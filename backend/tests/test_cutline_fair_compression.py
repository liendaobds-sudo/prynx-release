"""Nén trực giao giữ toàn bộ bài toán hình học, không bỏ mẫu/dung sai."""
from __future__ import annotations

import numpy as np
import pytest
from scipy.optimize._numdiff import approx_derivative

from app.workers import cutline_fair_jacobian as jac
from app.workers import cutline_fair_simplify as fair
from app.workers.cutline_preview_cancel import (
    PreviewCancellation, PreviewCancelled, cancellation_scope,
)


def _case(count, *, degenerate=False):
    rng = np.random.default_rng(20260927 + count)
    values = rng.normal(size=(count, 5))
    values[:, :2] *= 30
    indices = rng.integers(count, size=count * 83)
    parameters = np.full(len(indices), .37) if degenerate else rng.random(len(indices))
    weights = rng.uniform(.2, 4., len(indices))
    weights[::17] = 0
    target = rng.normal(size=(len(indices), 2)) * 20
    angles = rng.normal(size=count)
    return values, indices, parameters, weights, target, angles


@pytest.mark.parametrize("count", [1, 2, 5, 19])
@pytest.mark.parametrize("degenerate", [False, True])
def test_compression_preserves_cost_gradient_and_normal_matrix(count, degenerate):
    values, indices, t, weights, target, angles = _case(count, degenerate=degenerate)
    saved = [x.copy() for x in (indices, t, weights, target)]
    compact_indices, basis, projected = jac.compress_fair_samples(indices, t, weights, target)
    assert len(compact_indices) <= 6 * count < len(indices)
    free = np.ones(count * 5, dtype=bool)
    free[:3] = False
    smooth, strength = np.ones(count, dtype=bool), np.full(count, .3)
    old_jac = jac.build_fair_jacobian(indices, t, weights, strength, smooth, free, angles)
    new_jac = jac.build_fair_jacobian(compact_indices, None, None, strength, smooth,
                                     free, angles, weighted_basis=basis)
    for delta in (0., .15, -.7):
        state = values + delta
        curves = fair._decode(state, angles)
        curvature = strength * fair._curvature_jumps(curves)
        old = np.r_[((fair._evaluate(curves, indices, t) - target) * weights[:, None]).ravel(), curvature]
        new = np.r_[(np.einsum('ij,ijk->ik', basis, curves[compact_indices]) - projected).ravel(), curvature]
        a, b = old_jac(state, curves), new_jac(state, curves)
        np.testing.assert_allclose(new @ new, old @ old, rtol=2e-13, atol=1e-10)
        np.testing.assert_allclose(b.T @ new, a.T @ old, rtol=2e-11, atol=2e-9)
        np.testing.assert_allclose((b.T @ b).toarray(), (a.T @ a).toarray(), rtol=2e-11, atol=2e-9)
    for actual, expected in zip((indices, t, weights, target), saved):
        np.testing.assert_array_equal(actual, expected)


def test_compact_jacobian_matches_finite_difference_and_keeps_constant_error():
    values, indices, t, weights, target, angles = _case(5)
    compact_indices, basis, projected = jac.compress_fair_samples(indices, t, weights, target)
    free = np.ones(values.size, dtype=bool)
    strength, smooth = np.full(5, .3), np.ones(5, dtype=bool)
    build = jac.build_fair_jacobian(compact_indices, None, None, strength, smooth,
                                    free, angles, weighted_basis=basis)
    def residual(x):
        curves = fair._decode(x.reshape(-1, 5), angles)
        return np.r_[(np.einsum('ij,ijk->ik', basis, curves[compact_indices]) - projected).ravel(),
                     strength * fair._curvature_jumps(curves)]
    expected = approx_derivative(residual, values.ravel(), method="3-point")
    np.testing.assert_allclose(build(values, fair._decode(values, angles)).toarray(), expected,
                               rtol=3e-8, atol=3e-7)
    # Hai cột target phải ở trong QR: không được bỏ phần sai số vuông góc
    # với bốn Bernstein, vì cost/ftol của solver sẽ thay đổi.
    assert np.linalg.norm(projected[np.linalg.norm(basis, axis=1) < 1e-14]) > 1


def test_sparse_buckets_and_empty_input():
    indices = np.array([3, 1, 3])
    t, weights, target = np.array([0., .5, 1.]), np.ones(3), np.zeros((3, 2))
    idx, basis, projected = jac.compress_fair_samples(indices, t, weights, target)
    assert len(idx) == 3 and set(idx) == {1, 3}
    assert basis.shape == (3, 4) and projected.shape == (3, 2)
    idx, basis, projected = jac.compress_fair_samples(indices[:0], t[:0], weights[:0], target[:0])
    assert idx.shape == (0,) and basis.shape == (0, 4) and projected.shape == (0, 2)


def test_qr_failure_keeps_all_original_rows(monkeypatch):
    _, indices, t, weights, target, _ = _case(2)
    monkeypatch.setattr(np.linalg, "qr", lambda *a, **kw: (_ for _ in ()).throw(np.linalg.LinAlgError()))
    idx, basis, projected = jac.compress_fair_samples(indices, t, weights, target)
    assert len(idx) == len(indices)
    assert basis.shape == (len(indices), 4) and projected.shape == target.shape


def test_cancel_between_qr_blocks_stops_work(monkeypatch):
    _, indices, t, weights, target, _ = _case(5)
    token, calls = PreviewCancellation(), []
    original = np.linalg.qr
    def cancel(*args, **kwargs):
        calls.append(1)
        result = original(*args, **kwargs)
        token.cancel()
        return result
    monkeypatch.setattr(np.linalg, "qr", cancel)
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            jac.compress_fair_samples(indices, t, weights, target)
    finally:
        token.close()
    assert calls == [1]
