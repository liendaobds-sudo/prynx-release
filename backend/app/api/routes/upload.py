"""
Upload API endpoints.
"""
import logging
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.job import UploadedFile as UploadedFileModel
from app.schemas.job import FileUploadResponse
from app.utils.file_handler import save_upload_file
from app.core.pdf_processor import PDFProcessor
from app.core.license_guard import require_license

# Uploaded files auto-expire after this duration (cleanup task deletes them)
FILE_EXPIRY_HOURS = 24

logger = logging.getLogger(__name__)
router = APIRouter()
processor = PDFProcessor()


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
        raise HTTPException(status_code=400, detail=f"Lỗi hệ thống ({type(e).__name__})")

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
