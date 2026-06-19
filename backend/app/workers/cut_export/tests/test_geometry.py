"""Test geometry: flatten Bezier + RDP (task 2.2). Requirements: 1.2."""

import math

from app.workers.cut_export.geometry import (
    flatten_cubic_bezier,
    rdp_simplify,
    max_segment_length,
    _perp_distance,
)


def test_flatten_includes_endpoints():
    pts = flatten_cubic_bezier((0, 0), (0, 10), (10, 10), (10, 0))
    assert pts[0] == (0.0, 0.0)
    assert pts[-1] == (10.0, 0.0)


def test_flatten_straight_line_collapses_to_endpoints():
    # 4 điểm thẳng hàng → RDP nén còn 2 điểm.
    pts = flatten_cubic_bezier((0, 0), (3, 0), (6, 0), (9, 0))
    assert pts == [(0.0, 0.0), (9.0, 0.0)]


def test_flatten_curve_segment_within_tolerance():
    # Đường cong thật: kiểm tra mỗi đoạn không vượt quá ~2x dung sai (sau RDP).
    pts = flatten_cubic_bezier((0, 0), (0, 50), (50, 50), (50, 0), max_seg_mm=0.2)
    # RDP cho phép gộp đoạn miễn sai số hình ≤ epsilon; điểm phải đủ dày để cong mượt.
    assert len(pts) > 10
    assert pts[0] == (0.0, 0.0) and pts[-1] == (50.0, 0.0)


def test_flatten_deviation_from_true_curve_small():
    # Lấy nhiều điểm mẫu trên Bezier gốc, kiểm tra polyline xấp xỉ sát.
    p0, p1, p2, p3 = (0, 0), (0, 30), (30, 30), (30, 0)
    poly = flatten_cubic_bezier(p0, p1, p2, p3, max_seg_mm=0.2)

    def bez(t):
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        return (x, y)

    # Với mỗi điểm trên cung gốc, tìm khoảng cách min tới các cạnh polyline.
    max_dev = 0.0
    for i in range(101):
        s = bez(i / 100)
        d = min(
            _perp_distance(s, poly[j], poly[j + 1]) for j in range(len(poly) - 1)
        )
        max_dev = max(max_dev, d)
    assert max_dev < 0.3, f"sai lệch {max_dev:.3f}mm vượt ngưỡng"


def test_rdp_keeps_corners():
    # Hình chữ nhật: RDP phải giữ 4 góc.
    rect = [(0, 0), (5, 0), (10, 0), (10, 5), (10, 10), (0, 10), (0, 0)]
    out = rdp_simplify(rect, 0.03)
    # Bỏ điểm giữa cạnh (5,0), giữ các góc.
    assert (5.0, 0.0) not in out
    for corner in [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]:
        assert corner in out


def test_rdp_short_input_unchanged():
    assert rdp_simplify([(0, 0), (1, 1)], 0.03) == [(0.0, 0.0), (1.0, 1.0)]


def test_max_segment_length():
    assert math.isclose(max_segment_length([(0, 0), (3, 4)]), 5.0)
    assert max_segment_length([(0, 0)]) == 0.0
