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


def _caller_reason() -> str:
    """Module + hàm gọi `run_hidden`, dùng làm nhãn cho bộ đếm Ghostscript.

    Dò ngược ngăn xếp thay vì bắt caller tự khai: chỗ gọi GS mới thêm sau này
    sẽ được đếm mà không ai phải nhớ thêm tham số — và đó đúng là những chỗ số
    liệu quan trọng nhất. Bỏ qua khung của asyncio/threading vì phần lớn lệnh
    GS chạy qua `asyncio.to_thread`, nếu không nhãn nào cũng ra "thread.run".
    """
    try:
        frame = sys._getframe(2)
        for _ in range(12):
            if frame is None:
                break
            name = frame.f_globals.get("__name__", "")
            if name.startswith("app.") and not name.endswith("subprocess_utils"):
                return f"{name}.{frame.f_code.co_name}"
            frame = frame.f_back
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def _executable_of(cmd) -> str:
    if isinstance(cmd, (list, tuple)):
        return str(cmd[0]) if cmd and cmd[0] is not None else ""
    if isinstance(cmd, str):
        return cmd
    return ""


def _guard_ghostscript(cmd) -> None:
    """Dừng sớm với lời giải thích khi lệnh Ghostscript không thể chạy.

    Nhận diện theo HAI dấu hiệu chứ không chỉ theo tên tiến trình: đường dẫn GS
    được cấu hình có thể rỗng (bản no-GS) hoặc trỏ tới một tên bất kỳ (máy khách
    cấu hình sai, và cũng là cách `test_no_ghostscript_survival` mô phỏng). Cả hai
    trường hợp đó `is_ghostscript_command()` đều trả `False`, nên chỉ dựa vào tên
    là bỏ đúng những ca cần nói rõ nhất.

    Bộ đếm telemetry được ghi SAU hàm này: một lần gọi không bao giờ xảy ra thì
    không được tính vào số lần dùng Ghostscript.
    """
    import os
    import shutil

    exe = _executable_of(cmd)
    if exe:
        if os.path.isfile(exe):
            return
        has_sep = os.sep in exe or (os.altsep is not None and os.altsep in exe)
        # Tên trần (`gswin64c.exe`) được Windows phân giải qua PATH, `os.path.isfile`
        # trả False cho nó. Không tra PATH ở đây thì guard sẽ chặn oan đúng cấu hình
        # phổ biến nhất trên máy có Ghostscript cài sẵn.
        if not has_sep and shutil.which(exe) is not None:
            return

    looks_like_gs = False
    configured = ""
    try:
        from app.core import gs_usage

        looks_like_gs = bool(exe) and gs_usage.is_ghostscript_command(cmd)
    except Exception:  # noqa: BLE001
        looks_like_gs = False
    try:
        from app.config import settings

        configured = str(getattr(settings, "GHOSTSCRIPT_PATH", "") or "")
    except Exception:  # noqa: BLE001
        configured = ""

    if not (looks_like_gs or exe == configured):
        # Công cụ ngoài khác (poppler…) — để nguyên lỗi gốc của subprocess.
        return

    from app.core.gs_availability import GhostscriptUnavailable, unavailable_message

    raise GhostscriptUnavailable(unavailable_message())


def run_hidden(cmd, **kwargs) -> subprocess.CompletedProcess:
    """subprocess.run + CREATE_NO_WINDOW (Windows) để KHÔNG pop cửa sổ console.

    Truyền thẳng mọi kwargs (capture_output, timeout, stdout, stderr, cwd, env…)
    xuống subprocess.run. Nếu caller tự đặt creationflags thì OR thêm cờ ẩn cửa sổ
    (giữ nguyên cờ của caller, chỉ bổ sung).

    Cũng là chỗ **đếm mọi lần Ghostscript được gọi** (gate §8.1 — xem
    `app.core.gs_usage`). Đặt bộ đếm ở đây vì mọi lệnh GS của sản phẩm đều đi
    qua hàm này; rải nó ra từng call site sẽ bỏ sót đúng các đường thêm mới.

    `gs_reason=` (tuỳ chọn) để caller tự đặt nhãn khi nó biết rõ hơn ngăn xếp —
    ví dụ `action_engine` biết tên action, còn dò ngăn xếp chỉ ra được tên hàm
    nội bộ. Tham số này được lấy ra trước khi gọi `subprocess.run`.
    """
    reason = kwargs.pop("gs_reason", None)
    # GS-SUNSET (audit 2026-07-27 §A.4): chặn ở đây thay vì để subprocess ném
    # `FileNotFoundError`. Đây là hook duy nhất mọi lệnh Ghostscript đi qua, nên một
    # chỗ sửa cho mọi call site — kể cả call site thêm sau này.
    _guard_ghostscript(cmd)
    try:
        from app.core import gs_usage

        if gs_usage.is_ghostscript_command(cmd):
            gs_usage.record_gs_call(reason or _caller_reason())
    except Exception:  # noqa: BLE001 — đo đạc không được làm hỏng job
        pass
    if sys.platform == "win32":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_NO_WINDOW
    return subprocess.run(cmd, **kwargs)
