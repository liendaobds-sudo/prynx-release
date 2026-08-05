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

import contextlib

import io

from app.workers import pdf_wrapper as pdf_lib

import tempfile

import uuid

import math

from typing import List, Dict, Any, Optional

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
    resolve_one_dao_trim,
)
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers.nup_sticker import compute_sticker_layout_for_page
from app.workers.imposition_finalize import finalize_placements

from app.workers.nup_process_chunk import process_chunk
from app.workers.nup_output_finalize import NupOutputContext, finalize_nup_output
from app.workers.nup_cut_border import resolve_cut_border_config
from app.workers.nup_repeat_metadata import (
    build_repeat_sheet_metadata as _build_repeat_sheet_metadata,
)
from app.workers.page_space_canonicalization import canonicalize_page_space_file
from app.core.disk_space_guard import ensure_job_disk_space, estimate_nup_disk
from app.workers.mixed_guillotine_adapter import (
    resolve_guillotine_trim,
)


def _plan_nup_chunking(total_sheets: int, available_workers: int) -> tuple[int, int]:
    """Chọn kích thước chunk và số worker thật sự cho một job N-Up."""
    sheets = max(0, int(total_sheets or 0))
    workers = max(1, int(available_workers or 1))
    if sheets <= workers:
        # PERF (audit 2026-07-30 §G.1): job nhỏ hơn số lõi bị chậm vì mỗi tờ
        # mở một process riêng. Chạy nội tuyến; job lớn hơn vẫn dùng đủ worker.
        return max(1, min(5, sheets)), 1
    return min(5, max(1, math.ceil(sheets / workers))), workers


def _canonicalize_page_space(source_path: str, job_id: str = None) -> tuple:
    """Wrapper tương thích; phần chuẩn hóa được tách khỏi file N-Up quá dài."""
    return canonicalize_page_space_file(source_path, job_id)


@contextlib.contextmanager
def canonical_page_space(source_path: str, job_id: str = None):
    """Context manager công khai cho `_canonicalize_page_space`, tự dọn file tạm.

    [AUDIT §2.1 2026-07-28] Dùng cho các đường KHÔNG đi qua `run_nup_engine` (route
    detect-shape, preview) để chúng đọc CÙNG hệ quy chiếu với export. Đo được trên
    trang /Rotate=90 khổ 200×100: preview thấy 200×100 còn export sau chuẩn hoá thấy
    100×200 — lệch hoán w/h, đủ để preview dựng sai lưới ô.

    Yield đường dẫn đã chuẩn hoá; file tạm (nếu có) được xoá khi ra khỏi block, kể cả
    khi thân block ném ngoại lệ.
    """
    path, is_temp = _canonicalize_page_space(source_path, job_id)
    try:
        yield path
    finally:
        if is_temp:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except OSError as error:
                logger.warning("[PAGE-CANON] không xoá được %s: %s", path, error)


def _effective_diecut_grouping(layout_type, is_die_cut, grouping_strategy):
    """Repeat is a hard mode boundary: cluster cannot turn S&R into mixed N-up."""
    if is_die_cut and layout_type == 'repeat' and grouping_strategy == 'cluster_tile':
        return 'none'
    return grouping_strategy


def _normalize_page_sheet_settings(settings: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
    """Normalize whole-sheet routing before any downstream isDieCutMode gate."""
    normalized = dict(settings or {})
    raw_mode = normalized.get("page_sheet_mode", False)
    if type(raw_mode) is not bool:
        raise ValueError("page_sheet_mode phải là boolean.")
    if not raw_mode:
        return normalized, False

    imposer_mode = str(normalized.get("imposerMode", "") or "").strip().lower()
    task_mode = str(normalized.get("taskMode", "") or "").strip().lower()
    if imposer_mode == "cnc" or task_mode in ("cnc", "cnc_imposer"):
        raise ValueError("Bình nguyên tấm decal không áp dụng cho CNC.")
    try:
        bleed_mm = float(normalized.get("bleed", 0) or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("Bleed không hợp lệ.") from exc
    if not math.isfinite(bleed_mm) or bleed_mm < 0:
        raise ValueError("Bleed phải là số hữu hạn không âm.")

    pont_type = str(normalized.get("pontType", "none") or "none")
    normalized.update({
        "page_sheet_mode": True,
        "bleed": bleed_mm,
        "isDieCutMode": False,
        "cutType": "default",
        # Whole-sheet decal is a hybrid: rectangular imposition plus a paired
        # die page containing the sheet's existing kiss-cut paths.
        "separateCutPage": True,
        "pontType": pont_type,
        "pontConfig": (
            normalized.get("pontConfig") if pont_type != "none" else None
        ),
        "pontsOnCutFile": bool(normalized.get("pontsOnCutFile", True)),
        "duplexFlow": "normal",
        "detectedShapesByPage": {},
        "detectedShapeParamsByPage": {},
    })
    return normalized, True


def run_nup_engine(
    source_path: str,
    output_path: str,
    settings: Dict[str, Any],
    job_id: str = None,
    progress_callback=None,
) -> str:
    """Own the rotated-source temporary file for the complete N-Up lifecycle."""
    settings, _ = _normalize_page_sheet_settings(settings)
    # FIX (audit 2026-08-05 §OC.2): bảo vệ cả caller nội bộ đi thẳng vào engine.
    from app.schemas.pont import normalize_pont_settings
    settings = normalize_pont_settings(settings)
    perf_stages = None
    perf_path = None
    try:
        from app.core.perf_sampler import PerfStages, perf_enabled
        if perf_enabled():
            perf_stages = PerfStages()
            if job_id:
                perf_path = os.path.join(tempfile.gettempdir(), f"nup_perf_{job_id}.json")
    except Exception:
        perf_stages = None

    canonical_path, is_temporary = _canonicalize_page_space(source_path, job_id)
    if perf_stages is not None:
        perf_stages.mark("canonical_s")
    try:
        return _run_nup_engine_impl(
            canonical_path,
            output_path,
            settings,
            job_id=job_id,
            progress_callback=progress_callback,
            _perf_stages=perf_stages,
        )
    finally:
        if is_temporary:
            try:
                os.remove(canonical_path)
            except FileNotFoundError:
                pass
            except OSError as error:
                logger.warning("[ROTATE-CANON] cannot remove %s: %s", canonical_path, error)
        if perf_stages is not None and perf_path:
            try:
                perf_stages.mark("canonical_cleanup_s")
                from app.core.perf_sampler import write_perf_stages
                write_perf_stages(perf_path, perf_stages.finish())
            except Exception:
                pass


def _run_nup_engine_impl(

    source_path: str,

    output_path: str,

    settings: Dict[str, Any],

    job_id: str = None,

    progress_callback=None,

    _perf_stages=None,

) -> str:
    import math

    page_sheet_mode = settings.get("page_sheet_mode", False) is True
    _mixed_mode_requested = settings.get("layoutType") == "mixed_guillotine"
    if _mixed_mode_requested:
        # MIXED-GUILLOTINE (audit 2026-07-30 §MG.1): mode mới là Bình cắt xén
        # chữ nhật độc lập; không để preset của Tem bế/CNC/nguyên tấm chảy nhầm vào.
        _mixed_incompatible = (
            page_sheet_mode
            or bool(settings.get("isDieCutMode", False))
            or str(settings.get("imposerMode", "") or "").lower() == "cnc"
        )
        if _mixed_incompatible:
            raise ValueError(
                "Dàn nhiều kích thước chỉ dùng cho Bình cắt xén hình chữ nhật."
            )
        if settings.get("mixedGuillotineStrategy", "auto_zone") != "auto_zone":
            raise ValueError(
                "Cách dàn nhiều kích thước hiện tại chỉ hỗ trợ Tự động — dễ cắt xén."
            )

    # ── Fix A (audit bảo toàn nội dung 2026-07-07): canonicalize /Rotate ≠ 0 MỘT LẦN,
    # TRƯỚC cả route CNC, để cả hai nhánh (nup + CNC) nhận file đã chuẩn hoá — mọi bước
    # hạ nguồn (die detection, trim, layout, placement) thấy trang KHÔNG xoay. File không
    # xoay giữ nguyên byte. Temp nup_canon_* được dọn bởi cơ chế dọn OS temp prefix nup_.
    # Rotation is canonicalized by the public wrapper before entering this implementation.

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

    # Polygon contour theo từng loại tem, dùng để né boong trước khi chốt SL/tờ.
    _repeat_collision_poly_by_page = {}

    p5_params = p6_params = p5_row_params = p6_row_params = p5_col_params = p6_col_params = None

    bleed_mm = settings.get('bleed', 0)

    bleed_pt = bleed_mm * MM_TO_PTS

    if page_sheet_mode:
        from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
        _page_sheet_geo = resolve_page_sheet_geometry(src_w, src_h, bleed_pt)
        trim_w = _page_sheet_geo.trim_width
        trim_h = _page_sheet_geo.trim_height
    elif geom_rect:

        trim_w = geom_rect[2] - geom_rect[0]

        trim_h = geom_rect[3] - geom_rect[1]

    elif not is_die_cut:

        # [GUILLOTINE-BOX FIX 2026-08-04] Preview lấy khổ trang logic từ
        # TrimBox/CropBox. Export phải dùng cùng resolver thay vì luôn lấy MediaBox.
        trim_w, trim_h = resolve_guillotine_trim(first_page, bleed_pt)

    else:

        trim_w = src_w - 2 * bleed_pt

        trim_h = src_h - 2 * bleed_pt

    src_doc.close()

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

    # CUT-BORDER (audit 2026-08-04 §CB.4): chuẩn hóa một lần trước khi chuyển qua
    # ProcessPool; page-sheet/tem bế/CNC tuyệt đối không nhận đường cắt thủ công này.
    cut_border_config = resolve_cut_border_config(
        settings,
        is_die_cut=bool(is_die_cut),
        page_sheet_mode=page_sheet_mode,
    )

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

    layout_type = settings.get('layoutType', 'sequential')
    if layout_type == 'mixed_guillotine' and cluster_mode != 'none':
        # MIXED-GUILLOTINE (audit 2026-07-30 §MG.7): solver tự chia vùng; state
        # chia cọc cũ không được làm co vùng giấy hoặc lộ cluster_tile vào mode mới.
        logger.info(
            "[MIXED-GUILLOTINE] bỏ qua clusterMode=%r của preset cũ", cluster_mode
        )
        cluster_mode = 'none'
    is_die_cut = settings.get('isDieCutMode', False)
    # CNC cũng đi nhánh die-cut (imposerMode='cnc' + isDieCutMode).
    imposer_mode = (settings.get('imposerMode') or '').lower()
    is_cnc = imposer_mode == 'cnc' or bool(settings.get('cncMode'))

    # Chia cọc row/column CHỈ cho N-Up xén (guillotine). Tem bế / CNC lấp đầy
    # toàn bộ usable — nếu để clusterMode rò từ N-Up (row/column) sẽ CHIA ĐÔI
    # usable_h/w → tem chỉ nằm 1 dải trên tờ (bug "chỉ bình được 1 phần tờ").
    if is_die_cut or is_cnc:
        if cluster_mode in ('row', 'column'):
            logger.info(
                "   [CLUSTER] ignore clusterMode=%r on die-cut/CNC — use full usable sheet",
                cluster_mode,
            )
        cluster_mode = 'none'

    # Cluster-type (ratio_stack + chia cọc theo LOẠI): KHÔNG chia usable đều theo
    # cluster_count. Bề RỘNG mỗi cọc TỶ LỆ với SL → nhánh precalc cluster_type tự giải
    # lưới ĐẦY ĐỦ tờ rồi phân cột/hàng theo tỷ lệ. Ở đây giữ nguyên usable + cx/cy=1.
    _lt_early = layout_type
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
    # Bình trang là S&R từng source page. Grouping cũ trong preset/UI không được
    # phép đổi mode thành cluster mixed hoặc làm skip full_layouts.
    _requested_grouping_strategy = grouping_strategy
    grouping_strategy = _effective_diecut_grouping(
        layout_type, is_die_cut, grouping_strategy,
    )
    if grouping_strategy != _requested_grouping_strategy:
        logger.info(
            "   [MODE-GUARD] layoutType=repeat: ignore groupingStrategy=cluster_tile"
        )
    cluster_combine_mode = settings.get('clusterCombineMode', 'replicate_mixed')
    logger.info("   ZONE-DEBUG grouping_strategy=%r combine=%r" % (grouping_strategy, cluster_combine_mode))
    cluster_tile_w_mm = settings.get('clusterTileW', 148.0)   # mm, default A5 width
    cluster_tile_h_mm = settings.get('clusterTileH', 210.0)   # mm, default A5 height

    precalculated_placements = None
    cluster_tile_cuts = {}

    # Chế độ ĐỒNG NHẤT (sticker-homogeneous-nup) — mặc định tắt; chỉ bật trong khối die-cut.
    homogeneous_master_idx = None
    # 1 khuôn + N artwork (Bình trang): master path bế — nest/cắt kế thừa, KHÔNG trộn mẫu.
    single_mold_master_idx = None

    # Report state (spec: binh-tem-be-report) — luôn tồn tại để khối finalize đọc được.
    _reports_by_sheet = {}
    _report_rows = []
    _ratio_stack_template_count = 1
    _ratio_stack_export_unique = True
    _ratio_stack_duplex = False
    _ratio_stack_warnings = []  # cảnh báo ratio_stack (unplaced…) → message hoàn tất

    target_quantity = settings.get('targetQuantity', 0)


    target_quantities_by_page = settings.get('targetQuantitiesByPage', {})

    # Check if all targets are 0 (Auto-Fill 1 Sheet mode)

    is_auto_fill = (target_quantity == 0 and not any(v > 0 for v in target_quantities_by_page.values()))

    def _page_sheet_report_fields(extra_identifier: str = "") -> dict:
        """Build the product-level fields required by the whole-sheet report.

        Không nhét gapX/gapY vào identifier: field đó là 「Mẫu/Trang」cho người
        đọc (tên mẫu, số tờ…), còn khe tấm là thông số layout đã có ô nhập riêng.
        """
        quantities = target_quantities_by_page or {}
        requested_qty = 0
        for page_idx in range(page_count):
            raw_qty = quantities.get(
                str(page_idx), quantities.get(page_idx, target_quantity)
            )
            try:
                requested_qty += max(0, int(raw_qty or 0))
            except (TypeError, ValueError):
                continue

        return {
            "width_mm": trim_w / MM_TO_PTS,
            "height_mm": trim_h / MM_TO_PTS,
            "requested_qty": requested_qty,
            "gang_count": max(1, page_count),
            "identifier": (extra_identifier or "").strip(),
        }

    if is_die_cut:

        logger.info(f"\n🚀 [NUP_ENGINE] Running ZONE-BASED N-UP with INTERLOCKING per type")

        logger.info(f"   target_quantity={target_quantity}, is_auto_fill={is_auto_fill}")

        logger.info(f"   target_quantities_by_page={target_quantities_by_page}")

        # ── TIMING: đo từng bước để tìm bottleneck (ghi ra rot_audit.log) ──
        import time as _time
        _t_marks = [('start', _time.perf_counter())]
        def _tlog(_label):
            _now = _time.perf_counter()
            _prev = _t_marks[-1][1]
            _t_marks.append((_label, _now))
            try:
                from app.workers.rot_audit_log import get_logger as _rgl
                _rgl().warning("[CLUSTER-TIMING] %-22s +%6.1fms (tổng %6.1fms)",
                               _label, (_now - _prev) * 1000.0,
                               (_now - _t_marks[0][1]) * 1000.0)
            except Exception:
                pass

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

            # 1 Dao + "theo kích thước trang": trim = mediabox ± offset (nguồn chân lý
            # dùng chung export/preview). Trả None → giữ logic cũ bên dưới.
            _one_dao_trim = resolve_one_dao_trim(
                src_page, settings.get('cutType', 'default'),
                settings.get('dieSizeMode', 'die'), settings.get('dieOffsetMm', 0),
            )

            largest_path = (None if _one_dao_trim is not None
                            else _find_largest_die_path(src_page))

            has_die_by_page[p_idx] = largest_path is not None

            if _one_dao_trim is not None:
                genuine_die_by_page[p_idx] = False
            else:
                try:
                    from app.workers.sticker_homogeneous import page_has_die as _page_has_die
                    genuine_die_by_page[p_idx] = _page_has_die(src_page)
                except Exception:
                    genuine_die_by_page[p_idx] = False

            if _one_dao_trim is not None:

                cur_trim_w, cur_trim_h = _one_dao_trim

            elif largest_path:

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

        # ── 1 khuôn + N artwork (Bình trang S&R): trang 0 có path bế, trang sau không ──
        # Nếu mỗi trang nest riêng, trang không bế rơi về MediaBox → "bình theo trang"
        # và không có đường cắt. Đúng 1 master genuine → gán trim master + nest 1 lần.
        single_mold_master_idx = None
        _genuine_masters = [p for p, v in genuine_die_by_page.items() if v]
        if len(_genuine_masters) == 1 and page_count >= 2:
            single_mold_master_idx = _genuine_masters[0]
            _m_tw, _m_th = trim_by_page[single_mold_master_idx]
            _patched = []
            for p_idx, qty, tw, th in page_infos:
                if p_idx != single_mold_master_idx and not genuine_die_by_page.get(p_idx, False):
                    trim_by_page[p_idx] = (_m_tw, _m_th)
                    _patched.append((p_idx, qty, _m_tw, _m_th))
                else:
                    _patched.append((p_idx, qty, tw, th))
            page_infos = _patched
            logger.info(
                "   [SINGLE-MOLD] master=trang %s trim=%.1fx%.1f → kế thừa %d trang nội dung",
                single_mold_master_idx, _m_tw, _m_th,
                sum(1 for p, v in genuine_die_by_page.items() if not v),
            )

        # Sort page_infos by size ONLY when mixing multiple types on same sheet
        # (e.g. maximize_area, strict_ratio). For 'none' grouping / 'repeat' layout,
        # preserve original page order.
        # CHIA CỤM zone_per_type / zone_ratio: mỗi loại 1 vùng riêng theo THỨ TỰ TRANG
        # (trang 1→N) → KHÔNG sort (sort làm loại nhảy khỏi thứ tự trang người dùng
        # mong đợi). replicate_mixed vẫn sort (gom mọi loại vào 1 cụm, loại to trước).
        _combine_mode_early = settings.get('clusterCombineMode', 'replicate_mixed')
        _zone_mode_early = (grouping_strategy == 'cluster_tile'
                            and _combine_mode_early in ('zone_per_type', 'zone_ratio'))
        if grouping_strategy != 'none' and layout_type != 'repeat' and not _zone_mode_early:
            page_infos.sort(key=lambda x: min(x[2], x[3]), reverse=True)

        _tlog(f"Step1 dò khuôn xong ({len(page_infos)} trang)")

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

        # Zone modes (zone_per_type/zone_ratio) KHÔNG dùng full_layouts (re-nest theo
        # kích thước VÙNG trong dispatch) → bỏ qua nest full-sheet ở đây để khỏi tốn
        # 17 lần NFP shape-aware vô ích (chậm ~1 phút với nhiều loại).
        _skip_full_layouts = (grouping_strategy == 'cluster_tile'
                              and cluster_combine_mode in ('zone_per_type', 'zone_ratio'))

        # Reuse tmp_doc from Step 1 (still open)

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

        def _nest_page_for_full_layout(p_idx, page_obj):
            """Nest 1 trang → layout_result hoặc None."""
            p_shape = None
            if detected_shapes_by_page:
                p_shape = (detected_shapes_by_page.get(str(p_idx))
                           or detected_shapes_by_page.get(p_idx))
            p_shape_props = {}
            if detected_shape_params_by_page:
                p_shape_props = (detected_shape_params_by_page.get(str(p_idx))
                                 or detected_shape_params_by_page.get(p_idx) or {})
            w_for_nfp = usable_w
            h_for_nfp = usable_h
            # Zone modes (zone_per_type/zone_ratio) re-nest theo kích thước VÙNG
            # trong dispatch → full_layouts ở đây chỉ cần full-sheet. Chỉ replicate_mixed
            # mới nest sẵn theo kích thước cụm.
            if (grouping_strategy == 'cluster_tile' and settings.get('clusterNesting', True)
                    and cluster_combine_mode == 'replicate_mixed'):
                cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
                MM = 2.83465
                tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
                tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM
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
                    w_for_nfp = (usable_w - (cluster_cols - 1) * tile_gap_x_pt) / cluster_cols
                    h_for_nfp = (usable_h - (cluster_rows - 1) * tile_gap_y_pt) / cluster_rows
                else:
                    w_for_nfp = float(settings.get('clusterTileW', 148.0)) * MM
                    h_for_nfp = float(settings.get('clusterTileH', 210.0)) * MM

            logger.debug(
                f"   [ZONE DEBUG] p={p_idx} w_for_nfp={w_for_nfp} h_for_nfp={h_for_nfp} "
                f"gap_x={gap_x} gap_y={gap_y} bleed_pt={bleed_pt} secondary_gap={_secondary_gap}"
            )
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
                cut_type=settings.get('cutType', 'default'),
                die_size_mode=settings.get('dieSizeMode', 'die'),
                die_offset_mm=settings.get('dieOffsetMm', 0),
            )
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
            logger.debug(
                f"   [ZONE] Page {p_idx}: full-sheet layout -> {capacity} items "
                f"(strategy={layout_result.get('strategyUsed','?')})"
            )
            return layout_result

        if not _skip_full_layouts and single_mold_master_idx is not None:
            # Nest 1 lần trên trang master (có path bế) → copy cho mọi loại.
            try:
                _ml = _nest_page_for_full_layout(
                    single_mold_master_idx, tmp_doc[single_mold_master_idx],
                )
                for p_idx, _qty, _tw, _th in page_infos:
                    full_layouts[p_idx] = _ml
                logger.info(
                    "   [SINGLE-MOLD] nest master p=%s → %d items, áp dụng %d loại",
                    single_mold_master_idx,
                    len((_ml or {}).get('items') or []),
                    len(page_infos),
                )
            except Exception as e:
                logger.warning(
                    f"   [SINGLE-MOLD] nest master p={single_mold_master_idx} failed: {e} "
                    "→ fallback nest từng trang"
                )
                single_mold_master_idx = None  # fall through to per-page

        if not _skip_full_layouts and not full_layouts:
            for p_idx, qty, tw, th in page_infos:
                page_obj = tmp_doc[p_idx]
                try:
                    full_layouts[p_idx] = _nest_page_for_full_layout(p_idx, page_obj)
                except Exception as e:
                    logger.warning(f"   [ZONE] Layout engine failed for page {p_idx}: {e}")
                    full_layouts[p_idx] = None

        # [PONT TRIANGLE FIX 2026-07-29] Nhánh repeat phải biết số tem SAU né boong
        # trước khi tính report/số tờ. Dựng contour ngay khi tài liệu còn mở để không
        # mở lại PDF; process_chunk sẽ nhận placements đã resolve và không tính lặp.
        _repeat_pont_cfg = (
            settings.get('pontConfig')
            if settings.get('pontType', 'none') != 'none' else None
        )
        if (
            layout_type == 'repeat'
            and _repeat_pont_cfg
            and not _repeat_pont_cfg.get('disableCollision', False)
        ):
            from app.workers.pont_collision import build_collision_base_polygon

            for _p_idx, _qty, _tw, _th in page_infos:
                _fl_repeat = full_layouts.get(_p_idx)
                _items_repeat = (_fl_repeat or {}).get('items') or []
                if not _items_repeat:
                    continue
                _first_item = _items_repeat[0]
                _shape_repeat = (
                    detected_shapes_by_page.get(str(_p_idx))
                    or detected_shapes_by_page.get(_p_idx, 'CUSTOM')
                )
                _is_rect_repeat = (
                    page_sheet_mode
                    or cut_type == 'one_dao'
                    or str(_shape_repeat).upper() == 'RECTANGLE'
                )
                try:
                    _poly_repeat, _ = build_collision_base_polygon(
                        tmp_doc[_p_idx],
                        _shape_repeat,
                        _first_item.get('width', _tw),
                        _first_item.get('height', _th),
                        is_rect_cell=_is_rect_repeat,
                    )
                    _repeat_collision_poly_by_page[_p_idx] = _poly_repeat
                except Exception as _e_poly:
                    logger.warning(
                        "[PONT] Không dựng được contour trang %s trước report: %s",
                        _p_idx + 1,
                        _e_poly,
                    )

        tmp_doc.close()  # Close after both Step 1 and Step 3 are done
        _tlog("Step3 nest full_layouts xong (skip=%s, n=%d, single_mold=%s)" % (
            _skip_full_layouts, len(full_layouts), single_mold_master_idx,
        ))

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
        # CHỈ cho "Dàn nhiều mẫu" (layout_type ≠ repeat): 1 khuôn + N artwork xếp chung.
        # "Bình trang" (step_repeat → layoutType=repeat) = nhân bản MỘT trang đang chọn
        # lấp tờ — KHÔNG được ép homogeneous (sẽ ra dàn 28 loại như multi-sample).
        # Preview đã tách: is_nup_multi loại step_repeat; export trước đây bật nhầm.
        homogeneous_plan = None
        homogeneous_master_idx = None
        # 1 Dao theo kích thước trang cố ý bỏ qua đường khuôn có sẵn. Không để
        # detector homogeneous nhận nhầm một trang thành khuôn master, vì nhánh đó
        # sẽ clip/co artwork theo khuôn cũ thay vì theo hình chữ nhật của trang.
        _page_sized_one_dao = (
            settings.get('cutType', 'default') == 'one_dao'
            and settings.get('dieSizeMode', 'die') == 'page'
        )
        _allow_homogeneous = (layout_type != 'repeat')
        if not _allow_homogeneous:
            logger.info(
                "   [HOMOGENEOUS] Bỏ qua (Bình trang / layoutType=repeat) — chỉ nhân bản 1 trang"
            )
        try:
            if _allow_homogeneous:
                from app.workers import sticker_homogeneous as _sh
                from app.workers.shape_types import ShapeType as _ShapeType, coerce_shape_type as _coerce
                _adapters = []
                for _p in range(page_count):
                    _hd = False if _page_sized_one_dao else genuine_die_by_page.get(_p, False)
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

        if is_die_cut and layout_type != 'repeat' and grouping_strategy == 'cluster_tile':
            # ══ CHIA CỤM (cluster_tile) — ARM ĐẦU TIÊN, chạy bất kể layout_type / số lượng ══
            # Trước đây cluster chỉ chạy ở nhánh repeat / auto_fill; layout 'sequential' +
            # nhập số lượng rơi vào 'else' (bin-pack) → cluster BỊ BỎ. Nay xử lý tập trung
            # tại đây qua SSOT compute_cluster_sheets (dùng CHUNG với preview).
            from app.workers.cluster_tile_engine import compute_cluster_sheets
            MM = MM_TO_PTS
            combine_mode = settings.get('clusterCombineMode', 'replicate_mixed')
            try:
                from app.workers.rot_audit_log import get_logger as _rot_get_logger
                _rot_get_logger().warning(
                    "[CLUSTER-EXPORT] ARM ENTER grouping=%r combine_mode=%r "
                    "clusterCols=%r clusterRows=%r sizing=%r nTypes=%d is_auto_fill=%s",
                    grouping_strategy, combine_mode,
                    settings.get('clusterCols'), settings.get('clusterRows'),
                    settings.get('clusterSizingMode'), len(page_infos), is_auto_fill,
                )
            except Exception:
                pass
            cluster_nesting = settings.get('clusterNesting', True)
            tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
            tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM

            # cluster_w/h (chỉ dùng cho replicate_mixed) theo sizing mode.
            cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
            if cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
                if cluster_sizing_mode == 'split_cols':
                    _c_cols, _c_rows = max(1, int(settings.get('clusterCols', 2))), 1
                elif cluster_sizing_mode == 'split_rows':
                    _c_cols, _c_rows = 1, max(1, int(settings.get('clusterRows', 2)))
                else:
                    _c_cols = max(1, int(settings.get('clusterCols', 2)))
                    _c_rows = max(1, int(settings.get('clusterRows', 2)))
                cw_pt = (usable_w - (_c_cols - 1) * tile_gap_x_pt) / _c_cols
                ch_pt = (usable_h - (_c_rows - 1) * tile_gap_y_pt) / _c_rows
            else:
                cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

            # secondary_gap (khe block phụ) — page-independent, khớp full_layouts loop.
            _fbg = settings.get('fillBlockGap', 0)
            _ct = settings.get('cutType', 'default')
            _sg = settings.get('splitGap', None)
            if _ct == 'one_dao' and _fbg > 0:
                _zone_secondary_gap = _fbg * MM_TO_PTS
            elif _sg is not None and _sg > 0:
                _zone_secondary_gap = _sg * MM_TO_PTS
            else:
                _zone_secondary_gap = None

            # zone_layout_fn: nest 1 loại phủ đầy vùng (kích thước vùng ≠ full sheet).
            # tmp_doc đã đóng ở Step 3 → mở doc riêng, đóng ở finally.
            from app.workers.nup_sticker import compute_sticker_layout_for_page as _csl
            _zone_doc = pdf_lib.open(source_path) if combine_mode in ('zone_per_type', 'zone_ratio') else None

            # Cache nest theo (p_idx, zone_w, zone_h): mọi vùng ĐỀU NHAU nên 1 loại
            # xuất hiện ở K vùng chỉ nest 1 lần (thay vì K lần NFP shape-aware giống hệt).
            _zone_cache = {}

            def _zone_layout_fn(p_idx, zone_w, zone_h):
                if _zone_doc is None:
                    return {'items': []}
                # Một khuôn + N artwork: nest vùng bằng đúng trang master có geometry.
                # src_page_idx của placement vẫn là p_idx nên artwork không bị trộn.
                _geometry_idx = (
                    single_mold_master_idx
                    if single_mold_master_idx is not None
                    else p_idx
                )
                _ck = (_geometry_idx, round(zone_w, 1), round(zone_h, 1))
                _cached = _zone_cache.get(_ck)
                if _cached is not None:
                    return _cached
                _pg = _zone_doc[_geometry_idx]
                _ps = (detected_shapes_by_page.get(str(_geometry_idx))
                       or detected_shapes_by_page.get(_geometry_idx))
                _pp = (detected_shape_params_by_page.get(str(_geometry_idx))
                       or detected_shape_params_by_page.get(_geometry_idx) or {})
                _t_nest = _time.perf_counter()
                try:
                    _res = _csl(
                        _pg, zone_w, zone_h, gap_x, gap_y,
                        strategy=strategy,  # PARITY: preview dùng req.strategy (=gridStrategy)
                        shape_type_override=_ps if _ps else None,
                        shape_props_override=_pp if _pp else None,
                        bleed_pt=bleed_pt,
                        secondary_gap=_zone_secondary_gap,
                        cut_type=settings.get('cutType', 'default'),
                        die_size_mode=settings.get('dieSizeMode', 'die'),
                        die_offset_mm=settings.get('dieOffsetMm', 0),
                    )
                except Exception as _e_zl:
                    logger.warning(f"   [CLUSTER] zone_layout_fn p_idx={p_idx} lỗi: {_e_zl}")
                    _res = {'items': []}
                _tlog(f"nest p_idx={p_idx} zone={round(zone_w,1)}x{round(zone_h,1)} "
                      f"-> {len(_res.get('items', []))} con "
                      f"({(_time.perf_counter() - _t_nest) * 1000:.0f}ms)")
                _zone_cache[_ck] = _res
                return _res

            # full_layouts[p_idx] có thể là None (nest trang đó fail, L696) → dùng an toàn.
            _fl0 = full_layouts.get(page_infos[0][0]) if full_layouts else None

            try:
                cluster_sheets = compute_cluster_sheets(
                    page_infos=page_infos,
                    full_layouts=full_layouts,
                    zone_layout_fn=_zone_layout_fn,
                    sheet_w=usable_w,
                    sheet_h=usable_h,
                    cluster_w=cw_pt,
                    cluster_h=ch_pt,
                    gap_x=gap_x,
                    gap_y=gap_y,
                    tile_gap_x=tile_gap_x_pt,
                    tile_gap_y=tile_gap_y_pt,
                    combine_mode=combine_mode,
                    cluster_nesting=cluster_nesting,
                    is_die_cut=is_die_cut,
                    doc=None,
                    shape_type=(_fl0.get('shapeType', 'CUSTOM') if _fl0 else 'CUSTOM'),
                    shape_props=(_fl0.get('shapeProps', {}) if _fl0 else {}),
                    strategy=strategy,
                    zone_cols=max(1, int(settings.get('clusterCols', 2))),
                    zone_rows=max(1, int(settings.get('clusterRows', 2))),
                )
            finally:
                if _zone_doc is not None:
                    _zone_doc.close()
            _tlog(f"dispatch xong ({len(cluster_sheets)} tờ, cache {len(_zone_cache)} loại)")

            # Shift toạ độ 1 tờ (top-down usable) → tuyệt đối (margin + y-flip).
            ct_offset_x = margin_left
            ct_offset_y = sheet_h - margin_bottom - sheet_usable_h

            def _shift_cluster_placements(_placements):
                _out = []
                for p_item in _placements:
                    ox = p_item['abs_x'] + ct_offset_x
                    oy = p_item['abs_y'] + ct_offset_y
                    shifted = dict(p_item)
                    shifted['abs_x'] = ox
                    shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                    shifted['original_cell_y'] = oy
                    shifted['cell'] = dict(p_item['cell'])
                    shifted['cell']['x'] = ox
                    shifted['cell']['y'] = oy
                    _out.append(shifted)
                return _out

            def _shift_cut_lines(_cuts):
                if not _cuts:
                    return None
                return {
                    'v': {round(x + ct_offset_x, 2) for x in _cuts.get('v', set())},
                    'h': {round(y + ct_offset_y, 2) for y in _cuts.get('h', set())},
                }

            _is_zone = combine_mode in ('zone_per_type', 'zone_ratio')
            _export_unique_ct = bool(settings.get('exportUniqueSheets', True))
            _zone_report_meta_by_sheet = {}

            if _is_zone:
                # Zone tạo một bộ unique sheets; quantity quyết định số chu kỳ in,
                # không được bị mất khỏi report hoặc vật hoá thành raw ratio slots.
                _qty_by_type_zone = {
                    pi[0]: max(0, int(pi[1] or 0)) for pi in page_infos
                }
                _base_counts = []
                _cycle_counts = {}
                for _pls, _cuts in cluster_sheets:
                    _counts = {}
                    for _pl in _pls:
                        _src = _pl['src_page_idx']
                        _counts[_src] = _counts.get(_src, 0) + 1
                        _cycle_counts[_src] = _cycle_counts.get(_src, 0) + 1
                    _base_counts.append(_counts)

                _ratio_cycles = 1
                if not is_auto_fill and combine_mode == 'zone_ratio':
                    for _src, _qty in _qty_by_type_zone.items():
                        _cnt = _cycle_counts.get(_src, 0)
                        if _cnt > 0 and _qty > 0:
                            _ratio_cycles = max(_ratio_cycles, math.ceil(_qty / _cnt))

                _out_idx = 0
                _sheets_needed = 0
                for _base_idx, ((_pls, _cuts), _counts) in enumerate(
                        zip(cluster_sheets, _base_counts)):
                    _print_cycles = 1
                    if not is_auto_fill:
                        if combine_mode == 'zone_ratio':
                            _print_cycles = _ratio_cycles
                        else:
                            for _src, _cnt in _counts.items():
                                _qty = _qty_by_type_zone.get(_src, 0)
                                if _cnt > 0 and _qty > 0:
                                    _print_cycles = max(
                                        _print_cycles, math.ceil(_qty / _cnt),
                                    )
                    _sheets_needed += _print_cycles
                    _req_qty_sheet = sum(
                        _qty_by_type_zone.get(_src, 0) for _src in _counts
                    )
                    _repeat_out = 1 if _export_unique_ct else _print_cycles
                    for _copy_idx in range(_repeat_out):
                        precalculated_placements[_out_idx] = _shift_cluster_placements(_pls)
                        _zone_report_meta_by_sheet[_out_idx] = {
                            'base_idx': _base_idx,
                            'requested_qty': _req_qty_sheet,
                            'print_cycles': _print_cycles,
                        }
                        _scl = _shift_cut_lines(_cuts)
                        if _scl:
                            cluster_tile_cuts[_out_idx] = _scl
                        _out_idx += 1
                total_items_placed = sum(len(p) for p in precalculated_placements.values())
                _n_out_sheets = len(precalculated_placements)
                logger.info(
                    f"   [CLUSTER] mode={combine_mode} lưới → {_n_out_sheets} tờ "
                    f"(cần in {_sheets_needed} tờ, exportUnique={_export_unique_ct}, "
                    f"{len(page_infos)} loại, {total_items_placed} con output)"
                )
            else:
                # ── replicate_mixed: 1 tờ mẫu, nhân theo số lượng như cũ ──
                ct_placements = cluster_sheets[0][0] if cluster_sheets else []
                tile_cut_lines = cluster_sheets[0][1] if cluster_sheets else None
                _count_by_type = {}
                for _pl in ct_placements:
                    _sp = _pl['src_page_idx']
                    _count_by_type[_sp] = _count_by_type.get(_sp, 0) + 1
                _qty_by_type = {pi[0]: pi[1] for pi in page_infos}
                _sheets_needed = 1
                if not is_auto_fill:
                    for _sp, _cnt in _count_by_type.items():
                        if _cnt > 0:
                            _sheets_needed = max(_sheets_needed,
                                                 math.ceil(_qty_by_type.get(_sp, 0) / _cnt))
                _repeat_ct = 1 if _export_unique_ct else max(1, _sheets_needed)
                for _sidx in range(_repeat_ct):
                    precalculated_placements[_sidx] = _shift_cluster_placements(ct_placements)
                    _scl = _shift_cut_lines(tile_cut_lines)
                    if _scl:
                        cluster_tile_cuts[_sidx] = _scl
                total_items_placed = len(ct_placements) * _repeat_ct
                logger.info(
                    f"   [CLUSTER] mode={combine_mode} {len(ct_placements)} con/tờ × {_repeat_ct} tờ "
                    f"(sheets_needed={_sheets_needed}, exportUnique={_export_unique_ct}, types={len(page_infos)})"
                )

            # Report — zone modes: MỖI TỜ 1 report riêng (các loại trên tờ đó);
            # replicate_mixed: 1 report ở tờ 0 như cũ.
            try:
                from app.workers import nup_report as _nr_ct
                _rcfg_ct = settings.get('reportDisplay') or {}
                if _rcfg_ct.get('enabled') and total_items_placed > 0:
                    _paper_ct = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                    _label_ct = _rcfg_ct.get('labelNameText') or ""
                    _material_ct = settings.get('reportMaterial', '') or ''
                    _lam_ct = settings.get('reportLamination', 0) or 0
                    _lam_sides_ct = settings.get('reportLaminationSides', 1) or 1
                    _order_ct = settings.get('reportOrderCode', '') or ''

                    def _build_report(_ips, _req_qty, _identifier, _sheet_count):
                        _d = _nr_ct.compute_report_data(
                            label_name=_label_ct,
                            paper_size=_paper_ct,
                            items_per_sheet=_ips, requested_qty=_req_qty,
                            material=_material_ct,
                            lamination_type=_lam_ct,
                            lamination_sides=_lam_sides_ct,
                            mode_label='Bế tem',
                            order_code=_order_ct,
                            identifier=_identifier,
                            sheet_count_override=_sheet_count,
                        )
                        return _nr_ct.build_report_string(_rcfg_ct, _d)

                    if _is_zone:
                        # Mỗi unique zone sheet mang quantity + số chu kỳ in thật.
                        _n_zone_sheets = len(precalculated_placements)
                        for _sidx in sorted(precalculated_placements.keys()):
                            _ips_s = len(precalculated_placements[_sidx])
                            _meta_s = _zone_report_meta_by_sheet.get(_sidx, {})
                            _base_s = int(_meta_s.get('base_idx', _sidx))
                            _req_s = int(_meta_s.get('requested_qty', 0))
                            _cycles_s = int(_meta_s.get('print_cycles', 1))
                            _reports_by_sheet[_sidx] = _build_report(
                                _ips_s, _req_s,
                                f"Tờ mẫu {_base_s + 1} · {combine_mode}",
                                _cycles_s,
                            )
                        _report_rows.append({
                            'label': _label_ct or f"{len(page_infos)} mẫu",
                            'items_per_sheet': (total_items_placed // max(1, _n_zone_sheets)),
                            'requested_qty': sum(_qty_by_type_zone.values()),
                            'sheet_count': _sheets_needed,
                        })
                    else:
                        _req_qty_ct = sum(max(0, int(pi[1] or 0)) for pi in page_infos) if not is_auto_fill else 0
                        _ips_ct = len(cluster_sheets[0][0]) if cluster_sheets else 0
                        _reports_by_sheet[0] = _build_report(
                            _ips_ct, _req_qty_ct,
                            f"{len(page_infos)} mẫu · {combine_mode}", _sheets_needed,
                        )
                        _report_rows.append({
                            'label': _label_ct or f"{len(page_infos)} mẫu",
                            'items_per_sheet': _ips_ct,
                            'requested_qty': _req_qty_ct, 'sheet_count': _sheets_needed,
                        })
            except Exception as _e_ct:
                logger.warning(f"[REPORT] cluster dựng report lỗi: {_e_ct}")

        elif homogeneous_plan is not None:
            # ══ CHẾ ĐỘ ĐỒNG NHẤT: 1 khuôn master + N trang nội dung (Task 6) ══
            # Chạy cho cả auto-fill LẪN có-số-lượng: _quantities bên dưới đọc số lượng
            # thật theo trang (None khi auto-fill → chia đều thành từng khối mẫu liền nhau).
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
            # Homogeneous thuộc "Dàn nhiều mẫu": quantity chỉ quyết định số lần mỗi
            # artwork xuất hiện, tuyệt đối không đổi semantics thành S&R từng loại.
            _use_per_type = False
            _export_unique_h = bool(settings.get('exportUniqueSheets', True))

            # Nesting master 1 lần, rồi rải quantity xen kẽ/cuốn chiếu qua các tờ.
            _hom_layout = _sh.build_homogeneous_layout(
                master_page=None,
                plan=homogeneous_plan,
                sheet_usable_w=usable_w,
                sheet_usable_h=usable_h,
                gap_x=gap_x,
                gap_y=gap_y,
                bleed_pt=bleed_pt,
                secondary_gap=None,
                quantities=(_content_qtys
                            if any(q > 0 for q in _content_qtys) else None),
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

            from copy import deepcopy as _deepcopy
            from app.workers.imposition_finalize import resolve_pont_collisions_on_placements

            class _RepeatPontRequest:
                pass

            _repeat_pont_req = _RepeatPontRequest()
            _repeat_pont_req.pont_config = (
                settings.get('pontConfig')
                if settings.get('pontType', 'none') != 'none' else None
            )
            _repeat_pont_req.sheet_w = sheet_w
            _repeat_pont_req.sheet_h = sheet_h
            _repeat_pont_req.margin_left = margin_left
            _repeat_pont_req.margin_bottom = margin_bottom

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

                # cluster_tile được xử lý ở ARM ĐẦU TIÊN (compute_cluster_placements),
                # không còn nhánh cluster riêng ở đây.
                # Chốt một template đã né boong rồi mới tính report và số tờ.
                # Đây cũng là chính placements được chuyển sang process_chunk.
                _template_placements = finalize_placements(
                    fl['items'], usable_w, usable_h,
                    margin_left, margin_bottom, margin_top, p_idx,
                )
                _template_placements = resolve_pont_collisions_on_placements(
                    _template_placements,
                    _repeat_pont_req,
                    base_poly=_repeat_collision_poly_by_page.get(p_idx),
                    mark_resolved=True,
                )
                items_per_sheet = len(_template_placements)
                sheets_needed = math.ceil(qty / items_per_sheet) if items_per_sheet > 0 else 1
                repeat_count = 1 if _export_unique else sheets_needed
                _type_report_str = _make_type_report(p_idx, tw, th, items_per_sheet, qty) if _report_enabled else None

                # Mỗi tờ cần bản sao riêng vì worker có thể cập nhật cờ xoay khi dựng.
                for _ in range(repeat_count):
                    precalculated_placements[sheet_idx] = _deepcopy(_template_placements)
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
            # (cluster_tile đã xử ở arm đầu, bất kể auto-fill hay có số lượng.)
            from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed

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
                uniform_if_equal=(
                    settings.get('cutType', 'default') == 'one_dao'
                    and settings.get('dieSizeMode', 'die') == 'page'
                ),
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

        if (
            layout_type != 'mixed_guillotine'
            and strategy == 'manual'
            and (cols_manual <= 0 or rows_manual <= 0)
        ):
            raise ValueError(
                "L\u01b0\u1edbi th\u1ee7 c\u00f4ng c\u1ea7n s\u1ed1 c\u1ed9t v\u00e0 s\u1ed1 d\u00f2ng l\u1edbn h\u01a1n 0."
            )

        # Bình cắt xén không có hình học khuôn: giữ đúng khổ thành phẩm của từng
        # trang. Dàn chồng nhiều khổ không thể cắt an toàn trên một lưới thẳng nên
        # phải báo lỗi thay vì tự co các trang về cùng kích thước.
        _guillotine_trim_by_page = {}
        if not is_die_cut:
            _gdoc_dims = pdf_lib.open(source_path)
            try:
                for _pi_dims in range(_gdoc_dims.page_count):
                    _pg_dims = _gdoc_dims[_pi_dims]
                    if page_sheet_mode:
                        from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
                        _geo_dims = resolve_page_sheet_geometry(
                            _pg_dims.rect.width, _pg_dims.rect.height, bleed_pt,
                        )
                        _tw_dims, _th_dims = _geo_dims.trim_width, _geo_dims.trim_height
                    else:
                        _tw_dims, _th_dims = resolve_guillotine_trim(
                            _pg_dims, bleed_pt,
                        )
                    _guillotine_trim_by_page[_pi_dims] = (_tw_dims, _th_dims)
            finally:
                _gdoc_dims.close()

            if (
                layout_type in ('sequential', 'cut_stacks', 'ratio_stack')
                and (page_sheet_mode or grouping_strategy != 'cluster_tile')
                and len(_guillotine_trim_by_page) > 1
            ):
                _dims_values = list(_guillotine_trim_by_page.values())
                _w0, _h0 = _dims_values[0]
                _mixed_dims = any(
                    abs(_w - _w0) > 0.5 or abs(_h - _h0) > 0.5
                    for _w, _h in _dims_values[1:]
                )
                if _mixed_dims:
                    if page_sheet_mode:
                        raise ValueError(
                            "D\u00e0n nhi\u1ec1u m\u1eabu B\u00ecnh nguy\u00ean t\u1ea5m decal ch\u1ec9 h\u1ed7 tr\u1ee3 c\u00e1c trang "
                            "c\u00f9ng k\u00edch th\u01b0\u1edbc th\u00e0nh ph\u1ea9m sau khi tr\u1eeb bleed."
                        )
                    raise ValueError(
                        "D\u00e0n nhi\u1ec1u m\u1eabu c\u1eaft x\u00e9n ch\u1ec9 h\u1ed7 tr\u1ee3 c\u00e1c trang c\u00f9ng k\u00edch th\u01b0\u1edbc. "
                        "H\u00e3y d\u00f9ng B\u00ecnh trang ho\u1eb7c Chia c\u1ee5m theo t\u1eebng lo\u1ea1i."
                    )

        logger.info(f"[NUP_ENGINE SOLVER DEBUG] usable_w={usable_w:.2f} usable_h={usable_h:.2f} "
                    f"trim_w={trim_w:.2f} trim_h={trim_h:.2f} gap_x={gap_x:.2f} gap_y={gap_y:.2f} "
                    f"strategy={strategy} secondary_gap={secondary_gap} "
                    f"marginBottom={margin_bottom:.2f} marginTop={margin_top:.2f} "
                    f"sheet_h={sheet_h:.2f} split_gap_mm={settings.get('splitGap')} "
                    f"gripperMargin={settings.get('gripperMargin')}")

        _gui_cluster = (grouping_strategy == 'cluster_tile')
        if layout_type == 'mixed_guillotine':
            # MIXED-GUILLOTINE (audit 2026-07-30 §MG.3–§MG.5): planner thuần là
            # nguồn sự thật duy nhất; renderer chỉ chuyển đúng plan sang PDF.
            from app.workers.mixed_guillotine import (
                MixedGuillotineSettings,
                Rect as MixedGuillotineRect,
                build_mixed_guillotine_plan,
            )
            from app.workers.mixed_guillotine_adapter import (
                build_product_specs,
                materialize_plan_for_renderer,
            )

            _mixed_duplex = settings.get('duplexFlow', 'single') == 'double'
            _mixed_products = build_product_specs(
                [
                    _guillotine_trim_by_page[_page_index]
                    for _page_index in range(page_count)
                ],
                target_quantity=target_quantity,
                target_quantities_by_page=target_quantities_by_page,
                duplex=_mixed_duplex,
            )
            _mixed_plan = build_mixed_guillotine_plan(
                _mixed_products,
                MixedGuillotineSettings(
                    sheet_width=sheet_w,
                    sheet_height=sheet_h,
                    usable_rect=MixedGuillotineRect(
                        margin_left, margin_top, usable_w, usable_h
                    ),
                    gap_x=gap_x,
                    gap_y=gap_y,
                    # §MARK-GAP.1: secondary_gap đã đổi splitGap mm → point giống preview.
                    split_gap=secondary_gap,
                    duplex=_mixed_duplex,
                    flip_edge=str(settings.get('duplexFlipEdge', 'long') or 'long'),
                    # §MG-A2: cùng ngưỡng dư preview đã dùng → preview ≡ output.
                    excess_tolerance=float(
                        settings.get('mixedExcessTolerance', 0.0) or 0.0
                    ),
                ),
            )
            # §MG-B2: cảnh báo lề bất đối xứng đi cùng kênh warning sẵn có → hiện ở
            # message hoàn tất, không chặn job (hình học vẫn đúng).
            for _mixed_warn in (_mixed_plan.get('warnings') or []):
                _ratio_stack_warnings.append(f"⚠ {_mixed_warn}")

            _mixed_export_unique = bool(settings.get('exportUniqueSheets', True))
            precalculated_placements, _mixed_face_metadata = materialize_plan_for_renderer(
                _mixed_plan,
                expand_run_count=not _mixed_export_unique,
            )

            # MARKS (audit 2026-08-01 §DXM.1/§DXM.3): dấu thành phẩm đã do Rust
            # vẽ theo placements. Tầng này chỉ chuyển segment tách zone thật; không
            # chiếu thành lưới {v,h} và không thêm mép usableRect, tránh nhân V×H.
            for _output_page_index, _face_meta in _mixed_face_metadata.items():
                _zone_segments = [
                    {
                        'axis': str(_line['axis']),
                        'coordinate': float(_line['coordinate']),
                        'start': float(_line['start']),
                        'end': float(_line['end']),
                    }
                    for _line in _face_meta.get('cutLines', [])
                    if _line.get('kind') == 'zone'
                ]
                if _zone_segments:
                    cluster_tile_cuts[_output_page_index] = {
                        'segments': _zone_segments,
                    }

            _mixed_capacity = max(
                (len(_placements) for _placements in precalculated_placements.values()),
                default=0,
            )
            total_items_placed = sum(
                len(_placements) for _placements in precalculated_placements.values()
            )
            _mixed_required_runs = sum(
                int(_template['runCount']) for _template in _mixed_plan['templates']
            )
            layout = {
                'totalItems': _mixed_capacity,
                'overallWidth': usable_w,
                'overallHeight': usable_h,
                'cells': [],
                'strategyUsed': 'Mixed Guillotine Auto Zone',
            }

            _mixed_report_cfg = settings.get('reportDisplay') or {}
            if _mixed_report_cfg.get('enabled') and _mixed_capacity > 0:
                from app.workers import nup_report as _mixed_report

                _mixed_requested = sum(
                    int(_item['requestedQuantity'])
                    for _item in _mixed_plan['totalsByProduct']
                )
                _mixed_actual = sum(
                    int(_item['actualQuantity'])
                    for _item in _mixed_plan['totalsByProduct']
                )
                _mixed_report_data = _mixed_report.compute_report_data(
                    label_name=_mixed_report_cfg.get('labelNameText') or '',
                    paper_size=f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm",
                    items_per_sheet=_mixed_capacity,
                    requested_qty=_mixed_requested,
                    material=settings.get('reportMaterial', '') or '',
                    lamination_type=settings.get('reportLamination', 0) or 0,
                    lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                    mode_label='Cắt xén',
                    order_code=settings.get('reportOrderCode', '') or '',
                    identifier='Dàn nhiều kích thước',
                    gang_count=len(_mixed_products),
                    sheet_count_override=_mixed_required_runs,
                )
                _mixed_report_data['actualQty'] = f"SL thực: {_mixed_actual}"
                _mixed_report_text = _mixed_report.build_report_string(
                    _mixed_report_cfg, _mixed_report_data
                )
                for _output_page_index, _face_meta in _mixed_face_metadata.items():
                    if _face_meta['side'] == 'front':
                        _reports_by_sheet[_output_page_index] = _mixed_report_text
                _report_rows.append({
                    'label': _mixed_report_cfg.get('labelNameText') or 'Dàn nhiều kích thước',
                    'items_per_sheet': _mixed_capacity,
                    'requested_qty': _mixed_requested,
                    'sheet_count': _mixed_required_runs,
                })
            logger.info(
                "[MIXED-GUILLOTINE] plan=%s output_pages=%d physical_runs=%d duplex=%s",
                _mixed_plan['planHash'], len(precalculated_placements),
                _mixed_required_runs, _mixed_duplex,
            )
        elif _gui_cluster:
            # ══ CHIA CỤM (cluster_tile) cho BÌNH CẮT XÉN (guillotine) ══
            # Tái dùng SSOT compute_cluster_sheets như die-cut, nhưng nest trong VÙNG
            # bằng grid solver (solve_optimal_layout) thay vì NFP shape-aware → nhanh,
            # không đường bế. Hỗ trợ 3 kiểu ghép (replicate_mixed/zone_per_type/zone_ratio)
            # + 2 mặt (duplex). Set precalculated_placements + cluster_tile_cuts → bỏ qua
            # solver lưới đều gốc; process_chunk vẽ thẳng placements + divider vùng.
            from app.workers.cluster_tile_engine import compute_cluster_sheets
            MM = MM_TO_PTS
            combine_mode = settings.get('clusterCombineMode', 'replicate_mixed')
            cluster_nesting = settings.get('clusterNesting', True)
            tile_gap_x_pt = float(settings.get('tileGapX', 0.0)) * MM
            tile_gap_y_pt = float(settings.get('tileGapY', 0.0)) * MM

            _gui_duplex = (settings.get('duplexFlow', 'single') == 'double'
                           and page_count >= 2 and page_count % 2 == 0)
            _n_units_g = (page_count // 2) if _gui_duplex else page_count

            # page_infos guillotine: qty theo trang (duplex → key trang chẵn); trim từ
            # trimbox nếu lệch rect else rect-2*bleed (KHÔNG dò đường bế).
            _gdoc = pdf_lib.open(source_path)
            _gui_page_infos = []
            _gui_trim = {}
            try:
                for _u in range(_n_units_g):
                    _fp = (_u * 2) if _gui_duplex else _u
                    _q = target_quantities_by_page.get(
                        str(_fp), target_quantities_by_page.get(_fp, target_quantity))
                    try:
                        _q = int(_q)
                    except (TypeError, ValueError):
                        _q = 0
                    if _q <= 0:
                        _q = 1
                    _pg = _gdoc[_fp]
                    if page_sheet_mode:
                        from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
                        _geo_gui = resolve_page_sheet_geometry(
                            _pg.rect.width, _pg.rect.height, bleed_pt,
                        )
                        _tw, _th = _geo_gui.trim_width, _geo_gui.trim_height
                    else:
                        _tw, _th = resolve_guillotine_trim(_pg, bleed_pt)
                    _gui_page_infos.append((_fp, _q, _tw, _th))
                    _gui_trim[_fp] = (_tw, _th)
            finally:
                _gdoc.close()

            # replicate_mixed sort theo size (gom mọi loại vào 1 cụm); zone_* giữ thứ tự trang.
            if combine_mode == 'replicate_mixed':
                _gui_page_infos.sort(key=lambda x: min(x[2], x[3]), reverse=True)

            # cw/ch cho replicate_mixed theo sizing mode (mirror die-cut L1015-1029).
            cluster_sizing_mode = settings.get('clusterSizingMode', 'dims')
            if cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
                if cluster_sizing_mode == 'split_cols':
                    _c_cols, _c_rows = max(1, int(settings.get('clusterCols', 2))), 1
                elif cluster_sizing_mode == 'split_rows':
                    _c_cols, _c_rows = 1, max(1, int(settings.get('clusterRows', 2)))
                else:
                    _c_cols = max(1, int(settings.get('clusterCols', 2)))
                    _c_rows = max(1, int(settings.get('clusterRows', 2)))
                cw_pt = (usable_w - (_c_cols - 1) * tile_gap_x_pt) / _c_cols
                ch_pt = (usable_h - (_c_rows - 1) * tile_gap_y_pt) / _c_rows
            else:
                cw_pt = float(settings.get('clusterTileW', 148.0)) * MM
                ch_pt = float(settings.get('clusterTileH', 210.0)) * MM

            # zone_layout_fn: grid solver trong VÙNG (không NFP). cache per-(pidx,zone).
            _gui_zcache = {}

            def _gui_zone_layout_fn(p_idx, zone_w, zone_h):
                _ck = (p_idx, round(zone_w, 1), round(zone_h, 1))
                _hit = _gui_zcache.get(_ck)
                if _hit is not None:
                    return _hit
                _tw, _th = _gui_trim.get(p_idx, (trim_w, trim_h))
                if strategy == 'manual':
                    _sol = solve_manual(
                        _tw, _th, gap_x, gap_y, cols_manual, rows_manual,
                    )
                    if (_sol.get('overallWidth', 0) > zone_w + 0.01
                            or _sol.get('overallHeight', 0) > zone_h + 0.01):
                        raise ValueError("Manual grid exceeds cluster area")
                else:
                    _sol = solve_optimal_layout(
                        zone_w, zone_h, _tw, _th,
                        gap_x, gap_y, strategy, secondary_gap,
                    )
                _items = [{
                    'x': _c['x'], 'y': _c['y'],
                    'width': _c['width'], 'height': _c['height'],
                    'isRotated': _c.get('isRotated', False),
                    'isRotated180': False,
                } for _c in _sol.get('cells', [])]
                _res = {'items': _items}
                _gui_zcache[_ck] = _res
                return _res

            # full_layouts (chỉ replicate_mixed cần orientation): nest ở kích thước cụm.
            _gui_full = {}
            if combine_mode == 'replicate_mixed':
                for _pi, _q, _tw, _th in _gui_page_infos:
                    _gui_full[_pi] = _gui_zone_layout_fn(_pi, cw_pt, ch_pt)

            cluster_sheets = compute_cluster_sheets(
                page_infos=_gui_page_infos,
                full_layouts=_gui_full,
                zone_layout_fn=_gui_zone_layout_fn,
                sheet_w=usable_w,
                sheet_h=usable_h,
                cluster_w=cw_pt,
                cluster_h=ch_pt,
                gap_x=gap_x,
                gap_y=gap_y,
                tile_gap_x=tile_gap_x_pt,
                tile_gap_y=tile_gap_y_pt,
                combine_mode=combine_mode,
                cluster_nesting=cluster_nesting,
                is_die_cut=False,
                doc=None,
                shape_type='RECTANGLE',
                shape_props={},
                strategy=strategy,
                zone_cols=max(1, int(settings.get('clusterCols', 2))),
                zone_rows=max(1, int(settings.get('clusterRows', 2))),
            )

            # Shift top-down usable → abs (margin + y-flip). Mirror die-cut L1113-1138.
            ct_offset_x = margin_left
            ct_offset_y = sheet_h - margin_bottom - sheet_usable_h

            def _gshift(_placements, _page_map=None):
                _out = []
                for p_item in _placements:
                    ox = p_item['abs_x'] + ct_offset_x
                    oy = p_item['abs_y'] + ct_offset_y
                    shifted = dict(p_item)
                    shifted['abs_x'] = ox
                    shifted['abs_y'] = usable_h + margin_bottom + margin_top - oy - p_item['height']
                    shifted['original_cell_y'] = oy
                    shifted['cell'] = dict(p_item['cell'])
                    shifted['cell']['x'] = ox
                    shifted['cell']['y'] = oy
                    if _page_map is not None:
                        shifted['src_page_idx'] = _page_map(p_item.get('src_page_idx', 0))
                    _out.append(shifted)
                return _out

            def _gshift_cuts(_cuts):
                if not _cuts:
                    return None
                return {
                    'v': {round(x + ct_offset_x, 2) for x in _cuts.get('v', set())},
                    'h': {round(y + ct_offset_y, 2) for y in _cuts.get('h', set())},
                }

            def _gui_back_page(_sp):
                # Trang lẻ (mặt sau) = trang chẵn + 1; thiếu → tái dùng mặt trước.
                _bp = _sp + 1
                return _bp if _bp < page_count else _sp

            precalculated_placements = {}
            _is_zone = combine_mode in ('zone_per_type', 'zone_ratio')
            _export_unique_ct = bool(settings.get('exportUniqueSheets', True))

            # Danh sách tờ front (placements, cuts).
            if _is_zone:
                _front_sheets = list(cluster_sheets)
            else:
                # replicate_mixed: 1 tờ mẫu × sheets_needed (ceil SL/con-mỗi-loại).
                _ctp = cluster_sheets[0][0] if cluster_sheets else []
                _ctc = cluster_sheets[0][1] if cluster_sheets else None
                _count_by_type = {}
                for _pl in _ctp:
                    _sp = _pl['src_page_idx']
                    _count_by_type[_sp] = _count_by_type.get(_sp, 0) + 1
                _qty_by_type = {pi[0]: pi[1] for pi in _gui_page_infos}
                _sheets_needed = 1
                for _sp, _cnt in _count_by_type.items():
                    if _cnt > 0:
                        _sheets_needed = max(
                            _sheets_needed, math.ceil(_qty_by_type.get(_sp, 0) / _cnt))
                _repeat_ct = 1 if _export_unique_ct else max(1, _sheets_needed)
                _front_sheets = [(_ctp, _ctc) for _ in range(_repeat_ct)]

            # Đặt precalc; duplex → đan front (tờ chẵn) / back (tờ lẻ, map trang lẻ +
            # process_chunk mirror). KHÔNG để L2404 đan lại (guard cluster_tile).
            if _gui_duplex:
                for _s, (_pls, _cuts) in enumerate(_front_sheets):
                    precalculated_placements[_s * 2] = _gshift(_pls)
                    precalculated_placements[_s * 2 + 1] = _gshift(_pls, _page_map=_gui_back_page)
                    _scl = _gshift_cuts(_cuts)
                    if _scl:
                        cluster_tile_cuts[_s * 2] = _scl
                        cluster_tile_cuts[_s * 2 + 1] = _scl
            else:
                for _s, (_pls, _cuts) in enumerate(_front_sheets):
                    precalculated_placements[_s] = _gshift(_pls)
                    _scl = _gshift_cuts(_cuts)
                    if _scl:
                        cluster_tile_cuts[_s] = _scl

            total_items_placed = sum(len(p) for p in precalculated_placements.values())

            # Report (mode_label='Cắt xén') — mỗi tờ 1 dòng.
            try:
                from app.workers import nup_report as _nr_g
                _rcfg_g = settings.get('reportDisplay') or {}
                if _rcfg_g.get('enabled') and total_items_placed > 0:
                    _paper_g = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
                    _label_g = _rcfg_g.get('labelNameText') or ""
                    _n_output_pages_g = len(precalculated_placements)
                    _n_physical_sheets_g = (
                        _n_output_pages_g // 2 if _gui_duplex else _n_output_pages_g
                    )
                    _ips_g = total_items_placed // max(1, _n_output_pages_g)
                    _ps_report_g = (
                        _page_sheet_report_fields()
                        if page_sheet_mode else {}
                    )
                    _data_g = _nr_g.compute_report_data(
                        label_name=_label_g,
                        width_mm=_ps_report_g.get("width_mm", 0),
                        height_mm=_ps_report_g.get("height_mm", 0),
                        paper_size=_paper_g,
                        items_per_sheet=_ips_g,
                        requested_qty=_ps_report_g.get("requested_qty", 0),
                        material=settings.get('reportMaterial', '') or '',
                        lamination_type=settings.get('reportLamination', 0) or 0,
                        lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                        mode_label='Bình nguyên tấm decal' if page_sheet_mode else 'Cắt xén',
                        order_code=settings.get('reportOrderCode', '') or '',
                        identifier=(
                            _ps_report_g.get("identifier", "")
                            if page_sheet_mode
                            else f"{len(_gui_page_infos)} mẫu · {combine_mode}"
                        ),
                        gang_count=_ps_report_g.get("gang_count", 0),
                        sheet_count_override=_n_physical_sheets_g,
                    )
                    _rep_str_g = _nr_g.build_report_string(_rcfg_g, _data_g)
                    for _physical_idx in range(_n_physical_sheets_g):
                        _report_page_idx = (
                            _physical_idx * 2 if _gui_duplex else _physical_idx
                        )
                        _reports_by_sheet[_report_page_idx] = _rep_str_g
                    _report_rows.append({
                        'label': _label_g or f"{len(_gui_page_infos)} mẫu",
                        'items_per_sheet': _ips_g,
                        'requested_qty': _ps_report_g.get("requested_qty", 0),
                        'sheet_count': _n_physical_sheets_g,
                    })
            except Exception as _e_g:
                logger.warning(f"[REPORT] guillotine cluster report lỗi: {_e_g}")

            layout = {
                'totalItems': total_items_placed,
                'overallWidth': usable_w,
                'overallHeight': usable_h,
                'cells': [],
                'strategyUsed': 'Guillotine Zone-Based Cluster',
            }
            logger.info(
                "[GUI-CLUSTER] mode=%s %d tờ, %d con, duplex=%s, types=%d",
                combine_mode, len(precalculated_placements), total_items_placed,
                _gui_duplex, len(_gui_page_infos),
            )
        elif strategy == 'manual' and cols_manual > 0 and rows_manual > 0:
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
            layout = solve_optimal_layout(
                usable_w, usable_h, trim_w, trim_h,
                gap_x, gap_y, strategy, secondary_gap,
            )

        if strategy == 'manual':
            if (
                layout.get('overallWidth', 0) > usable_w + 0.01
                or layout.get('overallHeight', 0) > usable_h + 0.01
            ):
                raise ValueError(
                    "L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng. "
                    "H\u00e3y gi\u1ea3m s\u1ed1 c\u1ed9t ho\u1eb7c s\u1ed1 d\u00f2ng."
                )

        logger.debug("[NUP_ENGINE SOLVER RESULT] totalItems=%s strategy=%s",
                     layout.get('totalItems'), layout.get('strategyUsed'))



    capacity = layout['totalItems']

    total_capacity = capacity * cx_count * cy_count

    # Repeat may contain resized pages with different capacities. Build the
    # sheet count from each page's own geometry; process_chunk uses the same
    # sheet_mapping to select the matching layout during render.
    _repeat_capacity_by_page = {}
    if layout_type == 'repeat' and not is_die_cut and precalculated_placements is None:
        for _pi_repeat in range(page_count):
            _tw_repeat, _th_repeat = _guillotine_trim_by_page.get(
                _pi_repeat, (trim_w, trim_h)
            )
            if strategy == 'manual':
                _repeat_layout = solve_manual(
                    _tw_repeat, _th_repeat, gap_x, gap_y,
                    cols_manual, rows_manual,
                )
                if (
                    _repeat_layout.get('overallWidth', 0) > usable_w + 0.01
                    or _repeat_layout.get('overallHeight', 0) > usable_h + 0.01
                ):
                    raise ValueError(
                        f"L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y \u1edf trang {_pi_repeat + 1}."
                    )
            else:
                _repeat_layout = solve_optimal_layout(
                    usable_w, usable_h, _tw_repeat, _th_repeat,
                    gap_x, gap_y, strategy, secondary_gap,
                )
            _repeat_capacity_by_page[_pi_repeat] = int(_repeat_layout['totalItems']) * cx_count * cy_count
            if _repeat_capacity_by_page[_pi_repeat] < 1:
                raise ValueError(
                    f"Trang {_pi_repeat + 1} kh\u00f4ng th\u1ec3 x\u1ebfp v\u00e0o v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng."
                )


    if total_capacity < 1:

        raise ValueError(f"Sheet too small for source pages. Cannot fit any items.")

    sheet_mapping = []

    if precalculated_placements is not None:

        total_sheets = max(precalculated_placements.keys()) + 1 if precalculated_placements else 1

    elif layout_type == 'repeat':

        _repeat_duplex = (
            settings.get('duplexFlow') == 'double'
            and not is_die_cut
            and page_count >= 2
        )

        if _repeat_duplex:
            # Bình cắt xén hai mặt: UI lưu số lượng theo trang CHẴN (mặt trước).
            # Chuẩn hóa cùng số lượng cho cả cặp để worker cắt tờ cuối hai mặt giống nhau.
            _normalized_repeat_quantities = dict(target_quantities_by_page or {})
            for _front_idx in range(0, page_count, 2):
                _back_idx = _front_idx + 1
                _front_w, _front_h = _guillotine_trim_by_page.get(
                    _front_idx, (trim_w, trim_h)
                )
                _back_w, _back_h = _guillotine_trim_by_page.get(
                    _back_idx, (trim_w, trim_h)
                )
                if (
                    abs(_front_w - _back_w) > 0.5
                    or abs(_front_h - _back_h) > 0.5
                ):
                    raise ValueError(
                        "Bình 2 mặt yêu cầu mặt trước/sau của cùng một sản phẩm "
                        "có cùng kích thước thành phẩm. "
                        f"Cặp trang {_front_idx + 1}–{_back_idx + 1} hiện khác kích thước."
                    )

                _pair_qty_raw = target_quantities_by_page.get(
                    str(_front_idx),
                    target_quantities_by_page.get(_front_idx, target_quantity),
                )
                try:
                    _pair_qty = max(0, int(_pair_qty_raw or 0))
                except (TypeError, ValueError):
                    _pair_qty = 0

                _pair_capacity = max(
                    1,
                    min(
                        _repeat_capacity_by_page.get(_front_idx, total_capacity),
                        _repeat_capacity_by_page.get(_back_idx, total_capacity),
                    ),
                )
                _pair_sheets = (
                    math.ceil(_pair_qty / _pair_capacity)
                    if _pair_qty > 0
                    else 1
                )
                _normalized_repeat_quantities[str(_front_idx)] = _pair_qty
                _normalized_repeat_quantities[str(_back_idx)] = _pair_qty
                for _ in range(_pair_sheets):
                    sheet_mapping.extend([_front_idx, _back_idx])

            target_quantities_by_page = _normalized_repeat_quantities

        else:
            for p in range(page_count):

                str_p = str(p)

                if str_p in target_quantities_by_page:

                    qty = target_quantities_by_page[str_p]

                elif p in target_quantities_by_page:

                    qty = target_quantities_by_page[p]

                else:

                    qty = target_quantity

                if qty > 0:

                    sheets = math.ceil(qty / max(1, _repeat_capacity_by_page.get(p, total_capacity)))

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
        from app.workers.nup_layout_solver import compute_ratio_stack_templates
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
        _ratio_stack_duplex = _duplex_rs
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

        _template_allocs_rs = compute_ratio_stack_templates(capacity, _qtys)
        _ratio_stack_template_count = len(_template_allocs_rs)
        # Giữ contract cũ của ratio_stack: PDF chỉ chứa các tờ mẫu duy nhất;
        # runCount nằm trong lệnh in, không nhân hàng trăm trang giống hệt nhau.
        _ratio_stack_export_unique = True

        # Dựng một tờ mẫu: các ô cùng đơn vị nằm liền nhau và giữ nguyên vị trí
        # xuyên suốt chồng giấy. Mỗi template tự canh theo số ô thật của nó.
        def _build_template_rs(_cells_per_unit, _page_of_unit):
            _slot_to_unit_rs = []
            for _ui_rs, _cnt_rs in enumerate(_cells_per_unit):
                _slot_to_unit_rs.extend([_ui_rs] * int(_cnt_rs))
            _n_used_rs = min(len(_slot_to_unit_rs), len(_cells_rs))
            _sc_rs = _cells_rs[:_n_used_rs]
            _bw_rs = max((c['x'] + c['width'] for c in _sc_rs), default=0.0)
            _bh_rs = max((c['y'] + c['height'] for c in _sc_rs), default=0.0)
            if 'left' in _align_rs:
                _bx_rs = margin_left
            elif 'right' in _align_rs:
                _bx_rs = sheet_w - margin_right - _bw_rs
            else:
                _bx_rs = margin_left + (sheet_usable_w - _bw_rs) / 2
            if 'top' in _align_rs:
                _byb_rs = sheet_h - margin_top - _bh_rs
            elif 'bottom' in _align_rs:
                _byb_rs = margin_bottom
            else:
                _byb_rs = margin_bottom + (sheet_usable_h - _bh_rs) / 2

            _tpl = []
            for _j_rs in range(_n_used_rs):
                _c_rs = _sc_rs[_j_rs]
                _ax_rs = _bx_rs + _c_rs['x']
                _ayb_rs = _byb_rs + (
                    _bh_rs - _c_rs['y'] - _c_rs['height']
                )
                _tpl.append({
                    'cluster_idx': 0,
                    'cell': dict(_c_rs),
                    'src_page_idx': _page_of_unit(_slot_to_unit_rs[_j_rs]),
                    'abs_x': _ax_rs,
                    'abs_y': _ayb_rs,
                    'width': _c_rs['width'],
                    'height': _c_rs['height'],
                    'original_cell_y': sheet_h - _ayb_rs - _c_rs['height'],
                })
            return _tpl

        # Chỉ xuất mỗi tờ mẫu một lần; duplex đan front/back của từng mẫu liền nhau.
        precalculated_placements = {}
        _front_output_indices_rs = []
        _template_render_data_rs = []
        from copy import deepcopy as _deepcopy_rs
        for _template_idx_rs, _alloc_rs in enumerate(_template_allocs_rs):
            _cpp_rs = _alloc_rs['cellsPerPage']
            _run_count_rs = max(1, int(_alloc_rs.get('nSheets') or 1))
            _front_tpl_rs = _build_template_rs(
                _cpp_rs, (lambda _u_rs: _u_rs * 2) if _duplex_rs else (lambda _u_rs: _u_rs)
            )
            _back_tpl_rs = None
            if _duplex_rs:
                _back_tpl_rs = _build_template_rs(
                    _cpp_rs,
                    lambda _u_rs: (
                        _u_rs * 2 + 1
                        if _u_rs * 2 + 1 < page_count
                        else _u_rs * 2
                    ),
                )

            _front_indices_rs = []
            for _ in range(1):
                _front_idx_rs = len(precalculated_placements)
                precalculated_placements[_front_idx_rs] = _deepcopy_rs(_front_tpl_rs)
                _front_indices_rs.append(_front_idx_rs)
                if _back_tpl_rs is not None:
                    precalculated_placements[len(precalculated_placements)] = _deepcopy_rs(
                        _back_tpl_rs
                    )
            _front_output_indices_rs.append(_front_indices_rs)
            _template_render_data_rs.append({
                'alloc': _alloc_rs,
                'front': _front_tpl_rs,
                'run_count': _run_count_rs,
            })

        total_sheets = len(precalculated_placements)
        _ratio_stack_physical_sheets = sum(
            int(data_rs['run_count']) for data_rs in _template_render_data_rs
        )
        logger.info(
            "[RATIO_STACK] %s loại → %s tờ mẫu, cần in %s tờ vật lý",
            _n_units_rs, _ratio_stack_template_count, _ratio_stack_physical_sheets,
        )

        # Một dòng lệnh in cho mỗi tờ mẫu để tổng số tờ vật lý không bị nhập nhằng.
        _n_types_rs = sum(1 for q in _qtys if q > 0) or _n_units_rs
        _sides_lbl_rs = " · 2 mặt" if _duplex_rs else ""
        _base_label_rs = ((settings.get('reportDisplay') or {}).get('labelNameText')
                          or f"Bình tỷ lệ ({_n_types_rs} mẫu{_sides_lbl_rs})")
        _unplaced_rs = sorted({
            int(page_idx_rs)
            for alloc_rs in _template_allocs_rs
            for page_idx_rs in alloc_rs.get('unplaced', [])
        })
        if _unplaced_rs:
            _up_pages = ", ".join(str(i + 1) for i in _unplaced_rs)
            _ratio_stack_warnings.append(
                f"⚠ Không đủ chỗ trên tờ cho trang {_up_pages} — nên tách sang bài in khác."
            )

        _rcfg_rs = settings.get('reportDisplay') or {}
        try:
            _nr_rs = None
            if _rcfg_rs.get('enabled'):
                from app.workers import nup_report as _nr_rs
            _paper_rs = f"{settings.get('sheetWidth', 0)}x{settings.get('sheetHeight', 0)}mm"
            _PT_MM_rs = 1.0 / MM_TO_PTS
            for _template_idx_rs, _data_tpl_rs in enumerate(_template_render_data_rs):
                _alloc_tpl_rs = _data_tpl_rs['alloc']
                _page_indices_rs = list(_alloc_tpl_rs.get('pageIndices', []))
                _n_types_tpl_rs = len(_page_indices_rs)
                _req_qty_tpl_rs = sum(_qtys[i] for i in _page_indices_rs)
                _run_count_tpl_rs = int(_data_tpl_rs['run_count'])
                _items_tpl_rs = len(_data_tpl_rs['front'])
                _label_tpl_rs = _base_label_rs
                if _ratio_stack_template_count > 1:
                    _label_tpl_rs = (
                        f"{_base_label_rs} · Tờ mẫu {_template_idx_rs + 1}/"
                        f"{_ratio_stack_template_count} ({_n_types_tpl_rs} mẫu)"
                    )
                _report_rows.append({
                    'label': _label_tpl_rs,
                    'items_per_sheet': _items_tpl_rs,
                    'requested_qty': _req_qty_tpl_rs,
                    'sheet_count': _run_count_tpl_rs,
                })

                if _nr_rs is None:
                    continue
                _ps_report_rs = (
                    _page_sheet_report_fields(
                        f"Tờ mẫu {_template_idx_rs + 1}/{_ratio_stack_template_count}"
                    )
                    if page_sheet_mode else {}
                )
                _data_rs = _nr_rs.compute_report_data(
                    label_name=_label_tpl_rs,
                    width_mm=trim_w * _PT_MM_rs, height_mm=trim_h * _PT_MM_rs,
                    paper_size=_paper_rs,
                    items_per_sheet=_items_tpl_rs, requested_qty=_req_qty_tpl_rs,
                    material=settings.get('reportMaterial', '') or '',
                    lamination_type=settings.get('reportLamination', 0) or 0,
                    lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                    mode_label=(
                        'Bình nguyên tấm decal'
                        if page_sheet_mode
                        else ('Cắt xén (chia tỷ lệ, 2 mặt)' if _duplex_rs else 'Cắt xén (chia tỷ lệ)')
                    ),
                    order_code=settings.get('reportOrderCode', '') or '',
                    identifier=(
                        _ps_report_rs.get("identifier", "")
                        if page_sheet_mode
                        else (
                            f"Tờ mẫu {_template_idx_rs + 1}/{_ratio_stack_template_count}"
                            f" · {_n_types_tpl_rs} mẫu{_sides_lbl_rs}"
                        )
                    ),
                    gang_count=_ps_report_rs.get("gang_count", 0),
                    sheet_count_override=_run_count_tpl_rs,
                )
                _report_text_rs = _nr_rs.build_report_string(_rcfg_rs, _data_rs)
                for _front_idx_rs in _front_output_indices_rs[_template_idx_rs]:
                    _reports_by_sheet[_front_idx_rs] = _report_text_rs
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
        and layout_type not in ('sequential', 'cut_stacks', 'ratio_stack', 'mixed_guillotine')
        and grouping_strategy != 'cluster_tile'  # guillotine cluster tự đan front/back trong arm
    ):
        # Chế độ 'repeat': sheet_mapping là list page-idx, nhóm theo trang rồi đan từng cặp.
        if sheet_mapping and len(sheet_mapping) == total_sheets:
            from collections import Counter as _Counter
            _counts = _Counter(sheet_mapping)
            interleaved = []
            for p in range(0, page_count, 2):
                _front_count = _counts.get(p, 0)
                _back_count = _counts.get(p + 1, 0)
                if _front_count != _back_count:
                    raise ValueError(
                        "Bình 2 mặt tạo số tờ mặt trước/sau không khớp. "
                        "Hãy kiểm tra lại số lượng của cặp sản phẩm."
                    )
                for _s in range(_front_count):
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

    repeat_sheet_metadata = (
        _build_repeat_sheet_metadata(sheet_mapping)
        if layout_type == 'repeat' else {}
    )

    # PERF (audit 2026-08-05 §PERF.7): chốt dung lượng sau khi đã biết đúng số
    # tờ, nhưng trước khi fan-out các process và tạo chunk PDF lớn.
    try:
        source_bytes = os.path.getsize(source_path)
    except OSError:
        source_bytes = 0
    ensure_job_disk_space(
        "tạo file bình bản N-Up",
        output_path,
        tempfile.gettempdir(),
        estimate_nup_disk(source_bytes=source_bytes, total_sheets=total_sheets),
    )

    align = settings.get('align', 'center')

    active_grid_w = layout['overallWidth']

    active_grid_h = layout['overallHeight']

    super_grid_w = cx_count * active_grid_w + max(0, cx_count - 1) * cluster_gap

    super_grid_h = cy_count * active_grid_h + max(0, cy_count - 1) * cluster_gap

    cells = layout['cells']

    prog_file = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt") if job_id else None

    # PERF (audit 2026-07-29 §C.3): trước đây chỉ `cpu_count - 1`, KHÔNG đọc RAM — mỗi
    # worker là một process pikepdf giữ tờ in trong bộ nhớ nên máy 8 GB nhiều lõi dễ OOM.
    # `plan_worker_count` gate theo cả CPU và RAM; máy >=16 GB KHÔNG bị hạ theo hằng số.
    # `PRYNX_NUP_WORKERS` vẫn ghi đè được (nay ép cả chiều tăng, không chỉ giảm).
    from app.core.system_memory import plan_worker_count

    available_cores, _worker_reason = plan_worker_count(
        kind="nup",
        per_worker_mb=1024.0,  # 1 chunk = 1 process pikepdf + XObject của vài tờ
        env_override="PRYNX_NUP_WORKERS",
    )
    logger.info("[NUP] %s", _worker_reason)

    # Tối đa 5 tờ/chunk để tránh QPDF khử trùng XObject tăng bậc hai.
    # Job nhỏ chạy nội tuyến; job lớn vẫn dùng đủ ngân sách worker theo RAM/CPU.
    CHUNK_SIZE, planned_worker_count = _plan_nup_chunking(
        total_sheets, available_cores
    )

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

            settings.get('dieSizeMode', 'die'),  # 1 Dao: 'die' (khuôn thật) | 'page' (mediabox±offset)
            settings.get('dieOffsetMm', 0),  # 1 Dao mode=page: offset co(-)/mở(+) mm
            target_quantities_by_page,

            int(settings.get('cols', 0) or 0),

            int(settings.get('rows', 0) or 0),



            {
                s: repeat_sheet_metadata[s] for s in range(start_sheet, end_sheet)
                if s in repeat_sheet_metadata
            } if repeat_sheet_metadata else None,

            (homogeneous_master_idx is not None),  # _homogeneousMode: bật registration đồng nhất (trộn mẫu)

            # Master path bế: homogeneous trộn mẫu HOẶC single-mold Bình trang (chỉ vẽ/geom khuôn).
            homogeneous_master_idx if homogeneous_master_idx is not None else single_mold_master_idx,

            page_sheet_mode,

        )

        # CUT-BORDER (audit 2026-08-04 §CB.4): chỉ nối cấu hình khi thật sự bật.
        # Như vậy mọi job cũ vẫn giữ nguyên ba phần tử đuôi
        # (homogeneous_mode, master_idx, page_sheet_mode); process_chunk vẫn đọc
        # được tuple mở rộng khi N-Up guillotine cần vẽ viền.
        if cut_border_config is not None:
            args = args + (cut_border_config,)

        args_list.append(args)

        chunk_idx += 1

    # BUILD (audit 2026-08-03 §REL.03): engine chỉ chuyển kế hoạch đã chốt sang
    # module kết xuất; các trường ratio-stack được truyền rõ, không dò qua locals().
    return finalize_nup_output(
        NupOutputContext(
            args_list=args_list, planned_worker_count=planned_worker_count,
            output_path=output_path, prog_file=prog_file, perf_stages=_perf_stages,
            is_die_cut=is_die_cut, page_sheet_mode=page_sheet_mode,
            homogeneous_master_idx=homogeneous_master_idx,
            single_mold_master_idx=single_mold_master_idx, layout_type=layout_type,
            settings=settings, reports_by_sheet=_reports_by_sheet,
            report_rows=_report_rows, total_sheets=total_sheets,
            page_count=page_count, capacity=capacity,
            precalculated_placements=precalculated_placements,
            page_sheet_report_fields=_page_sheet_report_fields,
            progress_callback=progress_callback,
            ratio_stack_template_count=_ratio_stack_template_count,
            ratio_stack_export_unique=_ratio_stack_export_unique,
            ratio_stack_duplex=_ratio_stack_duplex,
            ratio_stack_warnings=_ratio_stack_warnings,
            layout=layout, strategy=strategy, total_capacity=total_capacity,
        ),
        chunk_processor=process_chunk,
    )
