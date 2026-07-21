"""
Comparison job API endpoints.
Supports both Celery (production) and synchronous (DEV_MODE) processing.
"""
import logging
import os
import threading
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.job import ComparisonJob, UploadedFile
from app.schemas.job import CompareRequest, JobCreateResponse
from app.core.license_guard import require_license, require_feature

logger = logging.getLogger(__name__)
router = APIRouter()

# Giới hạn số job SO SÁNH chạy ĐỒNG THỜI ở chế độ thread (DEV/Desktop). Mỗi job đỉnh
# RAM ~0.5–0.7GB/trang; chạy nhiều job song song dễ tràn RAM. Job vượt giới hạn sẽ
# XẾP HÀNG (thread chờ semaphore) thay vì cùng ngốn RAM. Cấu hình qua biến môi trường.
_MAX_CONCURRENT_COMPARES = max(1, int(os.environ.get("PRYNX_MAX_COMPARE_JOBS", "2") or "2"))
_COMPARE_SEMAPHORE = threading.BoundedSemaphore(_MAX_CONCURRENT_COMPARES)


def run_comparison_sync(job_id: str):
    """Run comparison synchronously in a background thread (DEV_MODE).

    Giới hạn đồng thời bằng semaphore: job vượt mức sẽ chờ tới lượt (xếp hàng) để
    không bùng nổ RAM khi mở nhiều job so sánh cùng lúc.
    """
    from app.database import SessionLocal
    from app.core.comparison_engine import run_comparison_pipeline

    _COMPARE_SEMAPHORE.acquire()
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
        _COMPARE_SEMAPHORE.release()


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
    db.add(job)
    db.commit()
    db.refresh(job)

    if settings.DEV_MODE or settings.IS_DESKTOP_APP:
        # DEV_MODE or Desktop App: run in a real daemon thread (survives uvicorn reload better)
        t = threading.Thread(
            target=run_comparison_sync,
            args=(str(job.id),),
            daemon=True,
        )
        t.start()
    else:
        # Production: dispatch to Celery
        from app.workers.compare_task import run_comparison
        run_comparison.delay(str(job.id))

    logger.info(f"Created job: {job.id} (sync_mode={settings.DEV_MODE or settings.IS_DESKTOP_APP})")
    return JobCreateResponse(job_id=job.id)

