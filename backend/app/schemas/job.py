"""
Pydantic schemas for API request/response validation.
"""
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


# ── Upload ──────────────────────────────────────────────
class LocalFileUploadRequest(BaseModel):
    file_path: str = Field(min_length=1)


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
    page_matching_mode: str = Field(default="auto", pattern="^(auto|sequential|imposition)$")
    tolerance: str = Field(default="NORMAL", pattern="^(STRICT|NORMAL|LOOSE)$")
    dpi: int = Field(default=300, ge=72, le=600)
    highlight_color: str = Field(default="#FF0000")
    is_packaging_mode: bool = Field(default=False)
    # (Đã gỡ llm_mode/llm_api_key: QC AI tách sang endpoint /qc/check-text, không
    #  còn dùng trong luồng so sánh ảnh.)


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

    # KIENTRUC (audit 2026-07-29 §A.2): `class Config` là API Pydantic v1, sẽ bị bỏ ở v3
    # và mỗi lần chạy test đều in DeprecationWarning. `ConfigDict` là dạng v2 tương đương.
    model_config = ConfigDict(from_attributes=True)


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
    matched_b_page: int | None = None

    model_config = ConfigDict(from_attributes=True)


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


# ── KIENTRUC (audit 2026-07-29 §A.2, lô 13) ─────────────────────
class DeleteJobResponse(BaseModel):
    """`DELETE /api/jobs/{job_id}` — xoá job so sánh + kết quả kèm theo.

    Chỉ có `message` (đã bản địa hoá) để UI hiển thị. Không trả `success` vì lỗi đã đi
    bằng HTTP status; thêm cờ nữa chỉ tạo hai nguồn chân lý.
    """

    message: str
