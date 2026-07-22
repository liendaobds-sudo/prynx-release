"""
Comparison job API endpoints.
Supports both Celery (production) and synchronous (DEV_MODE) processing.
"""
import logging
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.job import ComparisonJob, UploadedFile
from app.schemas.job import CompareRequest, JobCreateResponse
from app.core.license_guard import require_license, require_feature

logger = logging.getLogger(__name__)
router = APIRouter()

# Giới hạn job SO SÁNH ở DEV/Desktop. Fixed executor giữ số OS thread ổn định;
# submission slots chặn cả số job chạy và số job chờ để tránh tăng RAM vô hạn.
# Cấu hình qua PRYNX_MAX_COMPARE_JOBS và PRYNX_MAX_COMPARE_QUEUE.
_MAX_CONCURRENT_COMPARES = max(1, int(os.environ.get("PRYNX_MAX_COMPARE_JOBS", "1") or "1"))
_MAX_QUEUED_COMPARES = max(0, int(os.environ.get("PRYNX_MAX_COMPARE_QUEUE", "8") or "8"))
_COMPARE_EXECUTOR = ThreadPoolExecutor(
    max_workers=_MAX_CONCURRENT_COMPARES,
    thread_name_prefix="prynx-compare",
)
_COMPARE_SUBMISSION_SLOTS = threading.BoundedSemaphore(
    _MAX_CONCURRENT_COMPARES + _MAX_QUEUED_COMPARES
)

# Bound the largest rendered page, not just the PDF page count. A single A1/A0
# page at 300-600 DPI can exhaust memory even when the document has one page.
_MAX_COMPARE_PAGE_PIXELS = max(
    1,
    int(os.environ.get("PRYNX_MAX_COMPARE_PAGE_PIXELS", "40000000") or "40000000"),
)


def _estimate_max_render_pixels(uploaded_file, dpi: int) -> int | None:
    '''Estimate the largest page raster from upload metadata.'''
    metadata = getattr(uploaded_file, "pdf_metadata", None) or {}
    pages = metadata.get("pages") if isinstance(metadata, dict) else None
    if not isinstance(pages, list):
        return None

    largest = 0
    for page in pages:
        if not isinstance(page, dict):
            continue
        try:
            width_pt = float(page.get("width_pt") or 0)
            height_pt = float(page.get("height_pt") or 0)
        except (TypeError, ValueError):
            continue
        if width_pt <= 0 or height_pt <= 0:
            continue
        width_px = math.ceil(width_pt * dpi / 72.0)
        height_px = math.ceil(height_pt * dpi / 72.0)
        largest = max(largest, width_px * height_px)
    return largest or None


def run_comparison_sync(job_id: str):
    """Run comparison synchronously in a background thread (DEV_MODE).

    Executor có số worker cố định; job vượt mức sẽ chờ trong hàng đợi bounded để
    không bùng nổ RAM hoặc số thread khi mở nhiều job so sánh cùng lúc.
    """
    from app.database import SessionLocal
    from app.core.comparison_engine import run_comparison_pipeline

    db = SessionLocal()
    try:
        run_comparison_pipeline(job_id, db)
    except Exception as e:
        logger.exception(f"Job {job_id} failed: {e}")
        from app.models.job import ComparisonJob
        job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        if job:
            job.status = "failed"
            job.error_message = str(e)
            db.commit()
    finally:
        db.close()
        _COMPARE_SUBMISSION_SLOTS.release()


def _submit_reserved_comparison(job_id: str) -> None:
    """Submit after the caller has reserved one bounded queue slot."""
    _COMPARE_EXECUTOR.submit(run_comparison_sync, job_id)


def submit_comparison_local(job_id: str) -> bool:
    """Reserve a local Compare slot and submit, returning False when full."""
    if not _COMPARE_SUBMISSION_SLOTS.acquire(blocking=False):
        return False
    try:
        _submit_reserved_comparison(job_id)
    except Exception:
        _COMPARE_SUBMISSION_SLOTS.release()
        raise
    return True


@router.post("/jobs/compare", response_model=JobCreateResponse)
def create_comparison_job(
    request: CompareRequest,
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_feature("qc.compare_pdf")),
):
    """Create a new PDF comparison job."""
    # Validate files exist
    file_a = db.query(UploadedFile).filter(UploadedFile.id == str(request.file_a_id)).first()
    file_b = db.query(UploadedFile).filter(UploadedFile.id == str(request.file_b_id)).first()

    if not file_a:
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF gốc")
    if not file_b:
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF đã sửa")

    # Hard limit for memory protection (OOM prevention)
    MAX_PAGES = 50
    if (file_a.page_count and file_a.page_count > MAX_PAGES) or (file_b.page_count and file_b.page_count > MAX_PAGES):
        raise HTTPException(
            status_code=413, 
            detail=f"Quá giới hạn (>{MAX_PAGES} trang). Vui lòng nâng cấp phần cứng và chia nhỏ file PDF để tránh tràn RAM (OOM)."
        )

    max_render_pixels = max(
        _estimate_max_render_pixels(file_a, request.dpi) or 0,
        _estimate_max_render_pixels(file_b, request.dpi) or 0,
    )
    if max_render_pixels > _MAX_COMPARE_PAGE_PIXELS:
        safe_dpi = max(
            72,
            int(request.dpi * math.sqrt(_MAX_COMPARE_PAGE_PIXELS / max_render_pixels)),
        )
        megapixels = round(max_render_pixels / 1_000_000, 1)
        limit_megapixels = round(_MAX_COMPARE_PAGE_PIXELS / 1_000_000, 1)
        raise HTTPException(
            status_code=413,
            detail=(
                f"Trang l\u1edbn nh\u1ea5t s\u1ebd render {megapixels} MP, v\u01b0\u1ee3t gi\u1edbi h\u1ea1n an to\u00e0n "
                f"{limit_megapixels} MP. H\u00e3y ch\u1ecdn kho\u1ea3ng {safe_dpi} DPI ho\u1eb7c th\u1ea5p h\u01a1n."
            ),
        )

    # Create job
    job = ComparisonJob(
        job_type="version_compare",
        file_a_id=str(request.file_a_id),
        file_b_id=str(request.file_b_id),
        config={
            "comparison_mode": request.comparison_mode,
            "page_matching_mode": request.page_matching_mode,
            "tolerance": request.tolerance,
            "dpi": request.dpi,
            "highlight_color": request.highlight_color,
            "is_packaging_mode": request.is_packaging_mode,
        },
    )
    local_mode = settings.DEV_MODE or settings.IS_DESKTOP_APP
    if local_mode and not _COMPARE_SUBMISSION_SLOTS.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="Hàng đợi Compare đang đầy. Vui lòng chờ job hiện tại hoàn tất.",
        )

    try:
        db.add(job)
        db.commit()
        db.refresh(job)

        if local_mode:
            # Fixed workers: queued jobs no longer allocate one waiting OS thread each.
            _submit_reserved_comparison(str(job.id))
        else:
            # Production continues to use Celery.
            from app.workers.compare_task import run_comparison
            run_comparison.delay(str(job.id))
    except Exception:
        if local_mode:
            _COMPARE_SUBMISSION_SLOTS.release()
        raise
    logger.info(f"Created job: {job.id} (sync_mode={local_mode})")
    return JobCreateResponse(job_id=job.id)

