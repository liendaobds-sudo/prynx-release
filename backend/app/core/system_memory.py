"""Đọc RAM vật lý mà không thêm phụ thuộc ``psutil``.

RAM OS dùng được/khả dụng: Windows dùng ``GlobalMemoryStatusEx``, Linux đọc
``/proc/meminfo``. RAM lắp đặt trên Windows được đọc riêng để phân hạng máy,
không thay thế ngân sách bộ nhớ thật. Không đọc được thì trả ``None`` ở trường đó.
"""

from __future__ import annotations

import os


def process_pool_budget_mb() -> float | None:
    """PERF (audit 2026-09-25 §G2): chừa RAM cho Windows/viewer theo RAM thật.

    Đây là admission theo working set từng file, không phải trần worker máy mạnh.
    File nhỏ vẫn dùng toàn bộ CPU; chỉ giảm khi tổng RAM ước lượng không còn vừa.
    """
    total, available = read_memory_status_mb()
    if available is None:
        return None
    if total is not None and total < 16 * 1024:
        return max(0.0, available * 0.6)
    reserve = max(1024.0, (total or available) * 0.1)
    return max(0.0, available - reserve)


def estimate_pdf_worker_mb(source_bytes: int, *, raster_mb: float = 0.0) -> float:
    """Ước lượng admission, KHÔNG phải peak đo được: nguồn + bản copy + workspace.

    Dùng cho pipeline mở/copy cả tài liệu. Nhánh raster cộng working set theo
    kích thước ảnh đã chốt; không dùng số trang làm hệ số nhân file tùy tiện.
    """
    return 256.0 + max(0, source_bytes) * 2 / (1024 * 1024) + max(0.0, raster_mb)


def read_memory_status_mb() -> tuple[float | None, float | None]:
    """Trả ``(RAM OS dùng được, RAM khả dụng)`` theo MiB, không phải RAM lắp đặt."""
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


def read_installed_memory_mb() -> float | None:
    """PERF (audit 2026-09-28 §PERF28.03): đọc RAM lắp đặt từ SMBIOS Windows.

    API trả KiB qua con trỏ 64-bit; giá trị này chỉ dùng chọn hạng phần cứng.
    Ngoài Windows hoặc API thất bại/không có dữ liệu thì caller dùng RAM OS cũ.
    """
    if os.name != "nt":
        return None
    try:
        import ctypes

        read_installed = ctypes.windll.kernel32.GetPhysicallyInstalledSystemMemory
        read_installed.argtypes = [ctypes.POINTER(ctypes.c_ulonglong)]
        read_installed.restype = ctypes.c_int
        memory_kib = ctypes.c_ulonglong()
        if read_installed(ctypes.byref(memory_kib)) and memory_kib.value > 0:
            return memory_kib.value / 1024.0
    except Exception:
        return None
    return None


def memory_tier_mb(
    usable_mb: float | None, installed_mb: float | None
) -> float | None:
    """Chọn hạng phần cứng từ snapshot; hàm thuần, không tự đọc hệ điều hành.

    PERF (audit 2026-09-28 §PERF28.03 B2): kết quả chỉ dùng so ngưỡng tier,
    không thay usable/available trong phép tính dung lượng hoặc admission.
    """
    if usable_mb is not None and usable_mb > 0:
        if installed_mb is not None and installed_mb >= usable_mb:
            return installed_mb
    return usable_mb


def read_memory_tier_mb(usable_mb: float | None) -> float | None:
    """Đọc installed tại biên runtime; policy thuần dùng ``memory_tier_mb``."""
    return memory_tier_mb(usable_mb, read_installed_memory_mb())


def plan_worker_count(
    *,
    kind: str,
    per_worker_mb: float,
    cpu_count: int | None = None,
    hard_ceiling: int | None = None,
    env_override: str | None = None,
) -> tuple[int, str]:
    """Số worker cho một việc nặng, gate theo CẢ CPU lẫn hạng RAM.

    KIENTRUC (audit 2026-07-29 §C.3): trước đây bình bản và preflight chỉ chia theo
    ``cpu_count - 1`` mà KHÔNG đọc RAM. Mỗi worker là một process giữ PDF trong bộ nhớ,
    nên máy 8 GB nhiều lõi vào job lớn là đường ngắn nhất tới OOM/treo. Đây là chiều
    NGƯỢC của rule #1 trong AGENTS.md: máy yếu chưa được bảo vệ.

    Chính sách worker (các budget riêng ở Sticker/PPE không do helper này cấp):

    - Nền: ``cpu_count - 1`` — luôn chừa 1 nhân cho UI/backend.
    - Trần theo hạng RAM: ``<8 GB`` → 1 worker; ``<16 GB`` → 2 worker; ``>=16 GB`` →
      KHÔNG hạ (máy mạnh chạy hết công suất — rule #1).
      Windows ưu tiên RAM lắp đặt hợp lệ, không tính phần dành cho phần cứng là
      máy yếu hơn. Fallback về RAM OS dùng được khi API thiếu/lỗi/mâu thuẫn.
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
    installed_mb = read_installed_memory_mb()
    tier_mb = memory_tier_mb(total_mb, installed_mb)
    # PERF (audit 2026-09-28 §PERF28.03): giống Tauri, chỉ tin SMBIOS nếu không
    # nhỏ hơn RAM OS dùng được. Không làm tròn RAM hay cộng phần reserved vào
    # available/budget. Mất telemetry OS vẫn giữ policy cũ, không tự đoán tier.
    if installed_mb is not None:
        reason_parts.append(f"ram_installed_mb={installed_mb:.0f}")
    if total_mb is not None:
        reason_parts.append(f"ram_usable_mb={total_mb:.0f}")
    is_weak = tier_mb is not None and tier_mb < 16 * 1024

    if tier_mb is not None:
        if tier_mb < 8 * 1024:
            ram_cap = 1
        elif tier_mb < 16 * 1024:
            ram_cap = 2
        else:
            ram_cap = base  # >=16 GB: giữ nguyên full (rule #1)
        if ram_cap < workers:
            workers = ram_cap
        reason_parts.append(f"ram_tier_mb={tier_mb:.0f}->cap{ram_cap}")

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
