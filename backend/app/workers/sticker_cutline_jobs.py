"""PERF (audit 2026-09-11 §PREWARM): chuẩn bị CUT nền, chỉ công bố lượt mới.

Kết quả nháp chỉ để hiển thị. Kết quả cuối vẫn do builder canonical và bộ
kiểm hình học hiện có quyết định; bộ điều phối không sửa quỹ đạo hay memo.
"""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import logging
from pathlib import Path
import threading
from typing import Callable
from uuid import uuid4

from app.core.system_memory import plan_worker_count
from app.schemas.sticker_sheet import (
    StickerCutlinePreviewRequest,
    StickerCutlinePreviewResponse,
)
from app.workers.cutline_preview_cancel import (
    PreviewCancellation,
    PreviewCancelled,
    cancellation_scope,
)


logger = logging.getLogger(__name__)
_POOL: ThreadPoolExecutor | None = None
_POOL_LOCK = threading.Lock()
_ACTIVE_LOCK = threading.Lock()
_ACTIVE: dict[str, "_PreviewJob"] = {}
_TERMINAL = {"ready", "cancelled", "failed"}
_CLOSING_MARKER = ".cutline-closing"


class PreviewJobConflict(RuntimeError):
    """Thiết lập, lượt yêu cầu hoặc phiên nguồn không còn phù hợp."""


class PreviewJobNotFound(LookupError):
    """Công việc không thuộc phiên này hoặc đã được thay bằng lượt mới."""


@dataclass(eq=False)
class _PreviewJob:
    session: object
    page: object
    options: dict
    options_key: str
    generation: int
    job_id: str = field(default_factory=lambda: uuid4().hex)
    token: PreviewCancellation = field(default_factory=PreviewCancellation)
    status: str = "preparing"
    draft: dict | None = None
    result: dict | None = None
    error: str | None = None
    future: Future | None = None


@dataclass
class _SessionJobs:
    latest: _PreviewJob | None = None
    generation: int = -1
    cancelled_through: int = -1
    closing: bool = False
    active: dict[str, _PreviewJob] = field(default_factory=dict)
    cleanup_requested: bool = False
    cleanup: Callable[[], None] | None = None


def _state(session) -> _SessionJobs:
    state = getattr(session, "_cutline_preview_jobs", None)
    if state is None:
        state = _SessionJobs()
        session._cutline_preview_jobs = state
    return state


def _executor() -> ThreadPoolExecutor:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            workers, reason = plan_worker_count(
                kind="cutline-prewarm", per_worker_mb=256.0,
                env_override="PRYNX_CUTLINE_PREWARM_WORKERS",
            )
            # Pool điều phối riêng để không tự đợi các tem trong cùng pool.
            # Chính sách RAM chung giữ đủ công suất trên máy >=16 GB.
            _POOL = ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="cutline-prewarm",
            )
            logger.info("[PREWARM] %s", reason)
        return _POOL


def _generation(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PreviewJobConflict("Lượt xem trước không hợp lệ. Hãy cập nhật lại đường bế.")
    return value


def _snapshot(record: _PreviewJob) -> dict:
    # Chỉ dữ liệu của hợp đồng HTTP: không lộ session, token, tên vùng nhớ,
    # đường dẫn nguồn hay memo nội bộ. SVG vẫn thuộc response preview cũ.
    return {
        "job_id": record.job_id, "generation": record.generation,
        "page_number": record.options["page_number"],
        "base_revision": record.options["base_revision"],
        "target_simplify_mm": record.options["cutline_simplify_mm"],
        "status": record.status, "draft": deepcopy(record.draft),
        "result": deepcopy(record.result), "error": record.error,
    }


def _cancel_record(record: _PreviewJob) -> None:
    record.token.cancel()
    record.status = "cancelled"
    record.draft = record.result = None
    record.error = None


def _cancel_futures(records: list[_PreviewJob]) -> None:
    # Callback Future có thể lấy session lock hoặc dọn thư mục. Không gọi
    # cancel/wait khi đang giữ khóa phiên, kể cả Future chưa bắt đầu chạy.
    for record in records:
        if record.future is not None:
            record.future.cancel()


def _source_identity(session, page, options: dict) -> str:
    if options["classic_whole_page"]:
        with open(session.source_path, "rb") as source:
            source_key = hashlib.file_digest(source, "sha256").hexdigest()
    else:
        from app.workers.sticker_cutline_preview import _preview_source_key
        source_key = _preview_source_key(session, page)
    return json.dumps({
        "source": str(session.source_path), "kind": session.source_kind,
        "digest": source_key, "boundary": page.boundary_source,
        "preview_size": [page.preview_width_px, page.preview_height_px],
        "revision": page.manifest.get("mask_revision"),
    }, sort_keys=True)


def _builder_options(options: dict) -> dict:
    values = deepcopy(options)
    whole_page = values.pop("classic_whole_page")
    force_contour = values.pop("classic_force_contour")
    if whole_page:
        values["classic_force_contour"] = force_contour
    return values


def _build_preview(session, options: dict) -> dict:
    if options["classic_whole_page"]:
        from app.workers.sticker_classic_page_preview import build_classic_page_preview
        builder = build_classic_page_preview
    else:
        from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
        builder = build_sticker_cutline_preview
    return builder(session, **_builder_options(options))


def _final_cache_available(session, page, options: dict) -> bool:
    """Chỉ hỏi cache tin cậy; builder cũ vẫn phục hồi Alpha/memo khi trúng."""
    if options["classic_whole_page"]:
        from app.workers.sticker_classic_page_preview import source_digest, whole_page_key
        digest = source_digest(session.source_path)
        keys = ("offset_mm", "bleed_mm", "cut_mode", "corner_style", "fill_holes",
                "cutline_smoothness", "cutline_fidelity", "curve_tension",
                "min_detail_area_mm2", "cutline_denoise", "cutline_simplify_mm")
        geometry = {key: options[key] for key in keys}
        geometry["shape_mode"] = "contour" if options["classic_force_contour"] else "auto_safe"
        if geometry["cutline_denoise"] is None:
            geometry["cutline_denoise"] = 0.0
        key = whole_page_key(
            digest, options["page_number"], options["base_revision"], geometry,
            (int(page.preview_width_px), int(page.preview_height_px)),
        )
        cached = getattr(page, "cutline_export_cache", None)
        if (isinstance(cached, dict) and cached.get("kind") == "whole-page-memo-v1"
                and cached.get("key") == key and cached.get("source_digest") == digest):
            return True
        history = getattr(page, "_classic_preview_history", None)
        return bool(
            isinstance(history, dict)
            and history.get("identity") == (digest, options["page_number"], options["base_revision"])
            and key in history.get("entries", {})
        )
    from app.workers.sticker_cutline_preview import _preview_source_key
    history = getattr(page, "cutline_preview_fit_cache", None)
    if (not isinstance(history, dict)
            or history.get("source_key") != _preview_source_key(session, page)):
        return False
    wanted = _builder_options(options)
    wanted["dpi_y"] = wanted["dpi_y"] if wanted["dpi_y"] is not None else wanted["dpi"]
    for frame in history.get("entries", {}).values():
        response = frame.get("response", {})
        if (frame.get("options") == wanted
                and response.get("preview_width_px") == page.preview_width_px
                and response.get("preview_height_px") == page.preview_height_px):
            return True
    return False


def _check_current(record: _PreviewJob) -> None:
    """Caller giữ page lock; thứ tự duy nhất khi cần cả hai là page → session."""
    record.token.check()
    with record.session.operation_lock:
        state = _state(record.session)
        if (state.closing or state.latest is not record
                or state.generation != record.generation
                or record.generation <= state.cancelled_through
                or record.session.pages.get(record.options["page_number"]) is not record.page
                or record.page.stage not in {"mask-review", "mask-ready"}
                or int(record.page.manifest.get("mask_revision", 0)) != record.options["base_revision"]):
            raise PreviewCancelled("Lượt xem trước đã được thay thế.")


def _publish(record: _PreviewJob, value: dict, source_identity: str, *, final: bool) -> None:
    if _source_identity(record.session, record.page, record.options) != source_identity:
        raise PreviewCancelled("Nguồn đường bế đã thay đổi trong lúc xem trước.")
    # Schema cũ loại metadata riêng của builder, đồng thời không cho response
    # lỗi/rỗng trở thành artifact sẵn sàng cho Thực thi.
    public = StickerCutlinePreviewResponse.model_validate(value).model_dump()
    with record.session.operation_lock:
        _check_current(record)
        if final:
            record.result, record.status = public, "ready"
        else:
            record.draft, record.status = public, "simplifying"


def _run(record: _PreviewJob) -> None:
    try:
        with cancellation_scope(record.token):
            record.token.check()
            with record.page.operation_lock:
                _check_current(record)
                original_cache = getattr(record.page, "cutline_export_cache", None)
                succeeded = False
                try:
                    identity = _source_identity(record.session, record.page, record.options)
                    if (record.options["cutline_simplify_mm"] <= 0
                            or _final_cache_available(record.session, record.page, record.options)):
                        final = _build_preview(record.session, record.options)
                    elif record.options["classic_whole_page"]:
                        # PERF (audit 2026-09-11 §PREWARM.DRAFT): frontend chỉ
                        # công bố kết quả `ready`, không hiển thị `draft`. Whole-page
                        # vốn đã chạy canonical writer một lượt đầy đủ, nên dựng
                        # thêm mức 0 trước mức cuối chỉ lặp lại chi phí PDFium/PDF.
                        final = _build_preview(record.session, record.options)
                    else:
                        draft_options = {**record.options, "cutline_simplify_mm": 0.0}
                        draft = _build_preview(record.session, draft_options)
                        _publish(record, draft, identity, final=False)
                        _check_current(record)
                        final = _build_preview(record.session, record.options)
                    _publish(record, final, identity, final=True)
                    succeeded = True
                finally:
                    if not succeeded:
                        # Builder cũ ghi active cache. Không để nháp hoặc lượt
                        # đã hủy thay artifact đang dùng; lịch sử kiểm rồi giữ lại.
                        record.page.cutline_export_cache = original_cache
    except PreviewCancelled:
        with record.session.operation_lock:
            _cancel_record(record)
    except Exception:
        logger.exception("[PREWARM] Không chuẩn bị được đường bế xem trước.")
        with record.session.operation_lock:
            if record.status != "cancelled":
                record.status = "failed"
                record.result = None
                record.error = "Không chuẩn bị được đường bế. Hãy cập nhật xem trước rồi thử lại."


def _finished(record: _PreviewJob, future: Future) -> None:
    cleanup = None
    try:
        record.token.close()
    except Exception:
        logger.exception("[PREWARM] Không thu hồi được token xem trước.")
    with record.session.operation_lock:
        state = _state(record.session)
        state.active.pop(record.job_id, None)
        if record.status not in _TERMINAL:
            if future.cancelled():
                _cancel_record(record)
            else:
                record.status = "failed"
                record.error = "Công việc xem trước đã dừng. Hãy cập nhật lại đường bế."
        if not state.active and state.cleanup is not None:
            cleanup, state.cleanup = state.cleanup, None
    with _ACTIVE_LOCK:
        _ACTIVE.pop(record.job_id, None)
    if cleanup is not None:
        try:
            cleanup()
        except Exception:
            logger.exception("[PREWARM] Không dọn được phiên đường bế đã đóng.")


def start_preview_job(session, options: dict, generation: int) -> dict:
    """Nhận lượt mới, hủy lượt cũ trước khi xếp việc; không đợi solver ở route."""
    generation = _generation(generation)
    normalized = StickerCutlinePreviewRequest.model_validate(options).model_dump()
    key = json.dumps(normalized, sort_keys=True, allow_nan=False)
    cancelled = []
    with session.operation_lock:
        state = _state(session)
        if state.closing or (Path(session.directory) / _CLOSING_MARKER).exists():
            raise PreviewJobConflict("Phiên nguồn đang đóng. Hãy chọn lại file.")
        if generation <= state.cancelled_through or generation < state.generation:
            raise PreviewJobConflict("Lượt xem trước này đã cũ. Hãy dùng thiết lập mới nhất.")
        if generation == state.generation:
            if state.latest is not None and state.latest.options_key == key:
                return _snapshot(state.latest)
            raise PreviewJobConflict("Một lượt xem trước không được dùng cho hai bộ thiết lập.")
        page = session.pages.get(normalized["page_number"])
        if (page is None or page.stage not in {"mask-review", "mask-ready"}
                or int(page.manifest.get("mask_revision", 0)) != normalized["base_revision"]):
            raise PreviewJobConflict("Trang nguồn đã thay đổi. Hãy chờ nhận diện lại.")
        for previous in state.active.values():
            _cancel_record(previous)
            cancelled.append(previous)
        record = _PreviewJob(session, page, normalized, key, generation)
        state.latest, state.generation = record, generation
        state.active[record.job_id] = record
        with _ACTIVE_LOCK:
            _ACTIVE[record.job_id] = record
        try:
            record.future = _executor().submit(_run, record)
        except Exception:
            state.active.pop(record.job_id, None)
            with _ACTIVE_LOCK:
                _ACTIVE.pop(record.job_id, None)
            record.token.close()
            record.status = "failed"
            record.error = "Không khởi động được xem trước. Hãy thử lại."
            logger.exception("[PREWARM] Không xếp được công việc xem trước.")
        snapshot = _snapshot(record)
    # add_done_callback có thể chạy ngay khi future đã xong; luôn đăng ký
    # ngoài session lock để callback dọn file không giữ khóa phiên từ caller.
    if record.future is not None:
        record.future.add_done_callback(lambda future: _finished(record, future))
    _cancel_futures(cancelled)
    return snapshot


def read_preview_job(session, job_id: str) -> dict:
    """Chỉ đọc latest/việc còn chạy thuộc chính phiên, không tra registry chung."""
    with session.operation_lock:
        state = _state(session)
        record = state.latest if state.latest is not None and state.latest.job_id == job_id else state.active.get(job_id)
        if record is None:
            raise PreviewJobNotFound("Công việc xem trước không còn tồn tại trong phiên này.")
        return _snapshot(record)


def cancel_preview_job(session, generation: int) -> bool:
    """Tombstone giữ được DELETE đến trước POST đang trễ trên mạng."""
    generation = _generation(generation)
    with session.operation_lock:
        state = _state(session)
        changed = generation > state.cancelled_through
        state.cancelled_through = max(state.cancelled_through, generation)
        records = {record.job_id: record for record in state.active.values()
                   if record.generation <= generation}
        if state.latest is not None and state.latest.generation <= generation:
            records[state.latest.job_id] = state.latest
        for record in records.values():
            changed = changed or record.status != "cancelled"
            _cancel_record(record)
    _cancel_futures(list(records.values()))
    return changed


def defer_preview_cleanup(session, cleanup: Callable[[], None]) -> bool:
    """Đóng phiên ngay về mặt giao thức, đợi worker thật nhả file rồi mới xóa."""
    with session.operation_lock:
        state = _state(session)
        state.closing = True
        state.cancelled_through = max(state.cancelled_through, state.generation)
        if state.cleanup_requested:
            return True
        state.cleanup_requested = True
        records = list(state.active.values())
        for record in records:
            _cancel_record(record)
        if records:
            # Marker phải có trước khi registry phiên bị bỏ: loader từ đĩa
            # không được hồi sinh session trong lúc worker đang nhả tài nguyên.
            directory = Path(session.directory)
            if directory.exists():
                (directory / _CLOSING_MARKER).touch(exist_ok=True)
            state.cleanup = cleanup
    _cancel_futures(records)
    return bool(records)


def shutdown_preview_jobs() -> None:
    """Hủy và thu hồi công việc còn chạy khi sidecar tắt; không giữ lịch sử chung."""
    global _POOL
    with _ACTIVE_LOCK:
        records = list(_ACTIVE.values())
    for record in records:
        with record.session.operation_lock:
            _cancel_record(record)
    _cancel_futures(records)
    with _POOL_LOCK:
        pool, _POOL = _POOL, None
    if pool is not None:
        pool.shutdown(wait=True, cancel_futures=True)
