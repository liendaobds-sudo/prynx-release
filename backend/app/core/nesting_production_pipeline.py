"""Điều phối một lượt nesting theo đường bế từ thiết lập job Tem bế/CNC.

NEST (audit 2026-08-28 §A4b-1). Đây là **mắt xích còn thiếu** giữa thiết lập job
và chuỗi đã có sẵn: pin nguồn → resolve contour → dựng bundle → solve một lần →
render artifact → commit manifest. Mỗi bước bên dưới đều là một lời gọi vào module
đã có test riêng; module này không tự tính hình học và không tự solve.

## Bất biến

1. **Solve đúng một lần.** ``solve_production_nesting`` được gọi một lần; writer
   đọc lại manifest đã chốt và **không** solve. Preview và export dùng cùng
   ``manifestId``/``layoutFingerprint`` vì cùng lấy từ một session.
2. **Không job lồng.** Không gọi ``/mixed-nesting/jobs``. Job cha (N-Up/CNC) đã
   giữ suất scheduler; ở đây chỉ gọi service/kernel nội bộ.
3. **Commit sau artifact.** ``persist_production_nesting`` chỉ chạy khi writer đã
   đóng file thành công. Hủy trước đó không được để lại manifest cuối.
4. **Miền xoay là server-owned.** Chặng A khoá cardinal; mở góc liên tục phải
   truyền tường minh ``allow_continuous_rotation`` sau khi Cổng Chặng B đóng.
5. **gapX/gapY không bị nén.** UI gap đi vào ``clearance.partToPart`` theo đúng
   hai trục (quyết định cổng Chặng 0 §7.3), không quy về một số vô hướng.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Sequence

from app.core.nesting_imposition_bundle import (
    ImpositionArtifactOptions,
    ImpositionCutSpec,
    ImpositionCutStyleSpec,
    ImpositionPontSpec,
    ImpositionReportSpec,
    ImpositionRenderContext,
    ImpositionRenderPartSpec,
    ImpositionTrimSpec,
    build_imposition_render_bundle_v2,
)
from app.core.nesting_manifest_store import NestingManifestStore, StoredNestingManifest
from app.core.nesting_production_orchestrator import (
    ProductionCommitFence,
    ProductionNestingInput,
    SolvedProductionNesting,
    persist_production_nesting,
    solve_production_nesting,
)
from app.core.nesting_source_geometry import (
    ResolvedSourceGeometry,
    derive_packing_footprint,
    resolve_cnc_source_geometry,
    resolve_sticker_source_geometry,
)
from app.core.nesting_source_pin import PinnedNestingSource, discard_source_pin, pin_pdf_path
from app.workers.nesting_imposition_render import (
    ProductionRenderResult,
    render_production_nesting,
)


logger = logging.getLogger(__name__)

_MM_PER_PT = 25.4 / 72.0

RenderTool = Literal["sticker_imposer", "cnc_imposer"]
LayoutIntent = Literal[
    "autofill_single_sheet",
    "step_repeat_single_sheet",
    "quantity_fulfillment",
]
_AUTOFILL_LAYOUT_INTENTS = frozenset(
    {"autofill_single_sheet", "step_repeat_single_sheet"}
)
LayoutAlignment = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]
GroupingIntent = Literal["free_gang", "maximize_area"]


class NestingProductionPipelineError(ValueError):
    """Thiết lập job không đủ để chạy nesting theo đường bế."""


@dataclass(frozen=True, slots=True)
class AxisGapMm:
    """Khoảng hở theo hai trục của TỜ. Không nén về một số vô hướng."""

    x_mm: float = 0.0
    y_mm: float = 0.0

    def to_contract(self) -> dict[str, float]:
        return {"xMm": float(self.x_mm), "yMm": float(self.y_mm)}


@dataclass(frozen=True, slots=True)
class AxisAlignedBoundsSpec:
    """Hình chữ nhật server-owned trong hệ tờ, mm, gốc trái-dưới."""

    min_x_mm: float
    min_y_mm: float
    max_x_mm: float
    max_y_mm: float

    def to_contract(self) -> dict[str, float]:
        return {
            "minXmm": float(self.min_x_mm),
            "minYmm": float(self.min_y_mm),
            "maxXmm": float(self.max_x_mm),
            "maxYmm": float(self.max_y_mm),
        }


@dataclass(frozen=True, slots=True)
class PartPlacementZoneSpec:
    """Vùng đặt gắn bằng ``part_id``; không phụ thuộc thứ tự mảng parts."""

    part_id: str
    bounds: AxisAlignedBoundsSpec

    def to_contract(self) -> dict[str, Any]:
        return {"partId": self.part_id, "bounds": self.bounds.to_contract()}


@dataclass(frozen=True, slots=True)
class JobPartInput:
    """Một mẫu trong job: nguồn PDF đã có trên đĩa + trang + số lượng cần."""

    part_id: str
    source_path: str | Path
    page_index: int = 0
    quantity: int | None = None
    #: Shape server-side giữ SSOT ``trim`` cho report; CNC dùng thêm page contour
    #: để resolver không detect lại hình xếp/cắt.
    detected_shape: Any | None = None
    #: Chỉ CNC duplex.
    back_page_index: int | None = None


@dataclass(frozen=True, slots=True)
class ProductionNestingJobInput:
    """Toàn bộ thiết lập server-owned cho một lượt nesting production."""

    manifest_id: str
    tool: RenderTool
    layout_intent: LayoutIntent
    sheet_width_mm: float
    sheet_height_mm: float
    parts: tuple[JobPartInput, ...]
    margin_mm: Mapping[str, float] = field(
        default_factory=lambda: {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}
    )
    max_sheets: int = 1
    seed: int = 0
    profile: Literal["fast", "balanced", "tight"] = "balanced"
    time_budget_ms: int | None = None
    request_revision: int = 1
    align: LayoutAlignment = "center"
    grouping_intent: GroupingIntent = "free_gang"
    placement_zones: tuple[PartPlacementZoneSpec, ...] = ()
    #: gapX/gapY của UI → clearance.partToPart.
    part_gap: AxisGapMm = field(default_factory=AxisGapMm)
    #: Khoảng hở tới mép vùng in. Mặc định 0: lề tờ đã trừ vào usable area rồi,
    #: cộng lại lần nữa là double-count.
    sheet_edge_gap: AxisGapMm = field(default_factory=AxisGapMm)
    #: Khoảng hở tới boong/nhíp/dấu canh. Mặc định bằng part_gap nếu không khai.
    obstacle_gap: AxisGapMm | None = None
    fixed_obstacles: tuple[Mapping[str, Any], ...] = ()
    duplex_mode: Literal["simplex", "duplex"] = "simplex"
    flip_edge: Literal["none", "long", "short"] = "none"
    duplex_registration: bool = False
    trim: ImpositionTrimSpec = field(default_factory=ImpositionTrimSpec)
    pont: ImpositionPontSpec = field(default_factory=ImpositionPontSpec)
    cut: ImpositionCutSpec = field(default_factory=ImpositionCutSpec)
    cut_style: ImpositionCutStyleSpec = field(default_factory=ImpositionCutStyleSpec)
    artifact_options: ImpositionArtifactOptions = field(
        default_factory=ImpositionArtifactOptions
    )


@dataclass(frozen=True, slots=True)
class ProductionNestingSession:
    """Một lượt solve đã chốt. Mọi artifact phải render TỪ ĐÂY.

    NEST (audit 2026-08-28 §A4b-1): tách session khỏi render là bắt buộc, không
    phải tiện lợi. Mỗi lượt ``pin_pdf_path`` sinh **locator mới**, mà locator nằm
    trong RenderBundle ⇒ chạy pipeline hai lần cho hai ``renderBundleHash`` khác
    nhau ⇒ hai ``layoutFingerprint`` khác nhau. Nếu preview và export mỗi bên gọi
    pipeline riêng thì chúng **không thể** cùng manifest — đúng điều Cổng Chặng A
    cấm. Vì vậy: solve một lần, render nhiều lần từ cùng session.
    """

    solved: SolvedProductionNesting
    source_pins: tuple[PinnedNestingSource, ...]

    @property
    def manifest_id(self) -> str:
        return str(self.solved.manifest.get("manifestId"))

    @property
    def layout_fingerprint(self) -> str:
        return self.solved.production_request.layout_fingerprint

    @property
    def source_paths(self) -> dict[str, Any]:
        return {pin.locator_id: pin.snapshot_path for pin in self.source_pins}


@dataclass(frozen=True, slots=True)
class ProductionNestingJobResult:
    """Kết quả một lượt: session đã solve, artifact đã ghi, manifest đã commit."""

    session: ProductionNestingSession
    render: ProductionRenderResult
    stored: StoredNestingManifest | None

    @property
    def solved(self) -> SolvedProductionNesting:
        return self.session.solved

    @property
    def source_pins(self) -> tuple[PinnedNestingSource, ...]:
        return self.session.source_pins

    @property
    def manifest_id(self) -> str:
        return self.render.manifest_id

    @property
    def layout_fingerprint(self) -> str:
        return self.render.layout_fingerprint


def _error(message: str) -> NestingProductionPipelineError:
    return NestingProductionPipelineError(message)


def _validate(value: ProductionNestingJobInput) -> None:
    if not isinstance(value, ProductionNestingJobInput):
        raise _error("value phải là ProductionNestingJobInput.")
    if value.tool not in {"sticker_imposer", "cnc_imposer"}:
        raise _error("tool không được hỗ trợ.")
    if value.layout_intent not in {
        "autofill_single_sheet",
        "step_repeat_single_sheet",
        "quantity_fulfillment",
    }:
        raise _error("layout_intent không được hỗ trợ.")
    if value.align not in {
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
        raise _error("align không được hỗ trợ.")
    if not value.parts:
        raise _error("Job phải có ít nhất một mẫu.")
    part_ids = {part.part_id for part in value.parts}
    if len(part_ids) != len(value.parts):
        raise _error("part_id bị trùng trong job.")

    if value.grouping_intent not in {"free_gang", "maximize_area"}:
        raise _error("grouping_intent không được hỗ trợ.")
    if value.grouping_intent == "free_gang":
        if value.placement_zones:
            raise _error("Xếp tự do không được mang placement_zones.")
    else:
        if value.layout_intent == "step_repeat_single_sheet":
            raise _error("Bình trang một mẫu không dùng Chia đều diện tích.")
        try:
            usable_min_x = float(value.margin_mm.get("left", 0.0))
            usable_min_y = float(value.margin_mm.get("bottom", 0.0))
            usable_max_x = float(value.sheet_width_mm) - float(
                value.margin_mm.get("right", 0.0)
            )
            usable_max_y = float(value.sheet_height_mm) - float(
                value.margin_mm.get("top", 0.0)
            )
        except (TypeError, ValueError, OverflowError) as exc:
            raise _error("Khổ tờ hoặc lề không hợp lệ để kiểm placement_zones.") from exc
        if not all(
            math.isfinite(number)
            for number in (usable_min_x, usable_min_y, usable_max_x, usable_max_y)
        ):
            raise _error("Khổ tờ hoặc lề phải là số hữu hạn.")

        seen: set[str] = set()
        for index, zone in enumerate(value.placement_zones):
            if not isinstance(zone, PartPlacementZoneSpec):
                raise _error(f"placement_zones[{index}] không đúng kiểu.")
            if zone.part_id not in part_ids:
                raise _error(
                    f"placement_zones[{index}].part_id không có trong parts."
                )
            if zone.part_id in seen:
                raise _error(f"placement_zones[{index}].part_id bị trùng.")
            seen.add(zone.part_id)
            if not isinstance(zone.bounds, AxisAlignedBoundsSpec):
                raise _error(f"placement_zones[{index}].bounds không đúng kiểu.")
            bounds = zone.bounds
            coordinates = (
                bounds.min_x_mm,
                bounds.min_y_mm,
                bounds.max_x_mm,
                bounds.max_y_mm,
            )
            if any(
                isinstance(number, bool) or not isinstance(number, (int, float))
                for number in coordinates
            ):
                raise _error(f"placement_zones[{index}].bounds phải hữu hạn.")
            try:
                min_x, min_y, max_x, max_y = (
                    float(number) for number in coordinates
                )
            except (TypeError, ValueError, OverflowError) as exc:
                raise _error(
                    f"placement_zones[{index}].bounds phải hữu hạn."
                ) from exc
            if not all(math.isfinite(number) for number in (min_x, min_y, max_x, max_y)):
                raise _error(f"placement_zones[{index}].bounds phải hữu hạn.")
            tolerance_mm = 1e-6
            if max_x - min_x <= tolerance_mm or max_y - min_y <= tolerance_mm:
                raise _error(
                    f"placement_zones[{index}].bounds phải có diện tích dương."
                )
            if (
                min_x < usable_min_x - tolerance_mm
                or min_y < usable_min_y - tolerance_mm
                or max_x > usable_max_x + tolerance_mm
                or max_y > usable_max_y + tolerance_mm
            ):
                raise _error(
                    f"placement_zones[{index}].bounds nằm ngoài vùng dùng được."
                )
        missing = part_ids.difference(seen)
        if missing:
            raise _error(
                "placement_zones thiếu vùng cho part_id: "
                + ", ".join(sorted(missing))
                + "."
            )

    if value.layout_intent in _AUTOFILL_LAYOUT_INTENTS:
        if value.max_sheets != 1:
            raise _error("Bình tự lấp đầy một tờ yêu cầu max_sheets = 1.")
        if any(part.quantity is not None for part in value.parts):
            raise _error("Bình tự lấp đầy một tờ không nhận quantity.")
        if value.layout_intent == "step_repeat_single_sheet" and len(value.parts) != 1:
            raise _error("Bình trang yêu cầu đúng một mẫu trong mỗi job.")
    else:
        for part in value.parts:
            if (
                part.quantity is None
                or isinstance(part.quantity, bool)
                or not isinstance(part.quantity, int)
                or part.quantity <= 0
            ):
                raise _error(
                    f"Mẫu {part.part_id!r} phải có quantity nguyên dương cho "
                    "quantity_fulfillment."
                )
    if value.duplex_mode == "simplex" and value.flip_edge != "none":
        raise _error("Simplex yêu cầu flip_edge='none'.")
    if value.duplex_mode == "duplex" and value.tool != "cnc_imposer":
        raise _error("Chỉ Bình CNC hỗ trợ duplex.")


def _die_dimensions_mm(
    part: JobPartInput,
    geometry: ResolvedSourceGeometry,
    *,
    tool: RenderTool,
) -> tuple[float, float]:
    """Kích thước thành phẩm authoritative, mm, cho metadata artifact.

    Cả Tem bế và CNC ưu tiên ``DetectedShape.trim`` mà viewer đã hiển thị.
    ``cutContour`` dùng một phép hợp/lấy mẫu khác để xếp và vẽ dao nên bbox của
    nó không phải SSOT kích thước. Fallback contour chỉ giữ tương thích cho caller
    nội bộ cũ của lane Tem bế chưa truyền shape; entrypoint production luôn truyền.
    """

    xs = [point[0] for point in geometry.polygon.outer]
    ys = [point[1] for point in geometry.polygon.outer]
    contour_dimensions = (max(xs) - min(xs), max(ys) - min(ys))

    trim = getattr(part.detected_shape, "trim", None)
    uses_detector_trim = trim is not None
    if uses_detector_trim:
        raw_dimensions = (getattr(trim, "w", None), getattr(trim, "h", None))
    else:
        if tool == "cnc_imposer":
            raw_dimensions = (None, None)
        else:
            raw_dimensions = contour_dimensions

    try:
        width, height = (float(value) for value in raw_dimensions)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _error(
            f"Mẫu {part.part_id!r}: không đọc được kích thước khuôn authoritative."
        ) from exc
    if uses_detector_trim:
        width *= _MM_PER_PT
        height *= _MM_PER_PT
    if not all(math.isfinite(value) and value > 0.0 for value in (width, height)):
        raise _error(
            f"Mẫu {part.part_id!r}: kích thước khuôn phải là số hữu hạn dương."
        )

    # SEC (audit 2026-09-05 §LOG.06): payload hình học chỉ dùng khi
    # chẩn đoán dev, không đẩy lên warning production.
    logger.debug(
        "[DIM-DIE-TRACE] stage=pipeline_dimensions tool=%s part_id=%s "
        "page_index=%s source=%s raw=%r contour_bbox_mm=(%.6f, %.6f) "
        "selected_mm=(%.6f, %.6f)",
        tool,
        part.part_id,
        part.page_index,
        "detector_trim" if uses_detector_trim else "contour_fallback",
        raw_dimensions,
        contour_dimensions[0],
        contour_dimensions[1],
        width,
        height,
    )
    return width, height


def _resolve_geometry(
    part: JobPartInput, pin: PinnedNestingSource, *, tool: RenderTool
) -> ResolvedSourceGeometry:
    """Lấy contour bế từ chính snapshot đã pin, không detect lại trên file gốc."""

    if tool == "cnc_imposer":
        if part.detected_shape is None:
            raise _error(
                f"Mẫu {part.part_id!r}: Bình CNC phải truyền detected_shape đã dò "
                "trước, resolver không được dò lại."
            )
        return resolve_cnc_source_geometry(pin, part.page_index, part.detected_shape)
    return resolve_sticker_source_geometry(pin, part.page_index)


def _source_pin_key(source_path: str | Path) -> str:
    """Identity nội bộ để một PDF nhiều trang chỉ snapshot đúng một lần.

    Chỉ dedup cùng đường dẫn Windows canonical trong **một job**. Không dedup theo hash
    sau khi đọc vì như vậy vẫn trả đủ chi phí copy/inspect; cũng không chia cache giữa job
    vì lease và hàng rào TOCTOU phải thuộc đúng session production hiện tại.
    """

    try:
        return os.path.normcase(os.path.abspath(os.fspath(source_path)))
    except (TypeError, ValueError, OSError) as exc:
        raise _error("Đường dẫn PDF nguồn cần pin không hợp lệ.") from exc


def _public_request(
    value: ProductionNestingJobInput,
    geometry: Mapping[str, ResolvedSourceGeometry],
    footprints: Mapping[str, Any],
) -> dict[str, Any]:
    """Payload công khai của engine. Hình học lấy từ contour đã resolve."""

    parts: list[dict[str, Any]] = []
    for part in value.parts:
        # Hình gửi solver PHẢI trùng khít `packingFootprint` của bundle — adapter
        # cưỡng chế ("packingFootprint không khớp exact outer/holes đã gửi solver").
        # Vì vậy footprint được dựng đúng MỘT lần rồi dùng cho cả hai chỗ.
        polygon = footprints[part.part_id]
        item: dict[str, Any] = {
            "partId": part.part_id,
            "outer": [list(point) for point in polygon.outer],
            "holes": [[list(point) for point in hole] for hole in polygon.holes],
        }
        if value.layout_intent == "quantity_fulfillment":
            item["quantity"] = int(part.quantity or 0)
        parts.append(item)

    from app.core.mixed_nesting_service import MIXED_NESTING_PROTOCOL_VERSION

    request: dict[str, Any] = {
        "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
        "seed": int(value.seed),
        "profile": value.profile,
        "sheet": {
            "widthMm": float(value.sheet_width_mm),
            "heightMm": float(value.sheet_height_mm),
            "marginMm": {
                key: float(value.margin_mm.get(key, 0.0))
                for key in ("left", "right", "top", "bottom")
            },
            "maxSheets": int(value.max_sheets),
        },
        # gapMm phải là 0 khi có productionContract; gap thật đi qua clearance.
        "gapMm": 0.0,
        "layoutIntent": value.layout_intent,
        "orientationPolicy": {
            # Client không quyết miền xoay; adapter bỏ qua trường này. Giữ ở đây
            # cho payload đủ hình dạng công khai.
            "defaultRotation": {"mode": "free"},
            "reflection": "forbidden",
        },
        "parts": parts,
    }
    if value.time_budget_ms is not None:
        request["timeBudgetMs"] = int(value.time_budget_ms)
    return request


def _clearance(value: ProductionNestingJobInput) -> dict[str, dict[str, float]]:
    obstacle = value.obstacle_gap if value.obstacle_gap is not None else value.part_gap
    return {
        "partToPart": value.part_gap.to_contract(),
        "partToSheetEdge": value.sheet_edge_gap.to_contract(),
        "partToObstacle": obstacle.to_contract(),
    }


def _render_context(value: ProductionNestingJobInput) -> ImpositionRenderContext:
    return ImpositionRenderContext(
        tool=value.tool,
        # S&R phải nằm trong bundle provenance; không suy lại từ số part ở writer.
        task_mode=(
            "step_repeat"
            if value.layout_intent == "step_repeat_single_sheet"
            else "nup"
        ),
        layout_intent=value.layout_intent,
        sheet_width_mm=float(value.sheet_width_mm),
        sheet_height_mm=float(value.sheet_height_mm),
        duplex_mode=value.duplex_mode,
        flip_edge=value.flip_edge,
        trim=value.trim,
        pont=value.pont,
        cut=value.cut,
        cut_style=value.cut_style,
        duplex_registration=value.duplex_registration,
        artifact_options=value.artifact_options,
    )


def solve_production_nesting_job(
    value: ProductionNestingJobInput,
    *,
    cancel_event: Any = None,
    progress_callback: Callable[[Mapping[str, Any]], None] | None = None,
    runtime_worker_grant_limit: int | None = None,
    runtime_worker_grant_request: Any = None,
) -> ProductionNestingSession:
    """Pin → geometry → bundle → solve. Gọi **đúng một lần** cho mỗi lượt bình.

    Preview và export sau đó cùng render từ session này. Không gọi lại hàm này
    cho preview: xem docstring của :class:`ProductionNestingSession`.

    **Cố ý KHÔNG có tham số ``allow_continuous_rotation``.** Cổng mở góc liên tục
    nằm ở ``build_production_request``, mà ``solve_production_nesting`` chưa phơi
    nó ra. Nhận một tham số rồi không truyền được xuống là tham số bị bỏ qua âm
    thầm — đúng lỗi đã sửa ở lô A2. Chặng A chạy cardinal theo mặc định của
    adapter; khi Cổng Chặng B đóng thì luồn tham số qua orchestrator trong một lô
    riêng, tường minh.
    """

    _validate(value)

    pins: dict[str, PinnedNestingSource] = {}
    pins_by_source: dict[str, PinnedNestingSource] = {}
    geometry: dict[str, ResolvedSourceGeometry] = {}
    try:
        for part in value.parts:
            # PERF (audit 2026-08-29 §NEST-PIN-DEDUP): một PDF 13 trang trước đây bị
            # copy + SHA-256 + inspect đủ 13 lần, rồi preflight lại 13 snapshot. Pin
            # một lần theo source path trong job; page binding vẫn tách riêng ở bundle.
            source_key = _source_pin_key(part.source_path)
            pin = pins_by_source.get(source_key)
            if pin is None:
                pin = pin_pdf_path(part.source_path)
                pins_by_source[source_key] = pin
            pins[part.part_id] = pin
            geometry[part.part_id] = _resolve_geometry(part, pin, tool=value.tool)

        footprints = {
            part.part_id: derive_packing_footprint(geometry[part.part_id].polygon)
            for part in value.parts
        }

        part_specs: list[ImpositionRenderPartSpec] = []
        for part in value.parts:
            polygon = geometry[part.part_id].polygon
            part_specs.append(
                ImpositionRenderPartSpec(
                    part_id=part.part_id,
                    source_pin=pins[part.part_id],
                    # PERF (audit 2026-08-28 §NEST-FOOTPRINT): footprint đóng gói là
                    # đường bế đã phình 0,2mm và giảm đỉnh. KHÔNG phải bbox — mất
                    # contour thật là mất chính lý do dùng nesting theo đường bế; đây
                    # vẫn là hình thật, chỉ bớt đỉnh lõm vô nghĩa. Chi phí NFP tăng
                    # theo bình phương số mảnh lồi nên đây là khác biệt cả bậc.
                    # `cut_contour` giữ nguyên từng đỉnh: dao cắt đúng đường của file.
                    packing_footprint=footprints[part.part_id],
                    cut_contour=polygon,
                    artwork_clip_path=polygon,
                    die_dimensions_mm=_die_dimensions_mm(
                        part,
                        geometry[part.part_id],
                        tool=value.tool,
                    ),
                    front_page_index=part.page_index,
                    cut_page_index=part.page_index,
                    back_page_index=part.back_page_index,
                )
            )

        built = build_imposition_render_bundle_v2(_render_context(value), part_specs)
        production_input = ProductionNestingInput(
            manifest_id=value.manifest_id,
            request_revision=int(value.request_revision),
            public_request=_public_request(value, geometry, footprints),
            render_bundle=built.render_bundle,
            clearance=_clearance(value),
            fixed_obstacles=tuple(value.fixed_obstacles),
            source_pins=built.source_pins,
            alignment=value.align,
            grouping_intent=value.grouping_intent,
            placement_zones=tuple(
                zone.to_contract() for zone in value.placement_zones
            ),
        )
        if (
            runtime_worker_grant_limit is not None
            and runtime_worker_grant_request is not None
        ):
            raise ValueError("Chỉ được truyền một nguồn runtime worker grant.")

        # PERF (audit 2026-09-02 §PERF-NEST-12): claim tại owner solve, sau khi
        # PreviewSessionStore đã phân vai singleflight. Cache hit/follower không vào
        # hàm này nên không giữ quota; deadline native chỉ bắt đầu sau admission.
        if runtime_worker_grant_request is not None:
            cancel_check = (
                None
                if cancel_event is None
                else getattr(cancel_event, "is_set", None)
            )
            with runtime_worker_grant_request.claim(cancel_check) as worker_grant:
                solved = solve_production_nesting(
                    production_input,
                    cancel_event=cancel_event,
                    progress_callback=progress_callback,
                    runtime_worker_grant_limit=worker_grant,
                )
        # PERF (audit 2026-09-01 §SR13-WAVE): đường đơn không truyền keyword mới để
        # giữ nguyên fake/caller cũ; caller legacy có thể truyền int trực tiếp.
        elif runtime_worker_grant_limit is None:
            solved = solve_production_nesting(
                production_input,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
            )
        else:
            solved = solve_production_nesting(
                production_input,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
                runtime_worker_grant_limit=runtime_worker_grant_limit,
            )
        return ProductionNestingSession(
            solved=solved, source_pins=built.source_pins
        )
    except BaseException:
        # Hủy/lỗi giữa đường không được để lại pin provisional treo TTL.
        for pin in pins_by_source.values():
            try:
                discard_source_pin(pin)
            except Exception:  # pragma: no cover - dọn dẹp không được che lỗi gốc
                logger.debug("Không thu hồi được source pin nesting.", exc_info=True)
        raise


def render_production_nesting_session(
    session: ProductionNestingSession,
    *,
    output_path: str | Path,
    report_override: ImpositionReportSpec | None = None,
) -> ProductionRenderResult:
    """Ghi một artifact từ session đã solve. Không solve, không pin lại.

    Gọi được nhiều lần: preview và export là hai file từ **cùng** một session, nên
    tất yếu cùng ``manifestId``/``layoutFingerprint``.
    """

    if not isinstance(session, ProductionNestingSession):
        raise _error("session phải là ProductionNestingSession.")
    production = session.solved.production_request
    return render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=session.solved.manifest,
        source_paths=session.source_paths,
        output_path=output_path,
        report_override=report_override,
    )


def render_stored_production_nesting(
    stored: StoredNestingManifest,
    *,
    output_path: str | Path,
    report_override: ImpositionReportSpec | None = None,
) -> ProductionRenderResult:
    """Ghi artifact từ manifest ĐÃ CÔNG BỐ, không cần session và không solve.

    NEST (audit 2026-08-28 §A4b-6). Đây là mắt xích qua **ranh giới process**:
    ``_spawn_nup_process`` chạy engine trong ``multiprocessing.Process`` riêng, nên
    session trong RAM của process API không thể thấy được từ process con. Kho
    manifest thì nằm trên đĩa và đã lưu đủ mọi thứ để render:

    - ``manifest`` và ``production_request`` (engine request + render bundle);
    - ``resolved_sources``: locator → ``ResolvedPinnedSource`` có ``path`` thật,
      lấy qua lease đã promote sang final nên process nào cũng resolve được.

    Nhờ vậy process con render đúng layout mà process API đã solve, giữ bất biến
    preview ≡ output qua ranh giới process.
    """

    if not isinstance(stored, StoredNestingManifest):
        raise _error("stored phải là StoredNestingManifest.")
    production = stored.production_request
    return render_production_nesting(
        production_request={
            "engineRequest": production.engine_request,
            "renderBundle": production.render_bundle,
            "renderBundleHash": production.render_bundle_hash,
        },
        manifest=stored.manifest,
        source_paths={
            locator: resolved.path
            for locator, resolved in stored.resolved_sources.items()
        },
        output_path=output_path,
        report_override=report_override,
    )


def commit_production_nesting_session(
    session: ProductionNestingSession,
    *,
    store: NestingManifestStore | None = None,
    commit_fence: ProductionCommitFence | None = None,
) -> StoredNestingManifest:
    """Công bố manifest cuối. Chỉ gọi SAU khi artifact đã đóng thành công."""

    if not isinstance(session, ProductionNestingSession):
        raise _error("session phải là ProductionNestingSession.")
    return persist_production_nesting(
        session.solved, store=store, commit_fence=commit_fence
    )


def run_production_nesting_job(
    value: ProductionNestingJobInput,
    *,
    output_path: str | Path,
    store: NestingManifestStore | None = None,
    commit_fence: ProductionCommitFence | None = None,
    cancel_event: Any = None,
    progress_callback: Callable[[Mapping[str, Any]], None] | None = None,
    commit: bool = True,
) -> ProductionNestingJobResult:
    """Tiện lợi: solve một lần, render một artifact, rồi commit nếu được yêu cầu.

    Dùng khi chỉ cần đúng một file. Cần cả preview và export thì gọi
    :func:`solve_production_nesting_job` một lần rồi
    :func:`render_production_nesting_session` hai lần.
    """

    session = solve_production_nesting_job(
        value, cancel_event=cancel_event, progress_callback=progress_callback
    )
    render = render_production_nesting_session(session, output_path=output_path)
    stored: StoredNestingManifest | None = None
    if commit:
        # Commit CHỈ sau khi artifact đã đóng thành công.
        stored = commit_production_nesting_session(
            session, store=store, commit_fence=commit_fence
        )
    return ProductionNestingJobResult(session=session, render=render, stored=stored)
