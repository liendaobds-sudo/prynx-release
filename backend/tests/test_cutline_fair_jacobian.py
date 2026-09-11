"""Đối chứng đạo hàm giải tích với sai phân cũ, không nới guard đường CUT."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import time

import numpy as np
import pytest
from scipy.optimize._numdiff import approx_derivative
from scipy.sparse import coo_matrix, isspmatrix_csr

from app.workers import cutline_fair_jacobian as jacobian_module
from app.workers import cutline_fair_simplify as fair
from app.workers.cutline_fair_verify import verify_fair_ring


def _fixture(count):
    rng = np.random.default_rng(123 + count)
    values = rng.normal(size=(count, 5))
    values[:, :2] *= 2
    values[:, 3:] = rng.uniform(-1., 1., size=(count, 2))
    indices = np.repeat(np.arange(count), 7)
    parameters = np.tile(np.linspace(0, 1, 7), count)
    weights = rng.uniform(.5, 2., size=len(indices))
    fair_scale = rng.uniform(.1, .3, size=count)
    smooth = np.ones(count, dtype=bool)
    angle_delta = rng.uniform(-1., 1., size=count)
    free = np.ones(values.shape, dtype=bool)
    # Khóa cả seam và một góc bên trong: hai hướng tại góc vẫn độc lập.
    free[[0, count // 2], :3] = False
    smooth[[0, count // 2]] = False
    return values, (indices, parameters, weights, fair_scale, smooth, free.ravel(), angle_delta)


def _residual_for(values, options):
    indices, parameters, weights, fair_scale, smooth, free, angle_delta = options
    base = values.ravel().copy()
    def residual(candidate):
        full = base.copy()
        full[free] = candidate
        curves = fair._decode(full.reshape(-1, 5), angle_delta)
        return np.r_[(fair._evaluate(curves, indices, parameters)*weights[:, None]).ravel(),
                     fair_scale*smooth*fair._curvature_jumps(curves)]
    return residual


@pytest.mark.parametrize("count", [4, 5, 11])
def test_analytic_jacobian_matches_central_difference_with_pinned_corners(count):
    values, options = _fixture(count)
    saved = values.copy()
    free, angle_delta = options[-2:]
    build = jacobian_module.build_fair_jacobian(*options)
    actual = build(values, fair._decode(values, angle_delta))
    reference = approx_derivative(_residual_for(values, options), values.ravel()[free], method="3-point")
    assert isspmatrix_csr(actual)
    assert actual.shape == reference.shape
    np.testing.assert_allclose(actual.toarray(), reference, rtol=2e-8, atol=2e-8)
    assert np.array_equal(values, saved)
    # Dòng độ cong tại các góc đã khóa bị tắt ở cả residual và Jacobian.
    assert not np.any(actual[-count:].toarray()[~options[4]])


def test_closed_seam_data_depends_on_last_and_first_knots_only():
    values, _ = _fixture(5)
    options = (np.array([4]), np.array([.37]), np.ones(1), np.ones(5),
               np.ones(5, dtype=bool), np.ones(25, dtype=bool), np.zeros(5))
    matrix = jacobian_module.build_fair_jacobian(*options)(values, fair._decode(values, options[-1]))
    affected = set(matrix[:2].nonzero()[1] // 5)
    assert affected == {0, 4}
    affected_fair = set(matrix[2].nonzero()[1] // 5)
    assert affected_fair == {0, 1, 4}


@pytest.mark.parametrize("scale", [0., .8, 1.2])
def test_curvature_gradient_matches_both_sides_of_denominator_clamp(scale):
    threshold = 1e-20 ** (1 / 3)
    velocity = np.array([[.8, .6]]) * (threshold * scale)
    acceleration = np.array([[.3, 1.1]])
    analytic_v, analytic_a = jacobian_module._curvature_gradient(velocity, acceleration)
    point = np.r_[velocity[0], acceleration[0]]
    def curvature(candidate):
        v, a = candidate[:2], candidate[2:]
        return (v[0]*a[1]-v[1]*a[0])/max(np.linalg.norm(v)**3, 1e-20)
    steps = [threshold*1e-5, threshold*1e-5, 1e-5, 1e-5]
    reference = []
    for index, step in enumerate(steps):
        delta = np.zeros(4)
        delta[index] = step
        reference.append((curvature(point+delta)-curvature(point-delta))/(2*step))
    np.testing.assert_allclose(np.r_[analytic_v[0], analytic_a[0]], reference, rtol=2e-8, atol=1e-10)


def test_full_jacobian_remains_correct_with_handles_near_clamp():
    values, options = _fixture(5)
    values[:, :2] *= 1e-7
    threshold_handle = 1e-20 ** (1 / 3) / 3
    values[:, 3] = np.log(threshold_handle * np.array([.8, 1.2, .8, 1.2, .8]))
    values[:, 4] = np.log(threshold_handle * np.array([1.2, .8, 1.2, .8, 1.2]))
    free, angle_delta = options[-2:]
    point = values.ravel()[free]
    residual = _residual_for(values, options)
    analytic = jacobian_module.build_fair_jacobian(*options)(
        values, fair._decode(values, angle_delta)).toarray()
    for column, original in enumerate(np.flatnonzero(free)):
        step = 1e-13 if original % 5 < 2 else 1e-6
        delta = np.zeros_like(point)
        delta[column] = step
        reference = (residual(point+delta)-residual(point-delta))/(2*step)
        # Theo norm cột vì đạo hàm theo vị trí có thể đạt 1e14 ở ca này.
        error = np.max(np.abs(analytic[:, column]-reference))
        assert error / max(1., np.max(np.abs(reference))) < 2e-6


def test_solver_uses_analytic_jacobian_without_changing_iteration_or_error_policy(monkeypatch):
    import scipy.optimize

    values, _ = _fixture(4)
    angles = np.zeros(4)
    source = fair._decode(values, angles)
    points = fair._evaluate(source, np.arange(4), np.full(4, .5))
    calls = []
    def solver(residual, initial, **kwargs):
        assert callable(kwargs["jac"]) and "jac_sparsity" not in kwargs
        matrix = kwargs["jac"](initial)
        assert isspmatrix_csr(matrix) and matrix.shape == (len(residual(initial)), len(initial))
        calls.append(kwargs)
        return SimpleNamespace(x=initial)
    monkeypatch.setattr(scipy.optimize, "least_squares", solver)
    result = fair._optimize_seed(source, source, .1, (), points)
    assert result is not None and len(calls) == 5
    for call in calls:
        assert call["max_nfev"] == 35
        assert call["ftol"] == call["xtol"] == call["gtol"] == 1e-7
        assert call["method"] == "trf" and call["x_scale"] == "jac"


def _legacy_sparsity(indices, count, free):
    """Oracle của nhánh sai phân trước tối ưu; không dùng giá trị Jacobian mới."""
    knots = np.column_stack([indices, (indices+1) % count])
    cols = (knots[:, :, None]*5+np.arange(5)).reshape(len(indices), 10)
    rows = np.repeat(np.arange(2*len(indices)), 10)
    columns = np.repeat(cols, 2, axis=0).ravel()
    neighbours = np.column_stack([(np.arange(count)-1) % count,
                                  np.arange(count), (np.arange(count)+1) % count])
    fair_cols = (neighbours[:, :, None]*5+np.arange(5)).reshape(count, 15)
    rows = np.r_[rows, np.repeat(2*len(indices)+np.arange(count), 15)]
    columns = np.r_[columns, fair_cols.ravel()]
    return coo_matrix((np.ones(len(rows), dtype=np.int8), (rows, columns)),
                      shape=(2*len(indices)+count, count*5)).tocsr()[:, free]


PAGE12 = Path(__file__).resolve().parents[2] / "output/pdf/Binder2-page12-global-final-2026-09-10/Binder2_page12_offset2_B3.pdf"


@pytest.mark.skipif(not PAGE12.is_file(), reason="Artifact Binder2 trang 12 là corpus riêng")
def test_binder2_page12_keeps_65_nodes_and_original_solver_trajectory(monkeypatch):
    import pikepdf
    import scipy.optimize
    from test_sticker_engine_e2e import _parse_cut_machine_paths

    with pikepdf.Pdf.open(PAGE12) as document:
        paths = _parse_cut_machine_paths(document.pages[0])
    assert len(paths) == 1 and len(paths[0]) == 122
    source = np.array([(s.p0, s.p1, s.p2, s.p3) for s in paths[0]]) * (25.4 / 72)
    saved = source.copy()
    original_build = jacobian_module.build_fair_jacobian
    original_solve = scipy.optimize.least_squares
    state = {}
    def capture_pattern(indices, parameters, weights, fair_scale, smooth, free, angle_delta):
        state["pattern"] = _legacy_sparsity(indices, len(smooth), free)
        return original_build(indices, parameters, weights, fair_scale, smooth, free, angle_delta)
    def finite_difference(residual, initial, **kwargs):
        kwargs.pop("jac")
        return original_solve(residual, initial, jac_sparsity=state["pattern"], **kwargs)
    started = time.perf_counter()
    with monkeypatch.context() as legacy:
        legacy.setattr(jacobian_module, "build_fair_jacobian", capture_pattern)
        legacy.setattr(scipy.optimize, "least_squares", finite_difference)
        baseline, old_bound = fair.fair_refit_ring(source, .1)
    baseline_seconds = time.perf_counter()-started
    started = time.perf_counter()
    candidate, bound = fair.fair_refit_ring(source, .1)
    analytic_seconds = time.perf_counter()-started
    assert np.array_equal(source, saved)
    assert len(baseline) == len(candidate) == 65
    assert 0 < old_bound <= .1 and 0 < bound <= .1
    delta = float(np.linalg.norm(np.asarray(baseline)-candidate, axis=2).max())
    # Control hull chặn lệch cả quỹ đạo cùng tham số, không chỉ tại neo.
    assert delta <= 1e-4
    protected = source[list(fair.protected_corner_indices(source)), 0]
    assert verify_fair_ring(source, candidate, tolerance_mm=.1, protected_vertices=protected).accepted
    print({"baseline_seconds": baseline_seconds, "analytic_seconds": analytic_seconds,
           "nodes": len(candidate), "control_delta_mm": delta, "bound_mm": bound})
