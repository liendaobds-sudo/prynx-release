"""Đối chứng tái dùng lõi CUT: cùng phép tính, nguồn bất biến và fallback cũ."""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
import heapq
from types import SimpleNamespace

import numpy as np
import pytest

import app.workers.cutline_fair_seed as seed_module
import app.workers.cutline_fair_simplify as fair_module
import app.workers.cutline_fair_verify as verify_module
import app.workers.cutline_fair_jacobian as jacobian_module
from app.workers.cutline_preview_cancel import (
    PreviewCancellation,
    PreviewCancelled,
    cancellation_scope,
)


def _legacy_fit_run(points, tolerance, left, right):
    """Oracle trước tái dùng nhịp: cố ý gọi lại fitter khi hàng đợi hỏi trùng."""
    tangents = np.vstack([
        left,
        [seed_module._unit(vector) for vector in points[2:] - points[:-2]],
        right,
    ])
    spans = []
    pending = [(0, len(points) - 1)]
    while pending:
        start, end = pending.pop()
        curve, error, split = seed_module._fit(
            points[start:end + 1], tangents[start], tangents[end],
        )
        if error <= tolerance or end == start + 1:
            if curve is None:
                return []
            spans.append((start, end, curve))
        else:
            middle = start + split
            pending.extend([(middle, end), (start, middle)])
    if len(spans) < 2:
        return [span[2] for span in spans]
    entries = {
        index: [start, end, curve, index - 1, index + 1, 0]
        for index, (start, end, curve) in enumerate(spans)
    }
    entries[0][3], entries[len(spans) - 1][4] = None, None
    queue = []

    def propose(index):
        if index is None or index not in entries:
            return
        a = entries[index]
        following = a[4]
        if following is None or following not in entries:
            return
        b = entries[following]
        curve, error, _ = seed_module._fit(
            points[a[0]:b[1] + 1], tangents[a[0]], tangents[b[1]],
        )
        if curve is not None and error <= tolerance:
            heapq.heappush(queue, (error, index, following, a[5], b[5], curve))

    for index in entries:
        propose(index)
    while queue:
        _error, index, following, version_a, version_b, curve = heapq.heappop(queue)
        if index not in entries or following not in entries:
            continue
        a, b = entries[index], entries[following]
        if a[4] != following or a[5] != version_a or b[5] != version_b:
            continue
        a[1], a[2], a[4], a[5] = b[1], curve, b[4], a[5] + 1
        if b[4] is not None:
            entries[b[4]][3] = index
        del entries[following]
        propose(a[3])
        propose(index)
    result, index = [], 0
    while index is not None:
        entry = entries[index]
        result.append(entry[2])
        index = entry[4]
    return result


@pytest.mark.parametrize("scale, origin", [
    (1.0, (0.0, 0.0)),
    (0.001, (-123.456789, 789.123456)),
    (100.0, (1e9, -1e9)),
])
def test_position_only_keeps_identical_floating_point_operations(scale, origin):
    generator = np.random.default_rng(20260911)
    parameters = np.r_[0.0, generator.random(37), 1.0]
    for raw_curve in generator.normal(size=(8, 4, 2)):
        curve = raw_curve * scale + origin
        saved = curve.copy()
        positions, _first, _second = seed_module._evaluate(curve, parameters)
        only_positions = seed_module._evaluate(curve, parameters, derivatives=False)
        assert only_positions.tobytes() == positions.tobytes()
        assert curve.tobytes() == saved.tobytes()


def test_arc_sampler_matches_old_derivative_allocating_path(monkeypatch):
    curves = np.asarray([
        ((-0.4, 0.1), (-0.2, 0.6), (0.3, 0.7), (0.5, 0.2)),
        ((0.5, 0.2), (0.8, -0.2), (1.1, 0.0), (1.4, 0.5)),
    ])
    saved = curves.copy()
    actual = seed_module._sample_run(curves, 0.02)
    evaluate = seed_module._evaluate
    derivative_requests = []

    def legacy_evaluate(curve, parameters, *, derivatives=True):
        derivative_requests.append(derivatives)
        result = evaluate(curve, parameters)
        return result if derivatives else result[0]

    monkeypatch.setattr(seed_module, "_evaluate", legacy_evaluate)
    expected = seed_module._sample_run(curves, 0.02)
    assert derivative_requests == [False, False]
    assert actual.tobytes() == expected.tobytes()
    assert curves.tobytes() == saved.tobytes()


@pytest.mark.parametrize("case", ["wave", "arc", "translated_wave"])
def test_fit_range_reuse_is_bit_identical_to_uncached_algorithm(case):
    t = np.linspace(0, 1, 41)
    if case == "arc":
        points = np.column_stack([2 * np.cos(np.pi * t), 2 * np.sin(np.pi * t)])
    else:
        points = np.column_stack([3 * t, 0.3 * np.sin(5 * np.pi * t)])
        if case == "translated_wave":
            points += np.asarray([-123.456789, 7.271828])
    left = seed_module._unit(points[1] - points[0])
    right = seed_module._unit(points[-1] - points[-2])
    saved = points.copy(), left.copy(), right.copy()
    expected = _legacy_fit_run(points, 0.025, left, right)
    actual = seed_module._fit_run(points, 0.025, left, right)
    assert np.asarray(actual).tobytes() == np.asarray(expected).tobytes()
    for current, original in zip((points, left, right), saved):
        assert current.tobytes() == original.tobytes()


def test_fit_range_reuse_removes_duplicate_failed_fits_without_cross_call_cache(monkeypatch):
    points = np.column_stack([np.arange(9.0), np.zeros(9)])
    left = right = np.asarray([1.0, 0.0])
    seen = []

    def fitted(samples, incoming, outgoing):
        seen.append((float(samples[0, 0]), float(samples[-1, 0])))
        curve = np.asarray([
            samples[0], samples[0] + incoming / 3,
            samples[-1] - outgoing / 3, samples[-1],
        ])
        return curve, 2.0 if len(samples) > 3 else 0.0, len(samples) // 2

    monkeypatch.setattr(seed_module, "_fit", fitted)
    expected = _legacy_fit_run(points, 1.0, left, right)
    old_requests = seen.copy()
    seen.clear()
    actual = seed_module._fit_run(points, 1.0, left, right)
    assert np.asarray(actual).tobytes() == np.asarray(expected).tobytes()
    assert len(old_requests) > len(seen)
    assert max(Counter(old_requests).values()) > 1
    assert all(count == 1 for count in Counter(seen).values())

    seen.clear()
    moved = points + [20.0, -7.0]
    moved_output = seed_module._fit_run(moved, 1.0, left, right)
    assert seen and min(start for start, _end in seen) == 20.0
    assert np.asarray(moved_output)[0, 0].tobytes() == moved[0].tobytes()
    assert np.array_equal(points[:, 0], np.arange(9.0))


def _source_ring():
    return np.asarray([
        ((10.0, 0.0), (10.0, 5.5), (5.5, 10.0), (0.0, 10.0)),
        ((0.0, 10.0), (-5.5, 10.0), (-10.0, 5.5), (-10.0, 0.0)),
        ((-10.0, 0.0), (-10.0, -5.5), (-5.5, -10.0), (0.0, -10.0)),
        ((0.0, -10.0), (5.5, -10.0), (10.0, -5.5), (10.0, 0.0)),
    ]) + [-123.456789, 7.271828]


def _install_fair_stubs(monkeypatch, *, accepted=None):
    """Cô lập vòng điều phối; kiểm hình học thật nằm trong bộ fair/cubic sẵn có."""
    state = {"prepare": Counter(), "calls": [], "seeds": (), "last": None}

    def corners(local):
        state["prepare"]["corners"] += 1
        return ()

    def uniform_points(local, step):
        state["prepare"]["points"] += 1
        return local[:, 0].copy()

    def build_seeds(local, tolerance, *, protected_indices):
        state["prepare"]["seeds"] += 1
        state["seeds"] = tuple(
            tuple(tuple(tuple(float(value) for value in point) for point in curve)
                  for curve in local[indices])
            for indices in ([0, 2], [0, 1, 3])
        )
        return state["seeds"]

    def optimize(local, seed, tolerance, protected, source_points, **options):
        stage = "fast" if options["max_nfev"] == 3 else "full"
        seed_index = len(seed) - 2
        state["last"] = stage, seed_index
        state["calls"].append({
            "stage": stage,
            "seed_index": seed_index,
            "seed_bytes": seed.tobytes(),
            "local_id": id(local),
            "points_id": id(source_points),
            "options": options,
        })
        # Cố ý sửa mảng riêng để bắt warm-start nhầm từ candidate bị loại.
        seed += [0.123456, -0.234567]
        return seed

    def verify(local, candidate, *, tolerance_mm, protected_vertices):
        return SimpleNamespace(
            accepted=state["last"] == accepted,
            maximum_error_bound_mm=0.0423,
        )

    monkeypatch.setattr(fair_module, "protected_corner_indices", corners)
    monkeypatch.setattr(fair_module, "_uniform_points", uniform_points)
    monkeypatch.setattr(seed_module, "build_fair_seeds", build_seeds)
    monkeypatch.setattr(fair_module, "_optimize_seed", optimize)
    monkeypatch.setattr(verify_module, "verify_fair_ring", verify)
    return state


@pytest.mark.parametrize("accepted, expected_calls", [
    (("fast", 0), [("fast", 0)]),
    (("full", 1), [("fast", 0), ("fast", 1), ("full", 0), ("full", 1)]),
    (None, [("fast", 0), ("fast", 1), ("full", 0), ("full", 1)]),
])
def test_full_fallback_reuses_preparation_but_restarts_original_seeds(
    monkeypatch, accepted, expected_calls,
):
    source = _source_ring()
    saved = source.copy()
    state = _install_fair_stubs(monkeypatch, accepted=accepted)
    result, bound = fair_module.fair_refit_ring(
        source, 0.1, max_irls_rounds=3, max_nfev=3,
    )
    assert state["prepare"] == {"corners": 1, "points": 1, "seeds": 1}
    assert [(call["stage"], call["seed_index"]) for call in state["calls"]] == expected_calls
    assert len({call["local_id"] for call in state["calls"]}) == 1
    assert len({call["points_id"] for call in state["calls"]}) == 1
    for call in state["calls"]:
        assert call["seed_bytes"] == np.asarray(state["seeds"][call["seed_index"]]).tobytes()
        assert call["options"] == (
            {"max_irls_rounds": 3, "max_nfev": 3} if call["stage"] == "fast"
            else {"max_irls_rounds": 5, "max_nfev": 35}
        )
    assert source.tobytes() == saved.tobytes()
    if accepted is None:
        assert result is source and bound == 0.0
    else:
        expected = np.asarray(state["seeds"][accepted[1]]) + [0.123456, -0.234567]
        expected = expected + source[0, 0]
        assert np.asarray(result).tobytes() == expected.tobytes()
        assert bound == 0.0423
    if accepted == ("full", 1):
        direct_result, direct_bound = fair_module.fair_refit_ring(source, 0.1)
        assert np.asarray(result).tobytes() == np.asarray(direct_result).tobytes()
        assert bound == direct_bound
        assert state["prepare"] == {"corners": 2, "points": 2, "seeds": 2}


def test_reuse_does_not_swallow_cancellation_before_full_fallback(monkeypatch):
    source = _source_ring()
    saved = deepcopy(source)
    state = _install_fair_stubs(monkeypatch)
    token = PreviewCancellation()
    verify = verify_module.verify_fair_ring

    def cancelling_verify(*args, **kwargs):
        result = verify(*args, **kwargs)
        if state["last"] == ("fast", 1):
            token.cancel()
        return result

    monkeypatch.setattr(verify_module, "verify_fair_ring", cancelling_verify)
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            fair_module.fair_refit_ring(source, 0.1, max_irls_rounds=3, max_nfev=3)
    finally:
        token.close()
    assert state["prepare"] == {"corners": 1, "points": 1, "seeds": 1}
    assert [call["stage"] for call in state["calls"]] == ["fast", "fast"]
    assert source.tobytes() == saved.tobytes()


def test_optional_optimizer_error_keeps_exact_original_source(monkeypatch):
    source = _source_ring()
    saved = source.copy()
    state = _install_fair_stubs(monkeypatch)

    def unavailable(*args, **kwargs):
        raise ImportError("Mô phỏng thiếu bộ tối ưu tùy chọn")

    monkeypatch.setattr(fair_module, "_optimize_seed", unavailable)
    result, bound = fair_module.fair_refit_ring(source, 0.1, max_irls_rounds=3, max_nfev=3)
    assert result is source and bound == 0.0
    assert source.tobytes() == saved.tobytes()
    assert state["prepare"] == {"corners": 1, "points": 1, "seeds": 1}


@pytest.mark.parametrize("count", [2, 3, 4, 11])
@pytest.mark.parametrize("free_mode", ["corners", "all", "none"])
def test_csr_template_matches_legacy_coo_assembly_exactly(count, free_mode):
    from test_cutline_fair_jacobian import _fixture

    values, options = _fixture(count)
    indices, parameters, weights, fair_scale, smooth, free, angles = options
    if free_mode != "corners":
        free = np.full(5 * count, free_mode == "all", dtype=bool)
    build = jacobian_module.build_fair_jacobian(
        indices, parameters, weights, fair_scale, smooth, free, angles,
    )
    # Selector số nguyên đi qua assembly COO cũ, cùng tập/thứ tự cột với
    # boolean mask. Không dùng template CSR mới làm oracle cho chính nó.
    legacy = jacobian_module.build_fair_jacobian(
        indices, parameters, weights, fair_scale, smooth, np.flatnonzero(free), angles,
    )
    for scale in (1.0, 0.0, 0.1, 2.0):
        changed = values.copy()
        changed[:, :3] *= scale
        curves = fair_module._decode(changed, angles)
        expected, actual = legacy(changed, curves), build(changed, curves)
        assert actual.shape == expected.shape
        assert actual.data.tobytes() == expected.data.tobytes()
        assert actual.indices.tobytes() == expected.indices.tobytes()
        assert actual.indptr.tobytes() == expected.indptr.tobytes()
        # Solver/khách gọi được sửa CSR trả về; không được phá template hoặc
        # các đạo hàm bằng 0 sẽ thành khác 0 ở lần đánh giá tiếp theo.
        actual.data.fill(0)
        actual.indices.fill(0)
        actual.indptr.fill(0)


def test_jacobian_only_builds_sparse_structure_once_per_correspondence(monkeypatch):
    from test_cutline_fair_jacobian import _fixture

    values, options = _fixture(5)
    original = jacobian_module.coo_matrix
    calls = []

    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(jacobian_module, "coo_matrix", counted)
    build = jacobian_module.build_fair_jacobian(*options)
    assert calls == [1]
    for angle in (0.0, 0.25, 0.8):
        shifted = values.copy()
        shifted[:, 2] += angle
        matrix = build(shifted, fair_module._decode(shifted, options[-1]))
        assert matrix.nnz > 0
    assert calls == [1]
