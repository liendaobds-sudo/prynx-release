"""Hợp đồng API nhóm hệ thống (system).

KIENTRUC (audit 2026-07-29 §A.2, lô 8 đợt 2). Cùng nguyên tắc với `schemas/imposition.py`:
model MÔ TẢ endpoint đang chạy, field lỏng để `Optional`, và ghi rõ ai đọc field đó.
"""

from pydantic import BaseModel, Field
from typing import Optional


class GpuStatusResponse(BaseModel):
    """Kết quả `GET /api/system/gpu-status` — nguồn: `GPUAccelerator.get_system_status()`.

    Desktop đọc qua `lib/api.ts` → `getGpuStatus()`.
    """

    is_gpu_available: bool
    current_backend: Optional[str] = Field(
        default=None, description="Tên backend đang dùng (vd cupy) hoặc None khi chạy CPU"
    )
    device_name: Optional[str] = None
    plugin_size_mb: Optional[float] = None


class InstallGpuPluginResponse(BaseModel):
    """Kết quả `POST /api/system/install-gpu-plugin`.

    `is_simulated=True` vì đường cài này hiện là mô phỏng — giữ field để UI không tuyên
    bố sai với người dùng rằng đã cài thật.
    """

    status: str
    is_simulated: bool
    message: Optional[str] = None
    note: Optional[str] = Field(
        default=None, description="Giải thích điều kiện để dùng GPU thật (CuPy + CUDA)"
    )
    device_name: Optional[str] = None
    plugin_size_mb: Optional[float] = None


class RecoverJobsResponse(BaseModel):
    """Kết quả `POST /api/system/recover-jobs` — gỡ job kẹt ở trạng thái processing/pending."""

    status: str
    recovered_jobs_count: int
