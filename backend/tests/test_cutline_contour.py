"""
Unit tests cho logic vẽ đường cắt (CutContour) của tính năng Tạo viền bế.

Kiểm chứng phần dễ sai nhất — hình học đường cắt theo kiểu góc:
  - Góc tròn (round)  → đường cong bezier ('c'), không có đoạn thẳng.
  - Góc vuông/vát     → đoạn thẳng ('l'), giữ đúng đỉnh, KHÔNG bo cong.
  - Lật trục y (top-left → toạ độ PDF y-lên) đúng.
  - Contour < 3 điểm  → không sinh lệnh (no-op).

Test thuần hàm, không cần render PDF nên chạy nhanh & ổn định.
"""
import math
import pytest

from app.workers.cutline_geometry import (
    build_contour_path_stream,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
)

PAGE_H = 200.0
# Hình vuông kín (gốc top-left, y xuống)
SQUARE = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0), (0.0, 0.0)]


def _ops(stream):
    """Lấy ký tự lệnh cuối mỗi dòng (m / l / c / h)."""
    return [line.split()[-1] for line in stream]


def test_round_uses_bezier_only():
    stream = build_contour_path_stream(SQUARE, PAGE_H, corner_style="round")
    ops = _ops(stream)
    assert ops[0] == 'm'
    assert ops[-1] == 'h'
    assert 'c' in ops, "Góc tròn phải dùng bezier"
    assert 'l' not in ops, "Góc tròn không được dùng đoạn thẳng"


@pytest.mark.parametrize("style", ["preserve", "square", "bevel", "mitre"])
def test_non_round_uses_straight_lines(style):
    stream = build_contour_path_stream(SQUARE, PAGE_H, corner_style=style)
    ops = _ops(stream)
    assert ops[0] == 'm'
    assert ops[-1] == 'h'
    assert 'l' in ops, "Góc vuông/vát phải dùng đoạn thẳng"
    assert 'c' not in ops, "Góc vuông/vát KHÔNG được bo cong (bezier)"


def test_square_preserves_corner_vertices():
    """Đường cắt góc vuông phải đi qua đúng 4 đỉnh, không bị dịch/bo."""
    stream = _coords_to_polyline_stream(SQUARE, PAGE_H)
    # 1 'm' + 3 'l' + 'h'
    assert len(stream) == 5
    # Thu các điểm (x, y_pdf) từ lệnh m/l
    pts = []
    for line in stream:
        toks = line.split()
        if toks[-1] in ('m', 'l'):
            pts.append((float(toks[0]), float(toks[1])))
    expected = {(0.0, 200.0), (100.0, 200.0), (100.0, 100.0), (0.0, 100.0)}
    assert set(pts) == expected


def test_y_axis_is_flipped():
    """Điểm y=0 (đỉnh trên top-left) phải thành y=page_h trong toạ độ PDF."""
    stream = _coords_to_polyline_stream(SQUARE, PAGE_H)
    first = stream[0].split()
    assert math.isclose(float(first[1]), PAGE_H)  # y=0 → 200


def test_too_few_points_is_noop():
    assert build_contour_path_stream([(0, 0), (1, 1)], PAGE_H, "round") == []
    assert build_contour_path_stream([(0, 0), (1, 1)], PAGE_H, "square") == []


def test_bezier_segment_count_matches_vertices():
    """Bezier kín: số lệnh 'c' = số đỉnh (mỗi cạnh 1 cung)."""
    stream = _coords_to_bezier_stream(SQUARE, PAGE_H)
    ops = _ops(stream)
    assert ops.count('c') == 4  # 4 đỉnh (đã bỏ điểm trùng cuối)
