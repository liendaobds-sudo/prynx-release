"""API mỏng cho chế độ Ảnh AI nhiều tem của Bù xén - Tạo đường cắt."""

from __future__ import annotations

import logging
import os
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from app.core.heavy_job_scheduler import run_heavy_in_threadpool
from app.core.license_guard import require_feature, require_license
from app.core.sticker_sheet_session import (
    close_session,
    create_session,
    get_asset,
    get_session,
)
from app.schemas.sticker_sheet import (
    StickerSheetAnalyzeResponse,
    StickerSheetCloseResponse,
    StickerSheetExportRequest,
    StickerSheetModel,
    StickerSheetWarmupResponse,
)
from app.utils.file_handler import save_upload_file
from app.workers.sticker_sheet_engine import StickerSheetError, analyze_sticker_sheet
from app.workers.sticker_sheet_export import StickerSheetExportError, export_sticker_sheet


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/sticker-sheet",
    tags=["Sticker Sheet"],
    dependencies=[Depends(require_license)],
)

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _validate_model(raw: str) -> StickerSheetModel:
    model = (raw or "birefnet-lite").strip().lower()
    if model not in ("birefnet-lite", "birefnet-full", "isnet"):
        raise HTTPException(status_code=422, detail="Mô hình tách tem không được hỗ trợ.")
    return model  # type: ignore[return-value]


def _validate_local_image_path(file_path: str) -> str:
    candidate = Path(file_path).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="Đường dẫn ảnh phải là đường dẫn tuyệt đối.")
    if candidate.is_symlink():
        raise HTTPException(status_code=400, detail="Không chấp nhận đường dẫn liên kết.")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh nguồn.") from exc
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh nguồn.")
    if resolved.suffix.lower() not in _IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Chỉ nhận ảnh JPG, PNG, WebP, BMP hoặc TIFF.")
    return str(resolved)


def _load_print_image(source_path: str) -> tuple[Image.Image, tuple[float, float] | None, list[str]]:
    warnings: list[str] = []
    with Image.open(source_path) as opened:
        dpi_raw = opened.info.get("dpi")
        dpi = None
        if (
            isinstance(dpi_raw, (tuple, list))
            and len(dpi_raw) >= 2
            and float(dpi_raw[0]) > 0
            and float(dpi_raw[1]) > 0
        ):
            dpi = (float(dpi_raw[0]), float(dpi_raw[1]))
        source_icc = opened.info.get("icc_profile")
        opened.load()
        work = ImageOps.exif_transpose(opened)

    if source_icc:
        try:
            source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc))
            srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
            work = ImageCms.profileToProfile(
                work.convert("RGB"),
                source_profile,
                srgb_profile,
                outputMode="RGB",
            )
            warnings.append("color-converted-to-srgb")
        except Exception:
            logger.warning("Không chuyển được ICC ảnh tách tem; dùng RGB mặc định", exc_info=True)
            work = work.convert("RGB")
            warnings.append("icc-profile-discarded")
    else:
        work = work.convert("RGB")
    return work, dpi, warnings


@router.post(
    "/analyze",
    response_model=StickerSheetAnalyzeResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def analyze_sticker_sheet_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    model: str = Form("birefnet-lite"),
    alpha_threshold: int = Form(128),
):
    selected_model = _validate_model(model)
    owned_upload = False
    source_path = ""
    original_name = "image"
    if file is not None:
        original_name = file.filename or "image.png"
        if Path(original_name).suffix.lower() not in _IMAGE_EXTENSIONS:
            raise HTTPException(status_code=415, detail="Chỉ nhận ảnh JPG, PNG, WebP, BMP hoặc TIFF.")
        try:
            _stored_name, source_path, _size = await save_upload_file(file)
        except ValueError as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        owned_upload = True
    elif file_path:
        source_path = _validate_local_image_path(file_path)
        original_name = Path(source_path).name
    else:
        raise HTTPException(status_code=400, detail="Hãy chọn một ảnh chứa các tem cần tách.")

    def _analyze():
        image, dpi, load_warnings = _load_print_image(source_path)
        result = analyze_sticker_sheet(
            image,
            model=selected_model,
            alpha_threshold=alpha_threshold,
        )
        result.warnings[:0] = load_warnings
        return create_session(
            source_path=source_path,
            original_name=original_name,
            original_size=image.size,
            analysis=result,
            dpi=dpi,
        )

    try:
        session = await run_heavy_in_threadpool(_analyze)
        manifest = session.manifest
        base = f"/api/sticker-sheet/{session.session_id}/assets"
        return {
            **manifest,
            "preview_url": f"{base}/preview",
            "labels_url": f"{base}/labels",
            "uncertainty_url": f"{base}/uncertainty",
        }
    except StickerSheetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Không đọc được ảnh tách tem", exc_info=True)
        raise HTTPException(
            status_code=415,
            detail="Không đọc được ảnh. Hãy xuất lại thành JPG hoặc PNG rồi thử lại.",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Phân tích ảnh nhiều tem thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Tách tem thất bại ({type(exc).__name__}).",
        ) from exc
    finally:
        if owned_upload and source_path:
            try:
                os.remove(source_path)
            except OSError:
                pass


@router.post(
    "/warmup",
    response_model=StickerSheetWarmupResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def warmup_sticker_sheet_model(model: str = Form("birefnet-lite")):
    selected_model = _validate_model(model)
    if selected_model == "isnet":
        from app.workers.isnet_engine import warmup

        ok = await run_heavy_in_threadpool(warmup)
    else:
        from app.workers.birefnet_engine import warmup

        variant = "full" if selected_model == "birefnet-full" else "lite"
        ok = await run_heavy_in_threadpool(warmup, variant)
    return {"ok": bool(ok), "model": selected_model}


@router.get(
    "/{session_id}/assets/{asset}",
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def serve_sticker_sheet_asset(session_id: str, asset: str):
    path = get_asset(session_id, asset)
    if path is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy dữ liệu tách tem.")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.delete(
    "/{session_id}",
    response_model=StickerSheetCloseResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def close_sticker_sheet_session(session_id: str):
    return {"closed": close_session(session_id)}


@router.post(
    "/{session_id}/export",
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def export_sticker_sheet_endpoint(
    session_id: str,
    request: StickerSheetExportRequest,
):
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Phiên tách tem đã hết hạn. Hãy phân tích lại ảnh.")
    try:
        result = await run_heavy_in_threadpool(
            export_sticker_sheet,
            session,
            edits=[edit.model_dump() for edit in request.edits],
            dpi=request.dpi,
            dpi_y=request.dpi_y,
            offset_mm=request.offset_mm,
            bleed_mm=request.bleed_mm,
            output_format=request.output_format,
        )
    except StickerSheetExportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Xuất tem đã tách thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Không tạo được file tem ({type(exc).__name__}).",
        ) from exc
    return FileResponse(
        result.path,
        filename=result.filename,
        media_type=result.media_type,
        headers={
            "X-Sticker-Sheet-Count": str(result.sticker_count),
            "X-Sticker-Output-Path": str(result.path.resolve()),
        },
    )
