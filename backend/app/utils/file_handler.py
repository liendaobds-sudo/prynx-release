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

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
async def _save_upload_file(upload_file: UploadFile) -> tuple[str, str, int]:
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
    setattr(upload_file, '_prynx_partial_path', file_path)

    # SEC (pentest 2026-08-28 §ATK.03): cưỡng chế trần dung lượng ĐÃ KHAI trong config
    # (MAX_FILE_SIZE_MB, mặc định 500MB). Trước đây vòng đọc chunk KHÔNG kiểm tổng nên một
    # file khổng lồ (hoặc luồng upload vô tận) làm đầy đĩa rồi treo các bước xử lý sau
    # (DoS). Đây KHÔNG phải hard-cap vô điều kiện: trần do người vận hành đặt qua env, máy
    # mạnh cứ nâng lên. Vượt trần thì raise ValueError; save_upload_file() bọc ngoài đã
    # dọn file dở trên MỌI nhánh lỗi, và các route (save_upload/pdf_tools) map sang 413.
    max_bytes = settings.MAX_FILE_SIZE_MB * 1024 * 1024

    # Save file
    file_size = 0
    async with aiofiles.open(file_path, "wb") as f:
        while chunk := await upload_file.read(1024 * 1024):  # 1MB chunks
            file_size += len(chunk)
            if max_bytes > 0 and file_size > max_bytes:
                raise ValueError(
                    f"File vượt quá giới hạn {settings.MAX_FILE_SIZE_MB}MB cho mỗi lần tải lên."
                )
            await f.write(chunk)

    logger.info(f"Saved upload: {upload_file.filename} → {stored_name} ({file_size} bytes)")
    return stored_name, file_path, file_size



async def save_upload_file(upload_file: UploadFile) -> tuple[str, str, int]:
    """Save an upload and remove any partial file on every failure path."""
    try:
        return await _save_upload_file(upload_file)
    except BaseException:
        partial_path = getattr(upload_file, '_prynx_partial_path', None)
        if partial_path:
            try:
                os.remove(partial_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.warning('Could not remove partial upload %s', partial_path, exc_info=True)
        raise

def cleanup_job_files(job_id: str):
    """Remove all files associated with a job."""
    results_dir = Path(settings.RESULTS_DIR) / str(job_id)
    if results_dir.exists():
        shutil.rmtree(results_dir)
        logger.info(f"Cleaned up job files: {job_id}")
