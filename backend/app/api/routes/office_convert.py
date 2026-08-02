"""API chuyển Office/Google → PDF với lifecycle có thể hủy thật."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.api.routes.pdf_tools import _cleanup_file, _safe_watermark, save_upload
from app.config import settings
from app.core.heavy_job_scheduler import (
    run_heavy_in_threadpool,
    run_scheduled_in_threadpool,
)
from app.core.license_guard import enforce_feature, require_license
from app.core.office_job_runner import (
    OfficeJobCancelled,
    OfficeJobControl,
    OfficeJobTimedOut,
    google_timeout_seconds,
    office_timeout_seconds,
    run_google_job,
    run_office_job,
)
from app.schemas.pdf_tools import (
    OfficeConvertStatusResponse,
    OfficeJobCancelResponse,
    OfficeJobExtendResponse,
    OfficeJobStatusResponse,
)
from app.utils.errors import raise_http
from app.workers.office_convert_engine import OFFICE_EXTENSIONS, parse_google_url, probe_converters
from app.workers.pdf_tools_engine import PdfOperationCancelled, resize_pages

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/pdf-tools/office-convert",
    tags=["Office Convert"],
    dependencies=[Depends(require_license)],
)

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

_TERMINAL_PHASES = frozenset({"completed", "failed", "cancelled", "timed_out"})
_JOB_TTL_SECONDS = 10 * 60


@dataclass
class _OfficeJobRecord:
    job_id: str
    control: OfficeJobControl
    phase: str
    created_at: float
    updated_at: float
    terminal: bool = False
    message: Optional[str] = None


_JOBS_LOCK = threading.Lock()
_JOBS: dict[str, _OfficeJobRecord] = {}


def _normalize_job_id(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return uuid.uuid4().hex
    try:
        return uuid.UUID(value).hex
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail="Mã job Office không hợp lệ.") from exc


def _sweep_jobs_locked(now: float) -> None:
    expired = [
        job_id
        for job_id, record in _JOBS.items()
        if record.terminal and now - record.updated_at >= _JOB_TTL_SECONDS
    ]
    for job_id in expired:
        _JOBS.pop(job_id, None)


def _register_job(raw_job_id: str, timeout_seconds: float) -> _OfficeJobRecord:
    job_id = _normalize_job_id(raw_job_id)
    now = time.monotonic()
    with _JOBS_LOCK:
        _sweep_jobs_locked(now)
        if job_id in _JOBS:
            raise HTTPException(status_code=409, detail="Mã job Office đang được sử dụng.")
        record = _OfficeJobRecord(
            job_id=job_id,
            control=OfficeJobControl(timeout_seconds),
            phase="queued",
            created_at=now,
            updated_at=now,
        )
        _JOBS[job_id] = record
        return record


def _set_job_phase(job_id: str, phase: str, message: Optional[str] = None) -> None:
    with _JOBS_LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return
        record.phase = phase
        record.updated_at = time.monotonic()
        record.terminal = phase in _TERMINAL_PHASES
        if message is not None:
            record.message = message


def _get_job(raw_job_id: str) -> Optional[_OfficeJobRecord]:
    job_id = _normalize_job_id(raw_job_id)
    now = time.monotonic()
    with _JOBS_LOCK:
        _sweep_jobs_locked(now)
        return _JOBS.get(job_id)


def _job_status(record: _OfficeJobRecord) -> OfficeJobStatusResponse:
    return OfficeJobStatusResponse(
        job_id=record.job_id,
        phase=record.phase,
        terminal=record.terminal,
        cancel_requested=record.control.cancel_event.is_set(),
        remaining_seconds=record.control.remaining_seconds() if not record.terminal else 0.0,
        message=record.message,
    )


async def _await_job(request: Request, record: _OfficeJobRecord, awaitable):
    """Nối client disconnect với control; không nhả slot trước process thật."""
    task = asyncio.create_task(awaitable)
    try:
        while not task.done():
            done, _pending = await asyncio.wait({task}, timeout=0.2)
            if task in done:
                break
            if await request.is_disconnected():
                record.control.cancel()
                _set_job_phase(record.job_id, "cancel_requested")
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        record.control.cancel()
        _set_job_phase(record.job_id, "cancel_requested")
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except BaseException:
            pass
        raise


def _runner_phase(job_id: str, running_phase: str, phase: str) -> None:
    mapped = {
        "starting": "starting",
        "running": running_phase,
        "completed": "converted",
        "cancelled": "cancelled",
        "timed_out": "timed_out",
        "failed": "failed",
    }.get(phase, phase)
    _set_job_phase(job_id, mapped)


def _run_office(record: _OfficeJobRecord, source: str, output: str, layout: str) -> str:
    return run_office_job(
        source,
        output,
        layout,
        control=record.control,
        phase_callback=lambda phase: _runner_phase(record.job_id, "converting", phase),
    )


def _run_google(record: _OfficeJobRecord, url: str, output: str) -> str:
    return run_google_job(
        url,
        output,
        control=record.control,
        phase_callback=lambda phase: _runner_phase(record.job_id, "downloading", phase),
    )


@router.get("/status", response_model=OfficeConvertStatusResponse)
async def office_convert_status(_license_info: dict = Depends(require_license)):
    return probe_converters()


@router.get("/jobs/{job_id}", response_model=OfficeJobStatusResponse)
async def office_job_status(job_id: str, _license_info: dict = Depends(require_license)):
    record = _get_job(job_id)
    if record is None:
        return OfficeJobStatusResponse(
            job_id=_normalize_job_id(job_id),
            phase="not_found",
            terminal=True,
            message="Không tìm thấy job Office.",
        )
    return _job_status(record)


@router.post("/jobs/{job_id}/cancel", response_model=OfficeJobCancelResponse)
async def cancel_office_job(job_id: str, _license_info: dict = Depends(require_license)):
    record = _get_job(job_id)
    normalized = _normalize_job_id(job_id)
    if record is None:
        return OfficeJobCancelResponse(
            job_id=normalized,
            phase="not_found",
            cancelled=False,
            terminal=True,
            message="Không tìm thấy job Office.",
        )
    if record.terminal:
        return OfficeJobCancelResponse(
            job_id=record.job_id,
            phase=record.phase,
            cancelled=record.phase == "cancelled",
            terminal=True,
            message=record.message,
        )
    record.control.cancel()
    _set_job_phase(record.job_id, "cancel_requested")
    return OfficeJobCancelResponse(
        job_id=record.job_id,
        phase="cancel_requested",
        cancelled=True,
        terminal=False,
    )


@router.post("/jobs/{job_id}/extend", response_model=OfficeJobExtendResponse)
async def extend_office_job(
    job_id: str,
    seconds: float = Form(300.0),
    _license_info: dict = Depends(require_license),
):
    record = _get_job(job_id)
    normalized = _normalize_job_id(job_id)
    if record is None:
        return OfficeJobExtendResponse(
            job_id=normalized,
            phase="not_found",
            remaining_seconds=0.0,
            extended=False,
            message="Không tìm thấy job Office.",
        )
    if record.terminal:
        return OfficeJobExtendResponse(
            job_id=record.job_id,
            phase=record.phase,
            remaining_seconds=0.0,
            extended=False,
            message="Job đã kết thúc, không thể gia hạn.",
        )
    if not 10.0 <= seconds <= 3600.0:
        raise HTTPException(status_code=400, detail="Mỗi lần gia hạn phải từ 10 đến 3600 giây.")
    remaining = record.control.extend(seconds)
    return OfficeJobExtendResponse(
        job_id=record.job_id,
        phase=record.phase,
        remaining_seconds=remaining,
        extended=True,
    )


@router.post("/file")
async def office_convert_file_endpoint(
    request: Request,
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    excel_layout: str = Form("preserve"),
    batch_mode: bool = Form(False),
    job_id: str = Form(""),
    return_path: Annotated[bool, Form()] = False,
    license_info: dict = Depends(require_license),
):
    if batch_mode:
        enforce_feature("pdf.office_batch", license_info)

    source_path: Optional[str] = None
    delete_source = False
    name = "document.docx"
    record: Optional[_OfficeJobRecord] = None
    output_path = ""

    try:
        path_arg = (file_path or "").strip().strip('"')
        if path_arg:
            if not await asyncio.to_thread(os.path.isfile, path_arg):
                raise HTTPException(status_code=400, detail=f"Không tìm thấy file: {path_arg}")
            source_path = path_arg
            name = os.path.basename(path_arg)
        elif file is not None and (file.filename or file.size is not None):
            name = file.filename or "document.docx"
            ext = os.path.splitext(name)[1].lower()
            if ext not in OFFICE_EXTENSIONS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Định dạng không hỗ trợ: {ext}. Hỗ trợ: {', '.join(sorted(OFFICE_EXTENSIONS))}",
                )
            source_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
            size = await asyncio.to_thread(
                _copy_upload_stream, file.file, source_path
            )
            if size <= 0:
                raise HTTPException(status_code=400, detail="File upload rỗng. Hãy chọn lại file.")
            delete_source = True
        else:
            raise HTTPException(
                status_code=400,
                detail="Thiếu file: gửi file_path hoặc upload file.",
            )

        ext = os.path.splitext(name)[1].lower()
        if ext not in OFFICE_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Định dạng không hỗ trợ: {ext}. Hỗ trợ: {', '.join(sorted(OFFICE_EXTENSIONS))}",
            )
        if excel_layout not in {"preserve", "fit_width", "one_page"}:
            raise HTTPException(status_code=400, detail="Chế độ phân trang Excel không hợp lệ.")

        record = _register_job(job_id, office_timeout_seconds(source_path))
        output_path = os.path.join(RESULTS_DIR, f"converted_{record.job_id[:12]}.pdf")
        await _await_job(
            request,
            record,
            run_scheduled_in_threadpool(
                "office", _run_office, record, source_path, output_path, excel_layout
            ),
        )
        if record.control.cancel_event.is_set():
            raise OfficeJobCancelled("Đã hủy chuyển Office → PDF.")

        _set_job_phase(record.job_id, "watermarking")
        await run_heavy_in_threadpool(_safe_watermark, output_path, license_info)
        if record.control.cancel_event.is_set():
            raise OfficeJobCancelled("Đã hủy chuyển Office → PDF.")
        _set_job_phase(record.job_id, "completed")

        base = os.path.splitext(name)[0] + ".pdf"
        if return_path:
            return {
                "path": os.path.abspath(output_path),
                "filename": f"converted_{base}",
                "job_id": record.job_id,
            }
        return FileResponse(
            path=output_path,
            filename=f"converted_{base}",
            media_type="application/pdf",
            headers={"X-PrynX-Job-Id": record.job_id},
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except OfficeJobCancelled as exc:
        if record:
            _set_job_phase(record.job_id, "cancelled", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OfficeJobTimedOut as exc:
        if record:
            _set_job_phase(record.job_id, "timed_out", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except HTTPException as exc:
        if record:
            _set_job_phase(record.job_id, "failed", str(exc.detail))
        _cleanup_file(output_path)
        raise
    except ValueError as exc:
        if record:
            _set_job_phase(record.job_id, "failed", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if record:
            _set_job_phase(record.job_id, "failed", "Chuyển Office → PDF thất bại")
        _cleanup_file(output_path)
        logger.exception("Office convert failed")
        raise_http(exc, "Chuyển Office → PDF thất bại")
    finally:
        if delete_source and source_path:
            _cleanup_file(source_path)


_UPLOAD_CHUNK_BYTES = 1024 * 1024


def _copy_upload_stream(source, path: str) -> int:
    """Ghi upload theo chunk trong worker thread, không tạo một bản bytes toàn file."""
    source.seek(0)
    with open(path, "wb") as output_file:
        shutil.copyfileobj(source, output_file, length=_UPLOAD_CHUNK_BYTES)
    return os.path.getsize(path)


def _is_managed_result_path(path: str) -> bool:
    """Chỉ cho phép consume file trung gian nằm thật bên trong RESULTS_DIR."""
    try:
        base = os.path.normcase(os.path.abspath(RESULTS_DIR))
        candidate = os.path.normcase(os.path.abspath(path))
        return os.path.commonpath([base, candidate]) == base
    except (OSError, ValueError):
        return False


class _ResizeCancelSignal:
    def __init__(self, control: OfficeJobControl):
        self._control = control

    def is_set(self) -> bool:
        return self._control.cancel_event.is_set() or self._control.expired()


def _resize_progress(job_id: str, completed: int, total: int) -> None:
    _set_job_phase(job_id, "resizing", f"{completed}/{total}")


@router.post("/resize-output")
async def office_convert_resize_output(
    request: Request,
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    target_w: float = Form(...),
    target_h: float = Form(...),
    auto_orientation: bool = Form(True),
    batch_mode: bool = Form(False),
    job_id: str = Form(""),
    return_path: Annotated[bool, Form()] = False,
    consume_source: Annotated[bool, Form()] = False,
    license_info: dict = Depends(require_license),
):
    """Chuẩn hóa khổ PDF với cancel cooperative giữa từng trang và trước save."""
    if batch_mode:
        enforce_feature("pdf.resize_batch", license_info)
    if not (10.0 <= target_w <= 5000.0 and 10.0 <= target_h <= 5000.0):
        raise HTTPException(status_code=400, detail="Kích thước PDF phải từ 10 đến 5000 mm.")

    source_path: Optional[str] = None
    delete_source = False
    name = "document.pdf"
    output_path = ""
    record: Optional[_OfficeJobRecord] = None
    try:
        path_arg = (file_path or "").strip().strip('"')
        if path_arg:
            exists = await asyncio.to_thread(os.path.isfile, path_arg)
            if not exists or not path_arg.lower().endswith(".pdf"):
                raise HTTPException(status_code=400, detail="Không tìm thấy file PDF nguồn.")
            source_path = path_arg
            name = os.path.basename(path_arg)
        elif file is not None:
            name = file.filename or "document.pdf"
            if not name.lower().endswith(".pdf"):
                raise HTTPException(status_code=400, detail="File tải lên không phải PDF.")
            source_path = await save_upload(file)
            delete_source = True
        else:
            raise HTTPException(status_code=400, detail="Thiếu file PDF cần chuẩn hóa.")

        record = _register_job(job_id, office_timeout_seconds(source_path))
        output_path = os.path.join(RESULTS_DIR, f"batch_resized_{record.job_id[:12]}.pdf")
        signal = _ResizeCancelSignal(record.control)
        _set_job_phase(record.job_id, "resizing", "0/?")
        await _await_job(
            request,
            record,
            run_scheduled_in_threadpool(
                "pdf-tools",
                resize_pages,
                source_path,
                output_path,
                target_w,
                target_h,
                "fit",
                "all",
                auto_orientation,
                "white",
                "#ffffff",
                signal,
                lambda completed, total: _resize_progress(
                    record.job_id, completed, total
                ),
            ),
        )
        if signal.is_set():
            raise PdfOperationCancelled("Đã hủy chuẩn hóa khổ PDF.")
        _set_job_phase(record.job_id, "completed")
        if return_path:
            return {
                "path": os.path.abspath(output_path),
                "filename": f"resized_{name}",
                "job_id": record.job_id,
            }
        return FileResponse(
            path=output_path,
            filename=f"resized_{name}",
            media_type="application/pdf",
            headers={"X-PrynX-Job-Id": record.job_id},
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except PdfOperationCancelled as exc:
        _cleanup_file(output_path)
        if record and record.control.expired() and not record.control.cancel_event.is_set():
            _set_job_phase(record.job_id, "timed_out", str(exc))
            raise HTTPException(status_code=504, detail="Chuẩn hóa khổ PDF đã hết thời gian chờ.") from exc
        if record:
            _set_job_phase(record.job_id, "cancelled", str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except HTTPException as exc:
        if record:
            _set_job_phase(record.job_id, "failed", str(exc.detail))
        _cleanup_file(output_path)
        raise
    except Exception as exc:  # noqa: BLE001
        if record:
            _set_job_phase(record.job_id, "failed", "Chuẩn hóa khổ PDF thất bại")
        _cleanup_file(output_path)
        logger.exception("Batch output resize failed")
        raise_http(exc, "Chuẩn hóa khổ PDF thất bại")
    finally:
        if delete_source and source_path:
            _cleanup_file(source_path)
        elif consume_source and source_path and _is_managed_result_path(source_path):
            _cleanup_file(source_path)

@router.post("/google")
async def office_convert_google_endpoint(
    request: Request,
    url: str = Form(...),
    job_id: str = Form(""),
    return_path: Annotated[bool, Form()] = False,
    license_info: dict = Depends(require_license),
):
    output_path = ""
    record: Optional[_OfficeJobRecord] = None
    try:
        kind, _file_id = parse_google_url(url)
        record = _register_job(job_id, google_timeout_seconds())
        output_path = os.path.join(RESULTS_DIR, f"google_{record.job_id[:12]}.pdf")
        # Google là network job riêng; không chờ serial gate COM Office.
        await _await_job(
            request,
            record,
            run_scheduled_in_threadpool("google", _run_google, record, url, output_path),
        )
        if record.control.cancel_event.is_set():
            raise OfficeJobCancelled("Đã hủy tải Google → PDF.")

        _set_job_phase(record.job_id, "watermarking")
        await run_heavy_in_threadpool(_safe_watermark, output_path, license_info)
        if record.control.cancel_event.is_set():
            raise OfficeJobCancelled("Đã hủy tải Google → PDF.")
        _set_job_phase(record.job_id, "completed")
        filename = f"google_{kind}.pdf"
        if return_path:
            return {
                "path": os.path.abspath(output_path),
                "filename": filename,
                "job_id": record.job_id,
            }
        return FileResponse(
            path=output_path,
            filename=filename,
            media_type="application/pdf",
            headers={"X-PrynX-Job-Id": record.job_id},
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except OfficeJobCancelled as exc:
        if record:
            _set_job_phase(record.job_id, "cancelled", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except OfficeJobTimedOut as exc:
        if record:
            _set_job_phase(record.job_id, "timed_out", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except HTTPException as exc:
        if record:
            _set_job_phase(record.job_id, "failed", str(exc.detail))
        _cleanup_file(output_path)
        raise
    except ValueError as exc:
        if record:
            _set_job_phase(record.job_id, "failed", str(exc))
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        if record:
            _set_job_phase(record.job_id, "failed", "Xuất Google → PDF thất bại")
        _cleanup_file(output_path)
        logger.exception("Google convert failed")
        raise_http(exc, "Xuất Google → PDF thất bại")