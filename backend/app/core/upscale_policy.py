"""Chính sách RAM, DPI và ICC dùng chung cho luồng Upscale."""

from __future__ import annotations

import math

from fastapi import HTTPException


def upscale_memory_budget_mb() -> float | None:
    """Ngân sách RAM an toàn tại thời điểm admission của một chu kỳ Upscale."""

    from app.core.system_memory import read_memory_status_mb

    _total_mb, available_mb = read_memory_status_mb()
    if available_mb is None:
        return None
    return max(0.0, available_mb - 1024.0) * 0.70


def validate_upscale_memory(width: int, height: int) -> float:
    """Từ chối sớm nếu pipeline x4 chắc chắn vượt RAM vật lý còn trống."""
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Kích thước ảnh không hợp lệ")

    model_output_pixels = width * height * 16
    estimated_peak_mb = model_output_pixels * 20 / (1024 * 1024)
    usable_mb = upscale_memory_budget_mb()
    if usable_mb is not None and estimated_peak_mb > usable_mb:
        output_w, output_h = width * 4, height * 4
        raise HTTPException(
            status_code=422,
            detail=(
                f"Ảnh {width}×{height} px cần khoảng {estimated_peak_mb / 1024:.1f} GB RAM "
                f"để xử lý AI (trung gian {output_w}×{output_h} px), nhưng máy hiện "
                "không còn đủ bộ nhớ. Hãy đóng bớt ứng dụng hoặc dùng ảnh nhỏ hơn."
            ),
        )
    # STABILITY (audit 2026-08-11 §US.04): trả peak cho scheduler đặt chỗ
    # atomically. Không chia cứng cho số slot — một job lớn trên máy mạnh vẫn dùng
    # toàn ngân sách nếu không có job khác chạy cùng lúc.
    return estimated_peak_mb


def upscale_output_dpi(source_dpi: object, scale_factor: int) -> tuple[float, float]:
    """Tăng mật độ điểm ảnh để kích thước vật lý không đổi sau Upscale."""
    dpi_x = dpi_y = 72.0
    try:
        if isinstance(source_dpi, (tuple, list)) and len(source_dpi) >= 2:
            candidate_x = float(source_dpi[0])
            candidate_y = float(source_dpi[1])
            if math.isfinite(candidate_x) and candidate_x > 0:
                dpi_x = candidate_x
            if math.isfinite(candidate_y) and candidate_y > 0:
                dpi_y = candidate_y
        elif source_dpi is not None:
            candidate = float(source_dpi)
            if math.isfinite(candidate) and candidate > 0:
                dpi_x = dpi_y = candidate
    except (TypeError, ValueError, OverflowError):
        pass
    return dpi_x * scale_factor, dpi_y * scale_factor


def icc_data_colorspace(icc_bytes: bytes | None) -> str | None:
    """Đọc colorspace từ ICC profile header (4 byte tại offset 16)."""
    if not icc_bytes or len(icc_bytes) < 20:
        return None
    signature = icc_bytes[16:20]
    mapping = {
        b"RGB ": "RGB",
        b"GRAY": "GRAY",
        b"Lab ": "LAB",
        b"CMYK": "CMYK",
        b"XYZ ": "XYZ",
    }
    return mapping.get(signature)
