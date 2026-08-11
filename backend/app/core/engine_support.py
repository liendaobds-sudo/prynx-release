"""Hợp đồng fail-closed cho các giới hạn của engine nội bộ PrynX.

Module này không phụ thuộc renderer hay cấu hình runtime để mọi tầng có thể dùng
cùng một kiểu lỗi mà không tạo vòng import.
"""

from __future__ import annotations


class InternalEngineUnsupported(RuntimeError):
    """Engine nội bộ từ chối file có chủ đích để không giao bản in sai."""


def unsupported_message(operation: str | None = None) -> str:
    """Tạo thông điệp từ chối an toàn khi engine chưa bảo toàn được file."""
    what = f"“{operation}”" if operation else "Thao tác này"
    return (
        f"{what} chưa xử lý chắc chắn được file này bằng PrynX Print Engine. "
        "Tác vụ đã dừng an toàn và không tạo file kết quả. Hãy nhúng đủ phông, "
        "giảm hiệu ứng hoặc xuất lại PDF nguồn đơn giản hơn; nếu file vẫn bị từ "
        "chối, hãy gửi file cho bộ phận hỗ trợ để bổ sung engine nội bộ."
    )
