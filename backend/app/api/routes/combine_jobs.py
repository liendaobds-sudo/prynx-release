"""API job nền cho Combine manifest dài: progress, hủy và lấy kết quả."""
from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.combine_jobs import (
    CombineJobPublicError,
    CombineJobQueueFull,
    combine_jobs,
)
from app.core.license_guard import require_license
from app.utils.file_handler import save_upload_file

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/merge-manifest/jobs",
    tags=["PDF Tools"],
    dependencies=[Depends(require_license)],
)

RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(RESULTS_DIR, exist_ok=True)

_SOURCE_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
_SOURCE_SIGNATURES = {
    ".pdf": b"%PDF-",
    ".png": bytes.fromhex("89504e470d0a1a0a"),
    ".jpg": bytes.fromhex("ffd8ff"),
    ".jpeg": bytes.fromhex("ffd8ff"),
}
_JOB_MODES = {"manifest", "merge_files", "interleave"}



class CombineJobStartResponse(BaseModel):
    job_id: str
    status: str = "queued"


class CombineJobStatusResponse(BaseModel):
    job_id: str
    status: str
    terminal: bool = False
    cancel_requested: bool = False
    progress: int = Field(default=0, ge=0, le=100)
    completed: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    completed_source_indices: list[int] = Field(default_factory=list)
    message: Optional[str] = None
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None


class CombineJobCancelResponse(BaseModel):
    job_id: str
    status: str
    cancelled: bool = False
    already_cancelled: bool = False
    terminal: bool = False
    message: Optional[str] = None


def _cleanup_file(path: str) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        logger.warning("Không thể dọn file nguồn Combine: %s", path, exc_info=True)


def manifest_source_extension(source_name: str) -> str:
    extension = os.path.splitext(source_name)[1].lower()
    if extension not in _SOURCE_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=(
                "Định dạng nguồn Combine không được hỗ trợ: "
                f"{extension or '(không có đuôi)'}"
            ),
        )
    return extension


def validate_manifest_source_file(path: str, source_name: str) -> None:
    extension = manifest_source_extension(source_name)
    try:
        with open(path, "rb") as source:
            header = source.read(8)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail="Không đọc được file nguồn Combine.",
        ) from exc
    if not header.startswith(_SOURCE_SIGNATURES[extension]):
        raise HTTPException(
            status_code=400,
            detail="Nội dung file nguồn không khớp với định dạng PDF/PNG/JPG.",
        )


async def _save_uploaded_source(uploaded: UploadFile) -> str:
    source_name = uploaded.filename or ""
    manifest_source_extension(source_name)
    try:
        _stored_name, path, _size = await save_upload_file(uploaded)
        return path
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Không thể lưu file nguồn Combine: %s", source_name)
        raise HTTPException(
            status_code=500,
            detail="Không thể lưu file nguồn Combine. Vui lòng thử lại.",
        ) from exc


def _parse_manifest(raw_manifest: str) -> list[dict]:
    if len(raw_manifest) > 4 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Manifest quá lớn.")
    try:
        items = json.loads(raw_manifest)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Manifest JSON không hợp lệ.") from exc
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="Manifest phải là một mảng thao tác.")
    return items


def _parse_job_mode(raw_mode: str) -> str:
    mode = str(raw_mode or "manifest").strip().lower()
    if mode not in _JOB_MODES:
        raise HTTPException(status_code=400, detail="Chế độ ghép PDF không hợp lệ.")
    return mode


def _parse_native_paths(raw_paths: Optional[str]) -> list[str]:
    if not raw_paths:
        return []
    try:
        paths = json.loads(raw_paths)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Danh sách đường dẫn nguồn không hợp lệ.",
        ) from exc
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
        raise HTTPException(
            status_code=400,
            detail="Danh sách đường dẫn nguồn không hợp lệ.",
        )
    return paths


def _parse_source_paths(raw_paths: Optional[str]) -> Optional[list[Optional[str]]]:
    """Giữ thứ tự mixed source: path native hoặc null ứng với upload kế tiếp."""
    if raw_paths is None:
        return None
    try:
        paths = json.loads(raw_paths)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Danh sách nguồn mixed không hợp lệ.",
        ) from exc
    if not isinstance(paths, list) or not all(
        path is None or isinstance(path, str) for path in paths
    ):
        raise HTTPException(
            status_code=400,
            detail="Danh sách nguồn mixed không hợp lệ.",
        )
    return paths

def _resolve_native_source(native_path: str) -> str:
    manifest_source_extension(native_path)
    if not os.path.isabs(native_path):
        raise HTTPException(
            status_code=400,
            detail="Đường dẫn nguồn Combine phải là đường dẫn tuyệt đối.",
        )
    resolved = os.path.realpath(native_path)
    if not os.path.isfile(resolved):
        raise HTTPException(
            status_code=400,
            detail="Không tìm thấy file nguồn Combine trên máy.",
        )
    validate_manifest_source_file(resolved, native_path)
    return resolved


async def _prepare_sources(
    uploads: list[UploadFile],
    native_paths: list[str],
    source_paths: Optional[list[Optional[str]]] = None,
) -> tuple[list[str], list[str]]:
    if source_paths is not None:
        if native_paths:
            raise HTTPException(
                status_code=400,
                detail="Không trộn file_paths với source_paths.",
            )
        source_count = len(source_paths)
        if source_count < 1 or source_count > 256:
            raise HTTPException(
                status_code=400,
                detail="Số file nguồn Combine không hợp lệ.",
            )
        if sum(path is None for path in source_paths) != len(uploads):
            raise HTTPException(
                status_code=400,
                detail="Số upload không khớp danh sách nguồn mixed.",
            )
    elif bool(uploads) == bool(native_paths):
        raise HTTPException(
            status_code=400,
            detail=(
                "Chỉ cung cấp file tải lên hoặc đường dẫn native, "
                "không cung cấp đồng thời."
            ),
        )
    else:
        source_count = len(uploads) or len(native_paths)
        if source_count < 1 or source_count > 256:
            raise HTTPException(
                status_code=400,
                detail="Số file nguồn Combine không hợp lệ.",
            )

    resolved_paths: list[str] = []
    owned_paths: list[str] = []
    try:
        if source_paths is not None:
            upload_index = 0
            for source_path in source_paths:
                if source_path is not None:
                    resolved_paths.append(
                        await run_in_threadpool(_resolve_native_source, source_path)
                    )
                    continue
                uploaded = uploads[upload_index]
                upload_index += 1
                source_name = uploaded.filename or ""
                uploaded_path = await _save_uploaded_source(uploaded)
                owned_paths.append(uploaded_path)
                await run_in_threadpool(
                    validate_manifest_source_file,
                    uploaded_path,
                    source_name,
                )
                resolved_paths.append(uploaded_path)
        else:
            for uploaded in uploads:
                source_name = uploaded.filename or ""
                uploaded_path = await _save_uploaded_source(uploaded)
                owned_paths.append(uploaded_path)
                await run_in_threadpool(
                    validate_manifest_source_file,
                    uploaded_path,
                    source_name,
                )
                resolved_paths.append(uploaded_path)
            for native_path in native_paths:
                resolved_paths.append(
                    await run_in_threadpool(_resolve_native_source, native_path)
                )
    except BaseException:
        for path in owned_paths:
            _cleanup_file(path)
        raise
    return resolved_paths, owned_paths


def _run_background_job(
    registry,
    job_id: str,
    resolved_paths: list[str],
    manifest_items: list[dict],
    partial_path: str,
    output_path: str,
    license_info: dict,
    order_mode: str = "manifest",
) -> None:
    from app.api.routes.pdf_tools import _safe_watermark
    from app.workers.pdf_manifest_engine import ManifestJobCancelled, merge_manifest

    progress_state = {"completed": 0, "total": 0}

    def progress(phase: str, completed: int, total: int) -> None:
        progress_state["completed"] = completed
        progress_state["total"] = total
        if phase == "inspecting":
            registry.update_progress(job_id, phase, 0, 0)
        else:
            registry.update_progress(job_id, phase, completed, total)

    def source_completed(source_index: int) -> None:
        registry.mark_source_completed(job_id, source_index)

    def cancelled() -> bool:
        return registry.is_cancel_requested(job_id)

    try:
        if order_mode == "interleave":
            merge_manifest(
                resolved_paths,
                manifest_items,
                partial_path,
                progress_callback=progress,
                cancel_check=cancelled,
                source_completed_callback=source_completed,
                order_mode="interleave",
            )
        else:
            merge_manifest(
                resolved_paths,
                manifest_items,
                partial_path,
                progress_callback=progress,
                cancel_check=cancelled,
                source_completed_callback=source_completed,
            )
    except ValueError as exc:
        raw_message = str(exc)
        if any(token in raw_message for token in ("Kế hoạch", "Nguồn ảnh", "Hãy", "ghép")):
            message = raw_message
        else:
            message = "Kế hoạch ghép PDF không hợp lệ. Vui lòng kiểm tra lại trang và file nguồn."
        raise CombineJobPublicError(message) from exc
    if cancelled():
        raise ManifestJobCancelled("Đã hủy ghép PDF")

    total = progress_state["total"]
    registry.update_progress(job_id, "watermarking", total, total)
    _safe_watermark(partial_path, license_info)
    if cancelled():
        raise ManifestJobCancelled("Đã hủy ghép PDF")
    if not os.path.isfile(partial_path) or os.path.getsize(partial_path) <= 0:
        raise CombineJobPublicError(
            "Không tạo được file PDF kết quả. Vui lòng thử lại."
        )
    os.replace(partial_path, output_path)


def _status_response(snapshot) -> CombineJobStatusResponse:
    return CombineJobStatusResponse(
        job_id=snapshot.job_id,
        status=snapshot.status,
        terminal=snapshot.terminal,
        cancel_requested=snapshot.cancel_requested,
        progress=snapshot.progress,
        completed=snapshot.completed,
        total=snapshot.total,
        completed_source_indices=list(snapshot.completed_source_indices),
        message=snapshot.message,
        created_at=snapshot.created_at,
        started_at=snapshot.started_at,
        completed_at=snapshot.completed_at,
    )


@router.post("", response_model=CombineJobStartResponse, status_code=202)
async def start_job(
    files: Optional[list[UploadFile]] = File(None),
    manifest: Optional[str] = Form(None),
    mode: str = Form("manifest"),
    file_paths: Optional[str] = Form(None),
    source_paths: Optional[str] = Form(None),
    return_path: bool = Form(False),
    license_info: dict = Depends(require_license),
):
    """Nhận job dài và trả mã job ngay sau khi chuẩn bị nguồn."""
    job_mode = await run_in_threadpool(_parse_job_mode, mode)
    if job_mode == "manifest":
        if manifest is None:
            raise HTTPException(status_code=400, detail="Thiếu manifest ghép PDF.")
        manifest_items = await run_in_threadpool(_parse_manifest, manifest)
    elif manifest not in (None, ""):
        raise HTTPException(status_code=400, detail="Chế độ legacy không nhận manifest.")
    else:
        manifest_items = []
    native_paths = await run_in_threadpool(_parse_native_paths, file_paths)
    mixed_source_paths = await run_in_threadpool(_parse_source_paths, source_paths)
    resolved_paths, owned_paths = await _prepare_sources(
        list(files or []),
        native_paths,
        mixed_source_paths,
    )
    try:
        if job_mode != "manifest":
            if any(os.path.splitext(path)[1].lower() != ".pdf" for path in resolved_paths):
                raise HTTPException(
                    status_code=415,
                    detail="Ghép nối tiếp/đan xen chỉ nhận file PDF.",
                )
            if job_mode == "interleave" and len(resolved_paths) < 2:
                raise HTTPException(
                    status_code=400,
                    detail="Đan xen cần ít nhất hai file PDF.",
                )
            manifest_items = [
                {"file_index": file_index}
                for file_index in range(len(resolved_paths))
            ]
    except BaseException:
        for path in owned_paths:
            _cleanup_file(path)
        raise

    registry = combine_jobs
    job_id = uuid.uuid4().hex
    output_path = os.path.join(RESULTS_DIR, f"merged_manifest_{job_id}.pdf")
    partial_path = os.path.join(
        RESULTS_DIR,
        f"merged_manifest_{job_id}.partial.pdf",
    )

    def worker() -> None:
        _run_background_job(
            registry,
            job_id,
            resolved_paths,
            manifest_items,
            partial_path,
            output_path,
            license_info,
            "interleave" if job_mode == "interleave" else "manifest",
        )

    try:
        snapshot = registry.submit(
            job_id=job_id,
            result_path=output_path,
            partial_path=partial_path,
            owned_paths=owned_paths,
            return_path=return_path,
            worker=worker,
        )
    except CombineJobQueueFull as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except CombineJobPublicError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Không thể khởi tạo job Combine")
        raise HTTPException(
            status_code=500,
            detail="Không thể khởi tạo job ghép PDF. Vui lòng thử lại.",
        ) from exc
    return CombineJobStartResponse(job_id=snapshot.job_id, status=snapshot.status)


@router.get("/{job_id}", response_model=CombineJobStatusResponse)
def get_job(job_id: str):
    snapshot = combine_jobs.get(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job ghép PDF.")
    return _status_response(snapshot)


@router.post("/{job_id}/cancel", response_model=CombineJobCancelResponse)
def cancel_job(job_id: str):
    result = combine_jobs.cancel(job_id)
    return CombineJobCancelResponse(
        job_id=result.job_id,
        status=result.status,
        cancelled=result.cancelled,
        already_cancelled=result.already_cancelled,
        terminal=result.terminal,
        message=result.message,
    )


@router.get("/{job_id}/result")
def get_job_result(job_id: str):
    snapshot = combine_jobs.get(job_id, refresh_ttl=True)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job ghép PDF.")
    if snapshot.status != "completed":
        raise HTTPException(
            status_code=409,
            detail=f"Job ghép PDF chưa hoàn tất (trạng thái: {snapshot.status}).",
        )
    if not os.path.isfile(snapshot.result_path):
        raise HTTPException(
            status_code=404,
            detail="Không tìm thấy file kết quả ghép PDF.",
        )
    if snapshot.return_path:
        return {
            "path": os.path.abspath(snapshot.result_path),
            "filename": "merged_output.pdf",
        }
    return FileResponse(
        path=snapshot.result_path,
        filename="merged_output.pdf",
        media_type="application/pdf",
    )
