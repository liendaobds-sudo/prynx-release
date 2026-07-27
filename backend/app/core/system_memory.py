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
