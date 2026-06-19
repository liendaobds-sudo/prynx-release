"""
Renderer cho công cụ Bình Bế Rớt (CNC) — bình 2 mặt, xuất 3 trang/đơn vị.

Tách RIÊNG khỏi luồng `repeat` của Bình Tem Bế (an toàn tuyệt đối — không sửa
process_chunk logic), nhưng TÁI DÙNG các primitive dùng chung:
  - compute_sticker_layout_for_page  : solver nesting (dùng CHUNG với Bình Tem Bế) — chế độ S&R Mặt trước.
  - build_cnc_front_layout            : bin-pack trộn nhiều mẫu (gang) — Mặt trước.
  - mirror_placements_multi           : lật gương cả cụm → Mặt sau.
  - nup_artwork.place_one_artwork      : đặt artwork (nguồn chân lý duy nhất).
  - nup_artwork.draw_die_lines_for_placement : vẽ đường bế (Khuôn).
  - nup_marks._draw_ponts_on_page      : vẽ boong định vị (pont) — CHỈ ở Mặt trước + Khuôn.

Bố cục trang:
  - 2 mặt: [Front, Back, Cut] cho mỗi cặp (trang 2k = trước, 2k+1 = sau).
  - 1 mặt: [Front, Cut].
"""

import io
import math
import logging
from typing import Dict, Any

from app.workers import pdf_wrapper as pdf_lib
from app.workers.nup_sticker import compute_sticker_layout_for_page
from app.workers.nup_diecut import _find_largest_die_path
from app.workers.nup_artwork import (
    place_one_artwork,
    compute_block_bbox,
    draw_die_lines_for_placement,
)
from app.workers.nup_marks import _draw_ponts_on_page
from app.workers.cnc_marks import draw_duplex_marks
from app.workers.cnc_layout import build_cnc_front_layout, build_cnc_gang_layout, select_front_pages
from app.workers.die_detection import DetectedShape, Trim, MAX_TRIM_PT
from app.workers.shape_types import coerce_shape_type

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465


def _resolve_cnc_collisions(placements, pont_config, sheet_w, sheet_h,
                            margin_left, margin_bottom, src_doc, detected_shapes_by_page):
    """Dời/loại tem đè vùng cấm boong (pont) — tái dùng pont_collision như Bình Tem Bế.

    Trả placements đã giải va chạm (hoặc nguyên bản nếu không có boong / không va chạm).
    S&R 1 mẫu: dùng polygon hình thật của trang. Gang nhiều mẫu khác trang: dùng
    kiểm tra theo hình chữ nhật bao (base_poly=None) để an toàn.
    """
    if not placements or not pont_config or pont_config.get('disableCollision', False):
        return placements
    try:
        from app.workers.pont_collision import (
            calculate_forbidden_zones, detect_collisions, smart_resolve_collisions,
            build_shapely_polygon_from_paths, MM_TO_PTS as PC_MM,
        )
    except Exception:
        return placements

    def _m(key, default_pt):
        v = pont_config.get(key)
        return v * PC_MM if v is not None else default_pt

    margins = {
        'top': _m('marginTop', margin_bottom),
        'bottom': _m('marginBottom', margin_bottom),
        'left': _m('marginLeft', margin_left),
        'right': _m('marginRight', margin_left),
    }
    try:
        zones = calculate_forbidden_zones(pont_config, margins, sheet_w, sheet_h)
    except Exception:
        return placements
    if not zones:
        return placements

    base_poly = None
    base_rect_pts = (0, 0, placements[0]['width'], placements[0]['height'])
    src_pages = {p['src_page_idx'] for p in placements}
    if len(src_pages) == 1:
        only_idx = next(iter(src_pages))
        shp = None
        if detected_shapes_by_page:
            shp = (detected_shapes_by_page.get(str(only_idx))
                   or detected_shapes_by_page.get(only_idx))
        try:
            if shp == 'CIRCLE_ELLIPSE':
                from shapely.geometry import Point
                from shapely.affinity import scale
                rx = placements[0]['width'] / 2.0
                ry = placements[0]['height'] / 2.0
                base_poly = scale(Point(0, 0).buffer(1.0, resolution=64), xfact=rx, yfact=ry)
                base_rect_pts = (-rx, -ry, rx, ry)
            else:
                paths = src_doc[only_idx].extract_vector_paths()
                if paths:
                    bp = build_shapely_polygon_from_paths(paths, src_doc[only_idx].rect)
                    if bp is not None:
                        base_poly = bp
                        base_rect_pts = bp.bounds
        except Exception:
            base_poly = None

    try:
        if not detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h):
            return placements
        resolved = smart_resolve_collisions(
            placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins
        )
        return resolved or placements
    except Exception:
        return placements


def _build_placements(items, usable_w, usable_h, margin_left, margin_bottom,
                      margin_top, src_page_idx):
    """Dựng danh sách placement (toạ độ tuyệt đối) từ items solver — căn giữa tờ.

    Công thức KHỚP nhánh `repeat` của nup_engine để render đồng nhất.
    """
    if not items:
        return []
    total_content_h = max((it.get('y', 0) + it.get('height', 0) for it in items), default=0.0)
    max_x_used = max((it.get('x', 0) + it.get('width', 0) for it in items), default=0.0)
    x_off = margin_left + (usable_w - max_x_used) / 2 if max_x_used < usable_w else margin_left
    y_off = margin_bottom + (usable_h - total_content_h) / 2 if total_content_h < usable_h else margin_bottom

    placements = []
    for it in items:
        rx = it.get('x', 0)
        ry = it.get('y', 0)
        iw = it.get('width', 0)
        ih = it.get('height', 0)
        abs_y_top = y_off + (total_content_h - ry - ih)
        placements.append({
            'cluster_idx': 0,
            'cell': {
                'x': rx, 'y': ry, 'width': iw, 'height': ih,
                'isRotated': it.get('isRotated', False),
                'isRotated180': it.get('isRotated180', False),
            },
            'src_page_idx': src_page_idx,
            'abs_x': x_off + rx,
            'abs_y': abs_y_top,
            'width': iw, 'height': ih,
            'original_cell_y': usable_h + margin_bottom + margin_top - abs_y_top - ih,
        })
    return placements


def mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of):
    """Lật gương CẢ CỤM Mặt trước (nhiều mẫu) → Mặt sau.

    Mặt sau = ẢNH PHẢN CHIẾU toàn tờ của mặt trước quanh TÂM TỜ. Việc phản chiếu
    (cả VỊ TRÍ lẫn NỘI DUNG) do `place_one_artwork`/`show_pdf_page` thực hiện bằng
    mirror_x/mirror_y quanh tâm trang đích — nên ở ĐÂY KHÔNG dời abs_x/abs_y và
    KHÔNG đổi góc xoay. (Trước đây vừa dời abs_x vừa mirror quanh tâm RECT trang
    nguồn → khi đường bế lệch tâm trong trang, mặt sau bị dịch, mất đối xứng.)
    """
    out = []
    for p in front_pl:
        bp = dict(p)
        bp['cell'] = dict(p['cell'])
        bp['src_page_idx'] = back_of.get(p['src_page_idx'])
        if flip_edge == 'short':
            bp['mirror_x'] = False
            bp['mirror_y'] = True
        else:  # 'long' (mặc định) — lật quanh cạnh dài (trục dọc) → mirror NGANG
            bp['mirror_x'] = True
            bp['mirror_y'] = False
        out.append(bp)
    return out


def _resolve_die_color(color):
    """Màu khuôn: fallback ĐỎ nếu thiếu hoặc vô hình (đen/trắng/spot) — giống process_chunk."""
    if not color:
        return (1, 0, 0)
    _inv = False
    if len(color) == 4:
        if (color[0] < 0.1 and color[1] < 0.1 and color[2] < 0.1 and color[3] < 0.1) or color[3] > 0.9:
            _inv = True
    elif len(color) == 3:
        if (color[0] < 0.1 and color[1] < 0.1 and color[2] < 0.1) or (color[0] > 0.9 and color[1] > 0.9 and color[2] > 0.9):
            _inv = True
    return (1, 0, 0) if _inv else color


def _render_cnc_unit(out_doc, src_doc, front_pl, *, two_sided, flip_edge, back_of,
                     sheet_w, sheet_h, bleed_pt, clip_off_x, clip_off_y,
                     margin_left, margin_bottom, pont_config, duplex_marks, job_id,
                     diecut_geom_cache, die_items_cache, local_stripped_pages,
                     max_geom_cache):
    """Render MỘT đơn vị bình (1 tờ logic) vào out_doc: Mặt trước → [Mặt sau] → Khuôn.

    Dùng chung cho cả 2 chế độ:
      - Dàn nhiều mẫu (gang): front_pl chứa nhiều mẫu trên cùng 1 tờ.
      - Bình trang (S&R):      front_pl chỉ chứa 1 mẫu (lấp đầy tờ).
    Trả về dict thông tin trang đã thêm (front_page/cut_page) để stamp report.
    """
    front_page = out_doc.page_count

    # ── Mặt trước ──
    front_bbox = compute_block_bbox(front_pl)
    out_front = out_doc.new_page(width=sheet_w, height=sheet_h)
    for p in front_pl:
        place_one_artwork(
            out_front, src_doc, p,
            bleed_pt=bleed_pt, is_die_cut=True, cut_type='default',
            separate_cut_page=True, local_stripped_pages=local_stripped_pages,
            job_id=job_id, diecut_geom_cache=diecut_geom_cache,
            die_items_cache=die_items_cache, max_geom_cache=max_geom_cache,
            block_bbox=front_bbox, clip_off_x=clip_off_x, clip_off_y=clip_off_y,
            find_largest_die_path=_find_largest_die_path,
        )
    if pont_config:
        _draw_ponts_on_page(out_front, front_pl, pont_config, sheet_w, sheet_h,
                            margin_left, margin_bottom)
    if duplex_marks and two_sided:
        draw_duplex_marks(out_front, sheet_w, sheet_h)

    # ── Mặt sau (lật gương cả cụm) ──
    if two_sided:
        back_pl = mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of)
        back_bbox = compute_block_bbox(back_pl)
        out_back = out_doc.new_page(width=sheet_w, height=sheet_h)
        for p in back_pl:
            place_one_artwork(
                out_back, src_doc, p,
                bleed_pt=bleed_pt, is_die_cut=True, cut_type='default',
                separate_cut_page=True, local_stripped_pages=local_stripped_pages,
                job_id=job_id, diecut_geom_cache=diecut_geom_cache,
                die_items_cache=die_items_cache, max_geom_cache=max_geom_cache,
                block_bbox=back_bbox, clip_off_x=clip_off_x, clip_off_y=clip_off_y,
                find_largest_die_path=_find_largest_die_path,
                mirror_x=p.get('mirror_x', False), mirror_y=p.get('mirror_y', False),
            )
        # Mặt sau KHÔNG vẽ boong; nhưng CÓ dấu canh 2 mặt (để canh chồng).
        if duplex_marks:
            draw_duplex_marks(out_back, sheet_w, sheet_h)

    # ── Khuôn (gộp đường bế của TẤT CẢ mẫu trên tờ) ──
    cut_page = out_doc.page_count
    out_cut = out_doc.new_page(width=sheet_w, height=sheet_h)
    cut_shape = out_cut.new_shape()
    drew_any = False
    for p in front_pl:
        cache_key = f"{job_id}_{p['src_page_idx']}"
        cached = die_items_cache.get(cache_key)
        if not (cached and cached.get('items')):
            continue
        die_items = cached['items']
        die_rect = cached['rect']
        die_color = _resolve_die_color(cached.get('color'))
        die_width = max(0.5, float(cached.get('width') or 0.5))
        cell = p['cell']
        draw_die_lines_for_placement(
            cut_shape, die_items, die_rect,
            p['abs_x'], p['original_cell_y'],
            is_rotated=cell.get('isRotated', False),
            is_rotated_180=cell.get('isRotated180', False),
        )
        cut_shape.finish(color=die_color, width=die_width, closePath=False)
        drew_any = True
    if drew_any:
        cut_shape.commit()
    else:
        logger.warning("[CNC] Không có die_items cho mẫu nào → trang khuôn rỗng.")
    if pont_config:
        _draw_ponts_on_page(out_cut, front_pl, pont_config, sheet_w, sheet_h,
                            margin_left, margin_bottom)

    return {'front_page': front_page, 'cut_page': cut_page}


def run_cnc_two_sided(source_path: str, output_path: str, settings: Dict[str, Any],
                      job_id: str = None, progress_callback=None) -> str:
    """Render công cụ CNC. Trả về chuỗi report."""
    two_sided = bool(settings.get('cncTwoSided', settings.get('cnc_two_sided', False)))
    flip_edge = settings.get('cncFlipEdge', settings.get('cnc_flip_edge', 'long'))
    # Boong bế (pont định vị máy cắt) — TÁI DÙNG hệ pont của Bình Tem Bế.
    # Theo script: boong CHỈ vẽ ở Mặt trước + Khuôn, KHÔNG vẽ Mặt sau.
    pont_type = settings.get('pontType', 'none')
    pont_config = settings.get('pontConfig') if pont_type and pont_type != 'none' else None
    # Dấu canh in 2 mặt (KHÁC boong) — vẽ ở CẢ Mặt trước & Mặt sau để canh chồng khi lật giấy.
    duplex_marks = bool(settings.get('cncDuplexMarks', False))
    # Report vẽ lên tờ (tuỳ chọn) — 1 dòng tóm tắt tờ ghép.
    report_cfg = settings.get('reportDisplay') or {}
    report_enabled = bool(report_cfg.get('enabled'))

    src_doc = pdf_lib.open(source_path)
    page_count = src_doc.page_count
    if page_count == 0:
        src_doc.close()
        raise ValueError("File nguồn không có trang nào.")

    # Số trang lẻ khi bật 2 mặt → lỗi rõ ràng (Yêu cầu 2.2)
    if two_sided and page_count % 2 != 0:
        src_doc.close()
        raise ValueError(
            f"Bình 2 mặt cần số trang CHẴN (mỗi cặp = Mặt trước + Mặt sau). "
            f"File có {page_count} trang (lẻ). Hãy bổ sung/bớt 1 trang."
        )

    # ── Kích thước tờ + lề + gap (mm → pt) ──
    sheet_w = settings.get('sheetWidth', 320) * MM_TO_PTS
    sheet_h = settings.get('sheetHeight', 450) * MM_TO_PTS
    gap_x = settings.get('gapX', 0) * MM_TO_PTS
    gap_y = settings.get('gapY', 0) * MM_TO_PTS
    margin_top = settings.get('marginTop', 0) * MM_TO_PTS
    margin_bottom = settings.get('marginBottom', 0) * MM_TO_PTS
    margin_left = settings.get('marginLeft', 0) * MM_TO_PTS
    margin_right = settings.get('marginRight', 0) * MM_TO_PTS
    bleed_pt = settings.get('bleed', 0) * MM_TO_PTS

    usable_w = sheet_w - margin_left - margin_right
    usable_h = sheet_h - margin_top - margin_bottom
    clip_off_x = min(gap_x / 2.0, bleed_pt) if gap_x > 0 else 0.0
    clip_off_y = min(gap_y / 2.0, bleed_pt) if gap_y > 0 else 0.0

    target_quantity = settings.get('targetQuantity', 0)
    target_quantities_by_page = settings.get('targetQuantitiesByPage', {}) or {}

    out_doc = pdf_lib.open()
    # Cache dùng chung cho place_one_artwork
    diecut_geom_cache: Dict[str, Any] = {}
    die_items_cache: Dict[str, Any] = {}
    local_stripped_pages = set()
    MAX_GEOM_CACHE = 200

    # Chế độ TÁC VỤ: layoutType=='repeat' → Bình trang (S&R, mỗi mẫu 1 tờ riêng);
    # ngược lại → Dàn nhiều mẫu (gang nhiều mẫu chung 1 tờ).
    layout_type = settings.get('layoutType', settings.get('layout_type', 'sequential')) or 'sequential'
    is_sr = (layout_type == 'repeat')
    # Shape phát hiện THEO TRANG (từ frontend) + strategy — để S&R parity với Bình Tem Bế.
    detected_shapes_by_page = settings.get('detectedShapesByPage') or {}
    detected_shape_params_by_page = settings.get('detectedShapeParamsByPage') or {}
    sr_strategy = settings.get('gridStrategy') or 'optimal_auto'

    # Danh sách trang Mặt trước + ánh xạ Mặt sau (Yêu cầu 1)
    gap = max(gap_x, gap_y)
    front_idxs, back_of = select_front_pages(page_count, two_sided)

    def _qty_for(p_idx):
        q = target_quantities_by_page.get(str(p_idx),
            target_quantities_by_page.get(p_idx, target_quantity))
        try:
            q = int(q)
        except (TypeError, ValueError):
            q = 0
        return q if q > 0 else 0

    def _trim_dims(page):
        """Kích thước thành phẩm: ưu tiên đường bế lớn nhất, fallback MediaBox - 2*bleed."""
        lp = _find_largest_die_path(page)
        if lp:
            r = lp['rect']
            return r.width, r.height
        return page.rect.width - 2 * bleed_pt, page.rect.height - 2 * bleed_pt

    # ── Dựng layout cho 1 tập mẫu Mặt trước (SL lấy theo trang MẶT TRƯỚC — Yêu cầu 2.3) ──
    def _layout_for(sub_front_idxs):
        if is_sr and len(sub_front_idxs) == 1:
            # Chế độ S&R 1 mẫu -> dùng solver Bình Tem Bế (giữ cấu trúc lồng ghép NFP tổ ong)
            fi = sub_front_idxs[0]
            # Shape override THEO TRANG (giống process_chunk) để parity với Bình Tem Bế + khớp preview.
            frontend_shape = None
            if detected_shapes_by_page:
                frontend_shape = (detected_shapes_by_page.get(str(fi))
                                  or detected_shapes_by_page.get(fi))
            frontend_shape_props = {}
            if detected_shape_params_by_page:
                frontend_shape_props = (detected_shape_params_by_page.get(str(fi))
                                        or detected_shape_params_by_page.get(fi) or {})

            layout = compute_sticker_layout_for_page(
                page=src_doc[fi],
                sheet_usable_w=usable_w,
                sheet_usable_h=usable_h,
                gap_x=gap_x, gap_y=gap_y,
                strategy=sr_strategy,
                shape_type_override=frontend_shape if frontend_shape else None,
                shape_props_override=frontend_shape_props if frontend_shape_props else None,
                bleed_pt=bleed_pt,
                secondary_gap=None
            )
            
            items = layout.get('items', [])
            placements = _build_placements(
                items, usable_w, usable_h, margin_left, margin_bottom, margin_top, fi
            )
            # Xử lý va chạm vùng cấm boong (như Bình Tem Bế) — dời/loại tem đè boong.
            placements = _resolve_cnc_collisions(
                placements, pont_config, sheet_w, sheet_h,
                margin_left, margin_bottom, src_doc, detected_shapes_by_page,
            )
            total_placed = len(placements)

            target_qty = _qty_for(fi)
            sheets_needed = 1
            if target_qty > 0 and total_placed > 0:
                sheets_needed = -(-target_qty // total_placed)
                
            return {
                'placements': placements,
                'cells': items,
                'items_per_sheet': total_placed,
                'placed_by_page': {fi: total_placed},
                'sheets_needed': sheets_needed,
                'overall_w': layout.get('widthUsed', usable_w),
                'overall_h': layout.get('heightUsed', usable_h),
            }
        else:
            # Dàn nhiều mẫu (gang) → dùng DetectedShape để GIỮ hình thật của từng
            # mẫu (sửa RC-5: trước đây bin-pack chữ nhật làm mất hình). Packing vẫn
            # theo chữ nhật bao của trim (baseline an toàn — R8.5), nhưng mỗi cell
            # mang theo shapeType/shapeProps/poly để trang Khuôn + preview đúng hình.
            gang_items = []
            for fi in sub_front_idxs:
                tw, th = _trim_dims(src_doc[fi])
                stype = (detected_shapes_by_page.get(str(fi))
                         or detected_shapes_by_page.get(fi) or 'CUSTOM')
                sprops = (detected_shape_params_by_page.get(str(fi))
                          or detected_shape_params_by_page.get(fi) or {})
                try:
                    _stype = coerce_shape_type(stype)
                except Exception:
                    _stype = coerce_shape_type('CUSTOM')
                _w = min(MAX_TRIM_PT, max(0.001, float(tw)))
                _h = min(MAX_TRIM_PT, max(0.001, float(th)))
                shape = DetectedShape(
                    page=fi, type=_stype,
                    props=dict(sprops) if isinstance(sprops, dict) else {},
                    trim=Trim(_w, _h), poly=(),
                    source='vector' if _stype is not coerce_shape_type('CUSTOM') else 'custom',
                    confidence=1.0 if _stype is not coerce_shape_type('CUSTOM') else 0.0,
                )
                gang_items.append((shape, _qty_for(fi)))
            # Va chạm boong: LOẠI vùng cấm NGAY lúc packing (thay vì xếp xong mới
            # xóa → để lỗ lớn). Dùng helper CHUNG với preview → preview == output.
            gang_exclude = []
            if pont_config and not pont_config.get('disableCollision', False):
                try:
                    from app.workers.pont_collision import compute_packer_exclude_zones
                    gang_exclude = compute_packer_exclude_zones(
                        pont_config, sheet_w, sheet_h, usable_w, usable_h,
                        margin_left, margin_bottom, gap,
                    )
                except Exception:
                    gang_exclude = []
            res = build_cnc_gang_layout(
                gang_items, usable_w, usable_h, gap,
                margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
                exclude_zones=gang_exclude or None,
            )
            # Tính số đếm theo placements thực (đã tránh boong lúc xếp).
            res['items_per_sheet'] = len(res['placements'])
            _pbp = {}
            for _p in res['placements']:
                _pbp[_p['src_page_idx']] = _pbp.get(_p['src_page_idx'], 0) + 1
            res['placed_by_page'] = _pbp
            _sn = 1
            for fi in sub_front_idxs:
                _cnt = _pbp.get(fi, 0)
                _q = _qty_for(fi)
                if _q > 0 and _cnt > 0:
                    _sn = max(_sn, -(-_q // _cnt))
            res['sheets_needed'] = _sn
            return res

    # ── Dựng danh sách "đơn vị bình" ──
    #  - Bình trang (S&R): MỖI mẫu → 1 đơn vị (1 tờ riêng, lấp đầy bằng chính mẫu đó).
    #  - Dàn nhiều mẫu:    TẤT CẢ mẫu → 1 đơn vị (gang chung 1 tờ).
    if is_sr:
        units = [([fi], _layout_for([fi])) for fi in front_idxs]
    else:
        units = [(list(front_idxs), _layout_for(front_idxs))]

    # ── Guard "mẫu lớn hơn tờ" (Yêu cầu audit #3): nếu KHÔNG xếp được con nào trên
    # bất kỳ đơn vị bình nào → báo lỗi RÕ thay vì xuất tờ trắng âm thầm. Kèm kích
    # thước mẫu lớn nhất vs vùng in để người dùng biết cách xử (tăng khổ/giảm lề/xoay).
    if not any(lay['placements'] for _, lay in units):
        # Mẫu lớn nhất (theo bbox trim) để gợi ý.
        _big = None
        for fi in front_idxs:
            tw, th = _trim_dims(src_doc[fi])
            if _big is None or (tw * th) > (_big[0] * _big[1]):
                _big = (tw, th)
        src_doc.close()
        out_doc.close()
        _mm = lambda v: round(v / MM_TO_PTS, 1)
        if _big:
            raise ValueError(
                f"Không xếp được mẫu nào lên tờ: mẫu lớn nhất ({_mm(_big[0])}×{_mm(_big[1])}mm) "
                f"lớn hơn vùng in của tờ ({_mm(usable_w)}×{_mm(usable_h)}mm). "
                f"Hãy tăng khổ tờ, giảm lề/khoảng hở, hoặc cho phép xoay mẫu."
            )
        raise ValueError(
            f"Không xếp được mẫu nào lên vùng in ({_mm(usable_w)}×{_mm(usable_h)}mm). "
            f"Hãy kiểm tra khổ tờ và lề."
        )

    # ── Render từng đơn vị: Mặt trước → [Mặt sau lật gương] → Khuôn ──
    report_units = []  # (sub_front_idxs, layout, page_info)
    for sub_front_idxs, layout in units:
        page_info = _render_cnc_unit(
            out_doc, src_doc, layout['placements'],
            two_sided=two_sided, flip_edge=flip_edge, back_of=back_of,
            sheet_w=sheet_w, sheet_h=sheet_h, bleed_pt=bleed_pt,
            clip_off_x=clip_off_x, clip_off_y=clip_off_y,
            margin_left=margin_left, margin_bottom=margin_bottom,
            pont_config=pont_config, duplex_marks=duplex_marks, job_id=job_id,
            diecut_geom_cache=diecut_geom_cache, die_items_cache=die_items_cache,
            local_stripped_pages=local_stripped_pages, max_geom_cache=MAX_GEOM_CACHE,
        )
        report_units.append((sub_front_idxs, layout, page_info))

    total_sheets = sum(lay['sheets_needed'] for _, lay, _ in report_units)

    if progress_callback:
        progress_callback(1, 1, "CNC: hoàn tất")

    buf = io.BytesIO()
    out_doc.save(buf, garbage=0, deflate=True)
    out_doc.close()
    src_doc.close()
    with open(output_path, 'wb') as f:
        f.write(buf.getvalue())

    # ── Vẽ report (1 dòng tóm tắt mỗi đơn vị) lên Mặt trước + Khuôn (tuỳ chọn) ──
    if report_enabled:
        try:
            from app.workers import nup_report as _nr
            reports_by_page = {}
            # Dùng CHUNG builder với tem bế (build_report_string) để khớp preview +
            # tôn trọng toggle bật/tắt field + thứ tự field. Bổ sung 'gangCount' vào
            # fieldOrder nếu cấu hình từ FE chưa có (để số mẫu/tờ vẫn hiển thị cho CNC).
            _cfg = dict(report_cfg)
            _fo = list(_cfg.get('fieldOrder') or _nr.DEFAULT_FIELD_ORDER)
            if 'gangCount' not in _fo:
                _fo = _fo + ['gangCount']
            _cfg['fieldOrder'] = _fo
            for sub_front_idxs, layout, page_info in report_units:
                if is_sr:
                    fi = sub_front_idxs[0]
                    _label = report_cfg.get('labelNameText') or f"Trang {fi + 1}"
                    _qty = _qty_for(fi)
                    _gang = 0
                    _ident = str(fi + 1)
                else:
                    _label = report_cfg.get('labelNameText') or ""
                    _qty = 0
                    _gang = len(sub_front_idxs)
                    _ident = ""
                _data = _nr.compute_report_data(
                    label_name=_label,
                    items_per_sheet=layout['items_per_sheet'],
                    requested_qty=_qty,
                    material=settings.get('reportMaterial', '') or '',
                    lamination_type=settings.get('reportLamination', 0) or 0,
                    lamination_sides=settings.get('reportLaminationSides', 1) or 1,
                    mode_label='Bình bế rớt CNC',
                    order_code=settings.get('reportOrderCode', '') or '',
                    identifier=_ident,
                    gang_count=_gang,
                    sheet_count_override=layout['sheets_needed'],
                )
                # build_report_string đã tự áp removeDiacritics + customText.
                line = _nr.build_report_string(_cfg, _data)
                # Report CHỈ vẽ trên trang IN (mặt trước). KHÔNG vẽ lên trang Khuôn.
                reports_by_page[page_info['front_page']] = line
            _nr.stamp_reports_on_pdf(
                output_path, output_path, reports_by_page,
                position=report_cfg.get('position', 'top'),
                offset_x_mm=float(report_cfg.get('offsetX', 5) or 5),
                offset_y_mm=float(report_cfg.get('offsetY', 5) or 5),
                font_size=float(report_cfg.get('fontSize', 8) or 8),
                centered=bool(report_cfg.get('centered', True)),
            )
        except Exception as _e:
            logger.warning("[CNC] Vẽ report lên tờ lỗi: %s", _e)

    # ── Report (chuỗi tóm tắt) ──
    sr_txt = "Bình trang (mỗi mẫu 1 tờ)" if is_sr else "Dàn nhiều mẫu (gang)"
    mode_txt = "2 mặt (Trước/Sau/Khuôn)" if two_sided else "1 mặt (Trước/Khuôn)"
    lines = ["✅ Hoàn tất Bình Bế Rớt (CNC)!"]
    lines.append(
        f"Kiểu: {sr_txt} | {mode_txt} | "
        f"Lật: {'cạnh dài' if flip_edge == 'long' else 'cạnh ngắn'} | Boong: {pont_type}"
    )
    lines.append("")
    lines.append("📋 LỆNH IN:")
    for sub_front_idxs, layout, _pi in report_units:
        placed_by_page = layout['placed_by_page']
        sheets_needed = layout['sheets_needed']
        if is_sr:
            fi = sub_front_idxs[0]
            n = placed_by_page.get(fi, placed_by_page.get(str(fi), layout['items_per_sheet']))
            qty = _qty_for(fi)
            if qty > 0:
                actual = n * sheets_needed
                lines.append(
                    f"  • Trang {fi + 1}: {n} con/tờ × {sheets_needed} tờ — "
                    f"đặt {qty} → in thực {actual} (dư {actual - qty})"
                )
            else:
                lines.append(f"  • Trang {fi + 1}: {n} con/tờ × {sheets_needed} tờ (SL auto)")
        else:
            lines.append(f"  • Số mẫu ghép trên tờ: {len(sub_front_idxs)}")
            lines.append(f"  • Tổng SL/tờ: {layout['items_per_sheet']} con")
            for fi in sub_front_idxs:
                n = placed_by_page.get(fi, placed_by_page.get(str(fi), 0))
                qty = _qty_for(fi)
                if qty > 0:
                    actual = n * sheets_needed
                    lines.append(
                        f"     - Trang {fi + 1}: {n} con/tờ — đặt {qty} → in thực {actual} (dư {actual - qty})"
                    )
                else:
                    lines.append(f"     - Trang {fi + 1}: {n} con/tờ — SL auto")
    lines.append(f"  ⇒ Số tờ cần in (tổng): {total_sheets}")
    return "\n".join(lines)
