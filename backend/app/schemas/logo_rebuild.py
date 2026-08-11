"""Hợp đồng API cho MVP thu gọn Phục hồi & Vector hóa Logo.

MVP chỉ mở hai chế độ đã có bằng chứng: đen trắng và màu dùng palette do
người dùng xác nhận. Auto-color chưa đạt cổng G1 nên không xuất hiện trong schema.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator


LogoRebuildMode = Literal["monochrome", "fixed_palette"]
LogoRebuildEngine = Literal["prynx_core", "vtracer"]


class NormalizedPoint(BaseModel):
    """Điểm chuẩn hóa theo kích thước ảnh, trong khoảng 0..1."""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class NormalizedCrop(BaseModel):
    """Vùng crop chuẩn hóa để project không phụ thuộc độ phân giải preview."""

    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    width: float = Field(gt=0.0, le=1.0)
    height: float = Field(gt=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_inside_source(self) -> "NormalizedCrop":
        if self.x + self.width > 1.0 or self.y + self.height > 1.0:
            raise ValueError("Vùng crop phải nằm hoàn toàn trong ảnh")
        if self.width < 0.01 or self.height < 0.01:
            raise ValueError("Vùng crop quá nhỏ để xử lý ổn định")
        return self


class LogoRebuildSettings(BaseModel):
    """Cấu hình đầu vào đã giới hạn theo phạm vi MVP được duyệt."""

    mode: LogoRebuildMode
    engine: LogoRebuildEngine = "prynx_core"
    palette: list[str] = Field(default_factory=list, max_length=12)
    background_color: str | None = None
    crop: NormalizedCrop | None = None
    perspective_points: list[NormalizedPoint] | None = None
    smoothing: float = Field(default=0.5, ge=0.0, le=1.0)
    despeckle_size_px: int = Field(
        default=4,
        ge=0,
        le=128,
        validation_alias=AliasChoices("despeckle_size_px", "despeckle_area_px"),
    )
    illumination_correction: bool = False
    physical_width_mm: float | None = Field(default=None, gt=0.0, le=5000.0)
    physical_height_mm: float | None = Field(default=None, gt=0.0, le=5000.0)

    @model_validator(mode="before")
    @classmethod
    def apply_mode_defaults(cls, data: object) -> object:
        if isinstance(data, dict) and "smoothing" not in data:
            normalized = dict(data)
            # LOGO-REBUILD (audit 2026-07-30 §LG.02): chế độ màu ưu tiên
            # trung thực đường nét; request/project cũ có giá trị tường minh vẫn giữ nguyên.
            normalized["smoothing"] = 0.0 if data.get("mode") == "fixed_palette" else 0.5
            return normalized
        return data

    @field_validator("palette")
    @classmethod
    def normalize_palette(cls, colors: list[str]) -> list[str]:
        normalized: list[str] = []
        for color in colors:
            value = color.strip().lower()
            if (
                len(value) != 7
                or not value.startswith("#")
                or any(ch not in "0123456789abcdef" for ch in value[1:])
            ):
                raise ValueError("Palette phải gồm mã màu #RRGGBB")
            if value not in normalized:
                normalized.append(value)
        return normalized

    @field_validator("background_color")
    @classmethod
    def normalize_background_color(cls, color: str | None) -> str | None:
        if color is None:
            return None
        value = color.strip().lower()
        if (
            len(value) != 7
            or not value.startswith("#")
            or any(ch not in "0123456789abcdef" for ch in value[1:])
        ):
            raise ValueError("Màu nền phải có dạng #RRGGBB")
        return value

    @model_validator(mode="after")
    def validate_mode_contract(self) -> "LogoRebuildSettings":
        # LOGO-REBUILD (audit 2026-08-09 §LR3.03): kích thước in là một
        # quyết định có đủ hai chiều, không suy ra nửa chừng từ metadata DPI.
        if (self.physical_width_mm is None) != (self.physical_height_mm is None):
            raise ValueError("Chiều rộng và chiều cao in mm phải được xác nhận đồng thời")
        if self.mode == "monochrome" and self.palette:
            raise ValueError("Chế độ đen trắng không nhận palette màu")
        if self.mode == "fixed_palette" and not 1 <= len(self.palette) <= 12:
            raise ValueError("Chế độ màu cần palette đã xác nhận gồm 1–12 màu")
        if self.background_color is not None:
            if self.mode != "fixed_palette":
                raise ValueError("Chỉ chế độ màu mới nhận màu nền cần loại bỏ")
            if self.background_color in self.palette:
                raise ValueError("Màu nền cần loại bỏ phải khác bảng màu logo")

        points = self.perspective_points
        if self.crop is not None and points is not None:
            raise ValueError("MVP không áp dụng đồng thời crop chữ nhật và hiệu chỉnh phối cảnh")
        if points is not None:
            if len(points) != 4:
                raise ValueError("Hiệu chỉnh phối cảnh cần đúng bốn điểm")
            area_twice = abs(
                sum(
                    points[i].x * points[(i + 1) % 4].y
                    - points[(i + 1) % 4].x * points[i].y
                    for i in range(4)
                )
            )
            if area_twice < 0.0002:
                raise ValueError("Bốn điểm phối cảnh tạo vùng suy biến")
            cross_products = []
            for i in range(4):
                a, b, c = points[i], points[(i + 1) % 4], points[(i + 2) % 4]
                cross_products.append(
                    (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
                )
            if not (
                all(value > 0.0 for value in cross_products)
                or all(value < 0.0 for value in cross_products)
            ):
                raise ValueError("Bốn điểm phối cảnh phải theo thứ tự quanh một vùng lồi")
        return self


class LogoSourceInfo(BaseModel):
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    mode: str
    format: str
    file_size_bytes: int = Field(gt=0)
    has_alpha: bool
    has_icc_profile: bool
    dpi: tuple[float, float] | None = None


class LogoPaletteSuggestion(BaseModel):
    """Một màu nhìn thấy trong ảnh nguồn; không phải cam kết màu in gốc."""

    color: str = Field(pattern=r"^#[0-9a-f]{6}$")
    coverage_ratio: float = Field(ge=0.0, le=1.0)


class LogoRebuildPreflightResponse(BaseModel):
    status: Literal["ready"] = "ready"
    source: LogoSourceInfo
    settings: LogoRebuildSettings
    palette_suggestions: list[LogoPaletteSuggestion] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class LogoRebuildEngineInfo(BaseModel):
    engine: str
    version: str
    cancellable: bool
    structured_result: bool = False
    result_schema_version: int | None = Field(default=None, ge=1)
    legacy_engine: str | None = None
    legacy_version: str | None = None


class LogoRebuildCapabilitiesResponse(BaseModel):
    version: Literal["mvp-preflight-v1"] = "mvp-preflight-v1"
    modes: list[LogoRebuildMode]
    supported_formats: list[str]
    auto_color_enabled: Literal[False] = False
    preview_engine_enabled: bool = False
    legacy_vtracer_enabled: bool = False
    engine: LogoRebuildEngineInfo | None = None
    limitations: list[str]


class LogoSvgComplexity(BaseModel):
    path_count: int = Field(ge=0)
    drawable_path_count: int = Field(ge=0)
    node_count: int = Field(ge=0)
    tiny_path_count: int = Field(ge=0)
    tiny_path_ratio: float = Field(ge=0.0, le=1.0)
    svg_bytes: int = Field(ge=0)
    removed_redundant_paths: int = Field(ge=0)


class LogoNativeMetrics(BaseModel):
    layer_count: int = Field(ge=0)
    component_count: int = Field(ge=0)
    outer_count: int = Field(ge=0)
    hole_count: int = Field(ge=0)
    source_nodes: int = Field(ge=0)
    output_nodes: int = Field(ge=0)
    max_error_px: float = Field(ge=0.0)
    raster_scale: int = Field(gt=0)
    iou: float = Field(ge=0.0, le=1.0)
    mae: float = Field(ge=0.0, le=1.0)


class LogoRebuildPreviewResponse(BaseModel):
    status: Literal["ready", "review", "rejected"] = "ready"
    job_id: UUID
    svg: str
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    physical_width_mm: float | None = Field(default=None, gt=0.0)
    physical_height_mm: float | None = Field(default=None, gt=0.0)
    warnings: list[str] = Field(default_factory=list)
    engine: str
    engine_version: str
    result_schema_version: int | None = Field(default=None, ge=1)
    artifact_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    preprocess_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    native_metrics: LogoNativeMetrics | None = None
    complexity: LogoSvgComplexity
    review_reasons: list[str] = Field(default_factory=list)
    review_actions: list[str] = Field(default_factory=list)


class LogoRebuildCancelResponse(BaseModel):
    job_id: UUID
    cancelled: bool
    status: Literal["cancelled", "not_found"]
