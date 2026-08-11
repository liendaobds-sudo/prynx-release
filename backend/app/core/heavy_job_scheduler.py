"""Shared admission for CPU/RAM-heavy work across backend feature families."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Callable, Iterator, TypeVar

from starlette.concurrency import run_in_threadpool as _run_in_threadpool

logger = logging.getLogger(__name__)

def _default_heavy_slots() -> tuple[int, str]:
    """Số slot việc nặng mặc định, gate theo RAM (PERF audit 2026-07-29 §C.3).

    Trước đây là hằng số 2 vô điều kiện. Nay:

    - ``<8 GB``  → 1 slot. Đây là phần bị thiếu: hai việc nặng song song (chuyển đổi
      Office, resize, tách nền, upscale) trên máy 8 GB đủ để đẩy máy vào swap.
    - ``<16 GB`` → 2 slot (giữ như cũ).
    - ``>=16 GB`` → 2 slot, **giữ nguyên như cũ một cách CỐ Ý**. Nới lên cho máy mạnh là
      thay đổi hành vi runtime của đúng những feature đã từng treo (xem
      ``docs/BAO_CAO_AUDIT_UPSCALE_TREO_2026-07-28.md``, COM/LibreOffice nhiều instance),
      nên phải đo và duyệt riêng chứ không nới âm thầm trong đợt audit kiến trúc.
      Máy mạnh cũng KHÔNG bị kìm oan: những job trải hết lõi (bình bản, VDP, tem,
      preflight) không đi qua scheduler này mà có trần riêng + process pool riêng.
    - Không đọc được RAM → 2 slot, y như trước.

    ``PRYNX_MAX_HEAVY_JOBS`` vẫn ghi đè được cả hai chiều.
    """
    raw = os.environ.get("PRYNX_MAX_HEAVY_JOBS", "")
    if raw:
        try:
            forced = int(raw)
        except (TypeError, ValueError):
            forced = 0
        if forced > 0:
            return forced, f"env PRYNX_MAX_HEAVY_JOBS={forced}"

    from app.core.system_memory import read_memory_status_mb

    total_mb, _available_mb = read_memory_status_mb()
    if total_mb is None:
        return 2, "ram_total_mb=unknown"
    if total_mb < 8 * 1024:
        return 1, f"ram_total_mb={total_mb:.0f} (<8GB)"
    if total_mb < 16 * 1024:
        return 2, f"ram_total_mb={total_mb:.0f} (<16GB)"
    if total_mb < 64 * 1024:
        return 3, f"ram_total_mb={total_mb:.0f} (>=16GB)"
    return 4, f"ram_total_mb={total_mb:.0f} (>=64GB)"


# ── Trần THEO LOẠI VIỆC (PERF audit 2026-07-29 §C.3b, đợt sau) ──
#
# Nới trần toàn cục cho máy mạnh chỉ an toàn khi có lớp này. Lý do: `heavy_job_slot` gate
# CẢ những việc tự trải hết máy bên trong (bình bản, VDP, so sánh — mỗi job mở tới
# `cpu-1` process). Với trần toàn cục 2, hôm nay đã có thể xảy ra 1 nup + 1 VDP song song
# = ~2×(cpu-1) process cùng giữ PDF trong RAM. Nới lên 3–4 mà không cách ly là nhân tiếp
# con số đó.
#
# Nên: nhóm "dùng hết máy" chia nhau ĐÚNG MỘT suất — chặt hơn hiện trạng, tức đây vừa là
# điều kiện để nới, vừa là một sửa lỗi.
_WHOLE_MACHINE_KINDS = frozenset({"nup", "vdp", "compare"})
_WHOLE_MACHINE_SLOTS = threading.BoundedSemaphore(1)

# Chuyển đổi Office đi qua COM/LibreOffice — nhiều instance cùng lúc là nguồn treo đã có
# lịch sử. Cách ly 1 suất để việc nới trần toàn cục KHÔNG chạm vào đường này.
_SERIAL_KINDS = frozenset({"office"})
_SERIAL_SLOTS = threading.BoundedSemaphore(1)


def _kind_gate(kind: str) -> "threading.BoundedSemaphore | None":
    """Trần phụ theo loại việc, `None` nếu loại đó chỉ chịu trần toàn cục."""
    if kind in _WHOLE_MACHINE_KINDS:
        return _WHOLE_MACHINE_SLOTS
    if kind in _SERIAL_KINDS:
        return _SERIAL_SLOTS
    return None


_MAX_ACTIVE_HEAVY_JOBS, _HEAVY_SLOTS_REASON = _default_heavy_slots()
_HEAVY_JOB_SLOTS = threading.BoundedSemaphore(_MAX_ACTIVE_HEAVY_JOBS)
logger.info(
    "[HEAVY] slot việc nặng = %d (%s)", _MAX_ACTIVE_HEAVY_JOBS, _HEAVY_SLOTS_REASON
)


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


class HeavyJobQueueCancelled(RuntimeError):
    """Job bị hủy khi còn chờ admission, trước khi chiếm thread worker."""


async def _acquire_semaphore_async(
    semaphore: threading.BoundedSemaphore,
    queue_cancelled: Callable[[], bool] | None,
) -> None:
    """Chờ semaphore mà không giữ token AnyIO/Starlette threadpool."""

    def try_acquire() -> bool:
        try:
            return bool(semaphore.acquire(blocking=False))
        except TypeError:
            # Giữ tương thích wrapper/test-double cũ chỉ khai `acquire()`;
            # semaphore production là threading.BoundedSemaphore và luôn đi nhánh trên.
            return bool(semaphore.acquire())

    while not try_acquire():
        if queue_cancelled is not None and queue_cancelled():
            raise HeavyJobQueueCancelled("Job đã bị hủy khi đang chờ tài nguyên.")
        await asyncio.sleep(0.05)
    if queue_cancelled is not None and queue_cancelled():
        semaphore.release()
        raise HeavyJobQueueCancelled("Job đã bị hủy khi đang chờ tài nguyên.")


@contextmanager
def heavy_job_slot(kind: str) -> Iterator[None]:
    """Wait for a shared heavy slot and release it on every exit path.

    PERF (audit 2026-07-29 §C.3b): lấy trần PHỤ theo loại việc TRƯỚC, rồi mới lấy suất
    toàn cục. Thứ tự này là cố định và quan trọng — mọi nơi cùng lấy theo một thứ tự thì
    không thể deadlock. Đảo thứ tự (giữ suất toàn cục rồi chờ trần phụ) sẽ khiến một job
    dùng-hết-máy đang chờ vẫn chiếm suất toàn cục, chặn cả việc nhẹ.
    """
    started = time.monotonic()
    gate = _kind_gate(kind)
    with _STATE_LOCK:
        _WAITING_BY_KIND[kind] = _WAITING_BY_KIND.get(kind, 0) + 1
    if gate is not None:
        gate.acquire()
    try:
        _HEAVY_JOB_SLOTS.acquire()
    except BaseException:
        if gate is not None:
            gate.release()
        with _STATE_LOCK:
            _WAITING_BY_KIND[kind] -= 1
        raise
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
        if gate is not None:
            gate.release()


@asynccontextmanager
async def async_heavy_job_slot(
    kind: str,
    queue_cancelled: Callable[[], bool] | None = None,
) -> AsyncIterator[None]:
    """Admission async dùng chung semaphore với đường sync hiện có.

    PERF (audit 2026-08-09 §LR3.01): waiter phải chờ trước khi vào
    Starlette threadpool; nếu không đủ waiter sẽ giữ hết token và chặn cả
    endpoint hủy/health. Thứ tự khóa vẫn là trần phụ rồi trần toàn cục.
    """

    started = time.monotonic()
    gate = _kind_gate(kind)
    gate_acquired = False
    global_acquired = False
    waiting_registered = True
    active_registered = False
    with _STATE_LOCK:
        _WAITING_BY_KIND[kind] = _WAITING_BY_KIND.get(kind, 0) + 1
    try:
        if gate is not None:
            await _acquire_semaphore_async(gate, queue_cancelled)
            gate_acquired = True
        await _acquire_semaphore_async(_HEAVY_JOB_SLOTS, queue_cancelled)
        global_acquired = True
        with _STATE_LOCK:
            _WAITING_BY_KIND[kind] -= 1
            waiting_registered = False
            _ACTIVE_BY_KIND[kind] = _ACTIVE_BY_KIND.get(kind, 0) + 1
            active_registered = True
        waited_ms = round((time.monotonic() - started) * 1000, 1)
        if waited_ms >= 100:
            logger.info("Heavy scheduler admitted %s after %.1f ms", kind, waited_ms)
        yield
    finally:
        with _STATE_LOCK:
            if waiting_registered:
                _WAITING_BY_KIND[kind] -= 1
            if active_registered:
                _ACTIVE_BY_KIND[kind] -= 1
        if global_acquired:
            _HEAVY_JOB_SLOTS.release()
        if gate_acquired and gate is not None:
            gate.release()


def scheduled_job(kind: str) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorate a fixed-executor worker with shared heavy-job admission."""
    def decorate(function: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(function)
        def wrapped(*args: Any, **kwargs: Any) -> T:
            with heavy_job_slot(kind):
                return function(*args, **kwargs)
        return wrapped
    return decorate


async def run_heavy_in_threadpool(function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run one PDF-tool operation off-loop and under the shared scheduler."""
    return await run_scheduled_in_threadpool("pdf-tools", function, *args, **kwargs)


async def run_scheduled_in_threadpool(
    kind: str,
    function: Callable[..., T],
    *args: Any,
    queue_cancelled: Callable[[], bool] | None = None,
    **kwargs: Any,
) -> T:
    """Run synchronous heavy work off-loop under the shared scheduler."""
    async with async_heavy_job_slot(kind, queue_cancelled):
        return await _run_in_threadpool(function, *args, **kwargs)
