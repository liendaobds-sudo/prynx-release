"""Repeatable performance sampling for heavy jobs (P0-0 baseline).

Records per-process peak RSS, wall-clock duration, output size and temp-disk
growth for a heavy job so the perf-plan claims can be checked against real
numbers instead of static reasoning.

Design constraints (match the rest of the codebase):
  - No psutil dependency. RSS is read via ctypes on Windows and /proc on Linux,
    the same style as app.workers.sticker_engine._read_memory_status.
  - Zero overhead unless enabled. Sampling only runs when PRYNX_PERF=1 (or a
    debug build sets it), mirroring the Rust perf_enabled() gate.
  - Never raises into the job. Every failure path degrades to None/no-op so a
    measurement bug can never break the job it measures.
"""
from __future__ import annotations

import glob
import os
import threading
import time
from typing import Optional


def perf_enabled() -> bool:
    """True when perf sampling should run. Mirrors the Rust-side gate."""
    val = os.environ.get("PRYNX_PERF", "")
    return val == "1" or val.lower() == "true"


def _proc_rss_mb(pid: int) -> Optional[float]:
    """Current working-set / RSS of one process in MB. None if unreadable."""
    if pid <= 0:
        return None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
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

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            PROCESS_QUERY_INFORMATION = 0x0400
            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid
            ) or kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
            if not handle:
                return None
            try:
                counters = PROCESS_MEMORY_COUNTERS()
                counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
                if psapi.GetProcessMemoryInfo(
                    handle, ctypes.byref(counters), counters.cb
                ):
                    return float(counters.WorkingSetSize) / (1024.0 * 1024.0)
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
        return None
    # Linux / POSIX
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return float(line.split()[1]) / 1024.0
    except Exception:
        return None
    return None


def _dir_size_mb(path: str) -> Optional[float]:
    """Total size of files under `path` in MB. None if unreadable."""
    if not path or not os.path.isdir(path):
        return None
    total = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat().st_size
                except OSError:
                    continue
    except OSError:
        return None
    return float(total) / (1024.0 * 1024.0)


def _process_parent_map() -> dict[int, list[int]]:
    """Return parent PID -> child PIDs without adding a psutil dependency."""
    parents: dict[int, list[int]] = {}
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class PROCESSENTRY32W(ctypes.Structure):
                _fields_ = [
                    ("dwSize", wintypes.DWORD),
                    ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG),
                    ("dwFlags", wintypes.DWORD),
                    ("szExeFile", wintypes.WCHAR * 260),
                ]

            snapshot = ctypes.windll.kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
            if snapshot in (0, ctypes.c_void_p(-1).value):
                return parents
            try:
                entry = PROCESSENTRY32W()
                entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
                has_entry = ctypes.windll.kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
                while has_entry:
                    parents.setdefault(int(entry.th32ParentProcessID), []).append(int(entry.th32ProcessID))
                    has_entry = ctypes.windll.kernel32.Process32NextW(snapshot, ctypes.byref(entry))
            finally:
                ctypes.windll.kernel32.CloseHandle(snapshot)
        except Exception:
            return {}
        return parents

    try:
        with os.scandir("/proc") as entries:
            for entry in entries:
                if not entry.name.isdigit():
                    continue
                try:
                    with open(f"/proc/{entry.name}/stat", "r", encoding="utf-8") as handle:
                        _head, _separator, tail = handle.read().rpartition(")")
                    fields = tail.strip().split()
                    parent_pid = int(fields[1])
                    parents.setdefault(parent_pid, []).append(int(entry.name))
                except (OSError, ValueError, IndexError):
                    continue
    except OSError:
        return {}
    return parents


def _process_tree_pids(root_pid: int) -> set[int]:
    if root_pid <= 0:
        return set()
    parents = _process_parent_map()
    pending = [root_pid]
    result: set[int] = set()
    while pending:
        pid = pending.pop()
        if pid in result:
            continue
        result.add(pid)
        pending.extend(parents.get(pid, ()))
    return result


def _process_tree_rss_mb(root_pid: int) -> Optional[float]:
    readings = [_proc_rss_mb(pid) for pid in _process_tree_pids(root_pid)]
    valid = [value for value in readings if value is not None]
    return sum(valid) if valid else None


def _paths_size_mb(patterns: tuple[str, ...]) -> Optional[float]:
    """Size of the files matching job-scoped patterns, without double counting."""
    if not patterns:
        return None
    total = 0
    matched = False
    for path in {path for pattern in patterns for path in glob.glob(pattern)}:
        try:
            if os.path.isfile(path):
                total += os.path.getsize(path)
                matched = True
        except OSError:
            continue
    return float(total) / (1024.0 * 1024.0) if matched else 0.0


class ProcessRssSampler:
    """Poll process-tree RSS and job-scoped temporary files for their peaks.

    Usage:
        sampler = ProcessRssSampler(pid, temp_patterns=("/tmp/job_*.pdf",))
        sampler.start()
        ...            # let the job run
        sampler.stop()
        sampler.peak_mb       # highest summed process-tree RSS
        sampler.peak_temp_mb  # highest job-scoped temporary-file usage

    A no-op when perf sampling is disabled, so callers never need to branch on
    perf_enabled().
    """

    def __init__(self, pid: int, interval_ms: int = 250, temp_patterns: tuple[str, ...] = ()):
        self.pid = pid
        self.interval = max(0.05, interval_ms / 1000.0)
        self.temp_patterns = temp_patterns
        self.peak_mb: Optional[float] = None
        self.peak_temp_mb: Optional[float] = None
        self.sample_count = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _sample(self) -> None:
        rss = _process_tree_rss_mb(self.pid)
        if rss is not None and (self.peak_mb is None or rss > self.peak_mb):
            self.peak_mb = rss
        temp_mb = _paths_size_mb(self.temp_patterns)
        if temp_mb is not None and (self.peak_temp_mb is None or temp_mb > self.peak_temp_mb):
            self.peak_temp_mb = temp_mb
        self.sample_count += 1

    def _run(self) -> None:
        while not self._stop.is_set():
            self._sample()
            self._stop.wait(self.interval)
        # One final read catches resources that remain immediately before exit.
        self._sample()

    def start(self) -> None:
        if not perf_enabled():
            return
        self._thread = threading.Thread(
            target=self._run, name=f"rss-sampler-{self.pid}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout=2.0)


def write_job_perf(record: dict) -> None:
    """Append one job perf record as a line to logs/job_perf.log.

    No-op unless perf sampling is enabled. Never raises.
    """
    if not perf_enabled():
        return
    try:
        line_parts = [f"{k}={v}" for k, v in record.items() if v is not None]
        line = "[JOBPERF] " + " ".join(line_parts)
        log_dir = os.environ.get("PRYNX_PERF_DIR") or os.path.join(os.getcwd(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(log_dir, "job_perf.log"), "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {line}\n")
    except Exception:
        pass
