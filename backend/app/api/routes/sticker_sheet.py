"""API mỏng cho chế độ Ảnh AI nhiều tem của Bù xén - Tạo đường cắt."""

from __future__ import annotations

import asyncio
import logging
import os
from io import BytesIO
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from app.core.heavy_job_scheduler import run_heavy_in_threadpool
from app.core.license_guard import require_feature, require_license
from app.core.sticker_sheet_session import (
    StickerSheetSessionConflict,
    abort_source_detection,
    begin_source_detection,
    close_session,
    confirm_source_session,
    create_session,
    create_source_session,
    get_asset,
    get_page_state,
    get_session,
    promote_source_session,
    read_versioned_asset,
    refine_source_session,
)
from app.schemas.sticker_sheet import (
    StickerCutlinePreviewRequest,
    StickerCutlinePreviewResponse,
    StickerSourceConfirmResponse,
    StickerSourceConfirmRequest,
    StickerSourceDetectRequest,
    StickerSourceDetectResponse,
    StickerSourceInspectResponse,
    StickerSourceRefineRequest,
    StickerSheetAnalyzeResponse,
    StickerSheetCloseResponse,
    StickerSheetExportRequest,
    StickerSheetModel,
    StickerSheetWarmupResponse,
)
from app.utils.file_handler import save_upload_file
from app.workers.sticker_sheet_engine import StickerSheetError, analyze_sticker_sheet
from app.workers.sticker_sheet_export import (
    StickerCanonicalPreviewConflict,
    StickerSheetExportError,
    export_sticker_sheet,
    export_sticker_sheet_document,
)
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.sticker_source_inspector import (
    StickerSourceInspectionError,
    inspect_sticker_source,
)
from app.workers.sticker_source_pipeline import (
    StickerSourcePipelineError,
    detect_sticker_source,
)
from starlette.concurrency import run_in_threadpool


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/sticker-sheet",
    tags=["Sticker Sheet"],
    dependencies=[Depends(require_license)],
)

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
_SOURCE_EXTENSIONS = _IMAGE_EXTENSIONS | {".pdf"}


def _validate_model(raw: str) -> StickerSheetModel:
    model = (raw or "birefnet-lite").strip().lower()
    if model not in ("birefnet-lite", "birefnet-full", "isnet"):
        raise HTTPException(status_code=422, detail="Mô hình tách tem không được hỗ trợ.")
    return model  # type: ignore[return-value]


def _page_detection_response(session_id: str, page_number: int) -> dict[str, object] | None:
    page = get_page_state(session_id, page_number)
    if page is None or page.stage != "mask-review":
        return None
    revision = int(page.manifest.get("mask_revision", 1))
    base = f"/api/sticker-sheet/{session_id}/assets"
    asset_query = f"v={revision}&page={page_number}"
    return {
        **page.manifest,
        "preview_url": f"{base}/preview?{asset_query}",
        "labels_url": f"{base}/labels?{asset_query}",
        "uncertainty_url": f"{base}/uncertainty?{asset_query}",
    }


def _validate_local_source_path(
    file_path: str,
    *,
    allowed_extensions: set[str] = _SOURCE_EXTENSIONS,
) -> str:
    if ".." in file_path.replace("\\", "/").split("/"):
        raise HTTPException(status_code=400, detail="Đường dẫn nguồn không được chứa '..'.")
    candidate = Path(file_path).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="Đường dẫn nguồn phải là đường dẫn tuyệt đối.")
    if any(part.exists() and part.is_symlink() for part in (candidate, *candidate.parents)):
        raise HTTPException(status_code=400, detail="Không chấp nhận đường dẫn liên kết.")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=404, detail="Không tìm thấy ảnh nguồn.") from exc
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy file nguồn.")
    if resolved.suffix.lower() not in allowed_extensions:
        raise HTTPException(status_code=415, detail="Chỉ nhận PDF, PNG, JPG, WebP, BMP hoặc TIFF.")
    return str(resolved)


def _validate_local_image_path(file_path: str) -> str:
    return _validate_local_source_path(file_path, allowed_extensions=_IMAGE_EXTENSIONS)


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
    "/inspect",
    response_model=StickerSourceInspectResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def inspect_sticker_source_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
):
    """Chuẩn bị PDF/ảnh và preview; không warmup AI, không tạo mask/CutContour."""
    owned_upload = False
    source_path = ""
    original_name = "source"
    if file is not None:
        original_name = Path(file.filename or "source").name
        if Path(original_name).suffix.lower() not in _SOURCE_EXTENSIONS:
            raise HTTPException(status_code=415, detail="Chỉ nhận PDF, PNG, JPG, WebP, BMP hoặc TIFF.")
        try:
            _stored_name, source_path, _size = await save_upload_file(file)
        except ValueError as exc:
            raise HTTPException(status_code=415, detail=str(exc)) from exc
        owned_upload = True
    elif file_path:
        source_path = _validate_local_source_path(file_path)
        original_name = Path(source_path).name
    else:
        raise HTTPException(status_code=400, detail="Hãy chọn một file PDF hoặc ảnh tem.")

    def _inspect_and_store():
        try:
            # UIUX (audit 2026-08-08 §UNIFIED.8): inspector chỉ đọc metadata/preview
            # trong thread thường; AI và connected-components chưa được gọi ở bước này.
            inspection = inspect_sticker_source(source_path, original_name)
            return create_source_session(
                source_path=source_path,
                original_name=original_name,
                inspection=inspection,
            )
        finally:
            # UIUX (feedback 2026-08-19 §CUTPREVIEW.3): thread sở hữu file
            # upload tạm. Request bị hủy không được xóa file khi inspector
            # vẫn đang đọc nó; worker tự dọn sau khi đọc/tạo session xong.
            if owned_upload and source_path:
                try:
                    os.remove(source_path)
                except OSError:
                    pass

    def _close_abandoned_session(completed: asyncio.Task):
        """Dọn session mà client đã hủy trước khi nhận được ID."""
        try:
            abandoned = completed.result()
        except asyncio.CancelledError:
            return
        except Exception:
            # Đọc exception để task không phát cảnh báo "never retrieved".
            return
        try:
            close_session(abandoned.session_id)
        except Exception:
            logger.error(
                "Không dọn được phiên inspect bị client bỏ rơi",
                exc_info=True,
            )

    try:
        # Shield task thật, không chỉ coroutine chờ: khi WebView đổi file/đóng
        # tab, worker phải được chạy tới finally để file upload không rò rỉ.
        inspect_task = asyncio.create_task(run_in_threadpool(_inspect_and_store))
        try:
            session = await asyncio.shield(inspect_task)
        except asyncio.CancelledError:
            inspect_task.add_done_callback(_close_abandoned_session)
            raise
        return {
            **session.manifest,
            "preview_url": f"/api/sticker-sheet/{session.session_id}/assets/preview",
        }
    except StickerSourceInspectionError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Kiểm tra nguồn tem thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Không chuẩn bị được file nguồn ({type(exc).__name__}).",
        ) from exc


@router.post(
    "/{session_id}/detect",
    response_model=StickerSourceDetectResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def detect_sticker_source_endpoint(
    session_id: str,
    request: StickerSourceDetectRequest,
):
    """Nhận diện khi người dùng yêu cầu và nâng đúng session inspect hiện tại."""
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Phiên nguồn tem đã hết hạn. Hãy chọn lại file.")
    session = begin_source_detection(session_id, page_number=request.page_number)
    if session is None:
        # UIUX (audit 2026-08-09 §MP.9-10): backend có thể đã promote nhưng
        # WebView lỗi tải asset. Retry cùng trang chỉ phát lại manifest/URL, không
        # chạy model lần hai và không đóng session chứa kết quả của sibling.
        existing = _page_detection_response(session_id, request.page_number)
        if existing is not None:
            return existing
        raise HTTPException(status_code=409, detail="Nguồn tem này đã được nhận diện hoặc đang được xử lý.")

    def _detect_and_promote():
        # UIUX (audit 2026-08-08 §UNIFIED.8): toàn bộ nhánh deterministic/AI chỉ chạy
        # sau thao tác Nhận diện tem; cùng session ID được giữ xuyên suốt bước review.
        detected = detect_sticker_source(
            session,
            strategy=request.strategy,
            model=request.model,
            alpha_threshold=request.alpha_threshold,
            page_number=request.page_number,
            preview_only=request.preview_only,
        )
        return promote_source_session(
            session_id,
            analysis=detected.analysis,
            analysis_source=detected.source_image,
            boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review,
            dpi=detected.dpi,
            source_page=detected.source_page,
            vector_geometry_ref=detected.vector_geometry_ref,
            warnings=list(detected.warnings),
            edge_background_rgb=detected.background_rgb,
            edge_background_tolerance=detected.background_tolerance,
        )

    try:
        # PERF/UIUX (feedback 2026-08-19 §CUTPREVIEW.2): các chiến lược đã có
        # biên (CutContour/vector/Alpha/nền phẳng) chỉ là bước chuẩn bị preview
        # trung bình, không được chiếm hàng đợi heavy. AI/auto vẫn giữ scheduler
        # vì có thể nạp model và chạy inference nặng.
        if request.strategy in {"existing-cut", "vector", "alpha", "simple-bg", "page-box"}:
            promoted = await run_in_threadpool(_detect_and_promote)
        else:
            promoted = await run_heavy_in_threadpool(_detect_and_promote)
    except asyncio.CancelledError:
        abort_source_detection(session_id, page_number=request.page_number)
        raise
    except StickerSourcePipelineError as exc:
        restored = abort_source_detection(session_id, page_number=request.page_number)
        if not restored and get_session(session_id) is None:
            raise HTTPException(
                status_code=409,
                detail="Phiên nguồn tem đã thay đổi trong lúc nhận diện. Hãy kiểm tra kết quả hiện tại.",
            ) from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        restored = abort_source_detection(session_id, page_number=request.page_number)
        if not restored and get_session(session_id) is None:
            raise HTTPException(
                status_code=409,
                detail="Phiên nguồn tem đã đóng trong lúc nhận diện.",
            ) from exc
        logger.error("Nhận diện nguồn tem thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            # UIUX (feedback 2026-08-16 §WHITE-SHEET.2): tên lớp Python/ONNX chỉ
            # thuộc log chẩn đoán, không phải hướng dẫn có ích cho người dùng.
            detail="Không nhận diện được vùng tem. File gốc vẫn được giữ; hãy thử lại.",
        ) from exc
    if promoted is None:
        abort_source_detection(session_id, page_number=request.page_number)
        raise HTTPException(
            status_code=409,
            detail="Phiên nguồn tem đã thay đổi trong lúc nhận diện. Hãy kiểm tra kết quả hiện tại.",
        )

    response = _page_detection_response(promoted.session_id, request.page_number)
    if response is None:
        raise HTTPException(
            status_code=409,
            detail="Kết quả nhận diện của trang đã thay đổi trước khi đồng bộ preview.",
        )
    return response


@router.post(
    "/{session_id}/refine",
    response_model=StickerSourceDetectResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def refine_sticker_source_endpoint(
    session_id: str,
    request: StickerSourceRefineRequest,
):
    """Cập nhật preview từ Alpha đã cache; không chạy lại mô hình AI."""
    if get_session(session_id) is None:
        raise HTTPException(
            status_code=404,
            detail="Phiên nguồn tem đã hết hạn. Hãy chọn lại file.",
        )
    try:
        refined = await run_in_threadpool(
            refine_source_session,
            session_id,
            alpha_threshold=request.alpha_threshold,
            shadow_cleanup=request.shadow_cleanup,
            base_revision=request.base_revision,
            page_number=request.page_number,
        )
    except StickerSheetSessionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except StickerSheetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Tinh chỉnh preview nguồn tem thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Không cập nhật được bản xem trước ({type(exc).__name__}).",
        ) from exc
    if refined is None:
        raise HTTPException(
            status_code=409,
            detail="Phiên nguồn tem đã thay đổi trong lúc tinh chỉnh.",
        )

    page = get_page_state(refined.session_id, request.page_number)
    if page is None or page.stage != "mask-review":
        raise HTTPException(
            status_code=409,
            detail="Kết quả tinh chỉnh của trang đã thay đổi trước khi đồng bộ preview.",
        )
    base = f"/api/sticker-sheet/{refined.session_id}/assets"
    revision = int(page.manifest.get("mask_revision", 1))
    asset_query = f"v={revision}&page={request.page_number}"
    return {
        **page.manifest,
        "preview_url": f"{base}/preview?{asset_query}",
        "labels_url": f"{base}/labels?{asset_query}",
        "uncertainty_url": f"{base}/uncertainty?{asset_query}",
    }


@router.post(
    "/{session_id}/cutline-preview",
    response_model=StickerCutlinePreviewResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def preview_sticker_cutline_endpoint(
    session_id: str,
    request: StickerCutlinePreviewRequest,
):
    """Dựng Bézier CutContour thật để giao diện vẽ trực tiếp khi kéo thanh."""
    session = get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail="Phiên nguồn tem đã hết hạn. Hãy chọn lại file.",
        )
    try:
        return await run_in_threadpool(
            build_sticker_cutline_preview,
            session,
            page_number=request.page_number,
            base_revision=request.base_revision,
            edits=[edit.model_dump() for edit in request.edits],
            dpi=request.dpi,
            dpi_y=request.dpi_y,
            offset_mm=request.offset_mm,
            bleed_mm=request.bleed_mm,
            cut_mode=request.cut_mode,
            corner_style=request.corner_style,
            fill_holes=request.fill_holes,
            cutline_smoothness=request.cutline_smoothness,
            cutline_fidelity=request.cutline_fidelity,
            curve_tension=request.curve_tension,
            min_detail_area_mm2=request.min_detail_area_mm2,
            cutline_denoise=request.cutline_denoise,
        )
    except StickerSheetSessionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except StickerCanonicalPreviewConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except StickerSheetExportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("Dựng preview CutContour thất bại", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Không cập nhật được đường bế xem trước ({type(exc).__name__}).",
        ) from exc


@router.post(
    "/{session_id}/confirm",
    response_model=StickerSourceConfirmResponse,
    dependencies=[Depends(require_feature("prepress.cutline"))],
)
async def confirm_sticker_source_endpoint(
    session_id: str,
    request: StickerSourceConfirmRequest | None = None,
):
    """Chốt mask sau review; trước thời điểm này endpoint export luôn bị khóa."""
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Phiên nguồn tem đã hết hạn. Hãy chọn lại file.")
    page_number = request.page_number if request is not None else session.legacy_active_page
    page = get_page_state(session_id, page_number)
    if page is None or page.stage not in ("mask-review", "mask-ready"):
        raise HTTPException(status_code=409, detail="Hãy nhận diện vùng tem trước khi xác nhận.")
    confirmed = confirm_source_session(session_id, page_number=page_number)
    if confirmed is None:
        raise HTTPException(status_code=409, detail="Phiên nguồn tem đã thay đổi. Hãy thử lại.")
    return {
        "session_id": confirmed.session_id,
        "stage": page.stage,
        "mask_confirmed": bool(page.manifest.get("mask_confirmed")),
        "source_page": page_number,
    }


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
async def serve_sticker_sheet_asset(
    session_id: str,
    asset: str,
    v: int | None = None,
    page: int | None = None,
):
    if v is not None:
        try:
            content = await run_in_threadpool(
                read_versioned_asset,
                session_id,
                asset,
                v,
                page_number=page,
            )
        except StickerSheetSessionConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if content is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy preview tách tem.")
        return Response(
            content=content,
            media_type="image/png",
            headers={"Cache-Control": "no-store"},
        )

    path = get_asset(session_id, asset, page_number=page)
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
    if not request.pages and session.stage != "mask-ready":
        raise HTTPException(
            status_code=409,
            detail="Hãy nhận diện và xác nhận vùng tem trước khi xuất file.",
        )
    if request.pages:
        not_ready: list[int] = []
        stale: list[int] = []
        for page_request in request.pages:
            page = get_page_state(session_id, page_request.source_page)
            if page is None or page.stage != "mask-ready":
                not_ready.append(page_request.source_page)
                continue
            if int(page.manifest.get("mask_revision", 0)) != page_request.expected_revision:
                stale.append(page_request.source_page)
                continue
            if page_request.expected_fingerprint:
                actual_fingerprint = str(
                    (page.cutline_export_cache or {}).get("fingerprint", "")
                )
                if actual_fingerprint != page_request.expected_fingerprint:
                    stale.append(page_request.source_page)
        if not_ready:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Hãy nhận diện và xác nhận vùng tem cho trang "
                    + ", ".join(str(page) for page in sorted(not_ready))
                    + " trước khi xuất."
                ),
            )
        if stale:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Bản xem trước đã thay đổi ở trang "
                    + ", ".join(str(page) for page in sorted(stale))
                    + ". Hãy kiểm tra lại trước khi xuất."
                ),
            )
    try:
        common_options = {
            "dpi": request.dpi,
            "dpi_y": request.dpi_y,
            "offset_mm": request.offset_mm,
            "bleed_mm": request.bleed_mm,
            "cut_mode": request.cut_mode,
            "corner_style": request.corner_style,
            "fill_holes": request.fill_holes,
            "crop_to_sticker": request.crop_to_sticker,
            "bleed_color_type": request.bleed_color_type,
            "solid_bleed_cmyk": request.solid_bleed_cmyk,
            "shape_mode": request.shape_mode,
            "draw_cut_contour": request.draw_cut_contour,
            "preserve_existing_cut": request.preserve_existing_cut,
            "output_format": request.output_format,
            "cutline_smoothness": request.cutline_smoothness,
            "cutline_fidelity": request.cutline_fidelity,
            "curve_tension": request.curve_tension,
            "min_detail_area_mm2": request.min_detail_area_mm2,
            "cutline_denoise": request.cutline_denoise,
        }
        if request.pages:
            result = await run_heavy_in_threadpool(
                export_sticker_sheet_document,
                session,
                pages=[page.model_dump() for page in request.pages],
                page_order=request.page_order or [page.source_page for page in request.pages],
                **common_options,
            )
        else:
            result = await run_heavy_in_threadpool(
                export_sticker_sheet,
                session,
                edits=[edit.model_dump() for edit in request.edits],
                **common_options,
            )
    except StickerCanonicalPreviewConflict as exc:
        # UNIFY (audit 2026-09-06 §UNIFY.L1): đã yêu cầu đúng frame preview
        # thì stale fingerprint/tham số là lỗi đồng bộ nghiệp vụ, không phải
        # lỗi server 500. Không trả FileResponse và không công bố artifact dở.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
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
