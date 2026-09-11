"""Seed thưa dùng nguồn vector thật, bảo toàn góc và không phụ thuộc corpus."""

from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
import time

import numpy as np
import pytest
import shapely
from shapely.geometry import LineString
from shapely.strtree import STRtree

from app.workers.cutline_fair_seed import build_fair_seeds, fit_seed_ring
from app.workers.cutline_geometry import _bezier_point, _linear_cubic_segment
from app.workers.cutline_polyline_reduction import split_cubic


def _circle():
    r, k = 10.0, 5.522847498307936
    return [((r, 0), (r, k), (k, r), (0, r)),
            ((0, r), (-k, r), (-r, k), (-r, 0)),
            ((-r, 0), (-r, -k), (-k, -r), (0, -r)),
            ((0, -r), (k, -r), (r, -k), (r, 0))]


def _split(curves, levels=2):
    for _ in range(levels):
        curves = [part for curve in curves for part in split_cubic(curve, 0.5)]
    return curves


def _sample(curves):
    points = [_bezier_point(curve, t) for curve in curves for t in np.linspace(0, 1, 257, endpoint=False)]
    return np.array([*points, curves[-1][-1]])


def _sampled_distance(first, second):
    def directed(source, target):
        tree = STRtree(shapely.linestrings(np.stack([target[:-1], target[1:]], axis=1)))
        return float(tree.query_nearest(shapely.points(source), all_matches=False, return_distance=True)[1].max())
    return max(directed(first, second), directed(second, first))


def _angle(a, b):
    a, b = np.asarray(a), np.asarray(b)
    return math.acos(float(np.clip(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))


def test_seed_reduces_subdivided_circle_deterministically_without_mutating_source():
    source = _split(_circle(), 3)
    saved = deepcopy(source)
    candidates = build_fair_seeds(source, 0.1)
    assert candidates and all(2 <= len(candidate) <= 8 for candidate in candidates)
    assert source == saved
    assert build_fair_seeds(source, 0.1) == candidates
    for candidate in candidates:
        assert np.array_equal(np.asarray(candidate)[:, 3], np.roll(np.asarray(candidate)[:, 0], -1, axis=0))
        assert LineString(_sample(candidate)).is_simple


def test_sample_entire_cubic_not_only_anchors():
    source = _split(_circle(), 3)
    seed = fit_seed_ring(source, 0.125)
    # Chord nối bốn neo cardinal lệch gần 3 mm; seed phải theo các cung cong.
    assert _sampled_distance(_sample(seed), _sample(source)) < 0.125


def test_protected_corners_split_into_open_runs_and_keep_both_directions():
    points = [(0.3, 0.7), (20.8, 0.7), (20.8, 13.4), (0.3, 13.4)]
    original = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])]
    source = _split(original, 2)
    seeds = build_fair_seeds(source, 0.1, protected_indices=[4, 8, 12])
    assert seeds
    for seed in seeds:
        anchors = [curve[0] for curve in seed]
        for source_index in [4, 8, 12]:
            location = tuple(source[source_index][0])
            target_index = anchors.index(location)
            before, after = np.asarray(seed[target_index - 1]), np.asarray(seed[target_index])
            original_before, original_after = np.asarray(source[source_index - 1]), np.asarray(source[source_index])
            assert _angle(before[3] - before[2], original_before[3] - original_before[2]) < 1e-7
            assert _angle(after[1] - after[0], original_after[1] - original_after[0]) < 1e-7


def test_single_protected_corner_at_seam_and_negative_coordinates_remains_exact():
    source = _split(_circle(), 3)
    source = [tuple((x - 123.456789, y - 37.819273) for x, y in curve) for curve in source]
    seed = fit_seed_ring(source, 0.125, protected_indices=[11])
    assert seed[0][0] == source[11][0] == seed[-1][3]
    assert np.array_equal(np.asarray(seed)[:, 3], np.roll(np.asarray(seed)[:, 0], -1, axis=0))


@pytest.mark.parametrize("tolerance", [0, -0.1, math.nan, math.inf, None])
def test_invalid_tolerance_is_rejected(tolerance):
    with pytest.raises(ValueError):
        build_fair_seeds(_circle(), tolerance)


@pytest.mark.parametrize("source", [[[1, 2]], float("nan"), [((0, 0), (1, 0), (1, 1), (0, 1))]])
def test_malformed_or_open_source_is_rejected(source):
    with pytest.raises(ValueError):
        fit_seed_ring(source, 0.1)


@pytest.mark.parametrize("protected", [[-1], [4], [0.5]])
def test_invalid_protected_indices_are_rejected(protected):
    with pytest.raises(ValueError):
        build_fair_seeds(_circle(), 0.1, protected_indices=protected)


def test_empty_source_and_nonreducing_candidate_need_no_solver_work():
    assert build_fair_seeds([], 0.1) == ()
    points = [(0, 0), (10, 0), (10, 10), (0, 10)]
    source = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])]
    assert build_fair_seeds(source, 0.1, protected_indices=range(4)) == ()


def test_seed_order_prefers_moderate_refit_then_closer_fallback(monkeypatch):
    import app.workers.cutline_fair_seed as module

    seen = []
    def fitted(source, tolerance, **kwargs):
        seen.append(tolerance)
        circle = _circle()
        turn = len(seen) - 1
        return tuple(circle[turn:] + circle[:turn])
    monkeypatch.setattr(module, "fit_seed_ring", fitted)
    assert len(build_fair_seeds(_split(_circle()), 0.1)) == 3
    assert seen == pytest.approx([0.11, 0.10, 0.125])


def test_seed_to_optimizer_keeps_real_corner_positions_and_two_tangents():
    from app.workers.cutline_fair_simplify import fair_refit_ring

    points = [(0.1, 0.2), (1.1, 0.2), (1.1, 1.2), (0.1, 1.2)]
    original = [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:] + points[:1])]
    source = _split(original, 2)
    output, bound = fair_refit_ring(source, 0.03)
    assert len(output) == 4
    assert 0 <= bound <= 0.03
    assert set(curve[0] for curve in output) == set(points)
    for index, curve in enumerate(output):
        previous = np.asarray(output[index - 1])
        current = np.asarray(curve)
        assert _angle(previous[3] - previous[2], current[1] - current[0]) == pytest.approx(math.pi / 2)


def test_seed_to_optimizer_does_not_replace_smooth_ring_with_worse_curvature():
    from app.workers.cutline_fair_simplify import fair_refit_ring

    source = _split([tuple((x / 10, y / 10) for x, y in curve) for curve in _circle()], 3)
    saved = deepcopy(source)
    output, bound = fair_refit_ring(source, 0.03)
    # Seed hai nửa vòng có ít neo và gần nguồn nhưng độ cong biến thiên
    # xấu hơn circle đã trơn; verifier phải fallback, không chạy đua số neo.
    assert output is source and source == saved and bound == 0
    values = np.asarray(output)
    assert np.array_equal(values[:, 3], np.roll(values[:, 0], -1, axis=0))
    for index, curve in enumerate(values):
        incoming = values[index - 1, 3] - values[index - 1, 2]
        assert _angle(incoming, curve[1] - curve[0]) < 1e-7


ROOT = Path(__file__).resolve().parents[2]
PAGE12 = ROOT / "output/pdf/Binder2-page12-global-final-2026-09-10/Binder2_page12_offset2_B3.pdf"


@pytest.mark.skipif(not PAGE12.is_file(), reason="Artifact Binder2 trang 12 là corpus riêng")
def test_binder2_page12_real_vector_seed_is_sparse_and_not_a_temp_runtime_dependency():
    import pikepdf
    from test_sticker_engine_e2e import _parse_cut_machine_paths

    with pikepdf.Pdf.open(PAGE12) as document:
        paths = _parse_cut_machine_paths(document.pages[0])
    assert len(paths) == 1 and len(paths[0]) == 122
    units = 72 / 25.4
    source = tuple(tuple((p[0] / units, p[1] / units) for p in (s.p0, s.p1, s.p2, s.p3)) for s in paths[0])
    started = time.perf_counter()
    seed = fit_seed_ring(source, 0.125)
    elapsed = time.perf_counter() - started
    distance = _sampled_distance(_sample(seed), _sample(source))
    print({"source_nodes": len(source), "seed_nodes": len(seed), "sampled_error_mm": distance,
           "seed_seconds": elapsed})
    assert 45 <= len(seed) <= 65
    assert distance < 0.13
    assert LineString(_sample(seed)).is_simple
    # Không coi seed dưới 0,13 mm là đường CUT đạt mục tiêu 0,10 mm:
    # bộ tối ưu và verifier downstream vẫn bắt buộc so lại với nguồn.
