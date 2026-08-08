"""Regression cho số đo chuyển động của đường bế freeform."""

from __future__ import annotations

import math

import pytest

from app.workers.cutline_machine_path import (
    MachinePathSegment,
    analyze_machine_path,
    cubic_segments_from_tuples,
    line_segments_from_closed_ring,
)
from app.workers.cutline_geometry import build_bezier_segments_path_stream


def _circle_segments(radius: float):
    kappa = 0.5522847498307936
    handle = radius * kappa
    return [
        MachinePathSegment.cubic(
            (radius, 0.0),
            (radius, handle),
            (handle, radius),
            (0.0, radius),
        ),
        MachinePathSegment.cubic(
            (0.0, radius),
            (-handle, radius),
            (-radius, handle),
            (-radius, 0.0),
        ),
        MachinePathSegment.cubic(
            (-radius, 0.0),
            (-radius, -handle),
            (-handle, -radius),
            (0.0, -radius),
        ),
        MachinePathSegment.cubic(
            (0.0, -radius),
            (handle, -radius),
            (radius, -handle),
            (radius, 0.0),
        ),
    ]


def _analyze(segments, *, mm_to_units=1.0, closed=True):
    return analyze_machine_path(
        segments,
        mm_to_units=mm_to_units,
        smooth_join_threshold_degrees=1.0,
        short_segment_threshold_mm=0.25,
        closed=closed,
    )


def test_circle_nhieu_cubic_nhung_noi_tron_khong_bi_coi_la_nguy_hiem():
    """§MOTION.1: nhiều lệnh cubic không đồng nghĩa đường chạy bị gãy."""
    metrics = _analyze(_circle_segments(10.0))

    assert metrics.segment_count == 4
    assert metrics.line_segment_count == 0
    assert metrics.cubic_segment_count == 4
    assert metrics.discontinuous_join_count == 0
    assert metrics.disconnected_join_count == 0
    assert metrics.maximum_join_angle_degrees == pytest.approx(0.0, abs=1e-9)
    assert metrics.maximum_curvature_jump_per_mm == pytest.approx(0.0, abs=1e-9)
    assert metrics.curvature_sign_flip_count == 0
    assert metrics.short_segment_count == 0
    assert metrics.total_length_mm == pytest.approx(2.0 * math.pi * 10.0, rel=2e-4)


def test_join_cubic_gay_duoc_phat_hien_du_tong_node_thap():
    """§MOTION.2: một control handle sai hướng phải lộ ra ở oracle tangent."""
    segments = _circle_segments(10.0)
    second = segments[1]
    segments[1] = MachinePathSegment.cubic(
        second.p0,
        (4.0, 12.0),
        second.p2,
        second.p3,
    )

    metrics = _analyze(segments)

    assert metrics.segment_count == 4
    assert metrics.discontinuous_join_count >= 1
    assert metrics.maximum_join_angle_degrees is not None
    assert metrics.maximum_join_angle_degrees > 5.0


def test_cum_line_cuc_ngan_duoc_do_khong_can_hard_cap_node():
    """§MOTION.3: ít node vẫn fail nếu có lệnh 0,036 mm chen giữa cạnh dài."""
    segments = line_segments_from_closed_ring(
        [
            (0.0, 0.0),
            (20.0, 0.0),
            (20.0, 10.0),
            (19.964, 10.0),
            (0.0, 10.0),
        ]
    )

    metrics = _analyze(segments)

    assert metrics.segment_count == 5
    assert metrics.line_segment_count == 5
    assert metrics.minimum_segment_length_mm == pytest.approx(0.036)
    assert metrics.short_segment_count == 1
    assert metrics.short_segment_ratio == pytest.approx(0.2)
    assert metrics.discontinuous_join_count >= 4


def test_metric_mm_bat_bien_khi_toa_do_doi_tu_mm_sang_pdf_point():
    """Đổi đơn vị không được làm thay đổi kết luận về đường chạy máy."""
    pt_per_mm = 72.0 / 25.4
    in_mm = _circle_segments(10.0)
    in_points = [
        MachinePathSegment.cubic(
            tuple(value * pt_per_mm for value in segment.p0),
            tuple(value * pt_per_mm for value in segment.p1),
            tuple(value * pt_per_mm for value in segment.p2),
            tuple(value * pt_per_mm for value in segment.p3),
        )
        for segment in in_mm
    ]

    mm_metrics = _analyze(in_mm)
    point_metrics = _analyze(in_points, mm_to_units=pt_per_mm)

    assert point_metrics.total_length_mm == pytest.approx(mm_metrics.total_length_mm)
    assert point_metrics.minimum_segment_length_mm == pytest.approx(
        mm_metrics.minimum_segment_length_mm
    )
    assert point_metrics.maximum_join_angle_degrees == pytest.approx(
        mm_metrics.maximum_join_angle_degrees,
        abs=1e-9,
    )
    assert point_metrics.maximum_curvature_jump_per_mm == pytest.approx(
        mm_metrics.maximum_curvature_jump_per_mm,
        abs=1e-9,
    )


def test_path_ho_phat_hien_endpoint_khong_noi_nhau():
    segments = [
        MachinePathSegment.line((0.0, 0.0), (10.0, 0.0)),
        MachinePathSegment.line((10.2, 0.0), (20.0, 0.0)),
    ]

    metrics = _analyze(segments, closed=False)

    assert metrics.join_count == 1
    assert metrics.disconnected_join_count == 1
    assert metrics.maximum_endpoint_gap_mm == pytest.approx(0.2)


def test_doan_suy_bien_duoc_dem_nhung_khong_lam_crash():
    segments = [
        MachinePathSegment.line((0.0, 0.0), (0.0, 0.0)),
        MachinePathSegment.line((0.0, 0.0), (10.0, 0.0)),
    ]

    metrics = _analyze(segments, closed=False)

    assert metrics.degenerate_segment_count == 1
    assert metrics.minimum_segment_length_mm == 0.0


def test_cubic_doi_dau_do_cong_duoc_dem_tren_path_mo():
    segments = [
        # y=x² rồi y=1+2t-t²: cùng tiếp tuyến (1, 2) tại điểm nối nhưng
        # curvature đổi từ dương sang âm đúng một lần.
        MachinePathSegment.cubic(
            (0.0, 0.0),
            (1.0 / 3.0, 0.0),
            (2.0 / 3.0, 1.0 / 3.0),
            (1.0, 1.0),
        ),
        MachinePathSegment.cubic(
            (1.0, 1.0),
            (4.0 / 3.0, 5.0 / 3.0),
            (5.0 / 3.0, 2.0),
            (2.0, 2.0),
        ),
    ]

    metrics = _analyze(segments, closed=False)

    assert metrics.curvature_sign_flip_count == 1
    assert metrics.curvature_sign_flips_per_100mm > 0.0


def test_nguong_do_cong_bo_nhieu_luong_tu_nhung_khong_che_mat_path_s():
    """§MOTION.1: lượng tử PDF gần thẳng không được tính thành răng cưa."""
    epsilon = 1.0e-4
    nearly_straight = [
        MachinePathSegment.cubic(
            (0.0, 0.0),
            (1.0, epsilon),
            (2.0, -epsilon),
            (3.0, 0.0),
        ),
        MachinePathSegment.cubic(
            (3.0, 0.0),
            (4.0, -epsilon),
            (5.0, epsilon),
            (6.0, 0.0),
        ),
    ]
    raw = _analyze(nearly_straight, closed=False)
    filtered = analyze_machine_path(
        nearly_straight,
        mm_to_units=1.0,
        smooth_join_threshold_degrees=1.0,
        short_segment_threshold_mm=0.25,
        closed=False,
        curvature_noise_floor_per_mm=0.005,
    )

    assert raw.curvature_sign_flip_count > 0
    assert filtered.curvature_sign_flip_count == 0


def test_helper_nhan_dung_tuple_cubic_cua_fitter_hien_tai():
    source = [
        ((0.0, 0.0), (1.0, 0.0), (2.0, 1.0), (3.0, 1.0)),
    ]

    converted = cubic_segments_from_tuples(source)

    assert converted == [
        MachinePathSegment.cubic((0.0, 0.0), (1.0, 0.0), (2.0, 1.0), (3.0, 1.0))
    ]


def test_so_lenh_cubic_do_duoc_khop_writer_pdf_hien_tai():
    """Metric và content stream phải đếm cùng một tập lệnh máy bế."""
    segments = _circle_segments(10.0)
    tuples = [(segment.p0, segment.p1, segment.p2, segment.p3) for segment in segments]

    stream = build_bezier_segments_path_stream(tuples, page_h=100.0)
    metrics = _analyze(cubic_segments_from_tuples(tuples))

    assert sum(line.endswith(" c") for line in stream) == metrics.cubic_segment_count == 4
    assert not any(line.endswith(" l") for line in stream)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"mm_to_units": 0.0}, "mm_to_units"),
        ({"smooth_join_threshold_degrees": -1.0}, "smooth_join_threshold_degrees"),
        ({"short_segment_threshold_mm": -0.1}, "short_segment_threshold_mm"),
        ({"curvature_noise_floor_per_mm": -0.1}, "curvature_noise_floor_per_mm"),
    ],
)
def test_nguong_profile_khong_hop_le_fail_fast(kwargs, message):
    options = {
        "mm_to_units": 1.0,
        "smooth_join_threshold_degrees": 1.0,
        "short_segment_threshold_mm": 0.25,
    }
    options.update(kwargs)

    with pytest.raises(ValueError, match=message):
        analyze_machine_path([], **options)
