"""Đo chất lượng chuyển động của đường bế trước khi giao cho máy cắt.

Module này chỉ đo hình học của các lệnh line/cubic đã có; nó không quyết định
dung sai sản xuất và không giới hạn số node. Profile máy phải truyền ngưỡng theo
mm từ tầng gọi. Giữ module thuần stdlib để unit test nhanh và không kéo SciPy,
OpenCV hoặc PDFium vào đường import nhẹ.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Literal, Sequence


Point = tuple[float, float]
SegmentKind = Literal["line", "cubic"]

_VECTOR_EPSILON = 1e-12


@dataclass(frozen=True, slots=True)
class MachinePathSegment:
    """Một lệnh chuyển động đã chuẩn hóa về dạng cubic bốn điểm."""

    kind: SegmentKind
    p0: Point
    p1: Point
    p2: Point
    p3: Point

    @classmethod
    def line(cls, start: Point, end: Point) -> "MachinePathSegment":
        """Tạo đoạn thẳng nhưng giữ control point tương đương cubic chính xác."""
        start = _point(start)
        end = _point(end)
        delta = _scale(_sub(end, start), 1.0 / 3.0)
        return cls(
            "line",
            start,
            _add(start, delta),
            _add(start, _scale(delta, 2.0)),
            end,
        )

    @classmethod
    def cubic(
        cls,
        start: Point,
        control1: Point,
        control2: Point,
        end: Point,
    ) -> "MachinePathSegment":
        """Tạo đoạn cubic Bézier theo đúng thứ tự lệnh PDF ``c``."""
        return cls(
            "cubic",
            _point(start),
            _point(control1),
            _point(control2),
            _point(end),
        )


@dataclass(frozen=True, slots=True)
class MachinePathMetrics:
    """Số đo trung lập; tầng policy quyết định ngưỡng nào được phép."""

    segment_count: int
    line_segment_count: int
    cubic_segment_count: int
    degenerate_segment_count: int
    total_length_mm: float
    minimum_segment_length_mm: float | None
    p10_segment_length_mm: float | None
    median_segment_length_mm: float | None
    short_segment_count: int
    short_segment_ratio: float
    join_count: int
    disconnected_join_count: int
    maximum_endpoint_gap_mm: float
    maximum_join_angle_degrees: float | None
    p95_join_angle_degrees: float | None
    discontinuous_join_count: int
    maximum_curvature_jump_per_mm: float | None
    p95_curvature_jump_per_mm: float | None
    curvature_sign_flip_count: int
    curvature_sign_flips_per_100mm: float


def cubic_segments_from_tuples(
    segments: Iterable[tuple[Point, Point, Point, Point]],
) -> list[MachinePathSegment]:
    """Đổi output fitter hiện tại thành segment dùng chung cho bộ đo."""
    return [MachinePathSegment.cubic(*segment) for segment in segments]


def line_segments_from_closed_ring(coords: Sequence[Point]) -> list[MachinePathSegment]:
    """Đổi một ring đóng thành các lệnh line, gồm cả cạnh đóng cuối cùng."""
    points = [_point(point) for point in coords]
    if len(points) > 1 and _distance(points[0], points[-1]) <= _VECTOR_EPSILON:
        points.pop()
    if len(points) < 2:
        return []
    return [
        MachinePathSegment.line(points[index], points[(index + 1) % len(points)])
        for index in range(len(points))
    ]


def analyze_machine_path(
    segments: Sequence[MachinePathSegment],
    *,
    mm_to_units: float,
    smooth_join_threshold_degrees: float,
    short_segment_threshold_mm: float,
    closed: bool = True,
    samples_per_cubic: int = 32,
    curvature_samples_per_cubic: int = 15,
    curvature_noise_ratio: float = 0.05,
    curvature_noise_floor_per_mm: float = 0.0,
) -> MachinePathMetrics:
    """Đo continuity, độ dài lệnh và dao động độ cong của một path.

    ``mm_to_units`` là số đơn vị tọa độ trên một mm, ví dụ ``72 / 25.4`` cho
    PDF point. Hai ngưỡng bắt buộc truyền vào để phép đo không âm thầm trở thành
    hard-cap dùng chung cho mọi máy.
    """
    _validate_positive("mm_to_units", mm_to_units)
    _validate_non_negative(
        "smooth_join_threshold_degrees",
        smooth_join_threshold_degrees,
    )
    _validate_non_negative("short_segment_threshold_mm", short_segment_threshold_mm)
    if samples_per_cubic < 2:
        raise ValueError("samples_per_cubic phải từ 2 trở lên")
    if curvature_samples_per_cubic < 1:
        raise ValueError("curvature_samples_per_cubic phải từ 1 trở lên")
    if not math.isfinite(curvature_noise_ratio) or not 0.0 <= curvature_noise_ratio <= 1.0:
        raise ValueError("curvature_noise_ratio phải nằm trong [0, 1]")
    _validate_non_negative(
        "curvature_noise_floor_per_mm",
        curvature_noise_floor_per_mm,
    )

    normalized = list(segments)
    if not normalized:
        return MachinePathMetrics(
            segment_count=0,
            line_segment_count=0,
            cubic_segment_count=0,
            degenerate_segment_count=0,
            total_length_mm=0.0,
            minimum_segment_length_mm=None,
            p10_segment_length_mm=None,
            median_segment_length_mm=None,
            short_segment_count=0,
            short_segment_ratio=0.0,
            join_count=0,
            disconnected_join_count=0,
            maximum_endpoint_gap_mm=0.0,
            maximum_join_angle_degrees=None,
            p95_join_angle_degrees=None,
            discontinuous_join_count=0,
            maximum_curvature_jump_per_mm=None,
            p95_curvature_jump_per_mm=None,
            curvature_sign_flip_count=0,
            curvature_sign_flips_per_100mm=0.0,
        )

    for segment in normalized:
        if segment.kind not in {"line", "cubic"}:
            raise ValueError(f"Loại lệnh đường bế không hợp lệ: {segment.kind!r}")
        for point in (segment.p0, segment.p1, segment.p2, segment.p3):
            _point(point)

    lengths_mm = [
        _segment_length(segment, samples_per_cubic) / mm_to_units
        for segment in normalized
    ]
    degenerate_count = sum(length <= _VECTOR_EPSILON for length in lengths_mm)
    short_count = sum(length < short_segment_threshold_mm for length in lengths_mm)
    total_length_mm = sum(lengths_mm)

    join_angles: list[float] = []
    curvature_jumps: list[float] = []
    endpoint_gaps_mm: list[float] = []
    disconnected_count = 0
    discontinuous_count = 0
    join_pairs = _join_pairs(normalized, closed=closed)
    for previous, following in join_pairs:
        endpoint_gap_mm = _distance(previous.p3, following.p0) / mm_to_units
        endpoint_gaps_mm.append(endpoint_gap_mm)
        if endpoint_gap_mm > _VECTOR_EPSILON:
            disconnected_count += 1

        angle = _angle_degrees(
            _endpoint_tangent(previous, at_end=True),
            _endpoint_tangent(following, at_end=False),
        )
        if angle is not None:
            join_angles.append(angle)
            if angle > smooth_join_threshold_degrees:
                discontinuous_count += 1

        previous_curvature = _curvature(previous, 1.0, mm_to_units)
        following_curvature = _curvature(following, 0.0, mm_to_units)
        if previous_curvature is not None and following_curvature is not None:
            curvature_jumps.append(abs(previous_curvature - following_curvature))

    sampled_curvatures: list[float] = []
    for segment in normalized:
        if segment.kind != "cubic":
            continue
        for sample_index in range(1, curvature_samples_per_cubic + 1):
            curvature = _curvature(
                segment,
                sample_index / (curvature_samples_per_cubic + 1),
                mm_to_units,
            )
            if curvature is not None:
                sampled_curvatures.append(curvature)
    sign_flip_count = _curvature_sign_flips(
        sampled_curvatures,
        noise_ratio=curvature_noise_ratio,
        absolute_floor=curvature_noise_floor_per_mm,
        closed=closed,
    )

    # QUALITY (audit 2026-08-07 §MOTION.1/§MOTION.6): đo actual command thay vì
    # suy chất lượng từ tổng node. Policy/fail-safe sẽ dùng các số này ở Lô C.
    return MachinePathMetrics(
        segment_count=len(normalized),
        line_segment_count=sum(segment.kind == "line" for segment in normalized),
        cubic_segment_count=sum(segment.kind == "cubic" for segment in normalized),
        degenerate_segment_count=degenerate_count,
        total_length_mm=total_length_mm,
        minimum_segment_length_mm=min(lengths_mm),
        p10_segment_length_mm=_percentile(lengths_mm, 0.10),
        median_segment_length_mm=_percentile(lengths_mm, 0.50),
        short_segment_count=short_count,
        short_segment_ratio=short_count / len(normalized),
        join_count=len(join_pairs),
        disconnected_join_count=disconnected_count,
        maximum_endpoint_gap_mm=max(endpoint_gaps_mm, default=0.0),
        maximum_join_angle_degrees=max(join_angles, default=None),
        p95_join_angle_degrees=(
            _percentile(join_angles, 0.95) if join_angles else None
        ),
        discontinuous_join_count=discontinuous_count,
        maximum_curvature_jump_per_mm=max(curvature_jumps, default=None),
        p95_curvature_jump_per_mm=(
            _percentile(curvature_jumps, 0.95) if curvature_jumps else None
        ),
        curvature_sign_flip_count=sign_flip_count,
        curvature_sign_flips_per_100mm=(
            sign_flip_count / total_length_mm * 100.0 if total_length_mm > 0 else 0.0
        ),
    )


def _point(value: Point) -> Point:
    if len(value) != 2:
        raise ValueError("Điểm đường bế phải có đúng hai tọa độ")
    point = (float(value[0]), float(value[1]))
    if not all(math.isfinite(component) for component in point):
        raise ValueError("Tọa độ đường bế phải là số hữu hạn")
    return point


def _add(first: Point, second: Point) -> Point:
    return first[0] + second[0], first[1] + second[1]


def _sub(first: Point, second: Point) -> Point:
    return first[0] - second[0], first[1] - second[1]


def _scale(vector: Point, factor: float) -> Point:
    return vector[0] * factor, vector[1] * factor


def _dot(first: Point, second: Point) -> float:
    return first[0] * second[0] + first[1] * second[1]


def _length(vector: Point) -> float:
    return math.hypot(vector[0], vector[1])


def _distance(first: Point, second: Point) -> float:
    return _length(_sub(first, second))


def _join_pairs(
    segments: Sequence[MachinePathSegment],
    *,
    closed: bool,
) -> list[tuple[MachinePathSegment, MachinePathSegment]]:
    pairs = list(zip(segments, segments[1:]))
    if closed and segments:
        pairs.append((segments[-1], segments[0]))
    return pairs


def _bezier_point(segment: MachinePathSegment, t: float) -> Point:
    u = 1.0 - t
    return (
        u**3 * segment.p0[0]
        + 3.0 * u * u * t * segment.p1[0]
        + 3.0 * u * t * t * segment.p2[0]
        + t**3 * segment.p3[0],
        u**3 * segment.p0[1]
        + 3.0 * u * u * t * segment.p1[1]
        + 3.0 * u * t * t * segment.p2[1]
        + t**3 * segment.p3[1],
    )


def _first_derivative(segment: MachinePathSegment, t: float) -> Point:
    u = 1.0 - t
    return _scale(
        _add(
            _add(
                _scale(_sub(segment.p1, segment.p0), u * u),
                _scale(_sub(segment.p2, segment.p1), 2.0 * u * t),
            ),
            _scale(_sub(segment.p3, segment.p2), t * t),
        ),
        3.0,
    )


def _second_derivative(segment: MachinePathSegment, t: float) -> Point:
    first = _add(_sub(segment.p2, _scale(segment.p1, 2.0)), segment.p0)
    second = _add(_sub(segment.p3, _scale(segment.p2, 2.0)), segment.p1)
    return _scale(_add(_scale(first, 1.0 - t), _scale(second, t)), 6.0)


def _endpoint_tangent(
    segment: MachinePathSegment,
    *,
    at_end: bool,
) -> Point | None:
    if at_end:
        candidates = (
            _sub(segment.p3, segment.p2),
            _sub(segment.p3, segment.p1),
            _sub(segment.p3, segment.p0),
        )
    else:
        candidates = (
            _sub(segment.p1, segment.p0),
            _sub(segment.p2, segment.p0),
            _sub(segment.p3, segment.p0),
        )
    for candidate in candidates:
        magnitude = _length(candidate)
        if magnitude > _VECTOR_EPSILON:
            return _scale(candidate, 1.0 / magnitude)
    return None


def _angle_degrees(first: Point | None, second: Point | None) -> float | None:
    if first is None or second is None:
        return None
    cosine = max(-1.0, min(1.0, _dot(first, second)))
    return math.degrees(math.acos(cosine))


def _curvature(
    segment: MachinePathSegment,
    t: float,
    mm_to_units: float,
) -> float | None:
    first = _first_derivative(segment, t)
    speed = _length(first)
    if speed <= _VECTOR_EPSILON:
        return None
    second = _second_derivative(segment, t)
    cross = first[0] * second[1] - first[1] * second[0]
    # Tọa độ theo unit làm curvature có đơn vị 1/unit; nhân unit/mm → 1/mm.
    return cross / speed**3 * mm_to_units


def _segment_length(segment: MachinePathSegment, samples_per_cubic: int) -> float:
    if segment.kind == "line":
        return _distance(segment.p0, segment.p3)
    total = 0.0
    previous = segment.p0
    for sample_index in range(1, samples_per_cubic + 1):
        current = _bezier_point(segment, sample_index / samples_per_cubic)
        total += _distance(previous, current)
        previous = current
    return total


def _curvature_sign_flips(
    values: Sequence[float],
    *,
    noise_ratio: float,
    absolute_floor: float,
    closed: bool,
) -> int:
    if not values:
        return 0
    magnitudes = [abs(value) for value in values]
    floor = max(
        _VECTOR_EPSILON,
        absolute_floor,
        _percentile(magnitudes, 0.75) * noise_ratio,
    )
    signs: list[int] = []
    for value in values:
        sign = 1 if value > floor else -1 if value < -floor else 0
        if sign and (not signs or sign != signs[-1]):
            signs.append(sign)
    if len(signs) < 2:
        return 0
    flips = len(signs) - 1
    if closed and signs[-1] != signs[0]:
        flips += 1
    return flips


def _percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        raise ValueError("Không thể lấy percentile của danh sách rỗng")
    rank = (len(ordered) - 1) * fraction
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _validate_positive(name: str, value: float) -> None:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} phải là số hữu hạn lớn hơn 0")


def _validate_non_negative(name: str, value: float) -> None:
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} phải là số hữu hạn không âm")
