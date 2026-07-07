"""
Chạy subprocess KHÔNG bật cửa sổ console trên Windows.

Ở bản release (Tauri sidecar không có console), mọi lần spawn một .exe có console
— điển hình là Ghostscript `gswin64c.exe` — sẽ khiến Windows bật một CỬA SỔ ĐEN.
Cửa sổ đó vừa xấu, vừa nguy hiểm: nếu người dùng lỡ click vào, chế độ QuickEdit
của console Windows sẽ ĐÓNG BĂNG tiến trình con cho tới khi bấm phím → subprocess
treo tới hết timeout → RuntimeError. Đây là gốc lỗi "xuất PDF/X treo + pop console".

`run_hidden()` bọc `subprocess.run` và thêm cờ CREATE_NO_WINDOW trên Windows (no-op
trên OS khác) → tiến trình con chạy ẩn, không bao giờ pop console. Dùng THAY cho
`subprocess.run` ở MỌI chỗ gọi công cụ ngoài (Ghostscript…) để lỗi này không tái diễn.
"""
import subprocess
import sys


# CREATE_NO_WINDOW chỉ có trên Windows. Trên OS khác = 0 (không đổi hành vi).
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def run_hidden(cmd, **kwargs) -> subprocess.CompletedProcess:
    """subprocess.run + CREATE_NO_WINDOW (Windows) để KHÔNG pop cửa sổ console.

    Truyền thẳng mọi kwargs (capture_output, timeout, stdout, stderr, cwd, env…)
    xuống subprocess.run. Nếu caller tự đặt creationflags thì OR thêm cờ ẩn cửa sổ
    (giữ nguyên cờ của caller, chỉ bổ sung).
    """
    if sys.platform == "win32":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_NO_WINDOW
    return subprocess.run(cmd, **kwargs)
