"""Oracle hình học nhẹ cho audit smart nesting.

Module này cố ý độc lập với solver production.  Nó được gọi sau một lần chạy
nesting để đo chất lượng/độ an toàn, vì vậy không làm tăng thời gian đường
thực thi của bình tem.  Lỗ trong part được ghi nhận nhưng MVP coi là vật liệu
đặc, đúng hợp đồng validator hiện tại.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import cos, hypot, isfinite, radians, sin
from statistics import median
from typing import Any, Iterable, Mapping, Sequence


Point = tuple[float, float]
Polygon = tuple[Point, ...]


@dataclass(frozen=True)
class QualityThresholds:
    """Ngưỡng oracle; không phải budget tìm kiếm của solver."""

    required_gap_mm: float = 0.25
    tolerance_mm: float = 1e-6
    # Production dùng clearance dị hướng theo trục tờ. Oracle này không tự
    # thay thế narrow-phase validator nên phải báo ``unsupported`` thay vì
    # suy diễn từ một khoảng hở vô hướng.
    required_gap_x_mm: float | None = None
    required_gap_y_mm: float | None = None


def rectangle(width: float, height: float) -> list[list[float]]:
    """Sinh contour chữ nhật theo mm."""

    return [[0.0, 0.0], [float(width), 0.0], [float(width), float(height)], [0.0, float(height)]]


def l_shape(width: float = 20.0, height: float = 20.0, leg: float = 7.0) -> list[list[float]]:
    """Sinh chữ L để corpus phủ hình lõm."""

    return [[0, 0], [width, 0], [width, leg], [leg, leg], [leg, height], [0, height]]


def t_shape(width: float = 20.0, height: float = 20.0, stem: float = 7.0) -> list[list[float]]:
    """Sinh chữ T đơn giản."""

    left = (width - stem) / 2.0
    right = left + stem
    return [[0, 0], [width, 0], [width, stem], [right, stem], [right, height], [left, height], [left, stem], [0, stem]]


def u_shape(width: float = 20.0, height: float = 20.0, wall: float = 6.0) -> list[list[float]]:
    """Sinh chữ U (rãnh hở phía trên)."""

    return [[0, 0], [width, 0], [width, height], [width - wall, height], [width - wall, wall], [wall, wall], [wall, height], [0, height]]


def notch_shape(width: float = 20.0, height: float = 20.0, depth: float = 6.0) -> list[list[float]]:
    """Sinh contour có hõm tam giác ở cạnh trên."""

    left = width * 0.35
    right = width * 0.65
    apex = width * 0.50
    return [[0, 0], [width, 0], [width, height], [right, height], [apex, height - depth], [left, height], [0, height]]


def triangle(size: float = 5.0) -> list[list[float]]:
    """Sinh mảnh tam giác để kiểm tra lồng vào hõm."""

    return [[0.0, 0.0], [float(size), 0.0], [float(size) / 2.0, float(size)]]


def _polygon(value: Any) -> Polygon:
    if isinstance(value, Mapping):
        value = value.get(
            "polygon",
            value.get("outer", value.get("cutContour", value.get("contour"))),
        )
    if not value or len(value) < 3:
        raise ValueError("contour phải có ít nhất 3 đỉnh")
    points = tuple((float(p[0]), float(p[1])) for p in value)
    if any(not (isfinite(x) and isfinite(y)) for x, y in points):
        raise ValueError("contour chứa tọa độ không hữu hạn")
    return points


def _pose_value(item: Mapping[str, Any], *keys: str, default: float = 0.0) -> float:
    pose = item.get("pose")
    sources: tuple[Mapping[str, Any], ...] = (pose, item) if isinstance(pose, Mapping) else (item,)
    for source in sources:
        for key in keys:
            if key in source:
                return float(source[key])
    return default


def _positive_area_overlap(a: Polygon, b: Polygon, tol: float) -> bool:
    """Chỉ nhận giao có diện tích dương; shared-edge/touching là hợp lệ khi gap=0."""

    # Không dùng ``tol²`` để xoá giao rất nhỏ: giao có diện tích dương vẫn là
    # va chạm. ``tol`` chỉ dành cho quyết định shared-edge trong narrow checks.
    if _bbox_overlap(a, b) <= 0.0:
        return False

    def proper_cross(first: tuple[Point, Point], second: tuple[Point, Point]) -> bool:
        c1 = _cross(first[0], first[1], second[0])
        c2 = _cross(first[0], first[1], second[1])
        c3 = _cross(second[0], second[1], first[0])
        c4 = _cross(second[0], second[1], first[1])
        return (c1 > 0.0 and c2 < 0.0 or c1 < 0.0 and c2 > 0.0) and (
            c3 > 0.0 and c4 < 0.0 or c3 < 0.0 and c4 > 0.0
        )

    if any(proper_cross(edge_a, edge_b) for edge_a in _edges(a) for edge_b in _edges(b)):
        return True

    def strict_inside(point: Point, polygon: Polygon) -> bool:
        return _point_in_polygon(point, polygon, 0.0) and not any(
            _on_segment(start, end, point, 0.0) for start, end in _edges(polygon)
        )

    sample_a = [a[0]] + [((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0) for start, end in _edges(a)]
    sample_b = [b[0]] + [((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0) for start, end in _edges(b)]
    return any(strict_inside(point, b) for point in sample_a) or any(strict_inside(point, a) for point in sample_b)


def _axis_spacing_residual(values: Sequence[float], tolerance: float) -> float:
    """Độ lệch bước theo một trục, bất biến khi tịnh tiến toàn layout.

    Đây chỉ là metric mô tả spacing 1D; không tuyên bố chứng minh được lattice
    xiên hoặc phase/motif đầy đủ.
    """

    ordered = sorted(float(value) for value in values if isfinite(float(value)))
    unique: list[float] = []
    for value in ordered:
        if not unique or value - unique[-1] > tolerance:
            unique.append(value)
    if len(unique) < 2:
        return 0.0
    deltas = [b - a for a, b in zip(unique, unique[1:]) if b - a > tolerance]
    if not deltas:
        return 0.0
    step = median(deltas)
    if step <= tolerance:
        return 0.0
    origin = unique[0]
    return max(
        min((value - origin) % step, step - ((value - origin) % step))
        for value in unique
    )


def _production_clearance_is_unsupported(case: Mapping[str, Any]) -> bool:
    """Phát hiện contract clearance dị hướng mà oracle nhẹ chưa thể tái kiểm."""

    if "clearance" in case and isinstance(case["clearance"], Mapping):
        return True
    for container_key in ("contract", "production", "production_contract", "productionContract"):
        container = case.get(container_key)
        if isinstance(container, Mapping) and isinstance(container.get("clearance"), Mapping):
            return True
    return False


def _unplaced_part_id(record: Any) -> str | None:
    if isinstance(record, Mapping):
        value = record.get("part_id", record.get("partId"))
        return None if value is None else str(value)
    if record is None:
        return None
    return str(record)


def transform_polygon(
    polygon: Sequence[Sequence[float]],
    rotation_deg: float = 0.0,
    translate_x_mm: float = 0.0,
    translate_y_mm: float = 0.0,
    reference: Sequence[float] = (0.0, 0.0),
) -> Polygon:
    """Áp đúng hợp đồng pose: R*(p-reference)+translation."""

    theta = radians(float(rotation_deg))
    c, s = cos(theta), sin(theta)
    rx, ry = float(reference[0]), float(reference[1])
    tx, ty = float(translate_x_mm), float(translate_y_mm)
    return tuple((c * (float(x) - rx) - s * (float(y) - ry) + tx, s * (float(x) - rx) + c * (float(y) - ry) + ty) for x, y in polygon)


def _cross(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a: Point, b: Point, p: Point, tol: float) -> bool:
    return abs(_cross(a, b, p)) <= tol and min(a[0], b[0]) - tol <= p[0] <= max(a[0], b[0]) + tol and min(a[1], b[1]) - tol <= p[1] <= max(a[1], b[1]) + tol


def _segments_intersect(a: Point, b: Point, c: Point, d: Point, tol: float) -> bool:
    c1, c2, c3, c4 = _cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b)
    if ((c1 > tol and c2 < -tol) or (c1 < -tol and c2 > tol)) and ((c3 > tol and c4 < -tol) or (c3 < -tol and c4 > tol)):
        return True
    return (_on_segment(a, b, c, tol) or _on_segment(a, b, d, tol) or _on_segment(c, d, a, tol) or _on_segment(c, d, b, tol))


def _point_in_polygon(point: Point, polygon: Polygon, tol: float) -> bool:
    inside = False
    for index, current in enumerate(polygon):
        previous = polygon[index - 1]
        if _on_segment(previous, current, point, tol):
            return True
        if (current[1] > point[1]) != (previous[1] > point[1]):
            x_at_y = (previous[0] - current[0]) * (point[1] - current[1]) / (previous[1] - current[1]) + current[0]
            if point[0] < x_at_y:
                inside = not inside
    return inside


def _segment_distance(a: Point, b: Point, c: Point, d: Point) -> float:
    if _segments_intersect(a, b, c, d, 1e-12):
        return 0.0

    def point_segment(p: Point, q: Point, r: Point) -> float:
        vx, vy = r[0] - q[0], r[1] - q[1]
        length_sq = vx * vx + vy * vy
        if length_sq == 0:
            return hypot(p[0] - q[0], p[1] - q[1])
        t = max(0.0, min(1.0, ((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / length_sq))
        return hypot(p[0] - (q[0] + t * vx), p[1] - (q[1] + t * vy))

    return min(point_segment(a, c, d), point_segment(b, c, d), point_segment(c, a, b), point_segment(d, a, b))


def _edges(polygon: Polygon) -> Iterable[tuple[Point, Point]]:
    return zip(polygon, polygon[1:] + polygon[:1])


def _bbox(polygon: Polygon) -> tuple[float, float, float, float]:
    xs, ys = zip(*polygon)
    return min(xs), min(ys), max(xs), max(ys)


def _bbox_overlap(a: Polygon, b: Polygon) -> float:
    ax0, ay0, ax1, ay1 = _bbox(a)
    bx0, by0, bx1, by1 = _bbox(b)
    return max(0.0, min(ax1, bx1) - max(ax0, bx0)) * max(0.0, min(ay1, by1) - max(ay0, by0))


def _polygons_intersect(a: Polygon, b: Polygon, tol: float) -> bool:
    return _positive_area_overlap(a, b, tol)


def _polygon_distance(a: Polygon, b: Polygon) -> float:
    return min(_segment_distance(*edge_a, *edge_b) for edge_a in _edges(a) for edge_b in _edges(b))


def _obstacle_polygon(item: Any) -> Polygon:
    if isinstance(item, Mapping) and ("polygon" not in item and "outer" not in item):
        x, y = float(item.get("x", 0.0)), float(item.get("y", 0.0))
        return tuple((x + px, y + py) for px, py in _polygon(rectangle(float(item["width"]), float(item["height"]))))
    return _polygon(item.get("polygon", item.get("outer")) if isinstance(item, Mapping) else item)


def _part_polygon(part: Mapping[str, Any]) -> Any:
    """Đọc cả fixture đơn giản lẫn ``productionRequest.parts[].cutContour``."""

    for key in ("polygon", "outer", "cutContour", "contour"):
        if key in part:
            return part[key]
    return None


def evaluate_layout(case: Mapping[str, Any], thresholds: QualityThresholds | None = None) -> dict[str, Any]:
    """Đánh giá layout offline; chỉ metrics, không can thiệp solver."""

    limits = thresholds or QualityThresholds()
    errors: list[str] = []

    def finite(value: Any, field: str, default: float = 0.0) -> float:
        try:
            if isinstance(value, bool):
                raise ValueError
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            errors.append(f"NONFINITE:{field}")
            return default
        if not isfinite(result):
            errors.append(f"NONFINITE:{field}")
            return default
        return result

    gap_mm = finite(limits.required_gap_mm, "threshold.required_gap_mm")
    tolerance_mm = finite(limits.tolerance_mm, "threshold.tolerance_mm")
    if gap_mm < 0.0:
        errors.append("INVALID_THRESHOLD:required_gap_mm")
        gap_mm = 0.0
    if tolerance_mm < 0.0:
        errors.append("INVALID_THRESHOLD:tolerance_mm")
        tolerance_mm = 0.0

    sheet = case.get("sheet")
    if not isinstance(sheet, Mapping):
        sheet = {}
        errors.append("INVALID_SHEET")
    sheet_w = finite(sheet.get("width", sheet.get("width_mm", sheet.get("widthMm", sheet.get("w", 0.0)))), "sheet.width")
    sheet_h = finite(sheet.get("height", sheet.get("height_mm", sheet.get("heightMm", sheet.get("h", 0.0)))), "sheet.height")
    margin_value = sheet.get("margin", sheet.get("margin_mm", sheet.get("marginMm", 0.0)))
    if isinstance(margin_value, Mapping):
        margin_left = finite(margin_value.get("left", margin_value.get("leftMm", 0.0)), "sheet.margin.left")
        margin_right = finite(margin_value.get("right", margin_value.get("rightMm", 0.0)), "sheet.margin.right")
        margin_bottom = finite(margin_value.get("bottom", margin_value.get("bottomMm", 0.0)), "sheet.margin.bottom")
        margin_top = finite(margin_value.get("top", margin_value.get("topMm", 0.0)), "sheet.margin.top")
    else:
        margin_left = margin_right = margin_bottom = margin_top = finite(margin_value, "sheet.margin")
    if sheet_w <= 0 or sheet_h <= 0:
        errors.append("INVALID_SHEET_DIMENSIONS")

    raw_parts = case.get("parts", [])
    if not isinstance(raw_parts, Sequence) or isinstance(raw_parts, (str, bytes)):
        raw_parts = []
        errors.append("INVALID_PARTS")
    parts: dict[str, Mapping[str, Any]] = {}
    quantities: dict[str, int | None] = {}
    for item in raw_parts:
        if not isinstance(item, Mapping):
            errors.append("INVALID_PART")
            continue
        raw_id = item.get("part_id", item.get("partId"))
        if raw_id is None or str(raw_id) == "":
            errors.append("INVALID_PART_ID")
            continue
        part_id = str(raw_id)
        if part_id in parts:
            errors.append(f"DUPLICATE_PART:{part_id}")
            continue
        parts[part_id] = item
        raw_quantity = item.get("quantity", item.get("quantityFulfillment"))
        if raw_quantity is None:
            quantities[part_id] = None
        else:
            quantity = finite(raw_quantity, f"quantity:{part_id}", -1.0)
            if quantity < 0 or quantity != int(quantity):
                errors.append(f"INVALID_QUANTITY:{part_id}")
                quantities[part_id] = None
            else:
                quantities[part_id] = int(quantity)

    raw_placements = case.get("placements", [])
    if not isinstance(raw_placements, Sequence) or isinstance(raw_placements, (str, bytes)):
        raw_placements = []
        errors.append("INVALID_PLACEMENTS")
    placements = list(raw_placements)
    transformed: list[tuple[Mapping[str, Any], Polygon, int, str, str]] = []
    containment_violations = 0
    seen_ids: set[str] = set()
    for index, placement in enumerate(placements):
        if not isinstance(placement, Mapping):
            errors.append(f"INVALID_PLACEMENT:{index + 1}")
            continue
        raw_part_id = placement.get("part_id", placement.get("partId"))
        part_id = "" if raw_part_id is None else str(raw_part_id)
        if part_id not in parts:
            errors.append(f"UNKNOWN_PART:{part_id}")
            continue
        instance_id = str(placement.get("instance_id", placement.get("instanceId", f"{part_id}#{index + 1}")))
        if instance_id in seen_ids:
            errors.append(f"DUPLICATE_INSTANCE:{instance_id}")
        seen_ids.add(instance_id)
        part = parts[part_id]
        reference = part.get("reference", part.get("reference_point_mm", part.get("referencePointMm", (0.0, 0.0))))
        try:
            if isinstance(placement.get("pose"), Mapping):
                pose = placement["pose"]
                if not all(key in pose for key in ("rotationDeg", "translateXmm", "translateYmm")):
                    raise ValueError("pose thiếu trường")
            rotation = _pose_value(placement, "rotation_deg", "rotationDeg")
            tx = _pose_value(placement, "translate_x_mm", "translateXmm", "x")
            ty = _pose_value(placement, "translate_y_mm", "translateYmm", "y")
            if not (isfinite(rotation) and isfinite(tx) and isfinite(ty)) or rotation < 0.0 or rotation >= 360.0:
                raise ValueError("pose không hợp lệ")
            polygon = transform_polygon(_polygon(_part_polygon(part)), rotation, tx, ty, reference)
            if any(not (isfinite(x) and isfinite(y)) for x, y in polygon):
                raise ValueError("contour không hữu hạn")
        except (TypeError, ValueError, OverflowError, KeyError):
            errors.append(f"INVALID_POSE_OR_GEOMETRY:{instance_id}")
            continue
        try:
            raw_sheet_index = placement.get("sheet_index", placement.get("sheetIndex", 0))
            sheet_index_value = float(raw_sheet_index)
            if not isfinite(sheet_index_value) or sheet_index_value < 0 or sheet_index_value != int(sheet_index_value):
                raise ValueError
            sheet_index = int(sheet_index_value)
        except (TypeError, ValueError, OverflowError):
            errors.append(f"INVALID_SHEET_INDEX:{instance_id}")
            continue
        transformed.append((placement, polygon, sheet_index, part_id, instance_id))
        x0, y0, x1, y1 = _bbox(polygon)
        if x0 < margin_left - tolerance_mm or y0 < margin_bottom - tolerance_mm or x1 > sheet_w - margin_right + tolerance_mm or y1 > sheet_h - margin_top + tolerance_mm:
            containment_violations += 1
            errors.append(f"OUT_OF_SHEET:{instance_id}")

    obstacle_polygons: list[Polygon] = []
    raw_obstacles = case.get("obstacles", case.get("fixed_obstacles", case.get("fixedObstacles", [])))
    if not isinstance(raw_obstacles, Sequence) or isinstance(raw_obstacles, (str, bytes)):
        raw_obstacles = []
        errors.append("INVALID_OBSTACLES")
    for index, item in enumerate(raw_obstacles):
        try:
            obstacle_polygons.append(_obstacle_polygon(item))
        except (TypeError, ValueError, KeyError, OverflowError):
            errors.append(f"INVALID_OBSTACLE:{index + 1}")
    obstacle_hits = 0
    obstacle_clearance_violations = 0
    min_edge_distance = float("inf")
    bbox_overlap_pairs = 0
    interlock_pairs = 0
    for _, polygon, sheet_index, _, _ in transformed:
        for obstacle in obstacle_polygons:
            distance = _polygon_distance(polygon, obstacle)
            min_edge_distance = min(min_edge_distance, distance)
            if _polygons_intersect(polygon, obstacle, tolerance_mm):
                obstacle_hits += 1
            elif distance < gap_mm - tolerance_mm:
                obstacle_clearance_violations += 1
    for index, (_, polygon, sheet_index, _, _) in enumerate(transformed):
        for _, other_polygon, other_sheet_index, _, _ in transformed[index + 1 :]:
            if sheet_index != other_sheet_index:
                continue
            distance = _polygon_distance(polygon, other_polygon)
            min_edge_distance = min(min_edge_distance, distance)
            bbox_area = _bbox_overlap(polygon, other_polygon)
            intersects = _polygons_intersect(polygon, other_polygon, tolerance_mm)
            if bbox_area > tolerance_mm * tolerance_mm:
                bbox_overlap_pairs += 1
                # Đây là tín hiệu mô tả (không phải objective cứng): bbox chồng
                # nhưng contour không giao nhau nghĩa là hình có khả năng lồng.
                if not intersects:
                    interlock_pairs += 1
            if intersects or distance < gap_mm - tolerance_mm:
                errors.append("PAIR_CLEARANCE")
    if obstacle_hits:
        errors.append("OBSTACLE_COLLISION")
    if obstacle_clearance_violations:
        errors.append("OBSTACLE_CLEARANCE")
    if min_edge_distance == float("inf"):
        min_edge_distance = 0.0
    x_values = [_bbox(polygon)[0] for _, polygon, _, _, _ in transformed]
    y_values = [_bbox(polygon)[1] for _, polygon, _, _, _ in transformed]
    placement_counts: dict[str, int] = {}
    for _, _, _, part_id, _ in transformed:
        placement_counts[part_id] = placement_counts.get(part_id, 0) + 1
    raw_unplaced = case.get("unplaced", [])
    if not isinstance(raw_unplaced, Sequence) or isinstance(raw_unplaced, (str, bytes)):
        raw_unplaced = []
        errors.append("INVALID_UNPLACED")
    unplaced_by_part: dict[str, int] = {}
    for record in raw_unplaced:
        part_id = _unplaced_part_id(record)
        if part_id is None or part_id not in parts:
            errors.append(f"UNKNOWN_PART:{part_id or ''}")
            continue
        unplaced_by_part[part_id] = unplaced_by_part.get(part_id, 0) + 1
    expected = sum(quantity or 0 for quantity in quantities.values() if quantity is not None)
    count_ok = True
    for part_id, quantity in quantities.items():
        if quantity is None:
            continue
        actual = placement_counts.get(part_id, 0) + unplaced_by_part.get(part_id, 0)
        if actual > quantity:
            errors.append("PLACEMENT_COUNT_EXCEEDS_QUANTITY")
            count_ok = False
        elif actual < quantity:
            errors.append("PLACEMENT_COUNT_MISSING")
            count_ok = False
    unsupported_clearance = (
        limits.required_gap_x_mm is not None
        or limits.required_gap_y_mm is not None
        or _production_clearance_is_unsupported(case)
    )
    if unsupported_clearance:
        errors.append("ANISOTROPIC_CLEARANCE_UNSUPPORTED")
    axis_spacing_residual = max(
        _axis_spacing_residual(x_values, tolerance_mm),
        _axis_spacing_residual(y_values, tolerance_mm),
    )
    return {
        "valid": not errors,
        "errors": sorted(set(errors)),
        "placement_count": len(placements),
        "requested_count": expected,
        "unplaced_count": len(raw_unplaced),
        "count_ok": count_ok,
        "part_count": len(parts),
        "containment_violations": containment_violations,
        "min_edge_distance_mm": round(min_edge_distance, 9),
        "bbox_overlap_pairs": bbox_overlap_pairs,
        "interlock_pairs": interlock_pairs,
        "axis_spacing_residual_mm": round(axis_spacing_residual, 9),
        "periodic_metric": "axis_spacing_residual_mm (translation-invariant 1D; no skew-lattice proof)",
        "clearance_supported": not unsupported_clearance,
        "holes_ignored": any(item.get("holes") for item in parts.values()),
    }


def quality_corpus() -> list[dict[str, Any]]:
    """Corpus nhỏ, deterministic, dùng để smoke-test oracle độc lập."""

    return [
        {
            "name": "rectangle_stack",
            "sheet": {"width": 60, "height": 30},
            "parts": [{"part_id": "r", "polygon": rectangle(10, 10), "quantity": 4}],
            "placements": [{"part_id": "r", "x": x, "y": 0} for x in (0, 12, 24, 36)],
        },
        {
            "name": "notch_tongue_interlock",
            "sheet": {"width": 40, "height": 30},
            "parts": [{"part_id": "notch", "polygon": notch_shape()}, {"part_id": "tongue", "polygon": triangle(4)}],
            # Tam giác quay 180°: đỉnh chui vào hõm, cạnh đáy nằm sâu bên trong.
            "placements": [{"part_id": "notch", "x": 0, "y": 0}, {"part_id": "tongue", "rotation_deg": 180, "x": 12, "y": 19.5}],
        },
        {
            "name": "unsafe_gap",
            "sheet": {"width": 30, "height": 15},
            "parts": [{"part_id": "r", "polygon": rectangle(10, 10)}],
            "placements": [{"part_id": "r", "x": 0, "y": 0}, {"part_id": "r", "x": 9.5, "y": 0}],
        },
    ]


__all__ = [
    "QualityThresholds",
    "evaluate_layout",
    "l_shape",
    "notch_shape",
    "quality_corpus",
    "rectangle",
    "t_shape",
    "triangle",
    "transform_polygon",
    "u_shape",
]
