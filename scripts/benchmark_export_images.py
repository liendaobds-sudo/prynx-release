"""Benchmark read-only cho pipeline export ảnh PDF.

Chạy trên Windows với backend venv:

    backend\venv\Scripts\python.exe scripts\benchmark_export_images.py

Không sửa file nguồn; output tạm tự dọn sau khi đo.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF = ROOT / "backend" / "tests" / "preflight_fixtures" / "pdfs" / "13_multipage_15.pdf"


def _process_memory_bytes(pid: int) -> tuple[int, int] | None:
    """Đọc working set/private bytes của chính process benchmark trên Windows."""
    if os.name != "nt":
        return None
    try:
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000 | 0x0400, False, pid)
        if not handle:
            return None
        try:
            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            if not psapi.GetProcessMemoryInfo(
                handle, ctypes.byref(counters), ctypes.sizeof(counters)
            ):
                return None
            return int(counters.WorkingSetSize), int(counters.PagefileUsage)
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return None


def _sample_peak_memory(stop: threading.Event, state: dict[str, int]) -> None:
    while not stop.is_set():
        memory = _process_memory_bytes(os.getpid())
        if memory is not None:
            state["sample_count"] += 1
            state["peak_working_set"] = max(state["peak_working_set"], memory[0])
            state["peak_private"] = max(state["peak_private"], memory[1])
        stop.wait(0.025)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--color-mode", choices=("rgb", "gray", "cmyk"), default="rgb")
    parser.add_argument("--multipage-tiff", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "backend"))
    from app.api.routes.export import render_pdf_to_images

    if not args.pdf.exists():
        raise FileNotFoundError(args.pdf)
    with tempfile.TemporaryDirectory(prefix="prynx_export_bench_") as temp_dir:
        memory_stop = threading.Event()
        memory_state = {
            "sample_count": 0,
            "peak_working_set": 0,
            "peak_private": 0,
        }
        memory_thread = threading.Thread(
            target=_sample_peak_memory,
            args=(memory_stop, memory_state),
            daemon=True,
            name="export-memory-sampler",
        )
        memory_thread.start()
        started = time.perf_counter()
        try:
            files = render_pdf_to_images(
                str(args.pdf),
                temp_dir,
                fmt="tiff" if args.multipage_tiff or args.color_mode == "cmyk" else "png",
                dpi=args.dpi,
                color_mode=args.color_mode,
                multipage_tiff=args.multipage_tiff,
            )
            elapsed = time.perf_counter() - started
        finally:
            memory_stop.set()
            memory_thread.join(timeout=1.0)
        total_bytes = sum(os.path.getsize(path) for path in files)
    print(json.dumps({
        "pdf": str(args.pdf),
        "pages": len(files),
        "dpi": args.dpi,
        "color_mode": args.color_mode,
        "multipage_tiff": args.multipage_tiff,
        "elapsed_s": round(elapsed, 4),
        "artifact_bytes": total_bytes,
        "per_page_ms": round(elapsed * 1000 / max(1, len(files)), 2),
        "memory_measurement": "windows-process-working-set-private" if memory_state["sample_count"] else "unavailable",
        "memory_sample_count": memory_state["sample_count"],
        "peak_working_set_mib": round(memory_state["peak_working_set"] / (1024 * 1024), 3) if memory_state["sample_count"] else None,
        "peak_private_mib": round(memory_state["peak_private"] / (1024 * 1024), 3) if memory_state["sample_count"] else None,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
