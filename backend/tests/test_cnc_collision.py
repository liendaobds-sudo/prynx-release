"""
Test xử lý va chạm vùng cấm boong cho CNC (die-shape-detection-ssot — parity với Tem Bế).

Kiểm `_resolve_cnc_collisions`: dời/loại tem đè vùng cấm boong góc, giữ tem an toàn,
và tôn trọng disableCollision. Dùng placements tổng hợp (không cần PDF).
"""
from app.workers.cnc_render import _resolve_cnc_collisions
from app.workers.pont_collision import calculate_forbidden_zones, detect_collisions

MM = 2.83465
SHEET_W = 320 * MM
SHEET_H = 450 * MM
PONT = {'shape': 'circle', 'size': 5.0,
        'marginTop': 7.0, 'marginBottom': 7.0, 'marginLeft': 7.0, 'marginRight': 7.0}


def _placement(src_page, x_mm, y_mm, w_mm=30.0, h_mm=10.0):
    return {
        'cluster_idx': 0,
        'cell': {'x': x_mm * MM, 'y': y_mm * MM, 'width': w_mm * MM, 'height': h_mm * MM,
                 'isRotated': False, 'isRotated180': False},
        'src_page_idx': src_page,
        'abs_x': x_mm * MM,
        'abs_y': y_mm * MM,
        'width': w_mm * MM,
        'height': h_mm * MM,
        'original_cell_y': SHEET_H - y_mm * MM - h_mm * MM,
    }


def _zones():
    return calculate_forbidden_zones(PONT, {}, SHEET_W, SHEET_H)


def test_resolves_corner_collision():
    # A: nằm sát góc trên-trái → đè vùng cấm boong. B: giữa tờ → an toàn.
    a = _placement(0, x_mm=5.0, y_mm=450 - 15.0)   # top-left corner
    b = _placement(1, x_mm=150.0, y_mm=200.0)      # center (2 src pages → base_poly=None)
    placements = [a, b]

    zones = _zones()
    # Tiền đề: A thực sự va chạm trước khi xử lý.
    assert detect_collisions(placements, zones, None,
                             (0, 0, a['width'], a['height']), SHEET_H), "A phải va chạm để test có nghĩa"

    out = _resolve_cnc_collisions(placements, PONT, SHEET_W, SHEET_H,
                                  margin_left=7 * MM, margin_bottom=7 * MM,
                                  src_doc=None, detected_shapes_by_page={})
    # Sau xử lý: KHÔNG còn va chạm nào với vùng cấm.
    assert detect_collisions(out, zones, None, (0, 0, a['width'], a['height']), SHEET_H) == []
    # Tem an toàn (B) vẫn còn.
    assert any(p['src_page_idx'] == 1 for p in out)


def test_disable_collision_returns_unchanged():
    a = _placement(0, x_mm=5.0, y_mm=450 - 15.0)
    cfg = dict(PONT); cfg['disableCollision'] = True
    out = _resolve_cnc_collisions([a], cfg, SHEET_W, SHEET_H,
                                  margin_left=7 * MM, margin_bottom=7 * MM,
                                  src_doc=None, detected_shapes_by_page={})
    assert out == [a]


def test_no_pont_config_returns_unchanged():
    a = _placement(0, x_mm=5.0, y_mm=450 - 15.0)
    out = _resolve_cnc_collisions([a], None, SHEET_W, SHEET_H,
                                  margin_left=7 * MM, margin_bottom=7 * MM,
                                  src_doc=None, detected_shapes_by_page={})
    assert out == [a]


# ─────────────────────────────────────────────────────────────────────────────
#  P1: polygon vùng cấm phải sample đường cong (không lấy điểm điều khiển bezier)
# ─────────────────────────────────────────────────────────────────────────────
def test_forbidden_poly_samples_bezier_curve():
    import math
    from app.workers.pont_collision import build_shapely_polygon_from_paths

    class _P:
        def __init__(self, x, y): self.x = x; self.y = y
    class _Rect:
        def __init__(self, w, h): self.width = w; self.height = h

    r, cx, cy = 50.0, 50.0, 50.0
    k = 0.5523 * r
    def cseg(p0, p1, c0, c1): return ('c', _P(*p0), _P(*c0), _P(*c1), _P(*p1))
    items = [
        cseg((cx + r, cy), (cx, cy + r), (cx + r, cy + k), (cx + k, cy + r)),
        cseg((cx, cy + r), (cx - r, cy), (cx - k, cy + r), (cx - r, cy + k)),
        cseg((cx - r, cy), (cx, cy - r), (cx - r, cy - k), (cx - k, cy - r)),
        cseg((cx, cy - r), (cx + r, cy), (cx + k, cy - r), (cx + r, cy - k)),
    ]
    poly = build_shapely_polygon_from_paths([{'rect': _Rect(100, 100), 'items': items}], None)
    true_area = math.pi * r * r
    # Bản cũ (append điểm điều khiển) sai ~+15%; bản fix phải < 2%.
    assert abs(poly.area - true_area) / true_area < 0.02, (
        f"polygon vùng cấm sai đường cong: area={poly.area:.0f} vs thật={true_area:.0f}"
    )


# ─────────────────────────────────────────────────────────────────────────────
#  P4: get_item_polygon đặt polygon đúng ô khai báo (nhất quán vị trí với render)
#      cho mọi tổ hợp cờ xoay — kể cả hình bất đối xứng.
# ─────────────────────────────────────────────────────────────────────────────
def test_item_polygon_lands_in_declared_cell():
    from shapely.geometry import Polygon
    from app.workers.pont_collision import get_item_polygon

    # Tam giác vuông bất đối xứng, bbox (0,0)-(40,20), toạ độ top-down (như PDF paths).
    base = Polygon([(0, 0), (40, 0), (0, 20), (0, 0)])
    for is90, is180, ew, eh in [(False, False, 40, 20), (True, False, 20, 40),
                                (False, True, 40, 20), (True, True, 20, 40)]:
        item = {'abs_x': 100.0, 'abs_y': 200.0, 'width': ew, 'height': eh,
                'cell': {'isRotated': is90, 'isRotated180': is180}}
        poly = get_item_polygon(item, base)
        minx, miny, maxx, maxy = poly.bounds
        # Polygon phải nằm gọn trong ô [abs_x, abs_y, abs_x+w, abs_y+h] (sai số 0.5pt).
        assert abs(minx - 100.0) < 0.5 and abs(miny - 200.0) < 0.5, f"min lệch ({is90},{is180}): {poly.bounds}"
        assert abs(maxx - (100.0 + ew)) < 0.5 and abs(maxy - (200.0 + eh)) < 0.5, (
            f"max lệch ({is90},{is180}): {poly.bounds} vs ô ({ew}x{eh})"
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Option A: với layout SO LE/LỒNG, smart_resolve thử XOAY 180° để xóa ÍT tem hơn
#  (khôi phục logic gốc: đưa hàng/cột ít tem ra mép vùng cấm).
# ─────────────────────────────────────────────────────────────────────────────
def test_interlock_flip_keeps_more_than_single_orientation():
    from shapely.geometry import Polygon
    from app.workers.sticker_imposer_pkg.shape_layouts import _py_solve_advanced_pentagon_layout as penta
    from app.workers.pont_collision import (
        calculate_forbidden_zones, detect_collisions,
        smart_resolve_collisions, _resolve_one_orientation,
    )
    W, H = 60.0, 80.0
    base = Polygon([(0, 0), (W, 0), (W, 60), (W / 2, H), (0, 60), (0, 0)])
    sp = {'peakHeightRatio': 0.25, 'pentagonOrientation': 'up'}
    gap = 6.0
    sheet_w, sheet_h = 300.0, 440.0
    m = 20.0
    usable_w, usable_h = sheet_w - 2 * m, sheet_h - 2 * m
    pont = {'shape': 'circle', 'size': 5.0, 'marginTop': 7.0, 'marginBottom': 7.0,
            'marginLeft': 7.0, 'marginRight': 7.0}
    margins = {'top': 7 * MM, 'bottom': 7 * MM, 'left': 7 * MM, 'right': 7 * MM}
    zones = calculate_forbidden_zones(pont, margins, sheet_w, sheet_h)

    res = penta(usable_w, usable_h, W, H, gap, gap, sp, False, False)
    placements = [{
        'abs_x': it['x'] + m, 'abs_y': it['y'] + m, 'width': it['width'], 'height': it['height'],
        'cell': {'isRotated': it.get('isRotated', False), 'isRotated180': it.get('isRotated180', False)},
        'original_cell_y': sheet_h - (it['y'] + m) - it['height'], 'cluster_idx': 0, 'src_page_idx': 0,
    } for it in res['items']]

    old = _resolve_one_orientation(placements, zones, base, (0, 0, W, H), sheet_w, sheet_h, margins)
    new = smart_resolve_collisions(placements, zones, base, (0, 0, W, H), sheet_w, sheet_h, margins)

    # Option A phải giữ >= hướng đơn, và kết quả không còn va chạm.
    assert len(new) >= len(old), f"flip giữ ít hơn: new={len(new)} old={len(old)}"
    assert len(new) > len(old), "ca này flip phải cứu thêm tem (chứng minh logic chạy)"
    assert detect_collisions(new, zones, base, (0, 0, W, H), sheet_h) == [], "vẫn còn va chạm sau xử lý"
