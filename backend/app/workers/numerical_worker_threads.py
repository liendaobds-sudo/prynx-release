"""Chia luồng BLAS/OpenCV trong worker và khôi phục khi thoát tác vụ.

PERF (audit 2026-09-24 §CUT24.06): biến môi trường đặt sau import NumPy không
đổi BLAS đã nạp. Chỉ điều khiển thư viện đang nạp trong process hiện tại,
không sửa môi trường toàn cục hoặc số worker do planner đã chọn.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
from dataclasses import dataclass
from functools import lru_cache, wraps
import logging
import os
from pathlib import Path
import sys
from threading import RLock

import cv2

logger = logging.getLogger(__name__)
_BUDGET_LOCK = RLock()


@dataclass(frozen=True)
class _BlasControl:
    path: str
    library: object
    get_threads: object
    set_threads: object


def _loaded_library_paths():
    """Đọc module đã nạp; không tìm DLL theo PATH hoặc tải một bản BLAS khác."""
    if sys.platform == "win32":
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.argtypes = []
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.K32EnumProcessModules.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(wintypes.HMODULE), wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel.K32EnumProcessModules.restype = wintypes.BOOL
        kernel.K32GetModuleFileNameExW.argtypes = [
            wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD,
        ]
        kernel.K32GetModuleFileNameExW.restype = wintypes.DWORD
        process = kernel.GetCurrentProcess()
        count = 64
        while True:
            modules = (wintypes.HMODULE * count)()
            needed = wintypes.DWORD()
            if not kernel.K32EnumProcessModules(process, modules, ctypes.sizeof(modules), ctypes.byref(needed)):
                raise ctypes.WinError(ctypes.get_last_error())
            actual = needed.value // ctypes.sizeof(wintypes.HMODULE)
            if actual <= count:
                break
            count = actual
        for module in modules[:actual]:
            buffer = ctypes.create_unicode_buffer(32768)
            if kernel.K32GetModuleFileNameExW(process, module, buffer, len(buffer)):
                yield buffer.value
    elif sys.platform.startswith("linux"):
        seen = set()
        for line in Path("/proc/self/maps").read_text().splitlines():
            parts = line.split(maxsplit=5)
            if len(parts) == 6 and parts[5].startswith("/") and parts[5] not in seen:
                seen.add(parts[5])
                yield parts[5]


@lru_cache(maxsize=None)
def _library_control(path):
    # Handle sống cùng process; tránh LoadLibrary lặp và giữ DLL còn dùng bởi
    # function pointer. Danh sách chỉ có các BLAS thực sự đã nạp.
    library = ctypes.CDLL(path)
    pairs = [
        (f"{prefix}openblas_get_num_threads{suffix}", f"{prefix}openblas_set_num_threads{suffix}")
        for prefix in ("", "scipy_") for suffix in ("", "_", "64_", "_64_")
    ]
    pairs += [("MKL_Get_Max_Threads", "MKL_Set_Num_Threads"),
              ("mkl_get_max_threads", "mkl_set_num_threads")]
    for getter_name, setter_name in pairs:
        getter = getattr(library, getter_name, None)
        setter = getattr(library, setter_name, None)
        if getter is None or setter is None:
            continue
        getter.argtypes, getter.restype = [], ctypes.c_int
        setter.argtypes, setter.restype = [ctypes.c_int], None
        return _BlasControl(path, library, getter, setter)
    return None


def _native_blas_controls():
    controls, seen = [], set()
    for path in _loaded_library_paths():
        name = Path(path).name.lower()
        if not any(marker in name for marker in ("openblas", "mkl_rt")):
            continue
        identity = os.path.normcase(path)
        if identity in seen:
            continue
        seen.add(identity)
        control = _library_control(path)
        if control is not None:
            controls.append(control)
    return controls


def _load_numeric_libraries():
    # SciPy có BLAS riêng với NumPy ở wheel Windows. Nạp trước scope để setter
    # phủ cả solver được import lười bên trong engine, không cần sửa os.environ.
    import numpy.linalg  # noqa: F401
    try:
        import scipy.linalg  # noqa: F401
    except ImportError:
        # Engine vốn hỗ trợ thiếu solver tùy chọn và giữ đường nguồn an toàn.
        pass


@contextmanager
def numerical_thread_budget(threads):
    """Áp đúng ngân sách planner, kể cả giá trị cao; hoàn nguyên cả khi lỗi/hủy."""
    requested = max(1, int(threads))
    with _BUDGET_LOCK:
        _load_numeric_libraries()
        try:
            controls = _native_blas_controls()
        except (OSError, AttributeError):
            logger.warning("Không đọc được BLAS đang nạp để chia luồng worker.", exc_info=True)
            controls = []
        previous_cv = cv2.getNumThreads()
        previous = []
        try:
            for control in controls:
                previous.append((control, control.get_threads()))
                control.set_threads(requested)
            cv2.setNumThreads(requested)
            yield
        finally:
            cv2.setNumThreads(previous_cv)
            for control, count in reversed(previous):
                control.set_threads(count)


def with_worker_thread_budget(function):
    """Bọc entrypoint chunk mà không đổi schema/đối số picklable của pool."""
    @wraps(function)
    def wrapped(args):
        with numerical_thread_budget(args.get("threads_per_worker", 1)):
            return function(args)
    return wrapped
