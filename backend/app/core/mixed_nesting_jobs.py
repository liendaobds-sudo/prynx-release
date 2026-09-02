"""Registry job của "Bình lồng ghép tự do" — phase P7a.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §6.3, §12.

Registry **riêng**, không refactor registry hiện tại thành generic (§6.3 nói rõ). Năm
điểm khác biệt so với `combine_jobs` — mỗi điểm là một yêu cầu của gate P7a:

1. **Owner isolation thật.** Mọi job gắn một ``owner`` dẫn xuất từ license phía server
   (xem :func:`derive_owner`), không phải ``owner_id`` do client khai. Job của owner khác
   trả **404** — không phải 403 — để không lộ việc job đó tồn tại.
2. **Kết quả nằm trong RAM, không ghi artifact.** Technical MVP giữ manifest JSON trong
   registry với TTL ~1 giờ (§12.4). Không chạm `RESULTS_DIR`, không chạm `cleanup.py`.
3. **Cancel ba đường**: còn trong hàng đợi (``Future.cancel``), đang chờ tài nguyên
   (cancel event làm waiter rời hàng), và đang chạy (``MixedNestingRun.cancel()`` —
   Rust kiểm atomic tại checkpoint). Idempotent ở cả ba.
4. **Không có cửa sổ vừa ``completed`` vừa ``cancel_requested``**: finalize và cancel
   dùng cùng một khóa.
5. **``close()`` tường minh** để lifespan của app dừng được sweeper + executor, không
   để thread nền sống qua shutdown.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.core.heavy_job_scheduler import (
    HeavyJobMemoryUnavailable,
    HeavyJobQueueCancelled,
    heavy_job_slot,
    memory_reservation,
)
from app.core.mixed_nesting_service import (
    HardwarePlan,
    MIXED_NESTING_KIND,
    MixedNestingError,
    MixedNestingRunHandle,
    assert_fits_memory,
    create_run,
    memory_budget_mb,
    plan_hardware,
)

logger = logging.getLogger(__name__)

#: TTL của job terminal, giây. §12.4: khoảng 1 giờ.
DEFAULT_TTL_SECONDS: float = 60 * 60

#: Số job mixed-nesting được nhận vào registry cùng lúc. Chỉ MỘT job chạy tại một thời
#: điểm vì kind này thuộc nhóm whole-machine; queue chỉ để client không bị 429 ngay.
DEFAULT_MAX_QUEUED: int = 4

#: Trần số job mỗi owner được giữ trong registry. Chặn một owner ăn hết bộ nhớ result.
DEFAULT_MAX_JOBS_PER_OWNER: int = 32

#: Trạng thái terminal — không đổi được nữa.
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})

MIXED_NESTING_CANCELLED_CODE = "MIXED_NESTING_CANCELLED"
MIXED_NESTING_CANCELLED_MESSAGE = "Đã hủy job lồng ghép."


def _solve_with_hardware_plan(
    handle: MixedNestingRunHandle,
    request: dict[str, Any],
    plan: HardwarePlan,
) -> dict[str, Any]:
    """Truyền grant cho handle mới, giữ fake/handle lab cũ chạy một đối số.

    Không bắt ``TypeError`` để fallback: lỗi TypeError phát sinh BÊN TRONG engine phải
    được lộ là lỗi thật. Feature-detect method riêng làm ranh giới tương thích rõ ràng.
    """
    solve_with_hardware = getattr(handle, "solve_with_hardware", None)
    if callable(solve_with_hardware):
        return solve_with_hardware(
            request,
            worker_grant=plan.worker_grant,
            nfp_cache_max_bytes_per_trial=plan.nfp_cache_max_bytes_per_trial,
        )
    return handle.solve(request)


class MixedNestingQueueFull(RuntimeError):
    """Hàng đợi đầy hoặc registry đang dừng. Route đổi thành 429."""


def derive_owner(license_info: dict[str, Any] | None) -> str:
    """Định danh chủ sở hữu job, dẫn xuất **phía server** từ license.

    Vì sao không nhận ``ownerId`` từ client: client tự khai owner thì owner isolation chỉ
    là quy ước, ai cũng đọc được job của người khác bằng cách khai trùng. Ở đây owner là
    ``sha256(license_key || hwid)`` — client không chọn được, và không lộ license key ra
    ngoài vì ta chỉ giữ digest.

    Ở DEV_MODE mọi request cùng ``("DEV_MODE", "DEV_MODE")`` nên chung một owner. Điều đó
    đúng: dev chỉ có một người dùng, và cách ly thật chỉ có nghĩa khi có license thật.
    """
    info = license_info or {}
    license_key = str(info.get("license_key") or "")
    hwid = str(info.get("hwid") or "")
    material = f"{license_key}\x00{hwid}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:32]


def new_job_id() -> str:
    """Mã job bằng CSPRNG (§9.2.1). Không nhận mã do client chọn."""
    return secrets.token_hex(16)


@dataclass(frozen=True)
class JobSnapshot:
    """Thứ duy nhất route được thấy. Không rò record khả biến ra ngoài registry."""

    job_id: str
    status: str
    terminal: bool
    cancel_requested: bool
    created_at: float
    started_at: Optional[float]
    completed_at: Optional[float]
    progress: Optional[dict[str, Any]]
    error_code: Optional[str]
    message: Optional[str]
    has_result: bool


@dataclass(frozen=True)
class CancelOutcome:
    job_id: str
    status: str
    cancelled: bool
    already_cancelled: bool
    terminal: bool


@dataclass
class _JobRecord:
    job_id: str
    owner: str
    request: dict[str, Any]
    status: str = "queued"
    terminal: bool = False
    created_at: float = field(default_factory=time.time)
    #: Mốc TTL dùng đồng hồ monotonic — đổi giờ hệ thống không làm job biến mất.
    updated_at: float = field(default_factory=time.monotonic)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    future: Optional[Future] = None
    handle: Optional[MixedNestingRunHandle] = None
    result: Optional[dict[str, Any]] = None
    progress: Optional[dict[str, Any]] = None
    error_code: Optional[str] = None
    message: Optional[str] = None
    slot_released: bool = False


def _positive_env_int(name: str) -> Optional[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


class MixedNestingJobRegistry:
    """Chạy job lồng ghép ngoài event loop, có progress/cancel/TTL/owner isolation."""

    def __init__(
        self,
        *,
        max_queued: Optional[int] = None,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_jobs_per_owner: Optional[int] = None,
        slot_factory: Optional[Callable[[], Any]] = None,
        run_factory: Optional[Callable[[], MixedNestingRunHandle]] = None,
    ) -> None:
        # MỘT worker là chủ đích: kind `mixed-nesting` thuộc nhóm whole-machine nên job
        # thứ hai sẽ chặn ở scheduler dù registry có mở nhiều thread. Nhiều worker chỉ
        # tạo thread nằm chờ và làm shutdown chậm hơn.
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="prynx-mixed-nesting"
        )
        queued = max_queued if max_queued is not None else (
            _positive_env_int("PRYNX_MAX_MIXED_NESTING_QUEUE") or DEFAULT_MAX_QUEUED
        )
        self._submission_slots = threading.BoundedSemaphore(1 + max(0, queued))
        self._max_jobs_per_owner = (
            max_jobs_per_owner
            if max_jobs_per_owner is not None
            else DEFAULT_MAX_JOBS_PER_OWNER
        )
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._slot_factory = slot_factory or (lambda: heavy_job_slot(MIXED_NESTING_KIND))
        self._run_factory = run_factory or create_run
        self._lock = threading.RLock()
        self._jobs: dict[str, _JobRecord] = {}
        self._closed = False
        self._sweeper_stop = threading.Event()
        sweep_interval = min(60.0, max(0.05, self._ttl_seconds / 2.0))
        self._sweeper_thread = threading.Thread(
            target=self._sweep_loop,
            args=(sweep_interval,),
            name="prynx-mixed-nesting-sweeper",
            daemon=True,
        )
        self._sweeper_thread.start()

    # ── Ảnh chụp và TTL ─────────────────────────────────────────────────────

    @staticmethod
    def _snapshot(record: _JobRecord) -> JobSnapshot:
        cancel_requested = record.cancel_event.is_set()
        progress = dict(record.progress) if record.progress else None
        if cancel_requested:
            # Read fence cuối: dù một producer progress cũ lọt qua, snapshot public
            # vẫn không được mâu thuẫn với state registry sau khi cancel đã latch.
            progress = progress or {}
            progress["phase"] = record.status
            progress["messageCode"] = "cancelled_by_user"
        return JobSnapshot(
            job_id=record.job_id,
            status=record.status,
            terminal=record.terminal,
            cancel_requested=cancel_requested,
            created_at=record.created_at,
            started_at=record.started_at,
            completed_at=record.completed_at,
            progress=progress,
            error_code=record.error_code,
            message=record.message,
            has_result=record.result is not None,
        )

    def _sweep(self) -> None:
        now = time.monotonic()
        with self._lock:
            expired = [
                record.job_id
                for record in self._jobs.values()
                if record.terminal and now - record.updated_at >= self._ttl_seconds
            ]
            for job_id in expired:
                self._jobs.pop(job_id, None)
        if expired:
            logger.debug("[MIXED-NESTING] dọn %d job hết TTL", len(expired))

    def _sweep_loop(self, interval_seconds: float) -> None:
        while not self._sweeper_stop.wait(interval_seconds):
            try:
                self._sweep()
            except Exception:  # noqa: BLE001 - không để một vòng giết sweeper
                logger.warning("[MIXED-NESTING] không quét được TTL job", exc_info=True)

    # ── Nhận job ────────────────────────────────────────────────────────────

    def submit(
        self,
        *,
        owner: str,
        build_request: Callable[[str], dict[str, Any]],
    ) -> JobSnapshot:
        """Nhận job và trả snapshot ``queued``. **Không** chạy engine trong lời gọi này.

        ``build_request`` nhận ``jobId`` do registry sinh và trả request nội bộ. Thứ tự
        này là chủ đích: ``jobId`` là **server-owned** (§9.2.1) nên route không thể dựng
        request trước rồi ghim mã vào sau — làm vậy sẽ có một khoảnh khắc request mang mã
        giả, và đó là đúng loại lỗ hổng "client chọn được jobId" mà kế hoạch cấm.
        """
        self._sweep()

        with self._lock:
            if self._closed:
                raise MixedNestingQueueFull("Dịch vụ lồng ghép đang dừng.")
            cua_owner = sum(1 for r in self._jobs.values() if r.owner == owner)
            if cua_owner >= self._max_jobs_per_owner:
                raise MixedNestingQueueFull(
                    "Bạn đang giữ quá nhiều job lồng ghép. Hãy xóa job cũ rồi thử lại."
                )

        if not self._submission_slots.acquire(blocking=False):
            raise MixedNestingQueueFull(
                "Hàng đợi lồng ghép đang đầy. Vui lòng chờ job hiện tại hoàn tất."
            )

        job_id = new_job_id()
        try:
            request = build_request(job_id)
        except BaseException:
            self._submission_slots.release()
            raise

        record = _JobRecord(job_id=job_id, owner=owner, request=request)
        with self._lock:
            if self._closed:
                self._submission_slots.release()
                raise MixedNestingQueueFull("Dịch vụ lồng ghép đang dừng.")
            self._jobs[record.job_id] = record

        try:
            future = self._executor.submit(self._run_job, record)
        except BaseException:
            with self._lock:
                self._jobs.pop(record.job_id, None)
                self._release_slot_locked(record)
            raise

        with self._lock:
            record.future = future
            return self._snapshot(record)

    # ── Vòng chạy ───────────────────────────────────────────────────────────

    def _release_slot_locked(self, record: _JobRecord) -> None:
        if record.slot_released:
            return
        record.slot_released = True
        self._submission_slots.release()

    def _finalize_locked(
        self,
        record: _JobRecord,
        status: str,
        *,
        error_code: Optional[str] = None,
        message: Optional[str] = None,
        result: Optional[dict[str, Any]] = None,
    ) -> None:
        if record.terminal:
            return
        # [NESTING CANCEL FIX 2026-08-27] Đây là chốt công bố cuối của registry.
        # Cancel và finalize giữ cùng khóa; nếu cờ đã lên thì mọi manifest vừa trả về
        # đều bị bỏ, không có trạng thái cancelled nhưng vẫn đọc được result.
        if record.cancel_event.is_set() or status == "cancelled":
            status = "cancelled"
            error_code = MIXED_NESTING_CANCELLED_CODE
            message = message or MIXED_NESTING_CANCELLED_MESSAGE
            result = None
            if record.progress is not None:
                record.progress = {
                    **record.progress,
                    "phase": "cancelled",
                    "progress": 1.0,
                    "messageCode": "cancelled_by_user",
                }
        record.status = status
        record.terminal = True
        record.error_code = error_code
        record.message = message
        record.result = result if status == "completed" else None
        record.updated_at = time.monotonic()
        record.completed_at = time.time()

    def _set_status_locked(self, record: _JobRecord, status: str) -> None:
        if record.terminal or record.cancel_event.is_set():
            return
        record.status = status
        record.updated_at = time.monotonic()

    def _run_job(self, record: _JobRecord) -> None:
        try:
            if record.cancel_event.is_set():
                raise InterruptedError("Đã hủy job lồng ghép")

            with self._lock:
                self._set_status_locked(record, "waiting_resources")

            # Admission RAM chạy TRƯỚC khi chiếm slot: vượt ngân sách thì fail sớm với
            # hướng dẫn, không giữ suất whole-machine để rồi OOM.
            plan = plan_hardware(record.request)
            assert_fits_memory(plan)
            logger.info("[MIXED-NESTING] %s admission: %s", record.job_id, plan.reason)

            with (
                self._slot_factory(),
                memory_reservation(
                    MIXED_NESTING_KIND,
                    plan.estimated_peak_mb,
                    memory_budget_mb,
                    record.cancel_event.is_set,
                ),
            ):
                if record.cancel_event.is_set():
                    raise InterruptedError("Đã hủy job lồng ghép")

                handle = self._run_factory()
                with self._lock:
                    record.handle = handle
                    record.started_at = time.time()
                    self._set_status_locked(record, "normalizing")
                # Hủy đến ngay trước khi solve: handle đã có nên chuyển tiếp được.
                if record.cancel_event.is_set():
                    handle.cancel()

                manifest = _solve_with_hardware_plan(handle, record.request, plan)

                with self._lock:
                    # Cancel và complete dùng cùng khóa: không có cửa sổ job vừa báo
                    # completed vừa mang cancel_requested.
                    record.progress = self._doc_progress(handle)
                    status = str(manifest.get("status") or "completed")
                    if record.cancel_event.is_set() or status == "cancelled":
                        self._finalize_locked(
                            record,
                            "cancelled",
                            error_code=MIXED_NESTING_CANCELLED_CODE,
                            message=MIXED_NESTING_CANCELLED_MESSAGE,
                        )
                    else:
                        self._finalize_locked(record, "completed", result=manifest)
        except BaseException as exc:  # noqa: BLE001 - mọi lỗi phải thành trạng thái job
            self._finalize_failure(record, exc)
        finally:
            with self._lock:
                record.handle = None
                self._release_slot_locked(record)

    def _finalize_failure(self, record: _JobRecord, exc: BaseException) -> None:
        # Kiểm cancel bên TRONG cùng khóa với finalize: nếu yêu cầu hủy đến sau khi
        # engine ném lỗi nhưng trước publication fence, cancel vẫn phải thắng lỗi đó.
        with self._lock:
            cancelled = record.cancel_event.is_set() or isinstance(
                exc, (InterruptedError, HeavyJobQueueCancelled)
            )
            if isinstance(exc, MixedNestingError) and exc.code == MIXED_NESTING_CANCELLED_CODE:
                cancelled = True

            if cancelled:
                self._finalize_locked(
                    record,
                    "cancelled",
                    error_code=MIXED_NESTING_CANCELLED_CODE,
                    message=MIXED_NESTING_CANCELLED_MESSAGE,
                )
                return

            if isinstance(exc, MixedNestingError):
                error_code, message = exc.code, exc.message
            elif isinstance(exc, HeavyJobMemoryUnavailable):
                error_code, message = "MIXED_NESTING_MEMORY_UNAVAILABLE", str(exc)
            else:
                error_code = "MIXED_NESTING_ENGINE_ERROR"
                message = "Không thể lồng ghép. Vui lòng thử lại."
                logger.exception("[MIXED-NESTING] job %s thất bại", record.job_id)

            self._finalize_locked(
                record, "failed", error_code=error_code, message=message
            )

    @staticmethod
    def _doc_progress(handle: MixedNestingRunHandle) -> Optional[dict[str, Any]]:
        """Đọc progress, bỏ qua lỗi: progress hỏng không được làm job hỏng."""
        try:
            return handle.progress()
        except Exception:  # noqa: BLE001
            return None

    # ── Truy vấn ────────────────────────────────────────────────────────────

    def _get_locked(self, job_id: str, owner: str) -> Optional[_JobRecord]:
        record = self._jobs.get(job_id)
        if record is None or record.owner != owner:
            # Job của owner khác được coi như KHÔNG TỒN TẠI (§16.2: không lộ job).
            return None
        return record

    def get(self, job_id: str, owner: str) -> Optional[JobSnapshot]:
        self._sweep()
        with self._lock:
            record = self._get_locked(job_id, owner)
            if record is None:
                return None
            handle = record.handle
            if (
                handle is not None
                and not record.terminal
                and not record.cancel_event.is_set()
            ):
                live = self._doc_progress(handle)
                if live is not None:
                    record.progress = live
                    # Không để progress native đến muộn ghi đè `cancel_requested`.
                    # `_set_status_locked` giữ bất biến không có snapshot vừa completed
                    # vừa mang cancelRequested=true trong lúc chờ publication fence.
                    self._set_status_locked(
                        record, str(live.get("phase") or record.status)
                    )
            return self._snapshot(record)

    def get_result(self, job_id: str, owner: str) -> Optional[dict[str, Any]]:
        """Manifest đã validate. ``None`` = job không tồn tại với owner này."""
        self._sweep()
        with self._lock:
            record = self._get_locked(job_id, owner)
            if record is None:
                return None
            if (
                record.status != "completed"
                or record.cancel_event.is_set()
                or record.result is None
            ):
                return None
            # Đọc result là dấu hiệu job còn được dùng: gia hạn TTL.
            record.updated_at = time.monotonic()
            return record.result

    def status_of(self, job_id: str, owner: str) -> Optional[str]:
        with self._lock:
            record = self._get_locked(job_id, owner)
            return record.status if record is not None else None

    def request_of(self, job_id: str, owner: str) -> Optional[dict[str, Any]]:
        """Request nội bộ đã dùng để chạy job.

        Bước xuất PDF (P14a) cần khổ tờ **của chính lần nesting đó**, không phải khổ tờ client
        gửi lúc xuất — nhận lại ở lúc xuất là mở đường xuất trên khổ khác với khổ đã kiểm.
        Trả bản sao nông để nơi gọi không sửa được state của registry.
        """
        with self._lock:
            record = self._get_locked(job_id, owner)
            return dict(record.request) if record is not None else None

    # ── Cancel và delete ────────────────────────────────────────────────────

    def cancel(self, job_id: str, owner: str) -> Optional[CancelOutcome]:
        """Hủy job. ``None`` = không tồn tại với owner này (route trả 404)."""
        self._sweep()
        with self._lock:
            record = self._get_locked(job_id, owner)
            if record is None:
                return None

            already = record.cancel_event.is_set()
            if record.terminal:
                # Hủy job terminal là no-op, và phải idempotent.
                return CancelOutcome(
                    job_id=job_id,
                    status=record.status,
                    cancelled=record.status == "cancelled",
                    already_cancelled=record.status == "cancelled",
                    terminal=True,
                )

            record.cancel_event.set()
            # Progress native có thể đang ở khe `completed` trước khi registry finalize.
            # Ghim phase theo state registry để route không phát hai tín hiệu trái nhau;
            # khi terminal, `_finalize_locked` tiếp tục chuẩn hóa về `cancelled`.
            record.progress = {
                **(record.progress or {}),
                "phase": "cancel_requested",
                "messageCode": "cancelled_by_user",
            }
            future = record.future
            if future is not None and future.cancel():
                # Còn trong hàng đợi: chuyển terminal ngay và nhả suất đúng MỘT lần.
                self._finalize_locked(
                    record, "cancelled", message="Đã hủy job lồng ghép."
                )
                self._release_slot_locked(record)
            else:
                record.status = "cancel_requested"
                record.updated_at = time.monotonic()
                if record.handle is not None:
                    # Đang chạy: Rust kiểm atomic tại checkpoint.
                    record.handle.cancel()

            return CancelOutcome(
                job_id=job_id,
                status=record.status,
                cancelled=True,
                already_cancelled=already,
                terminal=record.terminal,
            )

    def delete(self, job_id: str, owner: str) -> bool:
        """Xóa job khỏi registry. Job chưa terminal bị hủy trước khi xóa."""
        self._sweep()
        with self._lock:
            record = self._get_locked(job_id, owner)
            if record is None:
                return False
            if not record.terminal:
                record.cancel_event.set()
                future = record.future
                if future is not None and future.cancel():
                    self._finalize_locked(
                        record, "cancelled", message="Đã hủy job lồng ghép."
                    )
                    self._release_slot_locked(record)
                elif record.handle is not None:
                    record.handle.cancel()
            self._jobs.pop(job_id, None)
            return True

    def is_cancel_requested(self, job_id: str) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            return bool(record and record.cancel_event.is_set())

    def count_for_owner(self, owner: str) -> int:
        with self._lock:
            return sum(1 for record in self._jobs.values() if record.owner == owner)

    # ── Shutdown ────────────────────────────────────────────────────────────

    def close(self) -> None:
        """Dừng sweeper + executor và hủy mọi job chưa terminal. Idempotent."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._sweeper_stop.set()
            for record in list(self._jobs.values()):
                if record.terminal:
                    continue
                record.cancel_event.set()
                future = record.future
                if future is not None and future.cancel():
                    self._finalize_locked(
                        record, "cancelled", message="Dịch vụ lồng ghép đang dừng."
                    )
                    self._release_slot_locked(record)
                elif record.handle is not None:
                    record.handle.cancel()

        self._sweeper_thread.join(timeout=2.0)
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            self._jobs.clear()


#: Singleton dùng ở route. Test tạo registry riêng rồi monkeypatch vào module route.
mixed_nesting_jobs = MixedNestingJobRegistry()
