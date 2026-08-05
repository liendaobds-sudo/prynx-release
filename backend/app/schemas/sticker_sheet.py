"""Hợp đồng API cho công cụ Tách tem từ ảnh."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator


StickerSheetModel = Literal["birefnet-lite", "birefnet-full", "isnet"]


class StickerSheetInstanceResponse(BaseModel):
    id: int = Field(ge=1)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    area_px: int = Field(gt=0)
    confidence: float = Field(ge=0.0, le=1.0)
    uncertain_ratio: float = Field(ge=0.0, le=1.0)


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


class StickerSheetExportRequest(BaseModel):
    edits: list[StickerSheetEdit] = Field(default_factory=list, max_length=2000)
    dpi: float = Field(default=300.0, ge=36.0, le=2400.0)
    dpi_y: float | None = Field(default=None, ge=36.0, le=2400.0)
    offset_mm: float = Field(default=0.0, ge=-10.0, le=10.0)
    bleed_mm: float = Field(default=2.0, ge=0.0, le=10.0)
    output_format: Literal["pdf", "png_zip"] = "pdf"
