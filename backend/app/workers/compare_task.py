"""
Celery task for PDF comparison (Production mode).
Uses the shared comparison_engine pipeline with Redis pub/sub notifications.

Flow reference: compare-pdf (ThreadPoolExecutor parallel pages)
"""
import json
import logging

import redis

from app.workers.celery_app import celery_app
from app.config import settings
from app.database import SessionLocal
from app.core.comparison_engine import run_comparison_pipeline

logger = logging.getLogger(__name__)

# Redis for WebSocket pub/sub
redis_client = redis.Redis.from_url(settings.REDIS_URL)


def publish_progress(job_id: str, progress: int, status: str = "processing",
                     current_page: int = 0, total_pages: int = 0, message: str = ""):
    """Publish progress update via Redis pub/sub for WebSocket."""
    data = {
        "job_id": str(job_id),
        "status": status,
        "progress": progress,
        "current_page": current_page,
        "total_pages": total_pages,
        "message": message,
    }
    redis_client.publish(f"job:{job_id}", json.dumps(data))


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def run_comparison(self, job_id: str):
    """
    Main Celery comparison task.
    Delegates to the shared comparison_engine with Redis pub/sub notifications.
    """
    db = SessionLocal()

    try:
        run_comparison_pipeline(
            job_id,
            db,
            on_progress=publish_progress,
            raise_on_cancel=True,
        )
    except InterruptedError:
        # Hủy là trạng thái kết thúc hợp lệ, không retry Celery như lỗi tạm thời.
        logger.info("Job %s đã hủy", job_id)
    except Exception as e:
        logger.exception(f"Job {job_id} failed: {e}")
        from app.models.job import ComparisonJob
        db.expire_all()
        job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        if job and job.status == "cancelled":
            publish_progress(
                job_id,
                job.progress or 0,
                status="cancelled",
                message="Đã hủy so sánh theo yêu cầu của người dùng.",
            )
            return
        if job:
            job.status = "failed"
            job.error_message = str(e)
            db.commit()

        publish_progress(job_id, 0, status="failed", message=f"Lỗi: {str(e)}")

        # Retry if transient error
        if self.request.retries < self.max_retries:
            raise self.retry(exc=e)

    finally:
        db.close()
