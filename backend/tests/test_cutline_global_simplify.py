"""Hồi quy refit toàn nhịp + đồ thị ít đoạn, không thay nguồn để làm test xanh."""

from __future__ import annotations

from copy import deepcopy
from io import BytesIO
import hashlib
import json
import math
from pathlib import Path
import pickle
import sys
import time
from unittest.mock import patch

if __name__ == "__main__":
    sys.path[:0] = [str(Path(__file__).resolve().parents[1])]

import numpy as np
import pikepdf
import pytest
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.ops import unary_union

from app.workers.cutline_global_simplify import _candidate, _shortest_path
from app.workers.cutline_cubic_simplify import (
    _metrics,
    _simplify_cubic_path_groups_impl,
    simplify_cubic_path_groups,
)
from app.workers.cutline_geometry import _bezier_point, _linear_cubic_segment
from test_cutline_cubic_simplify import _circle, _dense_distance, _sample, _split_ring
from test_sticker_engine_e2e import _parse_cut_machine_paths


UNITS = 72.0 / 25.4
ROOT = Path(__file__).resolve().parents[2]
BINDER2 = ROOT / "test" / "Binder2.pdf"


def _candidate_before_perf(points, left, right, tolerance):
    """Oracle trước §SIMPERF.1: giữ nguyên phép tính và thứ tự bản 2026-09-10.

    Cố ý không dùng bộ lọc/lazy mới; đối chiếu byte tọa độ và certificate,
    không chỉ số đoạn hoặc sai số gần đúng của hai cách cài đặt.
    """
    import app.workers.cutline_global_simplify as module

    origin = points[0].copy()
    local = points - origin
    lengths = np.linalg.norm(np.diff(local, axis=0), axis=1)
    if len(local) < 3 or np.any(lengths <= 1e-12):
        return None
    parameters = np.r_[0.0, np.cumsum(lengths)]
    parameters /= parameters[-1]
    chord = module._unit(local[-1])
    if chord is None or min(float(np.dot(left, chord)), float(np.dot(right, chord))) <= 1e-5:
        return None
    projection = local @ chord
    if (float(projection.min()) < -tolerance
            or float(projection.max()) > float(np.linalg.norm(local[-1])) + tolerance
            or float((np.maximum.accumulate(projection) - projection).max()) > 2.0 * tolerance):
        return None
    source = [tuple(point) for point in local]
    for attempt in range(7):
        curve = module._fit(local, parameters, left, right)
        if curve is None:
            return None
        positions, first, second = module._evaluate(curve, parameters)
        residual = positions - local
        measured = float(np.linalg.norm(residual, axis=1).max())
        if measured <= tolerance:
            bound = module.certify_polyline_curve(source, curve, parameters.tolist(), tolerance)
            if bound is not None:
                translated = tuple(tuple(np.asarray(point) + origin) for point in curve)
                translated = (tuple(points[0]), translated[1], translated[2], tuple(points[-1]))
                return translated, bound
        if attempt == 6:
            return None
        denominator = np.sum(first * first + residual * second, axis=1)
        delta = np.divide(np.sum(residual * first, axis=1), denominator,
                          out=np.zeros_like(parameters), where=np.abs(denominator) > 1e-16)
        updated = np.clip(parameters - delta, 0.0, 1.0)
        updated[0], updated[-1] = 0.0, 1.0
        if np.any(np.diff(updated) <= 1e-12):
            return None
        parameters = updated
    return None


def test_lazy_hull_candidate_is_bit_identical_to_506_preoptimization_cases():
    import app.workers.cutline_global_simplify as module

    rng = np.random.default_rng(20260910)
    cases = []
    for index in range(500):
        scale = 10 ** rng.uniform(-2, 2)
        origin = rng.uniform(-10000, 10000, 2)
        curve = np.array([[0, 0], [rng.uniform(.1, .45), rng.uniform(-.3, .3)],
                          [rng.uniform(.55, .9), rng.uniform(-.3, .3)], [1, 0]]) * scale + origin
        left = module._unit(curve[1] - curve[0])
        right = module._unit(curve[3] - curve[2])
        points = module._evaluate(curve, np.linspace(0, 1, int(rng.integers(3, 80))))[0]
        tolerance = scale * rng.uniform(.002, .05)
        if index % 6 == 1:
            points[len(points) // 2] = points[len(points) // 2 - 1]
        if index % 6 == 2:
            points[len(points) // 2] += rng.uniform(-2, 2, 2) * scale
        if index % 6 == 3:
            right = -right
        cases.append((points, left, right, tolerance))
    cases.extend((np.array(points, dtype=float), np.array([1., 0.]), np.array([1., 0.]), .1)
                 for points in [((0, 0),), ((0, 0), (1, 0)), ((0, 0), (0, 0), (0, 0)),
                                ((0, 0), (1, 0), (0, 0)), ((0, 0), (1e-14, 0), (2e-14, 0)),
                                ((0, 0), (1, 0), (1, 0), (2, 0))])
    accepted = 0
    for index, arguments in enumerate(cases):
        old, new = _candidate_before_perf(*arguments), _candidate(*arguments)
        assert pickle.dumps(new) == pickle.dumps(old), f"Đổi kết quả candidate {index}"
        accepted += old is not None
        if new is not None:
            assert np.isfinite(np.asarray(new[0])).all() and math.isfinite(new[1])
    assert (len(cases), accepted) == (506, 227)


@pytest.mark.parametrize("angle", [0, .37, 1.7])
@pytest.mark.parametrize("sign", [-1, 1])
def test_hull_rejects_source_outside_possible_handle_strips_before_fit(monkeypatch, angle, sign):
    import app.workers.cutline_global_simplify as module

    # Với hai tangent cùng hướng chord, mọi handle _fit có thể nhận nằm
    # trên chord. Đỉnh cách chord 0,2 > ε=0,1 không thể được chứng nhận.
    rotation = np.array([[math.cos(angle), -math.sin(angle)],
                         [math.sin(angle), math.cos(angle)]])
    source = np.array([[0., 0.], [.5, sign * .2], [1., 0.]]) @ rotation.T + [3456., -8912.]
    tangent = np.array([1., 0.]) @ rotation.T
    monkeypatch.setattr(module, "_fit", lambda *args: pytest.fail("Đã có chứng cứ ngoài hull, không cần fit"))
    assert _candidate(source, tangent, tangent, .1) is None


@pytest.mark.parametrize("scale,origin", [(1., (0., 0.)), (100., (1e9, -1e9)), (.01, (-10000., 10000.))])
def test_hull_keeps_finite_candidate_near_expanded_strip_boundary(monkeypatch, scale, origin):
    import app.workers.cutline_global_simplify as module

    source = np.array([[0., 0.], [.25, .1], [.75, -.1], [1., 0.]]) * scale + origin
    # Lấy biên từ tọa độ float thật; cộng origin lớn có thể đổi khoảng
    # cách so với .1*scale lý tưởng trước lượng tử của phép cộng đó.
    tolerance = float(np.abs((source - source[0])[:, 1]).max())
    tangent = np.array([1., 0.])
    original_fit = module._fit
    calls = []

    def counted_fit(*args):
        calls.append(True)
        return original_fit(*args)

    monkeypatch.setattr(module, "_fit", counted_fit)
    reference = _candidate_before_perf(source, tangent, tangent, tolerance)
    calls.clear()
    actual = _candidate(source, tangent, tangent, tolerance)
    assert calls, "Biên dải mở rộng không được bị loại sớm do ulp"
    assert pickle.dumps(actual) == pickle.dumps(reference)


def _scalloped_polyline():
    shape = unary_union([
        Point(15 * UNITS * math.cos(i * math.pi / 6), 15 * UNITS * math.sin(i * math.pi / 6)).buffer(6 * UNITS, quad_segs=16)
        for i in range(12)
    ] + [Point(0, 0).buffer(15 * UNITS, quad_segs=32)])
    points = list(shape.exterior.coords)
    return [{"exterior": [_linear_cubic_segment(a, b) for a, b in zip(points, points[1:])], "interiors": []}]


def test_shortest_path_does_not_choose_farthest_greedy_dead_end():
    edges = {(0, 4): "dead-end", (0, 3): "first", (3, 6): "second"}
    choices, count = _shortest_path(6, lambda a, b: edges.get((a, b)))
    assert count == 2
    assert choices[0] == (3, "first")
    assert choices[3] == (6, "second")


def test_short_span_failure_does_not_block_long_span_success():
    edges = {(0, 5): "whole"}
    choices, count = _shortest_path(5, lambda a, b: edges.get((a, b)))
    assert count == 1 and choices[0] == (5, "whole")


def test_candidate_never_accepts_hidden_bulge_on_linear_reference():
    points = np.array([(0.0, 0.0), (0.2, 0.0), (0.7, 0.0), (1.0, 0.0)])
    result = _candidate(points, np.array([1.0, 0.0]), np.array([1.0, 0.0]), 0.01)
    assert result is not None
    curve, bound = result
    assert bound < 0.01
    assert max(abs(_bezier_point(curve, t)[1]) for t in np.linspace(0, 1, 100)) < 1e-12


def test_new_fitter_candidate_is_rejected_when_only_sample_points_match(monkeypatch):
    import app.workers.cutline_global_simplify as module

    bulge = ((0.0, 0.0), (1 / 3, 0.09), (2 / 3, -0.09), (1.0, 0.0))
    # Fit giả đánh lừa toàn bộ mẫu 0,1/2,1; oracle liên tục vẫn phải từ chối.
    monkeypatch.setattr(module, "_fit", lambda *args: bulge)
    source = np.array([(0.0, 0.0), (0.5, 0.0), (1.0, 0.0)])
    assert _candidate(source, np.array([1.0, 0.0]), np.array([1.0, 0.0]), 0.02) is None


@pytest.mark.parametrize("scale", [0.5, 1.0, 2.0])
def test_scalloped_curve_removes_redundant_nodes_under_same_physical_budget(scale):
    groups = _scalloped_polyline()
    for group in groups:
        group["exterior"] = [tuple((x * scale, y * scale) for x, y in curve) for curve in group["exterior"]]
    saved = deepcopy(groups)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.05)
    assert stats["changed"]
    assert stats["after_segments"] <= 30
    assert stats["after_segments"] < stats["before_segments"] / 6
    assert 0 < stats["maximum_error_bound_mm"] <= 0.05
    assert groups == saved
    assert _dense_distance(_sample(groups[0]["exterior"]), _sample(result[0]["exterior"])) < 0.05
    assert result[0]["exterior"][0][0] == groups[0]["exterior"][0][0]
    assert Polygon(_sample(result[0]["exterior"])).is_valid
    before, after = _metrics(groups[0]["exterior"], UNITS), _metrics(result[0]["exterior"], UNITS)
    assert after.short_segment_count <= before.short_segment_count
    assert after.discontinuous_join_count <= before.discontinuous_join_count


def test_free_curves_stay_inside_immutable_source_band_with_hole_and_neighbour():
    groups = _scalloped_polyline()
    hole = [tuple(reversed(curve)) for curve in reversed(_split_ring(_circle(2, (0, 0))))]
    groups[0]["interiors"] = [hole]
    groups.append({"exterior": _split_ring(_circle(1, (24, 0))), "interiors": []})
    saved = deepcopy(groups)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.05, page_height=153.456789)
    assert stats["changed"] and groups == saved
    assert len(result) == 2 and len(result[0]["interiors"]) == 1
    polygons = [Polygon(_sample(g["exterior"]), [_sample(r) for r in g["interiors"]]) for g in result]
    assert MultiPolygon(polygons).is_valid
    for a, b in zip(groups, result):
        assert _dense_distance(_sample(a["exterior"]), _sample(b["exterior"])) < 0.05


def test_zero_slider_is_exact_noop_after_several_fits():
    groups = _scalloped_polyline()
    saved = deepcopy(groups)
    for tolerance in (0.01, 0.05, 0.02):
        simplify_cubic_path_groups(groups, tolerance_mm=tolerance)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0)
    assert result is groups and groups == saved and not stats["changed"]


def test_isolated_shallow_corner_is_not_erased_as_raster_noise():
    from app.workers.cutline_global_simplify import global_refit_ring

    points = [(0, 0), (5, 0), (10, 0), (15, 1.0), (20, 2.0), (20, 10), (0, 10), (0, 0)]
    source = tuple(_linear_cubic_segment(a, b) for a, b in zip(points, points[1:]))
    reduced, _bound = global_refit_ring(source, 0.05, 1.0)
    assert (10.0, 0.0) in [curve[0] for curve in reduced]


def test_existing_c2_split_curve_does_not_lose_its_curvature_continuity():
    groups = [{"exterior": _split_ring(_circle(), 3), "interiors": []}]
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.05)
    before, after = _metrics(groups[0]["exterior"], UNITS), _metrics(result[0]["exterior"], UNITS)
    assert stats["after_segments"] == 4
    assert after.maximum_curvature_jump_per_mm <= before.maximum_curvature_jump_per_mm + 1e-6


def _write_page12_comparison(directory):
    """Artifact A/B đúng page12, không ghi đè file gốc hoặc baseline cũ."""
    import app.workers.cutline_cubic_simplify as simplifier
    from app.workers.sticker_engine import StickerEngine

    directory.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(BINDER2.read_bytes()).hexdigest()
    public_simplifier = simplifier.simplify_cubic_path_groups
    evidence = {"source": str(BINDER2), "sha256": source_hash, "cases": []}
    for offset in (0.0, 2.0):
        pairs = []
        for mode in ("B3", "B4"):
            def selected_simplifier(groups, **kwargs):
                return (_simplify_cubic_path_groups_impl(groups, **kwargs, global_refit=False)
                        if mode == "B3" else public_simplifier(groups, **kwargs))

            start = time.perf_counter()
            with patch.object(simplifier, "simplify_cubic_path_groups", selected_simplifier):
                result = StickerEngine(dpi=300).process_pdf(
                    input_path=str(BINDER2), output_path="", _page_subset=[11],
                    cut_mode="original", offset_mm=offset, bleed_mm=0.0,
                    corner_style="preserve", remove_white_bg=True, shape_mode="auto_safe",
                    alpha_corner_policy="adaptive", cutline_denoise=30, cutline_simplify_mm=0.05,
                )
            elapsed = time.perf_counter() - start
            output = directory / f"Binder2_page12_offset{offset:g}_{mode}.pdf"
            output.write_bytes(result[0])
            with pikepdf.Pdf.open(output) as pdf:
                paths = _parse_cut_machine_paths(pdf.pages[0])
                groups = [{"exterior": [(s.p0, s.p1, s.p2, s.p3) for s in ring], "interiors": []}
                          for ring in paths]
            pairs.append(groups)
            record = {"offset_mm": offset, "mode": mode, "pdf": str(output), "seconds": elapsed,
                      "ring_segments": [len(ring) for ring in paths],
                      "segments": sum(len(ring) for ring in paths),
                      "simplification": result[1][0].get("cutline_simplification")}
            evidence["cases"].append(record)
            print(json.dumps(record, ensure_ascii=True), flush=True)
        distances = [_dense_distance(_sample(a["exterior"]), _sample(b["exterior"]))
                     for a, b in zip(*pairs)]
        assert len(pairs[0]) == len(pairs[1])
        evidence["cases"][-1]["sampled_B3_B4_distance_mm"] = distances
    groups = _scalloped_polyline()
    start = time.perf_counter()
    result, stats = public_simplifier(groups, tolerance_mm=0.05)
    evidence["synthetic_scalloped"] = {**stats, "seconds": time.perf_counter() - start,
        "sampled_distance_mm": _dense_distance(_sample(groups[0]["exterior"]), _sample(result[0]["exterior"]))}
    evidence["source_unchanged"] = hashlib.sha256(BINDER2.read_bytes()).hexdigest() == source_hash
    assert evidence["source_unchanged"]
    (directory / "page12_evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    _write_page12_comparison(parser.parse_args().artifact_dir.resolve())


@pytest.mark.skipif(not BINDER2.is_file(), reason="Binder2 là corpus riêng của dự án")
def test_page12_flower_improves_beyond_pairwise_on_actual_pdf():
    from app.workers.sticker_engine import StickerEngine

    output = StickerEngine(dpi=300).process_pdf(
        input_path=str(BINDER2), output_path="", _page_subset=[11],
        cut_mode="original", offset_mm=0, bleed_mm=0, corner_style="preserve",
        remove_white_bg=True, shape_mode="auto_safe", alpha_corner_policy="adaptive",
        cutline_denoise=30, cutline_simplify_mm=0,
    )
    with pikepdf.Pdf.open(BytesIO(output[0])) as pdf:
        paths = _parse_cut_machine_paths(pdf.pages[0])
    # Chọn bằng diện tích, không hardcode thứ tự ring của extractor.
    source = max(paths, key=lambda path: Polygon([s.p0 for s in path]).area)
    groups = [{"exterior": [(s.p0, s.p1, s.p2, s.p3) for s in source], "interiors": []}]
    _old, old_stats = _simplify_cubic_path_groups_impl(groups, tolerance_mm=0.05, global_refit=False)
    result, stats = simplify_cubic_path_groups(groups, tolerance_mm=0.05)
    assert stats["changed"] and stats["after_segments"] < old_stats["after_segments"]
    assert stats["after_segments"] <= 46
    assert stats["maximum_error_bound_mm"] <= 0.05
    assert _dense_distance(_sample(groups[0]["exterior"]), _sample(result[0]["exterior"])) < 0.05
    before, after = _metrics(groups[0]["exterior"], UNITS), _metrics(result[0]["exterior"], UNITS)
    assert after.discontinuous_join_count <= before.discontinuous_join_count
    assert after.short_segment_count == 0
    assert after.maximum_curvature_jump_per_mm <= before.maximum_curvature_jump_per_mm + 1e-6
