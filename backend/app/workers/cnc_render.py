"""
Renderer cho công cụ Bình Bế Rớt (CNC) — bình 2 mặt, xuất 3 trang/đơn vị.

Tách RIÊNG khỏi luồng `repeat` của Bình Tem Bế (an toàn tuyệt đối — không sửa
process_chunk logic), nhưng TÁI DÙNG các primitive dùng chung:
  - compute_sticker_layout_for_page  : solver layout (Rust) cho Mặt trước.
  - cnc_geometry.mirror_layout        : lật gương → Mặt sau.
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
from app.workers.cnc_layout import build_cnc_front_layout, select_front_pages

logger = logging.getLogger(__name__)

MM_TO_PTS = 2.83465


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


def mirror_placements(front_pl, sheet_w, sheet_h, flip_edge, back_idx):
    """Lật gương danh sách placement Mặt trước (toạ độ TUYỆT ĐỐI của tờ) → Mặt sau.

    Lật ở mức placement đã căn giữa (không lật item thô rồi căn lại) để mỗi ô mặt
    sau khớp KHÍT ô mặt trước khi lật giấy.
      - 'long'  (cạnh dài, lật ngang): left' = sheet_w - (left + w); y giữ nguyên.
      - 'short' (cạnh ngắn, lật dọc):  bottom' = sheet_h - (bottom + h); x giữ nguyên.
    Artwork mặt sau (back_idx) đặt bình thường vào ô đã lật vị trí.
    """
    out = []
    for p in front_pl:
        bp = dict(p)
        bp['cell'] = dict(p['cell'])
        bp['src_page_idx'] = back_idx
        # Lật HƯỚNG XOAY: phản chiếu đảo chiều xoay 90° (front +90 → back -90),
        # 180° giữ nguyên. Theo script: totalRotation += isBackSide ? -90 : 90.
        # Ánh xạ cờ: nếu isRotated thì toggle isRotated180 (90↔270).
        if bp['cell'].get('isRotated', False):
            bp['cell']['isRotated180'] = not bp['cell'].get('isRotated180', False)
        if flip_edge == 'short':
            bp['original_cell_y'] = sheet_h - (p['original_cell_y'] + p['height'])
            bp['abs_y'] = sheet_h - (p['abs_y'] + p['height'])
        else:  # 'long' (mặc định)
            bp['abs_x'] = sheet_w - (p['abs_x'] + p['width'])
        out.append(bp)
    return out


def mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of):
    """Lật gương CẢ CỤM Mặt trước (nhiều mẫu) → Mặt sau.

    Khác `mirror_placements`: mỗi ô có thể thuộc MẪU khác nhau, nên src_page_idx
    của mỗi ô Mặt sau lấy theo `back_of[src_page_idx_mặt_trước]` (= front+1).
    Lật cả VỊ TRÍ (long/short) lẫn HƯỚNG XOAY (đảo chiều 90°, 180° giữ nguyên).
    """
    out = []
    for p in front_pl:
        bp = dict(p)
        bp['cell'] = dict(p['cell'])
        front_src = p['src_page_idx']
        bp['src_page_idx'] = back_of.get(front_src)
        # Lật hướng xoay: đảo chiều 90° (toggle isRotated180 khi isRotated), 180° giữ nguyên.
        if bp['cell'].get('isRotated', False):
            bp['cell']['isRotated180'] = not bp['cell'].get('isRotated180', False)
        if flip_edge == 'short':
            bp['original_cell_y'] = sheet_h - (p['original_cell_y'] + p['height'])
            bp['abs_y'] = sheet_h - (p['abs_y'] + p['height'])
        else:  # 'long' (mặc định)
            bp['abs_x'] = sheet_w - (p['abs_x'] + p['width'])
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

    # SL mỗi mẫu lấy theo trang MẶT TRƯỚC (Yêu cầu 2.3)
    page_dims_qty = []
    for fi in front_idxs:
        tw, th = _trim_dims(src_doc[fi])
        page_dims_qty.append((fi, tw, th, _qty_for(fi)))

    # GỌI HELPER (nguồn chân lý duy nhất) — trộn nhiều mẫu 1 tờ Mặt trước
    layout = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap,
        margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
    )
    front_pl = layout['placements']
    sheets_needed = layout['sheets_needed']
    items_per_sheet = layout['items_per_sheet']
    placed_by_page = layout['placed_by_page']

    # ════ TRANG MẶT TRƯỚC ════
    front_bbox = compute_block_bbox(front_pl)
    out_front = out_doc.new_page(width=sheet_w, height=sheet_h)
    for p in front_pl:
        place_one_artwork(
            out_front, src_doc, p,
            bleed_pt=bleed_pt, is_die_cut=True, cut_type='default',
            separate_cut_page=True, local_stripped_pages=local_stripped_pages,
            job_id=job_id, diecut_geom_cache=diecut_geom_cache,
            die_items_cache=die_items_cache, max_geom_cache=MAX_GEOM_CACHE,
            block_bbox=front_bbox, clip_off_x=clip_off_x, clip_off_y=clip_off_y,
            find_largest_die_path=_find_largest_die_path,
        )
    if pont_config:
        _draw_ponts_on_page(out_front, front_pl, pont_config, sheet_w, sheet_h,
                            margin_left, margin_bottom)
    if duplex_marks and two_sided:
        draw_duplex_marks(out_front, sheet_w, sheet_h)

    # ════ TRANG MẶT SAU (lật gương cả cụm) ════
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
                die_items_cache=die_items_cache, max_geom_cache=MAX_GEOM_CACHE,
                block_bbox=back_bbox, clip_off_x=clip_off_x, clip_off_y=clip_off_y,
                find_largest_die_path=_find_largest_die_path,
            )
        # Mặt sau KHÔNG vẽ boong; nhưng CÓ dấu canh 2 mặt (để canh chồng).
        if duplex_marks:
            draw_duplex_marks(out_back, sheet_w, sheet_h)

    # ════ TRANG KHUÔN (gộp đường bế của TẤT CẢ mẫu trên tờ) ════
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
        # finish PER placement (giống process_chunk) — đúng nét + đúng màu từng mẫu.
        cut_shape.finish(color=die_color, width=die_width, closePath=False)
        drew_any = True
    if drew_any:
        cut_shape.commit()
    else:
        logger.warning("[CNC] Không có die_items cho mẫu nào → trang khuôn rỗng.")
    # Boong bế trên trang Khuôn (để máy cắt canh) — giống pontsOnCutFile của script.
    if pont_config:
        _draw_ponts_on_page(out_cut, front_pl, pont_config, sheet_w, sheet_h,
                            margin_left, margin_bottom)

    if progress_callback:
        progress_callback(1, 1, "CNC: hoàn tất ghép nhiều mẫu")

    buf = io.BytesIO()
    out_doc.save(buf, garbage=0, deflate=True)
    out_doc.close()
    src_doc.close()
    with open(output_path, 'wb') as f:
        f.write(buf.getvalue())

    # ── Vẽ report (1 dòng tóm tắt) lên Mặt trước + Khuôn (tuỳ chọn) ──
    if report_enabled:
        try:
            from app.workers import nup_report as _nr
            parts = []
            _oc = settings.get('reportOrderCode')
            if _oc:
                parts.append(f"ĐH: {_oc}")
            _ln = report_cfg.get('labelNameText')
            if _ln:
                parts.append(str(_ln))
            parts.append("Bình bế rớt CNC")
            parts.append(f"{len(front_idxs)} mẫu")
            parts.append(f"{items_per_sheet} con/tờ")
            parts.append(f"In {sheets_needed} tờ")
            _mat = settings.get('reportMaterial')
            if _mat:
                parts.append(str(_mat))
            _lam = settings.get('reportLamination', 0)
            if _lam:
                parts.append(_nr._format_lamination(_lam, settings.get('reportLaminationSides', 1)))
            line = "  |  ".join(parts)
            if report_cfg.get('removeDiacritics'):
                line = _nr.remove_diacritics(line)
            # Mặt trước = trang 0; Khuôn = trang cuối cụm (2 nếu 2 mặt, 1 nếu 1 mặt).
            cut_idx = 2 if two_sided else 1
            reports_by_page = {0: line, cut_idx: line}
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

    # ── Report ──
    lines = ["✅ Hoàn tất Bình Bế Rớt (CNC) — ghép nhiều mẫu!"]
    mode_txt = "2 mặt (Trước/Sau/Khuôn)" if two_sided else "1 mặt (Trước/Khuôn)"
    lines.append(f"Chế độ: {mode_txt} | Lật: {'cạnh dài' if flip_edge == 'long' else 'cạnh ngắn'} | Boong: {pont_type}")
    lines.append("")
    lines.append("📋 LỆNH IN:")
    lines.append(f"  • Số mẫu ghép trên tờ: {len(front_idxs)}")
    lines.append(f"  • Tổng SL/tờ: {items_per_sheet} con")
    if placed_by_page:
        for fi in front_idxs:
            n = placed_by_page.get(fi, placed_by_page.get(str(fi), 0))
            qty = _qty_for(fi)
            if qty > 0:
                actual = n * sheets_needed
                extra = actual - qty
                lines.append(
                    f"     - Trang {fi + 1}: {n} con/tờ — đặt {qty} → in thực {actual} (dư {extra})"
                )
            else:
                lines.append(f"     - Trang {fi + 1}: {n} con/tờ — SL auto")
    lines.append(f"  ⇒ Số tờ cần in: {sheets_needed}")
    return "\n".join(lines)
