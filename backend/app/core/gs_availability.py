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
    """Câu giải thích ở mức sản phẩm, không phải mã lỗi của công cụ ngoài.

    Người dùng là thợ chế bản, không phải người vận hành Ghostscript: họ cần biết
    thao tác nào không xong và làm gì tiếp, chứ không cần chuỗi `Ghostscript failed:`.
    """
    what = f"“{operation}”" if operation else "Thao tác này"
    if is_no_gs_build():
        return (
            f"{what} chưa xử lý được bằng engine nội bộ (PrynX Print Engine) cho "
            "file này, và bản PrynX đang chạy không đóng gói Ghostscript. Tác vụ đã "
            "dừng thay vì giao ra bản in có thể sai. Cách xử lý: xuất lại file nguồn "
            "đơn giản hơn (nhúng đủ font, giảm hiệu ứng trong suốt), hoặc liên hệ hỗ "
            "trợ kèm file để bổ sung đường xử lý nội bộ."
        )
    return (
        f"{what} cần Ghostscript nhưng không tìm thấy Ghostscript trên máy. Cài "
        "Ghostscript rồi thử lại, hoặc đặt biến môi trường GHOSTSCRIPT_PATH trỏ tới "
        "gswin64c.exe."
    )
