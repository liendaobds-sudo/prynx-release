"""Rút gọn polyline bế trong hành lang sai số, không dựng lại silhouette.

QUALITY (audit 2026-09-09 §BINDER2.4): curve fitting chỉ tạo ứng viên. Mỗi
ứng viên phải có chứng nhận khoảng cách liên tục tới chuỗi nguồn bất biến;
đoạn không đạt giữ nguyên line, không cộng dồn sai số qua nhiều lượt gộp.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

from shapely.geometry import MultiPoint, MultiPolygon, Polygon, box
from shapely.strtree import STRtree

from app.workers.cutline_geometry import (
    _bezier_point,
    _chord_length_parameters,
    _generate_fitted_bezier,
    _linear_cubic_segment,
    _newton_reparameterize,
)
from app.workers.cutline_machine_path import MachinePathSegment, analyze_machine_path


Point = tuple[float, float]
Cubic = tuple[Point, Point, Point, Point]
_CORNER_DEGREES = 45.0
_SUBDIVISION_DEPTH = 16


def split_cubic(curve: Cubic, t: float) -> tuple[Cubic, Cubic]:
    """Chia chính xác một cubic bằng de Casteljau, không lấy mẫu xấp xỉ."""
    layers = [list(curve)]
    for _ in range(3):
        layers.append([
            (a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t)
            for a, b in zip(layers[-1], layers[-1][1:])
        ])
    return tuple(layer[0] for layer in layers), tuple(layer[-1] for layer in reversed(layers))


def _difference_bound(controls: Cubic, tolerance: float, depth: int = 0) -> float | None:
    upper = max(math.hypot(*point) for point in controls)
    if upper <= tolerance:
        return upper
    if max(math.hypot(*controls[0]), math.hypot(*controls[-1]),
           math.hypot(*_bezier_point(controls, 0.5))) > tolerance:
        return None
    if depth >= _SUBDIVISION_DEPTH:
        # Giới hạn hội tụ số học: không chứng minh được thì KHÔNG nhận.
        return None
    first, second = split_cubic(controls, 0.5)
    a = _difference_bound(first, tolerance, depth + 1)
    b = _difference_bound(second, tolerance, depth + 1) if a is not None else None
    return max(a, b) if a is not None and b is not None else None


def certify_polyline_curve(
    points: list[Point], curve: Cubic, parameters: list[float], tolerance: float,
) -> float | None:
    """Cận hai chiều liên tục qua ánh xạ tăng, không chỉ kiểm điểm neo.

    Mỗi đoạn nguồn là cubic nâng bậc chính xác. Hiệu của nó với một khoảng
    tham số cubic ứng viên nằm trong convex hull các control point hiệu.
    Các khoảng phủ toàn [0,1] nên chứng nhận áp dụng cho cả hai chiều.
    """
    if len(points) != len(parameters) or len(points) < 2 or not math.isfinite(tolerance) or tolerance < 0:
        return None
    if not all(math.isfinite(value) for point in [*points, *curve] for value in point):
        return None
    if parameters[0] != 0.0 or parameters[-1] != 1.0:
        return None
    if not all(math.isfinite(value) for value in parameters):
        return None
    if any(b <= a for a, b in zip(parameters, parameters[1:])):
        return None
    remaining = curve
    previous = 0.0
    maximum = 0.0
    for index, following in enumerate(parameters[1:]):
        fraction = (following - previous) / (1.0 - previous)
        part, remaining = split_cubic(remaining, min(1.0, fraction))
        source = _linear_cubic_segment(points[index], points[index + 1])
        difference = tuple((a[0] - b[0], a[1] - b[1]) for a, b in zip(part, source))
        bound = _difference_bound(difference, tolerance)
        if bound is None:
            return None
        maximum = max(maximum, bound)
        previous = following
    return maximum


def _unit(dx: float, dy: float) -> Point:
    length = math.hypot(dx, dy)
    return (dx / length, dy / length) if length > 1e-12 else (0.0, 0.0)


def chord_monotone(curve: Cubic) -> bool:
    """Chặn loop/cusp cục bộ, kể cả loop nhỏ vẫn nằm trong dung sai."""
    direction = _unit(curve[3][0] - curve[0][0], curve[3][1] - curve[0][1])
    if direction == (0.0, 0.0):
        return False
    projections = [
        (b[0] - a[0]) * direction[0] + (b[1] - a[1]) * direction[1]
        for a, b in zip(curve, curve[1:])
    ]
    return min(projections) >= 0.0 and projections[0] > 1e-12 and projections[-1] > 1e-12


def _flatten(curve: Cubic, tolerance: float, depth: int = 0) -> list[Point] | None:
    chord = _linear_cubic_segment(curve[0], curve[-1])
    if max(math.dist(a, b) for a, b in zip(curve, chord)) <= tolerance:
        return [curve[0], curve[-1]]
    if depth >= _SUBDIVISION_DEPTH:
        return None
    left, right = split_cubic(curve, 0.5)
    a = _flatten(left, tolerance, depth + 1)
    b = _flatten(right, tolerance, depth + 1) if a is not None else None
    return a[:-1] + b if a is not None and b is not None else None


def _segment_curve(segment: MachinePathSegment) -> Cubic:
    return segment.p0, segment.p1, segment.p2, segment.p3


def _angle(before: Point, center: Point, after: Point) -> float:
    u = _unit(center[0] - before[0], center[1] - before[1])
    v = _unit(after[0] - center[0], after[1] - center[1])
    return math.degrees(math.acos(max(-1.0, min(1.0, u[0] * v[0] + u[1] * v[1]))))


def _fit_ring(coords, tolerance: float):
    points = [(float(x), float(y)) for x, y in coords]
    if points and points[0] == points[-1]:
        points.pop()
    if len(points) < 3 or not all(math.isfinite(v) for point in points for v in point):
        return None
    if any(math.dist(a, b) <= 1e-12 for a, b in zip(points, points[1:] + points[:1])):
        return None
    original = [MachinePathSegment.line(a, b) for a, b in zip(points, points[1:] + points[:1])]
    corners = {index for index, point in enumerate(points)
               if _angle(points[index - 1], point, points[(index + 1) % len(points)]) >= _CORNER_DEGREES}

    # Pin cả seam: không đổi điểm bắt đầu đường chạy của máy.
    cuts = sorted(corners | {0})
    if len(cuts) == 1:
        cuts.append(max(range(1, len(points)), key=lambda i: math.dist(points[0], points[i])))
    result = []
    maximum_bound = 0.0
    for index, start in enumerate(cuts):
        end = cuts[(index + 1) % len(cuts)]
        chain = points[start:end + 1] if end > start else points[start:] + points[:end + 1]
        cursor = 0
        chain_output = []
        chain_bound = 0.0
        while cursor < len(chain) - 1:
            best = None
            total_turn = 0.0
            for stop in range(cursor + 2, len(chain)):
                total_turn += _angle(chain[stop - 2], chain[stop - 1], chain[stop])
                # Một cubic chord-monotone không được ôm vòng hoặc nắn xuyên
                # nhiều khúc đổi hướng; ngắt span theo hình học, không cap node.
                if total_turn >= 120.0:
                    break
                source = chain[cursor:stop + 1]
                samples = []
                for a, b in zip(source, source[1:]):
                    samples.extend((a, ((2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3),
                                    ((a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3)))
                samples.append(source[-1])
                left = _unit(source[1][0] - source[0][0], source[1][1] - source[0][1])
                right = _unit(source[-2][0] - source[-1][0], source[-2][1] - source[-1][1])
                parameters = _chord_length_parameters(samples)
                curve = _generate_fitted_bezier(samples, parameters, left, right)
                bound = None
                for attempt in range(5):
                    if not chord_monotone(curve):
                        break
                    actual_left = _unit(curve[1][0] - curve[0][0], curve[1][1] - curve[0][1])
                    actual_right = _unit(curve[2][0] - curve[3][0], curve[2][1] - curve[3][1])
                    if math.dist(actual_left, left) > 1e-7 or math.dist(actual_right, right) > 1e-7:
                        break
                    bound = certify_polyline_curve(samples, curve, parameters, tolerance)
                    if bound is not None:
                        break
                    if attempt == 4:
                        break
                    updated = [0.0] + [_newton_reparameterize(curve, p, t)
                                     for p, t in zip(samples[1:-1], parameters[1:-1])] + [1.0]
                    if any(b <= a for a, b in zip(updated, updated[1:])):
                        break
                    parameters = updated
                    curve = _generate_fitted_bezier(samples, parameters, left, right)
                if bound is not None:
                    best = (stop, curve, bound)
                elif best is not None:
                    break
            if best is None:
                chain_output.append(MachinePathSegment.line(chain[cursor], chain[cursor + 1]))
                cursor += 1
            else:
                cursor, curve, bound = best
                chain_output.append(MachinePathSegment.cubic(*curve))
                chain_bound = max(chain_bound, bound)
        if len(chain_output) >= len(chain) - 1:
            chain_output = [MachinePathSegment.line(a, b) for a, b in zip(chain, chain[1:])]
            chain_bound = 0.0
        result.extend(chain_output)
        maximum_bound = max(maximum_bound, chain_bound)
    if len(result) >= len(original):
        return original, 0.0
    return result, maximum_bound


@dataclass
class PolylineReduction:
    paths: list[list[MachinePathSegment]]
    original_segments: int
    reduced_segments: int
    maximum_error_mm: float


def _bounds(curve):
    return min(p[0] for p in curve), min(p[1] for p in curve), max(p[0] for p in curve), max(p[1] for p in curve)


def _endpoint_separator(first: Cubic, second: Cubic) -> bool:
    """Hai convex hull chỉ gặp tại endpoint chung, không bỏ qua cả cặp kề."""
    if first[-1] != second[0]:
        return False
    joint = first[-1]
    incoming = _unit(joint[0] - first[-2][0], joint[1] - first[-2][1])
    outgoing = _unit(second[1][0] - joint[0], second[1][1] - joint[1])
    normal = _unit(incoming[0] + outgoing[0], incoming[1] + outgoing[1])
    if normal == (0.0, 0.0):
        return False
    projection = lambda p: (p[0] - joint[0]) * normal[0] + (p[1] - joint[1]) * normal[1]
    return max(projection(p) for p in first[:-1]) < -1e-10 and min(projection(p) for p in second[1:]) > 1e-10


def _curves_disjoint(first: Cubic, second: Cubic, adjacent: bool, depth: int = 0) -> bool:
    a, b = _bounds(first), _bounds(second)
    if a[2] < b[0] - 1e-10 or b[2] < a[0] - 1e-10 or a[3] < b[1] - 1e-10 or b[3] < a[1] - 1e-10:
        return True
    if adjacent and _endpoint_separator(first, second):
        return True
    if MultiPoint(first).convex_hull.distance(MultiPoint(second).convex_hull) > 1e-10:
        return True
    if depth >= _SUBDIVISION_DEPTH:
        return False
    if max(a[2] - a[0], a[3] - a[1]) >= max(b[2] - b[0], b[3] - b[1]):
        left, right = split_cubic(first, 0.5)
        return (_curves_disjoint(left, second, False, depth + 1)
                and _curves_disjoint(right, second, adjacent, depth + 1))
    left, right = split_cubic(second, 0.5)
    return (_curves_disjoint(first, left, adjacent, depth + 1)
            and _curves_disjoint(first, right, False, depth + 1))


def _continuous_paths_simple(paths) -> bool:
    """Kiểm trên control hull sau .4f: không tự giao/cắt ring khác giữa sample."""
    if not paths or any(not path or any(a.p3 != b.p0 for a, b in zip(path, path[1:] + path[:1])) for path in paths):
        return False
    entries = [(ring, position, len(path), _segment_curve(segment))
               for ring, path in enumerate(paths) for position, segment in enumerate(path)]
    bounds = [box(*_bounds(item[3])) for item in entries]
    tree = STRtree(bounds)
    for index, (ring, position, count, curve) in enumerate(entries):
        if not chord_monotone(curve):
            return False
        for candidate in tree.query(bounds[index]):
            candidate = int(candidate)
            if candidate <= index:
                continue
            other_ring, other_position, _, other_curve = entries[candidate]
            adjacent = ring == other_ring and other_position == position + 1
            if ring == other_ring and position == 0 and other_position == count - 1:
                if not _curves_disjoint(other_curve, curve, True):
                    return False
            elif not _curves_disjoint(curve, other_curve, adjacent):
                return False
    return True


def reduce_cut_polyline(
    geometry, *, mm_to_units: float, tolerance_mm: float = 0.02, page_height: float = 0.0,
) -> PolylineReduction | None:
    """Nén riêng polyline đã tạo; thất bại giữ nguyên toàn geometry ở caller."""
    if not math.isfinite(mm_to_units) or mm_to_units <= 0:
        raise ValueError("Đơn vị đường cắt phải hữu hạn và dương")
    if not math.isfinite(tolerance_mm) or tolerance_mm < 0:
        raise ValueError("Sai số đường cắt phải hữu hạn và không âm")
    if not math.isfinite(page_height):
        raise ValueError("Chiều cao trang phải hữu hạn")
    if tolerance_mm == 0 or not isinstance(geometry, (Polygon, MultiPolygon)) or not geometry.is_valid:
        return None
    # Dự trữ làm tròn hai path .4f point: cũ + mới, cả x/y.
    rounding = math.sqrt(2.0) * 1e-4
    tolerance = tolerance_mm * mm_to_units - rounding - 1e-9 * mm_to_units
    if tolerance <= 0:
        return None
    parts = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    if geometry.is_empty:
        return None
    flat_tolerance = min(tolerance / 32, geometry.minimum_clearance / 16)
    if flat_tolerance <= 1e-10:
        return None
    all_paths, candidate_parts = [], []
    original_count = 0
    maximum_bound = 0.0
    for part in parts:
        candidate_rings = []
        for ring in [part.exterior, *part.interiors]:
            fitted = _fit_ring(ring.coords, tolerance)
            if fitted is None:
                return None
            path, bound = fitted
            original_count += len(ring.coords) - 1
            maximum_bound = max(maximum_bound, bound)
            flattened = []
            for segment in path:
                samples = _flatten(_segment_curve(segment), flat_tolerance)
                if samples is None:
                    return None
                flattened.extend(samples[:-1])
            flattened.append(path[-1].p3)
            if Polygon(flattened).exterior.is_ccw != ring.is_ccw:
                return None
            candidate_rings.append(flattened)
            all_paths.append(path)
        candidate = Polygon(candidate_rings[0], candidate_rings[1:])
        if not candidate.is_valid or candidate.is_empty or len(candidate.interiors) != len(part.interiors):
            return None
        candidate_parts.append(candidate)
    candidate_geometry = candidate_parts[0] if isinstance(geometry, Polygon) else MultiPolygon(candidate_parts)
    if not candidate_geometry.is_valid or candidate_geometry.minimum_clearance <= 4 * flat_tolerance:
        return None
    rounded_paths = []
    for path in all_paths:
        rounded = []
        for segment in path:
            controls = [(round(p[0], 4), page_height - round(page_height - p[1], 4))
                        for p in _segment_curve(segment)]
            rounded.append(MachinePathSegment.line(controls[0], controls[3])
                           if segment.kind == "line" else MachinePathSegment.cubic(*controls))
        rounded_paths.append(rounded)
    if not _continuous_paths_simple(rounded_paths):
        return None
    rounded_parts = []
    ring_cursor = 0
    for part in parts:
        rounded_rings = []
        for source_ring in [part.exterior, *part.interiors]:
            flattened = []
            for segment in rounded_paths[ring_cursor]:
                samples = _flatten(_segment_curve(segment), flat_tolerance)
                if samples is None:
                    return None
                flattened.extend(samples[:-1])
            flattened.append(rounded_paths[ring_cursor][-1].p3)
            if Polygon(flattened).exterior.is_ccw != source_ring.is_ccw:
                return None
            rounded_rings.append(flattened)
            ring_cursor += 1
        rounded_parts.append(Polygon(rounded_rings[0], rounded_rings[1:]))
    rounded_geometry = rounded_parts[0] if isinstance(geometry, Polygon) else MultiPolygon(rounded_parts)
    if (not rounded_geometry.is_valid or rounded_geometry.is_empty
            or rounded_geometry.minimum_clearance <= 4 * flat_tolerance):
        return None
    original_paths = [[MachinePathSegment.line(a, b) for a, b in zip(list(r.coords)[:-1], list(r.coords)[1:])]
                      for part in parts for r in [part.exterior, *part.interiors]]
    for original, candidate in zip(original_paths, rounded_paths):
        kwargs = dict(mm_to_units=mm_to_units, smooth_join_threshold_degrees=1.0, short_segment_threshold_mm=0.25)
        before = analyze_machine_path(original, **kwargs)
        after = analyze_machine_path(candidate, **kwargs)
        if after.short_segment_count > before.short_segment_count or after.discontinuous_join_count > before.discontinuous_join_count:
            return None
    reduced_count = sum(len(path) for path in all_paths)
    if reduced_count >= original_count:
        return None
    return PolylineReduction(all_paths, original_count, reduced_count, (maximum_bound + rounding) / mm_to_units)


def reduction_path_stream(path: list[MachinePathSegment], page_height: float) -> list[str]:
    """Ghi line còn nguyên và cubic đã chứng nhận, cùng lượng tử hóa writer cũ."""
    first = path[0].p0
    stream = [f"{first[0]:.4f} {page_height - first[1]:.4f} m"]
    for segment in path:
        if segment.kind == "line":
            stream.append(f"{segment.p3[0]:.4f} {page_height - segment.p3[1]:.4f} l")
        else:
            stream.append(" ".join(f"{p[0]:.4f} {page_height - p[1]:.4f}" for p in (segment.p1, segment.p2, segment.p3)) + " c")
    return stream + ["h"]
