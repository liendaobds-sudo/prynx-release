"""
Layout_Helper dùng chung cho công cụ Bình Bế Rớt (CNC) — NGUỒN CHÂN LÝ DUY NHẤT.

`build_cnc_front_layout` dựng layout TRỘN nhiều mẫu cho MỘT tờ Mặt trước:
  - Chọn solver theo tổng số lượng:
      * tổng SL > 0  → solve_offset_mixed  (trộn theo tỉ lệ, có sheets_needed)
      * tổng SL == 0 → solve_auto_fill_mixed (lấp đầy 1 tờ, sheets_needed = 1)
  - Căn giữa bbox nội dung trên usable area (lề dư trái = phải, trên = dưới).
  - Mỗi placement mang src_page_idx của mẫu tương ứng.

Cả cnc_render (render file) lẫn nhánh preview (/preview-layout) đều GỌI hàm này
với cùng đầu vào → cùng đầu ra → preview luôn KHỚP output.

Toạ độ:
  - bin_packing trả về items origin top-left của usable area, y hướng XUỐNG.
  - `placements` (cho render): toạ độ PDF tuyệt đối của tờ (origin bottom-left, y LÊN),
    đúng cấu trúc mà place_one_artwork / draw_die_lines_for_placement tiêu thụ
    (dùng abs_x = mép trái, original_cell_y = mép đáy).
  - `cells` (cho preview): GIỮ NGUYÊN toạ độ bin-pack thô (top-left, y xuống) —
    GridPreview tự căn giữa bằng overall_w/overall_h (giống nhánh mixed của Bình Tem Bế).
"""

from typing import List, Tuple, Dict, Any

from app.workers.sticker_imposer_pkg.bin_packing import (
    solve_offset_mixed,
    solve_auto_fill_mixed,
    _MaxRectsPacker,
)


def _ratio_fill_layout(usable_w, usable_h, page_dims_qty, gap, allow_rotation=True,
                       exclude_zones=None):
    """Lấp đầy MỘT tờ theo TRỌNG SỐ tỉ lệ SL — bounded theo sức chứa tờ.

    Mỗi vòng đặt mẫu đang "thiếu" nhất so với tỉ lệ mục tiêu (placed/weight nhỏ
    nhất) mà CÒN VỪA chỗ. Dừng khi không đặt thêm được. KHÔNG enumerate theo độ
    lớn SL (tránh bùng nổ khi SL lớn như 20000).

    exclude_zones: List[(x,y,w,h)] vùng cấm (boong) trong toạ độ packer — loại NGAY
    lúc xếp để không phải xóa tem sau (tránh để lỗ lớn)."""
    n = len(page_dims_qty)
    qtys = []
    for _, _, _, q in page_dims_qty:
        try:
            qi = int(q)
        except (TypeError, ValueError):
            qi = 0
        qtys.append(max(0, qi))
    total = sum(qtys)
    weights = [(qtys[i] / total) if total > 0 else (1.0 / n) for i in range(n)]

    packer = _MaxRectsPacker(usable_w, usable_h)
    if exclude_zones:
        for zone in exclude_zones:
            packer.exclude(*zone)
    placements = []
    placed = [0] * n
    MAX_ITEMS = 100000  # chặn an toàn
    for _ in range(MAX_ITEMS):
        order = sorted(
            range(n),
            key=lambda i: (placed[i] / weights[i]) if weights[i] > 0 else float('inf'),
        )
        placed_one = False
        for i in order:
            p_idx, w, h, _q = page_dims_qty[i]
            res = packer.insert(w + gap, h + gap, allow_rotation)
            if res is not None:
                rx, ry, rw, rh = res
                is_rot = (abs(rw - (w + gap)) > 0.01)
                dw = h if is_rot else w
                dh = w if is_rot else h
                placements.append({
                    'page_idx': p_idx, 'x': rx + gap / 2, 'y': ry + gap / 2,
                    'w': dw, 'h': dh, 'is_rotated': is_rot,
                })
                placed[i] += 1
                placed_one = True
                break
        if not placed_one:
            break

    placed_by_page = {page_dims_qty[i][0]: placed[i] for i in range(n) if placed[i] > 0}
    return {
        'placements': placements,
        'total_placed': len(placements),
        'placed_by_page': placed_by_page,
    }


def _empty_result() -> Dict[str, Any]:
    return {
        'placements': [],
        'cells': [],
        'items_per_sheet': 0,
        'placed_by_page': {},
        'sheets_needed': 0,
        'overall_w': 0.0,
        'overall_h': 0.0,
    }


def build_cnc_front_layout(
    page_dims_qty: List[Tuple[int, float, float, int]],
    usable_w: float,
    usable_h: float,
    gap: float,
    margin_left: float = 0.0,
    margin_bottom: float = 0.0,
    margin_top: float = 0.0,
    allow_rotation: bool = True,
    exclude_zones=None,
) -> Dict[str, Any]:
    """Dựng layout trộn nhiều mẫu cho MỘT tờ Mặt trước.

    Args:
        page_dims_qty: List[(page_idx, trim_w, trim_h, qty)]. qty=0 nghĩa là chưa nhập.
        usable_w/usable_h: vùng in (đã trừ lề), points.
        gap: khoảng cách giữa các ô, points.
        margin_left/bottom/top: lề tờ (points) để quy đổi sang toạ độ PDF tuyệt đối.
        exclude_zones: List[(x,y,w,h)] vùng cấm boong (toạ độ packer). Nếu có → tem
            được xếp TRÁNH vùng cấm ngay lúc packing (không xóa sau), và KHÔNG
            re-center (giữ nguyên toạ độ packer để khớp đúng vị trí boong trên tờ).

    Returns:
        {placements, cells, items_per_sheet, placed_by_page, sheets_needed,
         overall_w, overall_h}
    """
    if not page_dims_qty:
        return _empty_result()

    # Làm tròn kích thước vùng in + gap về 6 chữ số (1e-6pt ≈ vô nghĩa thực tế) để
    # TRIỆT TIÊU nhiễu dấu-phẩy-động do THỨ TỰ phép tính khác nhau giữa preview
    # (frontend: (sheet-mL-mR)*k) và output (backend: sheet*k - mL*k - mR*k). Chênh
    # ~1e-13 từng làm MaxRects lật số tem ở biên → preview ≠ output. (xác minh thực tế)
    usable_w = round(float(usable_w), 6)
    usable_h = round(float(usable_h), 6)
    gap = round(float(gap), 6)

    total_qty = 0
    for _, _, _, q in page_dims_qty:
        try:
            qi = int(q)
        except (TypeError, ValueError):
            qi = 0
        if qi > 0:
            total_qty += qi

    # Có SL → lấp đầy theo TRỌNG SỐ tỉ lệ SL (bounded, không bùng nổ với SL lớn).
    # Không SL → auto_fill (lấp đầy đều). Cả hai đều kín tờ. Vùng cấm boong (nếu có)
    # được LOẠI ngay lúc xếp (exclude_zones) thay vì xóa tem sau.
    try:
        if total_qty > 0:
            res = _ratio_fill_layout(usable_w, usable_h, page_dims_qty, gap, allow_rotation,
                                     exclude_zones=exclude_zones)
        else:
            page_dims = [(p, w, h) for p, w, h, _ in page_dims_qty]
            res = solve_auto_fill_mixed(
                sheet_w=usable_w, sheet_h=usable_h,
                page_dims=page_dims,
                gap=gap, allow_rotation=allow_rotation,
                exclude_zones=exclude_zones,
            )
    except Exception:
        return _empty_result()

    raw = res.get('placements', []) or []
    if not raw:
        return _empty_result()

    # LUÔN căn giữa nội dung trên usable (nhất quán + KHỚP preview). Vùng cấm boong
    # đã được packer LOẠI ở 4 góc; căn giữa chỉ dịch nội dung VỀ TÂM (ra XA góc boong)
    # nên boong vẫn trống an toàn. (Nhánh has_zones "map trực tiếp không căn giữa" cũ
    # khiến output dồn sát lề trên, khác preview — đã bỏ.)
    min_x = min(it['x'] for it in raw)
    min_y = min(it['y'] for it in raw)
    content_w = max((it['x'] - min_x + it['w'] for it in raw), default=0.0)
    content_h = max((it['y'] - min_y + it['h'] for it in raw), default=0.0)
    x_pad = (usable_w - content_w) / 2.0 if content_w < usable_w else 0.0
    y_pad = (usable_h - content_h) / 2.0 if content_h < usable_h else 0.0
    out_overall_w = content_w
    out_overall_h = content_h

    placements: List[Dict[str, Any]] = []
    cells: List[Dict[str, Any]] = []
    for it in raw:
        x = it['x'] - min_x; y = it['y'] - min_y; w = it['w']; h = it['h']
        is_rot = bool(it.get('is_rotated', False))
        pidx = it['page_idx']

        abs_x = margin_left + x_pad + x
        # original_cell_y = trim_rect.y0 mà place_one_artwork/show_pdf_page hiểu theo
        # TOP-DOWN (y0 nhỏ = TRÊN). Packer y cũng top-down (y=0 = trên) → cùng chiều
        # với cells (preview) → preview == output, KHÔNG lật dọc.
        original_cell_y = margin_top + y_pad + y

        placements.append({
            'cluster_idx': 0,
            'cell': {
                'x': x, 'y': y, 'width': w, 'height': h,
                'isRotated': is_rot, 'isRotated180': False, 'blockId': 0,
            },
            'src_page_idx': pidx,
            'abs_x': abs_x,
            'abs_y': original_cell_y,
            'width': w, 'height': h,
            'original_cell_y': original_cell_y,
        })
        cells.append({
            'x': x, 'y': y, 'width': w, 'height': h,
            'isRotated': is_rot, 'isRotated180': False, 'pageIdx': pidx,
        })

    # Số tờ cần in: theo SL từng mẫu ÷ số con thực mỗi mẫu trên tờ.
    placed = dict(res.get('placed_by_page', {}) or {})
    if total_qty > 0:
        sheets_needed = 1
        for p, _w, _h, q in page_dims_qty:
            try:
                qi = int(q)
            except (TypeError, ValueError):
                qi = 0
            cnt = placed.get(p, placed.get(str(p), 0))
            if qi > 0 and cnt > 0:
                need = -(-qi // cnt)  # ceil(qi / cnt)
                if need > sheets_needed:
                    sheets_needed = need
    else:
        sheets_needed = 1

    return {
        'placements': placements,
        'cells': cells,
        'items_per_sheet': int(res.get('total_placed', len(raw))),
        'placed_by_page': placed,
        'sheets_needed': sheets_needed,
        'overall_w': out_overall_w,
        'overall_h': out_overall_h,
    }


def build_cnc_gang_layout(
    items,
    usable_w: float,
    usable_h: float,
    gap: float,
    margin_left: float = 0.0,
    margin_bottom: float = 0.0,
    margin_top: float = 0.0,
    allow_rotation: bool = True,
    exclude_zones=None,
) -> Dict[str, Any]:
    """Dựng layout gang nhiều mẫu từ DetectedShape (spec die-shape-detection-ssot R8).

    `items`: List[(DetectedShape, qty)]. Khác `build_cnc_front_layout` (chỉ nhận
    kích thước, DROP shape — RC-5), hàm này MANG THEO `shapeType`/`shapeProps`/`poly`
    của từng mẫu vào mỗi cell + placement để render trang Khuôn và preview dùng
    ĐÚNG hình thật thay vì coi mọi mẫu là chữ nhật.

    Đóng gói (packing) hiện vẫn theo hình chữ nhật bao của `trim` (baseline an toàn),
    nên số mẫu/tờ KHÔNG nhỏ hơn bin-pack chữ nhật (R8.5). Việc nâng mật độ bằng
    nesting đa giác cho gang là cải tiến tương lai (không nằm trong phạm vi này).
    """
    if not items:
        return _empty_result()

    shapes_by_page = {}
    page_dims_qty = []
    for shape, qty in items:
        page_dims_qty.append((shape.page, float(shape.trim.w), float(shape.trim.h), qty))
        shapes_by_page[shape.page] = shape

    res = build_cnc_front_layout(
        page_dims_qty, usable_w, usable_h, gap,
        margin_left=margin_left, margin_bottom=margin_bottom, margin_top=margin_top,
        allow_rotation=allow_rotation,
        exclude_zones=exclude_zones,
    )

    # Gắn shape metadata theo page_idx (R8.1, R8.3, R8.6) — render/preview dùng hình thật.
    def _enrich(target, page_key):
        sh = shapes_by_page.get(page_key)
        if sh is None:
            return
        target['shapeType'] = sh.type.name
        target['shapeProps'] = dict(sh.props or {})
        target['poly'] = [list(pt) for pt in (sh.poly or ())]

    for cell in res.get('cells', []):
        _enrich(cell, cell.get('pageIdx'))
    for pl in res.get('placements', []):
        _enrich(pl, pl.get('src_page_idx'))
        if isinstance(pl.get('cell'), dict):
            _enrich(pl['cell'], pl.get('src_page_idx'))

    return res


def select_front_pages(page_count: int, two_sided: bool) -> Tuple[List[int], Dict[int, Any]]:
    """Chọn tập trang Mặt trước + ánh xạ sang Mặt sau.

    - 1 mặt: front = mọi trang [0..n-1], back_of[i] = None.
    - 2 mặt: front = trang chẵn [0,2,4,...], back_of[i] = i+1.
    """
    if two_sided:
        front_idxs = list(range(0, page_count, 2))
        back_of = {i: i + 1 for i in front_idxs}
    else:
        front_idxs = list(range(page_count))
        back_of = {i: None for i in front_idxs}
    return front_idxs, back_of
