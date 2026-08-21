"""API cục bộ cho công cụ Free: Nắn thẻ – Làm trắng scan."""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from dataclasses import asdict, dataclass
from io import BytesIO
from typing import Literal
from urllib.parse import quote

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image

from app.core.license_guard import require_feature
from app.workers.document_cleanup_engine import (
    ID1_HEIGHT_MM,
    ID1_RATIO,
    ID1_WIDTH_MM,
    CardDetection,
    DocumentCleanupCancelled,
    clean_scan,
    clean_scan_pdf,
    detect_card_quad,
    load_image_bytes,
    normalized_points,
    rectify_card,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/document-cleanup")

_MAX_INPUT_BYTES = 100 * 1024 * 1024
_MAX_PIXELS = 100_000_000
_CLEANUP_JOB_TTL_SECONDS = 15 * 60
_CLEANUP_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


@dataclass
class _CleanupJobStatus:
    job_id: str
    current: int = 0
    total: int = 0
    phase: str = "queued"
    terminal: bool = False
    cancelled: bool = False
    updated_at: float = 0.0


_cleanup_jobs: dict[str, _CleanupJobStatus] = {}
_cleanup_jobs_lock = threading.Lock()


def _prune_cleanup_jobs(now: float) -> None:
    stale = [
        job_id
        for job_id, status in _cleanup_jobs.items()
        if now - status.updated_at > _CLEANUP_JOB_TTL_SECONDS
    ]
    for job_id in stale:
        _cleanup_jobs.pop(job_id, None)


def _create_cleanup_job(job_id: str) -> None:
    if not _CLEANUP_JOB_ID.fullmatch(job_id):
        raise HTTPException(status_code=422, detail="Mã tiến độ làm trắng PDF không hợp lệ")
    now = time.monotonic()
    with _cleanup_jobs_lock:
        _prune_cleanup_jobs(now)
        existing = _cleanup_jobs.get(job_id)
        if existing is not None and not existing.terminal:
            raise HTTPException(status_code=409, detail="Lượt làm trắng PDF này đang chạy")
        _cleanup_jobs[job_id] = _CleanupJobStatus(job_id=job_id, updated_at=now)


def _update_cleanup_job(job_id: str | None, **changes: object) -> None:
    if not job_id:
        return
    with _cleanup_jobs_lock:
        status = _cleanup_jobs.get(job_id)
        if status is None:
            return
        for key, value in changes.items():
            setattr(status, key, value)
        status.updated_at = time.monotonic()


def _cleanup_job_cancelled(job_id: str | None) -> bool:
    if not job_id:
        return False
    with _cleanup_jobs_lock:
        status = _cleanup_jobs.get(job_id)
        return bool(status and status.cancelled)


def _cleanup_job_payload(job_id: str) -> dict[str, object]:
    with _cleanup_jobs_lock:
        _prune_cleanup_jobs(time.monotonic())
        status = _cleanup_jobs.get(job_id)
        if status is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tiến độ làm trắng PDF")
        payload = asdict(status)
    payload.pop("updated_at", None)
    total = int(payload["total"])
    current = int(payload["current"])
    payload["progress"] = round(current / total, 4) if total > 0 else 0.0
    return payload


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read(_MAX_INPUT_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="File ảnh rỗng")
    if len(data) > _MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail="Ảnh vượt quá 100 MB")
    return data


def _decode_image(data: bytes) -> Image.Image:
    try:
        image = load_image_bytes(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Không đọc được định dạng ảnh") from exc
    if image.width * image.height > _MAX_PIXELS:
        raise HTTPException(
            status_code=422,
            detail="Ảnh quá lớn để xử lý an toàn; hãy giảm xuống dưới 100 megapixel.",
        )
    return image


def _detect_with_optional_ai(image: Image.Image, use_ai: bool) -> CardDetection | None:
    detection = detect_card_quad(image)
    if not use_ai or (detection is not None and detection.confidence >= 0.82):
        return detection
    try:
        # DOC-CLEANUP (audit 2026-08-20 §DOC.02): dùng mask của engine Tách nền
        # để khoanh vùng, nhưng bốn góc cuối vẫn fit từ contour/cạnh hình học.
        from app.workers.isnet_engine import predict_alpha

        mask = np.asarray(predict_alpha(image.convert("RGB")))
        ai_detection = detect_card_quad(image, foreground_mask=mask)
        if ai_detection is not None and (
            detection is None or ai_detection.confidence > detection.confidence
        ):
            return ai_detection
    except Exception:
        # Model không sẵn sàng không được làm mất fallback OpenCV hoặc lộ path model.
        logger.warning("Không dùng được AI mask khi dò thẻ; giữ kết quả OpenCV", exc_info=True)
    return detection


def _parse_points(raw: str | None, image: Image.Image) -> list[list[float]] | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list) or len(parsed) != 4:
            raise ValueError
        result: list[list[float]] = []
        for point in parsed:
            if not isinstance(point, dict):
                raise ValueError
            x = float(point["x"])
            y = float(point["y"])
            if not np.isfinite(x) or not np.isfinite(y) or not (0 <= x <= 1 and 0 <= y <= 1):
                raise ValueError
            result.append([x * (image.width - 1), y * (image.height - 1)])
        return result
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail="Bốn góc thẻ không hợp lệ") from exc


def _png_response(
    image: Image.Image,
    filename: str,
    *,
    dpi: tuple[float, float] | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    output = BytesIO()
    kwargs: dict[str, object] = {"compress_level": 3}
    if dpi:
        kwargs["dpi"] = dpi
    image.save(output, format="PNG", **kwargs)
    response_headers = {
        "Content-Disposition": _content_disposition(filename),
        **(headers or {}),
    }
    return Response(output.getvalue(), media_type="image/png", headers=response_headers)


def _content_disposition(filename: str) -> str:
    """Tên Unicode theo RFC 5987, kèm fallback ASCII cho WebView cũ."""

    normalized = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode("ascii")
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", normalized).strip("._") or "ket_qua"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.post(
    "/detect-card",
    dependencies=[Depends(require_feature("util.document_cleanup"))],
)
async def detect_card(
    file: UploadFile = File(...),
    use_ai: bool = Form(True),
):
    """Dò bốn góc theo tọa độ chuẩn hóa để frontend cho phép chỉnh tay."""

    from app.core.heavy_job_scheduler import run_heavy_in_threadpool

    data = await _read_upload(file)
    image = _decode_image(data)
    detection = await run_heavy_in_threadpool(_detect_with_optional_ai, image, use_ai)
    if detection is None:
        raise HTTPException(
            status_code=422,
            detail="Không tìm thấy đủ bốn cạnh thẻ. Hãy đặt bốn góc thủ công.",
        )
    return {
        "width": image.width,
        "height": image.height,
        "points": normalized_points(detection, image.width, image.height),
        "confidence": round(detection.confidence, 4),
        "method": detection.method,
        "needs_review": detection.confidence < 0.82,
    }


@router.post(
    "/process",
    dependencies=[Depends(require_feature("util.document_cleanup"))],
)
async def process_document(
    file: UploadFile = File(...),
    operation: Literal["card", "scan"] = Form(...),
    points_json: str | None = Form(None),
    card_ratio: Literal["id1", "auto", "custom"] = Form("id1"),
    custom_width_mm: float | None = Form(None),
    custom_height_mm: float | None = Form(None),
    output_dpi: int = Form(300),
    scan_mode: Literal["color", "gray", "bw"] = Form("color"),
    strength: float = Form(0.55),
    remove_shadows: bool = Form(True),
    deskew: bool = Form(True),
    use_ai: bool = Form(True),
    job_id: str | None = Form(None),
):
    """Nắn thẻ hoặc làm trắng một ảnh; xử lý hoàn toàn trong sidecar cục bộ."""

    from app.core.heavy_job_scheduler import run_heavy_in_threadpool

    if not 72 <= output_dpi <= 1200:
        raise HTTPException(status_code=422, detail="DPI đầu ra phải nằm trong khoảng 72–1200")
    data = await _read_upload(file)
    is_pdf = data.startswith(b"%PDF-") or (file.content_type or "").lower() == "application/pdf"
    if is_pdf:
        if operation != "scan":
            raise HTTPException(status_code=422, detail="PDF chỉ hỗ trợ chế độ Làm trắng scan")
        if job_id:
            _create_cleanup_job(job_id)

        def report_progress(current: int, total: int, phase: str) -> None:
            _update_cleanup_job(job_id, current=current, total=total, phase=phase)

        try:
            result_pdf = await run_heavy_in_threadpool(
                clean_scan_pdf,
                data,
                mode=scan_mode,
                strength=strength,
                remove_shadows=remove_shadows,
                deskew=deskew,
                dpi=output_dpi,
                progress_callback=report_progress,
                cancel_check=lambda: _cleanup_job_cancelled(job_id),
            )
        except DocumentCleanupCancelled as exc:
            _update_cleanup_job(job_id, phase="cancelled", terminal=True, cancelled=True)
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            _update_cleanup_job(job_id, phase="failed", terminal=True)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            _update_cleanup_job(job_id, phase="failed", terminal=True)
            logger.warning("Không đọc hoặc làm sạch được PDF scan", exc_info=True)
            raise HTTPException(status_code=400, detail="Không đọc được PDF scan") from exc
        _update_cleanup_job(job_id, phase="complete", terminal=True)
        stem = (file.filename or "scan").rsplit(".", 1)[0]
        return Response(
            result_pdf,
            media_type="application/pdf",
            headers={
                "Content-Disposition": _content_disposition(f"scan_sach_{stem}.pdf"),
                "X-Document-Cleanup-Operation": "scan",
            },
        )

    image = _decode_image(data)

    if operation == "scan":
        result = await run_heavy_in_threadpool(
            clean_scan,
            image,
            mode=scan_mode,
            strength=strength,
            remove_shadows=remove_shadows,
            deskew=deskew,
        )
        stem = (file.filename or "scan").rsplit(".", 1)[0]
        return _png_response(
            result,
            f"scan_sach_{stem}.png",
            dpi=(float(output_dpi), float(output_dpi)),
            headers={"X-Document-Cleanup-Operation": "scan"},
        )

    points = _parse_points(points_json, image)
    detection: CardDetection | None = None
    if points is None:
        detection = await run_heavy_in_threadpool(_detect_with_optional_ai, image, use_ai)
        if detection is None:
            raise HTTPException(
                status_code=422,
                detail="Không tìm thấy đủ bốn cạnh thẻ. Hãy đặt bốn góc thủ công.",
            )
        points = [list(point) for point in detection.points]

    width_mm: float | None = None
    height_mm: float | None = None
    target_ratio: float | None
    if card_ratio == "id1":
        width_mm, height_mm = ID1_WIDTH_MM, ID1_HEIGHT_MM
        target_ratio = ID1_RATIO
    elif card_ratio == "custom":
        if (
            custom_width_mm is None
            or custom_height_mm is None
            or not 10 <= custom_width_mm <= 1000
            or not 10 <= custom_height_mm <= 1000
        ):
            raise HTTPException(status_code=422, detail="Kích thước thẻ tùy chỉnh không hợp lệ")
        width_mm, height_mm = custom_width_mm, custom_height_mm
        target_ratio = max(width_mm, height_mm) / min(width_mm, height_mm)
    else:
        target_ratio = None

    result = await run_heavy_in_threadpool(
        rectify_card,
        image,
        points,
        target_ratio=target_ratio,
    )
    if width_mm is not None and height_mm is not None:
        landscape = result.width >= result.height
        physical_w, physical_h = (
            (max(width_mm, height_mm), min(width_mm, height_mm))
            if landscape
            else (min(width_mm, height_mm), max(width_mm, height_mm))
        )
        pixel_size = (
            max(2, round(physical_w * output_dpi / 25.4)),
            max(2, round(physical_h * output_dpi / 25.4)),
        )
        result = result.resize(pixel_size, Image.Resampling.LANCZOS)
    stem = (file.filename or "the").rsplit(".", 1)[0]
    return _png_response(
        result,
        f"nan_thang_{stem}.png",
        dpi=(float(output_dpi), float(output_dpi)),
        headers={
            "X-Document-Cleanup-Operation": "card",
            "X-Card-Confidence": str(round(detection.confidence, 4)) if detection else "manual",
            "X-Card-Width-MM": str(width_mm or ""),
            "X-Card-Height-MM": str(height_mm or ""),
        },
    )


@router.get(
    "/jobs/{job_id}",
    dependencies=[Depends(require_feature("util.document_cleanup"))],
)
async def get_cleanup_job(job_id: str):
    """Trả tiến độ từng trang của một lượt làm trắng PDF đang chạy."""

    return _cleanup_job_payload(job_id)


@router.post(
    "/jobs/{job_id}/cancel",
    dependencies=[Depends(require_feature("util.document_cleanup"))],
)
async def cancel_cleanup_job(job_id: str):
    """Đánh dấu hủy; engine dừng an toàn trước khi bắt đầu trang kế tiếp."""

    with _cleanup_jobs_lock:
        status = _cleanup_jobs.get(job_id)
        if status is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy tiến trình làm trắng PDF")
        if not status.terminal:
            status.cancelled = True
            status.phase = "cancelling"
        status.updated_at = time.monotonic()
    return {"success": True, "job_id": job_id}
