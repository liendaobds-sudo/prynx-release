"""API tiền kiểm, preview và hủy job Phục hồi & Vector hóa Logo."""

from __future__ import annotations

import warnings
from io import BytesIO
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.heavy_job_scheduler import run_scheduled_in_threadpool
from app.core.license_guard import require_feature
from app.schemas.logo_rebuild import (
    LogoRebuildCancelResponse,
    LogoRebuildCapabilitiesResponse,
    LogoRebuildPreflightResponse,
    LogoRebuildPreviewResponse,
    LogoRebuildSettings,
    LogoSourceInfo,
)
from app.workers.logo_rebuild import (
    LogoEngineUnavailable,
    LogoInputError,
    LogoJobCancelled,
    LogoJobConflict,
    cancel_logo_job,
    logo_vectorizer_capabilities,
    process_logo_preview,
    reserve_logo_job,
)


router = APIRouter(dependencies=[Depends(require_feature("util.logo_rebuild"))])

_ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
_ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}
_BASE_LIMITATIONS = [
    "Chưa tự phục hồi phần logo bị che hoặc mất nét.",
    "Logo màu chỉ chạy khi người dùng xác nhận palette.",
]
_ENGINE_UNAVAILABLE_LIMITATION = (
    "Bản native hiện tại chưa có engine preview; cần build lại pdfcompare_native."
)


def _limitations(engine_enabled: bool) -> list[str]:
    result = list(_BASE_LIMITATIONS)
    if not engine_enabled:
        result.append(_ENGINE_UNAVAILABLE_LIMITATION)
    return result


def _read_dpi(raw: object) -> tuple[float, float] | None:
    if not isinstance(raw, tuple) or len(raw) < 2:
        return None
    try:
        x_dpi, y_dpi = float(raw[0]), float(raw[1])
    except (TypeError, ValueError):
        return None
    if x_dpi <= 0 or y_dpi <= 0:
        return None
    return round(x_dpi, 3), round(y_dpi, 3)


def _inspect_image(stream: BinaryIO, file_size: int) -> LogoSourceInfo:
    """Đọc metadata ảnh trong threadpool, không ghi ảnh khách hàng ra đĩa."""

    # LOGO-REBUILD (audit 2026-07-29 §VL.MVP-A): biến cảnh báo bomb thành lỗi
    # có thể xử lý, tránh tiếp tục với ảnh giải nén vượt ngưỡng an toàn của Pillow.
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        stream.seek(0)
        with Image.open(stream) as probe:
            probe.verify()

        stream.seek(0)
        with Image.open(stream) as image:
            image_format = (image.format or "").upper()
            if image_format not in _ALLOWED_FORMATS:
                raise ValueError("Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP")
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError("Không hỗ trợ ảnh động; hãy xuất một khung ảnh tĩnh")

            width, height = image.size
            orientation = image.getexif().get(274, 1)
            if orientation in (5, 6, 7, 8):
                width, height = height, width

            return LogoSourceInfo(
                width_px=width,
                height_px=height,
                mode=image.mode,
                format=image_format,
                file_size_bytes=file_size,
                has_alpha=image.mode in ("RGBA", "LA") or "transparency" in image.info,
                has_icc_profile=bool(image.info.get("icc_profile")),
                dpi=_read_dpi(image.info.get("dpi")),
            )


def _preflight_warnings(source: LogoSourceInfo) -> list[str]:
    result: list[str] = []
    if min(source.width_px, source.height_px) < 512:
        result.append("Độ phân giải vùng logo thấp; nét nhỏ có thể cần dựng lại thủ công.")
    if not source.has_icc_profile:
        result.append("Ảnh không có ICC profile; màu in cần được người dùng xác nhận.")
    if source.mode == "CMYK":
        result.append("Ảnh CMYK sẽ được chuyển về sRGB ở bước tiền xử lý.")
    return result


def _parse_settings(settings_json: str) -> LogoRebuildSettings:
    try:
        return LogoRebuildSettings.model_validate_json(settings_json)
    except ValidationError as exc:
        first_error = exc.errors(include_url=False)[0].get("msg", "cấu hình không hợp lệ")
        raise HTTPException(
            status_code=422,
            detail=f"Cấu hình logo không hợp lệ: {first_error}",
        ) from exc


async def _read_and_inspect_upload(file: UploadFile) -> tuple[bytes, LogoSourceInfo]:
    filename = file.filename or ""
    if Path(filename).suffix.lower() not in _ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP.")

    max_size = settings.MAX_FILE_SIZE_MB * 1024 * 1024
    payload = await file.read(max_size + 1)
    if not payload:
        raise HTTPException(status_code=400, detail="Ảnh rỗng; hãy chọn lại file.")
    if len(payload) > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"File quá lớn. Kích thước tối đa: {settings.MAX_FILE_SIZE_MB} MB.",
        )

    try:
        source = await run_in_threadpool(_inspect_image, BytesIO(payload), len(payload))
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise HTTPException(
            status_code=413,
            detail="Ảnh có quá nhiều pixel để xử lý an toàn.",
        ) from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc) or "File ảnh không hợp lệ.") from exc
    return payload, source


@router.get(
    "/logo-rebuild/capabilities",
    response_model=LogoRebuildCapabilitiesResponse,
)
def logo_rebuild_capabilities() -> LogoRebuildCapabilitiesResponse:
    engine = logo_vectorizer_capabilities()
    return LogoRebuildCapabilitiesResponse(
        modes=["monochrome", "fixed_palette"],
        supported_formats=["png", "jpeg", "webp"],
        preview_engine_enabled=engine is not None,
        engine=engine,
        limitations=_limitations(engine is not None),
    )


@router.post(
    "/logo-rebuild/preflight",
    response_model=LogoRebuildPreflightResponse,
)
async def logo_rebuild_preflight(
    file: UploadFile = File(...),
    settings_json: str = Form(...),
) -> LogoRebuildPreflightResponse:
    logo_settings = _parse_settings(settings_json)
    _payload, source = await _read_and_inspect_upload(file)
    engine_enabled = logo_vectorizer_capabilities() is not None
    return LogoRebuildPreflightResponse(
        source=source,
        settings=logo_settings,
        warnings=_preflight_warnings(source),
        limitations=_limitations(engine_enabled),
    )


@router.post(
    "/logo-rebuild/preview",
    response_model=LogoRebuildPreviewResponse,
)
async def logo_rebuild_preview(
    file: UploadFile = File(...),
    settings_json: str = Form(...),
    job_id: UUID = Form(...),
) -> LogoRebuildPreviewResponse:
    logo_settings = _parse_settings(settings_json)
    payload, source = await _read_and_inspect_upload(file)
    try:
        token = reserve_logo_job(str(job_id))
        result = await run_scheduled_in_threadpool(
            "logo-rebuild",
            process_logo_preview,
            payload,
            logo_settings,
            str(job_id),
            token,
        )
    except LogoEngineUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LogoJobConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LogoJobCancelled as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LogoInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"Không thể tạo SVG preview: {exc}") from exc

    warnings_result = list(dict.fromkeys([*_preflight_warnings(source), *result.warnings]))
    return LogoRebuildPreviewResponse(
        job_id=job_id,
        svg=result.svg,
        width_px=result.width_px,
        height_px=result.height_px,
        warnings=warnings_result,
        engine=result.engine,
        engine_version=result.engine_version,
    )


@router.delete(
    "/logo-rebuild/jobs/{job_id}",
    response_model=LogoRebuildCancelResponse,
)
def cancel_logo_rebuild_job(job_id: UUID) -> LogoRebuildCancelResponse:
    cancelled = cancel_logo_job(str(job_id))
    return LogoRebuildCancelResponse(
        job_id=job_id,
        cancelled=cancelled,
        status="cancelled" if cancelled else "not_found",
    )
