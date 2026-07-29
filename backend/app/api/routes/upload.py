"""
Upload API endpoints.
"""
import logging
import os
import shutil
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.job import UploadedFile as UploadedFileModel
from app.schemas.job import FileUploadResponse, LocalFileUploadRequest
from app.utils.file_handler import save_upload_file
from app.core.pdf_processor import PDFProcessor
from app.core.license_guard import require_license
from app.config import settings

# Uploaded files auto-expire after this duration (cleanup task deletes them)
FILE_EXPIRY_HOURS = 24

logger = logging.getLogger(__name__)
router = APIRouter()
processor = PDFProcessor()


@router.post("/upload/local", response_model=FileUploadResponse)
def register_local_pdf(
    request: LocalFileUploadRequest,
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_license),
):
    """Register a desktop-local PDF without moving its bytes through WebView RAM."""
    if not (settings.IS_DESKTOP_APP or settings.DEV_MODE):
        raise HTTPException(status_code=403, detail="Ch\u1ec9 kh\u1ea3 d\u1ee5ng trong \u1ee9ng d\u1ee5ng desktop")

    raw_path = Path(request.file_path)
    if not raw_path.is_absolute():
        raise HTTPException(status_code=400, detail="\u0110\u01b0\u1eddng d\u1eabn file ph\u1ea3i l\u00e0 tuy\u1ec7t \u0111\u1ed1i")
    try:
        source = raw_path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Kh\u00f4ng t\u00ecm th\u1ea5y file PDF tr\u00ean m\u00e1y")

    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Ch\u1ec9 ch\u1ea5p nh\u1eadn file PDF")
    file_size = source.stat().st_size
    max_size = settings.MAX_FILE_SIZE_MB * 1024 * 1024
    if file_size > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File qu\u00e1 l\u1edbn. K\u00edch th\u01b0\u1edbc t\u1ed1i \u0111a: {settings.MAX_FILE_SIZE_MB}MB",
        )

    stored_name = f"{uuid.uuid4().hex}.pdf"
    stored_path = Path(settings.UPLOAD_DIR) / stored_name
    stored_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        # Same-volume desktop files become a hard link (O(1), no extra data).
        # Cross-volume files fall back to a kernel-streamed copy without WebView RAM.
        try:
            os.link(source, stored_path)
        except OSError:
            shutil.copy2(source, stored_path)
    except OSError as exc:
        logger.exception("Could not register local PDF: %s", source)
        raise HTTPException(status_code=400, detail=f"Kh\u00f4ng th\u1ec3 \u0111\u1ecdc file PDF: {exc}")

    try:
        metadata = processor.get_metadata(str(stored_path))
        page_count = metadata.get("page_count", 0)
    except Exception as exc:
        logger.warning("Could not extract local PDF metadata: %s", exc)
        metadata = {}
        page_count = None

    db_file = UploadedFileModel(
        filename=stored_name,
        original_name=source.name,
        file_path=str(stored_path),
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=FILE_EXPIRY_HOURS),
    )
    db.add(db_file)
    db.commit()
    db.refresh(db_file)

    logger.info("Registered local PDF without multipart upload: %s", source)
    return FileUploadResponse(
        id=db_file.id,
        filename=stored_name,
        original_name=source.name,
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
    )


@router.post("/upload", response_model=FileUploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_license),
):
    """Upload a PDF file for comparison."""
    valid_exts = (".pdf", ".png", ".jpg", ".jpeg", ".webp")
    if not file.filename.lower().endswith(valid_exts):
        raise HTTPException(
            status_code=400,
            detail="Chỉ chấp nhận file PDF và ảnh (PNG, JPG). Vui lòng chọn đúng định dạng."
        )

    try:
        stored_name, file_path, file_size = await save_upload_file(file)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Tải file lên thất bại: {e}")

    # Extract metadata
    try:
        metadata = processor.get_metadata(file_path)
        page_count = metadata.get("page_count", 0)
    except Exception as e:
        logger.warning(f"Could not extract metadata: {e}")
        metadata = {}
        page_count = None

    # Save to database
    db_file = UploadedFileModel(
        filename=stored_name,
        original_name=file.filename,
        file_path=file_path,
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=FILE_EXPIRY_HOURS),
    )
    db.add(db_file)
    db.commit()
    db.refresh(db_file)

    logger.info(f"Uploaded: {file.filename} → {db_file.id}")

    return FileUploadResponse(
        id=db_file.id,
        filename=stored_name,
        original_name=file.filename,
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
    )
