"""Gộp CSR và tăng tốc LSMR của CUT, giữ hợp đồng số học SciPy.

PERF (audit 2026-09-27 §CUT.FUSED): không sửa globals của SciPy hoặc toàn
process. Chỉ bộ gọi riêng của CUT dùng operator gộp; không đổi phương trình,
regularization hay ngưỡng hội tụ. Bounded-TRF tĩnh chạy được với Nuitka;
LSMR Rust giữ norm NumPy để không đổi nghiệm do thứ tự reduction. Runtime
chưa xác minh hoặc binding thiếu/cũ dùng đường SciPy đã kiểm.
"""
from __future__ import annotations

from functools import lru_cache
from functools import partial
import importlib
import logging
from types import FunctionType

import numpy as np
import scipy
from scipy.sparse import isspmatrix_csr
from scipy.sparse.linalg import LinearOperator
try:
    from scipy.optimize._lsq.common import (
        right_multiplied_operator as _original_right,
        regularized_lsq_operator as _original_regularized,
    )
except ImportError:
    _original_right = _original_regularized = None
try:
    from scipy.sparse import _sparsetools
except ImportError:
    _sparsetools = None
logger = logging.getLogger(__name__)
# PERF (audit 2026-09-27 §CUT.NATIVE): API v2 + norm NumPy đã đối chứng
# toàn bộ 13 trang ở 13/2 worker; binding/runtime chưa kiểm tự về SciPy.
_NATIVE_LSMR_ENABLED = True


class _FusedCsrOperator(LinearOperator):
    """J@(d*x) và d*(J.T@u), thêm đường chéo mà không lồng operator."""
    def __init__(self, matrix, scale, diagonal=None):
        self.matrix = matrix
        self.scale = scale
        self.diagonal = diagonal
        self._rows, self._cols = matrix.shape
        shape = (self._rows + (self._cols if diagonal is not None else 0), self._cols)
        super().__init__(dtype=matrix.dtype, shape=shape)

    def _fallback(self):
        operator = _original_right(self.matrix, self.scale)
        return operator if self.diagonal is None else _original_regularized(operator, self.diagonal)

    def _matvec(self, x):
        values = np.ravel(x)
        if values.dtype != np.float64:
            return self._fallback().matvec(values)
        matrix = self.matrix
        result = np.zeros(self.shape[0], dtype=np.float64)
        _sparsetools.csr_matvec(
            self._rows, self._cols, matrix.indptr, matrix.indices, matrix.data,
            values * self.scale, result[:self._rows],
        )
        if self.diagonal is not None:
            result[self._rows:] = self.diagonal * values
        return result

    def _rmatvec(self, x):
        values = np.ravel(x)
        if values.dtype != np.float64:
            return self._fallback().rmatvec(values)
        matrix = self.matrix
        result = np.zeros(self._cols, dtype=np.float64)
        # CSR của J chính là CSC của J.T: giữ đúng thứ tự cộng của SciPy,
        # không prescale data vì (J*d)@x có thể đổi sai số dấu phẩy động.
        _sparsetools.csc_matvec(
            self._cols, self._rows, matrix.indptr, matrix.indices, matrix.data,
            values[:self._rows], result,
        )
        result = self.scale * result
        if self.diagonal is not None:
            result = result + self.diagonal * values[self._rows:]
        return result

    def _matmat(self, x):
        if x.shape[1] == 0:
            return np.empty((self.shape[0], 0), dtype=np.result_type(self.dtype, x.dtype))
        return np.column_stack([self._matvec(x[:, index]) for index in range(x.shape[1])])


def _supported_csr(matrix, scale):
    if (_sparsetools is None or not isspmatrix_csr(matrix)
            or matrix.dtype != np.float64 or not isinstance(scale, np.ndarray)
            or scale.dtype != np.float64 or scale.shape != (matrix.shape[1],)):
        return False
    rows, cols = matrix.shape
    # Kernel nội bộ không tự bảo vệ CSR hỏng. Kiểm đủ biên trước khi gọi,
    # không sửa thứ tự/duplicate và không ghi vào mảng Jacobian của solver.
    if (matrix.indptr.dtype not in (np.dtype('int32'), np.dtype('int64'))
            or matrix.indices.dtype != matrix.indptr.dtype
            or any(a.ndim != 1 or not a.flags.c_contiguous for a in (matrix.data, matrix.indices, matrix.indptr))
            or len(matrix.indptr) != rows + 1 or matrix.indptr[0] != 0
            or matrix.indptr[-1] != len(matrix.indices) or len(matrix.data) != len(matrix.indices)):
        return False
    return bool(np.all(matrix.indptr[1:] >= matrix.indptr[:-1])
                and (len(matrix.indices) == 0 or (matrix.indices.min() >= 0 and matrix.indices.max() < cols)))


def _right_multiplied_operator(matrix, scale):
    if _supported_csr(matrix, scale):
        return _FusedCsrOperator(matrix, scale)
    return _original_right(matrix, scale)


def _regularized_lsq_operator(operator, diagonal):
    if (isinstance(operator, _FusedCsrOperator) and operator.diagonal is None
            and isinstance(diagonal, np.ndarray) and diagonal.dtype == np.float64
            and diagonal.shape == (operator.shape[1],)):
        return _FusedCsrOperator(operator.matrix, operator.scale, diagonal)
    return _original_regularized(operator, diagonal)


def _python_function(function, required_names):
    # Nuitka compiled_function có thể là subtype FunctionType nhưng __code__
    # chỉ mang metadata. Không dựng hàm Python từ code object đó.
    return (type(function) is FunctionType and not hasattr(function, '__compiled__')
            and function.__closure__ is None and not hasattr(function, '__wrapped__')
            and set(required_names).issubset(function.__code__.co_names))


def _clone(function, replacements):
    namespace = dict(function.__globals__)
    namespace.update(replacements)
    cloned = FunctionType(function.__code__, namespace, function.__name__, function.__defaults__)
    cloned.__kwdefaults__ = function.__kwdefaults__
    return cloned


def _capability(solver):
    # requirements.txt khóa 1.12.0. Version khác phải được đối chứng trước,
    # không đoán rằng cấu trúc nội bộ TRF và kernel vẫn tương thích.
    if scipy.__version__ != '1.12.0':
        return 'scipy-version-unverified'
    if not callable(_original_right) or not callable(_original_regularized):
        return 'operator-builder-unavailable'
    if _sparsetools is None or not all(callable(getattr(_sparsetools, n, None)) for n in ('csr_matvec', 'csc_matvec')):
        return 'csr-kernel-unavailable'
    least_module = importlib.import_module('scipy.optimize._lsq.least_squares')
    trf_module = importlib.import_module('scipy.optimize._lsq.trf')
    if solver is not least_module.least_squares:
        return 'caller-solver-override'
    if not all((
        _python_function(solver, ('trf',)),
        _python_function(trf_module.trf, ('trf_bounds', 'trf_no_bounds')),
        _python_function(trf_module.trf_bounds, ('right_multiplied_operator', 'regularized_lsq_operator', 'lsmr')),
    )):
        return 'solver-runtime-unverified'
    if not all((
        solver.__globals__.get('trf') is trf_module.trf,
        trf_module.trf.__globals__.get('trf_bounds') is trf_module.trf_bounds,
        trf_module.trf.__globals__.get('trf_no_bounds') is trf_module.trf_no_bounds,
        trf_module.trf_bounds.__globals__.get('right_multiplied_operator') is _original_right,
        trf_module.trf_bounds.__globals__.get('regularized_lsq_operator') is _original_regularized,
    )):
        return 'solver-wiring-unverified'
    return None


@lru_cache(maxsize=None)
def _isolated_solver(solver, dispatch, bounded):
    # Tái dùng code SciPy đang cài, không sao chép/thay thuật toán TRF.
    # Unbounded/LM/dogbox giữ nguyên; chỉ nhánh bounded CSR của CUT thay
    # builder operator trong bộ globals RIÊNG, dùng được đồng thời giữa job.
    private_bounds = _clone(bounded, {
        'right_multiplied_operator': _right_multiplied_operator,
        'regularized_lsq_operator': _regularized_lsq_operator,
    })
    private_dispatch = _clone(dispatch, {'trf_bounds': private_bounds})
    return _clone(solver, {'trf': private_dispatch})


def _resolve_backend(solver):
    try:
        if _NATIVE_LSMR_ENABLED and scipy.__version__ == '1.12.0':
            least_module = importlib.import_module('scipy.optimize._lsq.least_squares')
            if (solver is least_module.least_squares and _native_module() is not None
                    and _numpy_norm_provider() is not None):
                selected = partial(native_fair_least_squares, solver)
                selected._prynx_backend = 'native-lsmr'
                return selected, None
        reason = _capability(solver)
        if reason is not None:
            return solver, reason
        trf_module = importlib.import_module('scipy.optimize._lsq.trf')
        return _isolated_solver(solver, trf_module.trf, trf_module.trf_bounds), None
    except (ImportError, AttributeError, TypeError, ValueError):
        # Chỉ fallback lúc dựng adapter; lỗi thật của residual/solver và
        # PreviewCancelled không được nuốt rồi tính lại công việc đã hủy.
        return solver, 'solver-adapter-unavailable'


def resolve_fair_least_squares(solver):
    """Chọn adapter riêng hoặc callable cũ; không chạy lại solver khi lỗi/hủy."""
    selected, reason = _resolve_backend(solver)
    _report_backend(reason, getattr(selected, '_prynx_backend', 'fused-csr'))
    return selected


@lru_cache(maxsize=None)
def _report_backend(reason, backend='fused-csr'):
    # Ghi một lần mỗi capability, không log từng seed/request. Bản đóng gói
    # fallback phải nhìn thấy được, không gọi mặc định là đã tăng tốc native.
    logger.info('[CUT_SOLVER] backend=%s reason=%s',
                backend if reason is None else 'scipy-default', reason or 'verified-solver')


def fused_solver_status():
    from scipy.optimize import least_squares
    selected, reason = _resolve_backend(least_squares)
    return {'backend': getattr(selected, '_prynx_backend', 'fused-csr') if reason is None else 'scipy-default',
            'reason': reason, 'scipy_version': scipy.__version__}


def _native_module():
    """Binding thiếu/cũ không được làm mất solver Python đã kiểm."""
    try:
        module = importlib.import_module('pdfcompare_native')
        if module.cutline_lsmr_version() == 2 and callable(module.cutline_lsmr):
            return module
    except (ImportError, AttributeError):
        pass
    return None


def _numpy_norm_provider():
    """Giữ norm NumPy đã kiểm, không gọi DLL thô hoặc đổi số luồng BLAS."""
    # PERF (audit 2026-09-27 §CUT.NATIVE): cộng tuần tự trong Rust có thể
    # đổi vài ulp của norm, rồi làm TRF chọn seed khác. Chuẩn hóa phải dùng
    # chính reduction của NumPy; runtime chưa chứng minh thì giữ SciPy.
    # Gọi qua API Python/NumPy có GIL, không đoán ABI hay function pointer.
    if np.__version__ != '1.26.4' or not callable(np.linalg.norm):
        return None
    return np.linalg.norm


def _native_lsmr(operator, rhs, **options):
    from scipy.sparse.linalg import lsmr
    from app.workers.cutline_preview_cancel import check_preview_cancelled
    native = _native_module()
    norm_provider = _numpy_norm_provider() if native is not None else None
    # Chỉ nhánh augmented CSR của CUT được đưa xuống Rust. Không cố đoán
    # cấu trúc operator của caller khác hoặc bỏ các tùy chọn chưa hỗ trợ.
    if (native is None or norm_provider is None or not isinstance(operator, _FusedCsrOperator)
            or operator.diagonal is None
            or set(options) - {'damp', 'atol', 'btol', 'conlim', 'maxiter', 'show', 'x0'}
            or options.get('show', False) or options.get('x0') is not None):
        return lsmr(operator, rhs, **options)
    # SciPy chấp nhận một số miền rộng hơn binding (ví dụ maxiter=10.0,
    # conlim âm). Chuyển về Python TRƯỚC khi chạy, không bắt lỗi rồi tính lại.
    maxiter = options.get('maxiter')
    if (maxiter is not None and (not isinstance(maxiter, (int, np.integer))
            or not 0 <= maxiter <= np.iinfo(np.uintp).max)):
        return lsmr(operator, rhs, **options)
    for name, default in (('damp', 0.), ('atol', 1e-6), ('btol', 1e-6), ('conlim', 1e8)):
        value = options.get(name, default)
        try:
            supported = (isinstance(value, (int, float, np.integer, np.floating))
                         and np.isfinite(float(value)) and value >= 0)
        except (TypeError, ValueError, OverflowError):
            supported = False
        if not supported:
            return lsmr(operator, rhs, **options)
    check_preview_cancelled()
    matrix = operator.matrix
    result = native.cutline_lsmr(
        np.ascontiguousarray(matrix.data, dtype=np.float64),
        np.ascontiguousarray(matrix.indices, dtype=np.int64),
        np.ascontiguousarray(matrix.indptr, dtype=np.int64),
        matrix.shape[0], matrix.shape[1],
        np.ascontiguousarray(operator.scale, dtype=np.float64),
        np.ascontiguousarray(operator.diagonal, dtype=np.float64),
        np.ascontiguousarray(rhs, dtype=np.float64),
        damp=options.get('damp', 0.), atol=options.get('atol', 1e-6),
        btol=options.get('btol', 1e-6), conlim=options.get('conlim', 1e8),
        maxiter=options.get('maxiter'), cancel=check_preview_cancelled,
        norm_provider=norm_provider,
    )
    check_preview_cancelled()
    return result


# Bộ điều phối TRF bên dưới được chuyển thể từ SciPy 1.12.0
# scipy/optimize/_lsq/trf.py và least_squares.py. Giữ nguyên thứ tự phép tính
# của nhánh bounded, linear loss, analytic Jacobian dùng bởi CUT.
# Copyright (c) 2001-2002 Enthought, Inc. 2003-2024, SciPy Developers.
# All rights reserved.
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
# 3. Neither the name of the copyright holder nor the names of its contributors
#    may be used to endorse or promote products derived from this software
#    without specific prior written permission.
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.


def _bounded_trf_native(fun, jac, x0, f0, initial_jacobian, lb, ub,
                        ftol, xtol, gtol, max_nfev, tr_options):
    """TRF định nghĩa tĩnh: chạy được khi Nuitka không có Python bytecode."""
    from numpy.linalg import norm
    from scipy.linalg import qr
    from scipy.optimize import OptimizeResult
    from scipy.optimize._lsq.trf import select_step
    from scipy.optimize._lsq.common import (
        CL_scaling_vector, compute_grad, compute_jac_scale, check_termination,
        update_tr_radius, make_strictly_feasible, find_active_constraints,
        build_quadratic_1d, minimize_quadratic_1d, solve_trust_region_2d,
    )
    from app.workers.cutline_preview_cancel import check_preview_cancelled

    x = x0.copy()
    f = f0
    f_true = f.copy()
    nfev = njev = 1
    matrix = initial_jacobian
    rows, columns = matrix.shape
    cost = .5 * np.dot(f, f)
    gradient = compute_grad(matrix, f)
    scale, scale_inv = compute_jac_scale(matrix)
    v, dv = CL_scaling_vector(x, gradient, lb, ub)
    v[dv != 0] *= scale_inv[dv != 0]
    radius = norm(x0 * scale_inv / v**.5)
    if radius == 0:
        radius = 1.
    gradient_norm = norm(gradient * v, ord=np.inf)
    augmented_rhs = np.zeros(rows + columns)
    regularization = 0.
    regularize = tr_options.pop('regularize', True)
    if max_nfev is None:
        max_nfev = x0.size * 100
    alpha = 0.
    termination = None
    while True:
        check_preview_cancelled()
        v, dv = CL_scaling_vector(x, gradient, lb, ub)
        gradient_norm = norm(gradient * v, ord=np.inf)
        if gradient_norm < gtol:
            termination = 1
        if termination is not None or nfev == max_nfev:
            break
        v[dv != 0] *= scale_inv[dv != 0]
        d = v**.5 * scale
        diagonal_h = gradient * dv * scale
        gradient_h = d * gradient
        augmented_rhs[:rows] = f
        scaled = _right_multiplied_operator(matrix, d)
        if regularize:
            a, b = build_quadratic_1d(scaled, gradient_h, -gradient_h, diag=diagonal_h)
            to_tr = radius / norm(gradient_h)
            ag_value = minimize_quadratic_1d(a, b, 0, to_tr)[1]
            regularization = -ag_value / radius**2
        operator = _regularized_lsq_operator(scaled, (diagonal_h + regularization)**.5)
        gn_h = _native_lsmr(operator, augmented_rhs, **tr_options)[0]
        subspace = np.vstack((gradient_h, gn_h)).T
        subspace, _ = qr(subspace, mode='economic')
        projected = scaled.dot(subspace)
        quadratic = np.dot(projected.T, projected) + np.dot(subspace.T * diagonal_h, subspace)
        projected_gradient = subspace.T.dot(gradient_h)
        theta = max(.995, 1 - gradient_norm)
        actual_reduction = -1
        while actual_reduction <= 0 and nfev < max_nfev:
            check_preview_cancelled()
            reduced_step, _ = solve_trust_region_2d(quadratic, projected_gradient, radius)
            step_h = subspace.dot(reduced_step)
            step = d * step_h
            step, step_h, predicted_reduction = select_step(
                x, scaled, diagonal_h, gradient_h, step, step_h, d, radius, lb, ub, theta,
            )
            x_new = make_strictly_feasible(x + step, lb, ub, rstep=0)
            f_new = fun(x_new)
            nfev += 1
            step_h_norm = norm(step_h)
            if not np.all(np.isfinite(f_new)):
                radius = .25 * step_h_norm
                continue
            cost_new = .5 * np.dot(f_new, f_new)
            actual_reduction = cost - cost_new
            radius_new, ratio = update_tr_radius(
                radius, actual_reduction, predicted_reduction, step_h_norm, step_h_norm > .95 * radius,
            )
            step_norm = norm(step)
            termination = check_termination(
                actual_reduction, cost, step_norm, norm(x), ratio, ftol, xtol,
            )
            if termination is not None:
                break
            alpha *= radius / radius_new
            radius = radius_new
        if actual_reduction > 0:
            x = x_new
            f = f_new
            f_true = f.copy()
            cost = cost_new
            matrix = jac(x, f)
            njev += 1
            gradient = compute_grad(matrix, f)
            scale, scale_inv = compute_jac_scale(matrix, scale_inv)
        else:
            step_norm = 0
            actual_reduction = 0
    if termination is None:
        termination = 0
    return OptimizeResult(
        x=x, cost=cost, fun=f_true, jac=matrix, grad=gradient, optimality=gradient_norm,
        active_mask=find_active_constraints(x, lb, ub, rtol=xtol),
        nfev=nfev, njev=njev, status=termination,
    )


def native_fair_least_squares(original_solver, fun, x0, **options):
    """Nhánh CUT hẹp; unsupported sau callback đi tiếp TRF, không phát lại callback."""
    allowed = {'jac', 'bounds', 'method', 'ftol', 'xtol', 'gtol', 'max_nfev',
               'x_scale', 'loss', 'verbose', 'tr_solver', 'tr_options'}
    if (set(options) - allowed or options.get('method', 'trf') != 'trf'
            or options.get('loss', 'linear') != 'linear' or options.get('verbose', 0) != 0
            or not isinstance(options.get('x_scale'), str) or options.get('x_scale') != 'jac'
            or not callable(options.get('jac')) or options.get('tr_solver') not in (None, 'lsmr')):
        return original_solver(fun, x0, **options)
    from scipy.sparse import issparse
    from scipy.optimize._lsq.least_squares import prepare_bounds, check_tolerance, TERMINATION_MESSAGES
    from scipy.optimize._lsq.common import in_bounds, make_strictly_feasible
    from scipy.optimize._lsq.trf import trf

    # Mọi guard trước đây đều chạy trước fun/jac, nên có thể dùng public
    # solver để phát đúng validation của các đầu vào ngoài contract CUT.
    eligible = False
    try:
        initial = np.atleast_1d(x0).astype(float)
        bounds = options.get('bounds', (-np.inf, np.inf))
        if not np.iscomplexobj(x0) and initial.ndim == 1 and len(bounds) == 2:
            lower, upper = prepare_bounds(bounds, initial.size)
            max_nfev = options.get('max_nfev')
            eligible = (lower.shape == initial.shape and upper.shape == initial.shape
                        and not np.any(lower >= upper) and in_bounds(initial, lower, upper)
                        and not (np.all(lower == -np.inf) and np.all(upper == np.inf))
                        and (max_nfev is None or max_nfev > 0))
    except (TypeError, ValueError):
        pass
    if not eligible:
        # Callback của solver gốc phải nằm NGOÀI try validation, nếu không
        # lỗi ValueError từ fun có thể vô tình bị bắt rồi chạy lần hai.
        return original_solver(fun, x0, **options)
    ftol, xtol, gtol = check_tolerance(options.get('ftol', 1e-8), options.get('xtol', 1e-8),
                                     options.get('gtol', 1e-8), 'trf')
    initial = make_strictly_feasible(initial, lower, upper)
    def residual(x):
        return np.atleast_1d(fun(x))
    f0 = residual(initial)
    if f0.ndim != 1 or not np.all(np.isfinite(f0)):
        raise ValueError('Residual ban đầu phải là vector một chiều hữu hạn.')
    jac = options['jac']
    matrix = jac(initial)
    if issparse(matrix):
        matrix = matrix.tocsr()
        def jacobian(x, _f=None):
            return jac(x).tocsr()
    elif isinstance(matrix, LinearOperator):
        raise ValueError("x_scale='jac' không hỗ trợ Jacobian LinearOperator.")
    else:
        matrix = np.atleast_2d(matrix)
        def jacobian(x, _f=None):
            return np.atleast_2d(jac(x))
    if matrix.shape != (len(f0), len(initial)):
        raise ValueError('Kích thước Jacobian không khớp residual và biến của solver.')
    tr_options = dict(options.get('tr_options', {}))
    if _supported_csr(matrix, np.ones(len(initial))):
        result = _bounded_trf_native(residual, jacobian, initial, f0, matrix, lower, upper,
                                      ftol, xtol, gtol, max_nfev, tr_options)
    else:
        # Giữ f0/J0 đã tính, không gọi lại public least_squares khi callback
        # đã có hiệu ứng/cancellation. Dense mặc định giữ exact solver cũ.
        tr_solver = options.get('tr_solver') or ('lsmr' if issparse(matrix) else 'exact')
        result = trf(residual, jacobian, initial, f0, matrix, lower, upper,
                     ftol, xtol, gtol, max_nfev, 'jac', None, tr_solver, tr_options, 0)
    result.message = TERMINATION_MESSAGES[result.status]
    result.success = result.status > 0
    return result
