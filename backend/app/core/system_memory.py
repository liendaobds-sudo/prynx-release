"""Đọc RAM vật lý mà không thêm phụ thuộc ``psutil``.

Đường Windows dùng ``GlobalMemoryStatusEx``; Linux đọc ``/proc/meminfo``.
Mọi lỗi trả ``(None, None)`` để caller áp chính sách bảo thủ thay vì làm hỏng job.
"""

from __future__ import annotations

import os


def read_memory_status_mb() -> tuple[float | None, float | None]:
    """Trả ``(tổng RAM, RAM khả dụng)`` theo MiB."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", wintypes.DWORD),
                    ("dwMemoryLoad", wintypes.DWORD),
                    ("ullTotalPhys", ctypes.c_uint64),
                    ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64),
                    ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64),
                    ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                divisor = 1024.0 * 1024.0
                return status.ullTotalPhys / divisor, status.ullAvailPhys / divisor
        except Exception:
            return None, None

    total = available = None
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    total = float(line.split()[1]) / 1024.0
                elif line.startswith("MemAvailable:"):
                    available = float(line.split()[1]) / 1024.0
    except (OSError, ValueError, IndexError):
        return None, None
    return total, available


def plan_worker_count(
    *,
    kind: str,
    per_worker_mb: float,
    cpu_count: int | None = None,
    hard_ceiling: int | None = None,
    env_override: str | None = None,
) -> tuple[int, str]:
    """Số worker **process** cho một việc nặng, gate theo CẢ CPU lẫn RAM.

    KIENTRUC (audit 2026-07-29 §C.3): trước đây bình bản và preflight chỉ chia theo
    ``cpu_count - 1`` mà KHÔNG đọc RAM. Mỗi worker là một process giữ PDF trong bộ nhớ,
    nên máy 8 GB nhiều lõi vào job lớn là đường ngắn nhất tới OOM/treo. Đây là chiều
    NGƯỢC của rule #1 trong AGENTS.md: máy yếu chưa được bảo vệ.

    Chính sách (đồng bộ với ``_auto_sticker_hw_profile`` và
    ``core/print_engine/facade._auto_memory_budget_mb``):

    - Nền: ``cpu_count - 1`` — luôn chừa 1 nhân cho UI/backend.
    - Trần theo TỔNG RAM: ``<8 GB`` → 1 worker; ``<16 GB`` → 2 worker; ``>=16 GB`` →
      KHÔNG hạ (máy mạnh chạy hết công suất — rule #1).
    - Trần theo RAM KHẢ DỤNG (``available * 0.6 / per_worker_mb``) CHỈ áp cho máy
      ``<16 GB``. Cố tình KHÔNG áp cho ``>=16 GB``: rule #1 nói rõ chỉ máy yếu mới được
      giảm, và đo thử trên máy 32 GB/16 lõi cho thấy trần theo RAM khả dụng kéo worker
      bình bản từ 15 xuống 8 — đúng loại hồi quy máy mạnh đã trả giá một lần.
    - Không đọc được RAM (``None``) → chỉ dùng trần CPU, không tự bịa con số bảo thủ:
      hành vi giữ NGUYÊN như trước khi có hàm này.

    ``env_override`` (nếu truyền) là tên biến môi trường cho phép ép số worker; giá trị
    ``<=0`` hoặc không parse được thì bỏ qua. Ép bằng env luôn thắng, kể cả tăng lên —
    người vận hành biết máy mình.

    Trả ``(workers, reason)``; ``reason`` để ghi log, không dùng cho logic.
    """
    if cpu_count is None:
        cpu_count = os.cpu_count() or 2
    base = max(1, int(cpu_count) - 1)

    workers = base
    reason_parts = [f"cpu={cpu_count}", f"base={base}"]

    total_mb, available_mb = read_memory_status_mb()
    is_weak = total_mb is not None and total_mb < 16 * 1024

    if total_mb is not None:
        if total_mb < 8 * 1024:
            ram_cap = 1
        elif total_mb < 16 * 1024:
            ram_cap = 2
        else:
            ram_cap = base  # >=16 GB: giữ nguyên full (rule #1)
        if ram_cap < workers:
            workers = ram_cap
        reason_parts.append(f"ram_total_mb={total_mb:.0f}->cap{ram_cap}")

    # Trần theo RAM khả dụng CHỈ cho máy yếu — xem docstring.
    if is_weak and available_mb is not None and per_worker_mb > 0:
        avail_cap = max(1, int(available_mb * 0.6 / per_worker_mb))
        if avail_cap < workers:
            workers = avail_cap
        reason_parts.append(f"ram_avail_mb={available_mb:.0f}->cap{avail_cap}")

    if hard_ceiling is not None and hard_ceiling > 0 and hard_ceiling < workers:
        workers = hard_ceiling
        reason_parts.append(f"ceiling={hard_ceiling}")

    if env_override:
        raw = os.environ.get(env_override, "")
        try:
            forced = int(raw) if raw else 0
        except (TypeError, ValueError):
            forced = 0
        if forced > 0:
            workers = forced
            reason_parts.append(f"{env_override}={forced}(env)")

    workers = max(1, int(workers))
    return workers, f"{kind}: workers={workers} ({', '.join(reason_parts)})"
