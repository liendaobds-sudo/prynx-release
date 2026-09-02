"""Adapter production cho chiến lược nesting tự do của Bình tem bế/CNC.

Module này là biên duy nhất dựng request cho Rust từ dữ liệu đã qua Pydantic/resolver.
Client không được sở hữu ``productionContract`` hay các hash hình học. Adapter chuẩn
hoá hình học, ghim render bundle và ép miền xoay tự do trước khi gọi native.
"""

from __future__ import annotations

import hashlib
import json
import math
import unicodedata
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from typing import Any, Mapping, Sequence

from app.core.mixed_nesting_service import (
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION,
    PRODUCTION_ALGORITHM_VERSION_KEYS,
)


TRUE_SHAPE_NESTING_STRATEGY = "true_shape_nesting"
RENDER_BUNDLE_SCHEMA_VERSION = 2
CANONICAL_DECIMAL_PLACES = 6
_QUANTUM = Decimal("0.000001")
_RENDER_TOOLS = frozenset({"sticker_imposer", "cnc_imposer"})
_RENDER_TASK_MODES = frozenset({"nup", "step_repeat"})
_LAYOUT_INTENTS = frozenset(
    {
        "quantity_fulfillment",
        "autofill_single_sheet",
        "step_repeat_single_sheet",
    }
)
_AUTOFILL_LAYOUT_INTENTS = frozenset(
    {"autofill_single_sheet", "step_repeat_single_sheet"}
)
_TRIM_MARK_TYPES = frozenset({"none", "corners", "guillotine"})
_TRIM_MARK_STYLES = frozenset({"default", "japanese"})
_PONT_TYPES = frozenset({"none", "corner", "5mm", "custom"})
_PONT_SHAPES = frozenset({"circle", "l_corner", "l_inverted"})
_PONT_GUIDE_POSITIONS = frozenset({"TL", "TR", "BL", "BR"})
_CUT_TYPES = frozenset({"default", "one_dao"})
_DIE_SIZE_MODES = frozenset({"die", "page"})
_REPORT_FIELD_KEYS = frozenset(
    {
        "orderCode",
        "identifier",
        "gangCount",
        "labelName",
        "material",
        "lamination",
        "labelsPerSheet",
        "actualQty",
        "sheetCount",
        "dimensions",
        "paperSize",
        "cutFileRef",
        "modeLabel",
    }
)
_REPORT_POSITIONS = frozenset({"top", "bottom", "left", "right"})
_LAMINATION_TYPES = frozenset({"none", "gloss", "matte"})
_IDENTITY_AFFINE = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
_ALLOWED_OBSTACLE_KINDS = frozenset(
    {"gripper", "sheet_mark", "cnc_exclude_zone", "keep_out"}
)
# NEST (audit 2026-08-28 §A1.1): cách NHẬN DIỆN nét bế trong file nguồn.
# "spot" = kênh Separation/DeviceN thật; "process" = màu process trong file.
_CUT_SOURCE_MODES = frozenset({"spot", "process"})
# Không gian màu dùng để VẼ nét CUT trên tờ ra.
_CUT_PROCESS_SPACES = frozenset({"cmyk", "rgb", "gray"})
_CUT_STROKE_SPACES = frozenset({"cmyk", "rgb", "gray", "separation"})
# Số thành phần màu bắt buộc theo từng không gian; separation chỉ có một tint.
_CUT_SPACE_ARITY: dict[str, int] = {
    "cmyk": 4,
    "rgb": 3,
    "gray": 1,
    "separation": 1,
}
# Trần vật lý: nét bế dày quá là lỗi nhập, không phải lựa chọn nghiệp vụ.
_CUT_STROKE_MAX_WIDTH_MM = 10.0
# Dung sai so màu là tỉ lệ [0..1] trên từng kênh, không phải mm.
_CUT_COLOR_TOLERANCE_MAX = 0.5
# Dung sai gộp hình học khi so nét bế; lớn hơn 1mm là mất khả năng phân biệt nét.
_CUT_GEOMETRY_TOLERANCE_MAX_MM = 1.0
_CUT_NAME_MAX_LEN = 128
# NEST (audit 2026-08-28 §A2.1): miền xoay cấp job. `inherit` chỉ hợp lệ ở cấp
# chi tiết — Rust trả ROTATION_INHERIT_NOT_ALLOWED_AT_JOB_LEVEL nếu gặp ở đây.
_ROTATION_JOB_MODES = frozenset({"free", "fixed", "discrete", "ranges"})
# Hai mode dưới đây mang VÔ HẠN góc. Chặng A chưa được mở chúng: số đo Lô 0 cho
# thấy free-angle còn kém cardinal ở 8/9 ca, nên mở sớm là đẩy job của thợ in
# vào phương án tệ hơn đường hiện hữu.
_ROTATION_CONTINUOUS_MODES = frozenset({"free", "ranges"})
_ROTATION_MODE_PARAM = {
    "free": None,
    "fixed": "angleDeg",
    "discrete": "anglesDeg",
    "ranges": "arcs",
}
# Giữ đồng bộ với imposition_core/src/mixed_nesting/model.rs.
_MAX_ROTATION_ANGLES = 4_096
_MAX_ROTATION_ARCS = 1_024
CARDINAL_ANGLES_DEG: tuple[float, ...] = (0.0, 90.0, 180.0, 270.0)
# Mặc định của Chặng A. Đổi mặc định này là quyết định rollout, không phải chi
# tiết cài đặt — nó quyết định mọi job production chạy miền góc nào.
_CARDINAL_ROTATION_POLICY: dict[str, Any] = {
    "defaultRotation": {
        "mode": "discrete",
        "anglesDeg": list(CARDINAL_ANGLES_DEG),
    },
    "reflection": "forbidden",
}
_PUBLIC_REQUEST_KEYS = frozenset(
    {
        "protocolVersion",
        "seed",
        "profile",
        "timeBudgetMs",
        "sheet",
        "gapMm",
        "layoutIntent",
        "orientationPolicy",
        "parts",
    }
)
_PUBLIC_PART_KEYS = frozenset(
    {"partId", "quantity", "outer", "holes", "rotationConstraint"}
)
_SERVER_PART_KEYS = frozenset(
    {"referencePointMm", "geometryHash", "sourceRevision"}
)


class ProductionAdapterError(ValueError):
    """Lỗi contract adapter có mã ổn định để route map fail-closed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = 422


@dataclass(frozen=True)
class ProductionNestingRequest:
    """Request engine và các identity phải persist cùng manifest cuối."""

    engine_request: dict[str, Any]
    render_bundle: dict[str, Any]
    render_bundle_hash: str
    input_hash: str
    solver_config_hash: str
    geometry_constraints_hash: str
    layout_fingerprint: str
    algorithm_versions: dict[str, int | str]
    native_build_identity: str


@dataclass(frozen=True)
class RenderPolygonV1:
    """Đa giác một outer và các hole trong hệ canonical mm."""

    outer: tuple[tuple[float, float], ...]
    holes: tuple[tuple[tuple[float, float], ...], ...]

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "outer": [list(point) for point in self.outer],
            "holes": [[list(point) for point in hole] for hole in self.holes],
        }


@dataclass(frozen=True)
class RenderCutSourceFilterV2:
    """Khoá cách nhận diện nét bế trong PDF nguồn.

    Writer phải chọn đúng tập nét mà die detection đã chọn. Nếu tiêu chí này
    không nằm trong bundle bất biến, preview và export có thể chọn hai tập nét
    khác nhau trên cùng một file mà không ai phát hiện.
    """

    mode: str
    spot_names: tuple[str, ...]
    process_space: str | None
    process_components: tuple[float, ...] | None
    color_tolerance: float
    die_layer_names: tuple[str, ...]
    geometry_tolerance_mm: float

    def to_canonical_dict(self) -> dict[str, Any]:
        process_color: dict[str, Any] | None = None
        if self.process_space is not None:
            process_color = {
                "space": self.process_space,
                "components": list(self.process_components or ()),
            }
        return {
            "mode": self.mode,
            "spotNames": list(self.spot_names),
            "processColor": process_color,
            "colorTolerance": self.color_tolerance,
            "dieLayerNames": list(self.die_layer_names),
            "geometryToleranceMm": self.geometry_tolerance_mm,
        }


@dataclass(frozen=True)
class RenderCutStrokeV2:
    """Khoá cách VẼ nét CUT trên tờ ra: độ dày, màu, overprint.

    NEST (audit 2026-08-28 §A3.1): với ``colorSpace = separation``, PDF đòi
    ``[/Separation /Name <alternate space> <tint transform>]``. Tint + tên kênh
    KHÔNG đủ để dựng colorspace hợp lệ, nên contract phải mang thêm ``alternate``.
    Trước khi có trường này, writer buộc phải fail-closed.
    """

    width_mm: float
    color_space: str
    components: tuple[float, ...]
    separation_name: str | None
    alternate_space: str | None
    alternate_components: tuple[float, ...] | None
    overprint: bool

    def to_canonical_dict(self) -> dict[str, Any]:
        alternate: dict[str, Any] | None = None
        if self.alternate_space is not None:
            alternate = {
                "space": self.alternate_space,
                "components": list(self.alternate_components or ()),
            }
        return {
            "widthMm": self.width_mm,
            "colorSpace": self.color_space,
            "components": list(self.components),
            "separationName": self.separation_name,
            "alternate": alternate,
            "overprint": self.overprint,
        }


@dataclass(frozen=True)
class RenderCutStyleV2:
    """Hợp đồng nét bế đủ để writer dựng lớp CUT mà không đọc state mutable.

    Một bundle chỉ có MỘT cutStyle, nên Front/Back/Cut của cùng tờ không thể
    lệch nét bế — bất biến này được bảo đảm ở cấp kiểu, không cần test canh.
    """

    source_filter: RenderCutSourceFilterV2
    stroke: RenderCutStrokeV2

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "sourceFilter": self.source_filter.to_canonical_dict(),
            "stroke": self.stroke.to_canonical_dict(),
        }


@dataclass(frozen=True)
class PageBoxesV1:
    """Ba page box bắt buộc, đã đổi sang mm nhưng giữ nguyên origin nguồn."""

    media_box: tuple[float, float, float, float]
    crop_box: tuple[float, float, float, float]
    trim_box: tuple[float, float, float, float]

    def to_canonical_dict(self) -> dict[str, list[float]]:
        return {
            "mediaBox": list(self.media_box),
            "cropBox": list(self.crop_box),
            "trimBox": list(self.trim_box),
        }


@dataclass(frozen=True)
class PageBindingV2:
    """Ánh xạ một trang nguồn sang cùng frame canonical của part."""

    page_index: int
    page_boxes_mm: PageBoxesV1
    user_unit: float
    rotate_deg: int
    source_page_to_canonical: tuple[float, float, float, float, float, float]
    source_reference_point_mm: tuple[float, float]

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "pageIndex": self.page_index,
            "pageBoxesMm": self.page_boxes_mm.to_canonical_dict(),
            "userUnit": self.user_unit,
            "rotateDeg": self.rotate_deg,
            "sourcePageToCanonical": list(self.source_page_to_canonical),
            "sourceReferencePointMm": list(self.source_reference_point_mm),
        }


@dataclass(frozen=True)
class RenderSourceV2:
    """Identity bất biến của PDF nguồn dùng cho mọi side của một part."""

    locator_id: str
    content_hash: str
    byte_size: int
    page_count: int
    revision: str

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "locatorId": self.locator_id,
            "contentHash": self.content_hash,
            "byteSize": self.byte_size,
            "pageCount": self.page_count,
            "revision": self.revision,
        }


@dataclass(frozen=True)
class RenderBundlePartV2:
    """PartDefinition đủ dữ liệu để preview/export không đọc state mutable."""

    part_id: str
    reference_point_mm: tuple[float, float]
    geometry_hash: str
    packing_footprint: RenderPolygonV1
    cut_contour: RenderPolygonV1
    artwork_clip_path: RenderPolygonV1
    die_dimensions_mm: tuple[float, float] | None
    source: RenderSourceV2
    front: PageBindingV2
    back: PageBindingV2 | None
    cut: PageBindingV2

    def to_canonical_dict(self) -> dict[str, Any]:
        value = {
            "partId": self.part_id,
            "referencePointMm": list(self.reference_point_mm),
            "geometryHash": self.geometry_hash,
            "packingFootprint": self.packing_footprint.to_canonical_dict(),
            "cutContour": self.cut_contour.to_canonical_dict(),
            "artworkClipPath": self.artwork_clip_path.to_canonical_dict(),
            "source": self.source.to_canonical_dict(),
            "pages": {
                "front": self.front.to_canonical_dict(),
                "back": None if self.back is None else self.back.to_canonical_dict(),
                "cut": self.cut.to_canonical_dict(),
            },
        }
        # Bundle V2 cũ không có field này vẫn đọc được; mọi bundle mới do builder
        # production tạo đều phải mang kích thước authoritative.
        if self.die_dimensions_mm is not None:
            value["dieDimensionsMm"] = {
                "width": self.die_dimensions_mm[0],
                "height": self.die_dimensions_mm[1],
            }
        return value


@dataclass(frozen=True)
class RenderBundleV2:
    """Bundle typed/canonical được persist nguyên khối cùng manifest."""
    flow: dict[str, str]
    output_sides: tuple[str, ...]
    duplex: dict[str, str]
    marks: dict[str, Any]
    artifact_options: dict[str, Any]
    sheet_frames: dict[
        str, tuple[float, float, float, float, float, float] | None
    ]
    renderer: dict[str, str]
    cut_style: RenderCutStyleV2
    parts: tuple[RenderBundlePartV2, ...]
    schema_version: int = RENDER_BUNDLE_SCHEMA_VERSION

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "flow": dict(self.flow),
            "outputSides": list(self.output_sides),
            "duplex": dict(self.duplex),
            "marks": self.marks,
            "artifactOptions": self.artifact_options,
            "sheetFrames": {
                side: None if matrix is None else list(matrix)
                for side, matrix in self.sheet_frames.items()
            },
            "renderer": dict(self.renderer),
            "cutStyle": self.cut_style.to_canonical_dict(),
            "parts": [part.to_canonical_dict() for part in self.parts],
        }


def _error(message: str) -> ProductionAdapterError:
    return ProductionAdapterError("NESTING_PRODUCTION_CONTRACT_INVALID", message)


def _has_control(value: str) -> bool:
    return any(unicodedata.category(character) == "Cc" for character in value)


def _as_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _error(f"{field} phải là object.")
    return value


def _quantized_decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise _error(f"{field} phải là số hữu hạn.")
    try:
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            raise _error(f"{field} phải là số hữu hạn.")
        digits = len(decimal_value.as_tuple().digits)
        with localcontext() as context:
            context.prec = max(50, digits + abs(decimal_value.adjusted()) + 16)
            rounded = decimal_value.quantize(_QUANTUM, rounding=ROUND_HALF_EVEN)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise _error(f"{field} không thể chuẩn hoá ở độ chính xác 6 chữ số.") from exc
    return Decimal(0) if rounded == 0 else rounded


def _quantized_float(value: Any, field: str) -> float:
    result = float(_quantized_decimal(value, field))
    if not math.isfinite(result):
        raise _error(f"{field} nằm ngoài miền số thực hỗ trợ.")
    return 0.0 if result == 0.0 else result


def _json_string(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise _error("Chuỗi canonical chứa mã Unicode không hợp lệ.") from exc
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _canonical_encode(value: Any) -> str:
    """Encode JSON xác định: key theo byte UTF-8, float luôn đúng 6 chữ số."""

    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (float, Decimal)):
        return format(_quantized_decimal(value, "canonical number"), ".6f")
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical_encode(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise _error("Mọi key canonical phải là chuỗi.")
        keys = sorted(value, key=lambda key: key.encode("utf-8"))
        return "{" + ",".join(
            f"{_json_string(key)}:{_canonical_encode(value[key])}" for key in keys
        ) + "}"
    raise _error(f"Kiểu dữ liệu {type(value).__name__} không được phép trong canonical JSON.")


def canonical_json_bytes(value: Any) -> bytes:
    """Trả canonical JSON UTF-8 dùng chung cho mọi hash production."""

    return _canonical_encode(value).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    """Băm canonical JSON theo định dạng contract ``sha256:<hex thường>``."""

    return "sha256:" + hashlib.sha256(canonical_json_bytes(value)).hexdigest()

def _ring_area(ring: Sequence[Sequence[float]]) -> float:
    return 0.5 * sum(
        ring[index][0] * ring[(index + 1) % len(ring)][1]
        - ring[(index + 1) % len(ring)][0] * ring[index][1]
        for index in range(len(ring))
    )


def _canonical_ring(raw: Any, field: str, *, ccw: bool) -> list[list[float]]:
    if not isinstance(raw, (list, tuple)):
        raise _error(f"{field} phải là mảng điểm.")
    points: list[list[float]] = []
    for index, raw_point in enumerate(raw):
        if not isinstance(raw_point, (list, tuple)) or len(raw_point) != 2:
            raise _error(f"{field}[{index}] phải có đúng hai toạ độ.")
        point = [
            _quantized_float(raw_point[0], f"{field}[{index}][0]"),
            _quantized_float(raw_point[1], f"{field}[{index}][1]"),
        ]
        if not points or point != points[-1]:
            points.append(point)
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if len(points) < 3 or len({(point[0], point[1]) for point in points}) < 3:
        raise _error(f"{field} phải còn ít nhất ba đỉnh phân biệt sau chuẩn hoá.")

    area = _ring_area(points)
    if not math.isfinite(area) or area == 0.0:
        raise _error(f"{field} có diện tích bằng 0 hoặc không hữu hạn.")
    if (area > 0.0) != ccw:
        points.reverse()

    # NEST (audit 2026-08-27): cùng quy tắc score::bottom_left_order — y trước, x sau.
    start = min(range(len(points)), key=lambda index: (points[index][1], points[index][0]))
    return points[start:] + points[:start]


def _polygon_centroid(ring: Sequence[Sequence[float]], field: str) -> list[float]:
    double_area = 0.0
    sum_x = 0.0
    sum_y = 0.0
    for index, current in enumerate(ring):
        following = ring[(index + 1) % len(ring)]
        cross = current[0] * following[1] - following[0] * current[1]
        double_area += cross
        sum_x += (current[0] + following[0]) * cross
        sum_y += (current[1] + following[1]) * cross
    if not math.isfinite(double_area) or abs(double_area) <= 1e-12:
        raise _error(f"{field} không suy được reference point ổn định.")
    factor = 1.0 / (3.0 * double_area)
    return [
        _quantized_float(sum_x * factor, f"{field}.referencePointMm[0]"),
        _quantized_float(sum_y * factor, f"{field}.referencePointMm[1]"),
    ]


def _require_exact_fields(
    value: Mapping[str, Any], expected: set[str] | frozenset[str], field: str
) -> None:
    missing = set(expected).difference(value)
    unknown = set(value).difference(expected)
    details: list[str] = []
    if missing:
        details.append(f"thiếu {', '.join(sorted(missing))}")
    if unknown:
        details.append(f"có field lạ {', '.join(sorted(unknown))}")
    if details:
        raise _error(f"{field} {'; '.join(details)}.")


def _canonical_polygon(raw: Any, field: str) -> RenderPolygonV1:
    polygon = _as_mapping(raw, field)
    _require_exact_fields(polygon, {"outer", "holes"}, field)
    outer = _canonical_ring(polygon["outer"], f"{field}.outer", ccw=True)
    raw_holes = polygon["holes"]
    if not isinstance(raw_holes, (list, tuple)):
        raise _error(f"{field}.holes phải là mảng.")
    holes = [
        _canonical_ring(hole, f"{field}.holes[{index}]", ccw=False)
        for index, hole in enumerate(raw_holes)
    ]
    holes.sort(key=canonical_json_bytes)
    return RenderPolygonV1(
        outer=tuple((point[0], point[1]) for point in outer),
        holes=tuple(
            tuple((point[0], point[1]) for point in hole)
            for hole in holes
        ),
    )


def _canonical_die_dimensions(
    raw: Any, field: str
) -> tuple[float, float]:
    dimensions = _as_mapping(raw, field)
    _require_exact_fields(dimensions, {"width", "height"}, field)
    width = _quantized_float(dimensions["width"], f"{field}.width")
    height = _quantized_float(dimensions["height"], f"{field}.height")
    if width <= 0.0 or height <= 0.0:
        raise _error(f"{field} phải có chiều rộng và chiều cao dương.")
    return width, height


def _canonical_page_box(raw: Any, field: str) -> tuple[float, float, float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        raise _error(f"{field} phải có đúng bốn toạ độ [x0, y0, x1, y1].")
    box = tuple(
        _quantized_float(value, f"{field}[{index}]")
        for index, value in enumerate(raw)
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        raise _error(f"{field} phải có chiều rộng và chiều cao dương.")
    return box


def _canonical_page_boxes(raw: Any, field: str) -> PageBoxesV1:
    boxes = _as_mapping(raw, field)
    _require_exact_fields(boxes, {"mediaBox", "cropBox", "trimBox"}, field)
    return PageBoxesV1(
        media_box=_canonical_page_box(boxes["mediaBox"], f"{field}.mediaBox"),
        crop_box=_canonical_page_box(boxes["cropBox"], f"{field}.cropBox"),
        trim_box=_canonical_page_box(boxes["trimBox"], f"{field}.trimBox"),
    )


def _canonical_affine(
    raw: Any, field: str
) -> tuple[float, float, float, float, float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 6:
        raise _error(f"{field} phải có đúng sáu hệ số [a, b, c, d, e, f].")
    affine = tuple(
        _quantized_float(value, f"{field}[{index}]")
        for index, value in enumerate(raw)
    )
    determinant = affine[0] * affine[3] - affine[1] * affine[2]
    norm_x = affine[0] ** 2 + affine[1] ** 2
    norm_y = affine[2] ** 2 + affine[3] ** 2
    dot = affine[0] * affine[2] + affine[1] * affine[3]
    scale = max(norm_x, norm_y, 1e-12)
    if (
        not math.isfinite(determinant)
        or determinant <= 1e-12
        or abs(norm_x - norm_y) > scale * 1e-6
        or abs(dot) > scale * 1e-6
    ):
        raise _error(f"{field} phải là phép quay/tịnh tiến/tỷ lệ đều, không mirror.")
    return affine


def _canonical_invertible_affine(
    raw: Any, field: str
) -> tuple[float, float, float, float, float, float]:
    if not isinstance(raw, (list, tuple)) or len(raw) != 6:
        raise _error(f"{field} phải có đúng sáu hệ số [a, b, c, d, e, f].")
    affine = tuple(
        _quantized_float(value, f"{field}[{index}]")
        for index, value in enumerate(raw)
    )
    determinant = affine[0] * affine[3] - affine[1] * affine[2]
    if not math.isfinite(determinant) or abs(determinant) <= 1e-12:
        raise _error(f"{field} phải là ma trận affine khả nghịch.")
    return affine


def _expected_source_affine(
    boxes: PageBoxesV1, rotation: int, field: str
) -> tuple[float, float, float, float, float, float]:
    """Suy ma trận nguồn từ MediaBox vật lý và /Rotate, không tin resolver."""

    x0, y0, x1, y1 = boxes.media_box
    if rotation == 0:
        values = (1.0, 0.0, 0.0, 1.0, -x0, -y0)
    elif rotation == 90:
        values = (0.0, -1.0, 1.0, 0.0, -y0, x1)
    elif rotation == 180:
        values = (-1.0, 0.0, 0.0, -1.0, x1, y1)
    else:
        values = (0.0, 1.0, -1.0, 0.0, y1, -x0)
    return tuple(
        _quantized_float(value, f"{field}[{index}]")
        for index, value in enumerate(values)
    )


def _source_reference_point(
    affine: tuple[float, float, float, float, float, float],
    canonical_reference: Sequence[float],
    field: str,
) -> tuple[float, float]:
    """Suy điểm đăng ký nguồn và chứng minh affine đưa nó về pivot part."""

    a, b, c, d, e, f = affine
    determinant = a * d - b * c
    delta_x = canonical_reference[0] - e
    delta_y = canonical_reference[1] - f
    source_x = _quantized_float(
        (d * delta_x - c * delta_y) / determinant, f"{field}[0]"
    )
    source_y = _quantized_float(
        (-b * delta_x + a * delta_y) / determinant, f"{field}[1]"
    )
    mapped = [
        _quantized_float(a * source_x + c * source_y + e, f"{field}.mapped[0]"),
        _quantized_float(b * source_x + d * source_y + f, f"{field}.mapped[1]"),
    ]
    if mapped != list(canonical_reference):
        raise _error(
            f"{field} không khớp referencePointMm của part ở độ chính xác 6 chữ số."
        )
    return (source_x, source_y)


def _canonical_page_binding(
    raw: Any,
    field: str,
    *,
    source: RenderSourceV2,
    reference_point: Sequence[float],
) -> PageBindingV2:
    binding = _as_mapping(raw, field)
    _require_exact_fields(
        binding,
        {
            "pageIndex",
            "pageBoxesMm",
            "userUnit",
            "rotateDeg",
            "sourcePageToCanonical",
        },
        field,
    )
    page_index = binding["pageIndex"]
    if (
        isinstance(page_index, bool)
        or not isinstance(page_index, int)
        or not 0 <= page_index < source.page_count
    ):
        raise _error(f"{field}.pageIndex phải nằm trong [0, source.pageCount).")
    boxes = _canonical_page_boxes(binding["pageBoxesMm"], f"{field}.pageBoxesMm")
    user_unit = _quantized_float(binding["userUnit"], f"{field}.userUnit")
    if not 0.0 < user_unit <= 75000.0:
        raise _error(f"{field}.userUnit phải lớn hơn 0 và không vượt 75000.")
    rotation = binding["rotateDeg"]
    if (
        isinstance(rotation, bool)
        or not isinstance(rotation, int)
        or rotation not in {0, 90, 180, 270}
    ):
        raise _error(f"{field}.rotateDeg chỉ nhận 0, 90, 180 hoặc 270.")
    affine = _canonical_affine(
        binding["sourcePageToCanonical"], f"{field}.sourcePageToCanonical"
    )
    expected_affine = _expected_source_affine(
        boxes, rotation, f"{field}.sourcePageToCanonical"
    )
    if affine != expected_affine:
        raise _error(
            f"{field}.sourcePageToCanonical không khớp MediaBox và /Rotate nguồn."
        )
    return PageBindingV2(
        page_index=page_index,
        page_boxes_mm=boxes,
        user_unit=user_unit,
        rotate_deg=rotation,
        source_page_to_canonical=affine,
        source_reference_point_mm=_source_reference_point(
            affine, reference_point, f"{field}.sourceReferencePointMm"
        ),
    )


def _canonical_render_source(raw: Any, field: str) -> RenderSourceV2:
    source = _as_mapping(raw, field)
    _require_exact_fields(
        source,
        {"locatorId", "contentHash", "byteSize", "pageCount", "revision"},
        field,
    )
    locator_id = source["locatorId"]
    try:
        canonical_locator = (
            str(uuid.UUID(locator_id)) if isinstance(locator_id, str) else ""
        )
    except (ValueError, AttributeError):
        canonical_locator = ""
    if canonical_locator != locator_id:
        raise _error(
            f"{field}.locatorId phải là UUID canonical chữ thường có dấu gạch nối."
        )
    content_hash = source["contentHash"]
    if (
        not isinstance(content_hash, str)
        or len(content_hash) != 71
        or not content_hash.startswith("sha256:")
        or any(character not in "0123456789abcdef" for character in content_hash[7:])
    ):
        raise _error(f"{field}.contentHash phải có dạng sha256: + 64 ký tự hex thường.")
    byte_size = source["byteSize"]
    if isinstance(byte_size, bool) or not isinstance(byte_size, int) or byte_size <= 0:
        raise _error(f"{field}.byteSize phải là số nguyên dương.")
    page_count = source["pageCount"]
    if (
        isinstance(page_count, bool)
        or not isinstance(page_count, int)
        or page_count <= 0
    ):
        raise _error(f"{field}.pageCount phải là số nguyên dương.")
    revision = source["revision"]
    if (
        not isinstance(revision, str)
        or not revision.strip()
        or len(revision) > 512
        or _has_control(revision)
    ):
        raise _error(f"{field}.revision phải là chuỗi không rỗng, tối đa 512 ký tự.")
    _json_string(revision)
    if revision != content_hash:
        raise _error(f"{field}.revision phải bằng contentHash của source pin V2.")
    return RenderSourceV2(
        locator_id=locator_id,
        content_hash=content_hash,
        byte_size=byte_size,
        page_count=page_count,
        revision=revision,
    )


def _validate_render_geometry(
    *,
    packing_footprint: RenderPolygonV1,
    cut_contour: RenderPolygonV1,
    artwork_clip_path: RenderPolygonV1,
    field: str,
) -> None:
    """Chặn geometry renderer suy biến và painted region vượt footprint."""

    try:
        from shapely.geometry import Polygon
    except ImportError as exc:  # pragma: no cover - dependency production bắt buộc
        raise _error("Thiếu thư viện kiểm tra hình học render production.") from exc

    def polygon(value: RenderPolygonV1, name: str):
        shape = Polygon(value.outer, value.holes)
        if shape.is_empty or not shape.is_valid or shape.area <= 1e-12:
            raise _error(f"{field}.{name} không phải polygon renderer hợp lệ.")
        return shape

    polygon(packing_footprint, "packingFootprint")
    # Kernel V1 coi hole của packing footprint là vật liệu đặc, nên containment
    # renderer cũng dùng outer đặc để không vô tình mở nesting vào cửa sổ khuôn.
    packing_outer = Polygon(packing_footprint.outer)
    if packing_outer.is_empty or not packing_outer.is_valid:
        raise _error(f"{field}.packingFootprint.outer không hợp lệ.")
    cut_shape = polygon(cut_contour, "cutContour")
    clip_shape = polygon(artwork_clip_path, "artworkClipPath")
    containment = packing_outer.buffer(10 ** -CANONICAL_DECIMAL_PLACES)
    if not containment.covers(cut_shape):
        raise _error(f"{field}.cutContour vượt ngoài packingFootprint.")
    if not containment.covers(clip_shape):
        raise _error(f"{field}.artworkClipPath vượt ngoài packingFootprint.")


# NEST (audit 2026-08-28 §4B1): mọi context ảnh hưởng artifact phải đi vào
# canonical bundle; không suy lại từ profile/UI sau khi manifest đã chốt.
def _canonical_render_flow(raw: Any, request_layout_intent: str) -> dict[str, str]:
    field = "renderBundle.flow"
    flow = _as_mapping(raw, field)
    _require_exact_fields(flow, {"tool", "taskMode", "layoutIntent"}, field)
    tool = flow["tool"]
    task_mode = flow["taskMode"]
    layout_intent = flow["layoutIntent"]
    if not isinstance(tool, str) or tool not in _RENDER_TOOLS:
        raise _error(f"{field}.tool không được hỗ trợ.")
    if not isinstance(task_mode, str) or task_mode not in _RENDER_TASK_MODES:
        raise _error(f"{field}.taskMode không được hỗ trợ.")
    if (
        not isinstance(layout_intent, str)
        or layout_intent not in _LAYOUT_INTENTS
        or layout_intent != request_layout_intent
    ):
        raise _error(f"{field}.layoutIntent không khớp request production.")
    return {"tool": tool, "taskMode": task_mode, "layoutIntent": layout_intent}


def _canonical_render_duplex(raw: Any, _sheet: Mapping[str, Any]) -> dict[str, str]:
    field = "renderBundle.duplex"
    duplex = _as_mapping(raw, field)
    _require_exact_fields(duplex, {"mode", "flipEdge", "physicalAxis"}, field)
    mode = duplex["mode"]
    flip_edge = duplex["flipEdge"]
    physical_axis = duplex["physicalAxis"]
    if mode == "simplex":
        expected = ("none", "none")
    elif (
        mode == "duplex"
        and isinstance(flip_edge, str)
        and flip_edge in {"long", "short"}
    ):
        expected = (flip_edge, "x" if flip_edge == "long" else "y")
    else:
        raise _error(f"{field}.mode/flipEdge không tạo thành chế độ hợp lệ.")
    if (flip_edge, physical_axis) != expected:
        raise _error(
            f"{field}.physicalAxis không khớp cạnh lật của workflow CNC hiện hữu."
        )
    return {"mode": mode, "flipEdge": flip_edge, "physicalAxis": physical_axis}


def _canonical_pont_config(raw: Any, field: str) -> dict[str, Any]:
    config = _as_mapping(raw, field)
    _require_exact_fields(
        config,
        {
            "shape",
            "sizeMm",
            "thicknessMm",
            "isGraphtec",
            "layerInfoName",
            "layerName",
            "groupName",
            "itemName",
            "disableCollision",
            "marginsMm",
            "guides",
        },
        field,
    )
    shape = config["shape"]
    if not isinstance(shape, str) or shape not in _PONT_SHAPES:
        raise _error(f"{field}.shape không được hỗ trợ.")
    size_mm = _quantized_float(config["sizeMm"], f"{field}.sizeMm")
    thickness_mm = _quantized_float(config["thicknessMm"], f"{field}.thicknessMm")
    if size_mm <= 0.0 or thickness_mm <= 0.0:
        raise _error(f"{field}.sizeMm/thicknessMm phải lớn hơn 0.")
    for key in ("isGraphtec", "disableCollision"):
        if not isinstance(config[key], bool):
            raise _error(f"{field}.{key} phải là boolean.")
    names: dict[str, str] = {}
    for key in ("layerInfoName", "layerName", "groupName", "itemName"):
        value = config[key]
        allow_empty = key == "layerInfoName" and not config["isGraphtec"]
        if (
            not isinstance(value, str)
            or (not allow_empty and not value.strip())
            or len(value) > 512
            or _has_control(value)
        ):
            raise _error(f"{field}.{key} không hợp lệ.")
        names[key] = value.strip()
        _json_string(names[key])
    margins = _as_mapping(config["marginsMm"], f"{field}.marginsMm")
    _require_exact_fields(
        margins, {"top", "bottom", "left", "right"}, f"{field}.marginsMm"
    )
    canonical_margins = {
        key: _quantized_float(margins[key], f"{field}.marginsMm.{key}")
        for key in ("top", "bottom", "left", "right")
    }
    if any(value < 0.0 for value in canonical_margins.values()):
        raise _error(f"{field}.marginsMm không được âm.")
    raw_guides = config["guides"]
    if not isinstance(raw_guides, (list, tuple)) or len(raw_guides) > 2:
        raise _error(f"{field}.guides phải là mảng có tối đa hai guide.")
    guides: list[dict[str, Any]] = []
    for index, raw_guide in enumerate(raw_guides):
        guide_field = f"{field}.guides[{index}]"
        guide = _as_mapping(raw_guide, guide_field)
        _require_exact_fields(
            guide,
            {"position", "lengthMm", "thicknessMm", "offsetXmm", "offsetYmm"},
            guide_field,
        )
        position = guide["position"]
        if not isinstance(position, str) or position not in _PONT_GUIDE_POSITIONS:
            raise _error(f"{guide_field}.position không được hỗ trợ.")
        length_mm = _quantized_float(guide["lengthMm"], f"{guide_field}.lengthMm")
        guide_thickness = _quantized_float(
            guide["thicknessMm"], f"{guide_field}.thicknessMm"
        )
        if length_mm <= 0.0 or guide_thickness <= 0.0:
            raise _error(f"{guide_field}.lengthMm/thicknessMm phải lớn hơn 0.")
        guides.append(
            {
                "position": position,
                "lengthMm": length_mm,
                "thicknessMm": guide_thickness,
                "offsetXmm": _quantized_float(
                    guide["offsetXmm"], f"{guide_field}.offsetXmm"
                ),
                "offsetYmm": _quantized_float(
                    guide["offsetYmm"], f"{guide_field}.offsetYmm"
                ),
            }
        )
    if len({guide["position"] for guide in guides}) != len(guides):
        raise _error(f"{field}.guides không được trùng position.")
    return {
        "shape": shape,
        "sizeMm": size_mm,
        "thicknessMm": thickness_mm,
        "isGraphtec": config["isGraphtec"],
        **names,
        "disableCollision": config["disableCollision"],
        "marginsMm": canonical_margins,
        "guides": guides,
    }


def _canonical_cut_output(raw: Any, field: str) -> dict[str, Any]:
    cut = _as_mapping(raw, field)
    _require_exact_fields(
        cut,
        {
            "type",
            "separatePage",
            "pontsOnCutFile",
            "fillBlockGapMm",
            "dieSizeMode",
            "dieOffsetMm",
        },
        field,
    )
    cut_type = cut["type"]
    die_size_mode = cut["dieSizeMode"]
    if not isinstance(cut_type, str) or cut_type not in _CUT_TYPES:
        raise _error(f"{field}.type không được hỗ trợ.")
    if not isinstance(die_size_mode, str) or die_size_mode not in _DIE_SIZE_MODES:
        raise _error(f"{field}.dieSizeMode không được hỗ trợ.")
    for key in ("separatePage", "pontsOnCutFile"):
        if not isinstance(cut[key], bool):
            raise _error(f"{field}.{key} phải là boolean.")
    fill_block_gap = _quantized_float(
        cut["fillBlockGapMm"], f"{field}.fillBlockGapMm"
    )
    if fill_block_gap < 0.0:
        raise _error(f"{field}.fillBlockGapMm không được âm.")
    return {
        "type": cut_type,
        "separatePage": cut["separatePage"],
        "pontsOnCutFile": cut["pontsOnCutFile"],
        "fillBlockGapMm": fill_block_gap,
        "dieSizeMode": die_size_mode,
        "dieOffsetMm": _quantized_float(
            cut["dieOffsetMm"], f"{field}.dieOffsetMm"
        ),
    }


def _canonical_cut_name(raw: Any, field: str) -> str:
    """Tên spot/separation/layer: NFC, bỏ khoảng trắng biên, hạ chữ thường."""

    if not isinstance(raw, str):
        raise _error(f"{field} phải là chuỗi.")
    name = unicodedata.normalize("NFC", raw.strip()).lower()
    if not name or _has_control(name) or len(name) > _CUT_NAME_MAX_LEN:
        raise _error(
            f"{field} rỗng, chứa ký tự điều khiển hoặc dài quá "
            f"{_CUT_NAME_MAX_LEN} ký tự."
        )
    return name


def _canonical_cut_name_list(raw: Any, field: str) -> tuple[str, ...]:
    """Danh sách tên đã chuẩn hoá, loại trùng, sắp theo byte UTF-8."""

    if isinstance(raw, (str, bytes)) or not isinstance(raw, (list, tuple)):
        raise _error(f"{field} phải là mảng chuỗi.")
    names: list[str] = []
    for index, item in enumerate(raw):
        name = _canonical_cut_name(item, f"{field}[{index}]")
        if name in names:
            raise _error(f"{field} không được trùng tên {name!r}.")
        names.append(name)
    names.sort(key=lambda value: value.encode("utf-8"))
    return tuple(names)


def _canonical_color_components(
    raw: Any, field: str, *, arity: int
) -> tuple[float, ...]:
    """Thành phần màu: đúng số kênh, mỗi kênh trong [0..1] sau lượng tử 6 số."""

    if isinstance(raw, (str, bytes)) or not isinstance(raw, (list, tuple)):
        raise _error(f"{field} phải là mảng số.")
    if len(raw) != arity:
        raise _error(f"{field} phải có đúng {arity} thành phần màu.")
    components: list[float] = []
    for index, item in enumerate(raw):
        value = _quantized_float(item, f"{field}[{index}]")
        if not 0.0 <= value <= 1.0:
            raise _error(f"{field}[{index}] phải nằm trong khoảng 0..1.")
        components.append(value)
    return tuple(components)


def _canonical_cut_source_filter(raw: Any, field: str) -> RenderCutSourceFilterV2:
    source = _as_mapping(raw, field)
    _require_exact_fields(
        source,
        {
            "mode",
            "spotNames",
            "processColor",
            "colorTolerance",
            "dieLayerNames",
            "geometryToleranceMm",
        },
        field,
    )
    mode = source["mode"]
    if not isinstance(mode, str) or mode not in _CUT_SOURCE_MODES:
        raise _error(f"{field}.mode không được hỗ trợ.")

    spot_names = _canonical_cut_name_list(source["spotNames"], f"{field}.spotNames")
    raw_process = source["processColor"]
    process_space: str | None = None
    process_components: tuple[float, ...] | None = None
    if mode == "spot":
        # Nét bế theo kênh spot thì phải có tên kênh, và không được kèm màu
        # process — hai tiêu chí song song sẽ khiến writer chọn nhập nhằng.
        if not spot_names:
            raise _error(f"{field}.spotNames không được rỗng khi mode=spot.")
        if raw_process is not None:
            raise _error(f"{field}.processColor phải là null khi mode=spot.")
    else:
        if spot_names:
            raise _error(f"{field}.spotNames phải rỗng khi mode=process.")
        process = _as_mapping(raw_process, f"{field}.processColor")
        _require_exact_fields(
            process, {"space", "components"}, f"{field}.processColor"
        )
        space = process["space"]
        if not isinstance(space, str) or space not in _CUT_PROCESS_SPACES:
            raise _error(f"{field}.processColor.space không được hỗ trợ.")
        process_space = space
        process_components = _canonical_color_components(
            process["components"],
            f"{field}.processColor.components",
            arity=_CUT_SPACE_ARITY[space],
        )

    color_tolerance = _quantized_float(
        source["colorTolerance"], f"{field}.colorTolerance"
    )
    if not 0.0 <= color_tolerance <= _CUT_COLOR_TOLERANCE_MAX:
        raise _error(
            f"{field}.colorTolerance phải trong khoảng 0..{_CUT_COLOR_TOLERANCE_MAX}."
        )
    geometry_tolerance = _quantized_float(
        source["geometryToleranceMm"], f"{field}.geometryToleranceMm"
    )
    if not 0.0 < geometry_tolerance <= _CUT_GEOMETRY_TOLERANCE_MAX_MM:
        raise _error(
            f"{field}.geometryToleranceMm phải lớn hơn 0 và tối đa "
            f"{_CUT_GEOMETRY_TOLERANCE_MAX_MM}mm."
        )
    return RenderCutSourceFilterV2(
        mode=mode,
        spot_names=spot_names,
        process_space=process_space,
        process_components=process_components,
        color_tolerance=color_tolerance,
        die_layer_names=_canonical_cut_name_list(
            source["dieLayerNames"], f"{field}.dieLayerNames"
        ),
        geometry_tolerance_mm=geometry_tolerance,
    )


def _canonical_cut_stroke(raw: Any, field: str) -> RenderCutStrokeV2:
    stroke = _as_mapping(raw, field)
    _require_exact_fields(
        stroke,
        {
            "widthMm",
            "colorSpace",
            "components",
            "separationName",
            "alternate",
            "overprint",
        },
        field,
    )
    color_space = stroke["colorSpace"]
    if not isinstance(color_space, str) or color_space not in _CUT_STROKE_SPACES:
        raise _error(f"{field}.colorSpace không được hỗ trợ.")
    width_mm = _quantized_float(stroke["widthMm"], f"{field}.widthMm")
    if not 0.0 < width_mm <= _CUT_STROKE_MAX_WIDTH_MM:
        raise _error(
            f"{field}.widthMm phải lớn hơn 0 và tối đa {_CUT_STROKE_MAX_WIDTH_MM}mm."
        )
    if not isinstance(stroke["overprint"], bool):
        raise _error(f"{field}.overprint phải là boolean.")
    components = _canonical_color_components(
        stroke["components"],
        f"{field}.components",
        arity=_CUT_SPACE_ARITY[color_space],
    )
    raw_name = stroke["separationName"]
    raw_alternate = stroke["alternate"]
    if color_space == "separation":
        separation_name: str | None = _canonical_cut_name(
            raw_name, f"{field}.separationName"
        )
        # Không có alternate thì writer không dựng nổi /Separation hợp lệ.
        alternate = _as_mapping(raw_alternate, f"{field}.alternate")
        _require_exact_fields(
            alternate, {"space", "components"}, f"{field}.alternate"
        )
        alternate_space = alternate["space"]
        if (
            not isinstance(alternate_space, str)
            or alternate_space not in _CUT_PROCESS_SPACES
        ):
            raise _error(f"{field}.alternate.space không được hỗ trợ.")
        alternate_components: tuple[float, ...] | None = _canonical_color_components(
            alternate["components"],
            f"{field}.alternate.components",
            arity=_CUT_SPACE_ARITY[alternate_space],
        )
        if not any(value > 0.0 for value in alternate_components):
            # Tint 1.0 phải ra một màu thấy được; alternate toàn 0 là nét vô hình.
            raise _error(
                f"{field}.alternate.components phải có ít nhất một kênh lớn hơn 0."
            )
    else:
        if raw_name is not None:
            raise _error(
                f"{field}.separationName phải là null khi colorSpace khác separation."
            )
        if raw_alternate is not None:
            raise _error(
                f"{field}.alternate phải là null khi colorSpace khác separation."
            )
        separation_name = None
        alternate_space = None
        alternate_components = None
    return RenderCutStrokeV2(
        width_mm=width_mm,
        color_space=color_space,
        components=components,
        separation_name=separation_name,
        alternate_space=alternate_space,
        alternate_components=alternate_components,
        overprint=stroke["overprint"],
    )


def _canonical_cut_style(raw: Any, field: str = "renderBundle.cutStyle") -> RenderCutStyleV2:
    """Canonicalize hợp đồng nét bế; mọi giá trị lạ đều fail-closed."""

    style = _as_mapping(raw, field)
    _require_exact_fields(style, {"sourceFilter", "stroke"}, field)
    return RenderCutStyleV2(
        source_filter=_canonical_cut_source_filter(
            style["sourceFilter"], f"{field}.sourceFilter"
        ),
        stroke=_canonical_cut_stroke(style["stroke"], f"{field}.stroke"),
    )


def _canonical_render_marks(
    raw: Any, *, duplex_mode: str, tool: str
) -> dict[str, Any]:
    field = "renderBundle.marks"
    marks = _as_mapping(raw, field)
    _require_exact_fields(
        marks, {"trim", "pont", "cut", "duplexRegistration"}, field
    )
    trim = _as_mapping(marks["trim"], f"{field}.trim")
    _require_exact_fields(
        trim,
        {"type", "lengthMm", "offsetMm", "thicknessMm", "style"},
        f"{field}.trim",
    )
    trim_type = trim["type"]
    trim_style = trim["style"]
    if not isinstance(trim_type, str) or trim_type not in _TRIM_MARK_TYPES:
        raise _error(f"{field}.trim.type không được hỗ trợ.")
    if not isinstance(trim_style, str) or trim_style not in _TRIM_MARK_STYLES:
        raise _error(f"{field}.trim.style không được hỗ trợ.")
    length_mm = _quantized_float(trim["lengthMm"], f"{field}.trim.lengthMm")
    offset_mm = _quantized_float(trim["offsetMm"], f"{field}.trim.offsetMm")
    trim_thickness = _quantized_float(
        trim["thicknessMm"], f"{field}.trim.thicknessMm"
    )
    if length_mm < 0.0 or offset_mm < 0.0 or trim_thickness <= 0.0:
        raise _error(f"{field}.trim có kích thước không hợp lệ.")
    pont = _as_mapping(marks["pont"], f"{field}.pont")
    _require_exact_fields(pont, {"type", "config"}, f"{field}.pont")
    pont_type = pont["type"]
    if not isinstance(pont_type, str) or pont_type not in _PONT_TYPES:
        raise _error(f"{field}.pont.type không được hỗ trợ.")
    if pont_type == "none":
        if pont["config"] is not None:
            raise _error(f"{field}.pont.config phải là null khi pont.type=none.")
        pont_config = None
    else:
        pont_config = _canonical_pont_config(
            pont["config"], f"{field}.pont.config"
        )
    duplex_registration = marks["duplexRegistration"]
    if not isinstance(duplex_registration, bool):
        raise _error(f"{field}.duplexRegistration phải là boolean.")
    if duplex_registration and (tool != "cnc_imposer" or duplex_mode != "duplex"):
        raise _error(
            f"{field}.duplexRegistration chỉ hợp lệ cho CNC hai mặt."
        )
    return {
        "trim": {
            "type": trim_type,
            "lengthMm": length_mm,
            "offsetMm": offset_mm,
            "thicknessMm": trim_thickness,
            "style": trim_style,
        },
        "pont": {"type": pont_type, "config": pont_config},
        "cut": _canonical_cut_output(marks["cut"], f"{field}.cut"),
        "duplexRegistration": duplex_registration,
    }


def _canonical_artifact_text(
    value: Any, field: str, *, max_length: int = 512
) -> str:
    """Chuẩn hoá text report để hash không phụ thuộc Unicode/khoảng trắng UI."""

    if not isinstance(value, str):
        raise _error(f"{field} phải là chuỗi.")
    canonical = unicodedata.normalize("NFC", value).strip()
    if len(canonical) > max_length or _has_control(canonical):
        raise _error(f"{field} không hợp lệ hoặc vượt quá {max_length} ký tự.")
    _json_string(canonical)
    return canonical


def _canonical_artifact_options(
    raw: Any, flow: Mapping[str, str]
) -> dict[str, Any]:
    """Khoá mọi lựa chọn làm đổi số trang hoặc nội dung PDF cuối."""

    field = "renderBundle.artifactOptions"
    options = _as_mapping(raw, field)
    _require_exact_fields(options, {"exportUniqueSheets", "report"}, field)
    export_unique = options["exportUniqueSheets"]
    if not isinstance(export_unique, bool):
        raise _error(f"{field}.exportUniqueSheets phải là boolean.")
    if not export_unique and (
        flow["tool"] == "cnc_imposer"
        or flow["layoutIntent"] in _AUTOFILL_LAYOUT_INTENTS
    ):
        raise _error(
            f"{field}.exportUniqueSheets phải bật cho CNC và bình tự lấp đầy một tờ."
        )

    report_field = f"{field}.report"
    report = _as_mapping(options["report"], report_field)
    enabled = report.get("enabled")
    if not isinstance(enabled, bool):
        raise _error(f"{report_field}.enabled phải là boolean.")
    if not enabled:
        _require_exact_fields(report, {"enabled"}, report_field)
        return {"exportUniqueSheets": export_unique, "report": {"enabled": False}}

    _require_exact_fields(
        report,
        {
            "enabled",
            "fields",
            "requestedQty",
            "labelName",
            "material",
            "lamination",
            "orderCode",
            "customText",
            "removeDiacritics",
            "placement",
        },
        report_field,
    )
    raw_fields = report["fields"]
    if not isinstance(raw_fields, list):
        raise _error(f"{report_field}.fields phải là mảng.")
    fields: list[str] = []
    seen_fields: set[str] = set()
    for index, report_key in enumerate(raw_fields):
        if not isinstance(report_key, str) or report_key not in _REPORT_FIELD_KEYS:
            raise _error(f"{report_field}.fields[{index}] không được hỗ trợ.")
        if report_key in seen_fields:
            raise _error(f"{report_field}.fields không được chứa field trùng.")
        seen_fields.add(report_key)
        fields.append(report_key)

    requested_qty = report["requestedQty"]
    if requested_qty is not None and (
        isinstance(requested_qty, bool)
        or not isinstance(requested_qty, int)
        or requested_qty <= 0
    ):
        raise _error(
            f"{report_field}.requestedQty phải là số nguyên dương hoặc null."
        )
    if (
        requested_qty is not None
        and flow["layoutIntent"] != "step_repeat_single_sheet"
    ):
        raise _error(
            f"{report_field}.requestedQty chỉ dùng cho bình trang một tờ đại diện."
        )

    lamination_field = f"{report_field}.lamination"
    lamination = _as_mapping(report["lamination"], lamination_field)
    _require_exact_fields(lamination, {"type", "sides"}, lamination_field)
    lamination_type = lamination["type"]
    if (
        not isinstance(lamination_type, str)
        or lamination_type not in _LAMINATION_TYPES
    ):
        raise _error(f"{lamination_field}.type không được hỗ trợ.")
    lamination_sides = lamination["sides"]
    if (
        isinstance(lamination_sides, bool)
        or not isinstance(lamination_sides, int)
        or lamination_sides not in {1, 2}
    ):
        raise _error(f"{lamination_field}.sides chỉ nhận 1 hoặc 2.")
    if lamination_type == "none" and lamination_sides != 1:
        raise _error(f"{lamination_field}.sides phải bằng 1 khi không cán màng.")

    placement_field = f"{report_field}.placement"
    placement = _as_mapping(report["placement"], placement_field)
    _require_exact_fields(
        placement,
        {"position", "centered", "offsetXmm", "offsetYmm", "fontSizePt"},
        placement_field,
    )
    position = placement["position"]
    if not isinstance(position, str) or position not in _REPORT_POSITIONS:
        raise _error(f"{placement_field}.position không được hỗ trợ.")
    centered = placement["centered"]
    if not isinstance(centered, bool):
        raise _error(f"{placement_field}.centered phải là boolean.")
    offset_x = _quantized_float(placement["offsetXmm"], f"{placement_field}.offsetXmm")
    offset_y = _quantized_float(placement["offsetYmm"], f"{placement_field}.offsetYmm")
    font_size = _quantized_float(placement["fontSizePt"], f"{placement_field}.fontSizePt")
    if offset_x < 0.0 or offset_y < 0.0:
        raise _error(f"{placement_field}.offsetXmm/offsetYmm không được âm.")
    if not 4.0 <= font_size <= 40.0:
        raise _error(f"{placement_field}.fontSizePt phải nằm trong [4, 40].")
    visible_fields = set(fields)
    # FIX/PARITY (audit 2026-08-29 §MAP-NEST-05): demand S&R là metadata
    # server-owned của report, không phải quantity đưa ngược vào solver autofill.
    # Khi các field phụ thuộc demand đều ẩn, strip payload để identity không đổi oan.
    if not visible_fields.intersection({"actualQty", "sheetCount"}):
        requested_qty = None
    label_name = (
        _canonical_artifact_text(report["labelName"], f"{report_field}.labelName")
        if "labelName" in visible_fields
        else ""
    )
    material = (
        _canonical_artifact_text(report["material"], f"{report_field}.material")
        if "material" in visible_fields
        else ""
    )
    order_code = (
        _canonical_artifact_text(report["orderCode"], f"{report_field}.orderCode")
        if "orderCode" in visible_fields
        else ""
    )
    if "lamination" not in visible_fields:
        lamination_type = "none"
        lamination_sides = 1
    remove_diacritics = report["removeDiacritics"]
    if not isinstance(remove_diacritics, bool):
        raise _error(f"{report_field}.removeDiacritics phải là boolean.")

    return {
        "exportUniqueSheets": export_unique,
        "report": {
            "enabled": True,
            "fields": fields,
            "requestedQty": requested_qty,
            "labelName": label_name,
            "material": material,
            "lamination": {"type": lamination_type, "sides": lamination_sides},
            "orderCode": order_code,
            "customText": _canonical_artifact_text(
                report["customText"],
                f"{report_field}.customText",
                max_length=2048,
            ),
            "removeDiacritics": remove_diacritics,
            "placement": {
                "position": position,
                "centered": centered,
                "offsetXmm": offset_x,
                "offsetYmm": offset_y,
                "fontSizePt": font_size,
            },
        },
    }

def _validate_tool_render_context(
    flow: Mapping[str, str], marks: Mapping[str, Any]
) -> None:
    """Khóa option hiệu dụng theo đúng renderer, không persist context bị bỏ qua."""

    if flow["tool"] != "cnc_imposer":
        return
    cut = marks["cut"]
    expected_cut = {
        "type": "default",
        "separatePage": True,
        "pontsOnCutFile": True,
        "fillBlockGapMm": 0.0,
        "dieSizeMode": "die",
        "dieOffsetMm": 0.0,
    }
    if marks["trim"]["type"] != "none" or cut != expected_cut:
        raise _error(
            "renderBundle CNC phải khớp renderer hiện hữu: không dấu xén, "
            "khuôn mặc định trên trang Cut riêng, boong luôn ở Front + Cut."
        )


def _canonical_output_sides(
    raw: Any,
    flow: Mapping[str, str],
    duplex: Mapping[str, str],
    cut: Mapping[str, Any],
) -> tuple[str, ...]:
    if flow["tool"] == "sticker_imposer":
        if duplex["mode"] != "simplex":
            raise _error("renderBundle sticker_imposer hiện chỉ hỗ trợ simplex.")
        expected = ("front", "cut") if cut["separatePage"] else ("front",)
    else:
        if cut["type"] != "default" or not cut["separatePage"]:
            raise _error("renderBundle CNC luôn dùng khuôn mặc định trên trang Cut riêng.")
        expected = (
            ("front", "back", "cut")
            if duplex["mode"] == "duplex"
            else ("front", "cut")
        )
    if not isinstance(raw, (list, tuple)) or tuple(raw) != expected:
        raise _error("renderBundle.outputSides không khớp flow và cấu hình CUT.")
    return expected


def _canonical_sheet_frames(
    raw: Any, sheet: Mapping[str, Any], duplex: Mapping[str, str]
) -> dict[str, tuple[float, float, float, float, float, float] | None]:
    field = "renderBundle.sheetFrames"
    frames = _as_mapping(raw, field)
    _require_exact_fields(frames, {"front", "back", "cut"}, field)
    front = _canonical_invertible_affine(frames["front"], f"{field}.front")
    cut = _canonical_invertible_affine(frames["cut"], f"{field}.cut")
    if front != _IDENTITY_AFFINE or cut != _IDENTITY_AFFINE:
        raise _error(f"{field}.front/cut phải là identity server-derived.")
    if duplex["mode"] == "simplex":
        if frames["back"] is not None:
            raise _error(f"{field}.back phải là null ở chế độ simplex.")
        back = None
    else:
        axis = duplex["physicalAxis"]
        expected_back = (
            (-1.0, 0.0, 0.0, 1.0, sheet["widthMm"], 0.0)
            if axis == "x"
            else (1.0, 0.0, 0.0, -1.0, 0.0, sheet["heightMm"])
        )
        back = _canonical_invertible_affine(frames["back"], f"{field}.back")
        if back != expected_back:
            raise _error(
                f"{field}.back không phải phép phản xạ tờ theo physicalAxis."
            )
    return {"front": front, "back": back, "cut": cut}


def _canonical_renderer(raw: Any, tool: str) -> dict[str, str]:
    field = "renderBundle.renderer"
    renderer = _as_mapping(raw, field)
    _require_exact_fields(renderer, {"identity", "version"}, field)
    expected_identity = {
        "sticker_imposer": "sticker_imposer_pdf",
        "cnc_imposer": "cnc_imposer_pdf",
    }[tool]
    identity = renderer["identity"]
    version = renderer["version"]
    if identity != expected_identity:
        raise _error(f"{field}.identity không khớp flow.tool.")
    if (
        not isinstance(version, str)
        or not version.strip()
        or len(version) > 128
        or _has_control(version)
    ):
        raise _error(f"{field}.version phải là chuỗi không rỗng, tối đa 128 ký tự.")
    _json_string(version)
    return {"identity": identity, "version": version}


def _validate_source_page_consistency(parts: Sequence[RenderBundlePartV2]) -> None:
    """Cùng locator/page không được khai metadata nguồn mâu thuẫn trong bundle."""

    sources: dict[str, dict[str, Any]] = {}
    pages: dict[tuple[str, int], dict[str, Any]] = {}
    for part in parts:
        locator_id = part.source.locator_id
        descriptor = part.source.to_canonical_dict()
        previous_source = sources.setdefault(locator_id, descriptor)
        if previous_source != descriptor:
            raise _error(
                f"renderBundle locatorId {locator_id!r} có descriptor mâu thuẫn."
            )
        for side, binding in (
            ("front", part.front),
            ("back", part.back),
            ("cut", part.cut),
        ):
            if binding is None:
                continue
            metadata = {
                "pageBoxesMm": binding.page_boxes_mm.to_canonical_dict(),
                "userUnit": binding.user_unit,
                "rotateDeg": binding.rotate_deg,
                "sourcePageToCanonical": list(binding.source_page_to_canonical),
            }
            key = (locator_id, binding.page_index)
            previous_page = pages.setdefault(key, metadata)
            if previous_page != metadata:
                raise _error(
                    f"renderBundle source page {locator_id}/{binding.page_index} "
                    f"có metadata mâu thuẫn ({side})."
                )
def _canonical_render_bundle_part(
    raw: Any,
    index: int,
    engine_part: Mapping[str, Any],
    *,
    duplex_mode: str,
) -> RenderBundlePartV2:
    field = f"renderBundle.parts[{index}]"
    part = _as_mapping(raw, field)
    expected_fields = {
        "partId",
        "packingFootprint",
        "cutContour",
        "artworkClipPath",
        "source",
        "pages",
    }
    if "dieDimensionsMm" in part:
        expected_fields.add("dieDimensionsMm")
    _require_exact_fields(part, expected_fields, field)
    part_id = part["partId"]
    if part_id != engine_part["partId"]:
        raise _error(f"{field}.partId không khớp part production đã canonicalize.")

    packing_footprint = _canonical_polygon(
        part["packingFootprint"], f"{field}.packingFootprint"
    )
    canonical_footprint = packing_footprint.to_canonical_dict()
    engine_footprint = {
        "outer": engine_part["outer"],
        "holes": engine_part["holes"],
    }
    if canonical_footprint != engine_footprint:
        raise _error(
            f"{field}.packingFootprint không khớp exact outer/holes đã gửi solver."
        )

    # NEST (audit 2026-08-27): pivot/hash chỉ có một chủ sở hữu là adapter;
    # resolver không được khai lại hai giá trị này trong immutable bundle thô.
    reference_point = _polygon_centroid(
        canonical_footprint["outer"], f"{field}.packingFootprint.outer"
    )
    geometry_hash = canonical_sha256(canonical_footprint)
    if (
        reference_point != engine_part["referencePointMm"]
        or geometry_hash != engine_part["geometryHash"]
    ):
        raise _error(f"{field} lệch identity hình học nội bộ sau canonicalize.")

    source = _canonical_render_source(part["source"], f"{field}.source")

    pages = _as_mapping(part["pages"], f"{field}.pages")
    _require_exact_fields(pages, {"front", "back", "cut"}, f"{field}.pages")
    if pages["front"] is None:
        raise _error(f"{field}.pages.front bắt buộc có PageBindingV2.")
    if pages["cut"] is None:
        raise _error(f"{field}.pages.cut bắt buộc có PageBindingV2.")
    front = _canonical_page_binding(
        pages["front"],
        f"{field}.pages.front",
        source=source,
        reference_point=reference_point,
    )
    cut_contour = _canonical_polygon(part["cutContour"], f"{field}.cutContour")
    artwork_clip_path = _canonical_polygon(
        part["artworkClipPath"], f"{field}.artworkClipPath"
    )
    die_dimensions_mm = (
        _canonical_die_dimensions(
            part["dieDimensionsMm"], f"{field}.dieDimensionsMm"
        )
        if "dieDimensionsMm" in part
        else None
    )
    _validate_render_geometry(
        packing_footprint=packing_footprint,
        cut_contour=cut_contour,
        artwork_clip_path=artwork_clip_path,
        field=field,
    )
    back = (
        None
        if pages["back"] is None
        else _canonical_page_binding(
            pages["back"],
            f"{field}.pages.back",
            source=source,
            reference_point=reference_point,
        )
    )
    cut = _canonical_page_binding(
        pages["cut"],
        f"{field}.pages.cut",
        source=source,
        reference_point=reference_point,
    )
    if (back is not None) != (duplex_mode == "duplex"):
        raise _error(f"{field}.pages.back phải có đúng khi bundle là duplex.")
    return RenderBundlePartV2(
        part_id=part_id,
        reference_point_mm=(reference_point[0], reference_point[1]),
        geometry_hash=geometry_hash,
        packing_footprint=packing_footprint,
        cut_contour=cut_contour,
        artwork_clip_path=artwork_clip_path,
        die_dimensions_mm=die_dimensions_mm,
        source=source,
        front=front,
        back=back,
        cut=cut,
    )


def _canonical_render_bundle(
    raw: Any,
    engine_parts: Sequence[Mapping[str, Any]],
    *,
    request_layout_intent: str,
    sheet: Mapping[str, Any],
) -> RenderBundleV2:
    bundle = _as_mapping(raw, "renderBundle")
    schema_version = bundle.get("schemaVersion")
    if (
        isinstance(schema_version, int)
        and not isinstance(schema_version, bool)
        and schema_version == 1
    ):
        raise _error(
            "RenderBundleV1 là legacy read-only và không được render production."
        )
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != RENDER_BUNDLE_SCHEMA_VERSION
    ):
        raise _error(
            f"renderBundle.schemaVersion phải bằng {RENDER_BUNDLE_SCHEMA_VERSION}."
        )
    _require_exact_fields(
        bundle,
        {
            "schemaVersion",
            "flow",
            "outputSides",
            "duplex",
            "marks",
            "artifactOptions",
            "sheetFrames",
            "renderer",
            "cutStyle",
            "parts",
        },
        "renderBundle",
    )
    flow = _canonical_render_flow(bundle["flow"], request_layout_intent)
    duplex = _canonical_render_duplex(bundle["duplex"], sheet)
    marks = _canonical_render_marks(
        bundle["marks"], duplex_mode=duplex["mode"], tool=flow["tool"]
    )
    artifact_options = _canonical_artifact_options(
        bundle["artifactOptions"], flow
    )
    _validate_tool_render_context(flow, marks)
    output_sides = _canonical_output_sides(
        bundle["outputSides"], flow, duplex, marks["cut"]
    )
    sheet_frames = _canonical_sheet_frames(
        bundle["sheetFrames"], sheet, duplex
    )
    renderer = _canonical_renderer(bundle["renderer"], flow["tool"])
    cut_style = _canonical_cut_style(bundle["cutStyle"])

    raw_parts = bundle["parts"]
    if not isinstance(raw_parts, (list, tuple)) or not raw_parts:
        raise _error("renderBundle.parts phải là mảng không rỗng.")
    if flow["taskMode"] == "step_repeat" and len(raw_parts) != 1:
        raise _error("renderBundle step_repeat yêu cầu đúng một part.")

    expected = {part["partId"]: part for part in engine_parts}
    seen: set[str] = set()
    canonical_parts: list[RenderBundlePartV2] = []
    for index, raw_part in enumerate(raw_parts):
        part = _as_mapping(raw_part, f"renderBundle.parts[{index}]")
        part_id = part.get("partId")
        if not isinstance(part_id, str) or not part_id or _has_control(part_id):
            raise _error(f"renderBundle.parts[{index}].partId không hợp lệ.")
        if part_id in seen:
            raise _error(f"renderBundle.parts có partId trùng {part_id!r}.")
        engine_part = expected.get(part_id)
        if engine_part is None:
            raise _error(f"renderBundle có partId dư {part_id!r} so với request.")
        seen.add(part_id)
        canonical_parts.append(
            _canonical_render_bundle_part(
                raw_part,
                index,
                engine_part,
                duplex_mode=duplex["mode"],
            )
        )

    missing = set(expected).difference(seen)
    if missing:
        raise _error(
            "renderBundle thiếu partId của request: "
            + ", ".join(sorted(missing))
            + "."
        )
    canonical_parts.sort(key=lambda item: item.part_id.encode("utf-8"))
    _validate_source_page_consistency(canonical_parts)
    return RenderBundleV2(
        flow=flow,
        output_sides=output_sides,
        duplex=duplex,
        marks=marks,
        artifact_options=artifact_options,
        sheet_frames=sheet_frames,
        renderer=renderer,
        cut_style=cut_style,
        parts=tuple(canonical_parts),
    )


def _canonical_part(raw: Any, index: int, layout_intent: str) -> dict[str, Any]:
    part = _as_mapping(raw, f"parts[{index}]")
    forbidden = _SERVER_PART_KEYS.intersection(part)
    if forbidden:
        raise _error(
            f"parts[{index}] chứa field server-owned: {', '.join(sorted(forbidden))}."
        )
    unknown = set(part).difference(_PUBLIC_PART_KEYS)
    if unknown:
        raise _error(f"parts[{index}] chứa field lạ: {', '.join(sorted(unknown))}.")
    part_id = part.get("partId")
    if not isinstance(part_id, str) or not part_id or _has_control(part_id):
        raise _error(f"parts[{index}].partId không hợp lệ.")

    outer = _canonical_ring(part.get("outer"), f"parts[{index}].outer", ccw=True)
    raw_holes = part.get("holes", [])
    if not isinstance(raw_holes, (list, tuple)):
        raise _error(f"parts[{index}].holes phải là mảng.")
    holes = [
        _canonical_ring(hole, f"parts[{index}].holes[{hole_index}]", ccw=False)
        for hole_index, hole in enumerate(raw_holes)
    ]
    holes.sort(key=canonical_json_bytes)

    canonical: dict[str, Any] = {"partId": part_id}
    if layout_intent == "quantity_fulfillment":
        quantity = part.get("quantity")
        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
            raise _error(f"parts[{index}].quantity phải là số nguyên dương.")
        canonical["quantity"] = quantity
    elif "quantity" in part:
        raise _error(
            f"parts[{index}].quantity phải vắng mặt khi layoutIntent là autofill_single_sheet."
        )
    canonical.update(
        {
            "outer": outer,
            "holes": holes,
            "rotationConstraint": {"mode": "inherit"},
            "referencePointMm": _polygon_centroid(outer, f"parts[{index}].outer"),
            "geometryHash": canonical_sha256({"outer": outer, "holes": holes}),
        }
    )
    return canonical


def _axis_clearance(raw: Any, field: str) -> dict[str, float]:
    value = _as_mapping(raw, field)
    if set(value) != {"xMm", "yMm"}:
        raise _error(f"{field} phải có đúng xMm và yMm.")
    x_mm = _quantized_float(value["xMm"], f"{field}.xMm")
    y_mm = _quantized_float(value["yMm"], f"{field}.yMm")
    if x_mm < 0.0 or y_mm < 0.0:
        raise _error(f"{field} không được âm.")
    return {"xMm": x_mm, "yMm": y_mm}


def _canonical_angle_deg(raw: Any, field: str) -> float:
    """Góc canonical trong [0, 360) sau lượng tử 6 chữ số.

    Không snap về bội của bước góc nào — khớp ``canonicalize_angle_deg`` bên Rust.
    """

    angle = _quantized_float(raw, field)
    if not 0.0 <= angle < 360.0:
        raise _error(f"{field} phải canonical trong [0, 360).")
    return angle


def _canonical_rotation_arc(raw: Any, field: str) -> dict[str, float]:
    arc = _as_mapping(raw, field)
    _require_exact_fields(arc, {"startDeg", "sweepDeg"}, field)
    sweep = _quantized_float(arc["sweepDeg"], f"{field}.sweepDeg")
    if not 0.0 < sweep <= 360.0:
        raise _error(f"{field}.sweepDeg phải thuộc khoảng (0, 360].")
    return {
        "startDeg": _canonical_angle_deg(arc["startDeg"], f"{field}.startDeg"),
        "sweepDeg": sweep,
    }


def _canonical_rotation_constraint(raw: Any, field: str) -> dict[str, Any]:
    """Canonicalize miền xoay cấp job theo đúng schema tagged của Rust."""

    constraint = _as_mapping(raw, field)
    mode = constraint.get("mode")
    if not isinstance(mode, str) or mode not in _ROTATION_JOB_MODES:
        if mode == "inherit":
            raise _error(
                f"{field}.mode=inherit chỉ hợp lệ ở cấp chi tiết, không phải cấp job."
            )
        raise _error(f"{field}.mode không được hỗ trợ.")
    parameter = _ROTATION_MODE_PARAM[mode]
    expected = {"mode"} if parameter is None else {"mode", parameter}
    # Chặn cả ca `{"mode":"free","anglesDeg":[0]}` — tham số lạc mode phải fail,
    # không được lặng lẽ rơi về free.
    _require_exact_fields(constraint, expected, field)

    if mode == "free":
        return {"mode": "free"}
    if mode == "fixed":
        return {
            "mode": "fixed",
            "angleDeg": _canonical_angle_deg(
                constraint["angleDeg"], f"{field}.angleDeg"
            ),
        }
    if mode == "discrete":
        raw_angles = constraint["anglesDeg"]
        if isinstance(raw_angles, (str, bytes)) or not isinstance(
            raw_angles, (list, tuple)
        ):
            raise _error(f"{field}.anglesDeg phải là mảng số.")
        if not raw_angles:
            raise _error(f"{field}.anglesDeg không được rỗng.")
        if len(raw_angles) > _MAX_ROTATION_ANGLES:
            raise _error(
                f"{field}.anglesDeg vượt giới hạn {_MAX_ROTATION_ANGLES} góc."
            )
        angles: list[float] = []
        for index, angle in enumerate(raw_angles):
            value = _canonical_angle_deg(angle, f"{field}.anglesDeg[{index}]")
            if value in angles:
                raise _error(f"{field}.anglesDeg không được trùng góc {value}.")
            angles.append(value)
        angles.sort()
        return {"mode": "discrete", "anglesDeg": angles}

    raw_arcs = constraint["arcs"]
    if isinstance(raw_arcs, (str, bytes)) or not isinstance(raw_arcs, (list, tuple)):
        raise _error(f"{field}.arcs phải là mảng object.")
    if not raw_arcs:
        raise _error(f"{field}.arcs không được rỗng.")
    if len(raw_arcs) > _MAX_ROTATION_ARCS:
        raise _error(f"{field}.arcs vượt giới hạn {_MAX_ROTATION_ARCS} cung.")
    arcs = [
        _canonical_rotation_arc(arc, f"{field}.arcs[{index}]")
        for index, arc in enumerate(raw_arcs)
    ]
    arcs.sort(key=canonical_json_bytes)
    return {"mode": "ranges", "arcs": arcs}


def _canonical_orientation_policy(
    raw: Any, *, allow_continuous_rotation: bool
) -> dict[str, Any]:
    """Chính sách hướng cấp job — nguồn chân lý DUY NHẤT cho miền xoay.

    NEST (audit 2026-08-28 §A2.1): miền xoay là **server-owned** — chính sách của
    client bị bỏ qua có chủ đích, giống `gapMm`. Nhưng trước lô này nó bị ghi
    CỨNG thành `free` ở hai chỗ trong hàm dựng request, nên không callsite nào
    khoá được cardinal cho Chặng A dù kế hoạch rollout yêu cầu. Giờ nó là tham số
    tường minh, mặc định cardinal.

    ``allow_continuous_rotation`` là cổng rollout, mặc định **đóng**: chỉ mở sau
    khi Cổng Chặng B chứng minh free không kém cardinal.
    """

    field = "orientationPolicy"
    policy = _as_mapping(raw, field)
    _require_exact_fields(policy, {"defaultRotation", "reflection"}, field)
    reflection = policy["reflection"]
    if not isinstance(reflection, str) or reflection != "forbidden":
        # Solver không mirror; nhận giá trị khác là mở đường lật hình âm thầm.
        raise _error(f"{field}.reflection chỉ được là 'forbidden'.")
    default_rotation = _canonical_rotation_constraint(
        policy["defaultRotation"], f"{field}.defaultRotation"
    )
    if (
        not allow_continuous_rotation
        and default_rotation["mode"] in _ROTATION_CONTINUOUS_MODES
    ):
        raise _error(
            f"{field}.defaultRotation.mode={default_rotation['mode']} là miền góc "
            "liên tục, chưa được mở cho đường production. Dùng discrete/fixed, "
            "ví dụ preset cardinal [0, 90, 180, 270]."
        )
    return {"defaultRotation": default_rotation, "reflection": "forbidden"}


def _canonical_clearance(raw: Any) -> dict[str, dict[str, float]]:
    value = _as_mapping(raw, "clearance")
    expected = {"partToPart", "partToSheetEdge", "partToObstacle"}
    if set(value) != expected:
        raise _error("clearance phải tách đủ partToPart/partToSheetEdge/partToObstacle.")
    return {
        key: _axis_clearance(value[key], f"clearance.{key}")
        for key in ("partToPart", "partToSheetEdge", "partToObstacle")
    }


def _canonical_obstacles(raw: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise _error("fixedObstacles phải là mảng.")
    obstacles: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        obstacle = _as_mapping(item, f"fixedObstacles[{index}]")
        if set(obstacle) != {"obstacleId", "kind", "outer"}:
            raise _error(f"fixedObstacles[{index}] có field thiếu hoặc lạ.")
        obstacle_id = obstacle["obstacleId"]
        kind = obstacle["kind"]
        if (
            not isinstance(obstacle_id, str)
            or not obstacle_id
            or _has_control(obstacle_id)
            or obstacle_id in seen
        ):
            raise _error(f"fixedObstacles[{index}].obstacleId rỗng hoặc bị trùng.")
        if not isinstance(kind, str) or kind not in _ALLOWED_OBSTACLE_KINDS:
            raise _error(f"fixedObstacles[{index}].kind không được hỗ trợ.")
        seen.add(obstacle_id)
        obstacles.append(
            {
                "obstacleId": obstacle_id,
                "kind": kind,
                "outer": _canonical_ring(
                    obstacle["outer"], f"fixedObstacles[{index}].outer", ccw=True
                ),
            }
        )
    obstacles.sort(key=lambda item: item["obstacleId"].encode("utf-8"))
    return obstacles


def _canonical_sheet(raw: Any) -> dict[str, Any]:
    sheet = _as_mapping(raw, "sheet")
    if set(sheet) != {"widthMm", "heightMm", "marginMm", "maxSheets"}:
        raise _error("sheet có field thiếu hoặc lạ.")
    margin = _as_mapping(sheet["marginMm"], "sheet.marginMm")
    if set(margin) != {"left", "right", "top", "bottom"}:
        raise _error("sheet.marginMm phải có đúng left/right/top/bottom.")
    max_sheets = sheet["maxSheets"]
    if isinstance(max_sheets, bool) or not isinstance(max_sheets, int) or max_sheets <= 0:
        raise _error("sheet.maxSheets phải là số nguyên dương.")
    width_mm = _quantized_float(sheet["widthMm"], "sheet.widthMm")
    height_mm = _quantized_float(sheet["heightMm"], "sheet.heightMm")
    canonical_margin = {
        key: _quantized_float(margin[key], f"sheet.marginMm.{key}")
        for key in ("left", "right", "top", "bottom")
    }
    if width_mm <= 0.0 or height_mm <= 0.0:
        raise _error("Kích thước tờ phải lớn hơn 0 mm.")
    if any(value < 0.0 for value in canonical_margin.values()):
        raise _error("Lề tờ không được âm.")
    if (
        width_mm - canonical_margin["left"] - canonical_margin["right"] <= 0.0
        or height_mm - canonical_margin["top"] - canonical_margin["bottom"] <= 0.0
    ):
        raise _error("Lề làm vùng xếp của tờ không còn diện tích dương.")
    return {
        "widthMm": width_mm,
        "heightMm": height_mm,
        "marginMm": {
            key: canonical_margin[key]
            for key in ("left", "right", "top", "bottom")
        },
        "maxSheets": max_sheets,
    }


def _canonical_grouping_intent(raw: Any) -> str:
    if not isinstance(raw, str) or raw not in {"free_gang", "maximize_area"}:
        raise _error("groupingIntent không được hỗ trợ.")
    return raw


def _canonical_placement_zones(
    raw: Any,
    *,
    grouping_intent: str,
    parts: Sequence[Mapping[str, Any]],
    sheet: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Chuẩn hoá association ``partId → bounds`` do server sở hữu.

    PARITY (audit 2026-08-29 §MAP-NEST-04): association đi theo ``partId`` và
    được sort độc lập với thứ tự payload; không zip theo vị trí sau khi parts đã sort.
    Partition dải bằng nhau vẫn được Rust kiểm như authority hình học cuối.
    """

    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise _error("placementZones phải là mảng.")
    if grouping_intent == "free_gang":
        if raw:
            raise _error("Xếp tự do không được mang placementZones.")
        return []

    part_ids = {str(part["partId"]) for part in parts}
    margin = sheet["marginMm"]
    usable = {
        "minXmm": float(margin["left"]),
        "minYmm": float(margin["bottom"]),
        "maxXmm": float(sheet["widthMm"]) - float(margin["right"]),
        "maxYmm": float(sheet["heightMm"]) - float(margin["top"]),
    }
    tolerance_mm = 1e-6
    zones: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        field = f"placementZones[{index}]"
        zone = _as_mapping(item, field)
        _require_exact_fields(zone, {"partId", "bounds"}, field)
        part_id = zone["partId"]
        if not isinstance(part_id, str) or part_id not in part_ids:
            raise _error(f"{field}.partId không có trong parts.")
        if part_id in seen:
            raise _error(f"{field}.partId bị trùng.")
        seen.add(part_id)

        bounds_field = f"{field}.bounds"
        bounds = _as_mapping(zone["bounds"], bounds_field)
        bound_keys = ("minXmm", "minYmm", "maxXmm", "maxYmm")
        _require_exact_fields(bounds, set(bound_keys), bounds_field)
        canonical_bounds = {
            key: _quantized_float(bounds[key], f"{bounds_field}.{key}")
            for key in bound_keys
        }
        if (
            canonical_bounds["maxXmm"] - canonical_bounds["minXmm"]
            <= tolerance_mm
            or canonical_bounds["maxYmm"] - canonical_bounds["minYmm"]
            <= tolerance_mm
        ):
            raise _error(f"{bounds_field} phải có chiều rộng và chiều cao dương.")
        if (
            canonical_bounds["minXmm"] < usable["minXmm"] - tolerance_mm
            or canonical_bounds["minYmm"] < usable["minYmm"] - tolerance_mm
            or canonical_bounds["maxXmm"] > usable["maxXmm"] + tolerance_mm
            or canonical_bounds["maxYmm"] > usable["maxYmm"] + tolerance_mm
        ):
            raise _error(f"{bounds_field} nằm ngoài vùng dùng được của tờ.")
        zones.append({"partId": part_id, "bounds": canonical_bounds})

    missing = part_ids.difference(seen)
    if missing:
        raise _error(
            "placementZones thiếu vùng cho partId: "
            + ", ".join(sorted(missing, key=lambda value: value.encode("utf-8")))
            + "."
        )
    zones.sort(key=lambda zone: zone["partId"].encode("utf-8"))
    return zones


def _production_versions(raw: Mapping[str, int | str]) -> dict[str, int | str]:
    versions = _as_mapping(raw, "algorithmVersions")
    missing = PRODUCTION_ALGORITHM_VERSION_KEYS.difference(versions)
    if missing:
        raise _error(f"Thiếu version production: {', '.join(sorted(missing))}.")
    unknown = set(versions).difference(PRODUCTION_ALGORITHM_VERSION_KEYS)
    if unknown:
        raise _error(f"Version production có field lạ: {', '.join(sorted(unknown))}.")
    selected: dict[str, int | str] = {}
    for key in sorted(
        PRODUCTION_ALGORITHM_VERSION_KEYS, key=lambda item: item.encode("utf-8")
    ):
        value = versions[key]
        if isinstance(value, bool) or not isinstance(value, (int, str)) or value == "":
            raise _error(f"Version {key} không hợp lệ.")
        selected[key] = value
    return selected


def _canonical_native_build_identity(raw: Any) -> str:
    if (
        not isinstance(raw, str)
        or len(raw) != 64
        or any(character not in "0123456789abcdef" for character in raw)
    ):
        raise _error("nativeBuildIdentity phải có đúng 64 ký tự hex thường.")
    return raw


def build_production_request(
    public_request: Mapping[str, Any],
    *,
    job_id: str,
    request_revision: int,
    render_bundle: Mapping[str, Any],
    clearance: Mapping[str, Any],
    fixed_obstacles: Sequence[Mapping[str, Any]] = (),
    grouping_intent: str = "free_gang",
    placement_zones: Sequence[Mapping[str, Any]] = (),
    algorithm_versions: Mapping[str, int | str],
    native_build_identity: str,
    rotation_policy: Mapping[str, Any] | None = None,
    allow_continuous_rotation: bool = False,
    alignment: str = "center",
) -> ProductionNestingRequest:
    """Dựng request production đã ghim identity cho Tem bế/CNC.

    ``public_request`` phải là payload đã qua Pydantic. Hàm vẫn kiểm fail-closed để
    callsite nội bộ không vô tình đưa field client-owned vào native.
    """

    request = _as_mapping(public_request, "request")
    if "productionContract" in request or "jobId" in request:
        raise _error("Client không được gửi productionContract hoặc jobId.")
    unknown = set(request).difference(_PUBLIC_REQUEST_KEYS)
    if unknown:
        raise _error(f"Request production chứa field lạ: {', '.join(sorted(unknown))}.")
    if request.get("protocolVersion") != MIXED_NESTING_PROTOCOL_VERSION:
        raise _error("protocolVersion không khớp sidecar.")
    if (
        not isinstance(job_id, str)
        or len(job_id) != 32
        or any(character not in "0123456789abcdef" for character in job_id)
    ):
        raise _error("jobId production phải là 32 ký tự hex thường do server cấp.")
    if (
        isinstance(request_revision, bool)
        or not isinstance(request_revision, int)
        or request_revision <= 0
    ):
        raise _error("requestRevision phải là số nguyên dương.")

    layout_intent = request.get("layoutIntent", "quantity_fulfillment")
    if layout_intent not in _LAYOUT_INTENTS:
        raise _error("layoutIntent không được hỗ trợ.")
    seed = request.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**64 - 1:
        raise _error("seed phải là số nguyên không âm.")
    profile = request.get("profile", "balanced")
    if profile not in {"fast", "balanced", "tight"}:
        raise _error("profile không được hỗ trợ.")
    time_budget_ms = request.get("timeBudgetMs")
    if time_budget_ms is not None and (
        isinstance(time_budget_ms, bool)
        or not isinstance(time_budget_ms, int)
        or time_budget_ms <= 0
    ):
        raise _error("timeBudgetMs phải là số nguyên dương khi có mặt.")

    if not isinstance(allow_continuous_rotation, bool):
        raise _error("allow_continuous_rotation phải là boolean.")
    if alignment not in {
        "top-left",
        "top-center",
        "top-right",
        "center-left",
        "center",
        "center-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
    }:
        raise _error("alignment không được hỗ trợ.")
    # `request["orientationPolicy"]` của client CỐ Ý bị bỏ qua, giống `gapMm`:
    # miền xoay là server-owned. Nhưng nó phải đến từ tham số tường minh của
    # callsite, không phải hằng ghi cứng trong hàm này.
    orientation_policy = _canonical_orientation_policy(
        _CARDINAL_ROTATION_POLICY if rotation_policy is None else rotation_policy,
        allow_continuous_rotation=allow_continuous_rotation,
    )

    sheet = _canonical_sheet(request.get("sheet"))
    if layout_intent in _AUTOFILL_LAYOUT_INTENTS and sheet["maxSheets"] != 1:
        raise _error("Bình tự lấp đầy một tờ yêu cầu sheet.maxSheets = 1.")

    raw_parts = request.get("parts")
    if not isinstance(raw_parts, (list, tuple)) or not raw_parts:
        raise _error("parts phải là mảng không rỗng.")
    parts = [
        _canonical_part(part, index, layout_intent)
        for index, part in enumerate(raw_parts)
    ]
    parts.sort(key=lambda part: part["partId"].encode("utf-8"))
    if len({part["partId"] for part in parts}) != len(parts):
        raise _error("partId bị trùng sau chuẩn hoá.")
    if layout_intent == "step_repeat_single_sheet" and len(parts) != 1:
        raise _error("Bình trang yêu cầu đúng một mẫu trong mỗi job.")

    canonical_grouping_intent = _canonical_grouping_intent(grouping_intent)
    if (
        canonical_grouping_intent == "maximize_area"
        and layout_intent == "step_repeat_single_sheet"
    ):
        raise _error("Bình trang một mẫu không dùng Chia đều diện tích.")
    canonical_placement_zones = _canonical_placement_zones(
        placement_zones,
        grouping_intent=canonical_grouping_intent,
        parts=parts,
        sheet=sheet,
    )

    # NEST (audit 2026-08-27): bundle được dựng từ PartDefinition typed và chỉ
    # được băm sau khi exact part set, footprint, source và page mapping đều đạt.
    canonical_bundle = _canonical_render_bundle(
        render_bundle,
        parts,
        request_layout_intent=layout_intent,
        sheet=sheet,
    )
    normalized_bundle = canonical_bundle.to_canonical_dict()
    render_bundle_hash = canonical_sha256(normalized_bundle)
    for part in parts:
        # Ghim coarse-grained toàn bundle: đổi một side/page mapping bất kỳ thì
        # placement cũ không còn đủ provenance để preview hoặc xuất lại.
        part["sourceRevision"] = render_bundle_hash

    canonical_clearance = _canonical_clearance(clearance)
    obstacles = _canonical_obstacles(fixed_obstacles)
    versions = _production_versions(algorithm_versions)
    build_identity = _canonical_native_build_identity(native_build_identity)
    solver_config: dict[str, Any] = {
        "seed": seed,
        "profile": profile,
        "layoutIntent": layout_intent,
        "maxSheets": sheet["maxSheets"],
        # Cùng MỘT object canonical với engine_request bên dưới: nếu hai chỗ dựng
        # riêng thì solverConfigHash có thể khớp trong khi engine chạy miền khác.
        "orientationPolicy": orientation_policy,
    }
    if time_budget_ms is not None:
        solver_config["timeBudgetMs"] = time_budget_ms
    solver_config_hash = canonical_sha256(solver_config)
    geometry_constraints_hash = canonical_sha256(
        {
            "sheet": sheet,
            "groupingIntent": canonical_grouping_intent,
            "placementZones": canonical_placement_zones,
            "clearance": canonical_clearance,
            "fixedObstacles": obstacles,
            "footprints": [
                {"partId": part["partId"], "geometryHash": part["geometryHash"]}
                for part in parts
            ],
        }
    )

    engine_request: dict[str, Any] = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": seed,
        "profile": profile,
        "sheet": sheet,
        # NEST (audit 2026-08-27): production chỉ có ba clearance tường minh.
        # `gapMm` phải bằng 0 — Rust trả LEGACY_GAP_WITH_PRODUCTION_CONTRACT nếu
        # khác 0 khi đã có productionContract. gapX/gapY của UI đi qua
        # `clearance.partToPart`, rồi normalize.rs suy ra gap broad-phase.
        "gapMm": 0.0,
        "layoutIntent": layout_intent,
        "orientationPolicy": orientation_policy,
        "parts": parts,
        "jobId": job_id,
    }
    if time_budget_ms is not None:
        engine_request["timeBudgetMs"] = time_budget_ms

    input_identity_request = {
        key: value for key, value in engine_request.items() if key != "jobId"
    }
    input_hash = canonical_sha256(
        {
            "request": input_identity_request,
            # NEST (audit 2026-08-29 §NEST-CENTER-3): alignment đổi pose
            # authoritative dù không đổi search; input identity phải ký nó.
            "alignment": alignment,
            "renderBundleHash": render_bundle_hash,
            "solverConfigHash": solver_config_hash,
            "geometryConstraintsHash": geometry_constraints_hash,
        }
    )
    layout_fingerprint = canonical_sha256(
        {
            "inputHash": input_hash,
            "strategyId": TRUE_SHAPE_NESTING_STRATEGY,
            "solverConfigHash": solver_config_hash,
            "alignment": alignment,
            "algorithmVersions": versions,
            "geometryConstraintsHash": geometry_constraints_hash,
            "nativeBuildIdentity": build_identity,
        }
    )
    engine_request["productionContract"] = {
        "schemaVersion": MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        "requestRevision": request_revision,
        "inputHash": input_hash,
        "layoutFingerprint": layout_fingerprint,
        "alignment": alignment,
        "groupingIntent": canonical_grouping_intent,
        "placementZones": canonical_placement_zones,
        "clearance": canonical_clearance,
        "fixedObstacles": obstacles,
    }
    return ProductionNestingRequest(
        engine_request=engine_request,
        render_bundle=normalized_bundle,
        render_bundle_hash=render_bundle_hash,
        input_hash=input_hash,
        solver_config_hash=solver_config_hash,
        geometry_constraints_hash=geometry_constraints_hash,
        layout_fingerprint=layout_fingerprint,
        algorithm_versions=versions,
        native_build_identity=build_identity,
    )


def _public_payload_from_canonical_engine(
    raw: Any,
) -> tuple[
    dict[str, Any],
    str,
    int,
    str,
    str,
    Sequence[Mapping[str, Any]],
    Mapping[str, Any],
    Sequence[Mapping[str, Any]],
]:
    request = _as_mapping(raw, "production.engineRequest")
    expected_request_fields = {
        "protocolVersion",
        "seed",
        "profile",
        "sheet",
        "gapMm",
        "layoutIntent",
        "orientationPolicy",
        "parts",
        "jobId",
        "productionContract",
    }
    if "timeBudgetMs" in request:
        expected_request_fields.add("timeBudgetMs")
    _require_exact_fields(request, expected_request_fields, "production.engineRequest")

    contract = _as_mapping(
        request["productionContract"], "production.engineRequest.productionContract"
    )
    _require_exact_fields(
        contract,
        {
            "schemaVersion",
            "requestRevision",
            "inputHash",
            "layoutFingerprint",
            "alignment",
            "groupingIntent",
            "placementZones",
            "clearance",
            "fixedObstacles",
        },
        "production.engineRequest.productionContract",
    )
    raw_parts = request["parts"]
    if not isinstance(raw_parts, (list, tuple)) or not raw_parts:
        raise _error("production.engineRequest.parts phải là mảng không rỗng.")
    layout_intent = request["layoutIntent"]
    if layout_intent not in _LAYOUT_INTENTS:
        raise _error("production.engineRequest.layoutIntent không được hỗ trợ.")

    public_parts: list[dict[str, Any]] = []
    for index, raw_part in enumerate(raw_parts):
        field = f"production.engineRequest.parts[{index}]"
        part = _as_mapping(raw_part, field)
        expected_part_fields = {
            "partId",
            "outer",
            "holes",
            "rotationConstraint",
            "referencePointMm",
            "geometryHash",
            "sourceRevision",
        }
        if layout_intent == "quantity_fulfillment":
            expected_part_fields.add("quantity")
        _require_exact_fields(part, expected_part_fields, field)
        public_parts.append(
            {key: part[key] for key in _PUBLIC_PART_KEYS if key in part}
        )

    public_request = {
        key: request[key]
        for key in _PUBLIC_REQUEST_KEYS
        if key != "parts" and key in request
    }
    public_request["parts"] = public_parts
    return (
        public_request,
        request["jobId"],
        contract["requestRevision"],
        contract["alignment"],
        contract["groupingIntent"],
        contract["placementZones"],
        contract["clearance"],
        contract["fixedObstacles"],
    )


def _resolver_bundle_from_canonical(raw: Any) -> dict[str, Any]:
    bundle = _as_mapping(raw, "production.renderBundle")
    root_keys = {
        "schemaVersion",
        "flow",
        "outputSides",
        "duplex",
        "marks",
        "artifactOptions",
        "sheetFrames",
        "renderer",
        "cutStyle",
        "parts",
    }
    _require_exact_fields(bundle, root_keys, "production.renderBundle")
    raw_parts = bundle["parts"]
    if not isinstance(raw_parts, (list, tuple)) or not raw_parts:
        raise _error("production.renderBundle.parts phải là mảng không rỗng.")
    resolver_parts: list[dict[str, Any]] = []
    base_canonical_keys = {
        "partId",
        "referencePointMm",
        "geometryHash",
        "packingFootprint",
        "cutContour",
        "artworkClipPath",
        "source",
        "pages",
    }
    for index, raw_part in enumerate(raw_parts):
        field = f"production.renderBundle.parts[{index}]"
        part = _as_mapping(raw_part, field)
        canonical_keys = set(base_canonical_keys)
        if "dieDimensionsMm" in part:
            canonical_keys.add("dieDimensionsMm")
        _require_exact_fields(part, canonical_keys, field)
        resolver_keys = canonical_keys.difference(
            {"referencePointMm", "geometryHash", "pages"}
        )
        reference_point = part["referencePointMm"]
        if not isinstance(reference_point, (list, tuple)) or len(reference_point) != 2:
            raise _error(f"{field}.referencePointMm phải có đúng hai toạ độ.")
        geometry_hash = part["geometryHash"]
        if (
            not isinstance(geometry_hash, str)
            or len(geometry_hash) != 71
            or not geometry_hash.startswith("sha256:")
            or any(
                character not in "0123456789abcdef" for character in geometry_hash[7:]
            )
        ):
            raise _error(f"{field}.geometryHash không đúng định dạng sha256.")
        pages = _as_mapping(part["pages"], f"{field}.pages")
        _require_exact_fields(pages, {"front", "back", "cut"}, f"{field}.pages")
        resolver_pages: dict[str, Any] = {}
        for side in ("front", "back", "cut"):
            binding = pages[side]
            if binding is None:
                resolver_pages[side] = None
                continue
            binding_field = f"{field}.pages.{side}"
            canonical_binding = _as_mapping(binding, binding_field)
            binding_keys = {
                "pageIndex",
                "pageBoxesMm",
                "userUnit",
                "rotateDeg",
                "sourcePageToCanonical",
                "sourceReferencePointMm",
            }
            _require_exact_fields(canonical_binding, binding_keys, binding_field)
            source_reference = canonical_binding["sourceReferencePointMm"]
            if (
                not isinstance(source_reference, (list, tuple))
                or len(source_reference) != 2
            ):
                raise _error(
                    f"{binding_field}.sourceReferencePointMm phải có đúng hai toạ độ."
                )
            resolver_pages[side] = {
                key: canonical_binding[key]
                for key in binding_keys.difference({"sourceReferencePointMm"})
            }
        resolver_part = {key: part[key] for key in resolver_keys}
        resolver_part["pages"] = resolver_pages
        resolver_parts.append(resolver_part)
    return {
        "schemaVersion": bundle["schemaVersion"],
        "flow": bundle["flow"],
        "outputSides": bundle["outputSides"],
        "duplex": bundle["duplex"],
        "marks": bundle["marks"],
        "artifactOptions": bundle["artifactOptions"],
        "sheetFrames": bundle["sheetFrames"],
        "renderer": bundle["renderer"],
        # NEST (audit 2026-08-28 §A1.1): cutStyle là ĐẦU VÀO authoritative, không
        # phải giá trị dẫn xuất — phải giữ nguyên khi dựng lại sau restart, nếu
        # bỏ đi thì writer mất tiêu chí nhận nét bế và fingerprint sẽ lệch.
        "cutStyle": _canonical_cut_style(
            bundle["cutStyle"], "production.renderBundle.cutStyle"
        ).to_canonical_dict(),
        "parts": resolver_parts,
    }


def validate_production_request_identity(
    production: ProductionNestingRequest,
) -> ProductionNestingRequest:
    """Dựng lại mọi identity; trả bản canonical tách rời hoặc fail-closed.

    Store gọi hàm này cả khi persist lẫn load. Vì rebuild đi qua chính adapter,
    bundle sai part/pivot/hash/source/page và contract hash bị sửa đều bị từ chối.
    """

    if not isinstance(production, ProductionNestingRequest):
        raise _error("production phải là ProductionNestingRequest.")
    (
        public_request,
        job_id,
        request_revision,
        alignment,
        grouping_intent,
        placement_zones,
        clearance,
        obstacles,
    ) = _public_payload_from_canonical_engine(production.engine_request)
    resolver_bundle = _resolver_bundle_from_canonical(production.render_bundle)
    rebuild_kwargs = {
        "job_id": job_id,
        "request_revision": request_revision,
        "render_bundle": resolver_bundle,
        "clearance": clearance,
        "fixed_obstacles": obstacles,
        "grouping_intent": grouping_intent,
        "placement_zones": placement_zones,
        "alignment": alignment,
        "algorithm_versions": production.algorithm_versions,
        "native_build_identity": production.native_build_identity,
    }
    rebuilt = build_production_request(public_request, **rebuild_kwargs)
    if canonical_json_bytes(rebuilt.engine_request) != canonical_json_bytes(
        production.engine_request
    ):
        raise _error("engineRequest hoặc productionContract không khớp identity dựng lại.")
    if canonical_json_bytes(rebuilt.render_bundle) != canonical_json_bytes(
        production.render_bundle
    ):
        raise _error("renderBundle không khớp PartDefinition canonical dựng lại.")
    for field in (
        "render_bundle_hash",
        "input_hash",
        "solver_config_hash",
        "geometry_constraints_hash",
        "layout_fingerprint",
    ):
        if getattr(production, field) != getattr(rebuilt, field):
            raise _error(f"production.{field} không khớp identity dựng lại.")
    return rebuilt
