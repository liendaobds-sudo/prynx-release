"""
Celery application configuration.
"""
from celery import Celery
from app.config import settings

celery_app = Celery(
    "pdf_compare",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.workers.compare_task"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Asia/Ho_Chi_Minh",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=600,   # 10 min soft limit
    task_time_limit=900,        # 15 min hard limit
    result_expires=86400,       # 24 hours
)
