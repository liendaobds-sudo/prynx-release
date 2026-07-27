"""Shared admission for CPU/RAM-heavy work across backend feature families."""

from __future__ import annotations

import functools
import logging
import os
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator, TypeVar

from starlette.concurrency import run_in_threadpool as _run_in_threadpool

logger = logging.getLogger(__name__)

_MAX_ACTIVE_HEAVY_JOBS = max(
    1,
    int(os.environ.get("PRYNX_MAX_HEAVY_JOBS", "2") or "2"),
)
_HEAVY_JOB_SLOTS = threading.BoundedSemaphore(_MAX_ACTIVE_HEAVY_JOBS)


def max_active_heavy_jobs() -> int:
    """Số việc nặng được phép chạy cùng lúc.

    Công khai để những nơi cấp **ngân sách bộ nhớ** chia theo đúng số việc song
    song. Nếu mỗi việc tự lấy cả phần RAM còn trống thì N việc cùng cam kết N lần
    lượng đó — trần bảo vệ mất tác dụng đúng lúc cần nhất.
    """
    return _MAX_ACTIVE_HEAVY_JOBS
_STATE_LOCK = threading.Lock()
_ACTIVE_BY_KIND: dict[str, int] = {}
_WAITING_BY_KIND: dict[str, int] = {}

T = TypeVar("T")


@contextmanager
def heavy_job_slot(kind: str) -> Iterator[None]:
    """Wait for a shared heavy slot and release it on every exit path."""
    started = time.monotonic()
    with _STATE_LOCK:
        _WAITING_BY_KIND[kind] = _WAITING_BY_KIND.get(kind, 0) + 1
    _HEAVY_JOB_SLOTS.acquire()
    with _STATE_LOCK:
        _WAITING_BY_KIND[kind] -= 1
        _ACTIVE_BY_KIND[kind] = _ACTIVE_BY_KIND.get(kind, 0) + 1
    try:
        waited_ms = round((time.monotonic() - started) * 1000, 1)
        if waited_ms >= 100:
            logger.info("Heavy scheduler admitted %s after %.1f ms", kind, waited_ms)
        yield
    finally:
        with _STATE_LOCK:
            _ACTIVE_BY_KIND[kind] -= 1
        _HEAVY_JOB_SLOTS.release()


def scheduled_job(kind: str) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorate a fixed-executor worker with shared heavy-job admission."""
    def decorate(function: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(function)
        def wrapped(*args: Any, **kwargs: Any) -> T:
            with heavy_job_slot(kind):
                return function(*args, **kwargs)
        return wrapped
    return decorate


def _run_heavy(kind: str, function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    with heavy_job_slot(kind):
        return function(*args, **kwargs)


async def run_heavy_in_threadpool(function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run one PDF-tool operation off-loop and under the shared scheduler."""
    return await run_scheduled_in_threadpool("pdf-tools", function, *args, **kwargs)


async def run_scheduled_in_threadpool(
    kind: str, function: Callable[..., T], *args: Any, **kwargs: Any
) -> T:
    """Run synchronous heavy work off-loop under the shared scheduler."""
    return await _run_in_threadpool(_run_heavy, kind, function, *args, **kwargs)
