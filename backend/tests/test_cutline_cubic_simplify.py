"""Regression rút gọn cubic: giữ nguồn, góc, topology và sai số liên tục."""

from __future__ import annotations

from copy import deepcopy
import math

import numpy as np
import pytest
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.strtree import STRtree

from app.workers.cutline_cubic_simplify import (
    _certify_cubic_span,
    simplify_cubic_path_groups,
)
from app.workers.cutline_geometry import _bezier_point, _linear_cubic_segment
from app.workers.cutline_machine_path import analyze_machine_path, cubic_segments_from_tuples
from app.workers.cutline_polyline_reduction import split_cubic


UNITS = 72.0 / 25.4


def _circle(radius=10.0, center=(20.0, 20.0)):
    k = 0.5522847498307936 * radius
    r = radius
    curves = [((r, 0), (r, k), (k, r), (0, r)),
              ((0, r), (-k, r), (-r, k), (-r, 0)),
              ((-r, 0), (-r, -k), (-k, -r), (0, -r)),
              ((0, -r), (k, -r), (r, -k), (r, 0))]
    return [tuple(((x + center[0]) * UNITS, (y + center[1]) * UNITS) for x, y in curve)
            for curve in curves]


def _split_ring(ring, levels=2):
    for _ in range(levels):
        ring = [piece for curve in ring for piece in split_cubic(curve, 0.5)]
    return ring


def _metric(ring):
    return analyze_machine_path(
        cubic_segments_from_tuples(ring), mm_to_units=UNITS,
        smooth_join_threshold_degrees=1.0, short_segment_threshold_mm=0.25,
        samples_per_cubic=128, curvature_samples_per_cubic=31,
    )


def _sample(ring, *, offset_x=0.0, offset_y=0.0, height=None):
    result = []
    for curve in ring:
        if height is not None:
            curve = tuple((float(f"{point[0] + offset_x:.4f}") - offset_x,
                           height - float(f"{height - (point[1] + offset_y):.4f}") - offset_y)
                          for point in curve)
        result.extend(_bezier_point(curve, i / 256) for i in range(256))
    result.append(result[0])
    return np.asarray(result)


def _dense_distance(first, second):
    """Oracle độc lập: khoảng cách đến segment qua STRtree, không O(n²) GEOS."""
    def directed(source, target):
        tree = STRtree(shapely.linestrings(np.stack((target[:-1], target[1:]), axis=1)))
        points = np.asarray(LineString(source).segmentize(0.005 * UNITS).coords)
        return float(tree.query_nearest(shapely.points(points), return_distance=True,
                                       all_matches=False)[1].max())
    return max(directed(first, second), directed(second, first)) / UNITS


def test_zero_returns_original_object_and_does_not_touch_input():
    groups = [{"exterior": _split_ring(_circle()), "interiors": [], "marker": "nguồn"}]
    saved = deepcopy(groups)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0)
    assert result is groups
    assert groups == saved
    assert stats == {"before_segments": 16, "after_segments": 16,
                     "maximum_error_bound_mm": 0.0, "changed": False}


@pytest.mark.parametrize("prefer_conservative,expected", [
    (True, [(True, False), (True, True), (False, False)]),
    (False, [(True, True), (True, False), (False, False)]),
])
def test_unchanged_route_does_not_repeat_conservative_global(monkeypatch, prefer_conservative, expected):
    import app.workers.cutline_cubic_simplify as module

    source = [{"exterior": _circle()}]
    saved = deepcopy(source)
    calls = []
    unchanged = {"before_segments": 4, "after_segments": 4,
                 "maximum_error_bound_mm": 0.0, "changed": False}

    def traced(groups, *, global_refit=True, fair_refit=False, **options):
        assert groups is source and options["tolerance_mm"] == .1
        calls.append((global_refit, fair_refit))
        return groups, unchanged.copy()

    monkeypatch.setattr(module, "_simplify_cubic_path_groups_impl", traced)
    result, stats = module.simplify_cubic_path_groups(
        source, tolerance_mm=.1, prefer_conservative=prefer_conservative)
    assert calls == expected
    assert result is source and source == saved and stats == unchanged


def test_preferred_conservative_noop_still_tries_fair_and_local_success(monkeypatch):
    import app.workers.cutline_cubic_simplify as module

    source = [{"exterior": _split_ring(_circle())}]
    reduced = [{"exterior": _circle()}]
    calls = []

    def traced(groups, *, global_refit=True, fair_refit=False, **options):
        calls.append((global_refit, fair_refit))
        changed = not global_refit
        return (reduced if changed else groups), {"before_segments": 16,
            "after_segments": 4 if changed else 16, "maximum_error_bound_mm": 0.0,
            "changed": changed}

    monkeypatch.setattr(module, "_simplify_cubic_path_groups_impl", traced)
    result, stats = module.simplify_cubic_path_groups(source, tolerance_mm=.1, prefer_conservative=True)
    assert calls == [(True, False), (True, True), (False, False)]
    assert result is reduced and stats["changed"]


def test_preview_fast_uses_fair_first_for_high_tolerance(monkeypatch):
    import app.workers.cutline_cubic_simplify as module

    source = [{"exterior": _circle()}]
    calls = []

    def traced(groups, *, global_refit=True, fair_refit=False, **options):
        calls.append((global_refit, fair_refit, options.get("fair_max_irls_rounds")))
        changed = fair_refit
        stats = {"before_segments": 4, "after_segments": 3 if changed else 4,
                 "maximum_error_bound_mm": .09 if changed else 0.0,
                 "changed": changed}
        return (source, stats)

    monkeypatch.setattr(module, "_simplify_cubic_path_groups_impl", traced)
    _result, stats = module.simplify_cubic_path_groups(
        source, tolerance_mm=.1, preview_fast=True,
    )
    assert stats["changed"]
    assert calls == [(True, True, 3)]


@pytest.mark.parametrize("tolerance", [-0.01, 0.100001, math.nan, math.inf, None])
def test_invalid_tolerance_is_rejected(tolerance):
    with pytest.raises(ValueError):
        simplify_cubic_path_groups([], tolerance_mm=tolerance)


@pytest.mark.parametrize("kwargs", [{"mm_to_units": 0}, {"mm_to_units": math.nan},
                                   {"page_height": math.inf}, {"offset_x_points": math.nan},
                                   {"offset_y_points": math.inf}])
def test_invalid_units_or_writer_frame_is_rejected(kwargs):
    with pytest.raises(ValueError):
        simplify_cubic_path_groups([], tolerance_mm=0.02, **kwargs)


def test_exact_subdivision_certificate_recovers_original_cubic():
    curve = _circle()[0]
    source = split_cubic(curve, 0.37)
    bound = _certify_cubic_span(source, curve, [0.37, 0.63], 1e-10)
    assert bound is not None and bound < 1e-10


def test_certificate_catches_between_anchor_bulge():
    straight = _linear_cubic_segment((0.0, 0.0), (1.0, 0.0))
    source = split_cubic(straight, 0.5)
    bulge = ((0.0, 0.0), (1 / 3, 0.09), (2 / 3, -0.09), (1.0, 0.0))
    assert _bezier_point(bulge, 0.5)[1] == pytest.approx(0.0)
    assert _certify_cubic_span(source, bulge, [0.5, 0.5], 0.02) is None


@pytest.mark.parametrize("tolerance", [0.01, 0.02, 0.05])
def test_exact_split_ring_reduces_without_c2_degradation(tolerance):
    original = _circle()
    groups = [{"exterior": _split_ring(original), "interiors": [], "marker": 123}]
    saved = deepcopy(groups)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=tolerance)
    assert stats["changed"]
    assert stats["before_segments"] == 16
    assert stats["after_segments"] == 4
    assert stats["maximum_error_bound_mm"] <= tolerance
    assert groups == saved and result[0]["marker"] == 123
    assert np.asarray(result[0]["exterior"]) == pytest.approx(np.asarray(original), abs=1e-8)
    before, after = _metric(groups[0]["exterior"]), _metric(result[0]["exterior"])
    assert after.discontinuous_join_count == before.discontinuous_join_count == 0
    assert after.maximum_curvature_jump_per_mm <= before.maximum_curvature_jump_per_mm + 1e-6
    assert _dense_distance(_sample(groups[0]["exterior"]), _sample(result[0]["exterior"])) < tolerance


def test_real_corners_and_seam_are_pinned():
    points = [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (0.0, 20.0)]
    original = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])]
    groups = [{"exterior": _split_ring(original, 1)}]
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
    assert stats["changed"] and stats["after_segments"] == 4
    assert [curve[0] for curve in result[0]["exterior"]] == points
    assert _metric(result[0]["exterior"]).discontinuous_join_count == 4
    assert "interiors" not in result[0]


def test_hole_and_neighbour_keep_winding_nesting_order():
    outer = _split_ring(_circle())
    hole = [tuple(reversed(curve)) for curve in reversed(_split_ring(_circle(2.0)))]
    neighbour = _split_ring(_circle(1.0, (33.0, 20.0)))
    groups = [{"exterior": outer, "interiors": [hole]}, {"exterior": neighbour}]
    saved = deepcopy(groups)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
    assert stats["changed"] and stats["after_segments"] < stats["before_segments"]
    assert groups == saved and len(result) == 2 and len(result[0]["interiors"]) == 1
    candidate = MultiPolygon([Polygon(_sample(result[0]["exterior"]),
                                     [_sample(result[0]["interiors"][0])]),
                              Polygon(_sample(result[1]["exterior"]))])
    assert candidate.is_valid and len(candidate.geoms[0].interiors) == 1
    for source_group, target_group in zip(groups, result):
        for source_ring, target_ring in zip([source_group["exterior"], *source_group.get("interiors", [])],
                                            [target_group["exterior"], *target_group.get("interiors", [])]):
            assert target_ring[0][0] == source_ring[0][0]
            assert Polygon(_sample(target_ring)).exterior.is_ccw == Polygon(_sample(source_ring)).exterior.is_ccw


def test_loop_open_or_degenerate_source_is_unchanged():
    points = [(0.0, 0.0), (2.0, 2.0), (0.0, 2.0), (2.0, 0.0)]
    bowtie = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])]
    invalid = [bowtie, _circle()[:-1], [((0.0, 0.0),) * 4]]
    for ring in invalid:
        groups = [{"exterior": ring}]
        result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
        assert result is groups and not stats["changed"]


@pytest.mark.parametrize("offset_x,offset_y,height", [(0.0, 0.0, 123.45678),
                                                       (11.234567, 21.543219, 157.654321),
                                                       (-15.314159, 7.271828, 222.000049)])
def test_writer_frame_bound_and_topology(offset_x, offset_y, height):
    groups = [{"exterior": _split_ring(_circle())}]
    result, stats = simplify_cubic_path_groups(
        groups, tolerance_mm=0.02, offset_x_points=offset_x,
        offset_y_points=offset_y, page_height=height,
    )
    assert stats["changed"] and stats["maximum_error_bound_mm"] <= 0.02
    original = _sample(groups[0]["exterior"], offset_x=offset_x, offset_y=offset_y, height=height)
    written = _sample(result[0]["exterior"], offset_x=offset_x, offset_y=offset_y, height=height)
    assert Polygon(written).is_valid and _dense_distance(original, written) < 0.02


def test_fresh_slider_runs_do_not_accumulate_error():
    groups = [{"exterior": _split_ring(_circle(), 3)}]
    saved = deepcopy(groups)
    first, first_stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
    _other, _other_stats = simplify_cubic_path_groups(groups, tolerance_mm=0.05)
    again, again_stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
    assert first == again and first_stats == again_stats and groups == saved


def test_unsupported_or_empty_input_is_noop():
    for groups in ([], [{"exterior": []}], [{"exterior": [((math.nan, 0.0),) * 4]}]):
        result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.02)
        assert result is groups and not stats["changed"]


def test_tiny_budget_uses_conservative_route_without_allocating_fair_samples(monkeypatch):
    import app.workers.cutline_fair_simplify as fair

    source = _split_ring(_circle())
    monkeypatch.setattr(fair, "_uniform_points", lambda *args: pytest.fail("Không được lấy mẫu tự do cho budget dưới bước UI"))
    result, bound = fair.fair_refit_ring(source, .0001)
    assert result is source and bound == 0


def test_missing_optional_optimizer_keeps_source(monkeypatch):
    import app.workers.cutline_fair_simplify as fair

    source = _split_ring(_circle())
    def unavailable(*args, **kwargs):
        raise ImportError("Mô phỏng optimizer thiếu trong runtime")
    monkeypatch.setattr(fair, "_optimize_seed", unavailable)
    result, bound = fair.fair_refit_ring(source, .1)
    assert result is source and bound == 0


def test_fair_dispatch_checks_actual_writer_frame_against_original_pdf():
    from pathlib import Path
    import pikepdf
    from app.workers.cutline_cubic_simplify import _rounded_groups, _simplify_cubic_path_groups_impl
    from app.workers.cutline_fair_verify import verify_fair_ring
    from test_sticker_engine_e2e import _parse_cut_machine_paths

    source_pdf = Path(__file__).resolve().parents[2] / "output/pdf/Binder2-page12-global-final-2026-09-10/Binder2_page12_offset2_B3.pdf"
    if not source_pdf.is_file():
        pytest.skip("Artifact Binder2 trang12 là corpus riêng")
    with pikepdf.Pdf.open(source_pdf) as document:
        paths = _parse_cut_machine_paths(document.pages[0])
    source = tuple((s.p0, s.p1, s.p2, s.p3) for s in paths[0])
    assert len(paths) == 1 and len(source) == 122
    groups = [{"exterior": source, "interiors": []}]
    saved = deepcopy(groups)
    frame = dict(offset_x_points=-15.314159, offset_y_points=7.271828, page_height=222.000049)
    result, stats = _simplify_cubic_path_groups_impl(groups, tolerance_mm=.1, fair_refit=True, **frame)
    assert groups == saved and stats["changed"]
    assert stats["after_segments"] <= 70
    old = _rounded_groups([[source]], frame["offset_x_points"], frame["offset_y_points"], frame["page_height"])[0][0]
    new = _rounded_groups([[result[0]["exterior"]]], frame["offset_x_points"], frame["offset_y_points"], frame["page_height"])[0][0]
    proof = verify_fair_ring(np.asarray(old)/UNITS, np.asarray(new)/UNITS, tolerance_mm=.1)
    assert proof.accepted
    assert stats["maximum_error_bound_mm"] == pytest.approx(proof.maximum_error_bound_mm)
    assert proof.candidate_metrics.maximum_abs_curvature_per_mm < proof.source_metrics.maximum_abs_curvature_per_mm
    assert proof.candidate_metrics.p95_curvature_jump_per_mm < proof.source_metrics.p95_curvature_jump_per_mm
