from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Depends
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
import os
import uuid
import json
import time
import base64
import csv
import io
import tempfile
import threading
from typing import List, Dict, Optional, Any, Tuple
from concurrent.futures import ThreadPoolExecutor
from app.schemas.vdp import VdpRequest, VdpField
from app.workers.vdp_engine import VdpCancelledError, run_vdp_engine
from app.workers.vdp_datasource import (
    DataSourceError,
    RecordTable,
    read_source,
    list_xlsx_sheets,
)
from app.workers.vdp_validate import (
    validate_batch,
    gating_state,
    build_error_report_csv,
)
from app.workers.vdp_preview import render_record_preview
from app.core.license_guard import require_license, require_feature
from app.core.heavy_job_scheduler import scheduled_job
from app.config import settings

import logging

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_feature("vdp.datamerge"))])

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

# In-memory job store
# In production with multiple Uvicorn workers, this should be Redis.
vdp_jobs = {}
_VDP_JOBS_LOCK = threading.RLock()

# ── Giới hạn tài nguyên ──
VDP_JOB_TTL_SECONDS = 3600          # Dọn job + file kết quả sau 1 giờ
MAX_VDP_ROWS = 100_000              # Chặn payload quá lớn gây OOM/đầy đĩa
MAX_VDP_PAYLOAD_BYTES = 256 * 1024 * 1024
_VDP_MAX_CONCURRENT_JOBS = max(1, int(os.environ.get('PRYNX_MAX_VDP_JOBS', '1') or '1'))
_VDP_MAX_QUEUED_JOBS = max(0, int(os.environ.get('PRYNX_MAX_VDP_QUEUE', '8') or '8'))
_VDP_EXECUTOR = ThreadPoolExecutor(
    max_workers=_VDP_MAX_CONCURRENT_JOBS,
    thread_name_prefix="prynx-vdp",
)
_VDP_SUBMISSION_SLOTS = threading.BoundedSemaphore(_VDP_MAX_CONCURRENT_JOBS + _VDP_MAX_QUEUED_JOBS)


def _purge_old_jobs():
    """Dọn các job quá hạn khỏi bộ nhớ và xoá file kết quả tương ứng.

    Khắc phục rò rỉ RAM (dict tăng vô hạn) và rác ổ đĩa (results/vdp_*.pdf
    không được cleanup loop của DB quét tới).
    """
    now = time.time()
    for jid in list(vdp_jobs.keys()):
        job = vdp_jobs.get(jid)
        if not job:
            continue
        created = job.get("created_at", now)
        if now - created > VDP_JOB_TTL_SECONDS and job.get("status") in {"completed", "failed", "cancelled"}:
            result_path = job.get("result")
            if result_path and os.path.exists(result_path):
                try:
                    os.remove(result_path)
                except OSError:
                    pass
            vdp_jobs.pop(jid, None)

import glob
import tempfile


def _vdp_cancel_marker(job_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"vdp_cancel_{job_id}.flag")


def _touch_vdp_cancel_marker(path: str) -> None:
    try:
        with open(path, "ab"):
            pass
    except OSError as exc:
        logger.warning("Unable to create VDP cancellation marker %s: %s", path, exc)


def _vdp_is_cancelled(job: dict) -> bool:
    event = job.get("cancel_event")
    return bool(
        job.get("cancel_requested")
        or job.get("status") == "cancelled"
        or (event is not None and event.is_set())
        or (job.get("cancel_file") and os.path.exists(job["cancel_file"]))
    )


def _cleanup_vdp_job_files(job_id: str, job: dict, *, include_output: bool) -> None:
    paths = [
        job.get("data_path"),
        job.get("template_path"),
        job.get("cancel_file"),
    ]
    if include_output:
        paths.extend((job.get("output_path"), job.get("result")))
    tmp_dir = tempfile.gettempdir()
    paths.extend(glob.glob(os.path.join(tmp_dir, f"vdp_prog_{job_id}_*.txt")))
    paths.extend(glob.glob(os.path.join(tmp_dir, f"vdp_chunk_{job_id}_*.pdf")))
    for path in dict.fromkeys(path for path in paths if path):
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass


def _release_vdp_submission_slot(job: dict) -> bool:
    """Release the reserved queue slot at most once for this job."""
    should_release = False
    with _VDP_JOBS_LOCK:
        if not job.get("slot_released", False):
            job["slot_released"] = True
            should_release = True
    if should_release:
        _VDP_SUBMISSION_SLOTS.release()
    return should_release


def _parse_csv_upload(file_obj, has_header: bool) -> List[Dict[str, str]]:
    """Parse an uploaded CSV once, without materializing a JSON string copy."""
    file_obj.seek(0)
    wrapper = io.TextIOWrapper(file_obj, encoding="utf-8-sig", errors="replace", newline="")
    try:
        sample = wrapper.read(4096)
        wrapper.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.reader(wrapper, dialect)
        rows: List[Dict[str, str]] = []
        if has_header:
            try:
                header = [str(value or "").strip() for value in next(reader)]
            except StopIteration:
                return rows
            for raw in reader:
                if not any(str(value or "").strip() for value in raw):
                    continue
                rows.append({
                    name: str(raw[index] if index < len(raw) else "")
                    for index, name in enumerate(header)
                })
                if len(rows) > MAX_VDP_ROWS:
                    raise ValueError(f"Quá nhiều bản ghi (>{MAX_VDP_ROWS}).")
        else:
            for raw in reader:
                if not any(str(value or "").strip() for value in raw):
                    continue
                rows.append({
                    f"Cột {index + 1}": str(value or "")
                    for index, value in enumerate(raw)
                })
                if len(rows) > MAX_VDP_ROWS:
                    raise ValueError(f"Quá nhiều bản ghi (>{MAX_VDP_ROWS}).")
        return rows
    finally:
        wrapper.detach()
        file_obj.seek(0)


def _uploaded_file_size(file_obj) -> int:
    current = file_obj.tell()
    file_obj.seek(0, os.SEEK_END)
    size = file_obj.tell()
    file_obj.seek(current)
    return size


def _copy_fileobj_limited(file_obj, destination: str, max_bytes: int) -> int:
    file_obj.seek(0)
    total = 0
    try:
        with open(destination, "wb") as output:
            while True:
                chunk = file_obj.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("VDP payload exceeds the configured size limit")
                output.write(chunk)
    except BaseException:
        try:
            os.remove(destination)
        except OSError:
            pass
        raise
    finally:
        file_obj.seek(0)
    if total == 0:
        try:
            os.remove(destination)
        except OSError:
            pass
        raise ValueError("Uploaded file is empty")
    return total


def _copy_path_limited(source: str, destination: str, max_bytes: int) -> int:
    with open(source, "rb") as file_obj:
        return _copy_fileobj_limited(file_obj, destination, max_bytes)


def _is_pdf_path(path: str) -> bool:
    try:
        with open(path, "rb") as file_obj:
            return file_obj.read(5).startswith(b"%PDF")
    except OSError:
        return False


def _load_spooled_vdp_data(data_path: str, data_format: str, has_header: bool) -> List[Dict[str, str]]:
    with open(data_path, "rb") as file_obj:
        if data_format == "csv":
            rows = _parse_csv_upload(file_obj, has_header)
        else:
            wrapper = io.TextIOWrapper(file_obj, encoding="utf-8-sig", errors="strict")
            try:
                rows = json.load(wrapper)
            finally:
                wrapper.detach()
    if not isinstance(rows, list) or not rows:
        raise ValueError("Data array is empty")
    if len(rows) > MAX_VDP_ROWS:
        raise ValueError(f"Too many records ({len(rows)} > {MAX_VDP_ROWS})")
    if not all(isinstance(row, dict) for row in rows):
        raise ValueError("VDP data must be an array of objects")
    return rows


def vdp_background_task(job_id: str, template_path: str, fields: List[VdpField], data: List[Dict[str, str]], output_path: str, **kwargs):
    with _VDP_JOBS_LOCK:
        job = vdp_jobs.get(job_id)
    if job is None:
        return

    cancel_file = job.get("cancel_file") or _vdp_cancel_marker(job_id)

    def cancel_check() -> bool:
        return _vdp_is_cancelled(job)

    try:
        if cancel_check():
            raise VdpCancelledError("VDP job cancelled")

        def on_saving():
            if cancel_check():
                raise VdpCancelledError("VDP job cancelled")
            with _VDP_JOBS_LOCK:
                if _vdp_is_cancelled(job):
                    raise VdpCancelledError("VDP job cancelled")
                job["status"] = "saving"

        run_vdp_engine(
            template_path,
            fields,
            data,
            output_path,
            job_id=job_id,
            on_saving=on_saving,
            cancel_check=cancel_check,
            cancel_file=cancel_file,
            **kwargs,
        )
        if cancel_check():
            raise VdpCancelledError("VDP job cancelled")
        with _VDP_JOBS_LOCK:
            if _vdp_is_cancelled(job):
                raise VdpCancelledError("VDP job cancelled")
            job["status"] = "completed"
            job["result"] = output_path
            job["error"] = None
    except VdpCancelledError:
        with _VDP_JOBS_LOCK:
            job["cancel_requested"] = True
            job["status"] = "cancelled"
            job["result"] = None
            job["error"] = None
        _cleanup_vdp_job_files(job_id, job, include_output=True)
    except Exception as e:
        with _VDP_JOBS_LOCK:
            if _vdp_is_cancelled(job):
                job["status"] = "cancelled"
                job["result"] = None
                job["error"] = None
            else:
                job["status"] = "failed"
                job["error"] = str(e)
    finally:
        _cleanup_vdp_job_files(
            job_id,
            job,
            include_output=job.get("status") == "cancelled",
        )

@scheduled_job("vdp")
def vdp_background_task_spooled(
    job_id: str,
    template_path: str,
    data_path: str,
    fields: List[VdpField],
    data_format: str,
    has_header: bool,
    output_path: str,
    **kwargs,
):
    """Parse only after a fixed worker starts, keeping queued jobs disk-backed."""
    job = None
    try:
        with _VDP_JOBS_LOCK:
            job = vdp_jobs.get(job_id)
            if job is None:
                return
            job.setdefault("data_path", data_path)
            job.setdefault("template_path", template_path)
            job.setdefault("output_path", output_path)
            job.setdefault("cancel_file", _vdp_cancel_marker(job_id))
            job.setdefault("cancel_requested", False)
            if _vdp_is_cancelled(job):
                raise VdpCancelledError("VDP job cancelled")
            job["status"] = "processing"

        data = _load_spooled_vdp_data(data_path, data_format, has_header)
        if _vdp_is_cancelled(job):
            raise VdpCancelledError("VDP job cancelled")
        with _VDP_JOBS_LOCK:
            job["total"] = len(data)
        return vdp_background_task(job_id, template_path, fields, data, output_path, **kwargs)
    except VdpCancelledError:
        if job is not None:
            with _VDP_JOBS_LOCK:
                job["cancel_requested"] = True
                job["status"] = "cancelled"
                job["result"] = None
                job["error"] = None
    except Exception as exc:
        if job is None:
            return
        with _VDP_JOBS_LOCK:
            if _vdp_is_cancelled(job):
                job["status"] = "cancelled"
                job["result"] = None
                job["error"] = None
            else:
                job["status"] = "failed"
                job["error"] = str(exc)
    finally:
        if job is not None:
            _cleanup_vdp_job_files(
                job_id,
                job,
                include_output=job.get("status") == "cancelled",
            )
            _release_vdp_submission_slot(job)
        else:
            for path in (data_path, template_path):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except OSError:
                    pass
            _VDP_SUBMISSION_SLOTS.release()

@router.post("/generate")
async def start_vdp_job(
    fields: str = Form(...),
    data_file: UploadFile = File(...),
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    data_format: str = Form("json"),
    has_header: bool = Form(True),
    license_info: dict = Depends(require_license),
):
    """Reserve capacity first, then spool queued inputs without retaining row lists."""
    logger.debug("Received POST /generate")
    _purge_old_jobs()
    if not _VDP_SUBMISSION_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Hàng đợi VDP đang đầy. Vui lòng chờ job hiện tại hoàn tất.")

    job_id = uuid.uuid4().hex
    data_path = os.path.join(UPLOAD_DIR, f"vdp_data_{job_id}.dat")
    template_path = os.path.join(UPLOAD_DIR, f"vdp_template_{job_id}.pdf")
    output_path = os.path.abspath(os.path.join(RESULTS_DIR, f"vdp_{job_id}.pdf"))
    submitted = False

    try:
        fields_parsed = json.loads(fields)
        if not isinstance(fields_parsed, list):
            raise ValueError("Fields must be an array")
        vdp_fields = [VdpField(**field) for field in fields_parsed]

        normalized_format = data_format.strip().lower()
        if normalized_format not in {"csv", "json"}:
            raise ValueError("Unsupported VDP data format")
        data_size = await run_in_threadpool(_uploaded_file_size, data_file.file)
        if data_size <= 0:
            raise ValueError("Data file is empty")
        if data_size > MAX_VDP_PAYLOAD_BYTES:
            raise HTTPException(status_code=413, detail="VDP payload vượt quá giới hạn kích thước.")
        await run_in_threadpool(
            _copy_fileobj_limited,
            data_file.file,
            data_path,
            MAX_VDP_PAYLOAD_BYTES,
        )

        if file_path:
            real_path = os.path.realpath(file_path)
            if not os.path.isfile(real_path):
                raise HTTPException(status_code=400, detail="file_path không tồn tại hoặc không phải file")
            if not _is_pdf_path(real_path):
                raise HTTPException(status_code=400, detail="file_path không phải PDF hợp lệ")
            await run_in_threadpool(
                _copy_path_limited,
                real_path,
                template_path,
                MAX_VDP_PAYLOAD_BYTES,
            )
        elif file is not None:
            await run_in_threadpool(
                _copy_fileobj_limited,
                file.file,
                template_path,
                MAX_VDP_PAYLOAD_BYTES,
            )
            if not _is_pdf_path(template_path):
                raise HTTPException(status_code=400, detail="File tải lên không phải PDF hợp lệ")
        else:
            raise HTTPException(status_code=400, detail="No file or file_path provided")

        vdp_jobs[job_id] = {
            "status": "queued",
            "processed": 0,
            "total": 0,
            "result": None,
            "error": None,
            "created_at": time.time(),
            "cancel_requested": False,
            "cancel_event": threading.Event(),
            "cancel_file": _vdp_cancel_marker(job_id),
            "data_path": data_path,
            "template_path": template_path,
            "output_path": output_path,
            "future": None,
            "slot_released": False,
        }
        future = _VDP_EXECUTOR.submit(
            vdp_background_task_spooled,
            job_id,
            template_path,
            data_path,
            vdp_fields,
            normalized_format,
            has_header,
            output_path,
            _license_key=license_info.get("license_key", ""),
            _hwid=license_info.get("hwid", ""),
        )
        with _VDP_JOBS_LOCK:
            vdp_jobs[job_id]["future"] = future
        submitted = True
        return {"job_id": job_id}
    except HTTPException:
        raise
    except ValueError as exc:
        logger.error("Error preparing VDP input: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Error preparing VDP input")
        raise HTTPException(status_code=400, detail="Invalid data payload") from exc
    finally:
        if not submitted:
            vdp_jobs.pop(job_id, None)
            for path in (data_path, template_path, output_path):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except OSError:
                    pass
            _VDP_SUBMISSION_SLOTS.release()

@router.post("/vdp-cancel/{job_id}")
@router.post("/cancel/{job_id}", include_in_schema=False)
def cancel_vdp_job(job_id: str, license_info: dict = Depends(require_license)):
    """Request cooperative cancellation without failing on repeated calls."""
    with _VDP_JOBS_LOCK:
        job = vdp_jobs.get(job_id)
        if job is None:
            return {
                "job_id": job_id,
                "status": "not_found",
                "cancelled": False,
                "message": "Job not found",
            }
        previous_status = job.get("status", "unknown")
        if previous_status in {"completed", "failed"}:
            return {
                "job_id": job_id,
                "status": previous_status,
                "cancelled": False,
                "message": f"Job is already {previous_status}",
            }
        already_cancelled = previous_status == "cancelled"
        was_queued = previous_status == "queued"
        job["cancel_requested"] = True
        job["status"] = "cancelled"
        job["result"] = None
        job["error"] = None
        event = job.get("cancel_event")
        if event is not None:
            event.set()
        future = job.get("future")
        cancel_file = job.get("cancel_file") or _vdp_cancel_marker(job_id)
        job["cancel_file"] = cancel_file

    _touch_vdp_cancel_marker(cancel_file)
    cancelled_before_start = was_queued
    cancel_future = getattr(future, "cancel", None)
    if callable(cancel_future):
        try:
            cancelled_before_start = bool(cancel_future()) or cancelled_before_start
        except Exception as exc:
            logger.warning("Unable to cancel queued VDP future %s: %s", job_id, exc)

    if cancelled_before_start:
        _cleanup_vdp_job_files(job_id, job, include_output=True)
        _release_vdp_submission_slot(job)

    return {
        "job_id": job_id,
        "status": "cancelled",
        "cancelled": True,
        "already_cancelled": already_cancelled,
        "cancelled_before_start": cancelled_before_start,
    }


@router.get("/status/{job_id}")
def get_vdp_status(job_id: str, license_info: dict = Depends(require_license)):
    if job_id not in vdp_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
        
    job = vdp_jobs[job_id]
    
    if job['status'] == 'processing':
        # Calculate progress from temp files
        tmp_dir = tempfile.gettempdir()
        total_processed = 0
        for f in glob.glob(os.path.join(tmp_dir, f"vdp_prog_{job_id}_*.txt")):
            try:
                with open(f, 'r', encoding='utf-8', errors='replace') as fp:
                    content = fp.read().strip()
                    if content.isdigit():
                        total_processed += int(content)
            except (IOError, OSError, UnicodeDecodeError):
                pass
        job['processed'] = total_processed
                
    return {
        "status": job.get("status"),
        "processed": job.get("processed", 0),
        "total": job.get("total", 0),
        "result": job.get("result"),
        "error": job.get("error"),
        "cancel_requested": bool(job.get("cancel_requested")),
    }

@router.get("/download/{job_id}")
def download_vdp(job_id: str, license_info: dict = Depends(require_license)):
    if job_id not in vdp_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
        
    job = vdp_jobs[job_id]
    if job['status'] != 'completed' or not job['result']:
        raise HTTPException(status_code=400, detail="Job is not completed yet")
        
    if not os.path.exists(job['result']):
        raise HTTPException(status_code=404, detail="File not found on server")
        
    return FileResponse(
        path=job['result'],
        filename=f"VDP_Output_{job['total']}records.pdf",
        media_type='application/pdf'
    )

@router.post("/upload")
async def upload_file_for_processing(file: UploadFile = File(...), license_info: dict = Depends(require_license)):
    """Upload a PDF file and return its server-side path for backend processing."""
    file_id = uuid.uuid4().hex
    file_path = os.path.join(UPLOAD_DIR, f"{file_id}.pdf")
    content = await file.read()
    # Chặn upload RỖNG/cụt: tránh ghi file 0 byte rồi vỡ với lỗi khó hiểu
    # ("unable to find trailer dictionary") ở các bước đọc PDF sau này.
    if not content:
        raise HTTPException(status_code=400, detail="File rỗng (0 byte) — nội dung tải lên không hợp lệ.")
    with open(file_path, "wb") as f:
        f.write(content)
    return {"path": os.path.abspath(file_path)}

@router.get("/fonts")
def get_system_fonts(license_info: dict = Depends(require_license)):
    import platform
    fonts = []
    os_name = platform.system()
    if os_name == "Windows":
        import winreg
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
            count = winreg.QueryInfoKey(key)[1]
            fonts_dir = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts')
            for i in range(count):
                name, value, _ = winreg.EnumValue(key, i)
                if not value.lower().endswith(('.ttf', '.otf', '.ttc')):
                    continue
                path = value if os.path.isabs(value) else os.path.join(fonts_dir, value)
                clean_name = name.replace(' (TrueType)', '').replace(' (OpenType)', '').strip()
                fonts.append({"name": clean_name, "path": path})
        except Exception as e:
            logger.warning("Error reading Windows registry: %s", e)
            pass
    elif os_name == "Darwin":
        font_dirs = [
            "/System/Library/Fonts",
            "/Library/Fonts",
            os.path.expanduser("~/Library/Fonts")
        ]
        for d in font_dirs:
            if os.path.exists(d):
                for f in os.listdir(d):
                    if f.lower().endswith(('.ttf', '.otf', '.ttc')):
                        clean_name = os.path.splitext(f)[0]
                        fonts.append({"name": clean_name, "path": os.path.join(d, f)})
    
    fonts.sort(key=lambda x: x["name"].lower())
    return {"fonts": fonts}


# ─────────────────────────────────────────────────────────────────────────────
# VDP Upgrade routes (Tier-1): nguồn dữ liệu, validate, preview, báo cáo lỗi.
#
# Mọi route giữ Depends(require_license) như các route hiện có. Lỗi đọc nguồn
# (DataSourceError) được chuyển thành HTTP 400 với detail là thông báo tiếng
# Việt (design.md — Error Handling). Route /validate KHÔNG sinh bất kỳ artifact
# PDF nào (Req 5.7).
# ─────────────────────────────────────────────────────────────────────────────

# Số dòng xem trước trả về cho /vdp/datasource (đủ để UI hiển thị mẫu cột).
DATASOURCE_PREVIEW_ROWS = 20


def _parse_fields(fields_json: str) -> List[VdpField]:
    """Phân tích chuỗi JSON cấu hình field thành danh sách ``VdpField``.

    Lỗi JSON/schema → HTTP 400 với thông báo tiếng Việt (giữ phong cách các
    route hiện có).
    """
    try:
        parsed = json.loads(fields_json)
        return [VdpField(**f) for f in parsed]
    except HTTPException:
        raise
    except Exception as exc:  # JSONDecodeError hoặc lỗi validate pydantic
        logger.debug("Invalid fields payload: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Dữ liệu cấu hình field (fields) không hợp lệ.",
        )


async def _form_or_file_text(value: Optional[str], upload: Optional[UploadFile]) -> Optional[str]:
    """Lấy nội dung JSON từ trường form chuỗi HOẶC từ file upload.

    Trường form multipart bị Starlette giới hạn 1MB mỗi part; dữ liệu lớn (vd
    ``rows``/``issues`` của lô nhiều bản ghi) phải gửi qua file part (UploadFile)
    để không bị chặn — giống cách ``/generate`` gửi ``data_file``. Ưu tiên ``value``
    (form) nếu có; nếu không thì đọc ``upload`` (file). Trả ``None`` khi cả hai trống.
    """
    if value is not None:
        return value
    if upload is not None:
        raw = await upload.read()
        return raw.decode("utf-8", errors="replace")
    return None


async def _read_table_from_source(
    kind: str,
    file: Optional[UploadFile],
    url: Optional[str],
    text: Optional[str],
    sheet: Optional[str],
    has_header: bool,
) -> RecordTable:
    """Đọc nguồn dữ liệu (csv/xlsx/gsheet) → ``RecordTable``.

    Quy ``DataSourceError`` về HTTP 400 với ``detail`` là thông báo tiếng Việt.
    """
    normalized = (kind or "").strip().lower()

    if normalized == "csv":
        if file is not None:
            payload: Any = await file.read()
        elif text is not None:
            payload = text
        else:
            raise HTTPException(
                status_code=400,
                detail="Thiếu dữ liệu nguồn CSV (cần tải file hoặc dán nội dung).",
            )
    elif normalized in ("xlsx", "excel"):
        if file is None:
            raise HTTPException(
                status_code=400,
                detail="Thiếu file Excel (.xlsx) để đọc.",
            )
        payload = await file.read()
    elif normalized in ("gsheet", "gsheets", "google-sheets"):
        if not url:
            raise HTTPException(
                status_code=400,
                detail="Thiếu đường liên kết (URL) Google Sheets.",
            )
        payload = url
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Định dạng nguồn dữ liệu không được hỗ trợ: '{kind}'.",
        )

    try:
        return read_source(normalized, payload, sheet=sheet, has_header=has_header)
    except DataSourceError as exc:
        raise HTTPException(status_code=400, detail=exc.message)


def _table_from_rows(
    rows_json: Optional[str], columns_json: Optional[str]
) -> Optional[RecordTable]:
    """Dựng ``RecordTable`` từ rows (và tuỳ chọn columns) đã nạp sẵn ở phía UI.

    Khi không truyền ``rows_json`` → trả ``None`` (nguồn chưa nạp). Khi không
    truyền ``columns_json`` → suy cột từ khoá của các dòng theo thứ tự xuất hiện.
    """
    if rows_json is None:
        return None
    try:
        rows = json.loads(rows_json)
        if not isinstance(rows, list):
            raise ValueError("rows phải là một mảng JSON")
        rows = [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("Invalid rows payload: %s", exc)
        raise HTTPException(
            status_code=400,
            detail="Dữ liệu dòng record (rows) không hợp lệ.",
        )

    if columns_json:
        try:
            columns = list(json.loads(columns_json))
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Dữ liệu danh sách cột (columns) không hợp lệ.",
            )
    else:
        columns = []
        seen: set = set()
        for row in rows:
            for key in row.keys():
                if key not in seen:
                    seen.add(key)
                    columns.append(key)

    return RecordTable(columns=columns, rows=rows)


async def _resolve_table(
    kind: Optional[str],
    file: Optional[UploadFile],
    url: Optional[str],
    text: Optional[str],
    sheet: Optional[str],
    has_header: bool,
    rows_json: Optional[str],
    columns_json: Optional[str],
) -> Optional[RecordTable]:
    """Lấy ``RecordTable`` từ một nguồn (đọc lại) HOẶC từ rows đã nạp sẵn.

    Ưu tiên nguồn (``kind``) nếu được cung cấp; nếu không, dùng ``rows_json``.
    Trả ``None`` khi không có cả hai (nguồn chưa nạp) — caller xử lý theo ngữ cảnh.
    """
    if kind:
        return await _read_table_from_source(kind, file, url, text, sheet, has_header)
    return _table_from_rows(rows_json, columns_json)


@router.post("/datasource")
async def read_datasource(
    kind: str = Form(...),
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    sheet: Optional[str] = Form(None),
    has_header: bool = Form(True),
    include_all_rows: bool = Form(False),
    license_info: dict = Depends(require_license),
):
    """Đọc nguồn dữ liệu (csv/xlsx/gsheet) → cột + số record + xem trước (Req 1.1, 1.3).

    Mặc định chỉ trả ``preview_rows`` (tối đa ``DATASOURCE_PREVIEW_ROWS`` dòng) để
    UI hiển thị mẫu cột. Khi ``include_all_rows=True``, trả thêm ``rows`` chứa
    TOÀN BỘ record — dùng cho bước sinh lô (generate) với nguồn xlsx/gsheet, tránh
    việc chỉ sinh theo 20 dòng preview (mất dữ liệu âm thầm).

    ``DataSourceError`` → HTTP 400 với thông báo tiếng Việt.
    """
    table = await _read_table_from_source(kind, file, url, text, sheet, has_header)
    result = {
        "columns": table.columns,
        "record_count": len(table.rows),
        "preview_rows": table.rows[:DATASOURCE_PREVIEW_ROWS],
    }
    if include_all_rows:
        result["rows"] = table.rows
    return result


@router.post("/datasource/sheets")
async def read_datasource_sheets(
    file: UploadFile = File(...),
    license_info: dict = Depends(require_license),
):
    """Liệt kê tên sheet của một file Excel ``.xlsx`` để người dùng chọn (Req 1.3)."""
    data = await file.read()
    try:
        sheets = list_xlsx_sheets(data)
    except DataSourceError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    return {"sheets": sheets}


@router.post("/validate")
async def validate_vdp(
    fields: str = Form(...),
    kind: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    sheet: Optional[str] = Form(None),
    has_header: bool = Form(True),
    rows: Optional[str] = Form(None),
    columns: Optional[str] = Form(None),
    rows_file: Optional[UploadFile] = File(None),
    license_info: dict = Depends(require_license),
):
    """Kiểm tra cấu hình field + dữ liệu TRƯỚC khi sinh lô (Req 5.*).

    KHÔNG sinh bất kỳ artifact PDF nào (Req 5.7). Trả danh sách ``issues`` và
    ``gating`` (``block`` | ``needs_confirmation`` | ``allow``). Nguồn chưa nạp/0
    record được ``validate_batch`` coi là lỗi chặn (Req 5.8, 5.11).
    """
    vdp_fields = _parse_fields(fields)
    rows = await _form_or_file_text(rows, rows_file)
    table = await _resolve_table(
        kind, file, url, text, sheet, has_header, rows, columns
    )

    issues = validate_batch(vdp_fields, table)
    gating = gating_state(issues)

    return {
        "gating": gating,
        "issues": [
            {
                "severity": i.severity,
                "record_idx": i.record_idx,
                "field": i.field,
                "reason": i.reason,
            }
            for i in issues
        ],
    }


@router.post("/preview")
async def preview_vdp(
    fields: str = Form(...),
    requested_index: int = Form(...),
    template: Optional[UploadFile] = File(None),
    template_path: Optional[str] = Form(None),
    kind: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    sheet: Optional[str] = Form(None),
    has_header: bool = Form(True),
    rows: Optional[str] = Form(None),
    columns: Optional[str] = Form(None),
    rows_file: Optional[UploadFile] = File(None),
    scale: float = Form(2.0),
    license_info: dict = Depends(require_license),
):
    """Render bản xem trước record thứ N → PNG (base64) + field_errors (Req 4.1–4.6, 4.10).

    Template nhận từ upload (``template``) hoặc đường dẫn server (``template_path``).
    Dùng chung ``render_record_preview`` để bảo toàn parity preview ↔ output.
    """
    vdp_fields = _parse_fields(fields)
    rows = await _form_or_file_text(rows, rows_file)
    table = await _resolve_table(
        kind, file, url, text, sheet, has_header, rows, columns
    )
    if table is None:
        raise HTTPException(
            status_code=400,
            detail="Nguồn dữ liệu chưa được nạp để xem trước.",
        )

    # Chuẩn bị template trên đĩa cho render_record_preview.
    tmp_template: Optional[str] = None
    resolved_template_path: Optional[str] = None
    if template is not None:
        template_bytes = await template.read()
        if not template_bytes.startswith(b"%PDF"):
            raise HTTPException(
                status_code=400, detail="File template tải lên không phải PDF hợp lệ."
            )
        tmp_template = os.path.join(
            tempfile.gettempdir(), f"vdp_preview_tpl_{uuid.uuid4().hex}.pdf"
        )
        with open(tmp_template, "wb") as fp:
            fp.write(template_bytes)
        resolved_template_path = tmp_template
    elif template_path:
        real_path = os.path.realpath(template_path)
        if not os.path.isfile(real_path):
            raise HTTPException(
                status_code=400,
                detail="template_path không tồn tại hoặc không phải file.",
            )
        resolved_template_path = real_path
    else:
        raise HTTPException(
            status_code=400,
            detail="Thiếu template (cần tải file hoặc cung cấp template_path).",
        )

    try:
        result = render_record_preview(
            resolved_template_path,
            vdp_fields,
            table.rows,
            requested_index,
            scale=scale,
        )
    finally:
        if tmp_template and os.path.exists(tmp_template):
            try:
                os.remove(tmp_template)
            except OSError:
                pass

    image_b64 = (
        base64.b64encode(result.image_png).decode("ascii")
        if result.image_png is not None
        else None
    )

    return {
        "image_png_base64": image_b64,
        "record_index": result.record_index,
        "clamped": result.clamped,
        "empty_source": result.empty_source,
        "width": result.width,
        "height": result.height,
        "message": result.message,
        "field_errors": [
            {
                "field": e.field,
                "kind": e.kind,
                "rect": e.rect,
                "reason": e.reason,
            }
            for e in result.field_errors
        ],
    }


@router.post("/error-report")
async def error_report_vdp(
    issues: Optional[str] = Form(None),
    fields: Optional[str] = Form(None),
    kind: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    sheet: Optional[str] = Form(None),
    has_header: bool = Form(True),
    rows: Optional[str] = Form(None),
    columns: Optional[str] = Form(None),
    rows_file: Optional[UploadFile] = File(None),
    issues_file: Optional[UploadFile] = File(None),
    license_info: dict = Depends(require_license),
):
    """Sinh báo cáo lỗi CSV tải về (Req 4.7, 4.8).

    Hai chế độ:
    - Truyền ``issues`` (JSON) đã có sẵn → sinh CSV trực tiếp.
    - Truyền ``fields`` + nguồn/rows → tính lại issue qua ``validate_batch`` rồi sinh CSV.
    """
    issues = await _form_or_file_text(issues, issues_file)
    rows = await _form_or_file_text(rows, rows_file)
    if issues is not None:
        try:
            issue_list = json.loads(issues)
            if not isinstance(issue_list, list):
                raise ValueError("issues phải là một mảng JSON")
        except Exception as exc:
            logger.debug("Invalid issues payload: %s", exc)
            raise HTTPException(
                status_code=400, detail="Dữ liệu issues không hợp lệ."
            )
    elif fields is not None:
        vdp_fields = _parse_fields(fields)
        table = await _resolve_table(
            kind, file, url, text, sheet, has_header, rows, columns
        )
        issue_list = validate_batch(vdp_fields, table)
    else:
        raise HTTPException(
            status_code=400,
            detail="Cần cung cấp 'issues' hoặc 'fields' (kèm nguồn) để sinh báo cáo lỗi.",
        )

    csv_text = build_error_report_csv(issue_list)
    # Thêm BOM UTF-8 để Excel mở đúng tiếng Việt có dấu.
    content = ("\ufeff" + csv_text).encode("utf-8")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=vdp_error_report.csv"
        },
    )
