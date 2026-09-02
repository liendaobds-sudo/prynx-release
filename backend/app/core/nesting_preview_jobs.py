"""Lifecycle bất đồng bộ cho preview nesting theo đường bế.

PV-A1 (audit 2026-08-30): endpoint preview đồng bộ vẫn được giữ tương thích, còn
client cần progress/cancel dùng registry này. Registry không tạo executor hoặc sweeper
riêng: Starlette cấp threadpool, ``asyncio.create_task`` giữ coroutine, và TTL được dọn
lazy khi có request kế tiếp.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
DEFAULT_TTL_SECONDS = 60 * 60
PREVIEW_CANCELLED_CODE = "NESTING_PREVIEW_CANCELLED"


def derive_preview_owner(license_info: Mapping[str, Any] | None) -> str:
    """Định danh owner từ thông tin license phía server, không nhận từ client."""

    info = license_info or {}
    material = (
        f"{info.get('license_key') or ''}\x00{info.get('hwid') or ''}"
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class PreviewJobSnapshot:
    job_id: str
    status: str
    terminal: bool
    cancel_requested: bool
    created_at: float
    started_at: float | None
    completed_at: float | None
    progress: dict[str, Any] | None
    error_code: str | None
    message: str | None
    has_result: bool


@dataclass(frozen=True, slots=True)
class PreviewCancelOutcome:
    job_id: str
    status: str
    cancelled: bool
    already_cancelled: bool
    terminal: bool


@dataclass(slots=True)
class _PreviewJobRecord:
    job_id: str
    owner: str
    request: Any
    source_path: str
    #: §B10-5: entitlement đã kiểm lúc submit, giữ lại để cổng chất lượng dựng được preview
    #: đường cũ trong worker (đường cũ tự kiểm entitlement lần nữa).
    license_info: Any = None
    status: str = "queued"
    terminal: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None
    completed_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task[None] | None = None
    progress: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    message: str | None = None


Runner = Callable[..., dict[str, Any]]


def _default_runner(request: Any, **kwargs: Any) -> dict[str, Any]:
    from app.core.nesting_preview_capacity import build_nesting_preview
    from app.core.nesting_quality_gate import (
        GRID_PROBE_STRATEGY,
        GridBeatsNestingSignal,
    )
    from app.api.routes.imposition import preview_layout

    license_info = kwargs.pop("license_info", None)
    effective_license = license_info if isinstance(license_info, dict) else {}

    def _legacy_preview_for_page(page_index: int) -> Mapping[str, Any]:
        """Dựng đúng layout legacy của một mẫu bằng route production hiện có."""

        updates: dict[str, Any] = {
            "strategy": GRID_PROBE_STRATEGY,
            "page_idx": int(page_index),
        }
        shapes = getattr(request, "detected_shapes_by_page", None)
        if isinstance(shapes, Mapping):
            shape = shapes.get(str(page_index), shapes.get(page_index))
            if shape is not None:
                updates["shape_type"] = shape
        params = getattr(request, "detected_shape_params_by_page", None)
        if isinstance(params, Mapping):
            shape_props = params.get(str(page_index), params.get(page_index))
            if isinstance(shape_props, Mapping):
                updates["shape_props"] = dict(shape_props)
        return preview_layout(request.model_copy(update=updates), effective_license)

    try:
        return build_nesting_preview(
            request,
            legacy_preview_for_page=_legacy_preview_for_page,
            **kwargs,
        )
    except GridBeatsNestingSignal as signal:
        # Chỉ còn đường dự phòng khi legacy layout của một mẫu không dựng được geometry.
        # Bình thường S&R đã công bố publication hybrid per-design ngay trong builder.
        logger.info(
            "[NEST-GATE] job preview fallback: lưới %s ≥ nesting %s ⇒ trả layout đường cũ",
            signal.grid_capacity,
            signal.nesting_capacity,
        )
        return preview_layout(
            request.model_copy(update={"strategy": GRID_PROBE_STRATEGY}),
            effective_license,
        )


class NestingPreviewJobRegistry:
    """Registry nhẹ cho job preview, an toàn giữa event loop và worker thread."""

    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        runner: Runner | None = None,
    ) -> None:
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._runner = runner or _default_runner
        self._lock = threading.RLock()
        self._jobs: dict[str, _PreviewJobRecord] = {}

    @staticmethod
    def _snapshot(record: _PreviewJobRecord) -> PreviewJobSnapshot:
        progress = dict(record.progress) if record.progress is not None else None
        if record.cancel_event.is_set():
            progress = progress or {}
            progress.update(
                phase="cancelled" if record.terminal else "cancel_requested",
                messageCode="cancelled_by_user",
            )
        return PreviewJobSnapshot(
            job_id=record.job_id,
            status=record.status,
            terminal=record.terminal,
            cancel_requested=record.cancel_event.is_set(),
            created_at=record.created_at,
            started_at=record.started_at,
            completed_at=record.completed_at,
            progress=progress,
            error_code=record.error_code,
            message=record.message,
            has_result=record.result is not None,
        )

    def _sweep_locked(self) -> None:
        now = time.monotonic()
        expired = [
            job_id
            for job_id, record in self._jobs.items()
            if record.terminal and now - record.updated_at >= self._ttl_seconds
        ]
        for job_id in expired:
            self._jobs.pop(job_id, None)

    def _get_locked(self, job_id: str, owner: str) -> _PreviewJobRecord | None:
        record = self._jobs.get(job_id)
        if record is None or record.owner != owner:
            return None
        return record

    def submit(
        self,
        *,
        owner: str,
        request: Any,
        source_path: str,
        license_info: Any = None,
    ) -> PreviewJobSnapshot:
        """Nhận job và lập lịch; caller phải đang ở trong event loop FastAPI."""

        job_id = secrets.token_hex(16)
        record = _PreviewJobRecord(
            job_id=job_id,
            owner=str(owner),
            request=request,
            source_path=str(source_path),
            license_info=license_info,
            progress={"phase": "queued", "progress": 0.0, "attempt": 0, "elapsedMs": 0},
        )
        with self._lock:
            self._sweep_locked()
            self._jobs[job_id] = record
        try:
            task = asyncio.create_task(
                self._run_job(record), name=f"nesting-preview-{job_id[:8]}"
            )
        except BaseException:
            with self._lock:
                self._jobs.pop(job_id, None)
            raise
        with self._lock:
            record.task = task
            return self._snapshot(record)

    def _on_progress(
        self, record: _PreviewJobRecord, progress: Mapping[str, Any]
    ) -> None:
        raw = dict(progress)
        with self._lock:
            if record.terminal or record.cancel_event.is_set():
                return
            previous = record.progress or {}

            def _monotonic_number(key: str, default: float = 0.0) -> float:
                try:
                    old = float(previous.get(key, default) or default)
                    new = float(raw.get(key, old) or old)
                except (TypeError, ValueError):
                    return float(previous.get(key, default) or default)
                return max(old, new)

            normalized = dict(previous)
            normalized.update(raw)
            normalized["phase"] = str(raw.get("phase") or "running")
            normalized["progress"] = min(1.0, _monotonic_number("progress"))
            normalized["attempt"] = int(_monotonic_number("attempt"))
            normalized["elapsedMs"] = int(_monotonic_number("elapsedMs"))
            record.progress = normalized
            record.updated_at = time.monotonic()

    def _finalize_cancelled_locked(self, record: _PreviewJobRecord) -> None:
        record.status = "cancelled"
        record.terminal = True
        record.result = None
        record.error_code = PREVIEW_CANCELLED_CODE
        record.message = "Đã hủy preview nesting."
        record.completed_at = record.completed_at or time.time()
        record.updated_at = time.monotonic()
        progress = dict(record.progress or {})
        progress.update(
            phase="cancelled",
            messageCode="cancelled_by_user",
        )
        record.progress = progress

    async def _run_job(self, record: _PreviewJobRecord) -> None:
        try:
            with self._lock:
                if record.cancel_event.is_set() or record.terminal:
                    self._finalize_cancelled_locked(record)
                    return
                record.status = "running"
                record.started_at = time.time()
                record.updated_at = time.monotonic()
                record.progress = {
                    **(record.progress or {}),
                    "phase": "running",
                }

            result = await run_in_threadpool(
                self._runner,
                record.request,
                source_path=record.source_path,
                job_id=record.job_id,
                cancel_event=record.cancel_event,
                progress_callback=lambda value: self._on_progress(record, value),
                subscriber_id=record.job_id,
                license_info=record.license_info,
            )
            if not isinstance(result, dict):
                raise TypeError("Kết quả preview nesting phải là object JSON.")
            with self._lock:
                # Publication fence: cancel luôn thắng, kể cả solver vừa trả kết quả.
                if record.cancel_event.is_set() or record.status == "cancelled":
                    self._finalize_cancelled_locked(record)
                    return
                record.status = "completed"
                record.terminal = True
                record.result = result
                record.completed_at = time.time()
                record.updated_at = time.monotonic()
                record.progress = {
                    **(record.progress or {}),
                    "phase": "completed",
                    "progress": 1.0,
                }
        except BaseException as exc:  # mọi lỗi phải thành trạng thái truy vấn được
            with self._lock:
                cancelled = record.cancel_event.is_set() or isinstance(
                    exc, (InterruptedError, asyncio.CancelledError)
                )
                if getattr(exc, "code", None) == "MIXED_NESTING_CANCELLED":
                    cancelled = True
                if cancelled:
                    record.cancel_event.set()
                    self._finalize_cancelled_locked(record)
                    return
                if record.terminal:
                    return
                record.status = "failed"
                record.terminal = True
                record.result = None
                record.completed_at = time.time()
                record.updated_at = time.monotonic()
                if isinstance(exc, ValueError):
                    record.error_code = "NESTING_PREVIEW_INVALID_REQUEST"
                    record.message = str(exc)
                else:
                    record.error_code = "NESTING_PREVIEW_FAILED"
                    record.message = "Không thể tạo preview nesting. Vui lòng thử lại."
                    logger.exception("Job preview nesting %s thất bại", record.job_id)
                record.progress = {
                    **(record.progress or {}),
                    "phase": "failed",
                }

    def get(self, job_id: str, owner: str) -> PreviewJobSnapshot | None:
        with self._lock:
            self._sweep_locked()
            record = self._get_locked(job_id, owner)
            return self._snapshot(record) if record is not None else None

    def get_result(self, job_id: str, owner: str) -> dict[str, Any] | None:
        with self._lock:
            self._sweep_locked()
            record = self._get_locked(job_id, owner)
            if (
                record is None
                or record.status != "completed"
                or record.cancel_event.is_set()
                or record.result is None
            ):
                return None
            record.updated_at = time.monotonic()
            return dict(record.result)

    def cancel(self, job_id: str, owner: str) -> PreviewCancelOutcome | None:
        with self._lock:
            self._sweep_locked()
            record = self._get_locked(job_id, owner)
            if record is None:
                return None
            if record.terminal:
                already = record.status == "cancelled"
                return PreviewCancelOutcome(
                    job_id=job_id,
                    status=record.status,
                    cancelled=already,
                    already_cancelled=already,
                    terminal=True,
                )
            already = record.cancel_event.is_set()
            record.cancel_event.set()
            self._finalize_cancelled_locked(record)

        # Tách subscriber ngoài khóa registry. Store quyết định có hủy native hay
        # không dựa trên việc còn subscriber cùng identity hay không.
        try:
            from app.core.nesting_preview_session import get_preview_session_store

            get_preview_session_store().cancel_subscriber(job_id)
        except Exception:
            logger.debug("Không tách được subscriber preview nesting.", exc_info=True)
        return PreviewCancelOutcome(
            job_id=job_id,
            status="cancelled",
            cancelled=True,
            already_cancelled=already,
            terminal=True,
        )


# Singleton không sinh thread nền; route và test dùng chung qua module này.
nesting_preview_jobs = NestingPreviewJobRegistry()
