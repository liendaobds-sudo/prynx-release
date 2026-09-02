"""Dựng RenderBundle V2 bất biến cho Bình tem bế/CNC.

Builder chỉ nhận source đã pin, geometry typed và context render typed. Path,
lease token, góc xếp thủ công và version renderer không có đường đi vào bundle.
"""

from __future__ import annotations

import json
import math
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN, localcontext
from typing import Any, Literal, Sequence

from app.core.nesting_production_adapter import RenderPolygonV1, canonical_json_bytes
from app.core.nesting_source_pin import (
    PinnedNestingSource,
    PinnedPageMetadata,
    source_descriptor,
)


STICKER_IMPOSER_RENDERER_VERSION = "sticker-manifest-affine-v1"
CNC_IMPOSER_RENDERER_VERSION = "cnc-manifest-affine-v3-duplex-registration"

# FIX/PARITY (audit 2026-08-29 §MAP-NEST-08): hình học dấu canh duplex
# là server-owned và dùng chung cho writer + vật cản solver. Giữ đúng lane CNC legacy.
DUPLEX_REGISTRATION_MARGIN_MM = 3.0
DUPLEX_REGISTRATION_CIRCLE_DIAMETER_MM = 3.0
DUPLEX_REGISTRATION_LINE_LENGTH_MM = 5.0
DUPLEX_REGISTRATION_STROKE_WIDTH_MM = 0.1

RenderTool = Literal["sticker_imposer", "cnc_imposer"]
RenderTaskMode = Literal["step_repeat", "nup"]
LayoutIntent = Literal[
    "autofill_single_sheet",
    "step_repeat_single_sheet",
    "quantity_fulfillment",
]
_AUTOFILL_LAYOUT_INTENTS = frozenset(
    {"autofill_single_sheet", "step_repeat_single_sheet"}
)
DuplexMode = Literal["simplex", "duplex"]
FlipEdge = Literal["none", "long", "short"]
ReportFieldKey = Literal[
    "orderCode", "identifier", "gangCount", "labelName", "material",
    "lamination", "labelsPerSheet", "actualQty", "sheetCount", "dimensions",
    "paperSize", "cutFileRef", "modeLabel",
]
_REPORT_FIELD_KEYS = frozenset(
    {
        "orderCode", "identifier", "gangCount", "labelName", "material",
        "lamination", "labelsPerSheet", "actualQty", "sheetCount", "dimensions",
        "paperSize", "cutFileRef", "modeLabel",
    }
)
_IDENTITY_AFFINE = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
_QUANTUM = Decimal("0.000001")
# NEST (audit 2026-08-28 §A1.1): giữ ĐỒNG BỘ với nesting_production_adapter.
# Builder phải chặn sớm bằng cùng luật, nếu không adapter mới báo lỗi và người
# dùng nhận thông điệp ở tầng sai.
_CUT_PROCESS_SPACES = frozenset({"cmyk", "rgb", "gray"})
_CUT_STROKE_SPACES = frozenset({"cmyk", "rgb", "gray", "separation"})
_CUT_SPACE_ARITY: dict[str, int] = {"cmyk": 4, "rgb": 3, "gray": 1, "separation": 1}
_CUT_STROKE_MAX_WIDTH_MM = 10.0
_CUT_COLOR_TOLERANCE_MAX = 0.5
_CUT_GEOMETRY_TOLERANCE_MAX_MM = 1.0
_CUT_NAME_MAX_LEN = 128


class ImpositionRenderBundleError(ValueError):
    """Context render không thể đóng thành bundle production."""


@dataclass(frozen=True)
class ImpositionTrimSpec:
    type: Literal["none", "corners", "guillotine"] = "none"
    length_mm: float = 5.0
    offset_mm: float = 3.0
    thickness_mm: float = 0.25
    style: Literal["default", "japanese"] = "default"

    def to_bundle_dict(self) -> dict[str, Any]:
        return {"type": self.type, "lengthMm": self.length_mm, "offsetMm": self.offset_mm, "thicknessMm": self.thickness_mm, "style": self.style}


@dataclass(frozen=True)
class ImpositionPontGuideSpec:
    position: Literal["TL", "TR", "BL", "BR"]
    length_mm: float
    thickness_mm: float
    offset_x_mm: float = 0.0
    offset_y_mm: float = 0.0

    def to_bundle_dict(self) -> dict[str, Any]:
        return {"position": self.position, "lengthMm": self.length_mm, "thicknessMm": self.thickness_mm, "offsetXmm": self.offset_x_mm, "offsetYmm": self.offset_y_mm}


@dataclass(frozen=True)
class ImpositionPontConfigSpec:
    shape: Literal["circle", "l_corner", "l_inverted"]
    size_mm: float
    thickness_mm: float
    is_graphtec: bool
    layer_info_name: str
    layer_name: str
    group_name: str
    item_name: str
    disable_collision: bool
    margin_top_mm: float
    margin_bottom_mm: float
    margin_left_mm: float
    margin_right_mm: float
    guides: tuple[ImpositionPontGuideSpec, ...] = ()

    def to_bundle_dict(self) -> dict[str, Any]:
        return {
            "shape": self.shape, "sizeMm": self.size_mm, "thicknessMm": self.thickness_mm,
            "isGraphtec": self.is_graphtec, "layerInfoName": self.layer_info_name,
            "layerName": self.layer_name, "groupName": self.group_name, "itemName": self.item_name,
            "disableCollision": self.disable_collision,
            "marginsMm": {"top": self.margin_top_mm, "bottom": self.margin_bottom_mm, "left": self.margin_left_mm, "right": self.margin_right_mm},
            "guides": [guide.to_bundle_dict() for guide in self.guides],
        }


@dataclass(frozen=True)
class ImpositionPontSpec:
    type: Literal["none", "corner", "5mm", "custom"] = "none"
    config: ImpositionPontConfigSpec | None = None

    def to_bundle_dict(self) -> dict[str, Any]:
        return {"type": self.type, "config": None if self.config is None else self.config.to_bundle_dict()}


@dataclass(frozen=True)
class ImpositionCutSpec:
    type: Literal["default", "one_dao"] = "default"
    separate_page: bool = True
    ponts_on_cut_file: bool = True
    fill_block_gap_mm: float = 0.0
    die_size_mode: Literal["die", "page"] = "die"
    die_offset_mm: float = 0.0

    def to_bundle_dict(self) -> dict[str, Any]:
        return {"type": self.type, "separatePage": self.separate_page, "pontsOnCutFile": self.ponts_on_cut_file, "fillBlockGapMm": self.fill_block_gap_mm, "dieSizeMode": self.die_size_mode, "dieOffsetMm": self.die_offset_mm}


@dataclass(frozen=True)
class ImpositionCutSourceFilterSpec:
    """Tiêu chí nhận diện nét bế trong file nguồn.

    Mặc định theo thói quen file khách Việt Nam: kênh spot ``cutcontour``.
    """

    mode: Literal["spot", "process"] = "spot"
    spot_names: tuple[str, ...] = ("cutcontour",)
    process_space: Literal["cmyk", "rgb", "gray"] | None = None
    process_components: tuple[float, ...] | None = None
    color_tolerance: float = 0.01
    die_layer_names: tuple[str, ...] = ()
    geometry_tolerance_mm: float = 0.1

    def to_bundle_dict(self) -> dict[str, Any]:
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
class ImpositionCutStrokeSpec:
    """Cách vẽ nét CUT trên tờ ra. Mặc định 100% Magenta CMYK, dày 0,25mm.

    NEST (audit 2026-08-28 §A3.1): ``colorSpace = separation`` bắt buộc kèm
    ``alternate_*`` — đó là màu mà RIP dùng khi tách kênh spot không tồn tại.
    """

    width_mm: float = 0.25
    color_space: Literal["cmyk", "rgb", "gray", "separation"] = "cmyk"
    components: tuple[float, ...] = (0.0, 1.0, 0.0, 0.0)
    separation_name: str | None = None
    alternate_space: Literal["cmyk", "rgb", "gray"] | None = None
    alternate_components: tuple[float, ...] | None = None
    overprint: bool = False

    def to_bundle_dict(self) -> dict[str, Any]:
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
class ImpositionCutStyleSpec:
    """Một bundle chỉ mang MỘT cutStyle nên Front/Back/Cut không thể lệch nét bế."""

    source_filter: ImpositionCutSourceFilterSpec = field(
        default_factory=ImpositionCutSourceFilterSpec
    )
    stroke: ImpositionCutStrokeSpec = field(
        default_factory=ImpositionCutStrokeSpec
    )

    def to_bundle_dict(self) -> dict[str, Any]:
        return {
            "sourceFilter": self.source_filter.to_bundle_dict(),
            "stroke": self.stroke.to_bundle_dict(),
        }


@dataclass(frozen=True)
class ImpositionReportLamination:
    type: Literal["none", "gloss", "matte"] = "none"
    sides: Literal[1, 2] = 1


@dataclass(frozen=True)
class ImpositionReportPlacement:
    position: Literal["top", "bottom", "left", "right"] = "top"
    centered: bool = True
    offset_x_mm: float = 5.0
    offset_y_mm: float = 5.0
    font_size_pt: float = 8.0


@dataclass(frozen=True)
class ImpositionReportDisabled:
    enabled: Literal[False] = field(default=False, init=False)


@dataclass(frozen=True)
class ImpositionReportEnabled:
    fields: tuple[ReportFieldKey, ...]
    requested_qty: int | None = None
    label_name: str = ""
    material: str = ""
    lamination: ImpositionReportLamination = field(
        default_factory=ImpositionReportLamination
    )
    order_code: str = ""
    custom_text: str = ""
    remove_diacritics: bool = False
    placement: ImpositionReportPlacement = field(
        default_factory=ImpositionReportPlacement
    )
    enabled: Literal[True] = field(default=True, init=False)


ImpositionReportSpec = ImpositionReportDisabled | ImpositionReportEnabled


@dataclass(frozen=True)
class ImpositionArtifactOptions:
    export_unique_sheets: bool = True
    report: ImpositionReportSpec = field(
        default_factory=ImpositionReportDisabled
    )


@dataclass(frozen=True)
class ImpositionRenderPartSpec:
    part_id: str
    source_pin: PinnedNestingSource
    packing_footprint: RenderPolygonV1
    cut_contour: RenderPolygonV1
    artwork_clip_path: RenderPolygonV1
    # FIX (audit 2026-08-29 §MAP-NEST-06 · re-audit 2026-09-01 §DIM-DIE):
    # kích thước thành phẩm server-owned; không được suy lại từ contour production.
    die_dimensions_mm: tuple[float, float]
    front_page_index: int
    cut_page_index: int
    back_page_index: int | None = None


@dataclass(frozen=True)
class ImpositionRenderContext:
    tool: RenderTool
    task_mode: RenderTaskMode
    layout_intent: LayoutIntent
    sheet_width_mm: float
    sheet_height_mm: float
    duplex_mode: DuplexMode = "simplex"
    flip_edge: FlipEdge = "none"
    trim: ImpositionTrimSpec = field(default_factory=ImpositionTrimSpec)
    pont: ImpositionPontSpec = field(default_factory=ImpositionPontSpec)
    cut: ImpositionCutSpec = field(default_factory=ImpositionCutSpec)
    cut_style: ImpositionCutStyleSpec = field(
        default_factory=ImpositionCutStyleSpec
    )
    duplex_registration: bool = False
    artifact_options: ImpositionArtifactOptions = field(
        default_factory=ImpositionArtifactOptions
    )


@dataclass(frozen=True)
class BuiltImpositionRenderBundle:
    canonical_bytes: bytes
    source_pins: tuple[PinnedNestingSource, ...]

    @property
    def render_bundle(self) -> dict[str, Any]:
        """Trả bản sao mới; caller không thể mutate snapshot đã chốt."""
        value = json.loads(self.canonical_bytes.decode("utf-8"))
        if not isinstance(value, dict):  # pragma: no cover - invariant nội bộ
            raise ImpositionRenderBundleError("Snapshot RenderBundle không phải object.")
        return value


def _canonical_text(
    value: str, field_name: str, *, max_length: int = 512
) -> str:
    if not isinstance(value, str):
        raise ImpositionRenderBundleError(f"{field_name} phải là chuỗi.")
    normalized = unicodedata.normalize("NFC", value.strip())
    if len(normalized) > max_length or any(
        unicodedata.category(character) == "Cc" for character in normalized
    ):
        raise ImpositionRenderBundleError(
            f"{field_name} chứa ký tự điều khiển hoặc dài quá {max_length} ký tự."
        )
    return normalized


def _q_nonnegative(value: float, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ImpositionRenderBundleError(f"{field_name} phải là số hữu hạn.")
    try:
        decimal_value = Decimal(str(value))
        if not decimal_value.is_finite():
            raise ImpositionRenderBundleError(f"{field_name} phải là số hữu hạn.")
        with localcontext() as context:
            context.prec = max(50, len(decimal_value.as_tuple().digits) + 24)
            rounded = decimal_value.quantize(_QUANTUM, rounding=ROUND_HALF_EVEN)
    except (InvalidOperation, ValueError, OverflowError) as exc:
        raise ImpositionRenderBundleError(
            f"{field_name} không thể chuẩn hoá 6 chữ số."
        ) from exc
    if rounded < 0:
        raise ImpositionRenderBundleError(f"{field_name} không được âm.")
    result = float(rounded)
    return 0.0 if result == 0.0 else result


def _cut_name(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ImpositionRenderBundleError(f"{field_name} phải là chuỗi.")
    name = unicodedata.normalize("NFC", value.strip()).lower()
    if (
        not name
        or len(name) > _CUT_NAME_MAX_LEN
        or any(unicodedata.category(character) == "Cc" for character in name)
    ):
        raise ImpositionRenderBundleError(
            f"{field_name} rỗng, có ký tự điều khiển hoặc dài quá "
            f"{_CUT_NAME_MAX_LEN} ký tự."
        )
    return name


def _cut_name_list(value: Any, field_name: str) -> list[str]:
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
        raise ImpositionRenderBundleError(f"{field_name} phải là tuple chuỗi.")
    names: list[str] = []
    for index, item in enumerate(value):
        name = _cut_name(item, f"{field_name}[{index}]")
        if name in names:
            raise ImpositionRenderBundleError(
                f"{field_name} không được trùng tên {name!r}."
            )
        names.append(name)
    names.sort(key=lambda item: item.encode("utf-8"))
    return names


def _cut_components(value: Any, field_name: str, *, arity: int) -> list[float]:
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
        raise ImpositionRenderBundleError(f"{field_name} phải là tuple số.")
    if len(value) != arity:
        raise ImpositionRenderBundleError(
            f"{field_name} phải có đúng {arity} thành phần màu."
        )
    components: list[float] = []
    for index, item in enumerate(value):
        channel = _q_nonnegative(item, f"{field_name}[{index}]")
        if channel > 1.0:
            raise ImpositionRenderBundleError(
                f"{field_name}[{index}] phải nằm trong khoảng 0..1."
            )
        components.append(channel)
    return components


def _cut_style(context: ImpositionRenderContext) -> dict[str, Any]:
    style = context.cut_style
    if not isinstance(style, ImpositionCutStyleSpec):
        raise ImpositionRenderBundleError(
            "cut_style phải là ImpositionCutStyleSpec."
        )
    source = style.source_filter
    if not isinstance(source, ImpositionCutSourceFilterSpec):
        raise ImpositionRenderBundleError(
            "cut_style.source_filter phải là ImpositionCutSourceFilterSpec."
        )
    stroke = style.stroke
    if not isinstance(stroke, ImpositionCutStrokeSpec):
        raise ImpositionRenderBundleError(
            "cut_style.stroke phải là ImpositionCutStrokeSpec."
        )
    if source.mode not in {"spot", "process"}:
        raise ImpositionRenderBundleError("cut_style.source_filter.mode không hợp lệ.")

    spot_names = _cut_name_list(source.spot_names, "cut_style.source_filter.spot_names")
    process_color: dict[str, Any] | None = None
    if source.mode == "spot":
        if not spot_names:
            raise ImpositionRenderBundleError(
                "cut_style.source_filter.spot_names không được rỗng khi mode=spot."
            )
        if source.process_space is not None or source.process_components is not None:
            raise ImpositionRenderBundleError(
                "cut_style.source_filter không được khai màu process khi mode=spot."
            )
    else:
        if spot_names:
            raise ImpositionRenderBundleError(
                "cut_style.source_filter.spot_names phải rỗng khi mode=process."
            )
        if source.process_space not in _CUT_PROCESS_SPACES:
            raise ImpositionRenderBundleError(
                "cut_style.source_filter.process_space không được hỗ trợ."
            )
        process_color = {
            "space": source.process_space,
            "components": _cut_components(
                source.process_components,
                "cut_style.source_filter.process_components",
                arity=_CUT_SPACE_ARITY[source.process_space],
            ),
        }

    color_tolerance = _q_nonnegative(
        source.color_tolerance, "cut_style.source_filter.color_tolerance"
    )
    if color_tolerance > _CUT_COLOR_TOLERANCE_MAX:
        raise ImpositionRenderBundleError(
            "cut_style.source_filter.color_tolerance vượt "
            f"{_CUT_COLOR_TOLERANCE_MAX}."
        )
    geometry_tolerance = _q_nonnegative(
        source.geometry_tolerance_mm, "cut_style.source_filter.geometry_tolerance_mm"
    )
    if not 0.0 < geometry_tolerance <= _CUT_GEOMETRY_TOLERANCE_MAX_MM:
        raise ImpositionRenderBundleError(
            "cut_style.source_filter.geometry_tolerance_mm phải lớn hơn 0 và tối đa "
            f"{_CUT_GEOMETRY_TOLERANCE_MAX_MM}mm."
        )

    if stroke.color_space not in _CUT_STROKE_SPACES:
        raise ImpositionRenderBundleError(
            "cut_style.stroke.color_space không được hỗ trợ."
        )
    width_mm = _q_nonnegative(stroke.width_mm, "cut_style.stroke.width_mm")
    if not 0.0 < width_mm <= _CUT_STROKE_MAX_WIDTH_MM:
        raise ImpositionRenderBundleError(
            "cut_style.stroke.width_mm phải lớn hơn 0 và tối đa "
            f"{_CUT_STROKE_MAX_WIDTH_MM}mm."
        )
    if not isinstance(stroke.overprint, bool):
        raise ImpositionRenderBundleError("cut_style.stroke.overprint phải là boolean.")
    components = _cut_components(
        stroke.components,
        "cut_style.stroke.components",
        arity=_CUT_SPACE_ARITY[stroke.color_space],
    )
    alternate: dict[str, Any] | None = None
    if stroke.color_space == "separation":
        separation_name: str | None = _cut_name(
            stroke.separation_name, "cut_style.stroke.separation_name"
        )
        if stroke.alternate_space not in _CUT_PROCESS_SPACES:
            raise ImpositionRenderBundleError(
                "cut_style.stroke.alternate_space bắt buộc khi colorSpace=separation."
            )
        alternate_components = _cut_components(
            stroke.alternate_components,
            "cut_style.stroke.alternate_components",
            arity=_CUT_SPACE_ARITY[stroke.alternate_space],
        )
        if not any(value > 0.0 for value in alternate_components):
            raise ImpositionRenderBundleError(
                "cut_style.stroke.alternate_components phải có kênh lớn hơn 0."
            )
        alternate = {
            "space": stroke.alternate_space,
            "components": alternate_components,
        }
    else:
        if stroke.separation_name is not None:
            raise ImpositionRenderBundleError(
                "cut_style.stroke.separation_name chỉ dùng cho colorSpace=separation."
            )
        if (
            stroke.alternate_space is not None
            or stroke.alternate_components is not None
        ):
            raise ImpositionRenderBundleError(
                "cut_style.stroke.alternate_* chỉ dùng cho colorSpace=separation."
            )
        separation_name = None

    return {
        "sourceFilter": {
            "mode": source.mode,
            "spotNames": spot_names,
            "processColor": process_color,
            "colorTolerance": color_tolerance,
            "dieLayerNames": _cut_name_list(
                source.die_layer_names, "cut_style.source_filter.die_layer_names"
            ),
            "geometryToleranceMm": geometry_tolerance,
        },
        "stroke": {
            "widthMm": width_mm,
            "colorSpace": stroke.color_space,
            "components": components,
            "separationName": separation_name,
            "alternate": alternate,
            "overprint": stroke.overprint,
        },
    }


def canonicalize_imposition_report(
    report: ImpositionReportSpec,
    *,
    layout_intent: str,
) -> dict[str, Any]:
    """Chuẩn hoá report server-owned để render lại mà không đổi placements.

    PERF (audit 2026-09-02 §REPORT-OVERLAY): report chỉ là overlay sau khi writer
    đã lưu tờ nền; nó không tham gia solve. Hàm công khai này cho phép handoff dùng
    layout preview bất biến nhưng vẫn đóng dấu metadata/số lượng mới nhất bằng đúng
    validator đã dựng RenderBundle ban đầu.
    """

    if isinstance(report, ImpositionReportDisabled):
        canonical_report: dict[str, Any] = {"enabled": False}
    elif isinstance(report, ImpositionReportEnabled):
        if not isinstance(report.fields, tuple):
            raise ImpositionRenderBundleError("report.fields phải là tuple bất biến.")
        fields = list(report.fields)
        if any(
            not isinstance(key, str) or key not in _REPORT_FIELD_KEYS
            for key in fields
        ):
            raise ImpositionRenderBundleError("report.fields có field không hỗ trợ.")
        if len(fields) != len(set(fields)):
            raise ImpositionRenderBundleError("report.fields không được trùng.")
        requested_qty = report.requested_qty
        if requested_qty is not None and (
            isinstance(requested_qty, bool)
            or not isinstance(requested_qty, int)
            or requested_qty <= 0
        ):
            raise ImpositionRenderBundleError(
                "report.requested_qty phải là số nguyên dương hoặc None."
            )
        if (
            requested_qty is not None
            and layout_intent != "step_repeat_single_sheet"
        ):
            raise ImpositionRenderBundleError(
                "report.requested_qty chỉ dùng cho bình trang một tờ đại diện."
            )
        if not isinstance(report.remove_diacritics, bool):
            raise ImpositionRenderBundleError(
                "report.remove_diacritics phải là boolean."
            )
        placement = report.placement
        if not isinstance(placement, ImpositionReportPlacement):
            raise ImpositionRenderBundleError(
                "report.placement phải là ImpositionReportPlacement."
            )
        if placement.position not in {"top", "bottom", "left", "right"}:
            raise ImpositionRenderBundleError(
                "report.placement.position không được hỗ trợ."
            )
        if not isinstance(placement.centered, bool):
            raise ImpositionRenderBundleError(
                "report.placement.centered phải là boolean."
            )
        font_size = _q_nonnegative(
            placement.font_size_pt, "report.placement.font_size_pt"
        )
        if not 4.0 <= font_size <= 40.0:
            raise ImpositionRenderBundleError(
                "report.placement.font_size_pt phải trong khoảng 4..40."
            )
        lamination = report.lamination
        if not isinstance(lamination, ImpositionReportLamination):
            raise ImpositionRenderBundleError(
                "report.lamination phải là ImpositionReportLamination."
            )
        if lamination.type not in {"none", "gloss", "matte"}:
            raise ImpositionRenderBundleError("report.lamination.type không hợp lệ.")
        if (
            isinstance(lamination.sides, bool)
            or not isinstance(lamination.sides, int)
            or lamination.sides not in {1, 2}
        ):
            raise ImpositionRenderBundleError("report.lamination.sides phải là 1 hoặc 2.")
        if lamination.type == "none" and lamination.sides != 1:
            raise ImpositionRenderBundleError(
                "Lamination none yêu cầu sides=1."
            )
        visible = set(fields)
        canonical_report = {
            "enabled": True,
            "fields": fields,
            # FIX/PARITY (audit 2026-08-29 §MAP-NEST-05): S&R chỉ xuất một tờ
            # đại diện nên demand không thể suy lại từ placement. Payload này chỉ
            # tham gia identity khi report thực sự in số tờ hoặc số lượng thực.
            "requestedQty": (
                requested_qty
                if visible.intersection({"actualQty", "sheetCount"})
                else None
            ),
            # NEST (audit 2026-08-28 §ARTIFACT.1): field bị ẩn không được
            # mang payload stale vào fingerprint của artifact.
            "labelName": _canonical_text(report.label_name, "report.label_name")
            if "labelName" in visible
            else "",
            "material": _canonical_text(report.material, "report.material")
            if "material" in visible
            else "",
            "lamination": (
                {"type": lamination.type, "sides": lamination.sides}
                if "lamination" in visible
                else {"type": "none", "sides": 1}
            ),
            "orderCode": _canonical_text(report.order_code, "report.order_code")
            if "orderCode" in visible
            else "",
            "customText": _canonical_text(
                report.custom_text,
                "report.custom_text",
                max_length=2048,
            ),
            "removeDiacritics": report.remove_diacritics,
            "placement": {
                "position": placement.position,
                "centered": placement.centered,
                "offsetXmm": _q_nonnegative(
                    placement.offset_x_mm, "report.placement.offset_x_mm"
                ),
                "offsetYmm": _q_nonnegative(
                    placement.offset_y_mm, "report.placement.offset_y_mm"
                ),
                "fontSizePt": font_size,
            },
        }
    else:
        raise ImpositionRenderBundleError("report phải là tagged report typed.")
    return canonical_report


def _artifact_options(context: ImpositionRenderContext) -> dict[str, Any]:
    options = context.artifact_options
    if not isinstance(options, ImpositionArtifactOptions):
        raise ImpositionRenderBundleError(
            "artifact_options phải là ImpositionArtifactOptions."
        )
    if not isinstance(options.export_unique_sheets, bool):
        raise ImpositionRenderBundleError("export_unique_sheets phải là boolean.")
    if (
        context.layout_intent in _AUTOFILL_LAYOUT_INTENTS
        or context.tool == "cnc_imposer"
    ) and not options.export_unique_sheets:
        raise ImpositionRenderBundleError(
            "Autofill và CNC yêu cầu export_unique_sheets=true."
        )

    return {
        "exportUniqueSheets": options.export_unique_sheets,
        "report": canonicalize_imposition_report(
            options.report,
            layout_intent=context.layout_intent,
        ),
    }


def _positive(value: float, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) <= 0.0:
        raise ImpositionRenderBundleError(f"{field_name} phải là số hữu hạn dương.")


def _binding(source_pin: PinnedNestingSource, page_index: int, *, side: str) -> dict[str, Any]:
    if isinstance(page_index, bool) or not isinstance(page_index, int):
        raise ImpositionRenderBundleError(f"{side}_page_index phải là số nguyên.")
    pages: dict[int, PinnedPageMetadata] = {}
    for page in source_pin.pages:
        if page.page_index in pages:
            raise ImpositionRenderBundleError(f"Source pin {source_pin.locator_id} có pageIndex trùng.")
        pages[page.page_index] = page
    page = pages.get(page_index)
    if page is None:
        raise ImpositionRenderBundleError(f"Source pin {source_pin.locator_id} không có trang {page_index}.")
    return page.to_binding_metadata()


def _duplex(context: ImpositionRenderContext) -> tuple[dict[str, str], list[float] | None]:
    if context.duplex_mode == "simplex":
        if context.flip_edge != "none":
            raise ImpositionRenderBundleError("Simplex yêu cầu flip_edge='none'.")
        return ({"mode": "simplex", "flipEdge": "none", "physicalAxis": "none"}, None)
    if context.tool != "cnc_imposer":
        raise ImpositionRenderBundleError("Bình tem bế hiện chỉ hỗ trợ simplex.")
    if context.flip_edge == "long":
        return ({"mode": "duplex", "flipEdge": "long", "physicalAxis": "x"}, [-1.0, 0.0, 0.0, 1.0, float(context.sheet_width_mm), 0.0])
    if context.flip_edge == "short":
        return ({"mode": "duplex", "flipEdge": "short", "physicalAxis": "y"}, [1.0, 0.0, 0.0, -1.0, 0.0, float(context.sheet_height_mm)])
    raise ImpositionRenderBundleError("Duplex yêu cầu flip_edge long hoặc short.")


def _marks(context: ImpositionRenderContext) -> dict[str, Any]:
    if context.tool == "cnc_imposer":
        # NEST (audit 2026-08-28 §4B2): CNC có contract dấu xén/CUT cố định;
        # settings stale không được persist vào immutable manifest.
        trim = ImpositionTrimSpec().to_bundle_dict()
        cut = ImpositionCutSpec().to_bundle_dict()
    else:
        trim = context.trim.to_bundle_dict()
        cut = context.cut.to_bundle_dict()
    return {"trim": trim, "pont": context.pont.to_bundle_dict(), "cut": cut, "duplexRegistration": context.duplex_registration}


def _renderer(tool: RenderTool) -> dict[str, str]:
    if tool == "sticker_imposer":
        return {"identity": "sticker_imposer_pdf", "version": STICKER_IMPOSER_RENDERER_VERSION}
    return {"identity": "cnc_imposer_pdf", "version": CNC_IMPOSER_RENDERER_VERSION}


def _bundle_part(
    part: ImpositionRenderPartSpec,
    *,
    tool: RenderTool,
    duplex_mode: DuplexMode,
) -> dict[str, Any]:
    if not isinstance(part.part_id, str) or not part.part_id.strip():
        raise ImpositionRenderBundleError("part_id không được rỗng.")
    if duplex_mode == "duplex" and part.back_page_index is None:
        raise ImpositionRenderBundleError(f"Part {part.part_id} thiếu back_page_index cho CNC duplex.")
    if duplex_mode == "simplex" and part.back_page_index is not None:
        raise ImpositionRenderBundleError(f"Part {part.part_id} không được có back_page_index ở simplex.")
    if part.cut_page_index != part.front_page_index:
        raise ImpositionRenderBundleError(
            f"Part {part.part_id} yêu cầu cut_page_index trùng Front."
        )
    if tool == "cnc_imposer":
        if part.front_page_index % 2 != 0:
            raise ImpositionRenderBundleError(
                f"Part {part.part_id} yêu cầu front_page_index chẵn cho CNC."
            )

        if (
            duplex_mode == "duplex"
            and part.back_page_index != part.front_page_index + 1
        ):
            raise ImpositionRenderBundleError(
                f"Part {part.part_id} yêu cầu Back liền sau Front cho CNC duplex."
            )
    if (
        not isinstance(part.die_dimensions_mm, (list, tuple))
        or len(part.die_dimensions_mm) != 2
    ):
        raise ImpositionRenderBundleError(
            f"Part {part.part_id} yêu cầu die_dimensions_mm có đúng rộng/cao."
        )
    die_width_mm, die_height_mm = part.die_dimensions_mm
    _positive(die_width_mm, f"Part {part.part_id} die_dimensions_mm.width")
    _positive(die_height_mm, f"Part {part.part_id} die_dimensions_mm.height")
    return {
        "partId": part.part_id,
        "packingFootprint": part.packing_footprint.to_canonical_dict(),
        "cutContour": part.cut_contour.to_canonical_dict(),
        "artworkClipPath": part.artwork_clip_path.to_canonical_dict(),
        "dieDimensionsMm": {
            "width": float(die_width_mm),
            "height": float(die_height_mm),
        },
        "source": source_descriptor(part.source_pin),
        "pages": {
            "front": _binding(part.source_pin, part.front_page_index, side="front"),
            "back": None if part.back_page_index is None else _binding(part.source_pin, part.back_page_index, side="back"),
            # Cut dùng cùng geometry canonical của Front, chỉ đổi page binding.
            "cut": _binding(part.source_pin, part.cut_page_index, side="cut"),
        },
    }


def _deduplicated_source_pins(parts: Sequence[ImpositionRenderPartSpec]) -> tuple[PinnedNestingSource, ...]:
    pins: dict[str, PinnedNestingSource] = {}
    for part in parts:
        pin = part.source_pin
        previous = pins.setdefault(pin.locator_id, pin)
        if previous != pin:
            raise ImpositionRenderBundleError(
                f"locatorId {pin.locator_id} trỏ tới pin khác snapshot/lease/metadata."
            )
    return tuple(
        pins[key] for key in sorted(pins, key=lambda item: item.encode("utf-8"))
    )


def build_imposition_render_bundle_v2(context: ImpositionRenderContext, parts: Sequence[ImpositionRenderPartSpec]) -> BuiltImpositionRenderBundle:
    """Dựng snapshot V2 từ source pin và context server-owned."""
    if not isinstance(context, ImpositionRenderContext):
        raise ImpositionRenderBundleError("context phải là ImpositionRenderContext.")
    if not isinstance(parts, (list, tuple)) or not parts:
        raise ImpositionRenderBundleError("parts phải là mảng không rỗng.")
    if not all(isinstance(part, ImpositionRenderPartSpec) for part in parts):
        raise ImpositionRenderBundleError("Mọi part phải là ImpositionRenderPartSpec.")
    if context.tool not in {"sticker_imposer", "cnc_imposer"}:
        raise ImpositionRenderBundleError("tool không được hỗ trợ.")
    if context.task_mode not in {"step_repeat", "nup"}:
        raise ImpositionRenderBundleError("task_mode không được hỗ trợ.")
    if context.layout_intent not in {
        "autofill_single_sheet",
        "step_repeat_single_sheet",
        "quantity_fulfillment",
    }:
        raise ImpositionRenderBundleError("layout_intent không được hỗ trợ.")
    if context.task_mode == "step_repeat" and len(parts) != 1:
        raise ImpositionRenderBundleError("step_repeat yêu cầu đúng một part.")
    if len({part.part_id for part in parts}) != len(parts):
        raise ImpositionRenderBundleError("part_id không được trùng.")
    _positive(context.sheet_width_mm, "sheet_width_mm")
    _positive(context.sheet_height_mm, "sheet_height_mm")
    duplex, back_frame = _duplex(context)
    marks = _marks(context)
    if context.duplex_registration and (
        context.tool != "cnc_imposer" or context.duplex_mode != "duplex"
    ):
        raise ImpositionRenderBundleError(
            "duplex_registration chỉ hợp lệ cho CNC hai mặt."
        )
    if context.tool == "sticker_imposer":
        output_sides = ["front", "cut"] if marks["cut"]["separatePage"] else ["front"]
    else:
        output_sides = ["front", "back", "cut"] if context.duplex_mode == "duplex" else ["front", "cut"]
    ordered_parts = sorted(parts, key=lambda part: part.part_id.encode("utf-8"))
    raw_bundle = {
        "schemaVersion": 2,
        "flow": {"tool": context.tool, "taskMode": context.task_mode, "layoutIntent": context.layout_intent},
        "outputSides": output_sides,
        "duplex": duplex,
        "marks": marks,
        "sheetFrames": {"front": list(_IDENTITY_AFFINE), "back": back_frame, "cut": list(_IDENTITY_AFFINE)},
        "renderer": _renderer(context.tool),
        "cutStyle": _cut_style(context),
        "artifactOptions": _artifact_options(context),
        "parts": [
            _bundle_part(
                part,
                tool=context.tool,
                duplex_mode=context.duplex_mode,
            )
            for part in ordered_parts
        ],
    }
    return BuiltImpositionRenderBundle(canonical_bytes=canonical_json_bytes(raw_bundle), source_pins=_deduplicated_source_pins(ordered_parts))
