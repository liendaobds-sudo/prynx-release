"""
File utility helpers.
"""
import os
import uuid
import shutil
import logging
from pathlib import Path

import aiofiles
from fastapi import UploadFile

from app.config import settings

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}
MAX_FILE_SIZE = settings.MAX_FILE_SIZE_MB * 1024 * 1024


async def save_upload_file(upload_file: UploadFile) -> tuple[str, str, int]:
    """
    Save uploaded file to disk.
    Returns: (stored_filename, file_path, file_size)
    """
    # Validate extension
    ext = Path(upload_file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Định dạng file không hỗ trợ: {ext}. Chỉ chấp nhận PDF và Hình ảnh.")

    # Generate unique filename
    stored_name = f"{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(settings.UPLOAD_DIR, stored_name)

    # Save file
    file_size = 0
    async with aiofiles.open(file_path, "wb") as f:
        while chunk := await upload_file.read(1024 * 1024):  # 1MB chunks
            file_size += len(chunk)
            if file_size > MAX_FILE_SIZE:
                os.remove(file_path)
                raise ValueError(
                    f"File quá lớn. Kích thước tối đa: {settings.MAX_FILE_SIZE_MB}MB"
                )
            await f.write(chunk)

    logger.info(f"Saved upload: {upload_file.filename} → {stored_name} ({file_size} bytes)")
    return stored_name, file_path, file_size


def cleanup_job_files(job_id: str):
    """Remove all files associated with a job."""
    results_dir = Path(settings.RESULTS_DIR) / str(job_id)
    if results_dir.exists():
        shutil.rmtree(results_dir)
        logger.info(f"Cleaned up job files: {job_id}")
