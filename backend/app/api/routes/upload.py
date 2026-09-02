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
from starlette.concurrency import run_in_threadpool

from app.database import get_db
from app.models.job import UploadedFile as UploadedFileModel
from app.schemas.job import FileUploadResponse, LocalFileUploadRequest
from app.utils.file_handler import save_upload_file
from app.core import pdf_intake
from app.core.parser_sandbox import (
    IsolatedParseCrashed,
    IsolatedParseTimeout,
    run_isolated,
)
from app.core.license_guard import require_license
from app.config import settings

# Uploaded files auto-expire after this duration (cleanup task deletes them)
FILE_EXPIRY_HOURS = 24

logger = logging.getLogger(__name__)
router = APIRouter()


def _remove_stored_file(file_path: str | Path) -> None:
    """Xóa bản lưu do backend tạo; không bao giờ nhận đường dẫn file nguồn."""
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError:
        logger.warning("Không thể dọn file upload lỗi: %s", file_path, exc_info=True)


def _rollback_quietly(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        logger.warning("Không thể rollback bản ghi upload lỗi", exc_info=True)


def _validate_pdf_and_extract_metadata(file_path: str) -> tuple[dict, int]:
    """Xác nhận file là PDF dùng được rồi mới cho phép ghi nhận thành công."""
    path = Path(file_path)

    try:
        file_size = path.stat().st_size
        with path.open("rb") as source:
            header = source.read(1024)
    except OSError as exc:
        logger.exception("Không thể đọc bản PDF vừa lưu: %s", path)
        raise HTTPException(
            status_code=500,
            detail="Không thể đọc file PDF vừa lưu. Vui lòng thử lại.",
        ) from exc

    if file_size == 0:
        raise HTTPException(
            status_code=400,
            detail="File PDF đang rỗng (0 byte). Vui lòng chọn lại file có nội dung.",
        )
    if b"%PDF-" not in header:
        raise HTTPException(
            status_code=400,
            detail="Nội dung file không phải PDF, dù tên file có đuôi .pdf.",
        )

    # SEC (pentest 2026-08-28 §ATK.04): phần CHẠM PARSER (qpdf/pypdf/PDFium) chạy trong
    # PROCESS CON. Đây là bề mặt đầu tiên đọc file khách gửi, nên một lỗi bộ nhớ của
    # parser tại đây trước kia sẽ giết cả sidecar (mất mọi phiên làm việc). Cách ly khiến
    # ca đó chỉ chết worker và trả lỗi sạch. Chi phí đo được: ~+0,3 ms/lần nhờ pool giữ
    # sẵn (process mới mỗi lần sẽ là ~+165 ms — xem `parser_sandbox`).
    #
    # Việc kiểm cấp-byte ở trên (rỗng / thiếu chữ ký %PDF-) CỐ Ý ở lại tiến trình cha:
    # nó không gọi parser nào và loại phần lớn rác trước khi tốn một vòng IPC.
    try:
        result = run_isolated(pdf_intake.inspect_pdf_for_intake, str(path))
    except IsolatedParseCrashed as exc:
        # Parser sập giữa lúc đọc: coi là file không dùng được, KHÔNG phải lỗi server.
        logger.error("Parser sập khi đọc PDF vừa lưu %s: %s", path, exc)
        raise HTTPException(
            status_code=400,
            detail="File PDF bị hỏng hoặc chưa tải xuống đầy đủ. Vui lòng xuất/tải lại file.",
        ) from exc
    except IsolatedParseTimeout as exc:
        logger.warning("Đọc PDF vượt trần thời gian %s: %s", path, exc)
        raise HTTPException(status_code=504, detail=str(exc)) from exc

    status = result.get("status")

    if status == pdf_intake.STATUS_ENCRYPTED:
        raise HTTPException(
            status_code=422,
            detail="File PDF bị mã hóa. Vui lòng bỏ mã hóa rồi mở lại.",
        )
    if status == pdf_intake.STATUS_PASSWORD:
        raise HTTPException(
            status_code=422,
            detail="File PDF có mật khẩu hoặc bị mã hóa. Vui lòng gỡ mật khẩu rồi mở lại.",
        )
    if status == pdf_intake.STATUS_CORRUPT:
        logger.info("Từ chối PDF bị hỏng %s: %s", path, result.get("detail"))
        raise HTTPException(
            status_code=400,
            detail="File PDF bị hỏng hoặc chưa tải xuống đầy đủ. Vui lòng xuất/tải lại file.",
        )
    if status == pdf_intake.STATUS_NO_PAGES:
        raise HTTPException(
            status_code=400,
            detail="File PDF không có trang nào để mở.",
        )
    if status == pdf_intake.STATUS_METADATA_FAILED:
        logger.error("Không thể đọc thông tin PDF: %s (%s)", path, result.get("detail"))
        raise HTTPException(
            status_code=500,
            detail="Không thể đọc thông tin PDF. Vui lòng thử xuất lại file hoặc mở file khác.",
        )
    if status == pdf_intake.STATUS_METADATA_MISMATCH:
        logger.error(
            "Thông tin PDF không hợp lệ: %s (pikepdf=%s, metadata=%r)",
            path,
            result.get("page_count"),
            result.get("metadata_page_count"),
        )
        raise HTTPException(
            status_code=500,
            detail="Không thể xác nhận thông tin PDF. Vui lòng thử xuất lại file.",
        )
    if status != pdf_intake.STATUS_OK:
        # Trạng thái lạ nghĩa là hợp đồng giữa hai module đã lệch — fail-closed, không
        # đoán bừa rồi ghi nhận một upload chưa được xác nhận.
        logger.error("Trạng thái khám PDF không nhận diện được: %r (%s)", status, path)
        raise HTTPException(
            status_code=500,
            detail="Không thể xác nhận thông tin PDF. Vui lòng thử xuất lại file.",
        )

    return result["metadata"], result["page_count"]


def _persist_uploaded_pdf(
    *,
    db: Session,
    stored_name: str,
    original_name: str,
    file_path: str,
    file_size: int,
    metadata: dict,
    page_count: int,
) -> FileUploadResponse:
    """Ghi DB hoặc rollback và dọn bản lưu nếu giao dịch thất bại."""
    db_file = UploadedFileModel(
        filename=stored_name,
        original_name=original_name,
        file_path=file_path,
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=FILE_EXPIRY_HOURS),
    )
    try:
        db.add(db_file)
        db.flush()
        db.refresh(db_file)
        file_id = db_file.id
        db.commit()
    except Exception as exc:
        _rollback_quietly(db)
        _remove_stored_file(file_path)
        logger.exception("Không thể ghi nhận file PDF vào cơ sở dữ liệu")
        raise HTTPException(
            status_code=500,
            detail="Không thể ghi nhận file PDF. Vui lòng thử lại.",
        ) from exc

    return FileUploadResponse(
        id=file_id,
        filename=stored_name,
        original_name=original_name,
        file_size=file_size,
        page_count=page_count,
        pdf_metadata=metadata,
    )


@router.post("/upload/local", response_model=FileUploadResponse)
def register_local_pdf(
    request: LocalFileUploadRequest,
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_license),
):
    """Register a desktop-local PDF without moving its bytes through WebView RAM."""
    if not (settings.IS_DESKTOP_APP or settings.DEV_MODE):
        raise HTTPException(status_code=403, detail="Chỉ khả dụng trong ứng dụng desktop")

    raw_path = Path(request.file_path)
    if not raw_path.is_absolute():
        raise HTTPException(status_code=400, detail="Đường dẫn file phải là tuyệt đối")
    try:
        source = raw_path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF trên máy")

    if not source.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF trên máy")
    if source.suffix.lower() != ".pdf":
        raise HTTPException(status_code=415, detail="Chỉ chấp nhận file PDF (.pdf)")
    try:
        file_size = source.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=400, detail="Không thể đọc file PDF đã chọn") from exc

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
        _remove_stored_file(stored_path)
        logger.exception("Could not register local PDF: %s", source)
        raise HTTPException(status_code=400, detail="Không thể đọc file PDF đã chọn") from exc

    try:
        metadata, page_count = _validate_pdf_and_extract_metadata(str(stored_path))
    except BaseException:
        _remove_stored_file(stored_path)
        raise

    response = _persist_uploaded_pdf(
        db=db,
        stored_name=stored_name,
        original_name=source.name,
        file_path=str(stored_path),
        file_size=file_size,
        metadata=metadata,
        page_count=page_count,
    )

    logger.info("Registered local PDF without multipart upload: %s", source)
    return response


@router.post("/upload", response_model=FileUploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_license),
):
    """Upload a PDF file for comparison."""
    original_name = file.filename or ""
    if Path(original_name).suffix.lower() != ".pdf":
        raise HTTPException(
            status_code=415,
            detail="Chỉ chấp nhận file PDF (.pdf). Hãy chuyển ảnh sang PDF trước khi tải lên.",
        )

    try:
        stored_name, file_path, file_size = await save_upload_file(file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Tải file lên thất bại: {exc}") from exc
    except Exception as exc:
        logger.exception("Không thể lưu file PDF tải lên: %s", original_name)
        raise HTTPException(
            status_code=500,
            detail="Không thể lưu file PDF tạm thời. Vui lòng thử lại.",
        ) from exc

    try:
        metadata, page_count = await run_in_threadpool(
            _validate_pdf_and_extract_metadata,
            file_path,
        )
    except BaseException:
        _remove_stored_file(file_path)
        raise

    response = _persist_uploaded_pdf(
        db=db,
        stored_name=stored_name,
        original_name=original_name,
        file_path=file_path,
        file_size=file_size,
        metadata=metadata,
        page_count=page_count,
    )

    logger.info("Uploaded: %s → %s", original_name, response.id)
    return response
