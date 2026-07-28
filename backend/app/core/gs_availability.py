"""Ghostscript có mặt hay không — một nguồn sự thật cho cấu hình và thông điệp lỗi.

# Vì sao cần module riêng thay vì cứ dò đường dẫn ở mỗi chỗ

Bản phát hành `-NoGhostscript` **không** đóng gói Ghostscript, nhưng máy khách có
thể đã cài GS sẵn cho việc khác. Trước đây `_find_ghostscript()` sẽ tìm thấy bản đó
và dùng, nên cùng một phiên bản PrynX chạy **hai đường engine khác nhau** tuỳ máy —
mà thiết bị đo tỉ lệ GS đã bị loại khỏi gate, nên không ai biết máy nào đang đi
đường nào. Đó đúng là loại phương sai làm sự cố ngoài hiện trường không tái lập
được.

Bản build no-GS để lại một **marker** trong payload (`NO_GHOSTSCRIPT.txt` dưới
`binaries/gs`). Marker đó là lời khai của artifact: “bản này chạy PPE, không có
Ghostscript”. Module này đọc nó và mọi tầng khác hỏi lại đây.

Module cố ý **không import gì từ `app`** để `app.config` gọi được nó trong lúc
dựng `Settings` mà không tạo vòng import.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


class GhostscriptUnavailable(RuntimeError):
    """Một đường chạy cần Ghostscript nhưng bản đang chạy không có nó."""


class InternalEngineUnsupported(RuntimeError):
    """Engine nội bộ từ chối file có chủ đích để không giao bản in sai."""


MARKER_NAME = "NO_GHOSTSCRIPT.txt"


def _payload_dirs() -> tuple[Path, ...]:
    """Các thư mục payload có thể chứa Ghostscript hoặc marker no-GS.

    Giữ **cùng danh sách** với đường dò Ghostscript trong `app.config`: nếu hai
    danh sách lệch nhau thì sẽ có cấu hình mà marker nằm ngoài tầm nhìn và bản
    no-GS lại âm thầm dùng GS hệ thống.
    """
    exe_dir = Path(sys.executable).parent
    return (
        exe_dir / "binaries" / "gs",
        exe_dir / "gs",
        exe_dir / "resources" / "binaries" / "gs",
    )


def bundled_ghostscript() -> str:
    """Ghostscript đóng kèm trong payload, chuỗi rỗng nếu không có."""
    for base in _payload_dirs():
        candidate = base / "bin" / "gswin64c.exe"
        if candidate.is_file():
            return str(candidate)
    return ""


def is_no_gs_build() -> bool:
    """`True` nếu artifact đang chạy tự khai là bản không có Ghostscript.

    Biến môi trường `PRYNX_NO_GS_BUILD` cho phép mô phỏng bản no-GS ở máy dev để
    kiểm thử đúng hành vi sản phẩm mà không phải build installer.
    """
    env = os.environ.get("PRYNX_NO_GS_BUILD", "").strip().lower()
    if env in {"1", "true", "yes", "on"}:
        return True
    if env in {"0", "false", "no", "off"}:
        return False
    for base in _payload_dirs():
        if (base / MARKER_NAME).is_file():
            return True
    return False


def unavailable_message(operation: str | None = None) -> str:
    """Thông điệp tương thích cho call site legacy; sản phẩm luôn no-GS."""
    return unsupported_message(operation)

def unsupported_message(operation: str | None = None) -> str:
    """Thông điệp fail-closed của sản phẩm no-GS, không giả là lỗi cài đặt.

    GS-SUNSET (audit 2026-07-28 §3.2): bản no-GS phải từ chối ngay khi engine
    nội bộ không bảo toàn được file. Nếu vẫn gọi runner GS rồi mới báo thiếu,
    telemetry và UI đều hiểu nhầm đây là phụ thuộc runtime thay vì một giới hạn
    sản phẩm đã công bố.
    """
    what = f"“{operation}”" if operation else "Thao tác này"
    return (
        f"{what} chưa xử lý chắc chắn được file này bằng PrynX Print Engine. "
        "Tác vụ đã dừng an toàn và không tạo file kết quả. Hãy nhúng đủ phông, "
        "giảm hiệu ứng hoặc xuất lại PDF nguồn đơn giản hơn; nếu file vẫn bị từ "
        "chối, hãy gửi file cho bộ phận hỗ trợ để bổ sung engine nội bộ."
    )
