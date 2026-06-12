"""
Pydantic schemas for API request/response validation.
"""
from datetime import datetime
from pydantic import BaseModel, Field


# ── Upload ──────────────────────────────────────────────
class FileUploadResponse(BaseModel):
    id: str
    filename: str
    original_name: str
    file_size: int
    page_count: int | None = None
    pdf_metadata: dict | None = None


# ── Comparison Job ──────────────────────────────────────
class CompareRequest(BaseModel):
    file_a_id: str
    file_b_id: str
    comparison_mode: str = Field(default="full", pattern="^(full|cmyk)$")
    tolerance: str = Field(default="NORMAL", pattern="^(STRICT|NORMAL|LOOSE)$")
    dpi: int = Field(default=300, ge=72, le=600)
    highlight_color: str = Field(default="#FF0000")
    is_packaging_mode: bool = Field(default=False)
    llm_mode: str = Field(default="off", pattern="^(off|gemini|openai|deepseek)$")
    llm_api_key: str = Field(default="")


class JobResponse(BaseModel):
    id: str
    job_type: str
    status: str
    progress: int
    current_page: int | None = None
    total_pages: int | None = None
    error_message: str | None = None
    status_message: str | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None

    class Config:
        from_attributes = True


class JobCreateResponse(BaseModel):
    job_id: str
    message: str = "Job đã được tạo thành công"


# ── Diff Region ─────────────────────────────────────────
class DiffRegion(BaseModel):
    x: float
    y: float
    width: float
    height: float
    type: str = "image"
    severity: str = "medium"
    description: str = ""
    b_page: int | None = None


# ── Page Result ─────────────────────────────────────────
class PageResultResponse(BaseModel):
    page_number: int
    status: str
    similarity_score: float
    diff_count: int
    diff_regions: list[DiffRegion]
    highlighted_image_url: str | None = None
    gif_image_url: str | None = None
    is_imposition_mode: bool = False

    class Config:
        from_attributes = True


# ── Full Results ────────────────────────────────────────
class ComparisonResultResponse(BaseModel):
    job: JobResponse
    summary: dict | None = None
    pages: list[PageResultResponse]
    file_a_url: str
    file_b_url: str


# ── WebSocket Progress ──────────────────────────────────
class ProgressUpdate(BaseModel):
    job_id: str
    status: str
    progress: int
    current_page: int | None = None
    total_pages: int | None = None
    message: str = ""
