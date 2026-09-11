"""Kiểm độc lập cubic neo tự do; tọa độ đầu vào luôn theo mm.

QUALITY (audit 2026-09-10 §FAIR.3): solver chỉ đề xuất hình học. Cận sai lệch
liên tục, tự giao và độ cong dưới đây không dùng residual/correspondence của
solver. Caller kiểm lại sau lượng tử writer và kiểm nesting/lỗ của toàn nhóm.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
from shapely import linestrings, points
from shapely.errors import GEOSException
from shapely.strtree import STRtree

from app.workers.cutline_machine_path import MachinePathSegment
from app.workers.cutline_polyline_reduction import (
    _continuous_paths_simple,
    chord_monotone,
    split_cubic,
)


Point = tuple[float, float]
Cubic = tuple[Point, Point, Point, Point]
# Độ sâu là chốt hội tụ số học, không giảm chất lượng theo số node/tài nguyên.
_SUBDIVISION_DEPTH = 24
_CURVATURE_EPS_PER_MM = 1e-6
# Chứng nhận khoảng cách dùng convex-hull của từng cubic. Sai số flatten này
# được cộng vào cận cuối; không phải cap chất lượng hay số node xuất.
_DISTANCE_FLATNESS_DIVISOR = 100.0
_DISTANCE_BINARY_STEPS = 8


@dataclass(frozen=True, slots=True)
class FairCurveMetrics:
    """Số đo độ cong giải tích; không phải chứng nhận động lực học máy bế."""

    maximum_curvature_jump_per_mm: float
    p95_curvature_jump_per_mm: float
    total_curvature_jump_per_mm: float
    total_curvature_variation_per_mm: float
    maximum_abs_curvature_per_mm: float
    maximum_join_angle_degrees: float


@dataclass(frozen=True, slots=True)
class FairRingVerification:
    """Kết quả fail-safe; reason là mã nội bộ, không phải text UI."""

    accepted: bool
    reason: str
    maximum_error_bound_mm: float | None = None
    sampled_maximum_error_mm: float | None = None
    source_metrics: FairCurveMetrics | None = None
    candidate_metrics: FairCurveMetrics | None = None


def _normalize_ring(raw_ring) -> tuple[Cubic, ...] | None:
    try:
        ring = tuple(tuple(tuple(float(value) for value in point) for point in curve)
                     for curve in raw_ring)
        if (not ring or any(len(curve) != 4 or any(len(point) != 2 for point in curve)
                            for curve in ring)
                or not all(math.isfinite(value) for curve in ring for point in curve for value in point)
                or any(a[-1] != b[0] for a, b in zip(ring, ring[1:] + ring[:1]))):
            return None
        return ring
    except (TypeError, ValueError, OverflowError):
        return None


def fair_paths_are_simple(paths_mm) -> bool:
    """Chứng nhận không giao bằng hull, kể cả giữa các ring và tại seam.

    Chỉ chia để kiểm chứng, không thêm node xuất. Đây KHÔNG phải kiểm nesting:
    hai ring rời nhau vẫn có thể đổi quan hệ chứa; caller phải giữ cây lỗ/nhóm.
    """
    def pieces(curve, depth=0):
        if chord_monotone(curve):
            return [curve]
        if depth >= _SUBDIVISION_DEPTH or len(set(curve)) == 1:
            return None
        first, second = split_cubic(curve, 0.5)
        a = pieces(first, depth + 1)
        if a is None:
            return None
        b = pieces(second, depth + 1)
        return a + b if b is not None else None

    try:
        checked = []
        for raw_ring in paths_mm:
            ring = _normalize_ring(raw_ring)
            if ring is None:
                return False
            segments = []
            for curve in ring:
                parts = pieces(curve)
                if parts is None:
                    return False
                segments.extend(MachinePathSegment.cubic(*part) for part in parts)
            checked.append(segments)
        return _continuous_paths_simple(checked)
    except (ArithmeticError, TypeError, ValueError, GEOSException):
        return False


def _segment_distance(point: Point, first: Point, last: Point) -> float:
    delta = (last[0] - first[0], last[1] - first[1])
    squared = delta[0] * delta[0] + delta[1] * delta[1]
    if squared == 0:
        return math.dist(point, first)
    t = max(0.0, min(1.0, ((point[0] - first[0]) * delta[0]
                           + (point[1] - first[1]) * delta[1]) / squared))
    return math.hypot(point[0] - first[0] - t * delta[0],
                      point[1] - first[1] - t * delta[1])


def _flatten_ring(ring, flatness: float, maximum_chord: float):
    result = [ring[0][0]]
    for curve in ring:
        stack = [(curve, 0)]
        while stack:
            part, depth = stack.pop()
            # Khoảng cách tới ĐOẠN chord, không chỉ tới đường thẳng vô hạn:
            # hull nằm trong capsule này => Hausdorff cubic/chord <= flatness.
            if (math.dist(part[0], part[3]) <= maximum_chord
                    and max(_segment_distance(point, part[0], part[3])
                            for point in part[1:3]) <= flatness):
                result.append(part[3])
                continue
            if depth >= _SUBDIVISION_DEPTH:
                return None
            left, right = split_cubic(part, 0.5)
            if left == part or right == part:
                return None
            stack.extend(((right, depth + 1), (left, depth + 1)))
    return np.asarray(result, dtype=float)


def _distance_bound(source, candidate, tolerance_mm: float):
    # Mỗi cubic nằm trong dải ``flatness`` quanh polyline do convex-hull.
    # Vì vậy chỉ cần chứng nhận hai polyline phủ lẫn nhau; không cần ép chord
    # nhỏ 0,01 mm rồi chạy STRtree trên hàng chục nghìn đỉnh.
    flatness = tolerance_mm / _DISTANCE_FLATNESS_DIVISOR
    source_points = _flatten_ring(source, flatness, math.inf)
    candidate_points = _flatten_ring(candidate, flatness, math.inf)
    if source_points is None or candidate_points is None:
        return None

    try:
        source_line = linestrings(source_points)
        candidate_line = linestrings(candidate_points)
        scale = max(1.0, float(np.max(np.abs(source_points))),
                    float(np.max(np.abs(candidate_points))))
        numerical_slack = 128.0 * math.ulp(scale)
        # GEOS buffer là phép phủ trên TOÀN polyline, nên không bỏ sót phần
        # giữa hai đỉnh. Nếu bán kính ban đầu chưa đủ, mở rộng để có một cận
        # hữu hạn ngay cả trường hợp candidate bị từ chối vì vượt dung sai.
        def covered(radius):
            return (candidate_line.buffer(radius, quad_segs=8).covers(source_line)
                    and source_line.buffer(radius, quad_segs=8).covers(candidate_line))

        lower, upper_radius = 0.0, max(float(tolerance_mm), 2.0 * flatness)
        while not covered(upper_radius):
            lower = upper_radius
            upper_radius *= 2.0
            if not math.isfinite(upper_radius):
                return None
        for _ in range(_DISTANCE_BINARY_STEPS):
            middle = (lower + upper_radius) / 2.0
            if covered(middle):
                upper_radius = middle
            else:
                lower = middle
        # Cận khoảng cách liên tục: polyline phủ nhau ở r, mỗi cubic lệch
        # thêm nhiều nhất flatness ở mỗi phía. Không gọi đây là interval
        # arithmetic proof hoặc sai số tổng từ artwork raster trước trace.
        upper = math.nextafter(upper_radius + 2.0 * flatness + numerical_slack,
                               math.inf)
        # Chỉ dùng STRtree trên polyline đã thưa để ghi lại số đo tham khảo;
        # acceptance vẫn dựa trên cận buffer ở trên.
        def sampled_distance(first, second):
            tree = STRtree(linestrings(np.stack((second[:-1], second[1:]), axis=1)))
            distances = tree.query_nearest(points(first), return_distance=True,
                                            all_matches=False)[1]
            return float(np.max(distances))

        sampled = max(sampled_distance(source_points, candidate_points),
                      sampled_distance(candidate_points, source_points))
        # Với candidate gần như trùng nguồn, polyline thưa có thể phóng đại
        # số đo do hai lần flatten rơi khác đỉnh (đặc biệt khi một cubic chỉ
        # là phép chia de Casteljau của cubic kia). Chỉ ca này mới cần mẫu
        # dày cũ để báo số đo tham khảo; cận buffer ở trên vẫn là quyết định.
        if upper <= float(tolerance_mm) * 0.25:
            precise_flatness = tolerance_mm / 2000.0
            precise_chord = tolerance_mm / 10.0
            precise_source = _flatten_ring(source, precise_flatness, precise_chord)
            precise_candidate = _flatten_ring(candidate, precise_flatness, precise_chord)
            if precise_source is not None and precise_candidate is not None:
                sampled = max(sampled_distance(precise_source, precise_candidate),
                              sampled_distance(precise_candidate, precise_source))
        return sampled, upper
    except (ArithmeticError, TypeError, ValueError, GEOSException):
        return None


def _signed_area(ring) -> float:
    origin = np.asarray(ring[0][0])
    integrals = []
    for curve in ring:
        c = np.asarray(curve) - origin
        power = np.asarray([c[0], 3 * (c[1] - c[0]),
                            3 * (c[2] - 2 * c[1] + c[0]),
                            c[3] - 3 * c[2] + 3 * c[1] - c[0]])
        polynomial = np.polynomial.polynomial.polysub(
            np.polynomial.polynomial.polymul(power[:, 0], power[1:, 1] * np.arange(1, 4)),
            np.polynomial.polynomial.polymul(power[:, 1], power[1:, 0] * np.arange(1, 4)),
        )
        integrals.append(float(np.sum(polynomial / np.arange(1, len(polynomial) + 1))) / 2.0)
    return math.fsum(integrals)


def _unit_roots(coefficients):
    coefficients = np.asarray(coefficients, dtype=float)
    scale = float(np.max(np.abs(coefficients)))
    if scale == 0:
        return []
    roots = np.polynomial.polynomial.polyroots(coefficients / scale)
    return sorted(float(root.real) for root in roots
                  if abs(root.imag) <= 1e-8 and 0 < root.real < 1)


def _curve_curvature(curve):
    """Tìm cực trị κ bằng nghiệm đa thức κ', không bỏ sót spike giữa mẫu."""
    c = np.asarray(curve)
    a = 3 * (c[1] - c[0])
    b = 6 * (c[2] - 2 * c[1] + c[0])
    d = 3 * (c[3] - 3 * c[2] + 3 * c[1] - c[0])
    cross = lambda u, v: float(u[0] * v[1] - u[1] * v[0])
    numerator = np.asarray([cross(a, b), 2 * cross(a, d), cross(b, d)])
    squared_speed = np.asarray([a @ a, 2 * (a @ b), b @ b + 2 * (a @ d),
                                2 * (b @ d), d @ d])
    derivative_speed = np.polynomial.polynomial.polyder(squared_speed)
    for t in [0.0, 1.0, *_unit_roots(derivative_speed)]:
        velocity = a + b * t + d * t * t
        if float(velocity @ velocity) <= 1e-24:
            return None
    stationary = np.polynomial.polynomial.polysub(
        np.polynomial.polynomial.polymul(np.polynomial.polynomial.polyder(numerator), squared_speed),
        1.5 * np.polynomial.polynomial.polymul(numerator, derivative_speed),
    )
    parameters = [0.0, *_unit_roots(stationary), 1.0]
    values = []
    for t in parameters:
        velocity = a + b * t + d * t * t
        acceleration = b + 2 * d * t
        values.append(cross(velocity, acceleration) / float(velocity @ velocity) ** 1.5)
    if not all(math.isfinite(value) for value in values):
        return None
    return values[0], values[-1], max(abs(value) for value in values), sum(
        abs(second - first) for first, second in zip(values, values[1:]))


def _curve_metrics(ring, protected_vertices) -> FairCurveMetrics | None:
    curvatures = [_curve_curvature(curve) for curve in ring]
    if any(item is None for item in curvatures):
        return None
    jumps, angles = [], []
    for index, (before, after) in enumerate(zip(ring, ring[1:] + ring[:1])):
        incoming = np.asarray(before[3]) - before[2]
        outgoing = np.asarray(after[1]) - after[0]
        cosine = float((incoming @ outgoing) / (np.linalg.norm(incoming) * np.linalg.norm(outgoing)))
        angles.append(math.degrees(math.acos(max(-1.0, min(1.0, cosine)))))
        if after[0] not in protected_vertices:
            jumps.append(abs(curvatures[index][1] - curvatures[(index + 1) % len(ring)][0]))
    total_jump = math.fsum(jumps)
    return FairCurveMetrics(
        max(jumps, default=0.0), float(np.percentile(jumps, 95)) if jumps else 0.0,
        total_jump, total_jump + math.fsum(item[3] for item in curvatures),
        max(item[2] for item in curvatures), max(angles, default=0.0),
    )


def _motion_improves(before: FairCurveMetrics, after: FairCurveMetrics) -> bool:
    # Không gate P95 theo cùng mẫu số khi số join đã giảm. Max + tổng jump +
    # biến thiên nội đoạn chặn việc ít node nhưng tăng gợn. Giữ các góc thật
    # qua protected_vertices; không ép G2 xuyên góc hoặc cấm mọi inflection.
    for name in ("maximum_curvature_jump_per_mm", "total_curvature_jump_per_mm",
                 "total_curvature_variation_per_mm", "maximum_abs_curvature_per_mm"):
        if getattr(after, name) > getattr(before, name) + _CURVATURE_EPS_PER_MM:
            return False
    return after.maximum_join_angle_degrees <= max(1.0, before.maximum_join_angle_degrees + 0.05)


def _protected_tangents_match(source, candidate, protected, coordinate_error_mm):
    def vectors(ring, index):
        anchor = np.asarray(ring[index][0])
        return anchor - ring[index - 1][2], np.asarray(ring[index][1]) - anchor

    source_indices = {curve[0]: index for index, curve in enumerate(source)}
    candidate_indices = {curve[0]: index for index, curve in enumerate(candidate)}
    for vertex in protected:
        old_vectors = vectors(source, source_indices[vertex])
        new_vectors = vectors(candidate, candidate_indices[vertex])
        for old, new in zip(old_vectors, new_vectors):
            old_length, new_length = float(np.linalg.norm(old)), float(np.linalg.norm(new))
            vector_error = 2.0 * coordinate_error_mm
            if min(old_length, new_length) <= max(vector_error, 1e-12):
                return False
            # Hai đầu vector mỗi đầu lệch <=q => vector lệch <=2q. Góc giữa
            # hướng trước/sau lượng tử bị chặn bởi asin(2q/|vector|), cộng
            # cận của cả source/candidate; q=0 giữ hướng thật, không nới 1°.
            allowance = math.degrees(math.asin(vector_error / old_length)
                                    + math.asin(vector_error / new_length)) + 1e-6
            cross = float(old[0] * new[1] - old[1] * new[0])
            difference = math.degrees(math.atan2(abs(cross), float(old @ new)))
            if difference > allowance:
                return False
    return True


def _protected_order_matches(source, candidate, protected):
    old = tuple(curve[0] for curve in source if curve[0] in protected)
    new = tuple(curve[0] for curve in candidate if curve[0] in protected)
    if len(old) != len(new):
        return False
    if not old:
        return True
    # Cho phép chuyển seam, không cho solver ghé các góc thật theo thứ tự khác.
    start = new.index(old[0])
    return old == new[start:] + new[:start]


def verify_fair_ring(
    source_mm, candidate_mm, *, tolerance_mm: float, protected_vertices=(),
    require_motion_improvement: bool = True, coordinate_error_mm: float = 0.0,
) -> FairRingVerification:
    """Kiểm một ring so với nguồn bất biến, không snap/làm tròn/sửa input.

    Các góc được truyền bằng tọa độ neo chính xác trong CÙNG frame với hai
    ring. Caller phải giữ số ring/cây lỗ, kiểm giao chéo toàn nhóm, và gọi lại
    với cubic đã lượng tử đúng writer. coordinate_error_mm là cận Euclid q
    mỗi điểm do writer, chỉ dùng dự trữ góc tay nắm. accepted chỉ chứng nhận
    ring này; cận khoảng cách vẫn đo hai ring thực sự đã truyền vào.
    """
    try:
        tolerance_mm = float(tolerance_mm)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Sai số làm mượt phải là số hợp lệ") from exc
    if not math.isfinite(tolerance_mm) or not 0.0 < tolerance_mm <= 0.1:
        raise ValueError("Sai số làm mượt phải nằm trong (0–0,10] mm")
    try:
        coordinate_error_mm = float(coordinate_error_mm)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Sai số tọa độ writer phải là số hợp lệ") from exc
    if not math.isfinite(coordinate_error_mm) or not 0 <= coordinate_error_mm <= tolerance_mm:
        raise ValueError("Sai số tọa độ writer phải không âm và không vượt dung sai")
    source, candidate = _normalize_ring(source_mm), _normalize_ring(candidate_mm)
    if source is None or candidate is None:
        return FairRingVerification(False, "invalid_or_open_ring")
    try:
        protected = frozenset(tuple(float(value) for value in point) for point in protected_vertices)
        if any(len(point) != 2 or not all(math.isfinite(value) for value in point) for point in protected):
            return FairRingVerification(False, "invalid_protected_vertex")
        if (not protected.issubset({curve[0] for curve in source})
                or not protected.issubset({curve[0] for curve in candidate})):
            return FairRingVerification(False, "protected_vertex_moved")
        if not fair_paths_are_simple([source]):
            return FairRingVerification(False, "source_topology_uncertified")
        if not fair_paths_are_simple([candidate]):
            return FairRingVerification(False, "candidate_topology_uncertified")
        if not _protected_order_matches(source, candidate, protected):
            return FairRingVerification(False, "protected_vertex_order_changed")
        if not _protected_tangents_match(source, candidate, protected, coordinate_error_mm):
            return FairRingVerification(False, "protected_tangent_changed")
        source_area, candidate_area = _signed_area(source), _signed_area(candidate)
        if (not math.isfinite(source_area) or not math.isfinite(candidate_area)
                or source_area == 0 or candidate_area == 0
                or (source_area > 0) != (candidate_area > 0)):
            return FairRingVerification(False, "winding_changed")
        before, after = _curve_metrics(source, protected), _curve_metrics(candidate, protected)
        if before is None or after is None:
            return FairRingVerification(False, "curvature_uncertified")
        if require_motion_improvement and not _motion_improves(before, after):
            return FairRingVerification(False, "motion_not_improved", source_metrics=before, candidate_metrics=after)
        measured = _distance_bound(source, candidate, tolerance_mm)
        if measured is None:
            return FairRingVerification(False, "distance_unresolved", source_metrics=before, candidate_metrics=after)
        sampled, upper = measured
        return FairRingVerification(
            upper <= tolerance_mm, "accepted" if upper <= tolerance_mm else "distance_exceeded",
            upper, sampled, before, after,
        )
    except (ArithmeticError, TypeError, ValueError, GEOSException, np.linalg.LinAlgError):
        return FairRingVerification(False, "numerical_failure")
