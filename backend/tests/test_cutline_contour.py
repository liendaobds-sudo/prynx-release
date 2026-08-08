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
    _chord_length_parameters,
    _reference_corner_indices,
    build_contour_path_stream,
    _coords_to_bezier_stream,
    _coords_to_polyline_stream,
    _generate_fitted_bezier,
    _vec_dot,
    _vec_length,
    _vec_normalize,
    _vec_sub,
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


def test_fitted_bezier_handles_do_not_exceed_chord():
    """Cụm điểm raster gấp khúc không được tạo tay nắm dài gây cubic tự vòng."""
    points = [
        (0.0, 0.0),
        (1.3897, 2.5680),
        (6.0499, -7.6619),
        (10.0, 0.0),
    ]
    segment = _generate_fitted_bezier(
        points,
        _chord_length_parameters(points),
        _vec_normalize(_vec_sub(points[1], points[0])),
        _vec_normalize(_vec_sub(points[-2], points[-1])),
    )
    chord = _vec_length(_vec_sub(segment[3], segment[0]))

    assert _vec_length(_vec_sub(segment[1], segment[0])) <= chord + 1e-9
    assert _vec_length(_vec_sub(segment[2], segment[3])) <= chord + 1e-9


def test_fitted_bezier_handles_do_not_turn_back_along_chord():
    """Tay nắm quay ngược phải về chord để không tạo loop trên contour kín."""
    points = [
        (0.0, 0.0),
        (-1.7049, 3.8520),
        (6.9498, -11.4928),
        (10.0, 0.0),
    ]
    segment = _generate_fitted_bezier(
        points,
        _chord_length_parameters(points),
        _vec_normalize(_vec_sub(points[1], points[0])),
        _vec_normalize(_vec_sub(points[-2], points[-1])),
    )
    chord_vector = _vec_sub(segment[3], segment[0])
    chord = _vec_length(chord_vector)
    chord_unit = (chord_vector[0] / chord, chord_vector[1] / chord)
    projection1 = _vec_dot(_vec_sub(segment[1], segment[0]), chord_unit)
    projection2 = _vec_dot(_vec_sub(segment[2], segment[0]), chord_unit)

    assert 0.0 <= projection1 <= projection2 <= chord


def _densify_ring(vertices, steps=16):
    dense = []
    for start, end in zip(vertices, vertices[1:] + vertices[:1]):
        for step in range(steps):
            ratio = step / steps
            dense.append((
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio,
            ))
    return dense


def _densify_ring_uniform(vertices, step_length=5.0):
    dense = []
    for start, end in zip(vertices, vertices[1:] + vertices[:1]):
        steps = max(1, math.ceil(math.dist(start, end) / step_length))
        for step in range(steps):
            ratio = step / steps
            dense.append((
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio,
            ))
    return dense


def _polar_ring(count, radius_fn):
    return [
        (
            radius_fn(index, angle) * math.cos(angle),
            radius_fn(index, angle) * math.sin(angle),
        )
        for index, angle in (
            (index, 2.0 * math.pi * index / count)
            for index in range(count)
        )
    ]


@pytest.mark.parametrize("scale", [1.0, 80.0])
def test_reference_corner_detector_is_scale_invariant(scale):
    """Reference phân biệt được độ cong liên tục với góc thật ở mọi kích thước."""
    heart = []
    for index in range(720):
        parameter = 2.0 * math.pi * index / 720.0
        heart.append((
            16.0 * math.sin(parameter) ** 3 * scale,
            -(
                13.0 * math.cos(parameter)
                - 5.0 * math.cos(2.0 * parameter)
                - 2.0 * math.cos(3.0 * parameter)
                - math.cos(4.0 * parameter)
            ) * scale,
        ))
    flower_vertices = _polar_ring(
        720,
        lambda _index, angle: 720.0 + 190.0 * math.cos(12.0 * angle),
    )
    flower = [
        (x * scale, y * scale)
        for x, y in _densify_ring(flower_vertices, steps=8)
    ]
    gear_vertices = _polar_ring(
        80,
        lambda index, _angle: 880.0 if index % 4 in (0, 1) else 690.0,
    )
    gear = [
        (x * scale, y * scale)
        for x, y in _densify_ring(gear_vertices)
    ]
    hourglass = [
        (x * scale, y * scale)
        for x, y in _densify_ring_uniform([
            (300.0, 260.0),
            (1980.0, 260.0),
            (1370.0, 930.0),
            (1280.0, 1137.0),
            (1370.0, 1344.0),
            (1980.0, 2010.0),
            (300.0, 2010.0),
            (910.0, 1344.0),
            (1000.0, 1137.0),
            (910.0, 930.0),
        ])
    ]

    assert len(_reference_corner_indices(heart, heart, 38.0)) == 2
    assert _reference_corner_indices(flower, flower, 38.0) == []
    assert len(_reference_corner_indices(gear, gear, 38.0)) == 80
    assert len(_reference_corner_indices(hourglass, hourglass, 38.0)) == 6
