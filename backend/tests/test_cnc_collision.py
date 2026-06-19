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
