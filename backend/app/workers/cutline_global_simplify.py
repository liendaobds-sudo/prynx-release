"""Dựng lại nhịp cong rồi chọn ít đoạn trong đồ thị ứng viên đã chứng nhận.

QUALITY (audit 2026-09-10 §CUTSIMPLIFY.4): dùng đường vector bất biến, không
trace lại raster. Flatten chỉ là cầu nối có cận sai số; mọi cạnh của đồ thị
được kiểm liên tục tới cầu nối đó, không tin riêng sai số tại điểm lấy mẫu.
"""

from __future__ import annotations

import math

import numpy as np
from app.workers.cutline_preview_cancel import check_preview_cancelled

from app.workers.cutline_polyline_reduction import (
    _flatten,
    certify_polyline_curve,
    chord_monotone,
)


_CORNER_DEGREES = 45.0


def _unit(vector):
    length = float(np.linalg.norm(vector))
    return vector / length if length > 1e-12 else None


def _angle(a, b):
    if a is None or b is None:
        return 180.0
    return math.degrees(math.acos(float(np.clip(np.dot(a, b), -1.0, 1.0))))


def _fit(points, parameters, left, right):
    """Bình phương tối thiểu hai tay nắm, ghim đầu/cuối và hướng tiếp tuyến."""
    t = parameters
    u = 1.0 - t
    b1, b2 = 3.0 * t * u * u, 3.0 * t * t * u
    b0, b3 = u ** 3, t ** 3
    start, end = points[0], points[-1]
    residual = points - (b0 + b1)[:, None] * start - (b2 + b3)[:, None] * end
    a0, a1 = b1[:, None] * left, -b2[:, None] * right
    c00, c01, c11 = float(np.sum(a0 * a0)), float(np.sum(a0 * a1)), float(np.sum(a1 * a1))
    x0, x1 = float(np.sum(a0 * residual)), float(np.sum(a1 * residual))
    determinant = c00 * c11 - c01 * c01
    chord = float(np.linalg.norm(end - start))
    if determinant > 1e-18:
        alpha = (x0 * c11 - x1 * c01) / determinant
        beta = (c00 * x1 - c01 * x0) / determinant
    else:
        alpha = beta = chord / 3.0
    if min(alpha, beta) <= 1e-9 or max(alpha, beta) > chord:
        return None
    curve = (tuple(start), tuple(start + alpha * left), tuple(end - beta * right), tuple(end))
    return curve if chord_monotone(curve) else None


def _evaluate(curve, t):
    c = np.asarray(curve)
    u = 1.0 - t
    position = (u ** 3)[:, None] * c[0] + (3 * u * u * t)[:, None] * c[1] + (3 * u * t * t)[:, None] * c[2] + (t ** 3)[:, None] * c[3]
    velocity = (3 * u * u)[:, None] * (c[1] - c[0]) + (6 * u * t)[:, None] * (c[2] - c[1]) + (3 * t * t)[:, None] * (c[3] - c[2])
    acceleration = (6 * u)[:, None] * (c[2] - 2 * c[1] + c[0]) + (6 * t)[:, None] * (c[3] - 2 * c[2] + c[1])
    return position, velocity, acceleration


def _candidate(points, left, right, tolerance, *, max_attempts: int = 7):
    check_preview_cancelled()
    # Dịch gốc trước phép tính để giảm triệt tiêu trên trang có tọa độ lớn.
    origin = points[0].copy()
    # PERF (audit 2026-09-10 §SIMPERF.1): chỉ dựng dữ liệu sau khi qua
    # điều kiện cần; không đổi tham số, lượt Newton hoặc thứ tự chọn cạnh.
    if len(points) < 3:
        return None
    chord = _unit(points[-1] - origin)
    if chord is None or min(float(np.dot(left, chord)), float(np.dot(right, chord))) <= 1e-5:
        return None
    local = points - origin
    # PERF (audit 2026-09-10 §CUTSIMPLIFY.4): mọi candidate được nhận đều
    # tiến đơn điệu dọc chord. Nguồn lùi quá 2ε hoặc ra ngoài [0,L] quá ε
    # không thể ghép qua ánh xạ tăng trong band; loại bằng chứng hình học này
    # trước Newton, không cắt số node hay số ứng viên theo tài nguyên.
    projection = local @ chord
    if (float(projection.min()) < -tolerance
            or float(projection.max()) > float(np.linalg.norm(local[-1])) + tolerance
            or float((np.maximum.accumulate(projection) - projection).max()) > 2.0 * tolerance):
        return None
    # _fit chỉ nhận 0<alpha,beta<=L. Hull của mọi cubic có thể nhận nằm
    # trong hull {P0,P3,P0+L*left,P3-L*right}; nguồn ngoài một trong hai
    # dải pháp tuyến mở rộng ε không thể được chứng nhận. Dự trữ ulp và
    # độ dài pháp tuyến thật để không loại nghiệm hợp lệ do làm tròn số.
    chord_length = float(np.linalg.norm(local[-1]))
    normals = np.array([[-left[1], left[0]], [-right[1], right[0]]])
    possible = np.array([[0.0, 0.0], local[-1], chord_length * left,
                         local[-1] - chord_length * right]) @ normals.T
    projected = local @ normals.T
    slack = 256.0 * math.ulp(max(1.0, float(np.max(np.abs(local))), chord_length))
    allowance = tolerance * np.linalg.norm(normals, axis=1) + slack
    if (np.any(projected.min(axis=0) < possible.min(axis=0) - allowance)
            or np.any(projected.max(axis=0) > possible.max(axis=0) + allowance)):
        return None
    lengths = np.linalg.norm(np.diff(local, axis=0), axis=1)
    if np.any(lengths <= 1e-12):
        return None
    parameters = np.r_[0.0, np.cumsum(lengths)]
    parameters /= parameters[-1]
    source = None
    try:
        attempts = max(1, min(7, int(max_attempts)))
    except (TypeError, ValueError):
        attempts = 7
    for attempt in range(attempts):
        check_preview_cancelled()
        curve = _fit(local, parameters, left, right)
        if curve is None:
            return None
        positions, first, second = _evaluate(curve, parameters)
        residual = positions - local
        measured = float(np.linalg.norm(residual, axis=1).max())
        if measured <= tolerance:
            if source is None:
                source = [tuple(point) for point in local]
            bound = certify_polyline_curve(source, curve, parameters.tolist(), tolerance)
            if bound is not None:
                translated = tuple(tuple(np.asarray(point) + origin) for point in curve)
                translated = (tuple(points[0]), translated[1], translated[2], tuple(points[-1]))
                return translated, bound
        if attempt == attempts - 1:
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


def _shortest_path(count, candidate_at):
    """Quy hoạch động trên DAG: không dừng vì một cạnh ngắn hơn bị từ chối.

    Cạnh nguồn i→i+1 luôn có sẵn. Tối ưu số cạnh trong tập xét; không tuyên bố
    tối ưu trên mọi đường Bézier hoặc mọi vị trí neo ngoài đồ thị này.
    """
    costs = [count + 1] * count + [0]
    choices = [None] * count
    for start in range(count - 1, -1, -1):
        # PERF (audit 2026-09-11 §PREWARM.CANCEL): giải phóng worker nóng
        # khi thanh kéo đã sang bộ thông số mới, không xét hết DAG đã cũ.
        check_preview_cancelled()
        costs[start] = costs[start + 1] + 1
        choices[start] = (start + 1, None)
        for end in range(count, start + 1, -1):
            check_preview_cancelled()
            if costs[end] + 1 >= costs[start]:
                continue
            candidate = candidate_at(start, end)
            if candidate is not None:
                costs[start] = costs[end] + 1
                choices[start] = (end, candidate)
    return choices, costs[0]


def global_refit_ring(source, tolerance, units, *, max_candidate_attempts: int = 7):
    """Trả candidate và cận bổ sung; các guard toàn ring vẫn thuộc caller."""
    check_preview_cancelled()
    count = len(source)
    if count < 3 or tolerance <= 0:
        return source, 0.0
    values = np.asarray(source, dtype=np.float64)
    incoming = [_unit(curve[3] - curve[2]) for curve in values]
    outgoing = [_unit(curve[1] - curve[0]) for curve in values]
    turns = [_angle(incoming[i - 1], outgoing[i]) for i in range(count)]
    corners = [i for i, turn in enumerate(turns)
               if turn >= _CORNER_DEGREES or (
                   turn >= 5.0 and max(turns[i - 1], turns[(i + 1) % count]) <= turn * 0.15)]
    # Góc nhẹ nhưng cô lập giữa hai phía trơn vẫn được ghim. Chuỗi đổi hướng
    # nhỏ lặp đều của polygon bậc thang không bị khóa tất cả thành corner giả.
    # Điểm trên chuỗi line không phải corner chỉ là mẫu của đường cong.
    # Cùng một tangent hai phía ở đây để các cạnh DP gặp nhau thành G1.
    # Cubic có tangent sẵn vẫn giữ nguyên hướng gốc.
    line_like = []
    for curve in values:
        delta = curve[3] - curve[0]
        chord = float(np.linalg.norm(delta))
        cross = lambda v: delta[0] * v[1] - delta[1] * v[0]
        line_like.append(chord > 0 and max(abs(cross(curve[1] - curve[0])), abs(cross(curve[2] - curve[0]))) <= 1e-9 * chord)
    for i in range(count):
        if i not in corners and line_like[i - 1] and line_like[i] and incoming[i - 1] is not None and outgoing[i] is not None:
            shared = _unit(incoming[i - 1] + outgoing[i])
            incoming[i - 1] = outgoing[i] = shared
    cuts = sorted(set([0, count, *corners]))
    flatten_error = min(tolerance / 16.0, 0.001 * units)
    flattened = []
    for curve in source:
        check_preview_cancelled()
        points = _flatten(curve, flatten_error)
        if points is None:
            return source, 0.0
        # Một line dài vẫn phải có mẫu nội đoạn để fit không bị thiếu phương trình.
        if len(points) == 2:
            a, b = np.asarray(points[0]), np.asarray(points[1])
            points = [tuple(a), tuple((2 * a + b) / 3), tuple((a + 2 * b) / 3), tuple(b)]
        flattened.append(points)
    result, maximum = [], 0.0
    for start, end in zip(cuts, cuts[1:]):
        points, boundaries = [], [0]
        for index in range(start, end):
            points.extend(flattened[index][:-1])
            boundaries.append(len(points))
        points.append(flattened[end - 1][-1])
        points = np.asarray(points)

        def candidate_at(first, last):
            left, right = outgoing[start + first], incoming[start + last - 1]
            if left is None or right is None:
                return None
            # Hướng tại các điểm nối kỹ thuật giữ G1 của source. Góc thật chỉ
            # nằm ở ranh giới cuts nên không có candidate nối tắt qua góc đó.
            local = points[boundaries[first]:boundaries[last] + 1]
            return _candidate(
                local,
                left,
                right,
                tolerance - flatten_error,
                max_attempts=max_candidate_attempts,
            )

        choices, reduced_count = _shortest_path(end - start, candidate_at)
        if reduced_count >= end - start:
            result.extend(source[start:end])
            continue
        cursor = 0
        while cursor < end - start:
            following, candidate = choices[cursor]
            if candidate is None:
                result.append(source[start + cursor])
            else:
                curve, bound = candidate
                result.append(curve)
                maximum = max(maximum, bound + flatten_error)
            cursor = following
    return tuple(result), maximum
