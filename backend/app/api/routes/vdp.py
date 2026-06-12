from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File, Form, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os
import uuid
import json
import time
import multiprocessing
from typing import List, Dict, Optional
from app.schemas.vdp import VdpRequest, VdpField
from app.workers.vdp_engine import run_vdp_engine
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
        raise HTTPException(status_code=400, detail=f"Invalid JSON data: {e}")
        
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
    output_path = os.path.join(RESULTS_DIR, f"vdp_{job_id}.pdf")
    
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
                with open(f, 'r') as fp:
                    content = fp.read().strip()
                    if content.isdigit():
                        total_processed += int(content)
            except (IOError, OSError):
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
    with open(file_path, "wb") as f:
        f.write(await file.read())
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
