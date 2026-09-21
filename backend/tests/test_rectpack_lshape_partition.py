"""
Test kiểm tra sửa lỗi RECTPACK21 (audit 2026-09-21):
- RECTPACK21.01: L-shape generator phân hoạch không giao nhau (Partition A / Partition B),
  đảm bảo 0 tem chồng lấn hình học (không còn 24 ô ảo hay giao nhau 1492.56 mm²).
- RECTPACK21.02: Bài toán Untitled-1.pdf (80.051275 x 64.995072 mm trên khổ 320 x 430 mm,
  lề in 3mm, boong 5mm lề 7mm) đạt trọn vẹn 23 tem (18 tem hướng gốc + 5 tem xoay 90°)
  sau khi finalize và giải va chạm boong, không bị cắt giảm xuống 21 tem.
"""
from types import SimpleNamespace
import pytest
from shapely.geometry import box

from app.workers.sticker_imposer_pkg.shape_layouts import (
    _py_solve_l_shape_layout, solve_l_shape_layout,
)
from app.workers.imposition_finalize import (
    finalize_placements, resolve_pont_collisions_on_placements,
)
from app.workers.pont_collision import (
    MM_TO_PTS, calculate_forbidden_zones, detect_collisions, _has_any_sticker_overlap,
)


def _check_no_internal_overlaps(items):
    """Kiểm tra độc lập diện tích giao nhau giữa mọi cặp ô tem."""
    n = len(items)
    for i in range(n):
        a = items[i]
        for j in range(i + 1, n):
            b = items[j]
            ox = max(0.0, min(a['x'] + a['width'], b['x'] + b['width']) - max(a['x'], b['x']))
            oy = max(0.0, min(a['y'] + a['height'], b['y'] + b['height']) - max(a['y'], b['y']))
            overlap_area = ox * oy
            assert overlap_area < 0.1, (
                f"Phát hiện tem chồng lấn giữa item {i} (block {a.get('blockId')}) "
                f"và item {j} (block {b.get('blockId')}): {ox:.3f} x {oy:.3f} = {overlap_area:.3f} mm²"
            )


def test_rectpack21_01_lshape_no_overlaps_untitled_1():
    """RECTPACK21.01: L-shape solver không được sinh ô chồng chéo, đạt 23 tem trên Untitled-1.pdf."""
    item_w, item_h = 80.051275, 64.995072
    usable_w, usable_h = 314.0, 424.0

    # 1. Kiểm tra Python solver
    py_res = _py_solve_l_shape_layout(usable_w, usable_h, item_w, item_h, 0.0, 0.0)
    assert py_res['totalItems'] == 23
    assert len(py_res['items']) == 23
    _check_no_internal_overlaps(py_res['items'])

    # Cấu trúc topology: 18 tem khối chính (3x6) + 5 tem khối phụ phải (1x5)
    block0 = [it for it in py_res['items'] if it.get('blockId') == 0]
    block1 = [it for it in py_res['items'] if it.get('blockId') == 1]
    block2 = [it for it in py_res['items'] if it.get('blockId') == 2]
    assert len(block0) == 18
    assert len(block1) == 5
    assert len(block2) == 0

    # 2. Kiểm tra Native Rust solver
    native_res = solve_l_shape_layout(usable_w, usable_h, item_w, item_h, 0.0, 0.0)
    assert native_res['totalItems'] == 23
    assert len(native_res['items']) == 23
    _check_no_internal_overlaps(native_res['items'])

    # Parity Python ↔ Rust
    assert round(py_res['widthUsed'], 4) == round(native_res['widthUsed'], 4)
    assert round(py_res['heightUsed'], 4) == round(native_res['heightUsed'], 4)


def test_rectpack21_02_end_to_end_preserves_23_items_with_ponts():
    """RECTPACK21.02: Sau khi finalize và giải va chạm boong, giữ trọn 23 tem không bị cắt còn 21."""
    item_w_mm, item_h_mm = 80.051275, 64.995072
    sheet_w_mm, sheet_h_mm = 320.0, 430.0
    margin_mm = 3.0
    usable_w_mm = sheet_w_mm - 2 * margin_mm  # 314.0
    usable_h_mm = sheet_h_mm - 2 * margin_mm  # 424.0

    # Giải bố cục L-shape
    layout = solve_l_shape_layout(usable_w_mm, usable_h_mm, item_w_mm, item_h_mm, 0.0, 0.0)
    assert layout['totalItems'] == 23

    # Chuyển toạ độ sang points cho finalize
    items_pt = [
        {
            'x': it['x'] * MM_TO_PTS,
            'y': it['y'] * MM_TO_PTS,
            'width': it['width'] * MM_TO_PTS,
            'height': it['height'] * MM_TO_PTS,
            'isRotated': it['isRotated'],
            'blockId': it['blockId'],
        }
        for it in layout['items']
    ]

    placements = finalize_placements(
        items_pt,
        usable_w_mm * MM_TO_PTS,
        usable_h_mm * MM_TO_PTS,
        margin_mm * MM_TO_PTS,
        margin_mm * MM_TO_PTS,
        margin_mm * MM_TO_PTS,
    )
    assert len(placements) == 23

    req = SimpleNamespace(
        sheet_w=sheet_w_mm * MM_TO_PTS,
        sheet_h=sheet_h_mm * MM_TO_PTS,
        margin_left=margin_mm * MM_TO_PTS,
        margin_bottom=margin_mm * MM_TO_PTS,
        pont_config={
            'shape': 'circle',
            'size': 5.0,
            'marginTop': 7.0,
            'marginBottom': 7.0,
            'marginLeft': 7.0,
            'marginRight': 7.0,
            'disableCollision': False,
        },
    )

    base_poly = box(0.0, 0.0, item_w_mm * MM_TO_PTS, item_h_mm * MM_TO_PTS)
    resolved = resolve_pont_collisions_on_placements(placements, req, base_poly=base_poly)

    # Khóa sản lượng: PHẢI đạt ít nhất 23 tem (không bị cắt giảm xuống 21)
    assert len(resolved) == 23, f"Kỳ vọng 23 tem nhưng chỉ giữ được {len(resolved)} tem"

    # Kiểm tra an toàn boong: 0 va chạm với 4 vùng cấm boong
    sheet_margins = {
        'top': margin_mm * MM_TO_PTS,
        'bottom': margin_mm * MM_TO_PTS,
        'left': margin_mm * MM_TO_PTS,
        'right': margin_mm * MM_TO_PTS,
    }
    zones = calculate_forbidden_zones(req.pont_config, sheet_margins, req.sheet_w, req.sheet_h)
    cols = detect_collisions(resolved, zones, base_poly, base_poly.bounds, req.sheet_h)
    assert cols == [], f"Tem vẫn va chạm boong tại các chỉ số: {cols}"

    # Kiểm tra không tem nào đè nhau
    assert not _has_any_sticker_overlap(resolved, base_poly)


@pytest.mark.parametrize("gap_mm", [0.0, 1.0, 2.0, 3.0])
def test_lshape_partition_no_overlaps_across_gaps(gap_mm):
    """Đảm bảo phân hoạch L-shape không bao giờ sinh tem đè nhau trên các bước hở khác nhau."""
    item_w, item_h = 80.051275, 64.995072
    usable_w, usable_h = 314.0, 424.0
    res = solve_l_shape_layout(usable_w, usable_h, item_w, item_h, gap_mm, gap_mm)
    _check_no_internal_overlaps(res['items'])
