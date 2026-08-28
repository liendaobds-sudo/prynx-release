"""Process lifecycle cho chuyển Office/Google → PDF.

COM và LibreOffice có thể treo ngoài tầm hủy của thread. Runner này giữ slot của caller
cho tới khi process con thật sự terminal, hỗ trợ cancel/deadline có thể gia hạn và chỉ
kết thúc PID do chính job PrynX tạo.
"""

from __future__ import annotations

import json
import logging
import multiprocessing
import os
import subprocess
import threading
import time
import uuid
from typing import Any, Callable, Optional

from app.workers.office_convert_engine import convert_google_link, convert_office_file

logger = logging.getLogger(__name__)


class OfficeJobCancelled(RuntimeError):
    """Người dùng hủy job đang chạy."""


class OfficeJobTimedOut(TimeoutError):
    """Lease hết hạn và process đã được thu hồi."""


class OfficeJobControl:
    """Kênh điều khiển thread-safe cho cancel và gia hạn lease."""

    def __init__(self, timeout_seconds: float):
        self.cancel_event = threading.Event()
        self._lease_lock = threading.Lock()
        self._deadline = time.monotonic() + max(1.0, float(timeout_seconds))

    def cancel(self) -> None:
        self.cancel_event.set()

    def extend(self, seconds: float) -> float:
        extension = max(1.0, float(seconds))
        with self._lease_lock:
            self._deadline = max(self._deadline, time.monotonic()) + extension
            return max(0.0, self._deadline - time.monotonic())

    def expired(self) -> bool:
        with self._lease_lock:
            return time.monotonic() >= self._deadline

    def remaining_seconds(self) -> float:
        with self._lease_lock:
            return max(0.0, self._deadline - time.monotonic())


def office_timeout_seconds(source_path: str) -> float:
    """Deadline theo kích thước; env là escape hatch cho file đặc biệt phức tạp."""
    forced = _positive_env_float("PRYNX_OFFICE_TIMEOUT_SECONDS")
    if forced is not None:
        return forced
    try:
        size_mb = os.path.getsize(source_path) / (1024 * 1024)
    except OSError:
        size_mb = 0.0
    # PERF (audit 2026-08-02 §OFFICE.1): deadline chống COM treo, không cap worker
    # hay chất lượng. File lớn được thêm thời gian; user còn có thể gia hạn lease.
    return min(1800.0, 300.0 + size_mb * 6.0)


def google_timeout_seconds() -> float:
    return _positive_env_float("PRYNX_GOOGLE_EXPORT_TIMEOUT_SECONDS") or 120.0


def _positive_env_float(name: str) -> Optional[float]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _write_state(state_path: str, status: str, message: str = "") -> None:
    temp_path = f"{state_path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as state_file:
        json.dump(
            {"status": status, "message": message[:2000]},
            state_file,
            ensure_ascii=False,
        )
    os.replace(temp_path, state_path)


def _office_worker(
    source_path: str,
    excel_layout: str,
    partial_output: str,
    owned_pid_path: str,
    state_path: str,
) -> None:
    try:
        convert_office_file(
            source_path,
            partial_output,
            excel_layout,
            owned_pid_path=owned_pid_path,
        )
        _write_state(state_path, "completed")
    except Exception as exc:  # noqa: BLE001 — trả lỗi nghiệp vụ về process cha
        _write_state(state_path, "failed", str(exc))


def _google_worker(
    url: str,
    http_timeout: float,
    partial_output: str,
    state_path: str,
) -> None:
    try:
        convert_google_link(url, partial_output, timeout=http_timeout)
        _write_state(state_path, "completed")
    except Exception as exc:  # noqa: BLE001 — trả lỗi nghiệp vụ về process cha
        _write_state(state_path, "failed", str(exc))


def _read_owned_pids(path: str) -> list[int]:
    try:
        with open(path, "r", encoding="ascii") as pid_file:
            raw_lines = pid_file.read().splitlines()
    except OSError:
        return []
    result: list[int] = []
    for raw in raw_lines:
        try:
            pid = int(raw.strip())
        except ValueError:
            continue
        if pid > 0 and pid not in result:
            result.append(pid)
    return result


# ── [PROC-LIFECYCLE FIX 2026-08-28 §UP.11] Quét PID Office mồ côi lúc khởi động ──
#
# Vì sao cần: Word/Excel do COM `DispatchEx` khởi tạo KHÔNG phải con của sidecar (DCOM sinh
# chúng dưới svchost), nên chúng không nằm trong cây process của sidecar và cũng không vào
# Job Object của app. Đường dọn duy nhất là `_terminate_process_tree` — viết bằng Python, tức
# là chỉ chạy khi sidecar còn sống. Sidecar bị `taskkill /F` (app thoát, cập nhật, crash) thì
# đoạn đó không bao giờ chạy ⇒ WINWORD.EXE/EXCEL.EXE/soffice.exe còn lại trong Task Manager,
# đúng như chủ máy thấy.
#
# File `*.owned-pids` là bằng chứng còn lại: nó chỉ tồn tại trong lúc job chạy (khối `finally`
# của `_run_isolated` luôn xóa). File còn sót ⇒ job trước bị cắt giữa ⇒ PID trong đó có thể
# đang mồ côi.
#
# Chống giết oan do PID bị Windows tái sử dụng: CHỈ diệt khi image name của PID nằm trong
# whitelist Office. Tuyệt đối không diệt theo tên ứng dụng (sẽ giết Word người dùng đang mở).
_ORPHAN_IMAGE_WHITELIST = frozenset(
    {
        "winword.exe",
        "excel.exe",
        "powerpnt.exe",
        "soffice.exe",
        "soffice.bin",
    }
)


def _image_name_of_pid(pid: int) -> Optional[str]:
    """Đọc image name của PID qua tasklist. None nếu không còn tiến trình."""
    if os.name != "nt" or pid <= 0:
        return None
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Không đọc được tên tiến trình PID %s: %s", pid, exc)
        return None
    first_line = (completed.stdout or "").strip().splitlines()
    if not first_line:
        return None
    # Dạng CSV: "IMAGE.EXE","1234","Console","1","12.345 K"
    # Không có tiến trình: tasklist in "INFO: No tasks are running..." (không có dấu ").
    raw = first_line[0].strip()
    if not raw.startswith('"'):
        return None
    name = raw.split('","', 1)[0].lstrip('"').strip()
    return name.lower() or None


def sweep_orphan_office_pids(*directories: str) -> int:
    """Diệt tiến trình Office mồ côi còn ghi trong các file `*.owned-pids` sót lại.

    Trả về số tiến trình đã diệt. An toàn khi gọi nhiều lần và trên máy không có Office.
    """
    if os.name != "nt":
        return 0
    killed = 0
    for directory in directories:
        if not directory:
            continue
        try:
            entries = os.listdir(directory)
        except OSError:
            continue
        for entry in entries:
            if not entry.endswith(".owned-pids"):
                continue
            pid_path = os.path.join(directory, entry)
            for pid in _read_owned_pids(pid_path):
                image = _image_name_of_pid(pid)
                if image is None:
                    continue
                if image not in _ORPHAN_IMAGE_WHITELIST:
                    # PID đã được hệ điều hành cấp lại cho tiến trình khác — bỏ qua.
                    logger.info(
                        "Bỏ qua PID %s (%s) — không thuộc whitelist Office mồ côi.",
                        pid,
                        image,
                    )
                    continue
                logger.warning(
                    "Diệt tiến trình Office mồ côi PID %s (%s) từ job trước.", pid, image
                )
                _kill_pid_tree(pid)
                killed += 1
            try:
                os.remove(pid_path)
            except OSError:
                pass
    return killed


def _kill_pid_tree(pid: int) -> None:
    if os.name != "nt" or pid <= 0:
        return
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Không dừng được cây process Office PID %s: %s", pid, exc)


def _terminate_process_tree(
    process: Any,
    owned_pid_path: str,
    join_timeout: float = 1.0,
    owned_pid_grace_timeout: float = 0.0,
) -> bool:
    """Dừng đúng các PID của job; tuyệt đối không taskkill theo tên ứng dụng."""
    killed_owned_pids: set[int] = set()

    def kill_new_owned_pids() -> None:
        for owned_pid in _read_owned_pids(owned_pid_path):
            if owned_pid in killed_owned_pids:
                continue
            _kill_pid_tree(owned_pid)
            killed_owned_pids.add(owned_pid)

    # [OFFICE FIX 2026-08-02] Khi hủy ngay sau spawn, DispatchEx có thể đã
    # khởi động Office nhưng chưa kịp công bố PID. Chờ ngắn để chỉ kill đúng PID job.
    if owned_pid_grace_timeout > 0 and not _read_owned_pids(owned_pid_path):
        deadline = time.monotonic() + owned_pid_grace_timeout
        while time.monotonic() < deadline:
            try:
                if not process.is_alive():
                    break
            except Exception:
                break
            if _read_owned_pids(owned_pid_path):
                break
            time.sleep(0.05)

    kill_new_owned_pids()

    try:
        if not process.is_alive():
            return True
    except Exception:
        return True

    pid = getattr(process, "pid", None)
    if os.name == "nt" and pid:
        _kill_pid_tree(int(pid))
    else:
        try:
            process.terminate()
        except Exception:
            pass

    try:
        process.join(timeout=join_timeout)
    except Exception:
        pass
    # [OFFICE FIX 2026-08-02] COM có thể công bố PID đúng lúc worker bị dừng.
    # Quét lần hai để không bỏ sót Word/Excel/PowerPoint do chính job vừa tạo.
    kill_new_owned_pids()
    try:
        if process.is_alive():
            process.terminate()
            process.join(timeout=join_timeout)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=join_timeout)
        kill_new_owned_pids()
        return not process.is_alive()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Không dừng sạch process job %s: %s", pid, exc)
        return False


def _run_isolated(
    target: Callable[..., None],
    args: tuple[Any, ...],
    output_pdf: str,
    *,
    control: OfficeJobControl,
    label: str,
    phase_callback: Optional[Callable[[str], None]] = None,
    tracks_owned_pid: bool = False,
) -> str:
    if control.cancel_event.is_set():
        raise OfficeJobCancelled(f"Đã hủy {label}.")

    token = uuid.uuid4().hex
    partial_output = f"{output_pdf}.{token}.partial.pdf"
    state_path = f"{output_pdf}.{token}.state.json"
    owned_pid_path = f"{output_pdf}.{token}.owned-pids"
    worker_args = (
        (*args, partial_output, owned_pid_path, state_path)
        if tracks_owned_pid
        else (*args, partial_output, state_path)
    )
    process = multiprocessing.Process(target=target, args=worker_args, daemon=False)
    started = False
    completed = False
    termination_attempted = False

    def set_phase(phase: str) -> None:
        if phase_callback is not None:
            phase_callback(phase)

    try:
        set_phase("starting")
        process.start()
        started = True
        set_phase("running")
        while process.is_alive():
            if control.cancel_event.is_set():
                set_phase("cancelled")
                _terminate_process_tree(
                    process,
                    owned_pid_path,
                    owned_pid_grace_timeout=3.0 if tracks_owned_pid else 0.0,
                )
                termination_attempted = True
                raise OfficeJobCancelled(f"Đã hủy {label}.")
            if control.expired():
                set_phase("timed_out")
                _terminate_process_tree(
                    process,
                    owned_pid_path,
                    owned_pid_grace_timeout=3.0 if tracks_owned_pid else 0.0,
                )
                termination_attempted = True
                raise OfficeJobTimedOut(
                    f"{label} mất quá nhiều thời gian và đã được dừng an toàn. "
                    "Bạn có thể thử lại và chọn Tiếp tục chờ nếu file rất phức tạp."
                )
            process.join(timeout=0.1)

        process.join(timeout=0)
        try:
            with open(state_path, "r", encoding="utf-8") as state_file:
                state = json.load(state_file)
        except (OSError, ValueError, TypeError) as exc:
            set_phase("failed")
            raise RuntimeError(
                f"Process {label} kết thúc bất thường (mã {process.exitcode})."
            ) from exc

        if state.get("status") != "completed":
            set_phase("failed")
            raise ValueError(state.get("message") or f"{label} thất bại.")
        if not os.path.isfile(partial_output) or os.path.getsize(partial_output) < 32:
            set_phase("failed")
            raise RuntimeError(f"{label} không tạo được file PDF hợp lệ.")
        os.replace(partial_output, output_pdf)
        completed = True
        set_phase("completed")
        return output_pdf
    except (OfficeJobCancelled, OfficeJobTimedOut):
        raise
    except BaseException:
        set_phase("failed")
        raise
    finally:
        if started:
            try:
                if not termination_attempted and (not completed or process.is_alive()):
                    _terminate_process_tree(
                        process,
                        owned_pid_path,
                        owned_pid_grace_timeout=3.0 if tracks_owned_pid else 0.0,
                    )
            except Exception:
                pass
        cleanup_paths = (
            partial_output,
            state_path,
            f"{state_path}.tmp",
            owned_pid_path,
            f"{owned_pid_path}.tmp",
        )
        for temp_path in cleanup_paths:
            try:
                os.remove(temp_path)
            except OSError:
                pass



def run_office_job(
    source_path: str,
    output_pdf: str,
    excel_layout: str = "preserve",
    *,
    control: Optional[OfficeJobControl] = None,
    phase_callback: Optional[Callable[[str], None]] = None,
) -> str:
    job_control = control or OfficeJobControl(office_timeout_seconds(source_path))
    return _run_isolated(
        _office_worker,
        (source_path, excel_layout),
        output_pdf,
        control=job_control,
        label="chuyển Office → PDF",
        phase_callback=phase_callback,
        tracks_owned_pid=True,
    )


def run_google_job(
    url: str,
    output_pdf: str,
    *,
    control: Optional[OfficeJobControl] = None,
    phase_callback: Optional[Callable[[str], None]] = None,
) -> str:
    timeout_seconds = google_timeout_seconds()
    job_control = control or OfficeJobControl(timeout_seconds)
    return _run_isolated(
        _google_worker,
        (url, min(90.0, max(10.0, timeout_seconds - 5.0))),
        output_pdf,
        control=job_control,
        label="tải Google → PDF",
        phase_callback=phase_callback,
    )