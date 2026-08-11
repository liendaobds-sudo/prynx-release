"""Hợp đồng API cho công cụ Tách tem từ ảnh."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator


StickerSheetModel = Literal["birefnet-lite", "birefnet-full", "isnet"]
StickerShadowCleanup = Literal["off", "auto"]
StickerSourceKind = Literal["pdf", "raster"]
StickerBoundarySource = Literal[
    "existing-cut",
    "vector",
    "alpha",
    "simple-bg",
    "ai",
    "manual",
]
StickerCutMode = Literal["original", "alpha", "bleed", "none"]
StickerCornerStyle = Literal["preserve", "round", "miter"]
StickerBleedColorType = Literal["auto", "image", "trajectory", "inpaint", "solid"]
StickerShapeMode = Literal["contour", "auto_safe"]
CmykChannel = Annotated[float, Field(ge=0.0, le=100.0)]


class StickerSourcePageResponse(BaseModel):
    page_number: int = Field(ge=1)
    width_mm: float | None = Field(default=None, gt=0.0)
    height_mm: float | None = Field(default=None, gt=0.0)
    has_existing_cut: bool
    has_vector: bool
    has_raster: bool
    has_alpha: bool
    cut_contour_count: int = Field(ge=0)


class StickerSourceInspectResponse(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    stage: Literal["inspected"]
    original_name: str
    source_kind: StickerSourceKind
    mime_type: str
    boundary_source: StickerBoundarySource
    strategy_confidence: float = Field(ge=0.0, le=1.0)
    needs_review: bool
    page_count: int = Field(ge=1)
    source_width_px: int | None = Field(default=None, gt=0)
    source_height_px: int | None = Field(default=None, gt=0)
    dpi: tuple[float, float] | None = None
    physical_width_mm: float | None = Field(default=None, gt=0.0)
    physical_height_mm: float | None = Field(default=None, gt=0.0)
    preview_width_px: int = Field(gt=0)
    preview_height_px: int = Field(gt=0)
    has_existing_cut: bool
    has_vector: bool
    has_raster: bool
    has_alpha: bool
    cut_contour_count: int = Field(ge=0)
    pages: list[StickerSourcePageResponse]
    warnings: list[str]
    preview_url: str


class StickerSheetInstanceResponse(BaseModel):
    id: int = Field(ge=1)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    area_px: int = Field(gt=0)
    confidence: float = Field(ge=0.0, le=1.0)
    uncertain_ratio: float = Field(ge=0.0, le=1.0)


class StickerSourceDetectRequest(BaseModel):
    strategy: Literal[
        "auto",
        "existing-cut",
        "vector",
        "alpha",
        "simple-bg",
        "ai",
    ] = "auto"
    model: StickerSheetModel = "birefnet-lite"
    alpha_threshold: int = Field(default=128, ge=1, le=254)
    page_number: int = Field(default=1, ge=1)


class StickerSourceRefineRequest(BaseModel):
    # UIUX (audit 2026-08-09 §AI-PREVIEW.1): V1 chỉ cho siết biên từ ngưỡng
    # baseline 128; hạ thấp hơn có thể đưa bóng Alpha thấp ngoài candidate trở lại.
    alpha_threshold: int = Field(default=128, ge=128, le=176)
    shadow_cleanup: StickerShadowCleanup = "auto"
    base_revision: int = Field(ge=1)
    page_number: int = Field(default=1, ge=1)


class StickerSourceDetectResponse(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    stage: Literal["mask-review"]
    original_name: str
    source_kind: StickerSourceKind
    boundary_source: StickerBoundarySource
    strategy_confidence: float = Field(ge=0.0, le=1.0)
    needs_review: bool
    page_count: int = Field(ge=1)
    source_page: int = Field(ge=1)
    original_width_px: int = Field(gt=0)
    original_height_px: int = Field(gt=0)
    analysis_width_px: int = Field(gt=0)
    analysis_height_px: int = Field(gt=0)
    preview_width_px: int = Field(gt=0)
    preview_height_px: int = Field(gt=0)
    dpi: tuple[float, float] | None = None
    model: StickerSheetModel
    model_seconds: float = Field(ge=0.0)
    postprocess_seconds: float = Field(ge=0.0)
    refine_seconds: float | None = Field(default=None, ge=0.0)
    mask_revision: int = Field(default=1, ge=1)
    refinement_available: bool = False
    alpha_threshold: int = Field(default=128, ge=1, le=254)
    shadow_cleanup: StickerShadowCleanup = "auto"
    instances: list[StickerSheetInstanceResponse]
    warnings: list[str]
    vector_geometry_ref: dict[str, object] | None = None
    preview_url: str
    labels_url: str
    uncertainty_url: str


class StickerSourceConfirmRequest(BaseModel):
    page_number: int = Field(default=1, ge=1)


class StickerSourceConfirmResponse(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    stage: Literal["mask-ready"]
    mask_confirmed: bool
    source_page: int = Field(ge=1)


class StickerSheetAnalyzeResponse(BaseModel):
    session_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    original_name: str
    original_width_px: int = Field(gt=0)
    original_height_px: int = Field(gt=0)
    analysis_width_px: int = Field(gt=0)
    analysis_height_px: int = Field(gt=0)
    preview_width_px: int = Field(gt=0)
    preview_height_px: int = Field(gt=0)
    dpi: tuple[float, float] | None = None
    model: StickerSheetModel
    model_seconds: float = Field(ge=0.0)
    postprocess_seconds: float = Field(ge=0.0)
    instances: list[StickerSheetInstanceResponse]
    warnings: list[str]
    preview_url: str
    labels_url: str
    uncertainty_url: str


class StickerSheetWarmupResponse(BaseModel):
    ok: bool
    model: StickerSheetModel


class StickerSheetCloseResponse(BaseModel):
    closed: bool


class StickerSheetPoint(BaseModel):
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class StickerSheetStrokeEdit(BaseModel):
    kind: Literal["stroke"]
    id: str = Field(min_length=1, max_length=80)
    tool: Literal["erase", "restore"]
    instance_id: int = Field(ge=1)
    radius: float = Field(ge=0.002, le=0.08)
    points: list[StickerSheetPoint] = Field(min_length=1, max_length=10000)


class StickerSheetMergeEdit(BaseModel):
    kind: Literal["merge"]
    id: str = Field(min_length=1, max_length=80)
    source_id: int = Field(ge=1)
    target_id: int = Field(ge=1)

    @model_validator(mode="after")
    def different_instances(self) -> "StickerSheetMergeEdit":
        if self.source_id == self.target_id:
            raise ValueError("Tem nguồn và tem đích phải khác nhau")
        return self


StickerSheetEdit = Annotated[
    StickerSheetStrokeEdit | StickerSheetMergeEdit,
    Field(discriminator="kind"),
]


class StickerSheetPageExportRequest(BaseModel):
    source_page: int = Field(ge=1)
    expected_revision: int = Field(ge=1)
    edits: list[StickerSheetEdit] = Field(default_factory=list, max_length=2000)
    dpi: float | None = Field(default=None, ge=36.0, le=2400.0)
    dpi_y: float | None = Field(default=None, ge=36.0, le=2400.0)
    cutline_smoothness: float = Field(default=50.0, ge=0.0, le=100.0)
    cutline_fidelity: float = Field(default=50.0, ge=0.0, le=100.0)
    curve_tension: float = Field(default=50.0, ge=0.0, le=100.0)
    min_detail_area_mm2: float = Field(default=1.0, ge=0.0, le=25.0)


class StickerCutlinePreviewRequest(BaseModel):
    base_revision: int = Field(ge=1)
    page_number: int = Field(default=1, ge=1)
    edits: list[StickerSheetEdit] = Field(default_factory=list, max_length=2000)
    dpi: float = Field(default=300.0, ge=36.0, le=2400.0)
    dpi_y: float | None = Field(default=None, ge=36.0, le=2400.0)
    offset_mm: float = Field(default=0.0, ge=-10.0, le=10.0)
    bleed_mm: float = Field(default=0.0, ge=0.0, le=10.0)
    cut_mode: StickerCutMode = "original"
    corner_style: StickerCornerStyle = "preserve"
    fill_holes: bool = True
    cutline_smoothness: float = Field(default=50.0, ge=0.0, le=100.0)
    cutline_fidelity: float = Field(default=50.0, ge=0.0, le=100.0)
    curve_tension: float = Field(default=50.0, ge=0.0, le=100.0)
    min_detail_area_mm2: float = Field(default=1.0, ge=0.0, le=25.0)


class StickerCutlineQualityResponse(BaseModel):
    """Số đo quỹ đạo thật sau fitter/fallback, không suy từ vị trí thanh kéo."""

    machine_safe: bool = True
    segment_count: int = Field(default=0, ge=0)
    short_segment_count: int = Field(default=0, ge=0)
    disconnected_join_count: int = Field(default=0, ge=0)
    unprotected_join_count: int = Field(default=0, ge=0)
    protected_corner_count: int = Field(default=0, ge=0)
    dropped_component_count: int = Field(default=0, ge=0)
    minimum_segment_length_mm: float | None = Field(default=None, ge=0.0)
    maximum_join_angle_degrees: float | None = Field(default=None, ge=0.0, le=180.0)
    effective_deviation_mm: float | None = Field(default=None, ge=0.0)
    fit_mode: str = "unknown"


class StickerCutlinePreviewPathResponse(BaseModel):
    instance_id: int = Field(ge=1)
    d: str
    segment_count: int = Field(ge=0)
    quality: StickerCutlineQualityResponse | None = None


class StickerCutlinePreviewResponse(BaseModel):
    page_number: int = Field(ge=1)
    mask_revision: int = Field(ge=1)
    preview_width_px: int = Field(gt=0)
    preview_height_px: int = Field(gt=0)
    paths: list[StickerCutlinePreviewPathResponse]
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    segment_count: int = Field(ge=0)
    quality: StickerCutlineQualityResponse | None = None


class StickerSheetExportRequest(BaseModel):
    edits: list[StickerSheetEdit] = Field(default_factory=list, max_length=2000)
    pages: list[StickerSheetPageExportRequest] = Field(default_factory=list, max_length=2000)
    page_order: list[int] = Field(default_factory=list, max_length=10000)
    dpi: float = Field(default=300.0, ge=36.0, le=2400.0)
    dpi_y: float | None = Field(default=None, ge=36.0, le=2400.0)
    cutline_smoothness: float = Field(default=50.0, ge=0.0, le=100.0)
    cutline_fidelity: float = Field(default=50.0, ge=0.0, le=100.0)
    curve_tension: float = Field(default=50.0, ge=0.0, le=100.0)
    min_detail_area_mm2: float = Field(default=1.0, ge=0.0, le=25.0)
    offset_mm: float = Field(default=0.0, ge=-10.0, le=10.0)
    bleed_mm: float = Field(default=2.0, ge=0.0, le=10.0)
    cut_mode: StickerCutMode = "original"
    corner_style: StickerCornerStyle = "preserve"
    fill_holes: bool = True
    crop_to_sticker: bool = True
    bleed_color_type: StickerBleedColorType = "auto"
    solid_bleed_cmyk: tuple[
        CmykChannel,
        CmykChannel,
        CmykChannel,
        CmykChannel,
    ] = (0.0, 0.0, 0.0, 0.0)
    shape_mode: StickerShapeMode = "contour"
    draw_cut_contour: bool = True
    # QUALITY (audit 2026-08-08 §UNIFIED.7): nhánh này chỉ được dùng khi mọi
    # thiết lập hình học còn nguyên và mask chưa bị sửa; worker kiểm tra lại.
    preserve_existing_cut: bool = True
    output_format: Literal["pdf", "png_zip"] = "pdf"

    @model_validator(mode="after")
    def validate_page_contract(self) -> "StickerSheetExportRequest":
        if not self.pages:
            if self.page_order:
                raise ValueError("page_order chỉ hợp lệ khi có hợp đồng export theo trang")
            return self
        page_numbers = [page.source_page for page in self.pages]
        if len(page_numbers) != len(set(page_numbers)):
            raise ValueError("Mỗi trang nguồn chỉ được khai báo thiết lập export một lần")
        order = self.page_order or page_numbers
        unknown = sorted(set(order) - set(page_numbers))
        if unknown:
            raise ValueError(
                "Thứ tự xuất tham chiếu trang chưa có mask: "
                + ", ".join(str(page) for page in unknown)
            )
        return self
