"""
WebSocket endpoint for real-time job progress updates.
Supports Redis pub/sub (production) and DB polling (DEV_MODE).
"""
import json
import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/jobs/{job_id}/progress")
async def job_progress_ws(
    websocket: WebSocket,
    job_id: str,
    token: str = Query(default=""),
    ts: str = Query(default=""),
    sig: str = Query(default=""),
):
    """
    WebSocket endpoint for real-time progress updates.

    SECURITY: xác thực bằng sidecar token + chữ ký HMAC (giống require_license),
    nhận qua query param (?token=&ts=&sig=) vì WebSocket trình duyệt không gửi được
    custom header. Bỏ qua ở dev mode. Chữ ký ký trên path "/ws/jobs/{job_id}/progress".
    """
    from app.core.license_guard import verify_sidecar_signature
    url_path = f"/ws/jobs/{job_id}/progress"
    ok, _reason = verify_sidecar_signature(url_path, token, ts, sig)
    if not ok:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info(f"WebSocket connected for job: {job_id}")

    try:
        if settings.DEV_MODE:
            await _poll_db_progress(websocket, job_id)
        else:
            await _subscribe_redis_progress(websocket, job_id)
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for job: {job_id}")
    except Exception as e:
        logger.error(f"WebSocket error for job {job_id}: {e}")


async def _poll_db_progress(websocket: WebSocket, job_id: str):
    """Poll database for job progress (DEV_MODE — no Redis needed)."""
    from app.database import SessionLocal
    from app.models.job import ComparisonJob

    while True:
        db = SessionLocal()
        try:
            job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
            if not job:
                await websocket.send_json({"error": "Job not found"})
                break

            data = {
                "job_id": job_id,
                "status": job.status,
                "progress": job.progress or 0,
                "current_page": job.current_page,
                "total_pages": job.total_pages,
                "message": f"Trang {job.current_page or 0}/{job.total_pages or '?'}" if job.status == "processing" else "",
            }
            await websocket.send_json(data)

            if job.status in ("completed", "failed"):
                await asyncio.sleep(0.3)
                break
        finally:
            db.close()

        await asyncio.sleep(1.5)


async def _subscribe_redis_progress(websocket: WebSocket, job_id: str):
    """Subscribe to Redis pub/sub for job progress (production mode)."""
    import redis.asyncio as aioredis

    r = aioredis.from_url(settings.REDIS_URL)
    pubsub = r.pubsub()
    channel = f"job:{job_id}"

    try:
        await pubsub.subscribe(channel)

        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=1.0
            )
            if message and message["type"] == "message":
                data = json.loads(message["data"])
                await websocket.send_json(data)

                if data.get("status") in ("completed", "failed"):
                    await asyncio.sleep(0.5)
                    break

            try:
                await asyncio.wait_for(
                    websocket.receive_text(), timeout=0.1
                )
            except asyncio.TimeoutError:
                pass
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.close()
        await r.close()
