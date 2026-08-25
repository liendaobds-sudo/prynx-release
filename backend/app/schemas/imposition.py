"""Hợp đồng API cho nhóm bình bản (imposition).

KIENTRUC (audit 2026-07-29 §A.2): hai đầu desktop ↔ backend không có codegen chung, nên
lệch schema là **lỗi runtime im lặng** — frontend đọc một field không còn tồn tại và chỉ
thấy `undefined`. Cách chặn: khai `response_model` cho các endpoint mà frontend phụ thuộc,
để FastAPI cưỡng chế hình dạng ngay tại biên và OpenAPI (dev) phản ánh đúng sự thật.

Nguyên tắc khi thêm model ở đây:

- **Chỉ mô tả, không siết.** Model được thêm cho endpoint ĐÃ CHẠY, nên mọi field frontend
  đang đọc phải có mặt; field kiểu lỏng thì để `Optional` thay vì bắt kiểu chặt. Một dữ
  liệu lệch nhẹ không được phép biến response 200 thành 500 vì lỗi validate.
- Ghi rõ **ai đọc field đó** ở phía desktop. Đó là thứ duy nhất giúp lần sau biết field
  nào được phép bỏ.
- Model cũ của thời `pdfcpu` (ImpositionConfig/ImpositionRequest/ImpositionResponse) đã
  **xoá**: `core/imposition_engine.py` deprecated, không nơi nào dùng, và
  `ImpositionRequest` là một class rỗng chỉ có `pass`.
"""

from pydantic import BaseModel, Field
from typing import Optional


class ImposeJobStartResponse(BaseModel):
    """Kết quả `/impose-start`, `/nup-start`, `/sticker-start`.

    Desktop đọc: `data.job_id` (`lib/api.ts` → `startNupJobBackend`).
    """

    job_id: str = Field(description="Id job để poll trạng thái / hủy / tải kết quả")


class NupJobStatusResponse(BaseModel):
    """Kết quả `/nup-status/{job_id}`.

    Desktop đọc (`lib/processHandlers.ts`): `status`, `progress`, `report`, `error`,
    `output_path`, `artifact_lease`. Ba mốc thời gian hiện chưa ai đọc nhưng vẫn
    trả — bỏ đi là thay đổi hợp đồng mà không có lợi ích gì.
    """

    status: str = Field(description="queued | running | completed | failed | cancelled")
    progress: Optional[str] = Field(
        default=None,
        description="Dạng 'trang_xong/tổng' (vd '3/10') hoặc thông điệp giai đoạn. "
        "Desktop chỉ hiển thị khi có ký tự '/'",
    )
    report: Optional[str] = Field(
        default=None, description="Báo cáo bình bản khi hoàn tất (hiển thị cho người dùng)"
    )
    error: Optional[str] = None
    created_at: Optional[float] = None
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    output_path: Optional[str] = Field(
        default=None,
        description="CHỈ có khi chạy bản desktop và job đã completed — desktop mở file "
        "trực tiếp trên đĩa thay vì tải lại qua HTTP",
    )
    artifact_lease: Optional[str] = Field(
        default=None,
        description="Token bí mật để tab claim Working artifact; client không gửi path",
    )


class NupJobCancelResponse(BaseModel):
    """Kết quả `/nup-cancel/{job_id}`.

    Endpoint trả BA hình dạng: job không tồn tại, job đã ở trạng thái cuối, và hủy thành
    công. Model là hợp của cả ba nên các field riêng của từng nhánh đều `Optional` —
    đây là mô tả đúng hiện trạng, không phải thiết kế mới.
    """

    job_id: str
    status: str = Field(description="not_found | completed | failed | cancelled")
    cancelled: bool = Field(description="True chỉ khi lời gọi này thực sự hủy job")
    message: Optional[str] = Field(
        default=None, description="Có ở nhánh not_found / đã ở trạng thái cuối"
    )
    already_cancelled: Optional[bool] = Field(
        default=None, description="Có ở nhánh hủy — job đã bị hủy trước đó rồi"
    )
    process_stopped: Optional[bool] = Field(
        default=None, description="Có ở nhánh hủy — đã kill được process con hay chưa"
    )
