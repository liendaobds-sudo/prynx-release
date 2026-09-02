"""
Layout_Helper dùng chung cho công cụ Bình Bế Rớt (CNC) — NGUỒN CHÂN LÝ DUY NHẤT.

`build_cnc_front_layout` dựng TOÀN BỘ tờ mẫu Mặt trước cho layout TRỘN:
  - Chọn solver theo tổng số lượng:
      * tổng SL > 0  → chia nhóm vừa tờ rồi lấp đầy từng tờ theo tỉ lệ SL.
      * tổng SL == 0 → solve_auto_fill_mixed (mở thêm tờ cho tới khi phủ hết mẫu).
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

import logging
from typing import List, Tuple, Dict, Any

from app.workers.sticker_imposer_pkg.bin_packing import (
    solve_auto_fill_mixed,
    _MaxRectsPacker,
)

logger = logging.getLogger(__name__)


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


# Dung sai khi so tem với vùng cấm (points). Tiếp tuyến KHÔNG phải va chạm — cùng
# tinh thần với PONT_COLLISION_EPS_PT2 ở pont_collision: coi tiếp tuyến là đè sẽ
# dời hoặc xoá tem oan ở gap = 0.
_ZONE_TOUCH_EPS_PT = 1e-6


def _hits_zone(raw, exclude_zones, min_x, min_y, x_pad, y_pad) -> bool:
    """Có tem nào đè vùng cấm với cặp padding này không?

    Toạ độ so sánh là toạ độ PACKER (gốc trên-trái vùng in, y xuống) — đúng hệ mà
    ``exclude_zones`` được khai ở ``pont_collision.compute_packer_exclude_zones``.
    """
    for it in raw:
        x0 = it['x'] - min_x + x_pad
        y0 = it['y'] - min_y + y_pad
        x1 = x0 + it['w']
        y1 = y0 + it['h']
        for zx, zy, zw, zh in exclude_zones:
            if not (x1 <= zx + _ZONE_TOUCH_EPS_PT
                    or x0 >= zx + zw - _ZONE_TOUCH_EPS_PT
                    or y1 <= zy + _ZONE_TOUCH_EPS_PT
                    or y0 >= zy + zh - _ZONE_TOUCH_EPS_PT):
                return True
    return False


def _resolve_safe_padding(raw, exclude_zones, min_x, min_y, x_pad, y_pad):
    """Chọn cặp padding vừa căn giữa được vừa không đẩy tem vào vùng cấm.

    [NEST-11 FIX 2026-08-27] Thử theo thứ tự CỐ ĐỊNH nên kết quả xác định:

    1. căn giữa cả hai trục — ca phổ biến, giữ nguyên output của bản trước;
    2. giữ trục X theo packer, còn căn giữa Y;
    3. căn giữa X, giữ trục Y theo packer;
    4. giữ nguyên toạ độ packer cả hai trục — luôn an toàn vì packer đã tránh vùng cấm.

    ``x_pad = min_x`` tương đương dịch tịnh bằng 0 (``it['x'] - min_x + min_x``), nên
    phương án 4 trả về đúng toạ độ packer mà không cần nhánh riêng ở caller.
    """
    if not exclude_zones:
        return x_pad, y_pad

    for cand_x, cand_y in (
        (x_pad, y_pad),
        (min_x, y_pad),
        (x_pad, min_y),
        (min_x, min_y),
    ):
        if not _hits_zone(raw, exclude_zones, min_x, min_y, cand_x, cand_y):
            if (cand_x, cand_y) != (x_pad, y_pad):
                logger.debug(
                    "[CNC-ZONE] Căn giữa sẽ đẩy tem vào vùng cấm boong → lùi về toạ độ "
                    "packer (x_pad %.3f→%.3f, y_pad %.3f→%.3f).",
                    x_pad, cand_x, y_pad, cand_y,
                )
            return cand_x, cand_y

    # Không thể xảy ra: packer đã xếp tránh vùng cấm nên phương án 4 phải sạch.
    # Nếu tới đây thì vùng cấm và packer đang dùng hai hệ toạ độ khác nhau — báo rõ
    # thay vì giao tờ có tem đè boong cho xưởng.
    logger.error(
        "[CNC-ZONE] Không có phương án căn tờ nào tránh được vùng cấm boong "
        "(%d tem, %d vùng). Giữ toạ độ packer.",
        len(raw), len(exclude_zones),
    )
    raise RuntimeError(
        "Không thể tìm phương án căn tờ CNC an toàn tránh vùng cấm boong"
    )


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
    """Dựng toàn bộ tờ mẫu Mặt trước cho layout trộn nhiều mẫu.

    Args:
        page_dims_qty: List[(page_idx, trim_w, trim_h, qty)]. qty=0 nghĩa là chưa nhập.
        usable_w/usable_h: vùng in (đã trừ lề), points.
        gap: khoảng cách giữa các ô, points.
        margin_left/bottom/top: lề tờ (points) để quy đổi sang toạ độ PDF tuyệt đối.
        exclude_zones: List[(x,y,w,h)] vùng cấm boong (toạ độ packer). Nếu có → tem
            được xếp TRÁNH vùng cấm ngay lúc packing (không xóa sau). Cụm vẫn được
            thử căn giữa; nếu phép dịch gây va chạm thì từng trục lùi xác định về
            toạ độ packer an toàn.

    Returns:
        Top-level giữ tờ đầu để tương thích caller cũ. Khi có nhiều tờ mẫu,
        ``sheets`` chứa đầy đủ từng layout; ``sheets_needed`` top-level là tổng
        lượt in của mọi tờ mẫu khác nhau.
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
    normalized_qty: Dict[int, int] = {}
    for page_idx, _, _, q in page_dims_qty:
        try:
            qi = int(q)
        except (TypeError, ValueError):
            qi = 0
        qi = max(0, qi)
        normalized_qty[page_idx] = qi
        total_qty += qi

    # CNC MULTI-SHEET FIX 2026-08-10 §MSHEET.1:
    # - Solver auto-fill đã biết mở thêm tờ khi số loại vượt sức chứa.
    # - Với ca có SL, dùng auto-fill CHỈ để chia nhóm loại vừa từng tờ, rồi giữ nguyên
    #   thuật toán ratio-fill hiện tại trên từng nhóm. Như vậy không enumerate theo SL
    #   lớn và không làm đổi mật độ/tỉ lệ của ca vốn vừa một tờ.
    try:
        if total_qty > 0:
            active_dims_qty = [
                (p, w, h, normalized_qty.get(p, 0))
                for p, w, h, _q in page_dims_qty
                if normalized_qty.get(p, 0) > 0
            ]
            group_probe = solve_auto_fill_mixed(
                sheet_w=usable_w,
                sheet_h=usable_h,
                page_dims=[(p, w, h) for p, w, h, _q in active_dims_qty],
                gap=gap,
                allow_rotation=allow_rotation,
                exclude_zones=exclude_zones,
            )
            probe_sheets = group_probe.get('sheets') or [group_probe]
            dims_by_page = {p: (p, w, h, q) for p, w, h, q in active_dims_qty}
            raw_sheets = []
            for probe_sheet in probe_sheets:
                group_pages = {
                    int(item['page_idx'])
                    for item in (probe_sheet.get('placements') or [])
                }
                group = [
                    dims_by_page[p]
                    for p in dims_by_page
                    if p in group_pages
                ]
                if group:
                    raw_sheets.append(_ratio_fill_layout(
                        usable_w,
                        usable_h,
                        group,
                        gap,
                        allow_rotation,
                        exclude_zones=exclude_zones,
                    ))
        else:
            page_dims = [(p, w, h) for p, w, h, _ in page_dims_qty]
            res = solve_auto_fill_mixed(
                sheet_w=usable_w, sheet_h=usable_h,
                page_dims=page_dims,
                gap=gap, allow_rotation=allow_rotation,
                exclude_zones=exclude_zones,
            )
            raw_sheets = res.get('sheets') or [res]
    except Exception:
        return _empty_result()

    def _materialize_sheet(raw_result: Dict[str, Any], sheet_index: int) -> Dict[str, Any]:
        raw = raw_result.get('placements', []) or []
        if not raw:
            return _empty_result()

        # Căn giữa cụm trên vùng in cho đẹp tờ. Nhưng phép căn giữa dịch CẢ CỤM đi
        # `x_pad - min_x`, và khi `x_pad < min_x` thì nó kéo nội dung NGƯỢC về phía
        # góc — đúng nơi có boong.
        #
        # [NEST-11 FIX 2026-08-27] Trước bản sửa, comment ở đây khẳng định "dịch về tâm
        # chỉ đưa nội dung ra xa các góc boong". Đó là giả định, không phải kiểm chứng,
        # và nó sai khi vùng cấm LỆCH giữa hai mép: đo được tem bị kéo từ x=160 (packer
        # đã tránh) về x=102,5 — nằm giữa dải cấm 0..160. Docstring của hàm ngoài lại
        # ghi ngược lại rằng có vùng cấm thì "KHÔNG re-center", tức file này từng có hai
        # cách hiểu và code theo cách sai.
        #
        # Cách sửa giữ blast radius nhỏ nhất: THỬ rồi LÙI. Ca đã an toàn vẫn ra toạ độ
        # y hệt bản cũ (không đổi output đang đúng); chỉ ca thật sự va chạm mới lùi về
        # toạ độ packer thuần — vốn được bảo đảm ngoài vùng cấm vì packer đã tránh.
        min_x = min(it['x'] for it in raw)
        min_y = min(it['y'] for it in raw)
        content_w = max((it['x'] - min_x + it['w'] for it in raw), default=0.0)
        content_h = max((it['y'] - min_y + it['h'] for it in raw), default=0.0)
        x_pad = (usable_w - content_w) / 2.0 if content_w < usable_w else 0.0
        y_pad = (usable_h - content_h) / 2.0 if content_h < usable_h else 0.0

        # `x_pad = min_x` nghĩa là dịch tịnh bằng 0 → giữ nguyên toạ độ packer.
        x_pad, y_pad = _resolve_safe_padding(
            raw, exclude_zones, min_x, min_y, x_pad, y_pad,
        )

        placements: List[Dict[str, Any]] = []
        cells: List[Dict[str, Any]] = []
        placed: Dict[int, int] = {}
        for it in raw:
            x = it['x'] - min_x
            y = it['y'] - min_y
            w = it['w']
            h = it['h']
            is_rot = bool(it.get('is_rotated', False))
            pidx = int(it['page_idx'])
            placed[pidx] = placed.get(pidx, 0) + 1

            abs_x = margin_left + x_pad + x
            # original_cell_y = trim_rect.y0 mà place_one_artwork/show_pdf_page hiểu
            # theo TOP-DOWN; cùng chiều packer và cells preview, không lật dọc.
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
                'width': w,
                'height': h,
                'original_cell_y': original_cell_y,
            })
            cells.append({
                'x': x, 'y': y, 'width': w, 'height': h,
                'isRotated': is_rot, 'isRotated180': False, 'pageIdx': pidx,
            })

        local_runs = 1
        if total_qty > 0:
            for pidx, count in placed.items():
                qty = normalized_qty.get(pidx, 0)
                if qty > 0 and count > 0:
                    local_runs = max(local_runs, -(-qty // count))

        return {
            'placements': placements,
            'cells': cells,
            'items_per_sheet': len(placements),
            'placed_by_page': placed,
            'sheets_needed': local_runs,
            'overall_w': content_w,
            'overall_h': content_h,
            'physical_sheet_index': sheet_index,
        }

    sheets = []
    for index, raw_sheet in enumerate(raw_sheets):
        sheet = _materialize_sheet(raw_sheet, index)
        if sheet['placements']:
            sheets.append(sheet)

    required_pages = {
        p for p, _w, _h, _q in page_dims_qty
        if total_qty == 0 or normalized_qty.get(p, 0) > 0
    }
    covered_pages = {
        placement['src_page_idx']
        for sheet in sheets
        for placement in sheet['placements']
    }
    unplaced_pages = sorted(required_pages - covered_pages)
    if not sheets:
        empty = _empty_result()
        empty['unplaced_pages'] = unplaced_pages
        empty['sheet_count'] = 0
        return empty

    first = dict(sheets[0])
    first['sheets_needed'] = sum(sheet['sheets_needed'] for sheet in sheets)
    first['sheet_count'] = len(sheets)
    first['unplaced_pages'] = unplaced_pages
    if len(sheets) > 1:
        first['sheets'] = sheets
    return first


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

    # Metadata phải đi theo TẤT CẢ tờ mẫu, không chỉ top-level/tờ đầu.
    layouts = [res] + list(res.get('sheets') or [])
    for layout in layouts:
        for cell in layout.get('cells', []):
            _enrich(cell, cell.get('pageIdx'))
        for pl in layout.get('placements', []):
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
