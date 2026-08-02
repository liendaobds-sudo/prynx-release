"""Registry vòng đời cho các job Combine manifest chạy nền."""
from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional

from app.core.heavy_job_scheduler import heavy_job_slot, max_active_heavy_jobs

logger = logging.getLogger(__name__)


class CombineJobQueueFull(RuntimeError):
    """Hàng đợi Combine đã hết chỗ nhận thêm job."""


class CombineJobPublicError(RuntimeError):
    """Lỗi đã được làm sạch và có thể trả cho người dùng."""


@dataclass(frozen=True)
class CombineJobSnapshot:
    job_id: str
    status: str
    terminal: bool
    cancel_requested: bool
    progress: int
    completed: int
    total: int
    message: Optional[str]
    return_path: bool
    result_path: str
    created_at: float
    started_at: Optional[float]
    completed_at: Optional[float]


@dataclass(frozen=True)
class CombineJobCancelResult:
    job_id: str
    status: str
    cancelled: bool
    already_cancelled: bool
    terminal: bool
    message: Optional[str] = None


@dataclass
class _CombineJobRecord:
    job_id: str
    result_path: str
    partial_path: str
    owned_paths: tuple[str, ...]
    return_path: bool
    status: str = "queued"
    terminal: bool = False
    progress: int = 0
    completed: int = 0
    total: int = 0
    message: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.monotonic)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    future: Optional[Future] = None
    submission_slot_released: bool = False


Worker = Callable[[], None]
SlotFactory = Callable[[], AbstractContextManager]


def _positive_env_int(name: str) -> Optional[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _remove_paths(paths: Iterable[str]) -> None:
    for raw_path in paths:
        if not raw_path:
            continue
        try:
            Path(raw_path).unlink(missing_ok=True)
        except OSError:
            logger.warning("Không thể dọn artifact Combine: %s", raw_path, exc_info=True)


class CombineJobRegistry:
    """Chạy Combine ngoài event loop, có progress/cancel/TTL và cleanup đúng chủ sở hữu."""

    def __init__(
        self,
        *,
        max_workers: Optional[int] = None,
        max_queued: Optional[int] = None,
        ttl_seconds: float = 60 * 60,
        slot_factory: Optional[SlotFactory] = None,
    ) -> None:
        workers = max(1, max_workers or max_active_heavy_jobs())
        configured_queue = _positive_env_int("PRYNX_MAX_COMBINE_QUEUE")
        if max_queued is None:
            # PERF (audit 2026-08-02 §COMB.2): queue tăng theo số slot đã gate RAM;
            # máy mạnh không bị giữ ở cùng trần với máy yếu. Env vẫn ghi đè hai chiều.
            max_queued = configured_queue if configured_queue is not None else max(4, workers * 4)
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._slot_factory = slot_factory or (lambda: heavy_job_slot("pdf-tools"))
        self._executor = ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="prynx-combine",
        )
        self._submission_slots = threading.BoundedSemaphore(workers + max(0, max_queued))
        self._lock = threading.RLock()
        self._jobs: dict[str, _CombineJobRecord] = {}
        self._closed = False
        self._sweeper_stop = threading.Event()
        sweep_interval = min(60.0, max(0.05, self._ttl_seconds / 2.0))
        self._sweeper_thread = threading.Thread(
            target=self._sweep_loop,
            args=(sweep_interval,),
            name="prynx-combine-sweeper",
            daemon=True,
        )
        self._sweeper_thread.start()

    @staticmethod
    def _snapshot(record: _CombineJobRecord) -> CombineJobSnapshot:
        return CombineJobSnapshot(
            job_id=record.job_id,
            status=record.status,
            terminal=record.terminal,
            cancel_requested=record.cancel_event.is_set(),
            progress=record.progress,
            completed=record.completed,
            total=record.total,
            message=record.message,
            return_path=record.return_path,
            result_path=record.result_path,
            created_at=record.created_at,
            started_at=record.started_at,
            completed_at=record.completed_at,
        )

    def _release_submission_slot_locked(self, record: _CombineJobRecord) -> None:
        if record.submission_slot_released:
            return
        record.submission_slot_released = True
        self._submission_slots.release()

    def _finalize_locked(
        self,
        record: _CombineJobRecord,
        status: str,
        message: Optional[str] = None,
    ) -> None:
        if record.terminal:
            return
        record.status = status
        record.terminal = True
        record.message = message
        record.updated_at = time.monotonic()
        record.completed_at = time.time()
        if status == "completed":
            record.progress = 100
            record.completed = max(record.completed, record.total)

    def _cleanup_after_terminal(self, record: _CombineJobRecord) -> None:
        paths = [*record.owned_paths, record.partial_path]
        if record.status != "completed":
            paths.append(record.result_path)
        _remove_paths(paths)

    @staticmethod
    def _expired_paths(record: _CombineJobRecord) -> list[str]:
        paths = [*record.owned_paths, record.partial_path]
        # FILEIO (audit 2026-08-02 §COMB.2): path trả cho workspace phải sống như
        # output sync cũ (cleanup filesystem 26 giờ), không bị registry TTL 1 giờ
        # xóa dưới một tab đang mở. Kết quả download thường vẫn dọn theo TTL job.
        if not (record.status == "completed" and record.return_path):
            paths.append(record.result_path)
        return paths

    def _sweep(self) -> None:
        now = time.monotonic()
        with self._lock:
            expired = [
                record
                for record in self._jobs.values()
                if record.terminal and now - record.updated_at >= self._ttl_seconds
            ]
            for record in expired:
                self._jobs.pop(record.job_id, None)
        for record in expired:
            _remove_paths(self._expired_paths(record))

    def _sweep_loop(self, interval_seconds: float) -> None:
        while not self._sweeper_stop.wait(interval_seconds):
            try:
                self._sweep()
            except Exception:
                logger.warning("Không thể quét TTL job Combine", exc_info=True)

    def submit(
        self,
        *,
        job_id: str,
        result_path: str,
        partial_path: str,
        owned_paths: Iterable[str],
        return_path: bool,
        worker: Worker,
    ) -> CombineJobSnapshot:
        self._sweep()
        owned = tuple(str(path) for path in owned_paths)
        if not self._submission_slots.acquire(blocking=False):
            _remove_paths([*owned, partial_path, result_path])
            raise CombineJobQueueFull(
                "Hàng đợi ghép PDF đang đầy. Vui lòng chờ job hiện tại hoàn tất."
            )

        record = _CombineJobRecord(
            job_id=job_id,
            result_path=result_path,
            partial_path=partial_path,
            owned_paths=owned,
            return_path=return_path,
        )
        with self._lock:
            if self._closed:
                self._submission_slots.release()
                _remove_paths([*owned, partial_path, result_path])
                raise CombineJobQueueFull("Dịch vụ ghép PDF đang dừng.")
            if job_id in self._jobs:
                self._submission_slots.release()
                _remove_paths([*owned, partial_path, result_path])
                raise CombineJobPublicError("Mã job ghép PDF đang được sử dụng.")
            self._jobs[job_id] = record

        try:
            future = self._executor.submit(self._run_job, record, worker)
        except BaseException:
            with self._lock:
                self._jobs.pop(job_id, None)
                self._release_submission_slot_locked(record)
            _remove_paths([*owned, partial_path, result_path])
            raise
        with self._lock:
            record.future = future
            return self._snapshot(record)

    def _run_job(self, record: _CombineJobRecord, worker: Worker) -> None:
        try:
            with self._slot_factory():
                if record.cancel_event.is_set():
                    raise InterruptedError("Đã hủy ghép PDF")
                with self._lock:
                    record.status = "starting"
                    record.started_at = time.time()
                    record.updated_at = time.monotonic()
                worker()
                with self._lock:
                    # Cancel và complete dùng cùng khóa để không có cửa sổ job vừa
                    # trả completed vừa mang cancel_requested=true.
                    if record.cancel_event.is_set():
                        raise InterruptedError("Đã hủy ghép PDF")
                    self._finalize_locked(record, "completed")
        except BaseException as exc:
            cancelled = record.cancel_event.is_set() or isinstance(exc, InterruptedError)
            if cancelled:
                with self._lock:
                    self._finalize_locked(record, "cancelled", "Đã hủy ghép PDF.")
            else:
                if isinstance(exc, (ValueError, CombineJobPublicError)):
                    message = str(exc)
                else:
                    message = "Không thể ghép PDF. Vui lòng thử lại."
                    logger.exception("Job Combine %s thất bại", record.job_id)
                with self._lock:
                    self._finalize_locked(record, "failed", message)
        finally:
            self._cleanup_after_terminal(record)
            with self._lock:
                self._release_submission_slot_locked(record)

    def update_progress(
        self,
        job_id: str,
        status: str,
        completed: int,
        total: int,
        message: Optional[str] = None,
    ) -> None:
        safe_total = max(0, int(total))
        safe_completed = min(max(0, int(completed)), safe_total) if safe_total else 0
        progress = int(safe_completed * 100 / safe_total) if safe_total else 0
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None or record.terminal:
                return
            record.completed = safe_completed
            record.total = safe_total
            record.progress = min(100, max(0, progress))
            record.updated_at = time.monotonic()
            if not record.cancel_event.is_set():
                record.status = status
            if message is not None:
                record.message = message

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            return bool(record and record.cancel_event.is_set())

    def get(
        self,
        job_id: str,
        *,
        refresh_ttl: bool = False,
    ) -> Optional[CombineJobSnapshot]:
        self._sweep()
        with self._lock:
            record = self._jobs.get(job_id)
            if record is not None and refresh_ttl and record.terminal:
                record.updated_at = time.monotonic()
            return self._snapshot(record) if record is not None else None

    def cancel(self, job_id: str) -> CombineJobCancelResult:
        self._sweep()
        queued_cancelled = False
        record: Optional[_CombineJobRecord]
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return CombineJobCancelResult(
                    job_id=job_id,
                    status="not_found",
                    cancelled=False,
                    already_cancelled=False,
                    terminal=True,
                    message="Không tìm thấy job ghép PDF.",
                )
            already_cancelled = record.cancel_event.is_set()
            if record.terminal:
                return CombineJobCancelResult(
                    job_id=job_id,
                    status=record.status,
                    cancelled=record.status == "cancelled",
                    already_cancelled=record.status == "cancelled",
                    terminal=True,
                    message=record.message,
                )

            record.cancel_event.set()
            future = record.future
            if future is not None and future.cancel():
                self._finalize_locked(record, "cancelled", "Đã hủy ghép PDF.")
                self._release_submission_slot_locked(record)
                queued_cancelled = True
            else:
                record.status = "cancel_requested"
                record.updated_at = time.monotonic()
            result = CombineJobCancelResult(
                job_id=job_id,
                status=record.status,
                cancelled=True,
                already_cancelled=already_cancelled,
                terminal=record.terminal,
                message=record.message,
            )
        if queued_cancelled and record is not None:
            self._cleanup_after_terminal(record)
        return result

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._sweeper_stop.set()
            records = list(self._jobs.values())
            for record in records:
                if not record.terminal:
                    record.cancel_event.set()
                    if record.future is not None and record.future.cancel():
                        self._finalize_locked(record, "cancelled", "Đã hủy ghép PDF.")
                        self._release_submission_slot_locked(record)
        self._sweeper_thread.join(timeout=1.0)
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            self._jobs.clear()
        for record in records:
            _remove_paths(self._expired_paths(record))


combine_jobs = CombineJobRegistry()
