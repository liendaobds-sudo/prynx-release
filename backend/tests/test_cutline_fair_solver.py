"""Gộp operator CSR chỉ bỏ lớp điều phối, không đổi phép tính hay solver.

PERF (audit 2026-09-27 §CUT.FUSED): so bit float64 và nghiệm có ràng buộc;
giữ SciPy toàn cục nguyên vẹn kể cả khi hai tác vụ cùng chạy.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import partial
import importlib
from threading import Barrier
from types import SimpleNamespace

import numpy as np
import pytest
import scipy
import scipy.optimize
from scipy.optimize._lsq.common import (
    regularized_lsq_operator as scipy_regularized,
    right_multiplied_operator as scipy_scaled,
)
from scipy.sparse import csr_matrix, csc_matrix
from scipy.sparse.linalg import aslinearoperator, lsmr as scipy_lsmr

from app.workers import cutline_fair_solver as adapter
from app.workers.cutline_preview_cancel import (
    PreviewCancellation, PreviewCancelled, cancellation_scope, check_preview_cancelled,
)


@pytest.fixture(autouse=True)
def _keep_legacy_dispatch_explicit(monkeypatch):
    """Các chốt bit-parity lô fused vẫn chạy nhánh cũ khi đã có DLL mới."""
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", False, raising=False)


def _matrix(index_dtype, *, duplicate=False):
    if duplicate:
        # Giữ thứ tự cột và phần tử trùng thật; không gọi sum_duplicates/sort.
        data = np.array([1.3, -.4, .09, -2.3, .8, 0., 1.2, .6, -.91, .9, -3.])
        indices = np.array([3, 0, 3, 2, 1, 0, 1, 3, 2, 1, 0], dtype=index_dtype)
        indptr = np.array([0, 3, 3, 7, 9, 11], dtype=index_dtype)
        matrix = csr_matrix((data, indices, indptr), shape=(5, 4))
        assert not matrix.has_sorted_indices
    else:
        matrix = csr_matrix(np.array([
            [1.3, 0., -.4, .09], [0., 0., 0., 0.],
            [-2.3, .8, 0., 1.2], [.6, 0., -.91, 0.], [0., .9, 0., -3.],
        ]))
    # SciPy có thể tự downcast constructor; bài test phải thật sự phủ int64.
    matrix.indices = matrix.indices.astype(index_dtype)
    matrix.indptr = matrix.indptr.astype(index_dtype)
    return matrix


def _vector(count, *, strided=False):
    values = np.linspace(-2.3, 1.7, count)
    if not strided:
        return values
    storage = np.empty(count * 2)
    storage[::2] = values
    result = storage[::2]
    assert not result.flags.c_contiguous
    return result


def _assert_float64_bits(actual, expected):
    actual, expected = np.asarray(actual), np.asarray(expected)
    assert actual.dtype == expected.dtype == np.float64
    np.testing.assert_array_equal(actual.view(np.uint64), expected.view(np.uint64))


@pytest.mark.parametrize("index_dtype", [np.int32, np.int64])
@pytest.mark.parametrize("duplicate", [False, True])
@pytest.mark.parametrize("strided", [False, True])
@pytest.mark.parametrize("regularized", [False, True])
def test_fused_csr_products_match_original_float64_bits(index_dtype, duplicate, strided, regularized):
    matrix = _matrix(index_dtype, duplicate=duplicate)
    saved = tuple(array.copy() for array in (matrix.data, matrix.indices, matrix.indptr))
    scale = np.array([0., 1.4, -.7, 2.3])
    diagonal = np.array([.2, 0., .33, 1.2]) if regularized else None
    expected = scipy_scaled(matrix, scale)
    if regularized:
        expected = scipy_regularized(expected, diagonal)
    actual = adapter._FusedCsrOperator(matrix, scale, diagonal)
    assert actual.shape == expected.shape
    _assert_float64_bits(actual.matvec(_vector(actual.shape[1], strided=strided)),
                         expected.matvec(_vector(expected.shape[1], strided=strided)))
    _assert_float64_bits(actual.rmatvec(_vector(actual.shape[0], strided=strided)),
                         expected.rmatvec(_vector(expected.shape[0], strided=strided)))
    for current, original in zip((matrix.data, matrix.indices, matrix.indptr), saved):
        np.testing.assert_array_equal(current, original)


def test_scaled_matmat_and_return_buffers_do_not_alias():
    matrix = _matrix(np.int64, duplicate=True)
    scale = np.array([.7, 2.3, .9, 1.4])
    values = np.arange(24, dtype=np.float64).reshape(4, 6)[:, ::2]
    actual, expected = adapter._FusedCsrOperator(matrix, scale), scipy_scaled(matrix, scale)
    _assert_float64_bits(actual.matmat(values), expected.matmat(values))
    x = np.array([.3, -.2, 1.7, 8.])
    first = actual.matvec(x)
    first[:] = 1e100
    _assert_float64_bits(actual.matvec(x), expected.matvec(x))
    reverse = actual.rmatvec(np.arange(5, dtype=np.float64))
    reverse[:] = 1e100
    _assert_float64_bits(actual.rmatvec(np.arange(5, dtype=np.float64)),
                         expected.rmatvec(np.arange(5, dtype=np.float64)))


def test_supported_operator_builders_choose_fused_and_keep_regularization():
    matrix = _matrix(np.int32)
    scale, diagonal = np.full(4, .7), np.arange(4, dtype=np.float64) * .13
    scaled = adapter._right_multiplied_operator(matrix, scale)
    actual = adapter._regularized_lsq_operator(scaled, diagonal)
    assert isinstance(scaled, adapter._FusedCsrOperator)
    assert isinstance(actual, adapter._FusedCsrOperator)
    expected = scipy_regularized(scipy_scaled(matrix, scale), diagonal)
    _assert_float64_bits(actual.matvec(_vector(4)), expected.matvec(_vector(4)))
    _assert_float64_bits(actual.rmatvec(_vector(9)), expected.rmatvec(_vector(9)))


@pytest.mark.parametrize("kind", ["dense", "csc", "float32", "complex", "float32-scale"])
def test_unsupported_operator_inputs_use_original_builder(kind):
    matrix = _matrix(np.int32)
    scale = np.full(4, .7)
    if kind == "dense":
        matrix = matrix.toarray()
    elif kind == "csc":
        matrix = csc_matrix(matrix)
    elif kind == "float32":
        matrix = matrix.astype(np.float32)
    elif kind == "complex":
        matrix = matrix.astype(np.complex128) * (1 + .2j)
    else:
        scale = scale.astype(np.float32)
    actual = adapter._right_multiplied_operator(matrix, scale)
    expected = scipy_scaled(matrix, scale)
    assert not isinstance(actual, adapter._FusedCsrOperator)
    np.testing.assert_array_equal(actual.matvec(_vector(4)), expected.matvec(_vector(4)))
    np.testing.assert_array_equal(actual.rmatvec(_vector(5)), expected.rmatvec(_vector(5)))


def test_regularization_of_other_operator_keeps_original_semantics():
    matrix = _matrix(np.int32)
    scale, diagonal = np.full(4, .7), np.arange(4, dtype=np.float64) * .13
    original = aslinearoperator(matrix)
    actual, expected = adapter._regularized_lsq_operator(original, diagonal), scipy_regularized(original, diagonal)
    assert not isinstance(actual, adapter._FusedCsrOperator)
    _assert_float64_bits(actual.rmatvec(_vector(9)), expected.rmatvec(_vector(9)))
    # Không được bỏ lớp diagonal đầu khi caller đã có một operator regularized.
    prior = adapter._FusedCsrOperator(matrix, scale, diagonal)
    actual, expected = adapter._regularized_lsq_operator(prior, diagonal), scipy_regularized(prior, diagonal)
    _assert_float64_bits(actual.matvec(_vector(4)), expected.matvec(_vector(4)))
    _assert_float64_bits(actual.rmatvec(_vector(13)), expected.rmatvec(_vector(13)))


@pytest.mark.parametrize("dtype", [np.float32, np.int64, np.complex128])
def test_non_float64_vectors_use_supported_scipy_products(dtype):
    matrix, scale, diagonal = _matrix(np.int32), np.full(4, .7), np.full(4, .2)
    actual = adapter._FusedCsrOperator(matrix, scale, diagonal)
    expected = scipy_regularized(scipy_scaled(matrix, scale), diagonal)
    forward = _vector(4).astype(dtype)
    reverse = _vector(9).astype(dtype)
    if dtype == np.complex128:
        forward += .2j
        reverse -= .3j
    np.testing.assert_array_equal(actual.matvec(forward), expected.matvec(forward))
    np.testing.assert_array_equal(actual.rmatvec(reverse), expected.rmatvec(reverse))


@pytest.mark.parametrize("shape", [(5, 4), (0, 4), (5, 0)])
def test_empty_csr_keeps_zero_products_and_regularization(shape):
    matrix = csr_matrix(shape, dtype=np.float64)
    scale, diagonal = np.ones(shape[1]), np.full(shape[1], .2)
    actual = adapter._FusedCsrOperator(matrix, scale, diagonal)
    expected = scipy_regularized(scipy_scaled(matrix, scale), diagonal)
    _assert_float64_bits(actual.matvec(np.ones(shape[1])), expected.matvec(np.ones(shape[1])))
    reverse = np.ones(sum(shape))
    _assert_float64_bits(actual.rmatvec(reverse), expected.rmatvec(reverse))
    assert actual.matmat(np.empty((shape[1], 0))).shape == (sum(shape), 0)


@pytest.mark.parametrize("malformation", [
    "data-length", "pointer-length", "pointer-order", "index-dtype", "negative-index",
    "past-last-column", "strided-data",
])
def test_invalid_or_unsupported_csr_never_enters_unchecked_kernel(monkeypatch, malformation):
    matrix = _matrix(np.int32)
    if malformation == "data-length":
        matrix.data = matrix.data[:-1]
    elif malformation == "pointer-length":
        matrix.indptr = matrix.indptr[:-1]
    elif malformation == "pointer-order":
        matrix.indptr[2] = matrix.indptr[1] - 1
    elif malformation == "index-dtype":
        matrix.indices = matrix.indices.astype(np.int64)
    elif malformation == "negative-index":
        matrix.indices[0] = -1
    elif malformation == "past-last-column":
        matrix.indices[0] = matrix.shape[1]
    else:
        storage = np.empty(matrix.data.size * 2)
        storage[::2] = matrix.data
        matrix.data = storage[::2]
    sentinel, calls = object(), []
    def fallback(received, scale):
        calls.append(received)
        return sentinel
    # Không đưa CSR cố ý hỏng vào bất kỳ kernel C nào, kể cả nhánh SciPy cũ.
    monkeypatch.setattr(adapter, "_original_right", fallback)
    assert adapter._right_multiplied_operator(matrix, np.ones(4)) is sentinel
    assert calls == [matrix]


def _problem():
    matrix = np.array([
        [1., .4, 0., -.2], [-.3, 1.3, .6, 0.], [.2, 0., 1.1, -.4],
        [.6, .5, -.3, 1.2], [1.1, -.7, .9, 0.], [0., .8, -.5, .3],
        [.2, -.1, .4, .7], [.5, .9, 0., -.8], [-.2, .4, .6, 1.1],
    ])
    target_x = np.array([1.1, -1.4, .9, -.8])
    target = matrix @ (target_x + .05 * target_x**2)
    def residual(x):
        return matrix @ (x + .05 * x**2) - target
    def jacobian(x):
        return csr_matrix(matrix * (1 + .1 * x)[None, :])
    return residual, jacobian


def _solve(solver, *, first_evaluation=None):
    residual, jacobian = _problem()
    calls = 0
    def wrapped(x):
        nonlocal calls
        calls += 1
        if first_evaluation is not None:
            first_evaluation(calls)
        return residual(x)
    return solver(wrapped, np.array([0., 0., .5, -.1]), jac=jacobian,
                  bounds=([- .5, -1., .1, -2.], [.4, 2., 1.8, .2]),
                  method="trf", x_scale="jac", ftol=1e-10, xtol=1e-10,
                  gtol=1e-10, max_nfev=35)


def _assert_same_solution(actual, expected):
    _assert_float64_bits(actual.x, expected.x)
    _assert_float64_bits(actual.fun, expected.fun)
    assert actual.cost == expected.cost
    assert actual.optimality == expected.optimality
    assert (actual.nfev, actual.njev, actual.status, actual.success) == (
        expected.nfev, expected.njev, expected.status, expected.success,
    )


def _global_identities():
    trf = importlib.import_module("scipy.optimize._lsq.trf")
    return (
        scipy.optimize.least_squares, scipy.optimize.least_squares.__globals__["trf"],
        trf.trf, trf.trf_bounds, trf.trf_no_bounds,
        trf.right_multiplied_operator, trf.regularized_lsq_operator,
    )


def test_bounded_least_squares_preserves_solution_cost_and_evaluation_counts():
    original = scipy.optimize.least_squares
    before = _global_identities()
    fused = adapter.resolve_fair_least_squares(original)
    assert fused is not original
    _assert_same_solution(_solve(fused), _solve(original))
    assert all(a is b for a, b in zip(_global_identities(), before))
    status = adapter.fused_solver_status()
    assert isinstance(status, dict) and {"backend", "reason"} <= status.keys()


def test_regular_and_fused_solvers_can_run_concurrently_without_global_mutation():
    original = scipy.optimize.least_squares
    fused = adapter.resolve_fair_least_squares(original)
    before, rendezvous = _global_identities(), Barrier(2)
    def checkpoint(count):
        assert all(a is b for a, b in zip(_global_identities(), before))
        if count == 1:
            rendezvous.wait(timeout=10)
    with ThreadPoolExecutor(max_workers=2) as pool:
        ordinary = pool.submit(_solve, original, first_evaluation=checkpoint)
        combined = pool.submit(_solve, fused, first_evaluation=checkpoint)
        _assert_same_solution(combined.result(timeout=15), ordinary.result(timeout=15))
    assert all(a is b for a, b in zip(_global_identities(), before))


@pytest.mark.parametrize("stub", [lambda *args, **kwargs: None, len, object()])
def test_resolver_keeps_unknown_or_compiled_callables_unchanged(stub):
    assert adapter.resolve_fair_least_squares(stub) is stub


def test_unsupported_scipy_version_falls_back_without_changing_global_solver(monkeypatch):
    original, before = scipy.optimize.least_squares, _global_identities()
    monkeypatch.setattr(scipy, "__version__", "0.0-unsupported-test")
    assert adapter.resolve_fair_least_squares(original) is original
    assert all(a is b for a, b in zip(_global_identities(), before))


@pytest.mark.parametrize("dependency", [None, SimpleNamespace(csr_matvec=None, csc_matvec=None)])
def test_unavailable_native_kernel_preserves_original_solver(monkeypatch, dependency):
    original, before = scipy.optimize.least_squares, _global_identities()
    monkeypatch.setattr(adapter, "_sparsetools", dependency)
    assert adapter.resolve_fair_least_squares(original) is original
    status = adapter.fused_solver_status()
    assert status["backend"] == "scipy-default"
    assert status["reason"] == "csr-kernel-unavailable"
    assert all(a is b for a, b in zip(_global_identities(), before))


def test_unavailable_solver_dependency_preserves_original_solver(monkeypatch):
    original = scipy.optimize.least_squares
    def unavailable(solver):
        raise ImportError("Môi trường không có graph SciPy Python đã kiểm.")
    # Nuitka được phép tối ưu import có tên hằng, nên monkeypatch importlib
    # không mô phỏng thiếu dependency đáng tin. Tiêm lỗi tại cổng capability
    # chung cho source/binary để chốt đúng hành vi fallback của resolver.
    monkeypatch.setattr(adapter, "_capability", unavailable)
    assert adapter.resolve_fair_least_squares(original) is original


def test_adapter_creation_failure_reports_real_fallback_in_status_and_log(monkeypatch, caplog):
    """Capability đạt nhưng dựng clone lỗi không được báo đã chạy fused."""
    original = scipy.optimize.least_squares
    def unavailable(*args):
        raise TypeError("Không dựng được adapter Python trong runtime này.")
    monkeypatch.setattr(adapter, "_isolated_solver", unavailable)
    adapter._report_backend.cache_clear()
    try:
        with caplog.at_level("INFO", logger=adapter.__name__):
            assert adapter.resolve_fair_least_squares(original) is original
            status = adapter.fused_solver_status()
        assert status["backend"] == "scipy-default"
        assert status["reason"] == "solver-adapter-unavailable"
        messages = [record.getMessage() for record in caplog.records if record.name == adapter.__name__]
        assert any("backend=scipy-default reason=solver-adapter-unavailable" in text for text in messages)
        assert not any("backend=fused-csr" in text for text in messages)
    finally:
        adapter._report_backend.cache_clear()


@pytest.mark.parametrize("metadata", ["__compiled__", "__wrapped__"])
def test_compiled_or_wrapped_runtime_metadata_does_not_build_python_clone(monkeypatch, metadata):
    original = scipy.optimize.least_squares
    monkeypatch.setattr(original, metadata, object(), raising=False)
    assert adapter.resolve_fair_least_squares(original) is original


def test_changed_scipy_wiring_declines_previously_cached_clone(monkeypatch):
    original = scipy.optimize.least_squares
    assert adapter.resolve_fair_least_squares(original) is not original
    trf = importlib.import_module("scipy.optimize._lsq.trf")
    monkeypatch.setattr(trf, "right_multiplied_operator", lambda *args: None)
    assert adapter.resolve_fair_least_squares(original) is original


@pytest.mark.parametrize("path", ["unbounded", "dogbox", "lm", "dense-bounded"])
def test_other_scipy_solver_paths_never_construct_fused_operator(monkeypatch, path):
    original = scipy.optimize.least_squares
    fused = adapter.resolve_fair_least_squares(original)
    constructions = []
    initialize = adapter._FusedCsrOperator.__init__
    def observe(self, *args, **kwargs):
        constructions.append(1)
        initialize(self, *args, **kwargs)
    monkeypatch.setattr(adapter._FusedCsrOperator, "__init__", observe)
    residual, sparse_jacobian = _problem()
    jacobian = (lambda x: sparse_jacobian(x).toarray()) if path in {"lm", "dense-bounded"} else sparse_jacobian
    method = path if path in {"lm", "dogbox"} else "trf"
    bounds = (-np.inf, np.inf) if path in {"unbounded", "lm"} else (-2., 2.)
    options = dict(jac=jacobian, method=method, bounds=bounds, x_scale="jac", max_nfev=35)
    x0 = np.array([0., 0., .5, -.1])
    actual, expected = fused(residual, x0, **options), original(residual, x0, **options)
    _assert_same_solution(actual, expected)
    assert constructions == []


def test_cancellation_from_residual_propagates_without_solver_replay():
    fused = adapter.resolve_fair_least_squares(scipy.optimize.least_squares)
    token, evaluations = PreviewCancellation(), []
    def checkpoint(count):
        evaluations.append(count)
        if count == 2:
            token.cancel()
        check_preview_cancelled()
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            _solve(fused, first_evaluation=checkpoint)
    finally:
        token.close()
    assert evaluations == [1, 2]


def test_user_residual_error_is_not_swallowed_by_dependency_fallback():
    fused = adapter.resolve_fair_least_squares(scipy.optimize.least_squares)
    evaluations = []
    def checkpoint(count):
        evaluations.append(count)
        raise ValueError("Lỗi residual chủ ý để kiểm không chạy lại solver.")
    with pytest.raises(ValueError, match="Lỗi residual"):
        _solve(fused, first_evaluation=checkpoint)
    assert evaluations == [1]


@pytest.fixture(scope="module")
def native_lsmr_module():
    try:
        module = importlib.import_module("pdfcompare_native")
    except ImportError:
        pytest.skip("Chưa có extension pdfcompare_native trong môi trường này.")
    if not callable(getattr(module, "cutline_lsmr", None)):
        pytest.skip("Extension đang nạp chưa có binding cutline_lsmr; cần build/stage mới.")
    assert callable(getattr(module, "cutline_lsmr_version", None))
    assert module.cutline_lsmr_version() == 2
    return module


@pytest.fixture(scope="module")
def real_numpy_norm_provider(native_lsmr_module):
    """Không skip cổng số học: binding mới thiếu norm đã kiểm phải báo đỏ."""
    provider = adapter._numpy_norm_provider()
    assert provider is np.linalg.norm, "Phải dùng callback NumPy an toàn, không FFI con trỏ DLL."
    return provider


def _native_case(kind="full"):
    matrix = _matrix(np.int64, duplicate=True)
    scale, diagonal = np.array([.75, 1.25, .95, 1.8]), np.array([.2, .1, .3, .15])
    if kind == "rank-deficient":
        matrix = csr_matrix(np.array([
            [1., 2., 0., 0.], [0., 0., 1., 2.], [1., 2., 1., 2.],
            [2., 4., -1., -2.], [0., 0., 0., 0.],
        ]))
        scale, diagonal = np.ones(4), np.zeros(4)
    elif kind == "ill-conditioned":
        matrix = csr_matrix(np.diag([1., 1e-2, 1e-4, 1e-6]))
        scale, diagonal = np.ones(4), np.zeros(4)
    elif kind == "zero-matrix":
        matrix = csr_matrix((5, 4), dtype=np.float64)
        diagonal = np.zeros(4)
    rhs = np.linspace(-1.3, 2.4, matrix.shape[0] + matrix.shape[1])
    if kind == "zero-rhs":
        rhs[:] = 0.0
    return matrix, scale, diagonal, rhs


def _native_payload(matrix, scale, diagonal, rhs):
    return dict(data=matrix.data.copy(), indices=matrix.indices.astype(np.int64),
                indptr=matrix.indptr.astype(np.int64), rows=matrix.shape[0], cols=matrix.shape[1],
                scale=scale.copy(), diagonal=diagonal.copy(), rhs=rhs.copy())


def _assert_native_lsmr_result(actual, expected):
    assert len(actual) == len(expected) == 8
    # LSMR Rust không gọi BLAS nrm2 của wheel SciPy: chốt sai số số học chặt,
    # không đòi bit-exact cho phép chuẩn hóa; nguyên nhân dừng/số vòng giữ nguyên.
    np.testing.assert_allclose(actual[0], expected[0], rtol=1e-10, atol=5e-12)
    assert tuple(actual[1:3]) == tuple(expected[1:3])
    np.testing.assert_allclose(actual[3:], expected[3:], rtol=1e-10, atol=5e-12)


@pytest.mark.parametrize("kind", ["full", "rank-deficient", "ill-conditioned", "zero-matrix", "zero-rhs"])
@pytest.mark.parametrize("damp", [0.0, 0.4])
def test_native_lsmr_matches_scipy_solution_and_all_statistics(native_lsmr_module, kind, damp):
    """Nhánh norm Rust độc lập chỉ để chẩn đoán; production bắt buộc provider."""
    matrix, scale, diagonal, rhs = _native_case(kind)
    options = dict(damp=damp, atol=1e-12, btol=1e-12, conlim=1e12, maxiter=40)
    expected = scipy_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs, **options)
    actual = native_lsmr_module.cutline_lsmr(**_native_payload(matrix, scale, diagonal, rhs), **options)
    _assert_native_lsmr_result(actual, expected)


@pytest.mark.parametrize("maxiter", [None, 0, 1, 3])
def test_native_lsmr_honours_default_and_explicit_iteration_contract(native_lsmr_module, maxiter):
    matrix, scale, diagonal, rhs = _native_case()
    options = dict(damp=.2, atol=1e-12, btol=1e-12, conlim=1e12, maxiter=maxiter)
    expected = scipy_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs, **options)
    actual = native_lsmr_module.cutline_lsmr(**_native_payload(matrix, scale, diagonal, rhs), **options)
    _assert_native_lsmr_result(actual, expected)


def test_native_lsmr_accepts_strided_readonly_inputs_without_mutation(native_lsmr_module):
    matrix, scale, diagonal, rhs = _native_case()
    payload = _native_payload(matrix, scale, diagonal, rhs)
    saved = {}
    for key in ("data", "indices", "indptr", "scale", "diagonal", "rhs"):
        values = payload[key]
        storage = np.empty(values.size * 2, dtype=values.dtype)
        storage[::2] = values
        payload[key] = storage[::2]
        payload[key].setflags(write=False)
        saved[key] = values.copy()
    expected = scipy_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs)
    actual = native_lsmr_module.cutline_lsmr(**payload)
    _assert_native_lsmr_result(actual, expected)
    for key, before in saved.items():
        np.testing.assert_array_equal(payload[key], before)


@pytest.mark.parametrize("invalid", [
    "data-length", "pointer-length", "pointer-start", "pointer-end", "pointer-order",
    "negative-index", "past-last-column", "scale-length", "diagonal-length", "rhs-length",
    "nan-data", "nan-rhs", "infinite-scale",
])
def test_native_lsmr_rejects_invalid_buffers_before_kernel(native_lsmr_module, invalid):
    payload = _native_payload(*_native_case())
    if invalid == "data-length":
        payload["data"] = payload["data"][:-1]
    elif invalid == "pointer-length":
        payload["indptr"] = payload["indptr"][:-1]
    elif invalid == "pointer-start":
        payload["indptr"][0] = 1
    elif invalid == "pointer-end":
        payload["indptr"][-1] += 1
    elif invalid == "pointer-order":
        payload["indptr"][2] = payload["indptr"][1] - 1
    elif invalid == "negative-index":
        payload["indices"][0] = -1
    elif invalid == "past-last-column":
        payload["indices"][0] = payload["cols"]
    elif invalid.endswith("-length"):
        key = invalid.removesuffix("-length")
        payload[key] = payload[key][:-1]
    elif invalid == "nan-data":
        payload["data"][0] = np.nan
    elif invalid == "nan-rhs":
        payload["rhs"][0] = np.nan
    else:
        payload["scale"][0] = np.inf
    with pytest.raises(ValueError):
        native_lsmr_module.cutline_lsmr(**payload)


@pytest.mark.parametrize("cancel_at", [1, 2, 3])
def test_native_lsmr_propagates_original_cancellation(native_lsmr_module, cancel_at):
    case, options = _native_case(), dict(maxiter=40)
    if cancel_at == 3:
        # Native kiểm hủy trước/sau solve và mỗi 16 vòng. Bài toán 4 biến
        # kết thúc trước checkpoint giữa vòng, nên phải dùng phổ 40 trị riêng
        # và xác nhận thật sự cần >=32 vòng, không giả định callback mỗi vòng.
        matrix = csr_matrix(np.diag(np.geomspace(1., 1e-4, 40)))
        case = matrix, np.ones(40), np.zeros(40), np.linspace(-1.3, 2.4, 80)
        options = dict(maxiter=64, atol=0., btol=0., conlim=0.)
        reference = scipy_lsmr(adapter._FusedCsrOperator(*case[:3]), case[3], **options)
        assert reference[2] >= 32
    calls = []
    cancelled = PreviewCancelled("Hủy LSMR native giữa vòng lặp.")
    def cancel():
        calls.append(1)
        if len(calls) == cancel_at:
            raise cancelled
    with pytest.raises(PreviewCancelled) as raised:
        native_lsmr_module.cutline_lsmr(**_native_payload(*case), **options, cancel=cancel)
    assert raised.value is cancelled
    assert len(calls) == cancel_at


def test_static_trf_with_python_lsmr_preserves_exact_solver_state(monkeypatch):
    calls = []
    def reference_lsmr(operator, rhs, **options):
        calls.append(operator.shape)
        return scipy_lsmr(operator, rhs, **options)
    monkeypatch.setattr(adapter, "_native_lsmr", reference_lsmr)
    private = partial(adapter.native_fair_least_squares, scipy.optimize.least_squares)
    before = _global_identities()
    _assert_same_solution(_solve(private), _solve(scipy.optimize.least_squares))
    assert calls, "Test phải thật sự qua TRF riêng, không âm thầm fallback public solver."
    assert all(a is b for a, b in zip(_global_identities(), before))


@pytest.mark.parametrize("jacobian_kind", ["dense", "float32", "csc"])
def test_static_trf_reuses_initial_callbacks_for_unsupported_jacobian(monkeypatch, jacobian_kind):
    monkeypatch.setattr(adapter, "_native_lsmr", scipy_lsmr)
    records = []
    solutions = []
    for solver in (scipy.optimize.least_squares,
                   partial(adapter.native_fair_least_squares, scipy.optimize.least_squares)):
        calls = []
        residual, sparse_jacobian = _problem()
        def fun(x):
            calls.append(("fun", x.copy()))
            return residual(x)
        def jac(x):
            calls.append(("jac", x.copy()))
            matrix = sparse_jacobian(x)
            if jacobian_kind == "dense":
                return matrix.toarray()
            if jacobian_kind == "float32":
                return matrix.astype(np.float32)
            return matrix.tocsc()
        solutions.append(solver(fun, np.array([0., 0., .5, -.1]), jac=jac,
                                bounds=(-2., 2.), method="trf", x_scale="jac", max_nfev=35))
        records.append(calls)
    _assert_same_solution(solutions[1], solutions[0])
    assert [kind for kind, _x in records[1]] == [kind for kind, _x in records[0]]
    for (_kind, actual), (_other, expected) in zip(records[1], records[0]):
        _assert_float64_bits(actual, expected)


@pytest.mark.parametrize("unsupported", [{"method": "dogbox"}, {"loss": "soft_l1"}, {"jac": "2-point"}])
def test_static_trf_unsupported_options_delegate_before_callbacks(unsupported):
    calls, sentinel = [], object()
    def original(*args, **options):
        calls.append(options)
        return sentinel
    def callback(*args):
        pytest.fail("Không được chạy callback trước khi fallback tham số ngoài contract.")
    options = dict(jac=callback, x_scale="jac", bounds=(-2., 2.))
    options.update(unsupported)
    assert adapter.native_fair_least_squares(original, callback, np.zeros(4), **options) is sentinel
    assert calls == [options]


@pytest.mark.parametrize("bounded", [True, False])
def test_static_trf_never_replays_residual_error_during_delegation(monkeypatch, bounded):
    monkeypatch.setattr(adapter, "_native_lsmr", scipy_lsmr)
    calls = []
    def residual(x):
        calls.append(x.copy())
        raise ValueError("Residual lỗi phải truyền nguyên, không gọi lại.")
    bounds = (-2., 2.) if bounded else (-np.inf, np.inf)
    with pytest.raises(ValueError, match="Residual lỗi"):
        adapter.native_fair_least_squares(
            scipy.optimize.least_squares, residual, np.zeros(4),
            jac=lambda x: csr_matrix(np.eye(4)), x_scale="jac", bounds=bounds,
        )
    assert len(calls) == 1


def test_static_trf_preserves_cancellation_without_replay(monkeypatch):
    monkeypatch.setattr(adapter, "_native_lsmr", scipy_lsmr)
    private = partial(adapter.native_fair_least_squares, scipy.optimize.least_squares)
    token, calls = PreviewCancellation(), []
    def cancel(count):
        calls.append(count)
        if count == 2:
            token.cancel()
        check_preview_cancelled()
    try:
        with cancellation_scope(token), pytest.raises(PreviewCancelled):
            _solve(private, first_evaluation=cancel)
    finally:
        token.close()
    assert calls == [1, 2]


def test_native_dispatch_is_opt_in_and_reports_verified_backend(monkeypatch):
    module = SimpleNamespace(cutline_lsmr_version=lambda: 2, cutline_lsmr=lambda *args, **kwargs: None)
    monkeypatch.setattr(adapter, "_native_module", lambda: module)
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: object())
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", True)
    selected = adapter.resolve_fair_least_squares(scipy.optimize.least_squares)
    assert selected is not scipy.optimize.least_squares
    assert adapter.fused_solver_status()["backend"] == "native-lsmr"
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", False)
    assert adapter.fused_solver_status()["backend"] == "fused-csr"


@pytest.mark.parametrize("unsupported", [{"method": "dogbox"}, {"loss": "soft_l1"}])
@pytest.mark.parametrize("exception_type", [ValueError, PreviewCancelled])
def test_static_trf_unsupported_options_preserve_callback_error_once(unsupported, exception_type):
    calls, failure = [], exception_type("Callback không được phát lại khi fallback.")
    def residual(x):
        calls.append(x.copy())
        raise failure
    options = dict(jac=lambda x: csr_matrix(np.eye(4)), x_scale="jac", bounds=(-2., 2.))
    options.update(unsupported)
    with pytest.raises(exception_type) as raised:
        adapter.native_fair_least_squares(scipy.optimize.least_squares, residual, np.zeros(4), **options)
    assert raised.value is failure
    assert len(calls) == 1


def test_native_static_dispatch_does_not_require_compiled_solver_python_code(monkeypatch):
    original = scipy.optimize.least_squares
    module = SimpleNamespace(cutline_lsmr_version=lambda: 2, cutline_lsmr=lambda *args, **kwargs: None)
    monkeypatch.setattr(adapter, "_native_module", lambda: module)
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: object())
    monkeypatch.setattr(original, "__compiled__", object(), raising=False)
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", True)
    def forbid_clone(*args, **kwargs):
        pytest.fail("Nhánh native tĩnh không được dựng Python function từ code Nuitka.")
    monkeypatch.setattr(adapter, "_clone", forbid_clone)
    selected = adapter.resolve_fair_least_squares(original)
    assert selected is not original
    assert getattr(selected, "_prynx_backend", None) == "native-lsmr"
    assert adapter.fused_solver_status()["backend"] == "native-lsmr"
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", False)
    assert adapter.resolve_fair_least_squares(original) is original
    assert adapter.fused_solver_status()["backend"] == "scipy-default"


@pytest.mark.parametrize("unsupported", [
    {"maxiter": 10.0}, {"maxiter": 10.5}, {"maxiter": -1},
    {"conlim": -1.0}, {"conlim": np.inf}, {"conlim": np.nan},
    {"atol": -1e-6}, {"atol": np.nan}, {"btol": -1e-6}, {"btol": np.inf},
    {"damp": -.5}, {"damp": np.nan}, {"damp": np.inf},
])
def test_native_lsmr_unsupported_option_values_fall_back_before_rust(monkeypatch, unsupported):
    """Tùy chọn Python chấp nhận không được lọt vào API usize/finite của Rust."""
    sentinel, calls = object(), []
    matrix, scale, diagonal, rhs = _native_case()
    operator = adapter._FusedCsrOperator(matrix, scale, diagonal)
    def forbidden_native(*args, **options):
        pytest.fail("Tùy chọn ngoài contract native phải fallback trước khi gọi Rust.")
    def scipy_fallback(received, values, **options):
        assert received is operator and values is rhs
        calls.append(options)
        return sentinel
    monkeypatch.setattr(adapter, "_native_module", lambda: SimpleNamespace(cutline_lsmr=forbidden_native))
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: object())
    monkeypatch.setattr("scipy.sparse.linalg.lsmr", scipy_fallback)
    assert adapter._native_lsmr(operator, rhs, **unsupported) is sentinel
    assert len(calls) == 1 and calls[0].keys() == unsupported.keys()
    for key, value in unsupported.items():
        # NaN không so ==; chính object tùy chọn phải được chuyển nguyên vẹn.
        assert calls[0][key] is value


@pytest.mark.parametrize("options", [{}, {"maxiter": 0}, {"maxiter": 10},
                                      {"atol": 0., "btol": 0., "conlim": 0., "damp": 0.}])
def test_native_lsmr_supported_option_values_still_reach_rust(monkeypatch, options):
    sentinel, calls, provider = object(), [], object()
    matrix, scale, diagonal, rhs = _native_case()
    def native(*args, **received):
        calls.append(received)
        return sentinel
    def forbidden_scipy(*args, **kwargs):
        pytest.fail("Không được vô hiệu hóa nhánh native với tham số hợp lệ.")
    monkeypatch.setattr(adapter, "_native_module", lambda: SimpleNamespace(cutline_lsmr=native))
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: provider)
    monkeypatch.setattr("scipy.sparse.linalg.lsmr", forbidden_scipy)
    assert adapter._native_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs, **options) is sentinel
    assert len(calls) == 1
    assert calls[0]["norm_provider"] is provider
    for key, value in options.items():
        assert calls[0][key] == value


@pytest.mark.parametrize("exception_type", [ValueError, PreviewCancelled])
def test_native_lsmr_runtime_error_is_not_retried_with_python(monkeypatch, exception_type):
    failure, calls = exception_type("Lỗi native phải truyền nguyên, không chạy lại."), []
    def native(*args, **options):
        calls.append(1)
        raise failure
    def forbidden_scipy(*args, **kwargs):
        pytest.fail("Không được chạy lại LSMR Python sau lỗi/hủy trong Rust.")
    monkeypatch.setattr(adapter, "_native_module", lambda: SimpleNamespace(cutline_lsmr=native))
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: object())
    monkeypatch.setattr("scipy.sparse.linalg.lsmr", forbidden_scipy)
    matrix, scale, diagonal, rhs = _native_case()
    with pytest.raises(exception_type) as raised:
        adapter._native_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs)
    assert raised.value is failure
    assert calls == [1]


@pytest.mark.parametrize("kind", ["normal", "boundary", "rank-deficient"])
def test_static_trf_really_uses_native_lsmr_and_preserves_bounded_solution(native_lsmr_module, real_numpy_norm_provider, monkeypatch, kind):
    """Nghiệm TRF hoàn chỉnh phải qua Rust thật, không chỉ kiểm riêng kernel."""
    residual, jacobian = _problem()
    bounds = (-2., 2.)
    if kind == "boundary":
        bounds = ([-.5, -1., .1, -2.], [.4, 2., 1.8, .2])
    elif kind == "rank-deficient":
        matrix = np.array([
            [1., 2., 0., 0.], [0., 0., 1., 2.], [1., 2., 1., 2.],
            [2., 4., -1., -2.], [0., 0., 0., 0.],
        ])
        target = matrix @ np.array([.2, -.3, .4, -.2])
        def residual(x):
            return matrix @ (x + .05 * x**2) - target
        def jacobian(x):
            return csr_matrix(matrix * (1 + .1 * x)[None, :])
    options = dict(jac=jacobian, bounds=bounds, method="trf", x_scale="jac",
                   ftol=1e-10, xtol=1e-10, gtol=1e-10, max_nfev=35)
    x0 = np.array([0., 0., .5, -.1])
    expected = scipy.optimize.least_squares(residual, x0, **options)
    calls = []
    native = native_lsmr_module.cutline_lsmr
    def observed_native(*args, **kwargs):
        assert kwargs["norm_provider"] is real_numpy_norm_provider
        calls.append(1)
        return native(*args, **kwargs)
    monkeypatch.setattr(native_lsmr_module, "cutline_lsmr", observed_native)
    monkeypatch.setattr(adapter, "_native_module", lambda: native_lsmr_module)
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: real_numpy_norm_provider)
    identities = _global_identities()
    actual = adapter.native_fair_least_squares(scipy.optimize.least_squares, residual, x0, **options)
    assert calls, "TRF native không được âm thầm chạy toàn bộ bằng Python LSMR."
    _assert_same_solution(actual, expected)
    _assert_float64_bits(actual.grad, expected.grad)
    np.testing.assert_array_equal(actual.active_mask, expected.active_mask)
    assert np.all(actual.x >= np.asarray(bounds[0])) and np.all(actual.x <= np.asarray(bounds[1]))
    assert all(a is b for a, b in zip(_global_identities(), identities))


def test_native_lsmr_concurrent_calls_keep_independent_state_and_immutable_inputs(native_lsmr_module, real_numpy_norm_provider):
    """Hai kernel dùng chung đầu vào chỉ đọc vẫn có workspace/kết quả riêng."""
    payload = _native_payload(*_native_case())
    saved = {}
    for key, value in payload.items():
        if isinstance(value, np.ndarray):
            saved[key] = value.copy()
            value.setflags(write=False)
    variants = [dict(damp=0., maxiter=40, norm_provider=real_numpy_norm_provider),
                dict(damp=.3, maxiter=40, norm_provider=real_numpy_norm_provider)]
    expected = [native_lsmr_module.cutline_lsmr(**payload, **options) for options in variants]
    identities, rendezvous = _global_identities(), Barrier(2)
    def run(options):
        checkpoints = 0
        def checkpoint():
            nonlocal checkpoints
            checkpoints += 1
            assert all(a is b for a, b in zip(_global_identities(), identities))
            if checkpoints == 1:
                # Đồng bộ lúc CẢ HAI đã vào kernel, không suy đoán song song
                # từ thời gian máy hay bắt callback cuối chờ tác vụ đã xong.
                rendezvous.wait(timeout=10)
        return native_lsmr_module.cutline_lsmr(**payload, **options, cancel=checkpoint)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, options) for options in variants]
        actual = [future.result(timeout=15) for future in futures]
    for result, reference in zip(actual, expected):
        _assert_float64_bits(result[0], reference[0])
        assert tuple(result[1:]) == tuple(reference[1:])
    for key, values in saved.items():
        np.testing.assert_array_equal(payload[key], values)
        assert not payload[key].flags.writeable
    assert all(a is b for a, b in zip(_global_identities(), identities))


def test_native_lsmr_version_retains_required_license_notice(native_lsmr_module):
    """Bản pyd phát hành phải mang thông báo bản quyền, không chỉ source Rust."""
    notice = native_lsmr_module.cutline_lsmr_version.__doc__ or ""
    assert "Copyright" in notice and "SciPy" in notice and "Stanford" in notice
    assert "Redistribution and use" in notice
    assert "THIS SOFTWARE IS PROVIDED" in notice and "AS IS" in notice
    assert "ANY EXPRESS OR IMPLIED WARRANTIES" in notice


def _assert_exact_native_lsmr(actual, expected):
    assert len(actual) == len(expected) == 8
    _assert_float64_bits(actual[0], expected[0])
    assert tuple(actual[1:3]) == tuple(expected[1:3])
    _assert_float64_bits(np.asarray(actual[3:]), np.asarray(expected[3:]))


@pytest.mark.parametrize("kind", ["full", "rank-deficient", "ill-conditioned", "zero-matrix", "zero-rhs"])
@pytest.mark.parametrize("damp", [0., .4])
def test_native_lsmr_with_numpy_norm_is_exact_on_fixed_systems(native_lsmr_module, real_numpy_norm_provider, kind, damp):
    """Vài ulp của norm có thể đổi seed: nhánh production phải so đúng bit."""
    matrix, scale, diagonal, rhs = _native_case(kind)
    options = dict(damp=damp, atol=1e-12, btol=1e-12, conlim=1e12, maxiter=40)
    reference = scipy_lsmr(scipy_regularized(scipy_scaled(matrix, scale), diagonal), rhs, **options)
    actual = native_lsmr_module.cutline_lsmr(
        **_native_payload(matrix, scale, diagonal, rhs), **options, norm_provider=real_numpy_norm_provider,
    )
    _assert_exact_native_lsmr(actual, reference)


@pytest.mark.parametrize("seed", range(100))
def test_native_lsmr_with_numpy_norm_is_exact_across_random_csr_sizes(native_lsmr_module, real_numpy_norm_provider, seed):
    rng = np.random.default_rng(20260927 + seed)
    rows, cols = 1 + (seed * 7) % 47, 1 + (seed * 11) % 31
    dense = rng.normal(size=(rows, cols))
    dense[rng.random(size=dense.shape) < .65] = 0.
    matrix = csr_matrix(dense)
    scale = np.exp(rng.normal(size=cols))
    diagonal = np.zeros(cols) if seed % 5 == 0 else rng.uniform(.01, .5, cols)
    rhs = rng.normal(size=rows + cols)
    options = dict(damp=(0., .02, .4)[seed % 3], atol=1e-12, btol=1e-12,
                   conlim=1e12, maxiter=None if seed % 2 == 0 else 1 + seed % 16)
    reference = scipy_lsmr(scipy_regularized(scipy_scaled(matrix, scale), diagonal), rhs, **options)
    actual = native_lsmr_module.cutline_lsmr(
        **_native_payload(matrix, scale, diagonal, rhs), **options, norm_provider=real_numpy_norm_provider,
    )
    _assert_exact_native_lsmr(actual, reference)


def test_numpy_norm_callback_receives_owned_copies_not_solver_buffers(native_lsmr_module):
    payload = _native_payload(*_native_case())
    original = {key: value.copy() for key, value in payload.items() if isinstance(value, np.ndarray)}
    seen = []
    def norm(values):
        assert isinstance(values, np.ndarray) and values.dtype == np.float64 and values.ndim == 1
        seen.append(values.shape)
        result = np.linalg.norm(values)
        # Cố ý sửa bản sao callback SAU tính norm: không được làm hỏng state
        # Rust hay mảng nguồn caller đang dùng ở tác vụ khác.
        values[:] = np.nan
        return result
    matrix, scale, diagonal, rhs = _native_case()
    expected = scipy_lsmr(scipy_regularized(scipy_scaled(matrix, scale), diagonal), rhs)
    actual = native_lsmr_module.cutline_lsmr(**payload, norm_provider=norm)
    assert seen
    _assert_exact_native_lsmr(actual, expected)
    for key, values in original.items():
        np.testing.assert_array_equal(payload[key], values)


@pytest.mark.parametrize("exception_type", [ValueError, RuntimeError, PreviewCancelled])
def test_numpy_norm_callback_error_preserves_original_exception(native_lsmr_module, exception_type):
    calls, failure = [], exception_type("Norm lỗi/hủy phải truyền nguyên, không đổi solver.")
    def norm(values):
        calls.append(1)
        raise failure
    with pytest.raises(exception_type) as raised:
        native_lsmr_module.cutline_lsmr(**_native_payload(*_native_case()), norm_provider=norm)
    assert raised.value is failure
    assert calls == [1]


@pytest.mark.parametrize("invalid", [1.5, object(), "np.linalg.norm"])
def test_native_lsmr_rejects_noncallable_norm_provider(native_lsmr_module, invalid):
    with pytest.raises((TypeError, ValueError)):
        native_lsmr_module.cutline_lsmr(**_native_payload(*_native_case()), norm_provider=invalid)


def test_unknown_numpy_version_disables_native_norm_without_callbacks(monkeypatch):
    monkeypatch.setattr(np, "__version__", "0.0-unverified-numpy-test")
    assert adapter._numpy_norm_provider() is None
    monkeypatch.setattr(adapter, "_NATIVE_LSMR_ENABLED", True)
    monkeypatch.setattr(adapter, "_native_module", lambda: SimpleNamespace(cutline_lsmr=lambda *a, **kw: None))
    selected = adapter.resolve_fair_least_squares(scipy.optimize.least_squares)
    assert getattr(selected, "_prynx_backend", None) != "native-lsmr"


def test_missing_numpy_norm_uses_python_before_any_native_callback(monkeypatch):
    sentinel, calls = object(), []
    def forbidden(*args, **kwargs):
        pytest.fail("Không có norm đã kiểm thì không gọi Rust/callback hủy của Rust.")
    def fallback(operator, rhs, **options):
        calls.append(1)
        return sentinel
    monkeypatch.setattr(adapter, "_native_module", lambda: SimpleNamespace(cutline_lsmr=forbidden))
    monkeypatch.setattr(adapter, "_numpy_norm_provider", lambda: None)
    monkeypatch.setattr("app.workers.cutline_preview_cancel.check_preview_cancelled", forbidden)
    monkeypatch.setattr("scipy.sparse.linalg.lsmr", fallback)
    matrix, scale, diagonal, rhs = _native_case()
    assert adapter._native_lsmr(adapter._FusedCsrOperator(matrix, scale, diagonal), rhs) is sentinel
    assert calls == [1]
