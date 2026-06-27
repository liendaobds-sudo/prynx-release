from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File, Form, Depends
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
import os
import uuid
import json
import time
import base64
import tempfile
import multiprocessing
from typing import List, Dict, Optional, Any, Tuple
from app.schemas.vdp import VdpRequest, VdpField
from app.workers.vdp_engine import run_vdp_engine
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
from app.core.license_guard import require_license
from app.config import settings

import logging

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

# In-memory job store
# In production with multiple Uvicorn workers, this should be Redis.
vdp_jobs = {}

# ── Giới hạn tài nguyên ──
VDP_JOB_TTL_SECONDS = 3600          # Dọn job + file kết quả sau 1 giờ
MAX_VDP_ROWS = 100_000              # Chặn payload quá lớn gây OOM/đầy đĩa


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
        if now - created > VDP_JOB_TTL_SECONDS:
            result_path = job.get("result")
            if result_path and os.path.exists(result_path):
                try:
                    os.remove(result_path)
                except OSError:
                    pass
            vdp_jobs.pop(jid, None)

import glob
import tempfile

def vdp_background_task(job_id: str, template_path: str, fields: List[VdpField], data: List[Dict[str, str]], output_path: str, **kwargs):
    try:
        def on_saving():
            vdp_jobs[job_id]['status'] = 'saving'
            
        run_vdp_engine(template_path, fields, data, output_path, job_id=job_id, on_saving=on_saving, **kwargs)
            
        vdp_jobs[job_id]['status'] = 'completed'
        vdp_jobs[job_id]['result'] = output_path
        
    except Exception as e:
        vdp_jobs[job_id]['status'] = 'failed'
        vdp_jobs[job_id]['error'] = str(e)
    finally:
        # Cleanup temp progress files
        tmp_dir = tempfile.gettempdir()
        for f in glob.glob(os.path.join(tmp_dir, f"vdp_prog_{job_id}_*.txt")):
            try:
                os.remove(f)
            except OSError:
                pass
        
        if os.path.exists(template_path):
            try:
                os.remove(template_path)
            except Exception:
                pass

@router.post("/generate")
async def start_vdp_job(
    background_tasks: BackgroundTasks,
    fields: str = Form(...),
    data_file: UploadFile = File(...),
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    license_info: dict = Depends(require_license),
):
    logger.debug("Received POST /generate")
    _purge_old_jobs()
    try:
        fields_parsed = json.loads(fields)
        logger.debug("Parsed fields")
        data_content = await data_file.read()
        logger.debug("Read data content: %d bytes", len(data_content))
        data_parsed = json.loads(data_content)
        logger.debug("Parsed %d rows", len(data_parsed))
        
        vdp_fields = [VdpField(**f) for f in fields_parsed]
    except Exception as e:
        logger.error("Error parsing input: %s", e)
        raise HTTPException(status_code=400, detail="Invalid JSON data")
        
    if not data_parsed:
        raise HTTPException(status_code=400, detail="Data array is empty")

    if len(data_parsed) > MAX_VDP_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"Quá nhiều bản ghi ({len(data_parsed)}). Tối đa {MAX_VDP_ROWS}.",
        )

    template_id = uuid.uuid4().hex
    template_path = os.path.join(UPLOAD_DIR, f"{template_id}.pdf")

    import shutil

    def _is_pdf(p: str) -> bool:
        try:
            with open(p, "rb") as fp:
                return fp.read(5).startswith(b"%PDF")
        except OSError:
            return False

    used = False
    if file_path:
        # Đường dẫn local hợp lệ (Tauri gửi path thật của người dùng), nhưng phải
        # chuẩn hoá + xác thực là FILE PDF thật để server không bị lừa copy/nhúng
        # file nhạy cảm khác (defense-in-depth, bug #6).
        real_path = os.path.realpath(file_path)
        if not os.path.isfile(real_path):
            raise HTTPException(status_code=400, detail="file_path không tồn tại hoặc không phải file")
        if not _is_pdf(real_path):
            raise HTTPException(status_code=400, detail="file_path không phải PDF hợp lệ")
        logger.debug("Using local file path: %s", real_path)
        shutil.copy2(real_path, template_path)
        used = True

    if not used:
        if file:
            file_bytes = await file.read()
            logger.debug("Received template file: %d bytes", len(file_bytes))
            if len(file_bytes) == 0:
                raise HTTPException(status_code=400, detail="Uploaded template PDF is 0 bytes")
            if not file_bytes.startswith(b"%PDF"):
                raise HTTPException(status_code=400, detail="File tải lên không phải PDF hợp lệ")
            with open(template_path, "wb") as f:
                f.write(file_bytes)
        else:
            raise HTTPException(status_code=400, detail="No file or file_path provided")
        
    job_id = uuid.uuid4().hex
    # Đường dẫn TUYỆT ĐỐI: path này được trả về frontend và dùng bởi Rust tile
    # renderer (cwd khác backend). Nếu để tương đối ("./results/..."), Rust không
    # tìm thấy file (os error 3) → render hỏng dù Python mở được.
    output_path = os.path.abspath(os.path.join(RESULTS_DIR, f"vdp_{job_id}.pdf"))
    
    vdp_jobs[job_id] = {
        "status": "processing",
        "processed": 0,
        "total": len(data_parsed),
        "result": None,
        "error": None,
        "created_at": time.time(),
    }
    
    background_tasks.add_task(
        vdp_background_task, job_id, template_path, vdp_fields, data_parsed, output_path,
        _license_key=license_info.get("license_key", ""),
        _hwid=license_info.get("hwid", ""),
    )
    
    return {"job_id": job_id}

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
                
    return job

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
    license_info: dict = Depends(require_license),
):
    """Đọc nguồn dữ liệu (csv/xlsx/gsheet) → cột + số record + xem trước (Req 1.1, 1.3).

    ``DataSourceError`` → HTTP 400 với thông báo tiếng Việt.
    """
    table = await _read_table_from_source(kind, file, url, text, sheet, has_header)
    return {
        "columns": table.columns,
        "record_count": len(table.rows),
        "preview_rows": table.rows[:DATASOURCE_PREVIEW_ROWS],
    }


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
