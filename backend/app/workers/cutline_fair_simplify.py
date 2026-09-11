"""Refit neo/tay nắm tự do, giữ góc thật và kiểm riêng quỹ đạo cuối.

QUALITY (audit 2026-09-10 §FAIR.1/2): nghiệm tối ưu không phải chứng nhận.
Nguồn bất biến, seed chỉ gợi ý; chỉ bộ kiểm độc lập được phép nhận kết quả.
Không phụ thuộc DLL, dữ liệu mẫu hoặc công cụ nghiên cứu ngoài sản phẩm.
"""
from __future__ import annotations

import math

import numpy as np
from app.workers.cutline_preview_cancel import check_preview_cancelled


def protected_corner_indices(source):
    """Giữ cusp/góc mạnh và góc nông cô lập, không khóa mọi gợn polyline."""
    curves = np.asarray(source, dtype=np.float64)
    incoming = np.roll(curves[:, 3] - curves[:, 2], 1, axis=0)
    outgoing = curves[:, 1] - curves[:, 0]
    lengths = np.linalg.norm(incoming, axis=1) * np.linalg.norm(outgoing, axis=1)
    cosine = np.divide(np.sum(incoming * outgoing, axis=1), lengths,
                       out=np.full(len(curves), -1.0), where=lengths > 1e-20)
    angles = np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))
    neighbours = np.maximum(np.roll(angles, 1), np.roll(angles, -1))
    return tuple(np.flatnonzero((angles >= 45.0) | ((angles >= 5.0) & (neighbours <= angles * .15))))


def _evaluate(curves, indices, parameters, derivative=0):
    p, t = curves[indices], parameters[:, None]
    if derivative == 1:
        return 3*(1-t)**2*(p[:, 1]-p[:, 0]) + 6*(1-t)*t*(p[:, 2]-p[:, 1]) + 3*t*t*(p[:, 3]-p[:, 2])
    if derivative == 2:
        return 6*(1-t)*(p[:, 2]-2*p[:, 1]+p[:, 0]) + 6*t*(p[:, 3]-2*p[:, 2]+p[:, 1])
    return (1-t)**3*p[:, 0] + 3*(1-t)**2*t*p[:, 1] + 3*(1-t)*t*t*p[:, 2] + t**3*p[:, 3]


def _parameters(curves, step):
    """Cận đạo hàm điều khiển khoảng cách lấy mẫu theo mm, không cap số neo."""
    bounds = 3*np.linalg.norm(np.diff(curves, axis=1), axis=2).max(axis=1)
    counts = np.maximum(8, np.ceil(bounds/step).astype(int))
    return np.repeat(np.arange(len(curves)), counts), np.concatenate([
        np.linspace(0, 1, int(n), endpoint=False) for n in counts])


def _uniform_points(curves, step):
    indices, parameters = _parameters(curves, step / 8)
    dense = np.vstack([_evaluate(curves, indices, parameters), curves[-1, 3]])
    lengths = np.r_[0, np.cumsum(np.linalg.norm(np.diff(dense, axis=0), axis=1))]
    keep = np.r_[True, np.diff(lengths) > 1e-12]
    dense, lengths = dense[keep], lengths[keep]
    if lengths[-1] <= step:
        return None
    at = np.linspace(0, lengths[-1], math.ceil(lengths[-1]/step), endpoint=False)
    return np.column_stack([np.interp(at, lengths, dense[:, axis]) for axis in (0, 1)])


def _closest(curves, points, step):
    check_preview_cancelled()
    from scipy.spatial import cKDTree

    indices, parameters = _parameters(curves, step)
    tree = cKDTree(_evaluate(curves, indices, parameters))
    _, nearest = tree.query(points)
    indices, parameters = indices[nearest], parameters[nearest]
    for _ in range(5):
        check_preview_cancelled()
        delta = _evaluate(curves, indices, parameters) - points
        first = _evaluate(curves, indices, parameters, 1)
        second = _evaluate(curves, indices, parameters, 2)
        denominator = np.sum(first*first + delta*second, axis=1)
        change = np.divide(np.sum(delta*first, axis=1), denominator,
                           out=np.zeros(len(points)), where=denominator > 1e-14)
        parameters = np.clip(parameters-change, 0, 1)
    return indices, parameters, _evaluate(curves, indices, parameters)


def _encode(seed, source, protected):
    """Năm biến tại join trơn; góc thật khóa vị trí và hai hướng độc lập."""
    outgoing = seed[:, 1]-seed[:, 0]
    incoming = seed[:, 0]-np.roll(seed[:, 2], 1, axis=0)
    lo, li = np.linalg.norm(outgoing, axis=1), np.linalg.norm(incoming, axis=1)
    if min(lo.min(), li.min()) <= 1e-10:
        return None
    tangent = outgoing/lo[:, None] + incoming/li[:, None]
    angles = np.arctan2(tangent[:, 1], tangent[:, 0])
    values = np.column_stack([seed[:, 0], angles, np.log(lo), np.log(li)])
    fixed, angle_delta = np.zeros(values.shape, dtype=bool), np.zeros(len(seed))
    smooth = np.ones(len(seed), dtype=bool)
    for index in protected:
        matches = np.flatnonzero(np.linalg.norm(seed[:, 0]-source[index, 0], axis=1) <= 1e-9)
        if len(matches) != 1:
            return None
        knot = matches[0]
        before = source[index, 0]-source[index-1, 2]
        after = source[index, 1]-source[index, 0]
        if min(np.linalg.norm(before), np.linalg.norm(after)) <= 1e-10:
            return None
        values[knot, :2] = source[index, 0]
        values[knot, 2] = math.atan2(after[1], after[0])
        angle_delta[knot] = math.atan2(before[1], before[0])-values[knot, 2]
        fixed[knot, :3], smooth[knot] = True, False
    return values, ~fixed.ravel(), angle_delta, smooth


def _decode(values, angle_delta):
    tangent = np.column_stack([np.cos(values[:, 2]), np.sin(values[:, 2])])
    incoming_tangent = np.column_stack([np.cos(values[:, 2]+angle_delta), np.sin(values[:, 2]+angle_delta)])
    anchors = values[:, :2]
    outgoing = anchors + np.exp(values[:, 3, None])*tangent
    incoming = anchors - np.exp(values[:, 4, None])*incoming_tangent
    return np.stack([anchors, outgoing, np.roll(incoming, -1, axis=0), np.roll(anchors, -1, axis=0)], axis=1)


def _curvature_jumps(curves):
    v0, v1 = 3*(curves[:, 1]-curves[:, 0]), 3*(curves[:, 3]-curves[:, 2])
    a0 = 6*(curves[:, 2]-2*curves[:, 1]+curves[:, 0])
    a1 = 6*(curves[:, 3]-2*curves[:, 2]+curves[:, 1])
    cross = lambda a,b: a[:, 0]*b[:, 1]-a[:, 1]*b[:, 0]
    k0 = cross(v0, a0)/np.maximum(np.linalg.norm(v0, axis=1)**3, 1e-20)
    k1 = cross(v1, a1)/np.maximum(np.linalg.norm(v1, axis=1)**3, 1e-20)
    return k0-np.roll(k1, 1)


def _optimize_seed(
    source,
    seed,
    tolerance,
    protected,
    source_points,
    *,
    fair_weight=.3,
    max_irls_rounds: int = 5,
    max_nfev: int = 35,
):
    from scipy.optimize import least_squares
    from app.workers.cutline_fair_jacobian import build_fair_jacobian

    encoded = _encode(seed, source, protected)
    if encoded is None:
        return None
    values, free, angle_delta, smooth = encoded
    lower, upper = np.full(values.shape, -np.inf), np.full(values.shape, np.inf)
    lower[:, 3:] = math.log(1e-9)
    # Giới hạn miền nghiệm theo kích thước hình, không hard-cap chất lượng/mm.
    upper[:, 3:] = math.log(max(1.0, 6*np.linalg.norm(np.diff(source, axis=1), axis=2).sum()))
    step = min(.03, tolerance*.3)
    chords = np.linalg.norm(seed[:, 3]-seed[:, 0], axis=1)
    fair_scale = (.0005*np.minimum(chords, np.roll(chords, 1))**2
                  if fair_weight is None else np.full(len(seed), fair_weight))
    # PERF (audit 2026-09-11 §SIMPLIFY.FAIR-FAST): residual đã có trọng số hình
    # học và được chứng nhận lại ở tầng caller. Vẫn giữ tối đa 5 lượt IRLS như
    # hợp đồng solver cũ, nhưng dừng sớm khi nghiệm đã ổn định; các lượt sau khi
    # đó chỉ giải lại cùng một seed và làm preview chờ thêm nhiều giây.
    # Nếu nghiệm nhanh không qua verify, caller giữ nguyên nguồn hoặc thử seed/
    # fallback an toàn; không nới dung sai, không bỏ topology/độ cong.
    try:
        irls_rounds = max(1, min(5, int(max_irls_rounds)))
    except (TypeError, ValueError):
        irls_rounds = 5
    try:
        solver_max_nfev = max(1, min(35, int(max_nfev)))
    except (TypeError, ValueError):
        solver_max_nfev = 35
    previous_solution = None
    for exponent in (0, 1, 2, 3, 4)[:irls_rounds]:
        check_preview_cancelled()
        current = _decode(values, angle_delta)
        source_indices, source_t, projected = _closest(current, source_points, step*4/3)
        reverse_indices, reverse_t = _parameters(current, step*10/3)
        reverse = _evaluate(current, reverse_indices, reverse_t)
        _, _, reverse_projected = _closest(source, reverse, step*4/3)
        indices, parameters = np.r_[source_indices, reverse_indices], np.r_[source_t, reverse_t]
        target = np.vstack([source_points, reverse_projected])
        error = np.linalg.norm(np.vstack([projected, reverse])-target, axis=1)
        weights = np.sqrt(1+(error/(tolerance*.75))**exponent) if exponent else np.ones(len(error))
        weights *= math.sqrt(step/.03)
        # PERF (audit 2026-09-10 §SIMPERF.2): đạo hàm của đúng residual cũ,
        # không giảm vòng lặp/mẫu hay đổi trọng số để lấy tốc độ.
        analytic = build_fair_jacobian(indices, parameters, weights, fair_scale,
                                       smooth, free, angle_delta)
        template = values.ravel().copy()
        def decode_free(candidate):
            full = template.copy()
            full[free] = candidate
            return _decode(full.reshape(-1, 5), angle_delta)
        def residual(candidate):
            # PERF (audit 2026-09-11 §PREWARM.CANCEL): SciPy gọi lại residual
            # trong mỗi bước; đây là điểm thoát thật khi UI đã đổi yêu cầu.
            check_preview_cancelled()
            curves = decode_free(candidate)
            data = ((_evaluate(curves, indices, parameters)-target)*weights[:, None]).ravel()
            return np.r_[data, fair_scale*smooth*_curvature_jumps(curves)]
        def jacobian(candidate):
            check_preview_cancelled()
            full = template.copy()
            full[free] = candidate
            decoded = full.reshape(-1, 5)
            return analytic(decoded, _decode(decoded, angle_delta))
        result = least_squares(residual, template[free], jac=jacobian,
                               bounds=(lower.ravel()[free], upper.ravel()[free]),
                               x_scale='jac', method='trf', max_nfev=solver_max_nfev,
                               ftol=1e-7, xtol=1e-7, gtol=1e-7)
        if not np.all(np.isfinite(result.x)):
            return None
        solution_delta = (
            math.inf if previous_solution is None
            else float(np.max(np.abs(result.x - previous_solution)))
        )
        template[free] = result.x
        values = template.reshape(-1, 5)
        previous_solution = result.x.copy()
        # SciPy result không có đủ metadata trong các solver stub/test cũ; khi
        # thiếu ``optimality`` không dừng sớm để giữ đúng 5 lượt như trước.
        optimality = getattr(result, "optimality", None)
        if (
            exponent > 0
            and math.isfinite(solution_delta)
            and solution_delta <= 1e-7
            and isinstance(optimality, (int, float))
            and math.isfinite(float(optimality))
            and float(optimality) <= 1e-5
        ):
            break
    return _decode(values, angle_delta)


def _fair_refit_ring_impl(
    source,
    tolerance_mm,
    *,
    max_irls_rounds: int = 5,
    max_nfev: int = 35,
):
    """Trả ring và cận mm; không có nghiệm an toàn thì giữ đúng object nguồn."""
    from app.workers.cutline_fair_seed import build_fair_seeds
    from app.workers.cutline_fair_verify import verify_fair_ring

    tolerance = float(tolerance_mm)
    check_preview_cancelled()
    values = np.asarray(source, dtype=np.float64)
    if (values.ndim != 3 or values.shape[1:] != (4, 2) or len(values) < 4
            or not np.isfinite(values).all() or not math.isfinite(tolerance)
            or tolerance < .005):
        # Dưới bước điều khiển Simplify (0,005 mm), giữ nhánh gộp bảo toàn
        # của caller. Không cho tham số API cực nhỏ kích hoạt tái dựng với
        # mật độ 1/ε; dung sai yêu cầu vẫn do nhánh bảo toàn kiểm, không nới.
        return source, 0.0
    origin = values[0, 0].copy()
    local = values-origin
    protected = protected_corner_indices(local)
    points = _uniform_points(local, min(.03, tolerance*.3))
    if points is None:
        return source, 0.0
    seeds = build_fair_seeds(local, tolerance, protected_indices=protected)
    while True:
        for seed in seeds:
            check_preview_cancelled()
            if len(seed) >= len(values):
                continue
            candidate = _optimize_seed(
                local,
                np.asarray(seed),
                tolerance,
                protected,
                points,
                max_irls_rounds=max_irls_rounds,
                max_nfev=max_nfev,
            )
            if candidate is None:
                continue
            check_preview_cancelled()
            verified = verify_fair_ring(local, candidate, tolerance_mm=tolerance,
                                        protected_vertices=local[list(protected), 0])
            if verified.accepted:
                shifted = candidate+origin
                # Sau translate, góc khóa vẫn phải là tọa độ gốc, không trôi vì triệt tiêu.
                for index in protected:
                    knot = int(np.argmin(np.linalg.norm(candidate[:, 0]-local[index, 0], axis=1)))
                    shifted[knot, 0] = values[index, 0]
                    shifted[knot-1, 3] = values[index, 0]
                return tuple(tuple(tuple(map(float, p)) for p in c) for c in shifted), verified.maximum_error_bound_mm
        if not max_nfev < 35:
            return source, 0.0
        # PERF (audit 2026-09-11 §CUTRUNTIME.CORE): fallback đầy đủ giữ cùng
        # nguồn/mẫu/ba seed bất biến, không dựng lại chúng. Mỗi lượt vẫn tạo
        # mảng seed mới, KHÔNG khởi động từ candidate nhanh đã bị từ chối.
        # Giữ nguyên số vòng/thứ tự nghiệm và bộ kiểm độc lập của nhánh cũ.
        check_preview_cancelled()
        max_irls_rounds, max_nfev = 5, 35


def fair_refit_ring(
    source,
    tolerance_mm,
    *,
    max_irls_rounds: int = 5,
    max_nfev: int = 35,
):
    """Làm mượt tùy chọn: phụ thuộc/solver lỗi thì giữ nguồn, không hỏng PDF."""
    try:
        return _fair_refit_ring_impl(
            source,
            tolerance_mm,
            max_irls_rounds=max_irls_rounds,
            max_nfev=max_nfev,
        )
    except (ImportError, ArithmeticError, TypeError, ValueError, IndexError,
            np.linalg.LinAlgError):
        return source, 0.0
