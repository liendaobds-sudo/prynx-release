"""Chốt độc lập cho làm mượt: sai số liên tục, góc, topology và độ cong."""

from __future__ import annotations

from copy import deepcopy
import math

import numpy as np
import pytest
from shapely import LineString, Polygon

from app.workers.cutline_fair_verify import (
    FairCurveMetrics,
    _curve_curvature,
    _distance_bound,
    _motion_improves,
    _protected_order_matches,
    fair_paths_are_simple,
    verify_fair_ring,
)
from app.workers.cutline_geometry import _bezier_point, _linear_cubic_segment
from app.workers.cutline_polyline_reduction import split_cubic


def _circle(radius=1.0):
    k = 0.5522847498307936 * radius
    r = radius
    return [((r, 0.0), (r, k), (k, r), (0.0, r)),
            ((0.0, r), (-k, r), (-r, k), (-r, 0.0)),
            ((-r, 0.0), (-r, -k), (-k, -r), (0.0, -r)),
            ((0.0, -r), (k, -r), (r, -k), (r, 0.0))]


def _rectangle(x0=0.0, y0=0.0, x1=1.0, y1=1.0):
    vertices = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [_linear_cubic_segment(a, b) for a, b in zip(vertices, vertices[1:] + vertices[:1])]


def _translate(ring, dx, dy=0.0):
    return [tuple((x + dx, y + dy) for x, y in curve) for curve in ring]


def _sample(ring, count=2048):
    points = [_bezier_point(curve, i / count) for curve in ring for i in range(count)]
    return LineString([*points, points[0]])


@pytest.mark.parametrize("budget", [0.0, -0.01, 0.100001, math.nan, math.inf, None])
def test_invalid_manufacturing_budget_is_rejected(budget):
    with pytest.raises(ValueError):
        verify_fair_ring(_circle(), _circle(), tolerance_mm=budget)


def test_exact_coarsening_accepts_without_mutating_source():
    candidate = _circle(3.0)
    source = [part for curve in candidate for part in split_cubic(curve, 0.37)]
    saved = deepcopy(source)
    result = verify_fair_ring(source, candidate, tolerance_mm=0.05)
    assert result.accepted and result.reason == "accepted"
    assert source == saved
    assert result.sampled_maximum_error_mm < 0.00005
    assert result.sampled_maximum_error_mm <= result.maximum_error_bound_mm <= 0.05
    assert result.candidate_metrics.total_curvature_variation_per_mm <= (
        result.source_metrics.total_curvature_variation_per_mm + 1e-6)


@pytest.mark.parametrize("invalid", [[], [((math.nan, 0.0),) * 4],
                                     [((0.0, 0.0), (1.0, 1.0), (2.0, 2.0))]])
def test_invalid_finite_or_shape_contract_fails_closed(invalid):
    assert not verify_fair_ring(_circle(), invalid, tolerance_mm=0.1).accepted


def test_open_ring_is_not_silently_snapped_to_closed():
    source = _circle()
    candidate = deepcopy(source)
    candidate[-1] = (*candidate[-1][:3], (1.0, 1e-12))
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1)
    assert not result.accepted and result.reason == "invalid_or_open_ring"


def test_protected_corner_cannot_move_even_within_distance_budget():
    source = _rectangle()
    candidate = _translate(source, 0.001)
    assert verify_fair_ring(source, candidate, tolerance_mm=0.1).accepted
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                              protected_vertices=[source[0][0]])
    assert not result.accepted and result.reason == "protected_vertex_moved"


def test_exact_protected_corners_survive_redundant_straight_subdivision():
    candidate = _rectangle()
    source = [part for curve in candidate for part in split_cubic(curve, 0.5)]
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                              protected_vertices=[curve[0] for curve in candidate])
    assert result.accepted
    assert result.source_metrics.total_curvature_jump_per_mm == 0.0
    assert result.candidate_metrics.total_curvature_variation_per_mm == 0.0


def test_protected_vertex_cannot_lose_its_corner_by_changing_tangent():
    candidate = _circle(0.2)
    source = deepcopy(candidate)
    start, control, control2, end = source[0]
    dx, dy = control[0] - start[0], control[1] - start[1]
    angle = math.radians(60)
    source[0] = (start, (start[0] + math.cos(angle) * dx - math.sin(angle) * dy,
                         start[1] + math.sin(angle) * dx + math.cos(angle) * dy), control2, end)
    assert verify_fair_ring(source, candidate, tolerance_mm=0.1).accepted
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                              protected_vertices=[start])
    assert not result.accepted and result.reason == "protected_tangent_changed"


def test_protected_vertex_order_allows_cyclic_seam_shift_but_not_permutation():
    source = tuple(_circle())
    protected = frozenset(curve[0] for curve in source)
    rotated = source[2:] + source[:2]
    assert _protected_order_matches(source, rotated, protected)
    assert verify_fair_ring(source, rotated, tolerance_mm=0.1,
                             protected_vertices=protected).accepted
    permuted = (source[0], source[2], source[1], source[3])
    assert not _protected_order_matches(source, permuted, protected)


def test_writer_tangent_slack_is_derived_from_coordinate_error_not_a_fixed_angle():
    source = np.asarray(_rectangle())
    theta = 0.31
    rotation = np.asarray([[math.cos(theta), -math.sin(theta)],
                           [math.sin(theta), math.cos(theta)]])
    source = source @ rotation.T
    candidate = deepcopy(source)
    # Cùng hình học/tangent nhưng đổi tốc độ tham số trên cạnh thẳng.
    candidate[:, 1] = candidate[:, 0] * 0.8 + candidate[:, 3] * 0.2
    candidate[:, 2] = candidate[:, 0] * 0.2 + candidate[:, 3] * 0.8
    source = np.round(source * 72 / 25.4, 4) * 25.4 / 72
    candidate = np.round(candidate * 72 / 25.4, 4) * 25.4 / 72
    protected = source[:, 0]
    strict = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                              protected_vertices=protected, require_motion_improvement=False)
    rounded = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                               protected_vertices=protected, require_motion_improvement=False,
                               coordinate_error_mm=math.sqrt(2.0) * 0.5e-4 * 25.4 / 72)
    assert not strict.accepted and strict.reason == "protected_tangent_changed"
    assert rounded.accepted


@pytest.mark.parametrize("error", [-1.0, 0.11, math.nan, math.inf, None])
def test_invalid_writer_error_is_rejected(error):
    with pytest.raises(ValueError):
        verify_fair_ring(_circle(), _circle(), tolerance_mm=0.1, coordinate_error_mm=error)


def test_reversed_winding_cannot_pass_identical_shape_distance():
    source = _circle()
    reversed_ring = [tuple(reversed(curve)) for curve in reversed(source)]
    result = verify_fair_ring(source, reversed_ring, tolerance_mm=0.1)
    assert not result.accepted and result.reason == "winding_changed"


def test_continuous_bound_catches_bulge_missing_at_anchors_and_midpoint():
    source = _rectangle()
    candidate = deepcopy(source)
    candidate[0] = ((0.0, 0.0), (1 / 3, -0.09), (2 / 3, 0.09), (1.0, 0.0))
    assert _bezier_point(candidate[0], 0.5)[1] == 0.0
    result = verify_fair_ring(source, candidate, tolerance_mm=0.02,
                              require_motion_improvement=False)
    assert not result.accepted and result.reason == "distance_exceeded"
    dense_error = _sample(source).hausdorff_distance(_sample(candidate))
    assert dense_error > 0.025
    assert result.maximum_error_bound_mm >= dense_error


def test_small_loop_inside_budget_fails_continuous_topology_not_only_distance():
    source = _rectangle(-0.05, 0.0, 0.05, 0.5)
    candidate = deepcopy(source)
    candidate[0] = ((-0.05, 0.0), (0.2, 0.1), (-0.2, 0.1), (0.05, 0.0))
    # Các control/end finite và đường vẫn rất gần; chỉ distance không đủ.
    assert _distance_bound(source, candidate, 0.1)[1] < 0.1
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1,
                              require_motion_improvement=False)
    assert not result.accepted and result.reason == "candidate_topology_uncertified"


def test_nonadjacent_touch_and_crossing_are_rejected():
    bowtie = [(0.0, 0.0), (2.0, 2.0), (0.0, 2.0), (2.0, 0.0)]
    ring = [_linear_cubic_segment(a, b) for a, b in zip(bowtie, bowtie[1:] + bowtie[:1])]
    assert not fair_paths_are_simple([ring])
    assert not fair_paths_are_simple([_rectangle(), _rectangle(1.0, 0.2, 2.0, 0.8)])


def test_collapsed_cubic_fails_without_expanding_a_binary_subdivision_tree():
    assert not fair_paths_are_simple([[((0.0, 0.0),) * 4]])


def test_single_ring_acceptance_does_not_replace_neighbour_gap_check():
    source = _rectangle()
    neighbour = _rectangle(1.02, 0.0, 2.02, 1.0)
    candidate = _translate(source, 0.04)
    assert verify_fair_ring(source, candidate, tolerance_mm=0.1).accepted
    assert fair_paths_are_simple([source, neighbour])
    assert not fair_paths_are_simple([candidate, neighbour])


def test_hole_parent_relationship_is_still_checked_by_group_caller():
    outer = _rectangle()
    hole = _rectangle(0.97, 0.4, 0.99, 0.42)
    moved_hole = _translate(hole, 0.06)
    assert verify_fair_ring(hole, moved_hole, tolerance_mm=0.1).accepted
    assert fair_paths_are_simple([outer, moved_hole])
    # Không có giao cắt không có nghĩa lỗ còn nằm trong đúng exterior.
    assert not Polygon([curve[0] for curve in outer],
                       [[curve[0] for curve in moved_hole]]).is_valid


def test_writer_quantization_that_closes_a_tiny_gap_must_be_rechecked():
    outer = _rectangle()
    hole = _rectangle(0.00001, 0.3, 0.2, 0.4)
    assert fair_paths_are_simple([outer, hole])
    rounded = np.round(np.asarray(hole) * 72 / 25.4, 4) * 25.4 / 72
    assert not fair_paths_are_simple([outer, rounded])


def test_nearby_g1_curve_with_larger_curvature_jump_is_not_called_smoother():
    source = _circle()
    candidate = deepcopy(source)
    start, control, control2, end = candidate[0]
    candidate[0] = (start, (control[0], control[1] * 0.95), control2, end)
    assert verify_fair_ring(source, candidate, tolerance_mm=0.1,
                             require_motion_improvement=False).accepted
    result = verify_fair_ring(source, candidate, tolerance_mm=0.1)
    assert not result.accepted and result.reason == "motion_not_improved"
    assert result.candidate_metrics.maximum_curvature_jump_per_mm > (
        result.source_metrics.maximum_curvature_jump_per_mm)


def test_analytic_curvature_extrema_detect_narrow_spike_between_samples():
    a, epsilon = 0.123456789, 0.0001
    initial_y = a * a / 2
    curve = ((0.0, initial_y), (epsilon / 3, initial_y - a / 3),
             (2 * epsilon / 3, initial_y - 2 * a / 3 + 1 / 6),
             (epsilon, initial_y - a + 0.5))
    metrics = _curve_curvature(curve)
    assert metrics is not None
    assert metrics[2] == pytest.approx(1 / epsilon ** 2, rel=1e-6)
    coarse_max = max(epsilon / (epsilon ** 2 + (t - a) ** 2) ** 1.5
                     for t in np.linspace(0, 1, 257))
    assert metrics[2] > coarse_max * 100


def test_lower_total_roughness_does_not_permit_a_sharper_peak_curvature():
    before = FairCurveMetrics(20.0, 15.0, 50.0, 100.0, 5.0, 0.0)
    after = FairCurveMetrics(1.0, 0.5, 2.0, 10.0, 6.0, 0.0)
    assert not _motion_improves(before, after)


def test_analytic_curvature_metrics_cover_dense_random_curve_observations():
    rng = np.random.default_rng(7214)
    t = np.linspace(0, 1, 4097)[:, None]
    for _ in range(20):
        curve = rng.normal(size=(4, 2))
        metrics = _curve_curvature(curve)
        assert metrics is not None
        velocity = 3 * ((1 - t) ** 2 * (curve[1] - curve[0])
                        + 2 * (1 - t) * t * (curve[2] - curve[1])
                        + t ** 2 * (curve[3] - curve[2]))
        acceleration = 6 * ((1 - t) * (curve[2] - 2 * curve[1] + curve[0])
                            + t * (curve[3] - 2 * curve[2] + curve[1]))
        curvature = ((velocity[:, 0] * acceleration[:, 1] - velocity[:, 1] * acceleration[:, 0])
                     / np.linalg.norm(velocity, axis=1) ** 3)
        assert metrics[2] >= float(np.max(np.abs(curvature))) - 1e-6
        assert metrics[3] >= float(np.sum(np.abs(np.diff(curvature)))) - 1e-6
