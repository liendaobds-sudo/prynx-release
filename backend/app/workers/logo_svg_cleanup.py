"""Dọn SVG legacy và kiểm độc lập artifact của mọi Logo Engine."""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import asdict, dataclass
from typing import Callable, Literal
from xml.etree import ElementTree


_SVG_NAMESPACE = "http://www.w3.org/2000/svg"
_COMMAND_RE = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]")
_TOKEN_RE = re.compile(
    r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][-+]?\d+)?"
)
_SVG_LENGTH_MM_RE = re.compile(
    r"^\s*([-+]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][-+]?\d+)?)\s*mm\s*$",
    re.IGNORECASE,
)
_TINY_PATH_AREA_RATIO = 1e-4
_REDUNDANT_COVERAGE_RATIO = 0.995
_FLATTEN_TOLERANCE_PX = 0.25


class LogoSvgCleanupError(ValueError):
    """SVG không thể phân tích hình học một cách tin cậy."""


class LogoSvgCleanupCancelled(RuntimeError):
    """Người dùng đã hủy trong lúc dọn SVG."""


@dataclass(frozen=True)
class LogoSvgComplexity:
    path_count: int
    drawable_path_count: int
    node_count: int
    tiny_path_count: int
    tiny_path_ratio: float
    svg_bytes: int
    removed_redundant_paths: int = 0

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


@dataclass(frozen=True)
class LogoSvgCleanupResult:
    svg: str
    removed_path_count: int


@dataclass(frozen=True)
class LogoSvgQuality:
    status: Literal["ready", "review", "rejected"]
    complexity: LogoSvgComplexity
    reasons: list[str]
    actions: list[str]


@dataclass
class _Subpath:
    start: tuple[float, float]
    segments: list[tuple]
    closed: bool = False


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _tokenize_path(path_data: str) -> list[str | float]:
    tokens: list[str | float] = []
    position = 0
    for match in _TOKEN_RE.finditer(path_data):
        skipped = path_data[position : match.start()]
        if skipped.strip(" \t\r\n,"):
            raise LogoSvgCleanupError("SVG chứa ký tự path không được hỗ trợ.")
        value = match.group()
        tokens.append(value if len(value) == 1 and value.isalpha() else float(value))
        position = match.end()
    if path_data[position:].strip(" \t\r\n,"):
        raise LogoSvgCleanupError("SVG chứa phần dư path không hợp lệ.")
    return tokens


def _absolute_pairs(
    values: list[float], current_x: float, current_y: float, relative: bool
) -> list[tuple[float, float]]:
    pairs = list(zip(values[0::2], values[1::2]))
    if relative:
        return [(current_x + x, current_y + y) for x, y in pairs]
    return pairs


def _quadratic_to_cubic(
    start: tuple[float, float],
    control: tuple[float, float],
    end: tuple[float, float],
) -> tuple[float, ...]:
    first = (
        start[0] + (2.0 / 3.0) * (control[0] - start[0]),
        start[1] + (2.0 / 3.0) * (control[1] - start[1]),
    )
    second = (
        end[0] + (2.0 / 3.0) * (control[0] - end[0]),
        end[1] + (2.0 / 3.0) * (control[1] - end[1]),
    )
    return (*first, *second, *end)


def _parse_path(path_data: str) -> list[_Subpath]:
    tokens = _tokenize_path(path_data)
    subpaths: list[_Subpath] = []
    current: _Subpath | None = None
    current_x = current_y = 0.0
    start_x = start_y = 0.0
    previous_cubic: tuple[float, float] | None = None
    previous_quadratic: tuple[float, float] | None = None
    index = 0
    command = ""
    while index < len(tokens):
        token = tokens[index]
        if isinstance(token, str):
            command = token
            index += 1
            if command in "Zz":
                if current is not None:
                    current.closed = True
                    subpaths.append(current)
                    current = None
                current_x, current_y = start_x, start_y
                previous_cubic = previous_quadratic = None
                continue
            if command in "Aa":
                raise LogoSvgCleanupError(
                    "SVG chứa cung A/a ngoài tập lệnh VTracer được hỗ trợ."
                )
        if not command:
            raise LogoSvgCleanupError("Path SVG phải bắt đầu bằng lệnh di chuyển.")

        upper = command.upper()
        required = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2}.get(upper)
        if required is None:
            raise LogoSvgCleanupError(f"Lệnh path {command} không được hỗ trợ.")
        values = tokens[index : index + required]
        if len(values) < required or any(isinstance(value, str) for value in values):
            raise LogoSvgCleanupError(f"Lệnh path {command} thiếu tham số.")
        numbers = [float(value) for value in values]
        if not all(math.isfinite(value) for value in numbers):
            raise LogoSvgCleanupError("Path SVG chứa tọa độ không hữu hạn.")
        index += required
        relative = command.islower()

        if upper == "M":
            x, y = (
                (current_x + numbers[0], current_y + numbers[1])
                if relative
                else (numbers[0], numbers[1])
            )
            if current is not None:
                subpaths.append(current)
            current = _Subpath((x, y), [])
            current_x, current_y = start_x, start_y = x, y
            command = "l" if relative else "L"
            previous_cubic = previous_quadratic = None
            continue
        if current is None:
            raise LogoSvgCleanupError("Path SVG có lệnh vẽ trước lệnh di chuyển.")

        if upper == "L":
            x, y = (
                (current_x + numbers[0], current_y + numbers[1])
                if relative
                else (numbers[0], numbers[1])
            )
            current.segments.append(("L", x, y))
            previous_cubic = previous_quadratic = None
        elif upper == "H":
            x = current_x + numbers[0] if relative else numbers[0]
            y = current_y
            current.segments.append(("L", x, y))
            previous_cubic = previous_quadratic = None
        elif upper == "V":
            x = current_x
            y = current_y + numbers[0] if relative else numbers[0]
            current.segments.append(("L", x, y))
            previous_cubic = previous_quadratic = None
        elif upper == "C":
            points = _absolute_pairs(numbers, current_x, current_y, relative)
            current.segments.append(("C", *points[0], *points[1], *points[2]))
            previous_cubic, previous_quadratic = points[1], None
            x, y = points[2]
        elif upper == "S":
            points = _absolute_pairs(numbers, current_x, current_y, relative)
            first = (
                (2 * current_x - previous_cubic[0], 2 * current_y - previous_cubic[1])
                if previous_cubic
                else (current_x, current_y)
            )
            current.segments.append(("C", *first, *points[0], *points[1]))
            previous_cubic, previous_quadratic = points[0], None
            x, y = points[1]
        elif upper == "Q":
            points = _absolute_pairs(numbers, current_x, current_y, relative)
            current.segments.append(
                ("C", *_quadratic_to_cubic((current_x, current_y), points[0], points[1]))
            )
            previous_quadratic, previous_cubic = points[0], None
            x, y = points[1]
        else:
            points = _absolute_pairs(numbers, current_x, current_y, relative)
            control = (
                (
                    2 * current_x - previous_quadratic[0],
                    2 * current_y - previous_quadratic[1],
                )
                if previous_quadratic
                else (current_x, current_y)
            )
            current.segments.append(
                ("C", *_quadratic_to_cubic((current_x, current_y), control, points[0]))
            )
            previous_quadratic, previous_cubic = control, None
            x, y = points[0]
        current_x, current_y = x, y

    if current is not None:
        subpaths.append(current)
    return [subpath for subpath in subpaths if subpath.segments]


def _point_line_distance(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> float:
    delta_x, delta_y = end[0] - start[0], end[1] - start[1]
    if delta_x == 0.0 and delta_y == 0.0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    return abs(
        delta_y * point[0]
        - delta_x * point[1]
        + end[0] * start[1]
        - end[1] * start[0]
    ) / math.hypot(delta_x, delta_y)


def _flatten_cubic(
    start: tuple[float, float],
    first: tuple[float, float],
    second: tuple[float, float],
    end: tuple[float, float],
    depth: int = 0,
) -> list[tuple[float, float]]:
    if depth >= 10 or max(
        _point_line_distance(first, start, end),
        _point_line_distance(second, start, end),
    ) <= _FLATTEN_TOLERANCE_PX:
        return [end]
    start_first = ((start[0] + first[0]) / 2, (start[1] + first[1]) / 2)
    first_second = ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
    second_end = ((second[0] + end[0]) / 2, (second[1] + end[1]) / 2)
    left_control = (
        (start_first[0] + first_second[0]) / 2,
        (start_first[1] + first_second[1]) / 2,
    )
    right_control = (
        (first_second[0] + second_end[0]) / 2,
        (first_second[1] + second_end[1]) / 2,
    )
    middle = (
        (left_control[0] + right_control[0]) / 2,
        (left_control[1] + right_control[1]) / 2,
    )
    return _flatten_cubic(start, start_first, left_control, middle, depth + 1) + _flatten_cubic(
        middle, right_control, second_end, end, depth + 1
    )


def _polygonal(geometry):
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

    if geometry.is_empty or isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    if isinstance(geometry, GeometryCollection):
        parts = [
            item for item in geometry.geoms if isinstance(item, (Polygon, MultiPolygon))
        ]
        if not parts:
            return Polygon()
        result = parts[0]
        for part in parts[1:]:
            result = result.union(part)
        return result
    return Polygon()


def _path_geometry(path_data: str, even_odd: bool):
    from shapely import make_valid
    from shapely.geometry import Polygon

    rings: list[tuple[float, float, object]] = []
    for subpath in _parse_path(path_data):
        if not subpath.closed:
            continue
        points = [subpath.start]
        current = subpath.start
        for segment in subpath.segments:
            if segment[0] == "L":
                endpoint = (segment[1], segment[2])
                points.append(endpoint)
            else:
                endpoint = (segment[5], segment[6])
                points.extend(
                    _flatten_cubic(
                        current,
                        (segment[1], segment[2]),
                        (segment[3], segment[4]),
                        endpoint,
                    )
                )
            current = endpoint
        if points[-1] != points[0]:
            points.append(points[0])
        if len(points) < 4:
            continue
        signed_area = sum(
            points[index][0] * points[index + 1][1]
            - points[index + 1][0] * points[index][1]
            for index in range(len(points) - 1)
        ) / 2.0
        polygon = _polygonal(make_valid(Polygon(points)))
        if not polygon.is_empty and polygon.area > 1e-8:
            rings.append((abs(signed_area), signed_area, polygon))
    if not rings:
        return Polygon()

    rings.sort(reverse=True, key=lambda item: item[0])
    if even_odd:
        result = Polygon()
        for _area, _signed_area, ring in rings:
            result = result.symmetric_difference(ring)
        return _polygonal(make_valid(result))

    dominant_sign = 1 if rings[0][1] >= 0 else -1
    result = Polygon()
    for _area, signed_area, ring in rings:
        ring_sign = 1 if signed_area >= 0 else -1
        result = result.union(ring) if ring_sign == dominant_sign else result.difference(ring)
    return _polygonal(make_valid(result))


def _parse_root(svg: str) -> ElementTree.Element:
    if "<!DOCTYPE" in svg.upper() or "<!ENTITY" in svg.upper():
        raise LogoSvgCleanupError("SVG chứa khai báo thực thể không được hỗ trợ.")
    try:
        root = ElementTree.fromstring(svg)
    except ElementTree.ParseError as exc:
        raise LogoSvgCleanupError("SVG không thể phân tích.") from exc
    if _local_name(root.tag) != "svg":
        raise LogoSvgCleanupError("Tài liệu đầu ra không có thẻ gốc SVG.")
    ElementTree.register_namespace("", _SVG_NAMESPACE)
    return root


def _path_entries(root: ElementTree.Element, *, drawable_only: bool) -> list[tuple]:
    entries: list[tuple] = []

    def walk(node: ElementTree.Element, parent: ElementTree.Element | None, hidden: bool, fill: str):
        local = _local_name(node.tag)
        next_hidden = hidden or local in {"defs", "mask", "clipPath"}
        next_fill = node.attrib.get("fill", fill).strip().lower()
        if local == "path" and node.attrib.get("d", "").strip():
            if not drawable_only or (not next_hidden and next_fill not in {"none", "transparent"}):
                entries.append((parent, node, next_fill, next_hidden))
        for child in list(node):
            walk(child, node, next_hidden, next_fill)

    walk(root, None, False, "#000000")
    return entries


def cleanup_redundant_logo_paths(
    svg: str,
    width_px: int,
    height_px: int,
    should_cancel: Callable[[], bool] | None = None,
) -> LogoSvgCleanupResult:
    """Xóa path nhỏ không đổi lớp màu đang nhìn thấy, không union toàn artwork."""

    from shapely.strtree import STRtree

    root = _parse_root(svg)
    entries = _path_entries(root, drawable_only=True)
    geometries = []
    for index, (_parent, node, _fill, _hidden) in enumerate(entries):
        if should_cancel is not None and index % 64 == 0 and should_cancel():
            raise LogoSvgCleanupCancelled("Đã hủy dọn SVG logo.")
        geometries.append(
            _path_geometry(
                node.attrib.get("d", ""),
                node.attrib.get("fill-rule", "nonzero").strip().lower() == "evenodd",
            )
        )
    nonempty_indices = [index for index, geometry in enumerate(geometries) if not geometry.is_empty]
    if not nonempty_indices:
        return LogoSvgCleanupResult(ElementTree.tostring(root, encoding="unicode"), 0)

    tree_geometries = [geometries[index] for index in nonempty_indices]
    tree = STRtree(tree_geometries)
    frame_area = max(1.0, float(width_px) * float(height_px))
    maximum_candidate_area = frame_area * _TINY_PATH_AREA_RATIO
    removed: set[int] = set()
    for index, candidate in enumerate(geometries):
        if should_cancel is not None and index % 64 == 0 and should_cancel():
            raise LogoSvgCleanupCancelled("Đã hủy dọn SVG logo.")
        candidate_area = candidate.area
        if candidate.is_empty or candidate_area > maximum_candidate_area:
            continue
        allowed_change = max(1e-6, candidate_area * (1.0 - _REDUNDANT_COVERAGE_RATIO))
        changed_area = 0.0
        residual = candidate
        try:
            hits = tree.query(candidate, predicate="intersects")
            previous_indices = sorted(
                (
                    nonempty_indices[int(hit)]
                    for hit in hits
                    if nonempty_indices[int(hit)] < index
                    and nonempty_indices[int(hit)] not in removed
                ),
                reverse=True,
            )
            for previous in previous_indices:
                if residual.is_empty:
                    break
                overlap = residual.intersection(geometries[previous])
                overlap_area = overlap.area
                if overlap_area <= 1e-7:
                    continue
                residual = residual.difference(overlap)
                if entries[previous][2] != entries[index][2]:
                    changed_area += overlap_area
                    if changed_area > allowed_change:
                        break
            if changed_area <= allowed_change:
                changed_area += residual.area
            if changed_area <= allowed_change:
                removed.add(index)
        except Exception:
            # Geometry lẻ lỗi số học thì giữ nguyên path; không đánh đổi chi tiết thật để dọn rác.
            continue

    for index in sorted(removed, reverse=True):
        parent, node, _fill, _hidden = entries[index]
        if parent is not None:
            parent.remove(node)
    return LogoSvgCleanupResult(
        ElementTree.tostring(root, encoding="unicode"),
        len(removed),
    )


def analyze_logo_svg(
    svg: str,
    width_px: int,
    height_px: int,
    removed_redundant_paths: int = 0,
    *,
    expected_physical_size_mm: tuple[float, float] | None = None,
    expected_artifact_sha256: str | None = None,
    require_physical_size: bool = False,
) -> LogoSvgQuality:
    """Trả QC có kiểu cho hình học, độ phức tạp và kích thước artifact."""

    root = _parse_root(svg)
    all_entries = _path_entries(root, drawable_only=False)
    drawable_entries = _path_entries(root, drawable_only=True)
    frame_area = max(1.0, float(width_px) * float(height_px))
    tiny_threshold = frame_area * _TINY_PATH_AREA_RATIO
    tiny_count = 0
    valid_drawable_count = 0
    out_of_bounds = False
    margin = max(2.0, max(width_px, height_px) * 0.005)
    for _parent, node, _fill, _hidden in all_entries:
        geometry = _path_geometry(
            node.attrib.get("d", ""),
            node.attrib.get("fill-rule", "nonzero").strip().lower() == "evenodd",
        )
        if not geometry.is_empty and geometry.area <= tiny_threshold:
            tiny_count += 1
    for _parent, node, _fill, _hidden in drawable_entries:
        geometry = _path_geometry(
            node.attrib.get("d", ""),
            node.attrib.get("fill-rule", "nonzero").strip().lower() == "evenodd",
        )
        if geometry.is_empty:
            continue
        valid_drawable_count += 1
        minimum_x, minimum_y, maximum_x, maximum_y = geometry.bounds
        if (
            minimum_x < -margin
            or minimum_y < -margin
            or maximum_x > width_px + margin
            or maximum_y > height_px + margin
        ):
            out_of_bounds = True

    path_count = len(all_entries)
    complexity = LogoSvgComplexity(
        path_count=path_count,
        drawable_path_count=valid_drawable_count,
        node_count=sum(
            len(_COMMAND_RE.findall(node.attrib.get("d", "")))
            for _parent, node, _fill, _hidden in all_entries
        ),
        tiny_path_count=tiny_count,
        tiny_path_ratio=round(tiny_count / path_count, 6) if path_count else 0.0,
        svg_bytes=len(svg.encode("utf-8")),
        removed_redundant_paths=removed_redundant_paths,
    )
    reasons: list[str] = []
    actions: list[str] = []
    # LOGO-ENGINE-V2 (audit 2026-08-11 Lô G2): validator Python đọc lại
    # chính artifact cuối; không tin hash native nếu chuỗi đã bị thay trên đường về.
    if expected_artifact_sha256 is not None:
        actual_sha256 = hashlib.sha256(svg.encode("utf-8")).hexdigest()
        if actual_sha256 != expected_artifact_sha256:
            reasons.append("Hash SVG cuối không khớp artifact do native xác nhận.")
            actions.append("Tạo lại preview; không dùng artifact đã thay đổi ngoài hợp đồng.")
    # LOGO-REBUILD (audit 2026-08-09 §LR3.03): QC chính chuỗi SVG cuối,
    # không suy rằng bước gắn metadata trước đó chắc chắn còn nguyên sau cleanup.
    view_box_raw = root.attrib.get("viewBox", "").replace(",", " ").split()
    try:
        view_box = [float(value) for value in view_box_raw]
    except ValueError:
        view_box = []
    if (
        len(view_box) != 4
        or not all(math.isfinite(value) for value in view_box)
        or not math.isclose(view_box[0], 0.0, abs_tol=1e-6)
        or not math.isclose(view_box[1], 0.0, abs_tol=1e-6)
        or not math.isclose(view_box[2], float(width_px), abs_tol=1e-4)
        or not math.isclose(view_box[3], float(height_px), abs_tol=1e-4)
    ):
        reasons.append("SVG đầu ra không giữ đúng viewBox theo kích thước ảnh làm việc.")
        actions.append("Tạo lại preview; không dùng artifact có hệ tọa độ sai.")

    if expected_physical_size_mm is not None:
        parsed_lengths: list[float] = []
        for attribute in ("width", "height"):
            match = _SVG_LENGTH_MM_RE.fullmatch(root.attrib.get(attribute, ""))
            if match is None:
                parsed_lengths = []
                break
            parsed_lengths.append(float(match.group(1)))
        expected_width_mm, expected_height_mm = expected_physical_size_mm
        if (
            len(parsed_lengths) != 2
            or not all(math.isfinite(value) and value > 0.0 for value in parsed_lengths)
            or not math.isclose(parsed_lengths[0], expected_width_mm, abs_tol=0.005)
            or not math.isclose(parsed_lengths[1], expected_height_mm, abs_tol=0.005)
        ):
            reasons.append(
                "SVG đầu ra không giữ đúng kích thước vật lý mm đã được người dùng xác nhận."
            )
            actions.append("Tạo lại preview sau khi xác nhận đúng chiều rộng/cao mm.")
    if valid_drawable_count == 0:
        reasons.append("SVG không có mảng vector nhìn thấy để sử dụng.")
        actions.append("Đổi chế độ hoặc bảng màu rồi tạo lại preview.")
    if out_of_bounds:
        reasons.append("SVG có hình học vượt quá vùng ảnh cho phép.")
        actions.append("Kiểm tra vùng crop/phối cảnh rồi tạo lại preview.")
    if reasons:
        return LogoSvgQuality("rejected", complexity, reasons, actions)

    review = False
    if require_physical_size and expected_physical_size_mm is None:
        reasons.append("Kích thước in mm chưa được người dùng xác nhận.")
        actions.append("Xác nhận chiều rộng/cao mm theo đúng tỷ lệ trước khi xuất SVG.")
        review = True
    if complexity.path_count > 1000:
        reasons.append("SVG còn quá nhiều mảng rời nên khó chỉnh sửa trong phần mềm vector.")
        review = True
    node_limit = max(20_000, round(frame_area * 0.004))
    if complexity.node_count > node_limit:
        reasons.append("SVG còn quá nhiều nút neo so với kích thước ảnh.")
        review = True
    if complexity.tiny_path_count > 100 and complexity.tiny_path_ratio > 0.65:
        reasons.append("SVG còn tỷ lệ mảng vụn cao; biên có thể lởm chởm khi phóng lớn.")
        review = True
    if complexity.svg_bytes > 2_000_000:
        reasons.append("Dung lượng SVG lớn bất thường cho một logo.")
        review = True
    if review:
        actions.append("Tăng mức khử hạt hoặc độ mượt rồi tạo lại preview trước khi xuất.")
        return LogoSvgQuality("review", complexity, reasons, actions)
    return LogoSvgQuality("ready", complexity, [], [])
