"""Hợp đồng API nhóm xuất ảnh (export).

KIENTRUC (audit 2026-07-29 §A.2, lô 13). Cùng nguyên tắc với `schemas/imposition.py`.
EXPORT (audit 2026-07-30 §IMG-08 lô 3): Literal + Field(ge/le) — reject tham số
sai thay vì âm thầm clamp.
"""

from pydantic import BaseModel, Field
from typing import List, Literal, Optional


class ExportImagesResponse(BaseModel):
    """`POST /api/export/images` — xuất trang PDF ra ảnh PNG/JPEG/TIFF.

    Desktop đọc (`lib/api.ts` → `exportImages`): `ok`, `count`, `output_dir`, `files`.
    `files` là đường dẫn TUYỆT ĐỐI trên máy người dùng (bản desktop mở thẳng thư mục kết
    quả thay vì tải lại qua HTTP), nên không được rút gọn thành tên file.
    """

    ok: bool
    count: int = Field(description="Số file ảnh đã ghi (TIFF nhiều trang = 1 file)")
    output_dir: str
    files: list[str] = Field(default_factory=list)


# ── Model gom từ app/api/routes/export.py (audit 2026-07-29 §A.2 lô 13) ──

class ExportImagesRequest(BaseModel):
    file_id: Optional[str] = None
    file_path: Optional[str] = None
    output_dir: str
    format: Literal["png", "jpeg", "tiff"] = "png"
    dpi: int = Field(default=150, ge=36, le=1200, description="Độ phân giải 36–1200 DPI")
    color_mode: Literal["rgb", "gray", "cmyk"] = "rgb"
    pages: Optional[List[int]] = None  # 1-based; None = tất cả
    multipage_tiff: bool = False
    jpeg_quality: int = Field(default=90, ge=1, le=100, description="Chất lượng JPEG 1–100")
    base_name: Optional[str] = None
