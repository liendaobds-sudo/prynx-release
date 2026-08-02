"""Hợp đồng API nhóm công cụ PDF (pdf_tools).

KIENTRUC (audit 2026-07-29 §A.2, lô 8 đợt 2).

Lưu ý về con số: `routes/pdf_tools.py` có 22 endpoint nhưng phần lớn trả **`FileResponse`**
(tải file PDF/PNG/ZIP về) — chỗ đó `response_model` không áp dụng được và cũng không có
gì để cưỡng chế. Chỉ 5 endpoint trả JSON, và đó là toàn bộ phạm vi file này. Vì vậy
"22 endpoint / 0 có model" trong báo cáo audit là con số dễ gây hiểu sai — xem đính chính
trong `docs/KIEN_TRUC_FIXES_2026-07-29.md`.

`/merge-manifest` cố tình KHÔNG gắn model: nó trả dict khi `return_path=true` và
`FileResponse` khi không — một endpoint hai kiểu response, gắn `response_model` sẽ làm
nhánh tải file sai kiểu. Chuẩn hoá nó là thay đổi hành vi, để dịp khác.
"""

from pydantic import BaseModel, Field
from typing import Any, Optional


class EncryptionStatusResponse(BaseModel):
    """Kết quả `POST /api/pdf-tools/encryption-status`."""

    encrypted: bool


class MetadataReadResponse(BaseModel):
    """Kết quả `POST /api/pdf-tools/metadata/read`.

    `metadata` là dict tự do đọc từ PDF (Title/Author/Producer/XMP…) nên không siết schema.
    """

    metadata: dict[str, Any] = Field(default_factory=dict)


class OfficeConvertStatusResponse(BaseModel):
    """Kết quả `GET /api/pdf-tools/office-convert/status` — nguồn: `probe_converters()`.

    UI dùng để chọn đường chuyển đổi và hiển thị `hint` cho người dùng biết vì sao chậm
    hoặc vì sao chất lượng khác nhau.
    """

    ms_office: dict[str, Any] = Field(
        default_factory=dict, description="Kết quả dò COM: {'word': bool, 'excel': bool, …}"
    )
    libreoffice: bool = False
    libreoffice_path: str = ""
    google_export: bool = True
    can_convert_office: bool = False
    supported_extensions: list[str] = Field(default_factory=list)
    unsupported_extensions: list[str] = Field(default_factory=list)
    engine_by_extension: dict[str, str] = Field(
        default_factory=dict,
        description="Engine thật theo từng đuôi: word/excel/powerpoint/libreoffice/unavailable",
    )
    hint: Optional[str] = Field(
        default=None, description="Câu giải thích hiển thị cho người dùng (tiếng Việt)"
    )


class OfficeJobStatusResponse(BaseModel):
    job_id: str
    phase: str
    terminal: bool = False
    cancel_requested: bool = False
    remaining_seconds: float = 0.0
    message: Optional[str] = None


class OfficeJobCancelResponse(BaseModel):
    job_id: str
    phase: str
    cancelled: bool = False
    terminal: bool = False
    message: Optional[str] = None


class OfficeJobExtendResponse(BaseModel):
    job_id: str
    phase: str
    remaining_seconds: float
    extended: bool = False
    message: Optional[str] = None

class WarmupResponse(BaseModel):
    """Kết quả `POST /api/pdf-tools/remove-background/warmup` và `/upscale/warmup`.

    Nạp sẵn model để lần bấm đầu không phải chờ cold-start; `ok=False` không phải lỗi
    nghiêm trọng — UI vẫn dùng được, chỉ chậm lần đầu.
    """

    ok: bool
