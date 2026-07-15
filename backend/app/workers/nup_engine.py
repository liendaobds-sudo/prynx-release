"""

High-Performance N-Up Imposition Engine (pikepdf).

Replaces the JavaScript pdf-lib based N-Up renderer for large files (>1000 pages).

pikepdf uses C++/QPDF under the hood → 10-50x faster than pdf-lib for bulk page operations.

Architecture:

  Frontend (TypeScript) computes the grid layout (NupGridSolver) and sends a lightweight

  JSON "plan" to this engine. This engine then executes the plan using pikepdf,

  placing source pages onto output sheets at the computed coordinates.

"""

import os

import io

from app.workers import pdf_wrapper as pdf_lib

import tempfile

import uuid

import math

from typing import List, Dict, Any, Optional

from app.workers.cluster_tile_engine import run_cluster_tile, draw_tile_cut_marks
import logging

MM_TO_PTS = 2.83465

logger = logging.getLogger(__name__)

# Layout solver functions extracted to nup_layout_solver.py for modularity & testability

from app.workers.nup_layout_solver import solve_grid, solve_optimal_layout, get_src_page_idx, solve_manual


# Extracted modules
from app.workers.nup_diecut import (
    _path_items_to_polygon,
    extract_page_die_cut_polygon,
    get_optimal_head_to_tail_overlap,
    _find_largest_die_path,
)
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers.nup_sticker import compute_sticker_layout_for_page
from app.workers.imposition_finalize import finalize_placements

from app.workers.nup_process_chunk import process_chunk


def _canonicalize_rotation(source_path: str) -> tuple:
    """Bake /Rotate ≠ 0 vào content stream để mọi bước hạ nguồn (die detection, trim,
    layout, placement) thấy trang KHÔNG xoay. Trả (path, is_temp).

    Vì sao: engine bình đọc kích thước trang qua page_rect = MediaBox CHƯA xoay
    (không nhánh nào đọc page.rotation), nhưng show_pdf_page dùng as_form_xobject()
    lại bake /Rotate vào /Matrix → trang có /Rotate=90 (MediaBox portrait, nhìn thực
    tế landscape) bị dựng ô sai + tràn/méo. Bản vá canonicalize của VDP chỉ áp cho
    VDP; luồng nup/CNC trước đây bỏ sót (audit bảo toàn nội dung 2026-07-07).

    CHỈ đụng khi có trang /Rotate ≠ 0 → file không xoay giữ NGUYÊN byte (bảo toàn
    hành vi hiện tại). Dùng MediaBox làm hệ quy chiếu (khớp cách nup đọc kích thước);
    bake cả 4 box phụ qua cùng ma trận.
    """
    import pikepdf
    try:
        needs = False
        _p = pikepdf.Pdf.open(source_path)
        try:
            for page in _p.pages:
                if int(page.get("/Rotate", 0) or 0) % 360 != 0:
                    needs = True
                    break
            if not needs:
                _p.close()
                return source_path, False
            for page in _p.pages:
                rotate = int(page.get("/Rotate", 0) or 0) % 360
                if rotate == 0:
                    continue
                mb = [float(x) for x in page.MediaBox]
                mx0, my0, mx1, my1 = mb
                mw = mx1 - mx0
                mh = my1 - my0
                if rotate == 90:
                    mtx = (0.0, -1.0, 1.0, 0.0, -my0, mx0 + mw)
                    new_w, new_h = mh, mw
                elif rotate == 180:
                    mtx = (-1.0, 0.0, 0.0, -1.0, mx0 + mw, my0 + mh)
                    new_w, new_h = mw, mh
                else:  # 270
                    mtx = (0.0, 1.0, -1.0, 0.0, my0 + mh, -mx0)
                    new_w, new_h = mh, mw
                ma, mb_, mc, md, me, mf = mtx
                page.contents_coalesce()
                stream = page.obj["/Contents"]
                old = stream.read_bytes()
                prefix = (
                    f"q {ma:.6g} {mb_:.6g} {mc:.6g} {md:.6g} {me:.4f} {mf:.4f} cm\n"
                ).encode("ascii")
                stream.write(prefix + old + b"\nQ")
                page.MediaBox = pikepdf.Array([0, 0, new_w, new_h])
                page.CropBox = pikepdf.Array([0, 0, new_w, new_h])
                page.Rotate = 0
                for box in ("/TrimBox", "/ArtBox", "/BleedBox"):
                    if box in page:
                        b4 = [float(x) for x in page[box]]
                        corners = [(b4[0], b4[1]), (b4[2], b4[1]), (b4[2], b4[3]), (b4[0], b4[3])]
                        xs = [ma * px + mc * py + me for px, py in corners]
                        ys = [mb_ * px + md * py + mf for px, py in corners]
                        page[box] = pikepdf.Array([min(xs), min(ys), max(xs), max(ys)])
            out = os.path.join(tempfile.gettempdir(), f"nup_canon_{uuid.uuid4().hex}.pdf")
            _p.save(out)
            _p.close()
            return out, True
        finally:
            try:
                _p.close()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[ROTATE-CANON] bỏ qua canonicalize /Rotate ({e}); dùng file gốc.")
        return source_path, False


def run_nup_engine(

    source_path: str,

    output_path: str,

    settings: Dict[str, Any],

    job_id: str = None,

    progress_callback=None,

) -> str:

    from concurrent.futures import ProcessPoolExecutor

    import math

    import pypdfium2 as pdfium

    # ── Fix A (audit bảo toàn nội dung 2026-07-07): canonicalize /Rotate ≠ 0 MỘT LẦN,
    # TRƯỚC cả route CNC, để cả hai nhánh (nup + CNC) nhận file đã chuẩn hoá — mọi bước
    # hạ nguồn (die detection, trim, layout, placement) thấy trang KHÔNG xoay. File không
    # xoay giữ nguyên byte. Temp nup_canon_* được dọn bởi cơ chế dọn OS temp prefix nup_.
    source_path, _rot_is_temp = _canonicalize_rotation(source_path)

    # ── Định tuyến công cụ Bình Bế Rớt (CNC): renderer riêng, không đụng luồng repeat ──
    if settings.get('imposerMode') == 'cnc':
        from app.workers.cnc_render import run_cnc_two_sided
        return run_cnc_two_sided(source_path, output_path, settings, job_id, progress_callback)

    try:
        from app.workers.rot_audit_log import get_logger as _rot_get_logger
        _rot_get_logger().warning(
            "[ROT-AUDIT][REQ][RENDER] source=%s isDieCut=%s layoutType=%s gridStrategy=%s "
            "sheet=%.1fx%.1f mm margins(t/b/l/r)=%s/%s/%s/%s gap=%s/%s bleed=%s targetQty=%s tqbp=%s "
            "pontType=%s pontConfig=%s grouping=%s cutType=%s fillBlockGap=%s splitGap=%s "
            "detectedShapes=%s detectedShapeParams=%s",
            source_path, settings.get('isDieCutMode'), settings.get('layoutType'),
            settings.get('gridStrategy'), settings.get('sheetWidth', 0), settings.get('sheetHeight', 0),
            settings.get('marginTop'), settings.get('marginBottom'), settings.get('marginLeft'),
            settings.get('marginRight'), settings.get('gapX'), settings.get('gapY'), settings.get('bleed'),
            settings.get('targetQuantity'), settings.get('targetQuantitiesByPage'),
            settings.get('pontType'), settings.get('pontConfig'), settings.get('groupingStrategy'),
            settings.get('cutType'), settings.get('fillBlockGap'), settings.get('splitGap'),
            settings.get('detectedShapesByPage'), settings.get('detectedShapeParamsByPage'),
        )
    except Exception:
        pass

    # ── GUARD: Bình 2 mặt (duplex) KHÔNG áp dụng cho BÌNH TEM BẾ ──────────────
    # 2 mặt chỉ hợp lệ ở: Bế CNC (imposerMode=='cnc' — đã route riêng ở đầu hàm) và
    # Bình cắt xén (guillotine, non-die-cut). Với die-cut sticker (isDieCutMode & !cnc),
    # duplexFlow='double' rò rỉ (persist từ job trước) làm TỜ SAU bị lật gương + xoay
    # 180° ở process_chunk → sai. Ép về 1 mặt để tờ nhân bản KHÔNG bị mirror, đồng thời
    # khớp preview (preview không mirror).
    if settings.get('isDieCutMode', False) and settings.get('imposerMode') != 'cnc':
        if settings.get('duplexFlow') == 'double':
            settings = {**settings, 'duplexFlow': 'normal'}

    src_doc = pdf_lib.open(source_path)

    page_count = src_doc.page_count

    if page_count == 0:

        raise ValueError("Source PDF has no pages")

    # ── Guard Bình 2 mặt (guillotine N-Up) ──
    #  - Số trang CHẴN (mỗi SP = cặp trước/sau).
    #  - cut_stacks: process_chunk vẫn mirror tờ lẻ nếu duplex=double trong khi precalc
    #    không dựng F/B → phá collate. Chặn rõ ràng.
    #  - ratio_stack: CÓ hỗ trợ 2 mặt (tự dựng 2 tờ front/back cùng template, process_chunk
    #    lật gương tờ lẻ) → chỉ đòi số trang chẵn (mỗi mẫu = cặp trang trước/sau).
    if (
        settings.get('duplexFlow') == 'double'
        and not settings.get('isDieCutMode', False)
    ):
        _lt_guard = settings.get('layoutType', 'sequential') or 'sequential'
        _bad_lt = _lt_guard == 'cut_stacks'
        _odd = page_count % 2 != 0
        if _bad_lt or _odd:
            try:
                src_doc.close()
            except Exception:
                pass
            if _bad_lt:
                raise ValueError(
                    "Chế độ «Xếp chồng» chưa hỗ trợ Bình 2 mặt. "
                    "Chọn 1 Mặt, hoặc dùng Xếp lần lượt / Bình trang (S&R)."
                )
            raise ValueError(
                f"Bình 2 mặt bắt buộc số trang CHẴN. File hiện có {page_count} trang (lẻ). "
                "Hãy thêm/xóa 1 trang ở thumbnail, hoặc chọn 1 Mặt."
            )

    first_page = src_doc[0]

    geom_rect = None

    if settings.get('isDieCutMode', False):

        paths = first_page.extract_vector_paths()

        if paths:

            valid_paths = [p for p in paths if p['rect'].width > 5 and p['rect'].height > 5]

            if valid_paths:

                filtered = [p for p in valid_paths if abs(p['rect'].width - first_page.rect.width) > 2 or abs(p['rect'].height - first_page.rect.height) > 2]

                if not filtered: filtered = valid_paths

                stroke_paths = [p for p in filtered if p.get('type') == 's' or (p.get('fill') is None and p.get('color') is not None)]

                target_paths = stroke_paths if stroke_paths else filtered

                largest_path = max(target_paths, key=lambda p: p['rect'].width * p['rect'].height)

                r = largest_path['rect']

                geom_rect = (r.x0, r.y0, r.x1, r.y1)

    # Dùng MediaBox (page.rect) = đúng kích thước file (gồm bleed). trim = page - 2*bleed(UI).
    src_w = first_page.rect.width

    src_h = first_page.rect.height

    MM_TO_PTS = 2.83465

    strategy = settings.get('gridStrategy', 'simple_auto')

    is_die_cut = settings.get('isDieCutMode', False)

    # Shape override from frontend dropdown

    detected_shapes_by_page = settings.get('detectedShapesByPage', {})

    detected_shape_params_by_page = settings.get('detectedShapeParamsByPage', {})

    frontend_shape = detected_shapes_by_page.get("0") or detected_shapes_by_page.get(0)

    frontend_shape_props = detected_shape_params_by_page.get("0") or detected_shape_params_by_page.get(0) or {}

    # Variables needed later for process_chunk (kept for backward compat)

    shape_type = "CUSTOM"

    shape_props = {}

    base_poly = None

    p5_params = p6_params = p5_row_params = p6_row_params = p5_col_params = p6_col_params = None

    src_doc.close()

    bleed_mm = settings.get('bleed', 0)

    bleed_pt = bleed_mm * MM_TO_PTS

    if geom_rect:

        trim_w = geom_rect[2] - geom_rect[0]

        trim_h = geom_rect[3] - geom_rect[1]

    else:

        trim_w = src_w - 2 * bleed_pt

        trim_h = src_h - 2 * bleed_pt

    sheet_w = settings.get('sheetWidth', 320) * MM_TO_PTS

    sheet_h = settings.get('sheetHeight', 450) * MM_TO_PTS

    gap_x = settings.get('gapX', 0) * MM_TO_PTS

    gap_y = settings.get('gapY', 0) * MM_TO_PTS

    margin_top = settings.get('marginTop', 0) * MM_TO_PTS

    margin_bottom = settings.get('marginBottom', 0) * MM_TO_PTS

    margin_left = settings.get('marginLeft', 0) * MM_TO_PTS

    margin_right = settings.get('marginRight', 0) * MM_TO_PTS

    mark_type = settings.get('markType', 'none')

    mark_len = settings.get('markLength', 5.0) * MM_TO_PTS

    mark_off = settings.get('markOffset', 3.0) * MM_TO_PTS

    # Độ dày nét dấu xén (mm → pts). Mặc định 0.25mm khớp DEFAULT_MARKS_CONFIG ở frontend.
    mark_thick = settings.get('markThickness', 0.25) * MM_TO_PTS

    # Kiểu dấu xén: 'default' (nét đơn) | 'japanese' (nét đôi trim+bleed / トンボ)
    mark_style = settings.get('markStyle', 'default')

    # ── Mép kẹp (gripper / cắn nhíp) ──
    # Cạnh nạp giấy (ĐÁY tờ) không in được → phải chừa tối thiểu = gripper. Theo ĐÚNG
    # quy ước đã thống nhất toàn app (nestingEngine.calcPrintableArea, useBoxStore,
    # SpreadPlacer): lề đáy hiệu dụng = max(marginBottom, gripper). TRƯỚC ĐÂY engine
    # N-Up bỏ qua gripper (chỉ log) → bài tràn vào vùng kẹp (audit cắt xén #gripper).
    gripper_pt = settings.get('gripperMargin', 0) * MM_TO_PTS
    if gripper_pt > margin_bottom:
        margin_bottom = gripper_pt

    if settings.get('marginMode') == 'include_marks' and mark_type != 'none':

        mark_space = mark_len + mark_off

        margin_top += mark_space

        margin_bottom += mark_space

        margin_left += mark_space

        margin_right += mark_space

    usable_w = sheet_w - margin_left - margin_right

    usable_h = sheet_h - margin_top - margin_bottom

    sheet_usable_w = usable_w

    sheet_usable_h = usable_h

    # --- CLUSTERING LOGIC ---

    cluster_mode = settings.get('clusterMode', 'none')

    cluster_count = max(2, settings.get('clusterCount', 2))

    cluster_gap = settings.get('clusterGap', 0) * MM_TO_PTS

    cx_count = 1

    cy_count = 1

    # Khởi tạo mặc định: nhánh zone/auto-fill (bế tem dàn nhiều mẫu) không gán
    # secondary_gap nhưng args tuple vẫn dùng → tránh UnboundLocalError.
    secondary_gap = None

    # Cluster-type (ratio_stack + chia cọc theo LOẠI): KHÔNG chia usable đều theo
    # cluster_count. Bề RỘNG mỗi cọc TỶ LỆ với SL → nhánh precalc cluster_type tự giải
    # lưới ĐẦY ĐỦ tờ rồi phân cột/hàng theo tỷ lệ. Ở đây giữ nguyên usable + cx/cy=1.
    _lt_early = settings.get('layoutType', 'sequential')
    _is_cluster_type_early = (_lt_early == 'ratio_stack' and cluster_mode in ('row', 'column'))

    if _is_cluster_type_early:
        pass  # không chia đều; nhánh cluster_type tự phân dải theo tỷ lệ
    elif cluster_mode == 'column' and cluster_count >= 2:

        usable_w = (usable_w - cluster_gap * (cluster_count - 1)) / cluster_count

        cx_count = cluster_count

    elif cluster_mode == 'row' and cluster_count >= 2:

        usable_h = (usable_h - cluster_gap * (cluster_count - 1)) / cluster_count

        cy_count = cluster_count

    strategy = settings.get('gridStrategy', 'simple_auto')

    grouping_strategy = settings.get('groupingStrategy', 'maximize_area')
    logger.info("   ZONE-DEBUG grouping_strategy=%r" % grouping_strategy)
    cluster_tile_w_mm = settings.get('clusterTileW', 148.0)   # mm, default A5 width
    cluster_tile_h_mm = settings.get('clusterTileH', 210.0)   # mm, default A5 height

    layout_type = settings.get('layoutType', 'sequential')

    is_die_cut = settings.get('isDieCutMode', False)

    precalculated_placements = None
    cluster_tile_cuts = {}

    # Chế độ ĐỒNG NHẤT (sticker-homogeneous-nup) — mặc định tắt; chỉ bật trong khối die-cut.
    homogeneous_master_idx = None

    # Report state (spec: binh-tem-be-report) — luôn tồn tại để khối finalize đọc được.
    _reports_by_sheet = {}
    _report_rows = []
    _ratio_stack_warnings = []  # cảnh báo ratio_stack (unplaced…) → message hoàn tất

    target_quantity = settings.get('targetQuantity', 0)


    target_quantities_by_page = settings.get('targetQuantitiesByPage', {})

    # Check if all targets are 0 (Auto-Fill 1 Sheet mode)

    is_auto_fill = (target_quantity == 0 and not any(v > 0 for v in target_quantities_by_page.values()))

    if is_die_cut:

        logger.info(f"\n🚀 [NUP_ENGINE] Running ZONE-BASED N-UP with INTERLOCKING per type")

        logger.info(f"   target_quantity={target_quantity}, is_auto_fill={is_auto_fill}")

        logger.info(f"   target_quantities_by_page={target_quantities_by_page}")

        # ── Step 1: Build per-page info ──

        tmp_doc = pdf_lib.open(source_path)

        page_infos = []  # [(p_idx, qty, trim_w, trim_h), ...]

        # Tín hiệu tin cậy cho chế độ ĐỒNG NHẤT (sticker-homogeneous-nup):
        #   has_die_by_page[p_idx]  = trang CÓ đường bế (master tiềm năng) hay KHÔNG (nội dung)
        #   trim_by_page[p_idx]     = trim (pt) của trang — để dựng poly khuôn cho detector
        has_die_by_page = {}
        trim_by_page = {}
        # Tín hiệu ĐÁNG TIN cho phân biệt cùng-khuôn/khác-khuôn: trang có ĐƯỜNG BẾ
        # THẬT (kênh khuôn/spot-nét/màu bế), KHÔNG tính fallback hình học (artwork
        # nội dung cũng có nét/khép kín). Tách khỏi has_die_by_page (dùng cho trim).
        genuine_die_by_page = {}

        for p_idx in range(page_count):

            p_str = str(p_idx)

            if p_str in target_quantities_by_page:

                qty = target_quantities_by_page[p_str]

            elif p_idx in target_quantities_by_page:

                qty = target_quantities_by_page[p_idx]

            else:

                qty = target_quantity

            if qty <= 0:

                qty = 1

            src_page = tmp_doc[p_idx]

            largest_path = _find_largest_die_path(src_page)

            has_die_by_page[p_idx] = largest_path is not None

            try:
                from app.workers.sticker_homogeneous import page_has_die as _page_has_die
                genuine_die_by_page[p_idx] = _page_has_die(src_page)
            except Exception:
                genuine_die_by_page[p_idx] = False

            if largest_path:

                r = largest_path['rect']

                cur_trim_w = r.width

                cur_trim_h = r.height

            else:

                if abs(src_page.trimbox.width - src_page.rect.width) > 1.0:

                    cur_trim_w = src_page.trimbox.width

                    cur_trim_h = src_page.trimbox.height

                else:

                    cur_trim_w = src_page.rect.width

                    cur_trim_h = src_page.rect.height

                cur_trim_w -= 2 * bleed_pt

                cur_trim_h -= 2 * bleed_pt

            page_infos.append((p_idx, qty, cur_trim_w, cur_trim_h))

            trim_by_page[p_idx] = (cur_trim_w, cur_trim_h)

            logger.debug(f"   [ZONE] Page {p_idx}: qty={qty} trim={cur_trim_w:.1f}x{cur_trim_h:.1f}")

        # Sort page_infos by size ONLY when mixing multiple types on same sheet
        # (e.g. maximize_area, strict_ratio, cluster_tile).
        # For 'none' grouping or 'repeat' layout, preserve original page order.
        if grouping_strategy != 'none' and layout_type != 'repeat':
            page_infos.sort(key=lambda x: min(x[2], x[3]), reverse=True)

        # ── Step 2: Calculate strip heights ──

        # maximize_area → chia đều diện tích: mỗi loại được usable_h / số_loại

        # strict_ratio  → chia đều số lượng: mỗi loại được không gian tỉ lệ với qty của nó

        n_types = len(page_infos)

        total_qty_all = sum(qty for _, qty, _, _ in page_infos)

        total_weighted = sum(qty * h for _, qty, _, h in page_infos)

        strip_allocations = []

        remaining_h = usable_h

        for p_idx, qty, tw, th in page_infos:

            if grouping_strategy == 'maximize_area':

                # Chia đều diện tích: mỗi loại được đúng 1/N tổng chiều cao

                alloc_h = usable_h / n_types

            else:

                # strict_ratio — chia đều số lượng:

                # Tỉ lệ = qty_loại / tổng_qty → loại nhiều hơn được nhiều không gian hơn

                # (số_hàng_cần × chiều_cao_tem ≈ qty / items_per_row × th)

                # Công thức đơn giản: weight thuần theo qty

                weight = qty / total_qty_all if total_qty_all > 0 else 1.0 / n_types

                alloc_h = usable_h * weight

            # Đảm bảo ít nhất 1 hàng tem vừa vào strip

            alloc_h = max(alloc_h, th + gap_y)

            # Không vượt quá không gian còn lại

            alloc_h = min(alloc_h, remaining_h)

            strip_allocations.append((p_idx, qty, tw, th, alloc_h))

            remaining_h -= alloc_h

            logger.debug(f"   [ZONE] Page {p_idx}: alloc_h={alloc_h:.1f}pt "

                  f"(item_h={th:.1f}, qty={qty}, strategy={grouping_strategy})")

        # ── Step 3: Compute FULL-SHEET layout per type, then slice items ──

        # Key insight: compute interlocking at full sheet height (for correct pattern),

        # then take only the needed qty. Y-offset stacks types vertically.

        # First: pre-compute full-sheet layout for each type (once)

        full_layouts = {}  # p_idx -> layout_result

        # Reuse tmp_doc from Step 1 (still open)

        for p_idx, qty, tw, th in page_infos:

            page_obj = tmp_doc[p_idx]

            p_shape = None

            if detected_shapes_by_page:

                p_shape = (detected_shapes_by_page.get(str(p_idx)) 

                          or detected_shapes_by_page.get(p_idx))

            p_shape_props = {}

            if detected_shape_params_by_page:

                p_shape_props = (detected_shape_params_by_page.get(str(p_idx)) 

                                or detected_shape_params_by_page.get(p_idx) or {})

            try:
                w_for_nfp = usable_w
                h_for_nfp = usable_h
                if grouping_strategy == 'cluster_tile' and settings.get('clusterNesting', True):
                    cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                    MM = 2.83465
                    tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                    tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                    if cluster_sizing_mode == 'grid':
                        cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                        cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                        w_for_nfp = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                        h_for_nfp = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                    else:
                        w_for_nfp = float(settings.get('clusterTileW', 148.0)) * MM
                        h_for_nfp = float(settings.get('clusterTileH', 210.0)) * MM

                # secondary_gap: PHẢI khớp _resolve_preview_secondary_gap (preview) →
                # one_dao+fillBlockGap → splitGap → None. Nếu bỏ splitGap ở đây, preview
                # (dùng splitGap) sẽ lệch render (cột lấp đầy L-shape xếp khác).
                fill_block_gap_mm = settings.get('fillBlockGap', 0)
                cut_type = settings.get('cutType', 'default')
                split_gap_mm = settings.get('splitGap', None)
                if cut_type == 'one_dao' and fill_block_gap_mm > 0:
                    _secondary_gap = fill_block_gap_mm * MM_TO_PTS
                elif split_gap_mm is not None and split_gap_mm > 0:
                    _secondary_gap = split_gap_mm * MM_TO_PTS
                else:
                    _secondary_gap = None

                logger.debug(f"   [ZONE DEBUG] w_for_nfp={w_for_nfp} h_for_nfp={h_for_nfp} gap_x={gap_x} gap_y={gap_y} bleed_pt={bleed_pt} secondary_gap={_secondary_gap}")
                layout_result = compute_sticker_layout_for_page(
                    page_obj,
                    w_for_nfp,
                    h_for_nfp,
                    gap_x, gap_y,

                    strategy='optimal_auto',

                    shape_type_override=p_shape if p_shape else None,

                    shape_props_override=p_shape_props if p_shape_props else None,

                    bleed_pt=bleed_pt,

                    secondary_gap=_secondary_gap,

                )

                full_layouts[p_idx] = layout_result

                try:
                    from app.workers.rot_audit_log import get_logger as _rot_get_logger
                    _items_dbg = layout_result.get('items', [])
                    _rot_get_logger().warning(
                        "[ROT-AUDIT][solver][RENDER p_idx=%s] strategy=%s shapeType=%s shapeProps=%s "
                        "secondary_gap=%s n=%d rot180_per_cell=%s",
                        p_idx, layout_result.get('strategyUsed'), layout_result.get('shapeType'),
                        layout_result.get('shapeProps'), _secondary_gap, len(_items_dbg),
                        [int(it.get('isRotated180', False)) for it in _items_dbg],
                    )
                except Exception:
                    pass

                capacity = len(layout_result.get('items', []))

                logger.debug(f"   [ZONE] Page {p_idx}: full-sheet layout -> {capacity} items "

                      f"(strategy={layout_result.get('strategyUsed','?')})")

            except Exception as e:

                logger.warning(f"   [ZONE] Layout engine failed for page {p_idx}: {e}")

                full_layouts[p_idx] = None

        tmp_doc.close()  # Close after both Step 1 and Step 3 are done

        # Step 3b: Calculate proportional items-per-sheet for each type

        # Based on full-sheet capacity and requested quantities

        total_qty = sum(qty for _, qty, _, _ in page_infos)

        # Calculate how many items of each type fit on a full sheet

        items_per_sheet_type = {}

        for p_idx, qty, tw, th in page_infos:

            fl = full_layouts.get(p_idx)

            if fl and fl.get('items'):

                items_per_sheet_type[p_idx] = len(fl['items'])

            else:

                # Grid fallback capacity

                cols = max(1, int(usable_w / (tw + gap_x)))

                rows = max(1, int(usable_h / (th + gap_y)))

                items_per_sheet_type[p_idx] = cols * rows

        if layout_type != 'repeat':
            if is_auto_fill:
                sum_inv_c = sum(1.0 / items_per_sheet_type[p_idx] for p_idx, _, _, _ in page_infos)
                N = max(1, int(1.0 / sum_inv_c)) if sum_inv_c > 0 else 1
                logger.debug(f"   [ZONE] AUTO-FILL MODE: Calculated N={N} items per type to fill 1 sheet")
                page_infos = [(p_idx, N, tw, th) for p_idx, _, tw, th in page_infos]
                remaining_by_page = {p_idx: N for p_idx, _, _, _ in page_infos}
            else:
                remaining_by_page = {p_idx: qty for p_idx, qty, _, _ in page_infos}

        # ── PHÁT HIỆN CHẾ ĐỘ ĐỒNG NHẤT (sticker-homogeneous-nup, Task 6) ──
        # Áp dụng cho MỌI chế độ die-cut, KỂ CẢ khi nhập số lượng (không chỉ auto-fill):
        # "1 khuôn master (trang đầu) + N trang nội dung" PHẢI xếp đồng nhất bất kể có
        # đặt số lượng hay không — việc dùng-chung-khuôn không liên quan tới số lượng.
        # Dựng adapter/trang từ tín hiệu has_die (đáng tin) + hình nhận diện; rồi
        # detect_homogeneous quyết định (trả None khi ≠ đúng-1-master → giữ đường cũ).
        homogeneous_plan = None
        homogeneous_master_idx = None
        try:
            from app.workers import sticker_homogeneous as _sh
            from app.workers.shape_types import ShapeType as _ShapeType, coerce_shape_type as _coerce
            _adapters = []
            for _p in range(page_count):
                _hd = genuine_die_by_page.get(_p, False)
                if _hd:
                    _s = (detected_shapes_by_page.get(str(_p))
                          or detected_shapes_by_page.get(_p))
                    try:
                        _stype = _coerce(_s) if _s else _ShapeType.CUSTOM
                    except Exception:
                        _stype = _ShapeType.CUSTOM
                else:
                    _stype = _ShapeType.CUSTOM
                _tw, _th = trim_by_page.get(_p, (0.0, 0.0))
                _poly = ((0.0, 0.0), (_tw, 0.0), (_tw, _th), (0.0, _th)) if _hd else ()
                _props = (detected_shape_params_by_page.get(str(_p))
                          or detected_shape_params_by_page.get(_p) or {})
                _adapters.append(_sh.make_shape_adapter(_stype, _poly, _tw, _th, _props, has_die=_hd))
            homogeneous_plan = _sh.detect_homogeneous(_adapters)
            if homogeneous_plan is not None:
                homogeneous_master_idx = homogeneous_plan.master_page_idx
                # Cần nesting master hợp lệ để xếp shape-aware; nếu không có → fallback.
                if not (full_layouts.get(homogeneous_master_idx)
                        and full_layouts[homogeneous_master_idx].get('items')):
                    logger.info("   [HOMOGENEOUS] Master nesting trống → fallback bin-pack trộn cũ")
                    homogeneous_plan = None
                    homogeneous_master_idx = None
                else:
                    logger.info(
                        f"   [HOMOGENEOUS] Bật chế độ đồng nhất: master=trang {homogeneous_master_idx}, "
                        f"shape={homogeneous_plan.shape_type.name}, "
                        f"{len(homogeneous_plan.content_pages)} trang nội dung")
        except Exception as _e_hom:
            logger.warning(f"   [HOMOGENEOUS] Phát hiện thất bại → giữ đường cũ: {_e_hom}")
            homogeneous_plan = None
            homogeneous_master_idx = None

        precalculated_placements = {}
        cluster_tile_cuts = {}  # sheet_idx -> tile_cut_lines for cluster_tile mode

        total_items_placed = 0

        # Track how many items from the full layout we have already placed

        items_used_by_page = {p_idx: 0 for p_idx, _, _, _ in page_infos}

        # y_offset and placed_on_sheet are mutable state used by _place_items_from_layout

        y_offset = 0.0

        placed_on_sheet = 0

        # Helper: place up to qty_limit items from a layout into the sheet at current y_offset

        def _place_items_from_layout(fl, p_idx, tw, th, max_h, qty_limit):

            nonlocal y_offset, placed_on_sheet

            if not fl or not fl.get('items'):

                return 0

            if 'items_sorted' not in fl:

                fl['items_sorted'] = sorted(fl['items'], key=lambda x: (x.get('y', 0), x.get('x', 0)))

            full_items = fl['items_sorted']

            start_idx = items_used_by_page.get(p_idx, 0) % len(full_items)

            available_items = full_items[start_idx:]

            if not available_items and full_items:

                items_used_by_page[p_idx] = 0

                start_idx = 0

                available_items = full_items

            if not available_items:

                return 0

            items_to_use = []

            min_y = available_items[0].get('y', 0)

            for it in available_items:

                rel_y = it.get('y', 0) - min_y

                bottom = rel_y + it.get('height', th)

                if bottom > max_h + 0.5:

                    break

                items_to_use.append(it)

                if len(items_to_use) >= qty_limit:

                    break

            if not items_to_use:

                return 0

            max_item_bottom_rel = max(it.get('y', 0) - min_y + it.get('height', th) for it in items_to_use)

            block_min_x = min(it.get('x', 0) for it in items_to_use)

            block_max_x = max(it.get('x', 0) + it.get('width', tw) for it in items_to_use)

            block_w = block_max_x - block_min_x

            x_shift = (usable_w - block_w) / 2 - block_min_x

            for item in items_to_use:

                item_x = item.get('x', 0) + x_shift

                item_w = item.get('width', tw)

                item_h = item.get('height', th)

                is_rotated = item.get('isRotated', False)

                is_rotated_180 = item.get('isRotated180', False)

                rel_y = item.get('y', 0) - min_y

                # Use raw relative Y so PDF matches preview vertically
                adjusted_y = rel_y + y_offset

                cell = {

                    'x': item_x,

                    'y': adjusted_y,

                    'width': item_w,

                    'height': item_h,

                    'isRotated': is_rotated,

                    'isRotated180': is_rotated_180,

                }

                precalculated_placements[sheet_idx].append({

                    'cluster_idx': 0,

                    'cell': cell,

                    'src_page_idx': p_idx,

                    'abs_x': 0,  # placeholder, set after centering

                    'abs_y': 0,

                    'width': item_w,

                    'height': item_h,

                    'original_cell_y': 0,

                })

                placed_on_sheet += 1

            items_used_by_page[p_idx] = start_idx + len(items_to_use)

            y_offset += max_item_bottom_rel + gap_y

            return len(items_to_use)

        def _finalize_sheet_centering(s_idx):

            """Apply centering offsets to all placements on a sheet."""

            if s_idx not in precalculated_placements or not precalculated_placements[s_idx]:

                return

            # Compute content bounds

            all_bottoms = [p['cell']['y'] + p['cell']['height'] for p in precalculated_placements[s_idx]]

            total_content_h_s = max(all_bottoms) if all_bottoms else 0.0


            max_x_used_s = 0.0

            for p in precalculated_placements[s_idx]:

                right = p['cell']['x'] + p['cell']['width']

                if right > max_x_used_s:

                    max_x_used_s = right

            x_off = margin_left + (usable_w - max_x_used_s) / 2 if max_x_used_s < usable_w else margin_left

            y_off = margin_bottom + (usable_h - total_content_h_s) / 2 if total_content_h_s < usable_h else margin_bottom

            for p in precalculated_placements[s_idx]:
                cell = p['cell']
                p['abs_x'] = x_off + cell['x']
                p['abs_y'] = y_off + (total_content_h_s - cell['y'] - cell['height'])
                p['original_cell_y'] = usable_h + margin_bottom + margin_top - p['abs_y'] - cell['height']

        if homogeneous_plan is not None:
            # ══ CHẾ ĐỘ ĐỒNG NHẤT: 1 khuôn master + N trang nội dung (Task 6) ══
            # Chạy cho cả auto-fill LẪN có-số-lượng: _quantities bên dưới đọc số lượng
            # thật theo trang (None khi auto-fill → mỗi trang 1 lần).
            # Xếp shape-aware từ master (tái dùng nesting đã tính ở full_layouts → "1 lần"),
            # rải nội dung theo thứ tự (cuốn chiếu sang tờ), căn-giữa qua finalize_placements
            # (SSOT parity preview↔output), giải boong qua resolve_pont_collisions_on_placements.
            from app.workers import sticker_homogeneous as _sh
            from app.workers.imposition_finalize import resolve_pont_collisions_on_placements

            _master_idx = homogeneous_plan.master_page_idx
            _master_fl = full_layouts.get(_master_idx)

            # Tái dùng nesting master ĐÃ tính (không gọi lại compute → giữ "nesting 1 lần").
            def _reuse_master_layout(*_a, **_k):
                return _master_fl

            # ── Resolve SL mỗi trang nội dung (KHÔNG dùng trang khuôn master) ──
            # Trước: chỉ đọc targetQuantitiesByPage, bỏ targetQuantity global → SL = 0
            # → auto-fill 1 con/loại (sai). Và dùng `or 0` nuốt giá trị 0 hợp lệ.
            # UI: ô trống → fallback global; ô 0 → bỏ loại đó.
            def _qty_for_content_page(_p_idx):
                _tq = target_quantities_by_page or {}
                _raw = _tq.get(str(_p_idx), _tq.get(_p_idx, None))
                if _raw is not None:
                    try:
                        return max(0, int(_raw))
                    except (TypeError, ValueError):
                        return 0
                try:
                    return max(0, int(target_quantity or 0))
                except (TypeError, ValueError):
                    return 0

            _content_pages = list(homogeneous_plan.content_pages)
            _content_qtys = [_qty_for_content_page(_cp) for _cp in _content_pages]
            # Có SL > 1 → mỗi loại lấp ĐẦY tờ riêng (S&R + cùng khuôn) — khớp UI
            # "Số tờ = ceil(SL/Tem/tờ)" và quy trình in (1 tờ mẫu × N bản).
            # Tất cả ≤ 1 (số dán 1→N / auto-fill) → rải tuần tự 1 con/trang (round-robin).
            _use_per_type = any(q > 1 for q in _content_qtys)
            _export_unique_h = bool(settings.get('exportUniqueSheets', True))

            # Nesting master 1 lần (items + C ô/tờ). quantities=None để chỉ lấy layout.
            _hom_layout = _sh.build_homogeneous_layout(
                master_page=None,
                plan=homogeneous_plan,
                sheet_usable_w=usable_w,
                sheet_usable_h=usable_h,
                gap_x=gap_x,
                gap_y=gap_y,
                bleed_pt=bleed_pt,
                secondary_gap=None,
                quantities=None if _use_per_type else (
                    _content_qtys if any(q > 0 for q in _content_qtys) else None
                ),
                layout_fn=_reuse_master_layout,
            )

            # base_poly cho boong: ellipse chuẩn cho Tròn/Elip, còn lại để None (xấp xỉ chữ nhật).
            _master_base_poly = None
            if homogeneous_plan.shape_type == _sh.ShapeType.CIRCLE_ELLIPSE:
                try:
                    from shapely.geometry import Point as _Point
                    from shapely.affinity import scale as _scale
                    _rx = homogeneous_plan.trim_w / 2.0
                    _ry = homogeneous_plan.trim_h / 2.0
                    if _rx > 0 and _ry > 0:
                        _master_base_poly = _scale(_Point(0, 0).buffer(1.0, resolution=64),
                                                   xfact=_rx, yfact=_ry)
                except Exception:
                    _master_base_poly = None

            # req-like tối thiểu cho resolve_pont_collisions_on_placements.
            class _ReqLike:
                pass
            _req_like = _ReqLike()
            _req_like.pont_config = (settings.get('pontConfig')
                                     if settings.get('pontType', 'none') != 'none' else None)
            _req_like.sheet_w = sheet_w
            _req_like.sheet_h = sheet_h
            _req_like.margin_left = margin_left
            _req_like.margin_bottom = margin_bottom

            _items = list(_hom_layout.items)
            _C = _hom_layout.cells_per_sheet
            total_items_placed = 0

            def _sheet_placements_for_type(_src_idx):
                """1 tờ đầy C ô cùng 1 loại nội dung (cùng khuôn master)."""
                _pls = finalize_placements(
                    _items, usable_w, usable_h,
                    margin_left, margin_bottom, margin_top, _master_idx,
                )
                for _pl in _pls:
                    _pl['src_page_idx'] = _src_idx
                return resolve_pont_collisions_on_placements(
                    _pls, _req_like, base_poly=_master_base_poly)

            if _use_per_type and _C > 0:
                # ══ MỖI LOẠI 1 (hoặc N) TỜ ĐẦY — khớp UI + export unique ══
                # Trước: round-robin trộn mọi loại × SL → hàng trăm trang "tùm lum"
                # (vd 10 loại × ~100 tem / 8 ô = ~120 tờ trộn). Nay: mỗi loại 1 tờ
                # mẫu lấp đầy + report "in ceil(SL/C) tờ"; 1 trang khuôn ở cuối.
                from app.workers import nup_report as _nr_h
                _rcfg_h = settings.get('reportDisplay') or {}
                _report_on_h = bool(_rcfg_h.get('enabled'))
                _paper_h = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                _trim_mm_w = (homogeneous_plan.trim_w or 0) * (1.0 / MM_TO_PTS)
                _trim_mm_h = (homogeneous_plan.trim_h or 0) * (1.0 / MM_TO_PTS)
                _sheet_i = 0
                for _cp, _qty in zip(_content_pages, _content_qtys):
                    if _qty <= 0:
                        continue
                    _sn = max(1, math.ceil(_qty / _C))
                    _rep_n = 1 if _export_unique_h else _sn
                    _type_report = None
                    if _report_on_h:
                        _label_h = (_rcfg_h.get('labelNameText')
                                    or f"Trang {_cp + 1}")
                        _data_h = _nr_h.compute_report_data(
                            label_name=_label_h,
                            width_mm=_trim_mm_w, height_mm=_trim_mm_h,
                            paper_size=_paper_h,
                            items_per_sheet=_C, requested_qty=_qty,
                            material=settings.get('reportMaterial', '') or '',
                            lamination_type=settings.get('reportLamination', 0) or 0,
                            lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                            mode_label='Bế tem (cùng khuôn)',
                            order_code=settings.get('reportOrderCode', '') or '',
                            identifier=str(_cp + 1),
                            sheet_count_override=_sn,
                        )
                        _type_report = _nr_h.build_report_string(_rcfg_h, _data_h)
                        _report_rows.append({
                            'label': _label_h,
                            'items_per_sheet': _C,
                            'requested_qty': _qty,
                            'sheet_count': _sn,
                        })
                    for _ in range(_rep_n):
                        _pls = _sheet_placements_for_type(_cp)
                        precalculated_placements[_sheet_i] = _pls
                        total_items_placed += len(_pls)
                        if _type_report:
                            _reports_by_sheet[_sheet_i] = _type_report
                        _sheet_i += 1
                logger.info(
                    f"   [HOMOGENEOUS] PER-TYPE: {_sheet_i} tờ xuất / "
                    f"{sum(max(1, math.ceil(q / _C)) for q in _content_qtys if q > 0)} tờ cần in "
                    f"(C={_C}, exportUnique={_export_unique_h}, types="
                    f"{sum(1 for q in _content_qtys if q > 0)})"
                )
            else:
                # ══ Auto-fill / số dán 1→N: rải tuần tự 1 con/trang, cuốn chiếu ══
                for _t in range(_hom_layout.num_sheets):
                    _pls = finalize_placements(
                        _items, usable_w, usable_h,
                        margin_left, margin_bottom, margin_top, _master_idx,
                    )
                    _by_cell = {cc.cell_index: cc.src_page_idx
                                for cc in _hom_layout.cell_contents if cc.sheet_index == _t}
                    _sheet_pls = []
                    for _ci, _pl in enumerate(_pls):
                        if _ci in _by_cell:
                            _pl['src_page_idx'] = _by_cell[_ci]
                            _sheet_pls.append(_pl)
                    _sheet_pls = resolve_pont_collisions_on_placements(
                        _sheet_pls, _req_like, base_poly=_master_base_poly)
                    precalculated_placements[_t] = _sheet_pls
                    total_items_placed += len(_sheet_pls)

                logger.info(
                    f"   [HOMOGENEOUS] SEQ: {total_items_placed} ô / "
                    f"{_hom_layout.num_sheets} tờ (C={_C} ô/tờ)"
                )

                # Report tóm tắt (mỗi tờ 1 dòng — nội dung trộn số dán)
                try:
                    from app.workers import nup_report as _nr_h
                    _rcfg_h = settings.get('reportDisplay') or {}
                    if _rcfg_h.get('enabled') and precalculated_placements:
                        _paper_h = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                        _label_h = _rcfg_h.get('labelNameText') or ""
                        _n_sheets_h = int(_hom_layout.num_sheets or 0)
                        _trim_mm_w = (homogeneous_plan.trim_w or 0) * (1.0 / MM_TO_PTS)
                        _trim_mm_h = (homogeneous_plan.trim_h or 0) * (1.0 / MM_TO_PTS)
                        for _ts, _pls_h in precalculated_placements.items():
                            _ips = len(_pls_h)
                            _data_h = _nr_h.compute_report_data(
                                label_name=_label_h,
                                width_mm=_trim_mm_w, height_mm=_trim_mm_h,
                                paper_size=_paper_h,
                                items_per_sheet=_ips, requested_qty=0,
                                material=settings.get('reportMaterial', '') or '',
                                lamination_type=settings.get('reportLamination', 0) or 0,
                                lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                                mode_label='Bế tem (cùng khuôn)',
                                order_code=settings.get('reportOrderCode', '') or '',
                                identifier=f"Tờ {_ts + 1}/{max(1, _n_sheets_h)}",
                                sheet_count_override=max(1, _n_sheets_h),
                            )
                            _reports_by_sheet[_ts] = _nr_h.build_report_string(
                                _rcfg_h, _data_h)
                        if _n_sheets_h > 0:
                            _report_rows.append({
                                'label': _label_h or 'Cùng khuôn',
                                'items_per_sheet': _C,
                                'requested_qty': total_items_placed,
                                'sheet_count': _n_sheets_h,
                            })
                except Exception as _e_rh:
                    logger.warning(f"[REPORT] homogeneous seq dựng report lỗi: {_e_rh}")

        elif layout_type == 'repeat':
            logger.debug(f"   [ZONE] STICKER IMPOSER -> processing pages independently without mixing")
            sheet_idx = 0

            # ── REPORT & XUẤT TỜ DUY NHẤT (spec: binh-tem-be-report) ──
            from app.workers import nup_report as _nr
            _report_cfg = settings.get('reportDisplay') or {}
            _report_enabled = bool(_report_cfg.get('enabled'))
            _export_unique = settings.get('exportUniqueSheets', True)
            _rep_material = settings.get('reportMaterial', '')
            _rep_lam = settings.get('reportLamination', 0)
            _rep_lam_sides = settings.get('reportLaminationSides', 1)
            _rep_order = settings.get('reportOrderCode', '')
            _rep_paper = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
            _PT_MM = 1.0 / MM_TO_PTS

            def _make_type_report(p_idx, tw, th, items_per_sheet, qty):
                """Tính + build chuỗi report cho 1 loại tem (1 tờ duy nhất)."""
                label = _report_cfg.get('labelNameText') or f"Trang {p_idx + 1}"
                data = _nr.compute_report_data(
                    label_name=label,
                    width_mm=tw * _PT_MM, height_mm=th * _PT_MM,
                    paper_size=_rep_paper,
                    items_per_sheet=items_per_sheet, requested_qty=qty,
                    material=_rep_material,
                    lamination_type=_rep_lam, lamination_sides=_rep_lam_sides,
                    mode_label='Bế tem', order_code=_rep_order,
                    identifier=str(p_idx + 1),
                )
                _report_rows.append({
                    'label': label, 'items_per_sheet': items_per_sheet,
                    'requested_qty': qty, 'sheet_count': data['raw']['sheet_count'],
                })
                return _nr.build_report_string(_report_cfg, data)

            for p_idx, qty, tw, th in page_infos:
                fl = full_layouts.get(p_idx)
                if not fl or not fl.get('items'):
                    continue
                
                if grouping_strategy == 'cluster_tile' and settings.get('clusterNesting', True):
                    MM = 2.83465
                    cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                    tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                    tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                    cluster_nesting = settings.get('clusterNesting', True)

                    if cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
                        if cluster_sizing_mode == 'split_cols':
                            cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                            cluster_rows = 1
                        elif cluster_sizing_mode == 'split_rows':
                            cluster_cols = 1
                            cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                        else:
                            cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                            cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                            
                        cw_pt = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                        ch_pt = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                    else:
                        cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                        ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

                    ct_placements, tile_cut_lines = run_cluster_tile(
                        page_infos=[(p_idx, 1, tw, th)],
                        full_layouts=full_layouts,
                        sheet_w=usable_w,
                        sheet_h=usable_h,
                        cluster_w=cw_pt,
                        cluster_h=ch_pt,
                        gap_x=gap_x,
                        gap_y=gap_y,
                        tile_gap_x=tile_gap_x_pt,
                        tile_gap_y=tile_gap_y_pt,
                        cluster_nesting=cluster_nesting,
                        is_die_cut=is_die_cut,
                        doc=tmp_doc if is_die_cut else None,
                        shape_type=fl.get('shapeType', 'CUSTOM') if is_die_cut else 'CUSTOM',
                        shape_props=fl.get('shapeProps', {}) if is_die_cut else {},
                        strategy=strategy
                    )
                    
                    if ct_placements:
                        items_per_sheet = len(ct_placements)
                        sheets_needed = math.ceil(qty / items_per_sheet) if items_per_sheet > 0 else 1
                        repeat_count = 1 if _export_unique else sheets_needed
                        _type_report_str = _make_type_report(p_idx, tw, th, items_per_sheet, qty) if _report_enabled else None

                        ct_offset_x = margin_left
                        ct_offset_y = sheet_h - margin_bottom - sheet_usable_h
                        
                        for _ in range(repeat_count):
                            precalculated_placements[sheet_idx] = []
                            for p_item in ct_placements:
                                ox = p_item['abs_x'] + ct_offset_x
                                oy = p_item['abs_y'] + ct_offset_y
                                shifted = dict(p_item)
                                shifted['abs_x'] = ox
                                shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                                shifted['original_cell_y'] = oy
                                shifted['cell'] = dict(p_item['cell'])
                                shifted['cell']['x'] = ox
                                shifted['cell']['y'] = oy
                                precalculated_placements[sheet_idx].append(shifted)
                            
                            if tile_cut_lines:
                                tile_cut_lines_shifted = {'v': set(), 'h': set()}
                                for v in tile_cut_lines.get('v', []):
                                    tile_cut_lines_shifted['v'].add(v + ct_offset_x)
                                for h in tile_cut_lines.get('h', []):
                                    tile_cut_lines_shifted['h'].add(h + ct_offset_y)
                                cluster_tile_cuts[sheet_idx] = tile_cut_lines_shifted
                                
                            if _type_report_str:
                                _reports_by_sheet[sheet_idx] = _type_report_str
                            sheet_idx += 1
                        continue

                items_per_sheet = len(fl['items'])
                sheets_needed = math.ceil(qty / items_per_sheet) if items_per_sheet > 0 else 1
                repeat_count = 1 if _export_unique else sheets_needed
                _type_report_str = _make_type_report(p_idx, tw, th, items_per_sheet, qty) if _report_enabled else None

                # SSOT căn giữa: dùng CHUNG finalize_placements với preview + cnc_render.
                for _ in range(repeat_count):
                    precalculated_placements[sheet_idx] = finalize_placements(
                        fl['items'], usable_w, usable_h,
                        margin_left, margin_bottom, margin_top, p_idx,
                    )
                    if _type_report_str:
                        _reports_by_sheet[sheet_idx] = _type_report_str
                    sheet_idx += 1
            total_items_placed = sum(len(p) for p in precalculated_placements.values())

        elif is_auto_fill and len(page_infos) == 1 and grouping_strategy != 'cluster_tile':
            # ── AUTO-FILL 1 LOẠI TEM (single template) ──────────────────────────────
            # solve_auto_fill_mixed (MaxRects bao hình CHỮ NHẬT) chỉ dành cho TRỘN ≥2 mẫu.
            # Với DUY NHẤT 1 mẫu, preview luôn đi single-page nesting shape-aware
            # (compute_sticker_layout_for_page) → nếu output đi MaxRects thì layout LỆCH
            # preview ("lung tung"). detect_homogeneous trả None khi chỉ 1 trang (cần ≥1
            # trang nội dung) nên không có nhánh nào kéo về nesting → bổ sung tại đây.
            # Dùng CHUNG full_layouts (nesting) + finalize_placements (SSOT căn giữa) y hệt
            # nhánh 'repeat' & preview Branch A → preview ≡ output. Boong giải ở Phase 2
            # nup_process_chunk (dùng chung mọi nhánh).
            p_idx, _qty, _tw, _th = page_infos[0]
            fl = full_layouts.get(p_idx)
            sheet_idx = 0
            if fl and fl.get('items'):
                precalculated_placements[sheet_idx] = finalize_placements(
                    fl['items'], usable_w, usable_h,
                    margin_left, margin_bottom, margin_top, p_idx,
                )
            else:
                precalculated_placements[sheet_idx] = []
            total_items_placed = len(precalculated_placements[sheet_idx])
            logger.info(f"   [ZONE] AUTO-FILL 1 MẪU (nesting, parity preview): "
                        f"{total_items_placed} con/tờ")

            # Report 1 tờ (auto-fill: số tờ cần in = 1)
            try:
                from app.workers import nup_report as _nr_af
                _rcfg_af = settings.get('reportDisplay') or {}
                if _rcfg_af.get('enabled') and total_items_placed > 0:
                    _paper_af = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                    _label_af = _rcfg_af.get('labelNameText') or f"Trang {p_idx + 1}"
                    _data_af = _nr_af.compute_report_data(
                        label_name=_label_af,
                        width_mm=_tw * (1.0 / MM_TO_PTS), height_mm=_th * (1.0 / MM_TO_PTS),
                        paper_size=_paper_af,
                        items_per_sheet=total_items_placed, requested_qty=0,
                        material=settings.get('reportMaterial', '') or '',
                        lamination_type=settings.get('reportLamination', 0) or 0,
                        lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                        mode_label='Bế tem',
                        order_code=settings.get('reportOrderCode', '') or '',
                        identifier=str(p_idx + 1),
                        sheet_count_override=1,
                    )
                    _reports_by_sheet[0] = _nr_af.build_report_string(_rcfg_af, _data_af)
                    _report_rows.append({
                        'label': _label_af, 'items_per_sheet': total_items_placed,
                        'requested_qty': 0, 'sheet_count': 1,
                    })
            except Exception as _e_af:
                logger.warning(f"[REPORT] auto-fill 1 mẫu dựng report lỗi: {_e_af}")

        elif is_auto_fill:
            # ── AUTO-FILL: Pack all types onto 1 sheet using MaxRects bin-packing ──
            from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed

            if grouping_strategy == 'cluster_tile':
                # -- CLUSTER TILE (gom cum nho roi nhan ban len to lon) --
                MM = 2.83465
                cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
                cluster_nesting = settings.get('clusterNesting', True)

                if cluster_sizing_mode == 'grid':
                    cluster_cols = max(1, int(settings.get('clusterCols', 2)))
                    cluster_rows = max(1, int(settings.get('clusterRows', 2)))
                    cw_pt = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                    ch_pt = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                else:
                    cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                    ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

                ct_placements, tile_cut_lines = run_cluster_tile(
                    page_infos=page_infos,
                    full_layouts=full_layouts,
                    sheet_w=usable_w,
                    sheet_h=usable_h,
                    cluster_w=cw_pt,
                    cluster_h=ch_pt,
                    gap_x=gap_x,
                    gap_y=gap_y,
                    tile_gap_x=tile_gap_x_pt,
                    tile_gap_y=tile_gap_y_pt,
                    cluster_nesting=cluster_nesting,
                    is_die_cut=is_die_cut,
                    doc=tmp_doc if is_die_cut else None,
                    shape_type=full_layouts[page_infos[0][0]].get('shapeType', 'CUSTOM') if is_die_cut and full_layouts else 'CUSTOM',
                    shape_props=full_layouts[page_infos[0][0]].get('shapeProps', {}) if is_die_cut and full_layouts else {},
                    strategy=strategy
                )
                ct_offset_x = margin_left
                ct_offset_y = sheet_h - margin_bottom - sheet_usable_h

                sheet_idx = 0
                precalculated_placements[sheet_idx] = []
                placed_on_sheet = 0
                for p_item in ct_placements:
                    ox = p_item['abs_x'] + ct_offset_x
                    oy = p_item['abs_y'] + ct_offset_y
                    shifted = dict(p_item)
                    shifted['abs_x'] = ox
                    shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                    shifted['original_cell_y'] = oy
                    shifted['cell'] = dict(p_item['cell'])
                    shifted['cell']['x'] = ox
                    shifted['cell']['y'] = oy
                    precalculated_placements[sheet_idx].append(shifted)
                    placed_on_sheet += 1

                if tile_cut_lines:
                    v_shifted = {round(x + ct_offset_x, 2) for x in tile_cut_lines.get('v', set())}
                    h_shifted = {round(y + ct_offset_y, 2) for y in tile_cut_lines.get('h', set())}
                    cluster_tile_cuts[sheet_idx] = {'v': v_shifted, 'h': h_shifted}

                logger.info(f'   [ZONE] CLUSTER_TILE DONE: {placed_on_sheet} items')

            else:
                # ── MaxRects BIN-PACKING: all types compete freely for space ──
                
                # Pre-compute forbidden zones from pont/ốc marks
                # Dùng SSOT compute_packer_exclude_zones (NGUỒN CHÂN LÝ DUY NHẤT) để
                # preview (/preview-layout) và output (đây) LUÔN khớp — không chép tay.
                engine_exclude_zones = []
                pont_cfg = settings.get('pontConfig') if settings.get('pontType', 'none') != 'none' else None
                if pont_cfg and not pont_cfg.get('disableCollision', False):
                    try:
                        from app.workers.pont_collision import compute_packer_exclude_zones
                        engine_exclude_zones = compute_packer_exclude_zones(
                            pont_cfg, sheet_w, sheet_h, usable_w, usable_h,
                            margin_left, margin_bottom, max(gap_x, gap_y),
                        )
                        if engine_exclude_zones:
                            logger.debug(f"   [ZONE] BIN-PACK: {len(engine_exclude_zones)} exclude zones from pont/oc")
                    except Exception as e:
                        logger.warning(f"   [ZONE] BIN-PACK: pont zone calc failed: {e}")
                        engine_exclude_zones = []
                
                page_dims = [(p_idx, tw, th) for p_idx, _, tw, th in page_infos]
                bp_result = solve_auto_fill_mixed(
                    sheet_w=usable_w,
                    sheet_h=usable_h,
                    page_dims=page_dims,
                    gap=max(gap_x, gap_y),
                    allow_rotation=True,
                    exclude_zones=engine_exclude_zones if engine_exclude_zones else None,
                )

                sheet_idx = 0
                precalculated_placements[sheet_idx] = []
                placed_on_sheet = 0

                for p in bp_result['placements']:
                    rx = p['x']
                    ry = p['y']
                    iw = p['w']
                    ih = p['h']
                    p_idx = p['page_idx']
                    is_rot = p['is_rotated']

                    precalculated_placements[sheet_idx].append({
                        'cluster_idx': 0,
                        'cell': {
                            'x': rx, 'y': ry, 'width': iw, 'height': ih,
                            'isRotated': is_rot, 'isRotated180': False,
                        },
                        'src_page_idx': p_idx,
                        'abs_x': 0,  # set by _finalize_sheet_centering
                        'abs_y': 0,
                        'width': iw,
                        'height': ih,
                        'original_cell_y': 0,
                    })
                    placed_on_sheet += 1

                _finalize_sheet_centering(sheet_idx)
                logger.debug(f"   [ZONE] BIN-PACK AUTO-FILL DONE: {placed_on_sheet} items on 1 sheet")

            total_items_placed = placed_on_sheet

            # Report 1 tờ (auto-fill trộn / cluster-tile: số tờ cần in = 1)
            try:
                from app.workers import nup_report as _nr_am
                _rcfg_am = settings.get('reportDisplay') or {}
                if _rcfg_am.get('enabled') and placed_on_sheet > 0:
                    _paper_am = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                    _label_am = _rcfg_am.get('labelNameText') or ""
                    _data_am = _nr_am.compute_report_data(
                        label_name=_label_am,
                        paper_size=_paper_am,
                        items_per_sheet=placed_on_sheet, requested_qty=0,
                        material=settings.get('reportMaterial', '') or '',
                        lamination_type=settings.get('reportLamination', 0) or 0,
                        lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                        mode_label='Bế tem',
                        order_code=settings.get('reportOrderCode', '') or '',
                        identifier=f"{len(page_infos)} mẫu",
                        sheet_count_override=1,
                    )
                    _reports_by_sheet[0] = _nr_am.build_report_string(_rcfg_am, _data_am)
                    _report_rows.append({
                        'label': _label_am or f"{len(page_infos)} mẫu",
                        'items_per_sheet': placed_on_sheet,
                        'requested_qty': 0, 'sheet_count': 1,
                    })
            except Exception as _e_am:
                logger.warning(f"[REPORT] auto-fill trộn dựng report lỗi: {_e_am}")

        else:

            # ── MULTI-SHEET with quantities: MaxRects bin-packing per sheet ──
            from app.workers.sticker_imposer_pkg.bin_packing import solve_offset_mixed

            page_dims_qty = [(p_idx, tw, th, remaining_by_page[p_idx])
                             for p_idx, _, tw, th in page_infos
                             if remaining_by_page.get(p_idx, 0) > 0]

            bp_result = solve_offset_mixed(
                sheet_w=usable_w,
                sheet_h=usable_h,
                page_dims_qty=page_dims_qty,
                gap=max(gap_x, gap_y),
                allow_rotation=True,
            )

            # bp_result gives us the layout for ONE sheet + sheets_needed count
            one_sheet_placements = bp_result['placements']
            sheets_needed = bp_result.get('sheets_needed', 1)

            # ── Xuất tờ duy nhất + report (spec: binh-tem-be-report) ──
            # Trước đây luôn nhân bản sheets_needed trang giống hệt → file phình to
            # và "Lưu file in" tách mỗi trang thành 1 file (quá nhiều file).
            # exportUniqueSheets=True (mặc định sticker/CNC): chỉ 1 tờ + lệnh in N tờ.
            from app.workers import nup_report as _nr_ms
            _rcfg_ms = settings.get('reportDisplay') or {}
            _report_enabled_ms = bool(_rcfg_ms.get('enabled'))
            _export_unique_ms = bool(settings.get('exportUniqueSheets', True))
            repeat_count = 1 if _export_unique_ms else max(1, int(sheets_needed or 1))

            for sheet_idx in range(repeat_count):
                precalculated_placements[sheet_idx] = []
                for p in one_sheet_placements:
                    rx = p['x']
                    ry = p['y']
                    iw = p['w']
                    ih = p['h']
                    p_idx = p['page_idx']
                    is_rot = p['is_rotated']

                    precalculated_placements[sheet_idx].append({
                        'cluster_idx': 0,
                        'cell': {
                            'x': rx, 'y': ry, 'width': iw, 'height': ih,
                            'isRotated': is_rot, 'isRotated180': False,
                        },
                        'src_page_idx': p_idx,
                        'abs_x': 0,
                        'abs_y': 0,
                        'width': iw,
                        'height': ih,
                        'original_cell_y': 0,
                    })

                _finalize_sheet_centering(sheet_idx)

            items_per_sheet_ms = len(one_sheet_placements)
            total_items_placed = items_per_sheet_ms * max(1, int(sheets_needed or 1))
            logger.debug(
                f"   [ZONE] BIN-PACK OFFSET DONE: {items_per_sheet_ms} items/sheet × "
                f"{sheets_needed} tờ cần in → xuất {repeat_count} trang "
                f"(exportUnique={_export_unique_ms})"
            )

            if _report_enabled_ms and items_per_sheet_ms > 0:
                try:
                    _paper_ms = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                    _label_ms = _rcfg_ms.get('labelNameText') or ""
                    # SL yêu cầu = tổng qty các loại còn lại; sheet_count = sheets_needed engine.
                    _req_qty_ms = 0
                    for _p_idx, _q, _tw, _th in page_infos:
                        try:
                            _req_qty_ms += max(0, int(_q or 0))
                        except (TypeError, ValueError):
                            pass
                    # Kích thước: 1 loại → trim loại đó; nhiều loại → bỏ dimensions (0).
                    _wmm = _hmm = 0.0
                    if len(page_infos) == 1:
                        _wmm = page_infos[0][2] * (1.0 / MM_TO_PTS)
                        _hmm = page_infos[0][3] * (1.0 / MM_TO_PTS)
                    _data_ms = _nr_ms.compute_report_data(
                        label_name=_label_ms,
                        width_mm=_wmm, height_mm=_hmm,
                        paper_size=_paper_ms,
                        items_per_sheet=items_per_sheet_ms,
                        requested_qty=_req_qty_ms,
                        material=settings.get('reportMaterial', '') or '',
                        lamination_type=settings.get('reportLamination', 0) or 0,
                        lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                        mode_label='Bế tem',
                        order_code=settings.get('reportOrderCode', '') or '',
                        identifier='1' if len(page_infos) == 1 else f"{len(page_infos)} mẫu",
                        sheet_count_override=max(1, int(sheets_needed or 1)),
                    )
                    _rep_str_ms = _nr_ms.build_report_string(_rcfg_ms, _data_ms)
                    for _si in range(repeat_count):
                        _reports_by_sheet[_si] = _rep_str_ms
                    _report_rows.append({
                        'label': _label_ms or ('Trang 1' if len(page_infos) == 1 else f"{len(page_infos)} mẫu"),
                        'items_per_sheet': items_per_sheet_ms,
                        'requested_qty': _req_qty_ms,
                        'sheet_count': max(1, int(sheets_needed or 1)),
                    })
                except Exception as _e_ms:
                    logger.warning(f"[REPORT] multi-sheet dựng report lỗi: {_e_ms}")

        layout = {

            'totalItems': total_items_placed,

            'overallWidth': usable_w,

            'overallHeight': usable_h,

            'cells': [],

            'strategyUsed': 'Zone-Based N-Up with Interlocking'

        }

        capacity = 1

        total_items_needed = sum(qty for _, qty, _, _ in page_infos)

        logger.debug(f"   [ZONE] DONE: {total_items_placed}/{total_items_needed} items on 1 sheet")

        layout = {

            'totalItems': total_items_placed,

            'overallWidth': usable_w,

            'overallHeight': usable_h,

            'cells': [],

            'strategyUsed': 'Zone-Based N-Up with Interlocking'

        }

        capacity = 1


    else:

        # Use fillBlockGap (KC cụm phụ) as secondary_gap between main & fill blocks
        # when 1 Dao mode is active; otherwise dùng splitGap do frontend tính (đã gồm
        # khoảng chừa mark cắt) để output KHỚP preview; cuối cùng mới fallback cluster_gap.
        fill_block_gap_mm = settings.get('fillBlockGap', 0)
        cut_type = settings.get('cutType', 'default')
        split_gap_mm = settings.get('splitGap', None)
        if cut_type == 'one_dao' and fill_block_gap_mm > 0:
            secondary_gap = fill_block_gap_mm * MM_TO_PTS
        elif split_gap_mm is not None and split_gap_mm > 0:
            # split_gap_mm: cùng giá trị (mm) preview gửi tới /preview-layout → preview==output
            secondary_gap = split_gap_mm * MM_TO_PTS
        else:
            secondary_gap = cluster_gap if cluster_gap > 0 else None

        # Req 4.3: gridStrategy 'manual' → dùng đúng cols/rows người dùng nhập.
        cols_manual = int(settings.get('cols', 0) or 0)
        rows_manual = int(settings.get('rows', 0) or 0)

        logger.info(f"[NUP_ENGINE SOLVER DEBUG] usable_w={usable_w:.2f} usable_h={usable_h:.2f} "
                    f"trim_w={trim_w:.2f} trim_h={trim_h:.2f} gap_x={gap_x:.2f} gap_y={gap_y:.2f} "
                    f"strategy={strategy} secondary_gap={secondary_gap} "
                    f"marginBottom={margin_bottom:.2f} marginTop={margin_top:.2f} "
                    f"sheet_h={sheet_h:.2f} split_gap_mm={settings.get('splitGap')} "
                    f"gripperMargin={settings.get('gripperMargin')}")

        if strategy == 'manual' and cols_manual > 0 and rows_manual > 0:
            layout = solve_manual(trim_w, trim_h, gap_x, gap_y, cols_manual, rows_manual)
        elif _is_cluster_type_early:
            # CHIA CỌC theo loại: dao guillotine cần đường xén THẲNG xuyên tờ → ép lưới
            # ĐỀU (simple_auto). optimal_auto (L-fill) dựng khối chính+phụ lệch nhau, ô
            # khối phụ giữ c/r từ sub-grid 0-based → gán loại theo _c['c'] SAI (cột phải
            # nhận loại dải trái) → xén lẫn lộn. Lưới đều: c/r == cột/hàng vật lý.
            #
            # BUG-2 FIX: TRỪ gutter (giữa các cọc) khỏi usable TRƯỚC khi solve. Nếu không,
            # lưới lấp kín usable rồi mới chèn (n_band-1)*cluster_gap → super-grid > usable
            # → cọc ngoài đè lề/lọt mép. Số band tối đa = số loại có SL>0 (mỗi loại 1 cọc,
            # min-1 dòng). Trừ theo số đó → super-grid luôn ≤ usable (band thực ≤ ước tính
            # → an toàn, không bao giờ tràn). Tính _qtys_ct/_duplex_ct SỚM ở đây; nhánh
            # precalc dưới (Python không block-scope) tái dùng — cùng giá trị, idempotent.
            _duplex_ct = (settings.get('duplexFlow', 'single') == 'double'
                          and page_count >= 2 and page_count % 2 == 0)
            _n_units_ct = (page_count // 2) if _duplex_ct else page_count
            _qtys_ct = []
            for _u in range(_n_units_ct):
                _pg_key = (_u * 2) if _duplex_ct else _u
                _q = target_quantities_by_page.get(str(_pg_key), target_quantities_by_page.get(_pg_key, target_quantity))
                try:
                    _q = int(_q)
                except (TypeError, ValueError):
                    _q = 0
                _qtys_ct.append(max(0, _q))
            _n_bands_est = sum(1 for _q in _qtys_ct if _q > 0) or _n_units_ct
            _gutter_total = max(0, _n_bands_est - 1) * cluster_gap
            _uw_ct = (usable_w - _gutter_total) if cluster_mode == 'column' else usable_w
            _uh_ct = (usable_h - _gutter_total) if cluster_mode == 'row' else usable_h
            _uw_ct = max(trim_w, _uw_ct)
            _uh_ct = max(trim_h, _uh_ct)
            layout = solve_optimal_layout(_uw_ct, _uh_ct, trim_w, trim_h, gap_x, gap_y, 'simple_auto', secondary_gap)
        else:
            layout = solve_optimal_layout(usable_w, usable_h, trim_w, trim_h, gap_x, gap_y, strategy, secondary_gap)

        logger.debug("[NUP_ENGINE SOLVER RESULT] totalItems=%s strategy=%s",
                     layout.get('totalItems'), layout.get('strategyUsed'))



    capacity = layout['totalItems']

    total_capacity = capacity * cx_count * cy_count

    if total_capacity < 1:

        raise ValueError(f"Sheet too small for source pages. Cannot fit any items.")

    sheet_mapping = []

    if precalculated_placements is not None:

        total_sheets = max(precalculated_placements.keys()) + 1 if precalculated_placements else 1

    elif layout_type == 'repeat':

        for p in range(page_count):

            str_p = str(p)

            if str_p in target_quantities_by_page:

                qty = target_quantities_by_page[str_p]

            elif p in target_quantities_by_page:

                qty = target_quantities_by_page[p]

            else:

                qty = target_quantity

            if qty > 0:

                sheets = math.ceil(qty / total_capacity)

            else:

                sheets = 1

            sheet_mapping.extend([p] * sheets)

        total_sheets = len(sheet_mapping)

    elif (layout_type == 'ratio_stack' and cluster_mode in ('row', 'column')
          and capacity > 0 and page_count > 0 and layout.get('cells')):

        # ── N-Up "Chia tỷ lệ + CHIA CỌC theo LOẠI" (guillotine batching) ──
        #    Mỗi LOẠI = 1 CỌC (dải cột dọc ở mode 'column' / dải hàng ngang ở mode 'row')
        #    có rãnh dao + dấu xén riêng → xén cả chồng ra mỗi cọc một loại. BỀ RỘNG cọc
        #    (số cột/hàng lưới) TỶ LỆ với SL: loại SL cao chiếm nhiều dòng hơn → số tờ cân
        #    bằng, không dư thừa. MỌI loại nằm CÙNG 1 tờ mẫu (giống hệt xuyên chồng).
        #
        #    KHÁC mô hình cũ: usable KHÔNG bị chia đều (guard _is_cluster_type_early) →
        #    `layout` là lưới ĐẦY ĐỦ tờ. Ta phân CỘT (mode column) / HÀNG (mode row) cho
        #    từng loại theo tỷ lệ, chèn gutter giữa các dải, mỗi dải 1 cluster_idx (Rust
        #    compute_mark_coords nhóm theo cluster_idx → dấu xén riêng mỗi cọc tự động).
        from app.workers.nup_layout_solver import compute_cluster_type_alloc
        _align_ct = settings.get('align', 'center')
        _cells_ct = layout['cells']

        # 2 mặt: ĐƠN VỊ = cặp trang (2u trước | 2u+1 sau). Chia cọc theo ĐƠN VỊ (SL trang
        # chẵn); xuất 2 tờ front/back → process_chunk lật gương tờ lẻ.
        _duplex_ct = (
            settings.get('duplexFlow', 'single') == 'double'
            and page_count >= 2
            and page_count % 2 == 0
        )
        _n_units_ct = (page_count // 2) if _duplex_ct else page_count
        _qtys_ct = []
        for _u in range(_n_units_ct):
            _pg_key = (_u * 2) if _duplex_ct else _u
            _q = target_quantities_by_page.get(str(_pg_key), target_quantities_by_page.get(_pg_key, target_quantity))
            try:
                _q = int(_q)
            except (TypeError, ValueError):
                _q = 0
            _qtys_ct.append(max(0, _q))

        # Kích thước lưới đầy đủ: số cột × số hàng.
        _cols_ct = max((c['c'] for c in _cells_ct), default=0) + 1
        _rows_ct = max((c['r'] for c in _cells_ct), default=0) + 1
        # 'column' → chia CỘT theo tỷ lệ (lines_cross = số hàng); 'row' → chia HÀNG.
        if cluster_mode == 'column':
            _total_lines_ct, _lines_cross_ct = _cols_ct, _rows_ct
        else:
            _total_lines_ct, _lines_cross_ct = _rows_ct, _cols_ct

        _alloc_ct = compute_cluster_type_alloc(_total_lines_ct, _lines_cross_ct, _qtys_ct)
        _lines_of_ct = _alloc_ct['linesPerType']  # index=loại, giá trị=số dòng cấp cho loại
        n_sheets = max(1, int(_alloc_ct['nSheets']))
        if _alloc_ct.get('unplaced'):
            logger.warning("[CLUSTER_TYPE] Loại không đủ dòng lưới (nên tách bài in): idx=%s", _alloc_ct['unplaced'])

        # Gán từng DÒNG (cột/hàng) → loại + band (cluster_idx). Loại 0 chiếm dải đầu.
        _line_type_ct = {}
        _line_band_ct = {}
        _band_ct = 0
        _cur_line_ct = 0
        for _t, _nl in enumerate(_lines_of_ct):
            if int(_nl) <= 0:
                continue
            for _ in range(int(_nl)):
                _line_type_ct[_cur_line_ct] = _t
                _line_band_ct[_cur_line_ct] = _band_ct
                _cur_line_ct += 1
            _band_ct += 1
        _num_bands_ct = max(1, _band_ct)

        # Bbox lưới đầy đủ + super-grid (thêm gutter giữa các dải theo hướng chia).
        _bw_full_ct = max((c['x'] + c['width'] for c in _cells_ct), default=0.0)
        _bh_full_ct = max((c['y'] + c['height'] for c in _cells_ct), default=0.0)
        if cluster_mode == 'column':
            _super_w_ct = _bw_full_ct + max(0, _num_bands_ct - 1) * cluster_gap
            _super_h_ct = _bh_full_ct
        else:
            _super_w_ct = _bw_full_ct
            _super_h_ct = _bh_full_ct + max(0, _num_bands_ct - 1) * cluster_gap
        if 'left' in _align_ct:
            _sbx_ct = margin_left
        elif 'right' in _align_ct:
            _sbx_ct = sheet_w - margin_right - _super_w_ct
        else:
            _sbx_ct = margin_left + (sheet_usable_w - _super_w_ct) / 2
        if 'top' in _align_ct:
            _sby_ct = sheet_h - margin_top - _super_h_ct
        elif 'bottom' in _align_ct:
            _sby_ct = margin_bottom
        else:
            _sby_ct = margin_bottom + (sheet_usable_h - _super_h_ct) / 2

        def _back_of_ct(_u):
            _bp = _u * 2 + 1
            return _bp if _bp < page_count else _u * 2

        # Dựng 1 tờ: mỗi ô → loại theo dòng (cột/hàng) của nó; dời band*gutter theo hướng
        # chia. cluster_idx = band → Rust vẽ dấu xén riêng mỗi dải.
        def _build_cluster_tpl(_page_of_unit):
            _tpl = []
            for _c in _cells_ct:
                _line = _c['c'] if cluster_mode == 'column' else _c['r']
                _t = _line_type_ct.get(_line)
                if _t is None:
                    continue  # dòng không được cấp (không xảy ra — mọi dòng đã gán)
                _b = _line_band_ct[_line]
                if cluster_mode == 'column':
                    _ax = _sbx_ct + _c['x'] + _b * cluster_gap
                    _ayb = _sby_ct + (_bh_full_ct - _c['y'] - _c['height'])
                else:
                    _ax = _sbx_ct + _c['x']
                    _ayb = _sby_ct + (_super_h_ct - (_c['y'] + _b * cluster_gap) - _c['height'])
                _tpl.append({
                    'cluster_idx': _b,
                    'cell': dict(_c),
                    'src_page_idx': _page_of_unit(_t),
                    'abs_x': _ax,
                    'abs_y': _ayb,
                    'width': _c['width'],
                    'height': _c['height'],
                    'original_cell_y': sheet_h - _ayb - _c['height'],
                })
            return _tpl

        if _duplex_ct:
            precalculated_placements = {
                0: _build_cluster_tpl(lambda _u: _u * 2),
                1: _build_cluster_tpl(_back_of_ct),
            }
            total_sheets = 2
        else:
            precalculated_placements = {0: _build_cluster_tpl(lambda _u: _u)}
            total_sheets = 1

        # Report: 1 dòng (mọi loại cùng 1 tờ mẫu). ô/tờ = tổng ô lưới; sheet_count=n_sheets.
        _active_ct = [t for t in range(len(_qtys_ct)) if _qtys_ct[t] > 0]
        _n_types_ct = len(_active_ct)
        _req_qty_ct = sum(_qtys_ct[t] for t in _active_ct)
        _items_per_sheet_ct = len(precalculated_placements.get(0, []))
        _lbl_ct = (settings.get('reportDisplay') or {}).get('labelNameText') or (
            f"Chia cọc theo loại ({_n_types_ct} cọc{' · 2 mặt' if _duplex_ct else ''})"
        )
        _report_rows.append({
            'label': _lbl_ct,
            'items_per_sheet': _items_per_sheet_ct,
            'requested_qty': _req_qty_ct,
            'sheet_count': n_sheets,
        })

        if _alloc_ct.get('unplaced'):
            _up_ct = ", ".join(str(i + 1) for i in _alloc_ct['unplaced'])
            _ratio_stack_warnings.append(
                f"⚠ Không đủ dòng lưới cho loại (trang) {_up_ct} — nên tách sang bài in khác."
            )

    elif layout_type == 'ratio_stack' and capacity > 0 and page_count > 0 and layout.get('cells'):

        # ── N-Up "Chia tỷ lệ + xếp chồng" (ratio_stack): mỗi mẫu chiếm số ô theo TỶ
        #    LỆ số lượng; MỌI tờ giống HỆT nhau (cùng vị trí ô = cùng mẫu xuyên cả
        #    chồng) → dao xén guillotine chém cả chồng ra mỗi xấp MỘT loại sạch.
        #    Khác round-robin của 'sequential' (mỗi tờ khác nhau → xén ra lẫn lộn).
        from app.workers.nup_layout_solver import compute_ratio_stack_alloc
        _align_rs = settings.get('align', 'center')
        _cells_rs = layout['cells']

        # 2 mặt: mỗi ĐƠN VỊ = cặp trang (2u mặt TRƯỚC | 2u+1 mặt SAU). Chia tỷ lệ theo
        # ĐƠN VỊ (SL đọc ở trang chẵn), rồi xuất 2 tờ CÙNG hình học ô: tờ 0 = mặt trước,
        # tờ 1 = mặt sau → process_chunk lật gương tờ lẻ canh đúng mặt sau. Máy in chạy
        # n_sheets lượt duplex từ 1 CẶP tờ mẫu (giống 1 mặt: 1 tờ mẫu, chỉ khác 2 mặt).
        _duplex_rs = (
            settings.get('duplexFlow', 'single') == 'double'
            and page_count >= 2
            and page_count % 2 == 0  # chẵn — đã chặn ở đầu; phòng thủ kép
        )
        _n_units_rs = (page_count // 2) if _duplex_rs else page_count

        # SL mỗi ĐƠN VỊ (2 mặt: key trang chẵn 2u; 1 mặt: key trang u).
        _qtys = []
        for _u in range(_n_units_rs):
            _pg_key = (_u * 2) if _duplex_rs else _u
            _q = target_quantities_by_page.get(str(_pg_key), target_quantities_by_page.get(_pg_key, target_quantity))
            try:
                _q = int(_q)
            except (TypeError, ValueError):
                _q = 0
            _qtys.append(max(0, _q))

        _alloc = compute_ratio_stack_alloc(capacity, _qtys)
        _cpp = _alloc['cellsPerPage']
        n_sheets = max(1, int(_alloc['nSheets']))
        if _alloc.get('unplaced'):
            logger.warning("[RATIO_STACK] Mẫu không đủ chỗ trên tờ (nên tách bài in): idx=%s", _alloc['unplaced'])

        # Gán ô → đơn vị: đơn vị 0 chiếm _cpp[0] ô ĐẦU, đơn vị 1 kế tiếp... (ô cùng đơn
        # vị liền nhau → dễ xén). Vị trí ô CỐ ĐỊNH giữa mọi tờ (cả mặt trước↔sau).
        _slot_to_unit = []
        for _ui, _cnt in enumerate(_cpp):
            _slot_to_unit.extend([_ui] * int(_cnt))
        _n_used = min(len(_slot_to_unit), len(_cells_rs))

        _sc = _cells_rs[:_n_used]
        _bw = max((c['x'] + c['width'] for c in _sc), default=0.0)
        _bh = max((c['y'] + c['height'] for c in _sc), default=0.0)
        if 'left' in _align_rs:
            _bx = margin_left
        elif 'right' in _align_rs:
            _bx = sheet_w - margin_right - _bw
        else:
            _bx = margin_left + (sheet_usable_w - _bw) / 2
        if 'top' in _align_rs:
            _byb = sheet_h - margin_top - _bh
        elif 'bottom' in _align_rs:
            _byb = margin_bottom
        else:
            _byb = margin_bottom + (sheet_usable_h - _bh) / 2

        # Dựng template 1 tờ: ô j → trang nguồn theo hàm _page_of_unit (đơn vị của slot j).
        # MỌI tờ cùng mặt dùng CHUNG template (giống hệt nhau → xén chồng ra 1 loại).
        def _build_template_rs(_page_of_unit):
            _tpl = []
            for _j in range(_n_used):
                _c = _sc[_j]
                _ax = _bx + _c['x']
                _ayb = _byb + (_bh - _c['y'] - _c['height'])
                _tpl.append({
                    'cluster_idx': 0,
                    'cell': dict(_c),
                    'src_page_idx': _page_of_unit(_slot_to_unit[_j]),
                    'abs_x': _ax,
                    'abs_y': _ayb,
                    'width': _c['width'],
                    'height': _c['height'],
                    'original_cell_y': sheet_h - _ayb - _c['height'],
                })
            return _tpl

        # XUẤT tờ mẫu — mọi tờ cùng mặt GIỐNG HỆT nhau nên nhân bản n_sheets tờ là lãng
        # phí thuần. Máy in chạy n_sheets lượt từ 1 tờ mẫu (1 mặt) / 1 cặp tờ mẫu (2 mặt)
        # → chỉ cần 1 tờ (hoặc 2 tờ front/back) + report "in n_sheets tờ".
        if _duplex_rs:
            # Tờ 0 = mặt trước (trang chẵn 2u), tờ 1 = mặt sau (trang lẻ 2u+1).
            def _back_page_rs(_u):
                _bp = _u * 2 + 1
                # Trang lẻ thiếu (bất khả vì page_count chẵn) → tái dùng mặt trước.
                return _bp if _bp < page_count else _u * 2
            precalculated_placements = {
                0: _build_template_rs(lambda _u: _u * 2),
                1: _build_template_rs(_back_page_rs),
            }
            total_sheets = 2
        else:
            precalculated_placements = {0: _build_template_rs(lambda _u: _u)}
            total_sheets = 1

        # Luôn ghi 1 dòng lệnh in (sheet_count=n_sheets) → message hoàn tất hiện
        # "in N tờ" dù reportDisplay tắt. Stamp lên PDF chỉ khi report bật.
        # KHÔNG thêm mỗi mẫu 1 dòng (bảng tổng hợp cộng sheet_count → nhân sai).
        _n_types_rs = sum(1 for q in _qtys if q > 0)
        _sides_lbl_rs = " · 2 mặt" if _duplex_rs else ""
        _label_rs = (settings.get('reportDisplay') or {}).get('labelNameText') or f"Bình tỷ lệ ({_n_types_rs} mẫu{_sides_lbl_rs})"
        _req_qty_rs = sum(max(0, q) for q in _qtys)
        _report_rows.append({
            'label': _label_rs,
            'items_per_sheet': _n_used,
            'requested_qty': _req_qty_rs,
            'sheet_count': n_sheets,
        })
        if _alloc.get('unplaced'):
            _up_pages = ", ".join(str(i + 1) for i in _alloc['unplaced'])
            _ratio_stack_warnings.append(
                f"⚠ Không đủ chỗ trên tờ cho trang {_up_pages} — nên tách sang bài in khác."
            )

        _rcfg_rs = settings.get('reportDisplay') or {}
        if _rcfg_rs.get('enabled'):
            try:
                from app.workers import nup_report as _nr_rs
                _paper_rs = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                _PT_MM_rs = 1.0 / MM_TO_PTS
                _data_rs = _nr_rs.compute_report_data(
                    label_name=_label_rs,
                    width_mm=trim_w * _PT_MM_rs, height_mm=trim_h * _PT_MM_rs,
                    paper_size=_paper_rs,
                    items_per_sheet=_n_used, requested_qty=_req_qty_rs,
                    material=settings.get('reportMaterial', '') or '',
                    lamination_type=settings.get('reportLamination', 0) or 0,
                    lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                    mode_label='Cắt xén (chia tỷ lệ, 2 mặt)' if _duplex_rs else 'Cắt xén (chia tỷ lệ)',
                    order_code=settings.get('reportOrderCode', '') or '',
                    identifier=f"{_n_types_rs} mẫu{_sides_lbl_rs}",
                    sheet_count_override=n_sheets,
                )
                _reports_by_sheet[0] = _nr_rs.build_report_string(_rcfg_rs, _data_rs)
            except Exception as _e_rs:
                logger.warning(f"[RATIO_STACK] dựng report lỗi: {_e_rs}")

    else:

        # ── sequential / cut_stacks / fallback ──
        _align_np = settings.get('align', 'center')
        _cells_np = layout.get('cells') or []

        def _qty_for_page(_p):
            _q = target_quantities_by_page.get(str(_p), target_quantities_by_page.get(_p, target_quantity))
            try:
                return max(0, int(_q))
            except (TypeError, ValueError):
                return 0

        if layout_type == 'sequential' and capacity > 0 and page_count > 0 and _cells_np:
            # ── Xếp LẦN LƯỢT ──
            # 1 mặt: trang 0×q0, 1×q1… (không xen). Trống = lấp 1 tờ wrap.
            # 2 mặt: mỗi SP = cặp (2k | 2k+1) trước/sau. Cùng ô trên tờ chẵn=trước,
            #    tờ lẻ=sau (cùng toạ độ); process_chunk lật gương tờ lẻ.
            #    SL UI key theo trang chẵn (SP): qty[0] cho SP0, qty[2] cho SP1…
            _duplex_seq = (
                settings.get('duplexFlow', 'single') == 'double'
                and page_count >= 2
                and page_count % 2 == 0  # chẵn — đã chặn ở đầu; phòng thủ kép
            )
            _n_prod = page_count // 2 if _duplex_seq else page_count
            if _duplex_seq and _n_prod < 1:
                _duplex_seq = False
                _n_prod = page_count

            def _qty_for_product(_pi):
                """SL của SP: 2 mặt → key trang chẵn 2*_pi; 1 mặt → key trang _pi."""
                if _duplex_seq:
                    return _qty_for_page(_pi * 2)
                return _qty_for_page(_pi)

            _seq = []  # danh sách chỉ số SP (1 mặt = chỉ số trang)
            _any_qty = any(_qty_for_product(p) > 0 for p in range(_n_prod))
            if _any_qty:
                for _p in range(_n_prod):
                    _seq.extend([_p] * _qty_for_product(_p))
            elif target_quantity > 0:
                for _p in range(_n_prod):
                    _seq.extend([_p] * int(target_quantity))
            else:
                # Trống = lấp đầy 1 tờ, GOM THEO LOẠI (A-A-A B-B-B C-C-C), KHÔNG xen
                # kẽ A-B-C-A-B-C. Chia đều capacity cho các loại thành khối liền nhau
                # (phần dư dồn cho các loại đầu) → xén chồng ra mỗi loại một xấp.
                if _n_prod > 0:
                    _base = capacity // _n_prod
                    _rem = capacity % _n_prod
                    _seq = []
                    for _p in range(_n_prod):
                        _seq.extend([_p] * (_base + (1 if _p < _rem else 0)))
                else:
                    _seq = [0] * capacity
            if not _seq:
                _seq = [0]
            total_needed = len(_seq)
            n_front_sheets = -(-total_needed // capacity)  # ceil

            _full_bw = max((c['x'] + c['width'] for c in _cells_np), default=0.0)
            _full_bh = max((c['y'] + c['height'] for c in _cells_np), default=0.0)

            def _sheet_base(_n_this, _n_front_total):
                _sc = _cells_np[:_n_this]
                if _n_front_total == 1:
                    _bw = max((c['x'] + c['width'] for c in _sc), default=0.0)
                    _bh = max((c['y'] + c['height'] for c in _sc), default=0.0)
                else:
                    _bw, _bh = _full_bw, _full_bh
                if 'left' in _align_np:
                    _bx = margin_left
                elif 'right' in _align_np:
                    _bx = sheet_w - margin_right - _bw
                else:
                    _bx = margin_left + (sheet_usable_w - _bw) / 2
                if 'top' in _align_np:
                    _byb = sheet_h - margin_top - _bh
                elif 'bottom' in _align_np:
                    _byb = margin_bottom
                else:
                    _byb = margin_bottom + (sheet_usable_h - _bh) / 2
                return _sc, _bw, _bh, _bx, _byb

            def _make_pls(_sc, _bw, _bh, _bx, _byb, _page_for_j):
                _pls = []
                for _j, _c in enumerate(_sc):
                    _ax = _bx + _c['x']
                    _ayb = _byb + (_bh - _c['y'] - _c['height'])
                    _pls.append({
                        'cluster_idx': 0,
                        'cell': dict(_c),
                        'src_page_idx': _page_for_j(_j),
                        'abs_x': _ax,
                        'abs_y': _ayb,
                        'width': _c['width'],
                        'height': _c['height'],
                        'original_cell_y': sheet_h - _ayb - _c['height'],
                    })
                return _pls

            precalculated_placements = {}
            if _duplex_seq:
                # Tờ 2s = mặt trước (trang 2*sp), tờ 2s+1 = mặt sau (trang 2*sp+1).
                # Cùng hình học ô → process_chunk mirror tờ lẻ canh đúng trước/sau.
                for _s in range(n_front_sheets):
                    _n_this = min(capacity, total_needed - _s * capacity)
                    _sc, _bw, _bh, _bx, _byb = _sheet_base(_n_this, n_front_sheets)
                    _prods = [_seq[_s * capacity + _j] for _j in range(_n_this)]

                    def _front_page(_j, _prods=_prods):
                        return int(_prods[_j]) * 2

                    def _back_page(_j, _prods=_prods):
                        _bp = int(_prods[_j]) * 2 + 1
                        # Trang lẻ thiếu (file lẻ) → tái dùng mặt trước (tránh crash).
                        return _bp if _bp < page_count else int(_prods[_j]) * 2

                    precalculated_placements[_s * 2] = _make_pls(
                        _sc, _bw, _bh, _bx, _byb, _front_page)
                    precalculated_placements[_s * 2 + 1] = _make_pls(
                        _sc, _bw, _bh, _bx, _byb, _back_page)
                total_sheets = n_front_sheets * 2
                logger.info(
                    "[SEQUENTIAL DUPLEX] products=%s page_count=%s front_sheets=%s total_sheets=%s",
                    _n_prod, page_count, n_front_sheets, total_sheets,
                )
            else:
                for _s in range(n_front_sheets):
                    _n_this = min(capacity, total_needed - _s * capacity)
                    _sc, _bw, _bh, _bx, _byb = _sheet_base(_n_this, n_front_sheets)

                    def _page_1side(_j, _s=_s, _n_this=_n_this):
                        return _seq[_s * capacity + _j]

                    precalculated_placements[_s] = _make_pls(
                        _sc, _bw, _bh, _bx, _byb, _page_1side)
                total_sheets = n_front_sheets

        elif layout_type == 'cut_stacks' and capacity > 0 and page_count > 0 and _cells_np:
            # ── Xếp CHỒNG (cut-stack / collation):
            #    Ô k trên mọi tờ tạo 1 cọc; xén rời cọc rồi úp đúng thứ tự trang.
            #    sheet s, cell j → page = j * n_sheets + s  (n_sheets = ceil(n/cap)).
            #    KHÔNG dùng round-robin sequential; KHÔNG nhầm với target_quantity/capacity.
            n_sheets = max(1, math.ceil(page_count / capacity))
            _full_bw = max((c['x'] + c['width'] for c in _cells_np), default=0.0)
            _full_bh = max((c['y'] + c['height'] for c in _cells_np), default=0.0)
            if 'left' in _align_np:
                _bx = margin_left
            elif 'right' in _align_np:
                _bx = sheet_w - margin_right - _full_bw
            else:
                _bx = margin_left + (sheet_usable_w - _full_bw) / 2
            if 'top' in _align_np:
                _byb = sheet_h - margin_top - _full_bh
            elif 'bottom' in _align_np:
                _byb = margin_bottom
            else:
                _byb = margin_bottom + (sheet_usable_h - _full_bh) / 2

            precalculated_placements = {}
            for _s in range(n_sheets):
                _pls = []
                for _j, _c in enumerate(_cells_np[:capacity]):
                    _src = _j * n_sheets + _s
                    if _src >= page_count:
                        continue  # ô trống (trang không đủ)
                    _ax = _bx + _c['x']
                    _ayb = _byb + (_full_bh - _c['y'] - _c['height'])
                    _pls.append({
                        'cluster_idx': 0,
                        'cell': dict(_c),
                        'src_page_idx': _src,
                        'abs_x': _ax,
                        'abs_y': _ayb,
                        'width': _c['width'],
                        'height': _c['height'],
                        'original_cell_y': sheet_h - _ayb - _c['height'],
                    })
                precalculated_placements[_s] = _pls
            total_sheets = n_sheets
            logger.info(
                "[CUT_STACKS] page_count=%s capacity=%s n_sheets=%s (collation stacks)",
                page_count, capacity, n_sheets,
            )

        elif target_quantity > 0:
            total_sheets = math.ceil(target_quantity / total_capacity)
        else:
            total_sheets = math.ceil(page_count / total_capacity)

    chunk_layout_type = layout_type

    # --- Duplex Interleaving for Multi-Sheet Jobs ---
    # Đan mặt trước/sau theo TỪNG CẶP trang (0&1, 2&3, ...). Dành cho repeat / die-cut
    # (mỗi tờ 1 mẫu). sequential 2 mặt đã dựng sẵn F/B trong precalc → BỎ QUA.
    # cut_stacks / ratio_stack: không đan (sẽ phá collate / tờ mẫu).
    if (
        settings.get('duplexFlow', 'single') == 'double'
        and page_count >= 2
        and page_count % 2 == 0
        and layout_type not in ('sequential', 'cut_stacks', 'ratio_stack')
    ):
        # Chế độ 'repeat': sheet_mapping là list page-idx, nhóm theo trang rồi đan từng cặp.
        if sheet_mapping and len(sheet_mapping) == total_sheets:
            from collections import Counter as _Counter
            _counts = _Counter(sheet_mapping)
            interleaved = []
            for p in range(0, page_count, 2):
                n = min(_counts.get(p, 0), _counts.get(p + 1, 0))
                for _s in range(n):
                    interleaved.append(p)
                    interleaved.append(p + 1)
            if interleaved:
                sheet_mapping = interleaved
                total_sheets = len(sheet_mapping)
        # Chế độ cluster_tile/die-cut: nhóm tờ gốc theo src_page_idx rồi đan từng cặp.
        if precalculated_placements and len(precalculated_placements) == total_sheets:
            _page_sheets = {}
            for _s_idx in sorted(precalculated_placements.keys()):
                _pls = precalculated_placements[_s_idx]
                _pg = _pls[0].get('src_page_idx', _pls[0].get('cell', {}).get('pageIdx')) if _pls else None
                _page_sheets.setdefault(_pg, []).append(_s_idx)
            new_precalc = {}
            new_idx = 0
            for p in range(0, page_count, 2):
                _front = _page_sheets.get(p, [])
                _back = _page_sheets.get(p + 1, [])
                for _f, _b in zip(_front, _back):
                    new_precalc[new_idx] = precalculated_placements[_f]
                    new_precalc[new_idx + 1] = precalculated_placements[_b]
                    new_idx += 2
            if new_precalc:
                precalculated_placements = new_precalc
                total_sheets = len(new_precalc)

    align = settings.get('align', 'center')

    active_grid_w = layout['overallWidth']

    active_grid_h = layout['overallHeight']

    super_grid_w = cx_count * active_grid_w + max(0, cx_count - 1) * cluster_gap

    super_grid_h = cy_count * active_grid_h + max(0, cy_count - 1) * cluster_gap

    cells = layout['cells']

    prog_file = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt") if job_id else None

    available_cores = max(1, os.cpu_count() - 1)

    # Adaptive chunk sizing: distribute work evenly across cores

    # For small jobs: ensure at least 2 chunks if possible to utilize multiprocessing

    # For large jobs: cap at 5 sheets/chunk to avoid O(N^2) XObject resource deduplication freeze
    if total_sheets <= available_cores:
        CHUNK_SIZE = 1  # 1 sheet per core for very small jobs
    else:
        CHUNK_SIZE = min(5, max(1, math.ceil(total_sheets / available_cores)))

    args_list = []

    chunk_idx = 0

    for start_sheet in range(0, total_sheets, CHUNK_SIZE):

        end_sheet = min(start_sheet + CHUNK_SIZE, total_sheets)

        args = (

            source_path, job_id, chunk_idx, start_sheet, end_sheet, 

            sheet_w, sheet_h, capacity, cells, bleed_pt, gap_x, gap_y, 

            mark_type, mark_len, mark_off, margin_left, margin_bottom, 

            sheet_usable_w, sheet_usable_h, align, cx_count, cy_count, cluster_gap,

            active_grid_w, active_grid_h, super_grid_w, super_grid_h,

            prog_file, page_count, chunk_layout_type, is_die_cut,

            settings.get('pontConfig') if settings.get('pontType', 'none') != 'none' else None,

            strategy, detected_shapes_by_page, target_quantity, detected_shape_params_by_page, sheet_mapping,

            {s: precalculated_placements.get(s, []) for s in range(start_sheet, end_sheet)} if precalculated_placements is not None else None,

            settings.get('cutType', 'default'),  # G3: one_dao support

            grouping_strategy,  # cluster_tile: cascade grouping strategy

            {s: cluster_tile_cuts[s] for s in range(start_sheet, end_sheet) if s in cluster_tile_cuts},  # cluster_tile cut lines

            settings.get('separateCutPage', False),  # separate cut page flag

            settings.get('pontsOnCutFile', True),  # draw ponts on cut page

            float(settings.get('fillBlockGap', 0)),  # fillBlockGap in mm for secondary_gap

            total_sheets,  # global total sheets count for unique OCG naming

            secondary_gap,  # KC cụm phụ (pt) — phải dùng lại khi re-solve trong process_chunk (preview==output)

            mark_thick,  # Độ dày nét dấu xén (pt) — luồn từ markThickness của frontend

            mark_style,  # Kiểu dấu xén: 'default' | 'japanese' (nét đôi)

            settings.get('duplexFlow', 'single'),  # Duplex flow for mirroring back side

            (homogeneous_master_idx is not None),  # _homogeneousMode: bật registration đồng nhất

            homogeneous_master_idx,  # trang khuôn master (để vẽ đường bế master ở mỗi ô)

        )

        args_list.append(args)

        chunk_idx += 1

    chunk_bytes = []

    if len(args_list) > 0:

        if len(args_list) == 1:

            # Sequential for small jobs

            for args in args_list:

                chunk_bytes.append(process_chunk(args))

        else:

            # Parallel processing across multiple CPU cores

            num_workers = min(len(args_list), available_cores)

            with ProcessPoolExecutor(max_workers=num_workers) as pool:

                chunk_bytes = list(pool.map(process_chunk, args_list))

    # Mốc tiến trình finalize (để chẩn đoán nếu kẹt ở bước nào)
    def _stage(msg):
        if prog_file:
            try:
                with open(prog_file, 'w', encoding='utf-8') as f:
                    f.write(msg)
            except OSError:
                pass

    _stage("Đang gộp các tờ in...")

    # --- FAST ASSEMBLY ---

    if len(chunk_bytes) == 1:
        # Optimization: no merge needed, preserves all layers perfectly
        with open(output_path, 'wb') as f:
            f.write(chunk_bytes[0])
    elif is_die_cut:
        # PDFium import_pages strips Document Catalog /OCProperties (layers).
        # We must use pikepdf to merge chunks to preserve layers.
        # This is slightly slower but die-cut jobs rarely exceed 100 pages.
        import pikepdf
        import io
        final_doc = pikepdf.Pdf.open(io.BytesIO(chunk_bytes[0]))
        for cb in chunk_bytes[1:]:
            src_pdf = pikepdf.Pdf.open(io.BytesIO(cb))
            
            # Merge OCGs and /Order structure from source chunk into final document
            src_oc_props = src_pdf.Root.get("/OCProperties")
            if src_oc_props:
                final_oc_props = final_doc.Root.get("/OCProperties")
                if final_oc_props:
                    # Import all OCGs from source into /OCGs and /ON
                    ocg_remap = {}  # src objgen -> final ocg ref (for remapping /Order)
                    chunk_ocg_map = {} # name -> final ocg ref (for remapping Properties of pages in this chunk)
                    for src_ocg in src_oc_props.get("/OCGs", []):
                        try:
                            new_ocg = final_doc.copy_foreign(src_ocg)
                            final_oc_props["/OCGs"].append(new_ocg)
                            d = final_oc_props.get("/D", {})
                            if "/ON" in d:
                                d["/ON"].append(new_ocg)
                            if hasattr(src_ocg, 'objgen'):
                                ocg_remap[src_ocg.objgen] = new_ocg
                            name = str(src_ocg.get("/Name", ""))
                            if name:
                                chunk_ocg_map[name] = new_ocg
                        except Exception:
                            pass
                    
                    # Copy /Order items (preserving nested groups)
                    src_d = src_oc_props.get("/D", {})
                    src_order = src_d.get("/Order", [])
                    final_d = final_oc_props.get("/D", {})
                    if "/Order" in final_d and src_order:
                        def _copy_order_item(item):
                            if isinstance(item, pikepdf.Array):
                                return pikepdf.Array([_copy_order_item(sub) for sub in item])
                            elif hasattr(item, 'objgen') and item.objgen in ocg_remap:
                                return ocg_remap[item.objgen]
                            else:
                                return final_doc.copy_foreign(item)
                        
                        for item in src_order:
                            try:
                                final_d["/Order"].append(_copy_order_item(item))
                            except Exception:
                                pass
            
            start_idx = len(final_doc.pages)
            final_doc.pages.extend(src_pdf.pages)
            
            # Remap orphaned OCGs for the newly appended pages using chunk_ocg_map
            if src_oc_props:
                for page in final_doc.pages[start_idx:]:
                    try:
                        if "/Resources" in page and "/Properties" in page.Resources:
                            props = page.Resources["/Properties"]
                            for key in list(props.keys()):
                                val = props[key]
                                if isinstance(val, pikepdf.Dictionary) and val.get("/Type") == "/OCG":
                                    name = str(val.get("/Name", ""))
                                    if name in chunk_ocg_map:
                                        props[key] = chunk_ocg_map[name]
                    except Exception:
                        pass
                        
            src_pdf.close()
            
        final_doc.save(output_path)
        final_doc.close()
    else:
        # Merge chunks using C++ PDFium (avoids O(N^2) resource deduplication freeze for huge jobs)
        final_doc = pdfium.PdfDocument.new()
        for cb in chunk_bytes:
            src_pdf = pdfium.PdfDocument(cb)
            final_doc.import_pages(src_pdf)
            src_pdf.close()
        final_doc.save(output_path)
        final_doc.close()

    # ══════════════════════════════════════════════════════════════
    # HOMOGENEOUS: dồn 1 trang khuôn duy nhất xuống CUỐI file
    # ══════════════════════════════════════════════════════════════
    # Chế độ dùng chung 1 khuôn + tách trang khuôn riêng: process_chunk chỉ sinh trang
    # khuôn cho TỜ 0 (đầy đủ mọi ô) và gắn marker /PSHomogCut. Ở đây tìm trang có marker,
    # chuyển xuống CUỐI file rồi xoá marker. Kết quả: ...artwork1, artwork2, ..., khuôn.
    # Xử lý trên output_path (mọi nhánh assembly, kể cả 1-chunk ghi thẳng bytes).
    if is_die_cut and homogeneous_master_idx is not None and settings.get('separateCutPage', False):
        try:
            import pikepdf
            with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as _pdf:
                _cut_idx = None
                for _i, _pg in enumerate(_pdf.pages):
                    if _pg.obj.get('/PSHomogCut'):
                        _cut_idx = _i
                        break
                if _cut_idx is not None:
                    _cut_pg = _pdf.pages[_cut_idx]
                    try:
                        del _cut_pg.obj['/PSHomogCut']  # dọn marker (không để lẫn vào file cuối)
                    except Exception:
                        pass
                    if _cut_idx != len(_pdf.pages) - 1:  # chưa ở cuối → dời xuống cuối
                        _pdf.pages.remove(_cut_pg)
                        _pdf.pages.append(_cut_pg)
                        _pdf.save(output_path)
        except Exception as _e_move:
            logger.warning(f"[HOMOGENEOUS] dời trang khuôn xuống cuối thất bại ({_e_move}); giữ nguyên vị trí.")

    # ══════════════════════════════════════════════════════════════
    # SECURITY: Stealth watermark — hashed license trace in XMP + invisible text
    # ══════════════════════════════════════════════════════════════
    _wm_license = settings.get('_license_key', '') or settings.get('watermarkKey', '')
    _wm_hwid = settings.get('_hwid', '')
    if _wm_license:
        _stage("Đang đóng dấu bản quyền...")
        try:
            import pikepdf
            import os as _os, tempfile as _tempfile
            from app.core.watermark import embed_watermark
            with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
                embed_watermark(pdf, _wm_license, _wm_hwid)
                # Ghi atomic: temp cùng thư mục rồi os.replace (tránh hỏng output nếu chết giữa chừng).
                _fd, _tmp = _tempfile.mkstemp(suffix=".pdf", dir=_os.path.dirname(output_path) or ".")
                _os.close(_fd)
                pdf.save(_tmp)
            _os.replace(_tmp, output_path)
        except Exception as e:
            logger.error(f"Failed to write watermark: {e}")

    if prog_file:

        try:

            with open(prog_file, 'w') as f:

                f.write(f"{page_count}/{page_count}")

        except OSError: pass

    # ── Report fallback (cắt xén HOẶC die-cut nếu nhánh chính quên dựng) ──
    # Cắt xén: 1 trang/tờ (không có trang khuôn) → key report = chỉ số trang output.
    # Die-cut: các nhánh homogeneous/repeat/auto-fill/multi-sheet đã dựng sẵn; chỉ
    # fallback khi _reports_by_sheet còn rỗng nhưng user bật reportDisplay.
    if not _reports_by_sheet:
        try:
            _gcfg = settings.get('reportDisplay') or {}
            if _gcfg.get('enabled') and total_sheets:
                from app.workers import nup_report as _nrg
                _g_paper = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                _g_label = _gcfg.get('labelNameText') or ""
                _g_cap = int(capacity or 0)
                _g_mode = 'Bế tem' if is_die_cut else 'Cắt xén'
                # Die-cut: total_sheets = số tờ logic; capacity có thể = 1 (zone path).
                # Ưu tiên đếm từ precalculated_placements nếu có.
                _g_n = int(total_sheets)
                if is_die_cut and precalculated_placements:
                    _g_n = max(precalculated_placements.keys()) + 1 if precalculated_placements else _g_n
                    _g_cap = max((len(v) for v in precalculated_placements.values()), default=_g_cap)
                # Cắt xén 2 mặt: tờ CHẴN = mặt trước, tờ LẺ = mặt sau (sequential dựng
                # precalc 2s/2s+1). Report CHỈ đóng mặt TRƯỚC → chỉ set key chẵn, và số
                # tờ VẬT LÝ = total_sheets/2 (2 mặt = 1 tờ giấy). Không lọc → report
                # rơi cả mặt sau (bug: user thấy report lặp ở mặt sau).
                _g_duplex = (
                    not is_die_cut
                    and settings.get('duplexFlow', 'single') == 'double'
                    and _g_n >= 2
                    and _g_n % 2 == 0
                )
                _g_phys = (_g_n // 2) if _g_duplex else _g_n
                for _gs in range(max(1, _g_phys)):
                    _gd = _nrg.compute_report_data(
                        label_name=_g_label, paper_size=_g_paper,
                        items_per_sheet=_g_cap, requested_qty=0,
                        material=settings.get('reportMaterial', '') or '',
                        lamination_type=settings.get('reportLamination', 0) or 0,
                        lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                        mode_label=_g_mode,
                        order_code=settings.get('reportOrderCode', '') or '',
                        identifier=f"Tờ {_gs + 1}/{max(1, _g_phys)}",
                        sheet_count_override=max(1, _g_phys),
                    )
                    # Duplex: key = tờ mặt trước (chẵn) = _gs*2; 1 mặt: key = _gs.
                    _reports_by_sheet[(_gs * 2) if _g_duplex else _gs] = _nrg.build_report_string(_gcfg, _gd)
        except Exception as _ge:
            logger.warning(f"[REPORT] fallback dựng report lỗi: {_ge}")

    # ── Stamp report lên từng tờ + bảng tổng hợp (spec: binh-tem-be-report) ──
    if _reports_by_sheet:
        _stage("Đang ghi report lên tờ...")
        try:
            from app.workers import nup_report as _nr
            _rd = settings.get('reportDisplay') or {}
            # Report CHỈ vẽ trên trang IN.
            #  - Non-homogeneous + tách khuôn: xen kẽ [in, khuôn, in, khuôn…] → in ở s*2.
            #  - Homogeneous + tách khuôn: chỉ 1 trang khuôn ở CUỐI → artwork liền 0..N-1,
            #    không xen kẽ → stamp đúng index tờ logic (s), KHÔNG *2 (bug cũ: report
            #    rơi vào trang khuôn / trượt mất tờ sau).
            #  - Không tách khuôn: 1 trang/tờ → key = s.
            _sep_cut = bool(settings.get('separateCutPage')) and is_die_cut
            _homog_cut = _sep_cut and (homogeneous_master_idx is not None)
            if _sep_cut and not _homog_cut:
                _reports_to_stamp = {s_idx * 2: txt for s_idx, txt in _reports_by_sheet.items()}
            else:
                _reports_to_stamp = _reports_by_sheet
            _nr.stamp_reports_on_pdf(
                output_path, output_path, _reports_to_stamp,
                position=_rd.get('position', 'top'),
                offset_x_mm=float(_rd.get('offsetX', 5.0)),
                offset_y_mm=float(_rd.get('offsetY', 5.0)),
                font_size=float(_rd.get('fontSize', 8.0)),
                centered=bool(_rd.get('centered', True)),
            )
        except Exception as e:
            logger.warning(f"[REPORT] stamp lỗi: {e}")

    if progress_callback:

        progress_callback(page_count, page_count, "Hoàn tất")

    out_sheets = len(args_list) if args_list else 0

    report_lines = [f"✅ Hoàn tất! Xuất thành công file kẽm."]

    # Bảng tổng hợp lệnh in (spec: binh-tem-be-report, Yêu cầu 5)
    if _report_rows:
        _total_sheets = sum(r['sheet_count'] for r in _report_rows)
        report_lines.append("")
        report_lines.append("📋 LỆNH IN (tổng hợp):")
        for r in _report_rows:
            report_lines.append(
                f"  • {r['label']}: {r['requested_qty']} tem — SL/tờ {r['items_per_sheet']} → in {r['sheet_count']} tờ"
            )
        report_lines.append(f"  ⇒ Tổng số tờ cần in: {_total_sheets}")
        if layout_type == 'ratio_stack' and _total_sheets > 1:
            if locals().get('_duplex_rs'):
                report_lines.append(
                    f"  (File chỉ 1 CẶP tờ mẫu (mặt trước + sau) — máy in chạy {_total_sheets} lượt duplex giống hệt.)"
                )
            else:
                report_lines.append(
                    f"  (File chỉ 1 tờ mẫu — máy in chạy {_total_sheets} bản giống hệt.)"
                )
    for _w in _ratio_stack_warnings:
        report_lines.append(_w)


    if is_die_cut and 'strategyUsed' in layout:

        strategy_used = layout['strategyUsed']

        s_map = {

            'dumbbell_illustrator': 'Khuôn tạ (Đầu đuôi xen kẽ)',

            'hammer_illustrator': 'Khuôn búa (Chữ T xen kẽ)',

            'grid': 'Lưới đơn giản',

            'staggered': 'So le (Tổ ong)',

            'head_to_tail': 'Đầu đuôi (Ghép ngàm)',

            'l_shape': 'Ghép L-Shape',

            'row_alt': 'Xoay xen kẽ dòng',

            'col_alt': 'Xoay xen kẽ cột',

            'pentagon_advanced': 'Ghép Ngũ Giác (Đầu đuôi ngàm)',

        }

        vn_strategy = strategy_used

        for k, v in s_map.items():

            if k in strategy_used:

                vn_strategy = strategy_used.replace(k, v)

                break

        if strategy == 'optimal_auto':

            report_lines.append(f"🤖 Máy tính đã tự động tối ưu và chọn kiểu: {vn_strategy}")

        else:

            report_lines.append(f"Chiến lược dàn: {vn_strategy}")

        report_lines.append(f"Hiệu suất: {total_capacity} tem / tấm kẽm.")

    return "\n".join(report_lines)
