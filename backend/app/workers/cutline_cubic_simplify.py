"""Gộp cubic bế trong sai số liên tục so với nguồn cubic bất biến.

QUALITY (audit 2026-09-10 §FAIR.1/3): neo/tay nắm tự do chỉ đề xuất ứng viên;
bộ kiểm độc lập chứng nhận band, góc, topology và độ cong sau frame writer.
Nhánh bảo toàn vẫn dùng hiệu control point/ánh xạ cubic khi fairing bị từ chối.
Không dựng lại mask và không cộng dồn sai số qua các lần gộp.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from app.workers.cutline_simplify_memo import memoized_simplify
from app.workers.cutline_preview_cancel import check_preview_cancelled

from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Polygon

from app.workers.cutline_geometry import _bezier_point, _generate_fitted_bezier
from app.workers.cutline_machine_path import (
    MachinePathSegment,
    _curvature,
    _segment_length,
    analyze_machine_path,
)
from app.workers.cutline_polyline_reduction import (
    _continuous_paths_simple,
    _difference_bound,
    _flatten,
    chord_monotone,
    split_cubic,
)


Point = tuple[float, float]
Cubic = tuple[Point, Point, Point, Point]
_JOIN_DEGREES = 1.0
_CURVATURE_EPS_PER_MM = 1e-6
_WRITER_POINT_ERROR = math.sqrt(2.0) * 0.5e-4
CUTLINE_SIMPLIFY_MAX_MM = 0.1
# Đổi salt khi thay chiến lược hội tụ để memo/cache cũ không được dùng lẫn
# với đường preview/Execute mới.
CUTLINE_SIMPLIFY_ALGORITHM = "free-g1-v3-fast-candidate"


def _sub(a: Point, b: Point) -> Point:
    return a[0] - b[0], a[1] - b[1]


def _dot(a: Point, b: Point) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _cross(a: Point, b: Point) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _unit(a: Point) -> Point | None:
    length = math.hypot(*a)
    return (a[0] / length, a[1] / length) if length > 1e-12 else None


def _tangents(curve: Cubic) -> tuple[Point | None, Point | None]:
    return _unit(_sub(curve[1], curve[0])), _unit(_sub(curve[3], curve[2]))


def _join_angle(first: Cubic, second: Cubic) -> float:
    incoming, outgoing = _tangents(first)[1], _tangents(second)[0]
    if incoming is None or outgoing is None:
        return 180.0
    return math.degrees(math.acos(max(-1.0, min(1.0, _dot(incoming, outgoing)))))


def _segments(curves) -> list[MachinePathSegment]:
    return [MachinePathSegment.cubic(*curve) for curve in curves]


def _metrics(curves, units: float, *, closed: bool = True):
    return analyze_machine_path(
        _segments(curves), mm_to_units=units, closed=closed,
        smooth_join_threshold_degrees=_JOIN_DEGREES,
        short_segment_threshold_mm=0.25, samples_per_cubic=64,
        curvature_samples_per_cubic=31,
    )


def _motion_not_worse(source, candidate, units: float, *, closed: bool = True,
                      global_refit: bool = False, quantized: bool = False) -> bool:
    before, after = _metrics(source, units, closed=closed), _metrics(candidate, units, closed=closed)
    if (after.short_segment_count > before.short_segment_count
            or after.degenerate_segment_count > before.degenerate_segment_count
            or after.disconnected_join_count > before.disconnected_join_count
            or after.discontinuous_join_count > before.discontinuous_join_count
            or after.curvature_sign_flip_count > before.curvature_sign_flip_count):
        return False
    angle_slack = 1e-5
    if global_refit and quantized:
        # Hai control .4f có thể làm góc thay đổi nhẹ dù tangent thực đã ghim.
        # Dùng cận sai số vector, không nới góc hình học của source/candidate.
        def rounding_angle(curves):
            lengths = [math.dist(curve[0], curve[1]) for curve in curves]
            lengths += [math.dist(curve[2], curve[3]) for curve in curves]
            return math.degrees(math.asin(min(1.0, 2 * _WRITER_POINT_ERROR / max(min(lengths), 1e-12))))
        angle_slack = max(angle_slack, 2 * (rounding_angle(source) + rounding_angle(candidate)))
    if (after.maximum_join_angle_degrees or 0.0) > (before.maximum_join_angle_degrees or 0.0) + angle_slack:
        return False
    # QUALITY (audit 2026-09-10 §CUTSIMPLIFY.4): P95 thay đổi mẫu số khi bỏ
    # node; xóa nhiều join có jump gần 0 không được làm candidate bị coi xấu.
    # Refit toàn nhịp kiểm max + tổng jump trên các join trơn, không dùng P95.
    curvature_names = ("maximum_curvature_jump_per_mm",) if global_refit else (
        "maximum_curvature_jump_per_mm", "p95_curvature_jump_per_mm")
    def line_like(curve):
        direction = _sub(curve[3], curve[0])
        length = math.hypot(*direction)
        epsilon = 2 * _WRITER_POINT_ERROR if quantized else 1e-9
        return length > 0 and max(abs(_cross(direction, _sub(curve[i], curve[0]))) for i in (1, 2)) <= length * epsilon
    if global_refit and all(line_like(curve) for curve in source):
        # Curvature của các line bằng 0 nhưng join không phải G2. Không yêu
        # cầu cung thay polyline có curvature 0; góc/inflection vẫn được kiểm.
        curvature_names = ()
    for name in curvature_names:
        if (getattr(after, name) or 0.0) > (getattr(before, name) or 0.0) + _CURVATURE_EPS_PER_MM:
            return False
    if global_refit and curvature_names:
        def total_jump(curves):
            pairs = zip(curves, curves[1:] + curves[:1]) if closed else zip(curves, curves[1:])
            return sum(abs((_curvature(MachinePathSegment.cubic(*a), 1.0, units) or 0.0)
                           - (_curvature(MachinePathSegment.cubic(*b), 0.0, units) or 0.0))
                       for a, b in pairs if _join_angle(a, b) <= _JOIN_DEGREES)
        if total_jump(candidate) > total_jump(source) + _CURVATURE_EPS_PER_MM:
            return False
    return True


def _span_weights(source: tuple[Cubic, ...]) -> list[list[float]]:
    """Thử miền tham số theo đạo hàm và chiều dài; cả hai đều được chứng nhận lại."""
    durations = [1.0]
    for before, after in zip(source, source[1:]):
        speed_before = math.dist(before[3], before[2])
        speed_after = math.dist(after[1], after[0])
        if min(speed_before, speed_after) <= 1e-12:
            durations = []
            break
        durations.append(durations[-1] * speed_after / speed_before)
    lengths = [_segment_length(MachinePathSegment.cubic(*curve), 16) for curve in source]
    result = []
    for values in (durations, lengths):
        total = sum(values)
        if (len(values) == len(source) and math.isfinite(total) and total > 0
                and all(math.isfinite(value) and value > 0 for value in values)):
            normalized = [value / total for value in values]
            if min(normalized) > 1e-12:
                result.append(normalized)
    return result


def _certify_cubic_span(
    source: tuple[Cubic, ...], candidate: Cubic, weights: list[float], tolerance: float,
) -> float | None:
    """Khóa sai lệch hai chiều trên MỌI điểm, so với cubic gốc của từng span."""
    if not source or len(source) != len(weights) or min(weights) <= 0:
        return None
    remaining, consumed, maximum = candidate, 0.0, 0.0
    for index, curve in enumerate(source):
        end = 1.0 if index == len(source) - 1 else consumed + weights[index]
        if not consumed < end <= 1.0:
            return None
        part, remaining = split_cubic(remaining, (end - consumed) / (1.0 - consumed))
        difference = tuple(_sub(a, b) for a, b in zip(part, curve))
        bound = _difference_bound(difference, tolerance)
        if bound is None:
            return None
        maximum = max(maximum, bound)
        consumed = end
    return maximum


def _curve_with_handles(start: Point, end: Point, left: Point, right: Point,
                        alpha: float, beta: float) -> Cubic:
    return (start, (start[0] + alpha * left[0], start[1] + alpha * left[1]),
            (end[0] - beta * right[0], end[1] - beta * right[1]), end)


def _match_endpoint_curvatures(source: tuple[Cubic, ...], seed: Cubic) -> Cubic | None:
    """Giải hai độ dài tay nắm, giữ hướng và độ cong tại hai đầu span.

    Giữ G2 ở hai đầu tránh biến spline C2 nguồn thành các khớp G1 có bước nhảy
    độ cong. Không có nghiệm dương hội tụ thì bỏ ứng viên, không nới ngưỡng.
    """
    left, right = _tangents(seed)
    if left is None or right is None:
        return None
    k0 = _curvature(MachinePathSegment.cubic(*source[0]), 0.0, 1.0)
    k1 = _curvature(MachinePathSegment.cubic(*source[-1]), 1.0, 1.0)
    if k0 is None or k1 is None:
        return None
    delta = _sub(seed[3], seed[0])
    chord = math.hypot(*delta)
    cross_lr = _cross(left, right)
    alpha, beta = math.dist(seed[0], seed[1]), math.dist(seed[2], seed[3])

    def residual(a, b):
        return (1.5 * k0 * a * a + cross_lr * b - _cross(left, delta),
                1.5 * k1 * b * b + cross_lr * a + _cross(right, delta))

    for _ in range(16):
        f0, f1 = residual(alpha, beta)
        if max(abs(f0), abs(f1)) <= 1e-11 * max(1.0, chord):
            return _curve_with_handles(seed[0], seed[3], left, right, alpha, beta)
        a00, a11 = 3.0 * k0 * alpha, 3.0 * k1 * beta
        determinant = a00 * a11 - cross_lr * cross_lr
        if abs(determinant) <= 1e-16:
            return None
        step_a = (a11 * f0 - cross_lr * f1) / determinant
        step_b = (a00 * f1 - cross_lr * f0) / determinant
        improved = False
        for factor in (1.0, 0.5, 0.25, 0.125, 0.0625):
            a, b = alpha - factor * step_a, beta - factor * step_b
            if not (0 < a <= chord and 0 < b <= chord):
                continue
            g0, g1 = residual(a, b)
            if math.hypot(g0, g1) < math.hypot(f0, f1):
                alpha, beta, improved = a, b, True
                break
        if not improved:
            return None
    return None


def _proposals(source: tuple[Cubic, ...], weights: list[float]):
    start, end = source[0][0], source[-1][3]
    left, right = _tangents(source[0])[0], _tangents(source[-1])[1]
    if left is None or right is None:
        return
    inverse = _curve_with_handles(
        start, end, left, right,
        math.dist(source[0][0], source[0][1]) / weights[0],
        math.dist(source[-1][2], source[-1][3]) / weights[-1],
    )
    samples, parameters, consumed = [], [], 0.0
    for curve, duration in zip(source, weights):
        for t in (0.0, 0.25, 0.5, 0.75):
            samples.append(_bezier_point(curve, t))
            parameters.append(consumed + duration * t)
        consumed += duration
    samples.append(end)
    parameters.append(1.0)
    fitted = _generate_fitted_bezier(samples, parameters, left, (-right[0], -right[1]))
    for seed in (inverse, fitted):
        yield seed
        matched = _match_endpoint_curvatures(source, seed)
        if matched is not None:
            yield matched


@dataclass(frozen=True)
class _Span:
    curve: Cubic
    source: tuple[Cubic, ...]
    bound: float = 0.0


def _merge(first: _Span, second: _Span, tolerance: float, units: float,
           preserve_curvature: bool = True) -> _Span | None:
    if _join_angle(first.curve, second.curve) > _JOIN_DEGREES:
        return None
    source = first.source + second.source
    left, right = _tangents(source[0])[0], _tangents(source[-1])[1]
    best = None
    for weights in _span_weights(source):
        for candidate in _proposals(source, weights):
            if not chord_monotone(candidate):
                continue
            actual_left, actual_right = _tangents(candidate)
            if (left is None or right is None or actual_left is None or actual_right is None
                    or math.dist(left, actual_left) > 1e-7 or math.dist(right, actual_right) > 1e-7):
                continue
            if preserve_curvature:
                endpoints_match = True
                for old, t in ((source[0], 0.0), (source[-1], 1.0)):
                    previous = _curvature(MachinePathSegment.cubic(*old), t, units)
                    following = _curvature(MachinePathSegment.cubic(*candidate), t, units)
                    if previous is None or following is None or abs(previous - following) > _CURVATURE_EPS_PER_MM:
                        endpoints_match = False
                        break
                if not endpoints_match:
                    continue
            # Chiều dài polyline nội tiếp là cận dưới độ dài cubic. Dự trữ cả
            # biến thiên độ dài tối đa 6q do .4f, không sinh lệnh ngắn mới.
            if (_segment_length(MachinePathSegment.cubic(*candidate), 64)
                    - 6.0 * _WRITER_POINT_ERROR) / units < 0.25:
                continue
            bound = _certify_cubic_span(source, candidate, weights, tolerance)
            if bound is None or not _motion_not_worse(source, [candidate], units, closed=False):
                continue
            if best is None or bound < best.bound:
                best = _Span(candidate, source, bound)
    return best


def _reduce_ring(
    source: tuple[Cubic, ...],
    tolerance: float,
    units: float,
    *,
    global_refit=True,
    max_candidate_attempts: int = 7,
):
    # PERF (audit 2026-09-11 §PREWARM.CANCEL): hủy job cũ giữa các span,
    # không biến hủy thành fallback chất lượng thấp hoặc kết quả no-op.
    check_preview_cancelled()
    spans = [_Span(curve, (curve,)) for curve in source]
    # C2 thật giữ độ cong hai đầu. Nguồn vốn chỉ G1 được phép đổi tay nắm
    # trong band hình học, nhưng toàn ring vẫn phải có metric độ cong không xấu hơn.
    preserve_curvature = (_metrics(source, units).maximum_curvature_jump_per_mm or 0.0) <= _CURVATURE_EPS_PER_MM
    while True:
        changed, updated, index = False, [], 0
        while index < len(spans):
            check_preview_cancelled()
            candidate = _merge(spans[index], spans[index + 1], tolerance, units, preserve_curvature) if index + 1 < len(spans) else None
            if candidate is not None:
                updated.append(candidate)
                changed, index = True, index + 2
            else:
                updated.append(spans[index])
                index += 1
        spans = updated
        if not changed:
            break
    curves = tuple(span.curve for span in spans)
    if len(curves) >= len(source) or not _motion_not_worse(source, curves, units):
        curves, bound = source, 0.0
    else:
        bound = max(span.bound for span in spans)
    # Dựng nhiều-cubic thành một ứng viên dài với ánh xạ tham số mới rồi chọn
    # đường đi toàn nhịp. Giữ nghiệm cũ nếu không có phương án tốt hơn đạt guard.
    if global_refit:
        from app.workers.cutline_global_simplify import global_refit_ring

        fitted, fitted_bound = global_refit_ring(
            source,
            tolerance,
            units,
            max_candidate_attempts=max_candidate_attempts,
        )
        if len(fitted) < len(curves) and _motion_not_worse(source, fitted, units, global_refit=True):
            curves, bound = fitted, fitted_bound
    return curves, bound


def _rounded_groups(groups, offset_x: float, offset_y: float, page_height: float):
    """Mô phỏng đúng frame writer rồi trả về tọa độ local để so hai path."""
    return [[tuple(tuple((round(point[0] + offset_x, 4) - offset_x,
                          page_height - round(page_height - (point[1] + offset_y), 4) - offset_y)
                         for point in curve) for curve in ring)
             for ring in group] for group in groups]


def _geometry(groups, flat_tolerance: float):
    parts, windings = [], []
    for rings in groups:
        flattened_rings = []
        for ring in rings:
            points = []
            for curve in ring:
                check_preview_cancelled()
                flattened = _flatten(curve, flat_tolerance)
                if flattened is None:
                    return None
                points.extend(flattened[:-1])
            points.append(ring[-1][3])
            flattened_rings.append(points)
            windings.append(Polygon(points).exterior.is_ccw)
        parts.append(Polygon(flattened_rings[0], flattened_rings[1:]))
    geometry = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    if geometry.is_empty or not geometry.is_valid:
        return None
    return geometry, windings


def _normalize(path_groups, units: float):
    groups, maximum_snap = [], 0.0
    for group in path_groups:
        rings = []
        for raw_ring in [group["exterior"], *(group.get("interiors") or [])]:
            if not raw_ring:
                return None
            ring = []
            for raw_curve in raw_ring:
                if len(raw_curve) != 4 or any(len(point) != 2 for point in raw_curve):
                    return None
                curve = tuple((float(point[0]), float(point[1])) for point in raw_curve)
                if not all(math.isfinite(value) for point in curve for value in point):
                    return None
                if ring:
                    gap = math.dist(ring[-1][3], curve[0])
                    if gap > 1e-9 * units:
                        return None
                    maximum_snap = max(maximum_snap, gap)
                    curve = (ring[-1][3], *curve[1:])
                ring.append(curve)
            gap = math.dist(ring[-1][3], ring[0][0])
            if gap > 1e-9 * units:
                return None
            maximum_snap = max(maximum_snap, gap)
            ring[-1] = (*ring[-1][:3], ring[0][0])
            rings.append(tuple(ring))
        groups.append(rings)
    return groups, maximum_snap


def _paths_are_simple(paths):
    """Chỉ chia cho kiểm giao cắt; không biến các mảnh kiểm tra thành node xuất."""
    def pieces(curve, depth=0):
        if chord_monotone(curve):
            return [curve]
        if depth >= 16:
            return None
        first, second = split_cubic(curve, 0.5)
        a, b = pieces(first, depth + 1), pieces(second, depth + 1)
        return a + b if a is not None and b is not None else None

    checked = []
    for path in paths:
        segments = []
        for curve in path:
            check_preview_cancelled()
            parts = pieces(curve)
            if parts is None:
                return False
            segments.extend(parts)
        checked.append(_segments(segments))
    return _continuous_paths_simple(checked)


def _simplify_cubic_path_groups_impl(
    path_groups, *, tolerance_mm, mm_to_units=72.0 / 25.4,
    offset_x_points=0.0, offset_y_points=0.0, page_height=0.0,
    global_refit=True, fair_refit=False, fair_max_irls_rounds=5,
    max_candidate_attempts: int = 7,
):
    """Gộp cục bộ; không giảm an toàn được thì trả chính input không thay đổi.

    Sai số là phần BỔ SUNG so với cubic đầu vào, không thay cho sai số fitter
    so với mask. Dự trữ làm tròn .4f của cả hai path; topology được kiểm trong
    đúng frame translate/flip của writer do caller truyền. Output vẫn local.
    """
    try:
        tolerance_mm, units = float(tolerance_mm), float(mm_to_units)
        offset_x, offset_y, height = float(offset_x_points), float(offset_y_points), float(page_height)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Sai số rút gọn và đơn vị đường bế phải là số hợp lệ") from exc
    if not math.isfinite(tolerance_mm) or not 0.0 <= tolerance_mm <= CUTLINE_SIMPLIFY_MAX_MM:
        raise ValueError("Sai số rút gọn đường bế phải nằm trong 0–0,10 mm")
    if not math.isfinite(units) or units <= 0:
        raise ValueError("Đơn vị đường bế phải hữu hạn và dương")
    if not all(math.isfinite(value) for value in (offset_x, offset_y, height)):
        raise ValueError("Frame ghi đường bế phải có tọa độ hữu hạn")
    try:
        before = sum(len(ring) for group in path_groups for ring in [group["exterior"], *(group.get("interiors") or [])])
    except (TypeError, KeyError, AttributeError):
        before = 0
    stats = {"before_segments": before, "after_segments": before,
             "maximum_error_bound_mm": 0.0, "changed": False}
    if tolerance_mm == 0 or not before:
        return path_groups, stats
    try:
        normalized = _normalize(path_groups, units)
        if normalized is None:
            return path_groups, stats
        source, snap = normalized
        rounding = 2.0 * _WRITER_POINT_ERROR
        budget = tolerance_mm * units - rounding - snap - 1e-9 * units
        if budget <= 0:
            return path_groups, stats
        source_paths = [ring for group in source for ring in group]
        if not _paths_are_simple(source_paths):
            return path_groups, stats
        flat_tolerance = min(budget / 32.0, 1e-4 * units)
        source_geometry = _geometry(source, flat_tolerance)
        if source_geometry is None:
            return path_groups, stats
        candidate, maximum_bound = [], 0.0
        for group in source:
            rings = []
            for ring in group:
                check_preview_cancelled()
                if fair_refit:
                    from app.workers.cutline_fair_simplify import fair_refit_ring, protected_corner_indices
                    from app.workers.cutline_fair_verify import verify_fair_ring
                    import numpy as np

                    physical = np.asarray(ring)/units
                    # C2/chuỗi line không có bước nhảy độ cong để cải thiện;
                    # để nhánh bảo toàn rút các đoạn phân chia, không chạy
                    # optimizer rồi bị chính guard độ cong từ chối.
                    if (_metrics(ring, units).maximum_curvature_jump_per_mm or 0.0) <= _CURVATURE_EPS_PER_MM:
                        fitted, bound_mm = physical, 0.0
                    else:
                        # PERF (audit 2026-09-11 §SIMPLIFY.FAIR-FAST): đường gọi
                        # preview/PDF có thể chọn số lượt IRLS; bộ kiểm độc lập vẫn
                        # chốt toàn bộ sai số, topology và độ cong trước khi nhận.
                        fitted, bound_mm = fair_refit_ring(
                            physical,
                            budget / units,
                            max_irls_rounds=fair_max_irls_rounds,
                            max_nfev=3 if fair_max_irls_rounds < 5 else 35,
                        )
                    if len(fitted) < len(ring):
                        fitted = np.asarray(fitted)*units
                        # Khóa đúng tọa độ pt trước frame writer, kể cả sai số
                        # vài ulp của phép đổi mm -> pt tại góc bắt buộc giữ.
                        for index in protected_corner_indices(physical):
                            knot = int(np.argmin(np.linalg.norm(fitted[:, 0]-ring[index][0], axis=1)))
                            fitted[knot, 0] = ring[index][0]
                            fitted[knot-1, 3] = ring[index][0]
                        reduced = tuple(tuple(tuple(map(float, p)) for p in c) for c in fitted)
                        bound = bound_mm*units
                    else:
                        reduced, bound = ring, 0.0
                else:
                    reduced, bound = _reduce_ring(
                        ring,
                        budget,
                        units,
                        global_refit=global_refit,
                        max_candidate_attempts=max_candidate_attempts,
                    )
                rings.append(reduced)
                maximum_bound = max(maximum_bound, bound)
            candidate.append(rings)
        after = sum(len(ring) for group in candidate for ring in group)
        if after >= before:
            return path_groups, stats
        paths = [ring for group in candidate for ring in group]
        if not _paths_are_simple(paths):
            return path_groups, stats
        geometry = _geometry(candidate, flat_tolerance)
        if (geometry is None or geometry[1] != source_geometry[1]
                or geometry[0].minimum_clearance <= 4.0 * (flat_tolerance + _WRITER_POINT_ERROR)):
            return path_groups, stats
        rounded_source = _rounded_groups(source, offset_x, offset_y, height)
        rounded_candidate = _rounded_groups(candidate, offset_x, offset_y, height)
        rounded_paths = [ring for group in rounded_candidate for ring in group]
        if not _paths_are_simple(rounded_paths):
            return path_groups, stats
        rounded_geometry = _geometry(rounded_candidate, flat_tolerance)
        if (rounded_geometry is None or rounded_geometry[1] != source_geometry[1]
                or rounded_geometry[0].minimum_clearance <= 4.0 * flat_tolerance):
            return path_groups, stats
        rounded_fair_bound = 0.0
        for source_group, old_group, new_group in zip(source, rounded_source, rounded_candidate):
            for original, old, new in zip(source_group, old_group, new_group):
                if old == new:
                    continue
                if fair_refit:
                    # QUALITY (audit 2026-09-10 §FAIR.3): kiểm lại SAU toàn bộ
                    # translate/flip/.4f. Không dùng cận optimizer làm cận PDF.
                    corners = protected_corner_indices(np.asarray(original)/units)
                    old_mm, new_mm = np.asarray(old)/units, np.asarray(new)/units
                    verified = verify_fair_ring(
                        old_mm, new_mm, tolerance_mm=tolerance_mm,
                        protected_vertices=old_mm[list(corners), 0],
                        coordinate_error_mm=_WRITER_POINT_ERROR/units,
                    )
                    if not verified.accepted:
                        return path_groups, stats
                    rounded_fair_bound = max(rounded_fair_bound, verified.maximum_error_bound_mm)
                elif not _motion_not_worse(old, new, units, global_refit=global_refit, quantized=global_refit):
                    return path_groups, stats
        result = []
        for original, rings in zip(path_groups, candidate):
            group = {**original, "exterior": list(rings[0])}
            if "interiors" in original or len(rings) > 1:
                group["interiors"] = [list(ring) for ring in rings[1:]]
            result.append(group)
        return result, {"before_segments": before, "after_segments": after,
                        "maximum_error_bound_mm": rounded_fair_bound if fair_refit else (maximum_bound + snap + rounding) / units,
                        "changed": True}
    except (ImportError, ArithmeticError, AttributeError, IndexError, KeyError, TypeError, ValueError, GEOSException):
        # Hình học không đủ điều kiện không được làm hỏng preview/export cũ.
        return path_groups, stats


@memoized_simplify
def simplify_cubic_path_groups(
    path_groups, *, tolerance_mm, mm_to_units=72.0 / 25.4,
    offset_x_points=0.0, offset_y_points=0.0, page_height=0.0,
    prefer_conservative=False, preview_fast=False,
    max_candidate_attempts: int = 7,
):
    """Neo tự do + độ cong; không đạt thì dùng nhánh bảo toàn đã chứng nhận."""
    check_preview_cancelled()
    try:
        candidate_attempts = max(1, min(7, int(max_candidate_attempts)))
    except (TypeError, ValueError):
        candidate_attempts = 7
    if preview_fast:
        # PERF (audit 2026-09-11 §SIMPLIFY.FAST-EXEC): giảm số vòng Newton
        # trong mỗi cạnh ứng viên khi chạy preview/Execute. Đây chỉ là bước đề
        # xuất; verifier độc lập vẫn chốt toàn bộ band, topology, góc và độ cong.
        candidate_attempts = min(candidate_attempts, 3)
    options = dict(tolerance_mm=tolerance_mm, mm_to_units=mm_to_units,
                   offset_x_points=offset_x_points, offset_y_points=offset_y_points,
                   page_height=page_height, max_candidate_attempts=candidate_attempts)
    if preview_fast:
        # PERF (audit 2026-09-11 §SIMPLIFY.PREVIEW-FAST): lúc kéo slider,
        # mức thấp ưu tiên reducer bảo toàn có chi phí ổn định. Với mức cao,
        # fairing thường là ứng viên duy nhất giảm được node, nên chạy nó
        # trước để không tốn thêm một lượt reducer vô ích.
        if float(tolerance_mm) >= 0.075:
            result, stats = _simplify_cubic_path_groups_impl(
                path_groups, **options, fair_refit=True, fair_max_irls_rounds=3,
            )
            if stats["changed"] or float(tolerance_mm) == 0:
                return result, stats
            return _simplify_cubic_path_groups_impl(
                path_groups, **options, global_refit=True,
            )
        result, stats = _simplify_cubic_path_groups_impl(
            path_groups, **options, global_refit=True,
        )
        if stats["changed"] or float(tolerance_mm) == 0:
            return result, stats
        result, stats = _simplify_cubic_path_groups_impl(
            path_groups, **options, fair_refit=True, fair_max_irls_rounds=3,
        )
        return result, stats
    if prefer_conservative:
        # QUALITY (2026-09-10 §SIMPLIFY.ROUND): Catmull writer có nhiều đoạn
        # ngắn nhưng đã G1; thử rút gọn giữ tangent trước. Không tốn ba nghiệm
        # neo tự do bị loại topology khi nghiệm bảo toàn đã giảm tốt trong band.
        result, stats = _simplify_cubic_path_groups_impl(path_groups, **options)
        if stats["changed"] or float(tolerance_mm) == 0:
            return result, stats
    # Một lượt IRLS là đủ để đề xuất ứng viên cho live preview/PDF; verify cuối
    # vẫn fail-closed. Các caller trực tiếp của impl giữ mặc định 5 lượt để không
    # đổi hợp đồng nghiên cứu/test.
    result, stats = _simplify_cubic_path_groups_impl(
        path_groups,
        **options,
        fair_refit=True,
        fair_max_irls_rounds=3,
    )
    if stats["changed"] or float(tolerance_mm) == 0:
        return result, stats
    # PERF (audit 2026-09-10 §SIMPERF.5): nhánh ưu tiên đã thử chính
    # nguồn/options này trước fair; không giải lại cùng một phương án.
    # Fallback cục bộ bên dưới vẫn cần vì guard khác với nhánh global.
    if not prefer_conservative:
        result, stats = _simplify_cubic_path_groups_impl(path_groups, **options)
        if stats["changed"] or float(tolerance_mm) == 0:
            return result, stats
    return _simplify_cubic_path_groups_impl(path_groups, **options, global_refit=False)
