"""Chạy công cụ ngoài mà không bật cửa sổ console trên Windows.

`run_hidden()` là lớp bọc chung cho qpdf, Poppler và các công cụ dòng lệnh khác.
Ngoài việc thêm `CREATE_NO_WINDOW`, hàm còn giữ một chốt an toàn để Ghostscript
không thể quay lại qua một call site cũ hoặc mới.
"""

from __future__ import annotations

import ntpath
import os
import posixpath
import subprocess
import sys


# CREATE_NO_WINDOW chỉ có ý nghĩa trên Windows; hệ điều hành khác giữ nguyên hành vi.
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
_GHOSTSCRIPT_STEMS = frozenset({"gs", "gsc", "gswin32c", "gswin64c"})


class GhostscriptBlocked(RuntimeError):
    """Tripwire phát hiện code đang cố gọi executable đã bị loại khỏi sản phẩm."""


def _executable_of(cmd) -> str:
    """Lấy executable trực tiếp từ dạng lệnh mà `subprocess.run` chấp nhận."""
    if isinstance(cmd, (list, tuple)):
        return str(cmd[0]) if cmd and cmd[0] is not None else ""
    if not isinstance(cmd, str):
        return ""

    command = cmd.lstrip()
    if not command:
        return ""
    if command[0] in {'"', "'"}:
        quote = command[0]
        closing = command.find(quote, 1)
        return command[1:closing] if closing >= 0 else command[1:]
    return command.split(maxsplit=1)[0]


def _executable_stem(cmd) -> str:
    """Chuẩn hoá tên executable cho cả đường dẫn Windows và POSIX."""
    executable = _executable_of(cmd)
    filename = ntpath.basename(posixpath.basename(executable))
    return os.path.splitext(filename)[0].casefold()


def _guard_ghostscript(cmd) -> None:
    """Chặn Ghostscript trước khi hệ điều hành có cơ hội tạo tiến trình."""
    if _executable_stem(cmd) not in _GHOSTSCRIPT_STEMS:
        return

    # GS-SUNSET (audit 2026-08-08 §E2A): đây là tripwire độc lập với cấu hình,
    # PATH và telemetry; mọi môi trường đều từ chối cùng một tập executable.
    raise GhostscriptBlocked(
        "PrynX không sử dụng Ghostscript. Tác vụ đã bị chặn trước khi tạo tiến trình; "
        "hãy dùng PrynX Print Engine/PDFium hoặc từ chối an toàn nếu file chưa được hỗ trợ."
    )


def run_hidden(cmd, **kwargs) -> subprocess.CompletedProcess:
    """Chạy công cụ ngoài, đồng thời ẩn cửa sổ console trên Windows.

    Mọi tham số như `capture_output`, `timeout`, `cwd` và `env` được chuyển
    nguyên vẹn xuống `subprocess.run`. Nếu caller đã có `creationflags`, cờ ẩn
    cửa sổ được ghép thêm thay vì ghi đè.
    """
    _guard_ghostscript(cmd)
    if sys.platform == "win32":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_NO_WINDOW
    return subprocess.run(cmd, **kwargs)
