"""
Preflight API Routes — REST endpoints for PDF inspection and auto-fix.

Endpoints:
  POST /api/preflight/inspect     — Run preflight checks
  POST /api/preflight/fix         — Execute a single fix action
  POST /api/preflight/pipeline    — Execute a chain of fix actions
  GET  /api/preflight/actions     — List available fix actions
  GET  /api/preflight/download/{filename} — Download fixed PDF
"""
import asyncio
import threading
import logging
import os
import uuid
import base64
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, Request, Query
from fastapi.responses import FileResponse, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import List, Optional, Any, Literal
import pikepdf

from app.core.preflight_engine import PreflightEngine, PreflightReport, PreflightIssue
from app.core.separations import SeparationEngine
from app.core.action_engine import ActionEngine, AVAILABLE_ACTIONS
from app.core.print_engine import PpeUnavailable, softproof as ppe_softproof
from app.utils.file_handler import save_upload_file
from app.utils.errors import raise_http
from app.config import settings
from app.core.license_guard import enforce_feature, require_license
from app.database import SessionLocal
from app.models.job import UploadedFile
# KIENTRUC (audit 2026-07-29 §A.2): response model dùng chung của nhóm preflight.
# Model request vẫn khai inline bên dưới (chưa gom, xem nhật ký lô 8).
from app.schemas.preflight import (
    CropRegionsResponse,
    ExportPdfxResponse,
    FixFileResponse,
    FixFileWithLogResponse,
    ConvertColorsPreviewResponse,
    FlattenLayersResponse,
    IccProfilesResponse,
    InksResponse,
    OcgLayerTreeResponse,
    OverprintPreviewResponse,
    PageBoxesResponse,
    PageObjectsResponse,
    PdfxComplianceResponse,
    PreviewImageResponse,
)

logger = logging.getLogger(__name__)

# KIENTRUC (audit 2026-07-29 §A.2 lô 13): model đã gom về app/schemas/preflight.py;
# import lại ở đây để mọi đường import cũ (kể cả test) vẫn dùng được.
from app.schemas.preflight import (  # noqa: F401
    ActionLogResponse,
    AddBleedRequest,
    AutoTrimRequest,
    ChannelReportResponse,
    ConvertColorsRequest,
    ConvertColorsPreviewRequest,
    ConvertSpotRequest,
    CropRegionsRequest,
    DeleteLayerRequest,
    DeleteObjectRequest,
    ExportPdfxRequest,
    FixHairlinesRequest,
    FixRequest,
    FixResponse,
    FlattenLayersRequest,
    InspectByIdRequest,
    ObjectToDelete,
    OverprintPreviewRequest,
    OutputPreviewFilter,
    PdfxStandard,
    PdfObjectResponse,
    PipelineAction,
    PipelineRequest,
    PreflightIssueResponse,
    PreflightReportResponse,
    PreviewLayersRequest,
    RenameLayerRequest,
    ReorderLayersRequest,
    SeparationCompositeRequest,
    SeparationsPathRequest,
    SetPageBoxesRequest,
    SetVisibilityRequest,
    SoftProofRequest,
    ViewerAccurateRenderRequest,
    ToggleLockRequest,
)

_DEFAULT_PREFLIGHT_FEATURE = "prepress.preflight"

# SEC (audit 2026-08-04 §BE.01): route không khai riêng sẽ fail về capability
# Preflight. Các route hỗ trợ công cụ chuyên biệt phải dùng đúng grant; route tải
# kết quả chỉ giữ require_license vì capability đã được enforce lúc tạo artifact.
_PREFLIGHT_ROUTE_FEATURES: dict[str, str | None] = {
    "/preflight/fix": None,
    "/preflight/pipeline": None,
    "/preflight/download/{filename}": None,
    "/preflight/page-boxes/{file_id}/{page}": "pdf.crop",
    "/preflight/set-page-boxes": "pdf.crop",
    "/preflight/detect-crop-regions": "pdf.crop",
    "/preflight/crop-regions": "pdf.crop",
    "/preflight/auto-trim": "pdf.crop",
    "/preflight/add-bleed": "prepress.cutline",
    "/preflight/fix-hairlines": "prepress.hairlines",
    "/preflight/inks/{file_id}": "prepress.convert_colors",
    "/preflight/convert-spot": "prepress.convert_colors",
    "/preflight/convert-colors": "prepress.convert_colors",
    "/preflight/convert-colors/preview": "prepress.convert_colors",
    "/preflight/icc-profiles": "prepress.convert_colors",
    "/preflight/softproof": "prepress.convert_colors",
    "/preflight/separation-composite": "prepress.convert_colors",
    # COLOR (audit 2026-08-07 §GV.3): đây là fidelity của Viewer thường, không phải
    # thao tác sửa/chuyển màu file nên không khóa sau capability chế bản nâng cao.
    "/preflight/viewer-accurate": None,
    "/preflight/viewer-accurate/session": None,
    "/preflight/set-overprint": "prepress.trapping",
    "/preflight/overprint-preview": "prepress.trapping",
    "/preflight/check-pdfx/{file_id}/{standard}": "prepress.pdfx",
    "/preflight/export-pdfx": "prepress.pdfx",
    "/preflight/mirror-bleed": "prepress.cutline",
}

_PREFLIGHT_ACTION_FEATURES = {
    "CONVERT_TO_CMYK": "prepress.convert_colors",
    "FLATTEN_TRANSPARENCY": "prepress.preflight",
    "OUTLINE_FONTS": "prepress.preflight",
    "EMBED_FONTS": "prepress.preflight",
    "DOWNSCALE_IMAGES": "prepress.preflight",
    "FIX_METADATA": "prepress.preflight",
    "REMOVE_CHANNELS": "prepress.convert_colors",
    "FIX_HAIRLINES": "prepress.hairlines",
    "SET_BLACK_OVERPRINT": "prepress.trapping",
}


def preflight_action_feature(action_id: str) -> str:
    """Trả capability có thẩm quyền cho một ActionEngine action."""
    return _PREFLIGHT_ACTION_FEATURES.get(action_id, _DEFAULT_PREFLIGHT_FEATURE)


def _local_preflight_route_path(request: Request) -> str:
    route = request.scope.get("route")
    route_path = str(getattr(route, "path", "") or request.url.path)
    marker = "/preflight/"
    index = route_path.find(marker)
    return route_path[index:] if index >= 0 else route_path


async def require_preflight_route_feature(
    request: Request,
    license_info: dict = Depends(require_license),
) -> dict:
    feature_id = _PREFLIGHT_ROUTE_FEATURES.get(
        _local_preflight_route_path(request),
        _DEFAULT_PREFLIGHT_FEATURE,
    )
    if feature_id is not None:
        enforce_feature(feature_id, license_info)
    return license_info


def enforce_preflight_actions(action_ids: List[str], license_info: dict) -> None:
    """Kiểm đủ mọi capability trước khi pipeline bắt đầu sửa file."""
    for feature_id in dict.fromkeys(preflight_action_feature(item) for item in action_ids):
        enforce_feature(feature_id, license_info)


router = APIRouter(dependencies=[Depends(require_preflight_route_feature)])


def _validate_local_pdf_path(file_path: str) -> str:
    """Kiểm tra path client gửi tới các endpoint *-by-path (desktop mở file tại chỗ).

    Đây là app desktop: người dùng CHỌN file qua Tauri dialog nên đường dẫn có thể
    ở bất kỳ đâu — KHÔNG ép vào UPLOAD_DIR. Nhưng vẫn hardening để nếu backend lỡ
    lộ ra mạng thì không thành đọc-file-tùy-ý toàn ổ đĩa:
      - Chuẩn hoá (chống ``..`` traversal), chặn null-byte.
      - BẮT BUỘC đuôi ``.pdf`` → không đọc được /etc/passwd, key, sidecar…
      - Phải là FILE thật đang tồn tại.
    Trả path đã chuẩn hoá; ném HTTPException nếu không hợp lệ.
    """
    raw = (file_path or "").strip()
    if not raw or "\x00" in raw:
        raise HTTPException(status_code=400, detail="Đường dẫn không hợp lệ.")
    norm = os.path.realpath(os.path.abspath(raw))
    if os.path.splitext(norm)[1].lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Chỉ chấp nhận file .pdf.")
    if not os.path.isfile(norm):
        raise HTTPException(status_code=404, detail="File không tồn tại.")
    return norm


# ── Request/Response Schemas ──


def _report_dict_to_response(report: Optional[dict]) -> Optional[ChannelReportResponse]:
    """Chuyển dict report nội bộ (ActionLogEntry.report) sang model API.

    Trả None khi action không sinh report để giữ nguyên hành vi cũ.
    """
    if not report:
        return None
    return ChannelReportResponse(
        max_delta_e=report.get("max_delta_e"),
        avg_delta_e=report.get("avg_delta_e"),
        out_of_gamut_count=report.get("out_of_gamut_count"),
        total_colors=report.get("total_colors"),
        warnings=list(report.get("warnings", []) or []),
        identical_to_original=report.get("identical_to_original"),
    )


def _action_result_to_fix_response(result) -> "FixResponse":
    """Dựng FixResponse từ ActionResult, surface report (nếu có) lên response.

    Mỗi step giữ report riêng trong ``log[i].report``; ``FixResponse.report`` lấy
    report của step gần nhất có dữ liệu (vd REMOVE_CHANNELS trong pipeline).
    """
    log_entries = []
    last_report: Optional[ChannelReportResponse] = None
    for entry in result.log:
        entry_report = _report_dict_to_response(getattr(entry, "report", None))
        if entry_report is not None:
            last_report = entry_report
        log_entries.append(
            ActionLogResponse(
                action_id=entry.action_id,
                status=entry.status,
                message=entry.message,
                duration_ms=entry.duration_ms,
                report=entry_report,
            )
        )

    return FixResponse(
        success=result.success,
        output_filename=Path(result.output_path).name if result.output_path else None,
        log=log_entries,
        error=result.error,
        report=last_report,
    )


# ── Helper ──

def _get_file_path(file_id: str) -> str:
    """Resolve file_id to actual file path from DB."""
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if not uploaded:
            raise HTTPException(status_code=404, detail=f"File ID '{file_id}' không tìm thấy.")
        if not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail=f"File đã bị xóa khỏi server.")
        return uploaded.file_path
    finally:
        db.close()

def _get_file_info(file_id: str) -> tuple[str, str]:
    """Resolve file_id to (file_path, original_name) from DB."""
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if not uploaded:
            raise HTTPException(status_code=404, detail=f"File ID '{file_id}' không tìm thấy.")
        if not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail=f"File đã bị xóa khỏi server.")
        return uploaded.file_path, uploaded.original_name or uploaded.filename
    finally:
        db.close()


def _report_to_response(report: PreflightReport) -> PreflightReportResponse:
    """Convert internal report dataclass to API response model."""
    return PreflightReportResponse(
        file_name=report.file_name,
        total_pages=report.total_pages,
        issues=[
            PreflightIssueResponse(
                rule_id=i.rule_id,
                severity=i.severity,
                page=i.page,
                object_ref=i.object_ref,
                description=i.description,
                auto_fixable=i.auto_fixable,
                bbox=i.bbox,
                bboxes=i.bboxes,
            )
            for i in report.issues
        ],
        summary=report.summary,
        color_summary=report.color_summary,
        font_summary=report.font_summary,
        image_summary=report.image_summary,
    )


# ── Endpoints ──

@router.post("/preflight/inspect", response_model=PreflightReportResponse)
async def inspect_pdf(request: InspectByIdRequest):
    """
    Chạy Preflight kiểm tra cấu trúc PDF.
    Trả về danh sách lỗi/cảnh báo chi tiết.
    """
    pdf_path, original_name = _get_file_info(request.file_id)

    try:
        from app.core.preflight_rules.ink import _normalize_tac_threshold
        tac_threshold = _normalize_tac_threshold(request.tac_threshold)
        engine = PreflightEngine()
        # PERF (audit 2026-08-13 §FONT.PERF.1): Preflight mở/duyệt PDF đồng bộ;
        # không được giữ event loop trong lúc sidecar đang quét tài liệu.
        report = await run_in_threadpool(
            engine.run,
            pdf_path,
            rules=request.rules,
            tac_threshold=tac_threshold,
        )
        resp = _report_to_response(report)
        resp.summary["tac_threshold"] = tac_threshold
        return resp
    except Exception as e:
        logger.exception("Preflight inspect failed")
        raise HTTPException(status_code=500, detail=f"Lỗi kiểm tra ({type(e).__name__})")


@router.post("/preflight/inspect-upload", response_model=PreflightReportResponse)
async def inspect_uploaded_pdf(file: UploadFile = File(...)):
    """
    Upload PDF trực tiếp và chạy Preflight ngay lập tức.
    Dùng cho trường hợp không cần lưu file vào DB.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file PDF.")

    try:
        stored_name, file_path, _ = await save_upload_file(file)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Không lưu được file tải lên: {e}")

    try:
        engine = PreflightEngine()
        # PERF (audit 2026-08-13 §FONT.PERF.1): giữ cả đường upload trực tiếp
        # không chặn các request khác của sidecar.
        report = await run_in_threadpool(engine.run, file_path)
        return _report_to_response(report)
    except Exception as e:
        logger.exception("Preflight inspect-upload failed")
        raise HTTPException(status_code=500, detail=f"Lỗi kiểm tra ({type(e).__name__})")


@router.post("/preflight/fix", response_model=FixResponse)
async def fix_pdf(
    request: FixRequest,
    http_request: Request,
    license_info: dict = Depends(require_license),
):
    """
    Thực thi một Action sửa lỗi trên file PDF.
    Trả về thông tin file đã sửa.
    """
    enforce_preflight_actions([request.action_id], license_info)
    pdf_path, original_name = _get_file_info(request.file_id)

    try:
        engine = ActionEngine()
        action_task = asyncio.create_task(
            engine.execute(pdf_path, request.action_id, request.params, original_name=original_name)
        )

        async def watch_disconnect() -> None:
            """AbortController phía UI phải hủy cả worker outline ở backend."""
            while not action_task.done():
                if await http_request.is_disconnected():
                    action_task.cancel()
                    return
                await asyncio.sleep(0.1)

        # PERF (audit 2026-08-13 §FONT.UI.2): ActionEngine đã có token cooperative;
        # watcher này nối client disconnect vào token thay vì chỉ dừng spinner UI.
        disconnect_task = asyncio.create_task(watch_disconnect())
        try:
            result = await action_task
        finally:
            disconnect_task.cancel()
            await asyncio.gather(disconnect_task, return_exceptions=True)

        return _action_result_to_fix_response(result)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("Preflight fix failed")
        raise HTTPException(status_code=500, detail=f"Lỗi sửa file ({type(e).__name__})")


@router.post("/preflight/pipeline", response_model=FixResponse)
async def pipeline_fix(
    request: PipelineRequest,
    license_info: dict = Depends(require_license),
):
    """
    Chạy chuỗi Actions tuần tự (Pipeline).
    Ví dụ: CONVERT_TO_CMYK → FLATTEN_TRANSPARENCY → EMBED_FONTS
    """
    enforce_preflight_actions([action.id for action in request.actions], license_info)
    pdf_path, original_name = _get_file_info(request.file_id)

    try:
        engine = ActionEngine()
        actions = [{"id": a.id, "params": a.params or {}} for a in request.actions]
        result = await engine.execute_batch(pdf_path, actions, original_name=original_name)

        return _action_result_to_fix_response(result)
    except Exception as e:
        logger.exception("Preflight pipeline failed")
        raise HTTPException(status_code=500, detail=f"Lỗi pipeline ({type(e).__name__})")


@router.get("/preflight/actions")
async def list_actions():
    """Liệt kê tất cả các Action khả dụng (cho UI rendering)."""
    return AVAILABLE_ACTIONS


@router.get("/preflight/download/{filename}")
async def download_fixed_pdf(filename: str):
    """Download file PDF đã được sửa."""
    output_dir = Path(settings.RESULTS_DIR) / "preflight_output"

    # CONTAINMENT: filename tới thẳng từ URL. Trên Windows `%5C` decode thành `\`
    # nên `..\..\Windows\win.ini` có thể thoát output_dir → đọc file hệ thống bất kỳ.
    # Chỉ nhận tên file trần (không phân đoạn thư mục), rồi xác nhận path đã resolve
    # vẫn nằm TRONG output_dir. Reject mọi thứ khác.
    base = output_dir.resolve()
    file_path = (base / filename).resolve()
    if base not in file_path.parents:
        raise HTTPException(status_code=400, detail="Tên file không hợp lệ.")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File không tìm thấy hoặc đã hết hạn.")

    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type="application/pdf",
    )



from app.core.pdf_object_ops import merge_rects as _merge_rects, expand_bbox as _expand_bbox, remove_text_from_stream as _remove_text_from_stream


@router.get("/preflight/page-svg/{file_id}/{page}")
async def get_page_svg(file_id: str, page: int):
    """Render a PDF page as SVG vector graphics using MuPDF C++ engine."""
    from fastapi.responses import Response
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if not uploaded or not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail="File không tồn tại.")
        
        import pypdfium2 as pdfium
        from app.core.pdfium_lock import pdfium_guard
        # KIENTRUC (audit 2026-07-29 §C.1): endpoint async nhưng PDFium là code C đồng bộ —
        # nhiều request preview cùng lúc vẫn chạm PDFium song song qua event loop + threadpool.
        with pdfium_guard("preflight_page_svg"):
            pdf_doc = pdfium.PdfDocument(uploaded.file_path)
            if page < 1 or page > len(pdf_doc):
                pdf_doc.close()
                raise HTTPException(status_code=400, detail="Trang không hợp lệ.")

            p = pdf_doc[page - 1]
            bitmap = p.render(scale=200/72)
            img = bitmap.to_pil()
            pdf_doc.close()

        # Convert to PNG base64 (SVG replacement - raster preview)
        import io as _io
        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        png_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        
        # Return as SVG with embedded raster image
        w, h = img.size
        svg_content = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><image href="data:image/png;base64,{png_b64}" width="{w}" height="{h}"/></svg>'
        
        return Response(
            content=svg_content,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=3600"}
        )
    except Exception as e:
        raise_http(e, "Lỗi render SVG")
    finally:
        db.close()


@router.get("/preflight/svg-by-path")
async def get_page_svg_by_path(file_path: str, page: int):
    """Render SVG from a local file path (desktop app only)."""
    from fastapi.responses import Response
    try:
        file_path = _validate_local_pdf_path(file_path)

        import pypdfium2 as pdfium
        from app.core.pdfium_lock import pdfium_guard
        # KIENTRUC (audit 2026-07-29 §C.1) — như get_page_svg ở trên.
        with pdfium_guard("preflight_svg_by_path"):
            pdf_doc = pdfium.PdfDocument(file_path)
            if page < 1 or page > len(pdf_doc):
                pdf_doc.close()
                raise HTTPException(status_code=400, detail="Trang không hợp lệ.")

            p = pdf_doc[page - 1]
            bitmap = p.render(scale=200/72)
            img = bitmap.to_pil()
            pdf_doc.close()

        import io as _io
        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        png_b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        
        w, h = img.size
        svg_content = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><image href="data:image/png;base64,{png_b64}" width="{w}" height="{h}"/></svg>'
        
        return Response(
            content=svg_content,
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=3600"}
        )
    except Exception as e:
        raise_http(e, "Lỗi render SVG by path")

@router.get("/preflight/objects/{file_id}/{page}", response_model=PageObjectsResponse)
async def get_page_objects(file_id: str, page: int):
    """Trích xuất toàn bộ object (Text, Image, Drawing) của một trang cụ thể."""
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if not uploaded or not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail="File không tồn tại.")
        
        doc = pikepdf.Pdf.open(uploaded.file_path)
        if page < 1 or page > len(doc.pages):
            raise HTTPException(status_code=400, detail="Trang không hợp lệ.")
            
        objects = []
        obj_idx = 0
        
        # 1. Text spans via pdfplumber
        try:
            import pdfplumber
            with pdfplumber.open(uploaded.file_path) as plumber:
                plumber_page = plumber.pages[page - 1]
                words = plumber_page.extract_words() or []
                for w in words:
                    objects.append(PdfObjectResponse(
                        id=f"p{page}_txt_{obj_idx}",
                        type='text',
                        bbox=[w['x0'], w['top'], w['x1'], w['bottom']],
                        content=w.get('text', '')[:80]
                    ))
                    obj_idx += 1
        except Exception as e:
            logger.debug(f"pdfplumber text extraction failed: {e}")
            
        # 2. Images from pikepdf Resources
        pike_page = doc.pages[page - 1]
        try:
            resources = pike_page.get("/Resources")
            if resources:
                xobjects = resources.get("/XObject")
                if xobjects:
                    for name, ref in xobjects.items():
                        try:
                            obj = ref
                            if hasattr(ref, 'resolve'):
                                obj = ref.resolve() if callable(getattr(ref, 'resolve', None)) else ref
                            subtype = str(obj.get("/Subtype", ""))
                            if subtype == "/Image":
                                w = int(obj.get("/Width", 0))
                                h = int(obj.get("/Height", 0))
                                if w <= 1 and h <= 1:
                                    continue
                                # Without content stream analysis, we can't get exact bbox
                                # Use page dimensions as approximation
                                mb = pike_page.get("/MediaBox")
                                if mb:
                                    bbox = [float(mb[0]), float(mb[1]), float(mb[2]), float(mb[3])]
                                else:
                                    bbox = [0, 0, 595, 842]
                                # xref = object number của image XObject (ổn định giữa
                                # list và delete → delete-object khớp ĐÚNG ảnh này, không
                                # xóa mù mọi ảnh). objgen=(num, gen); num=0 nếu là inline.
                                try:
                                    xref_num = int(obj.objgen[0]) or None
                                except Exception:
                                    xref_num = None
                                objects.append(PdfObjectResponse(
                                    id=f"p{page}_img_{obj_idx}",
                                    type='image',
                                    bbox=bbox,
                                    xref=xref_num,
                                ))
                                obj_idx += 1
                        except Exception:
                            pass
        except Exception:
            pass

        # 3. Drawings — simplified (no extract_vector_paths equivalent in pikepdf)
        # Skip vector object listing since pikepdf can't enumerate path objects easily
            
        doc.close()
        return {"objects": objects}
    except Exception as e:
        raise_http(e, "Lỗi khi trích xuất object")
    finally:
        db.close()


def _delete_images_by_ref(page, image_objs) -> int:
    """Xóa CHỈ các image XObject KHỚP object number (xref) yêu cầu — không xóa mù.

    Bug cũ: lặp mọi XObject ``/Image`` và ``del`` tất → yêu cầu xóa 1 ảnh làm mất
    SẠCH ảnh trên trang (mất dữ liệu âm thầm). Nay chỉ xóa entry mà object number
    của XObject (``objgen[0]``) nằm trong tập ``xref`` client gửi — cùng object
    number mà endpoint list trả về nên khớp chính xác.

    Nếu KHÔNG có xref nào (client cũ / chưa gửi) → không xóa gì, trả 0 để caller
    quyết (an toàn hơn xóa nhầm). Trả số ảnh đã xóa.
    """
    target_xrefs = {o.xref for o in image_objs if o.xref is not None}
    if not target_xrefs:
        return 0
    resources = page.get("/Resources")
    if not resources:
        return 0
    xobjects = resources.get("/XObject")
    if not xobjects:
        return 0
    removed = 0
    for name in list(xobjects.keys()):
        try:
            ref = xobjects[name]
            obj = ref.resolve() if hasattr(ref, "resolve") and callable(getattr(ref, "resolve", None)) else ref
            if str(obj.get("/Subtype", "")) != "/Image":
                continue
            og = getattr(obj, "objgen", None)
            obj_num = og[0] if og else None
            if obj_num is not None and obj_num in target_xrefs:
                del xobjects[name]
                removed += 1
        except Exception:
            pass
    return removed


@router.post("/preflight/delete-object", response_model=FixFileResponse)
async def delete_pdf_object(req: DeleteObjectRequest):
    """Xóa nhiều objects khỏi PDF sử dụng Redaction thông minh."""
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == req.file_id).first()
        if not uploaded or not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail="File không tồn tại.")
            
        doc = pikepdf.Pdf.open(uploaded.file_path)
        if req.page < 1 or req.page > len(doc.pages):
            raise HTTPException(status_code=400, detail="Trang không hợp lệ.")
            
        p = doc.pages[req.page - 1]
        
        # Group objects by type
        text_objs = [obj for obj in req.objects if obj.type == 'text']
        image_objs = [obj for obj in req.objects if obj.type == 'image']
        drawing_objs = [obj for obj in req.objects if obj.type == 'drawing']

        # 1. Process Images — CHỈ xóa image khớp xref yêu cầu (không xóa mù).
        logger.info(f"Received request to delete {len(image_objs)} images.")

        if image_objs:
            removed = _delete_images_by_ref(p, image_objs)
            logger.info("delete-object: xóa %d/%d ảnh khớp xref.", removed, len(image_objs))

        # 2. Process Text — use surgical CTM parser to remove text blocks
        if text_objs:
            _remove_text_from_stream(doc, p, text_objs)

        # 3. Process Drawings/Vectors — not supported without native redactions
        # Drawing deletion requires content stream parsing (complex)
        if drawing_objs:
            logger.warning("Drawing deletion not fully supported not fully supported. Skipping drawing deletion.")
            
        # Save
        output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        output_dir.mkdir(parents=True, exist_ok=True)
        original_stem = Path(uploaded.original_name).stem if uploaded.original_name else Path(uploaded.file_path).stem
        output_name = f"{original_stem}_erased_{uuid.uuid4().hex[:6]}.pdf"
        output_path = output_dir / output_name
        
        doc.save(str(output_path))
        doc.close()
        
        return {
            "success": True,
            "output_filename": output_name,
        }
    except Exception as e:
        raise_http(e, "Lỗi khi xóa object")
    finally:
        db.close()


@router.post("/preflight/preview-hide", response_model=PreviewImageResponse)
async def preview_hide_pdf_object(req: DeleteObjectRequest):
    """Tạo ảnh preview Base64 của trang với các objects đã bị xóa tạm (tắt mắt)."""
    import io as _io
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == req.file_id).first()
        if not uploaded or not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail="File không tồn tại.")
            
        import pypdfium2 as pdfium
        
        # Prefer live EditSession bytes (for edit mode accurate state after transforms/hides)
        import app.core.edit_session as edit_session_mod
        from io import BytesIO as _BytesIO
        session = edit_session_mod.get_active_session(req.file_id)
        temp_doc_path = None
        if session:
            buf = _BytesIO()
            with session.lock:
                session.pdf.save(buf, compress_streams=False)
            live_bytes = buf.getvalue()
            import tempfile, os
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmpf:
                tmpf.write(live_bytes)
                temp_doc_path = tmpf.name
            doc = pikepdf.Pdf.open(temp_doc_path)
        else:
            doc = pikepdf.Pdf.open(uploaded.file_path)
        if req.page < 1 or req.page > len(doc.pages):
            raise HTTPException(status_code=400, detail="Trang không hợp lệ.")
            
        p = doc.pages[req.page - 1]
        
        # Group objects by type
        text_objs = [obj for obj in req.objects if obj.type == 'text']
        image_objs = [obj for obj in req.objects if obj.type == 'image']
        drawing_objs = [obj for obj in req.objects if obj.type == 'drawing']

        # 1. Process Images — CHỈ ẩn image khớp xref yêu cầu (không xóa mù).
        if image_objs:
            _delete_images_by_ref(p, image_objs)

        # 2. Process Text
        if text_objs:
            _remove_text_from_stream(doc, p, text_objs)

        # Save processed doc (live or disk) to a render temp and rasterize
        import tempfile, os
        render_tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
        try:
            doc.save(render_tmp.name)
            doc.close()
            
            # KIENTRUC (audit 2026-07-29 §C.1): encode JPEG nằm TRONG khóa là cố ý —
            # `bitmap.to_pil()` có thể tham chiếu bộ đệm bitmap nên không đổi thứ tự
            # "dùng ảnh xong mới đóng tài liệu".
            from app.core.pdfium_lock import pdfium_guard
            with pdfium_guard("preflight_preview_hide_render"):
                pdf_render = pdfium.PdfDocument(render_tmp.name)
                render_page = pdf_render[req.page - 1]
                requested_dpi = max(36.0, min(200.0, float(req.preview_dpi)))
                render_scale = requested_dpi / 72.0
                if req.preview_max_pixels and req.preview_max_pixels > 0:
                    page_width, page_height = render_page.get_size()
                    projected_pixels = page_width * page_height * render_scale * render_scale
                    if projected_pixels > req.preview_max_pixels:
                        render_scale *= (req.preview_max_pixels / projected_pixels) ** 0.5
                bitmap = render_page.render(scale=render_scale)
                img = bitmap.to_pil()
                pdf_render.close()

                buf = _io.BytesIO()
                img.save(buf, format='JPEG', quality=92)
                b64 = base64.b64encode(buf.getvalue()).decode('utf-8')
        finally:
            try:
                os.unlink(render_tmp.name)
            except Exception:
                pass
            if temp_doc_path:
                try:
                    os.unlink(temp_doc_path)
                except Exception:
                    pass
        
        return {
            "success": True,
            "preview_b64": f"data:image/jpeg;base64,{b64}"
        }
    except Exception as e:
        raise_http(e, "Lỗi khi tạo ảnh preview tắt mắt")
    finally:
        db.close()

@router.get("/preflight/layers/{file_id}", response_model=OcgLayerTreeResponse)
async def get_ocg_layers(file_id: str, original_only: bool = False):
    """Đọc cây OCG từ live session nếu đang sửa, nếu không đọc file đã upload."""
    from app.core.layer_engine import LayerEngine
    import app.core.edit_session as edit_session
    from io import BytesIO

    pdf_path = _get_file_path(file_id)

    def _read() -> dict:
        session = edit_session.get_active_session(file_id)
        if session:
            with session.lock:
                live_bytes = session.live_bytes
                if live_bytes is None:
                    buf = BytesIO()
                    session.pdf.save(buf, compress_streams=False)
                    live_bytes = buf.getvalue()
                    session.live_bytes = live_bytes
            return LayerEngine().get_layer_tree(live_bytes, original_only=original_only)
        return LayerEngine().get_layer_tree(pdf_path, original_only=original_only)

    try:
        return await run_in_threadpool(_read)
    except Exception as exc:
        raise_http(exc, "Lỗi khi trích xuất OCG layers")


@router.post("/preflight/preview-layers")
async def preview_layers_pdf(req: PreviewLayersRequest):
    """Render preview OCG ngoài event loop; dùng bytes live-session, không ghi file tạm."""
    from app.core.layer_engine import LayerEngine
    import app.core.edit_session as edit_session
    from io import BytesIO

    pdf_path = _get_file_path(req.file_id)

    def _render() -> str:
        engine = LayerEngine()
        session = edit_session.get_active_session(req.file_id)
        if session:
            with session.lock:
                live_bytes = session.live_bytes
                if live_bytes is None:
                    buf = BytesIO()
                    session.pdf.save(buf, compress_streams=False)
                    live_bytes = buf.getvalue()
                    session.live_bytes = live_bytes
            return engine.render_with_visibility(live_bytes, req.page, req.hidden_layer_ids, dpi=150)
        return engine.render_with_visibility(pdf_path, req.page, req.hidden_layer_ids, dpi=150)

    try:
        preview_b64 = await run_in_threadpool(_render)
        return {"success": True, "preview_b64": preview_b64}
    except Exception as exc:
        raise_http(exc, "Lỗi khi tạo ảnh preview layers")


@router.post("/preflight/layers/rename", response_model=FixFileResponse)
async def rename_layer(req: RenameLayerRequest):
    """Đổi tên OCG layer."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.rename_layer(pdf_path, req.layer_id, req.new_name)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi đổi tên layer")



@router.post("/preflight/layers/toggle-lock", response_model=FixFileResponse)
async def toggle_layer_lock(req: ToggleLockRequest):
    """Khóa/mở khóa OCG layer."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.toggle_lock(pdf_path, req.layer_id, req.locked)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi khóa/mở khóa layer")



@router.post("/preflight/layers/set-visibility", response_model=FixFileResponse)
async def set_layer_visibility(req: SetVisibilityRequest):
    """Đặt visibility (ẩn/hiện) cho OCG layer và lưu vào PDF."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.set_visibility(pdf_path, req.layer_id, req.visible)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi đặt visibility layer")



@router.post("/preflight/layers/delete", response_model=FixFileResponse)
async def delete_layer(req: DeleteLayerRequest):
    """Xóa OCG layer khỏi PDF."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.delete_layer(pdf_path, req.layer_id)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi xóa layer")



@router.post("/preflight/layers/reorder", response_model=FixFileResponse)
async def reorder_layers(req: ReorderLayersRequest):
    """Sắp xếp lại thứ tự OCG layers."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.reorder_layers(pdf_path, req.new_order)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi sắp xếp lại layers")



@router.post("/preflight/layers/flatten", response_model=FlattenLayersResponse)
async def flatten_layers(req: FlattenLayersRequest):
    """Flatten visible layers — gộp tất cả layer hiện tại thành 1 (không có OCG)."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.flatten_visible(pdf_path)
        # `warning` KHÔNG rỗng nghĩa là đã phải raster hoá: file ra mất vector/CMYK/
        # màu pha. Trả lên để UI nói cho thợ biết, đừng chỉ success=True (GS-SUNSET).
        return {
            "success": True,
            "output_filename": Path(output).name,
            "warning": engine.last_flatten_warning,
        }
    except Exception as e:
        raise_http(e, "Lỗi khi flatten layers")

@router.get("/preflight/separations/{file_id}/{page}")
async def get_separations(
    file_id: str,
    page: int,
    dpi: int = 150,
    render_mode: Literal["accurate", "approximate"] = "accurate",
    profile_id: str = "fogra39",
    intent: Literal["perceptual", "relative", "saturation", "absolute"] = "relative",
    output_preview_filter: OutputPreviewFilter = "all",
):
    """
    Trích xuất bản kẽm (Separations) — gần Acrobat Output Preview.

    Mặc định dùng PrynX Print Engine (PPE) để dựng kẽm process + spot.
    ``render_mode=accurate`` dùng PPE; ``approximate`` buộc đường xem nhanh
    PDF→RGB→CMYK có nhãn xấp xỉ.
    """
    pdf_path = _get_file_path(file_id)

    try:
        engine = SeparationEngine()
        result = await engine.extract_separations(
            pdf_path, page, dpi,
            cmyk_profile_id=profile_id or "fogra39",
            rendering_intent=intent,
            render_mode=render_mode,
            output_preview_filter=output_preview_filter,
        )
        # CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.4): response mang danh
        # tính filter để UI không dùng plate của request cũ cho sampling/TAC.
        result["output_preview_filter"] = output_preview_filter
        return result
    except PpeUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise_http(e, "Lỗi khi tạo Separations")



@router.post("/preflight/separation-composite")
async def compose_separation_preview(req: SeparationCompositeRequest):
    """Ghép tập kẽm đang bật thành PNG color-managed, không raster lại PDF."""
    from io import BytesIO
    from PIL import Image
    from app.core.print_engine.facade import (
        PpeUnavailable,
        compose_separation_subset,
    )

    intent_codes = {
        "perceptual": 0,
        "relative": 1,
        "saturation": 2,
        "absolute": 3,
    }

    def _compose_png() -> tuple[bytes, dict[str, Any]]:
        result = compose_separation_subset(
            width=req.width,
            height=req.height,
            plates=[plate.model_dump() for plate in req.plates],
            enabled_names=req.enabled_names,
            cmyk_profile_id=req.profile_id,
            render_intent=intent_codes[req.intent],
        )
        image = Image.frombytes(
            "RGB",
            (int(result["width"]), int(result["height"])),
            bytes(result["rgb"]),
        )
        buffer = BytesIO()
        image.save(buffer, format="PNG", optimize=False, compress_level=1)
        return buffer.getvalue(), result

    try:
        png, metadata = await asyncio.to_thread(_compose_png)
    except PpeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - lỗi CMM/native cần nổi rõ tại API
        logger.exception("Lỗi khi ghép tập bản kẽm Output Preview")
        raise HTTPException(
            status_code=500,
            detail=f"Không ghép được tập bản kẽm: {exc}",
        ) from exc

    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-PrynX-Color-Accuracy": "rip-separation-subset",
            "X-PrynX-Color-Profile": req.profile_id,
            "X-PrynX-Missing-Spot-Alternates": str(
                len(metadata.get("missing_spot_alternates") or [])
            ),
        },
    )


@router.post("/preflight/separations-by-path")
async def get_separations_by_path(req: SeparationsPathRequest):
    """
    Desktop-only: Trích xuất kẽm trực tiếp từ đường dẫn file trên ổ đĩa.
    Không cần upload — backend đọc file tại chỗ. Tức thì.
    """
    safe_path = _validate_local_pdf_path(req.file_path)

    try:
        engine = SeparationEngine()
        result = await engine.extract_separations(
            safe_path, req.page, req.dpi,
            cmyk_profile_id=req.profile_id or "fogra39",
            rendering_intent=req.intent,
            render_mode=req.render_mode,
            output_preview_filter=req.output_preview_filter,
        )
        result["output_preview_filter"] = req.output_preview_filter
        return result
    except PpeUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise_http(e, "Lỗi khi tạo Separations (by path)")


# ══════════════════════════════════════════════════════════════
#  PAGE BOXES (Set Page Boxes)
# ══════════════════════════════════════════════════════════════

@router.get("/preflight/page-boxes/{file_id}/{page}", response_model=PageBoxesResponse)
async def get_page_boxes(file_id: str, page: int):
    """Lấy thông tin 5 box của 1 trang."""
    file_path = _get_file_path(file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        return engine.get_boxes(file_path, page)
    except Exception as e:
        raise_http(e, "Không lấy được thông tin page boxes")


@router.post("/preflight/set-page-boxes", response_model=FixFileResponse)
async def set_page_boxes(req: SetPageBoxesRequest):
    """Cập nhật 1 loại box cho danh sách trang."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = engine.set_boxes(file_path, req.box_type, req.rect_mm, req.pages)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Không cập nhật được page boxes")



class DetectCropRegionsRequest(CropRegionsRequest):
    """Dò bốn cạnh thành phẩm nằm gần bên trong các vùng quét rộng."""
    max_trim_mm: float = 5.0


@router.post("/preflight/detect-crop-regions")
async def detect_crop_regions(req: DetectCropRegionsRequest, request: Request):
    """Chỉ trả khung được đề xuất để người dùng xem trước; chưa sửa file PDF."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    cancel_event = threading.Event()

    async def watch_disconnect() -> None:
        while not cancel_event.is_set():
            if await request.is_disconnected():
                cancel_event.set()
                return
            await asyncio.sleep(0.1)

    disconnect_task = asyncio.create_task(watch_disconnect())
    try:
        return await run_in_threadpool(
            engine.detect_crop_regions,
            file_path,
            req.page,
            req.rects_mm,
            req.max_trim_mm,
            cancel_event,
        )
    except Exception as e:
        raise_http(e, "Không dò được rìa dư")
    finally:
        cancel_event.set()
        disconnect_task.cancel()

@router.post("/preflight/crop-regions", response_model=CropRegionsResponse)
async def crop_regions(req: CropRegionsRequest):
    """Mỗi vùng quét → 1 trang trong PDF kết quả (thứ tự giữ nguyên)."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = await run_in_threadpool(
            engine.crop_regions_to_pages,
            file_path,
            req.page,
            req.rects_mm,
            req.keep_other_pages,
            req.pages,
            req.display_rects_mm,
        )
        return {
            "success": True,
            "output_filename": Path(output).name,
            "page_count": len(req.rects_mm) * len(req.pages or [req.page]),
        }
    except Exception as e:
        raise_http(e, "Không crop được nhiều vùng")


@router.post("/preflight/auto-trim", response_model=FixFileResponse)
async def auto_trim(req: AutoTrimRequest):
    """Xén viền dư màu phẳng; cạnh được chọn tường minh là bắt buộc."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        # RESIZE (audit 2026-07-31 §C.2): render PDFium + OpenCV là việc đồng bộ;
        # không chặn event loop trong lúc xóa viền cho PDF nhiều trang.
        output = await run_in_threadpool(
            engine.auto_trim, file_path, req.pages, req.margin_mm, req.trim_sides,
        )
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Không tự động xóa lề trắng được")


@router.post("/preflight/add-bleed", response_model=FixFileResponse)
async def add_bleed(req: AddBleedRequest):
    """Tự động set BleedBox = TrimBox + bleed."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = engine.add_bleed_from_trim(
            file_path, req.bleed_mm, req.pages, sides=req.bleed_sides,
        )
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Không thêm được vùng bleed")


def _safe_watermark_preflight(pdf_path: str, license_info: dict | None) -> None:
    """Nhúng stealth watermark vào output (non-blocking, bỏ qua DEV_MODE).

    Giữ tính nhất quán với các endpoint pdf-tools: output phát hành đều có dấu
    truy vết. Mọi lỗi chỉ log, không làm hỏng file kết quả.
    """
    lk = (license_info or {}).get("license_key", "") or ""
    if not lk or lk == "DEV_MODE":
        return
    hwid = (license_info or {}).get("hwid", "") or ""
    tmp_path = None
    try:
        import tempfile
        from app.core.watermark import embed_watermark
        with pikepdf.Pdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            embed_watermark(pdf, lk, hwid)
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
            os.close(fd)
            pdf.save(tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.error(f"[WATERMARK] preflight mirror-bleed failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@router.post("/preflight/mirror-bleed", response_model=FixFileResponse)
async def mirror_bleed(req: AddBleedRequest, license_info: dict = Depends(require_license)):
    """Tạo bù xén bằng cách LẬT GƯƠNG nội dung mép ra vùng bleed (giữ vector)."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        # RESIZE (audit 2026-07-31 §C.2): pikepdf phải chạy ngoài event loop;
        # đây là việc trung bình nên dùng threadpool thường, không chiếm heavy slot.
        output = await run_in_threadpool(
            engine.add_mirror_bleed,
            file_path,
            req.bleed_mm,
            req.pages,
            req.bleed_sides,
        )
        _safe_watermark_preflight(output, license_info)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi tạo mirror-bleed")


# ══════════════════════════════════════════════════════════════
#  FIX HAIRLINES
# ══════════════════════════════════════════════════════════════



@router.post("/preflight/fix-hairlines", response_model=FixFileWithLogResponse)
async def fix_hairlines(req: FixHairlinesRequest):
    """Quét & sửa nét mảnh trên PDF."""
    file_path = _get_file_path(req.file_id)
    engine = ActionEngine()
    result = await engine.execute(file_path, "FIX_HAIRLINES", {
        "threshold_pt": req.threshold_pt,
        "replace_pt": req.replace_pt,
    })
    return {
        "success": result.success,
        "output_filename": Path(result.output_path).name if result.output_path else None,
        "log": [{"action_id": l.action_id, "status": l.status, "message": l.message, "duration_ms": l.duration_ms} for l in result.log],
        "error": result.error,
    }


# ══════════════════════════════════════════════════════════════
#  INK MANAGER
# ══════════════════════════════════════════════════════════════

@router.get("/preflight/inks/{file_id}", response_model=InksResponse)
async def list_inks(file_id: str):
    """Liệt kê toàn bộ kênh mực trong PDF."""
    file_path = _get_file_path(file_id)
    from app.core.ink_manager import InkManagerEngine
    engine = InkManagerEngine()
    try:
        # PREFLIGHT (audit 2026-08-10 §OP.5): inventory đi toàn bộ Resources/
        # Form XObject của tài liệu; không được chặn event loop uvicorn.
        return {"inks": await asyncio.to_thread(engine.list_inks, file_path)}
    except Exception as e:
        raise_http(e, "Không liệt kê được kênh mực")


@router.post("/preflight/convert-spot", response_model=FixFileResponse)
async def convert_spot(req: ConvertSpotRequest):
    """Chuyển Spot Color → CMYK."""
    file_path = _get_file_path(req.file_id)
    from app.core.ink_manager import InkManagerEngine
    engine = InkManagerEngine()
    try:
        output = await engine.convert_spot_to_cmyk(file_path, req.spot_name)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        from app.core.engine_support import InternalEngineUnsupported

        if isinstance(e, InternalEngineUnsupported):
            raise HTTPException(status_code=422, detail=str(e)) from e
        raise_http(e, "Chuyển Spot Color sang CMYK thất bại")


# ══════════════════════════════════════════════════════════════
#  TRAP / OVERPRINT
# ══════════════════════════════════════════════════════════════

@router.post("/preflight/set-overprint", response_model=FixFileWithLogResponse)
async def set_overprint(req: FixRequest):
    """Đặt overprint cho text/nét đen."""
    file_path = _get_file_path(req.file_id)
    engine = ActionEngine()
    result = await engine.execute(file_path, "SET_BLACK_OVERPRINT", req.params or {})
    return {
        "success": result.success,
        "output_filename": Path(result.output_path).name if result.output_path else None,
        "log": [{"action_id": l.action_id, "status": l.status, "message": l.message, "duration_ms": l.duration_ms} for l in result.log],
        "error": result.error,
    }


# ══════════════════════════════════════════════════════════════
#  PDF/X EXPORT
# ══════════════════════════════════════════════════════════════

@router.get("/preflight/check-pdfx/{file_id}/{standard}", response_model=PdfxComplianceResponse)
async def check_pdfx_compliance(file_id: str, standard: PdfxStandard):
    """Kiểm tra compliance PDF/X."""
    file_path = _get_file_path(file_id)
    from app.core.pdfx_export import PdfxExportEngine
    engine = PdfxExportEngine()
    try:
        return engine.check_compliance(file_path, standard)
    except Exception as e:
        raise_http(e, "Kiểm tra compliance PDF/X thất bại")


@router.post("/preflight/export-pdfx", response_model=ExportPdfxResponse)
async def export_pdfx(req: ExportPdfxRequest):
    """Xuất file chuẩn PDF/X."""
    file_path = _get_file_path(req.file_id)
    from app.core.pdfx_export import PdfxExportEngine
    from app.core.engine_support import (
        InternalEngineUnsupported,
        unsupported_message,
    )
    engine = PdfxExportEngine()
    try:
        output = await engine.export_pdfx(file_path, req.standard)
        # Cảnh báo phải đi cùng file: đường object-level có thể đã ĐẶT TrimBox
        # thay người dùng để đạt chuẩn, và nếu file có bleed thì TrimBox đó sai.
        # Im lặng ở đây là để họ gửi nhà in một file bị xén nhầm.
        return {
            "success": True,
            "output_filename": Path(output).name,
            "warnings": list(getattr(engine, "last_warnings", None) or []),
            "engine": getattr(engine, "last_engine", None),
        }
    except InternalEngineUnsupported as e:
        # GS-SUNSET (audit 2026-07-28 §3.2): giới hạn file là 422, không phải
        # lỗi server. UI hiển thị nguyên hướng xử lý an toàn cho người dùng.
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        # Log full traceback ở server; UI chỉ nhận ngữ cảnh tác vụ.
        import logging
        logging.getLogger(__name__).exception("PDF/X export failed")
        raise HTTPException(status_code=500, detail=f"Xuất PDF/X thất bại: {e}")


# ══════════════════════════════════════════════════════════════
#  CONVERT COLORS (RGB→CMYK, Gray→K, Spot→CMYK)
# ══════════════════════════════════════════════════════════════



# Map UI key → bundle filename; resolve_cmyk_profile_path() is preferred (bundle + OS).
@router.post(
    "/preflight/convert-colors/preview",
    response_model=ConvertColorsPreviewResponse,
)
async def preview_convert_colors(req: ConvertColorsPreviewRequest):
    """Phân tích một trang trong thư mục tạm; không tạo file tải xuống."""

    from app.core.color_conversion_preview import (
        ColorConversionPreviewError,
        create_color_conversion_preview,
    )

    file_path = _get_file_path(req.file_id)
    try:
        return await create_color_conversion_preview(
            file_path,
            page=req.page,
            conversions=list(req.conversions),
            icc_profile=req.icc_profile,
            rendering_intent=req.rendering_intent,
            preserve_black=req.preserve_black,
            black_point_compensation=req.black_point_compensation,
            gamut_mapping=req.gamut_mapping,
            adjustment_stage=req.adjustment_stage,
            brightness_lstar=req.brightness_lstar,
            contrast_percent=req.contrast_percent,
            vibrance_percent=req.vibrance_percent,
            preview_policy=req.preview_policy,
            dpi=req.dpi,
            request_id=req.request_id,
        )
    except ColorConversionPreviewError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("convert-colors preview failed")
        raise HTTPException(
            status_code=500,
            detail="Không thể phân tích bản CMYK. Hãy thử lại với trang khác.",
        ) from exc


@router.post("/preflight/convert-colors", response_model=FixFileWithLogResponse)
async def convert_colors(req: ConvertColorsRequest):
    """Chuyển đổi không gian màu toàn bộ file PDF."""
    import time
    file_path = _get_file_path(req.file_id)
    resolved_cmyk_profile: str | None = None
    if "rgb_to_cmyk" in req.conversions:
        from app.core import icc_profiles

        resolved_cmyk_profile = icc_profiles.resolve_cmyk_profile_path(
            req.icc_profile
        )
        if not resolved_cmyk_profile:
            # COLOR (audit 2026-08-20 §COLOR.08/.12): profile người dùng chọn không
            # được âm thầm đổi sang FOGRA39; preview và OutputIntent sẽ nói dối.
            if req.icc_profile == "auto":
                raise HTTPException(
                    status_code=503,
                    detail="Không tìm thấy hồ sơ CMYK mặc định FOGRA39.",
                )
            raise HTTPException(
                status_code=422,
                detail=f"Hồ sơ màu '{req.icc_profile}' chưa được cài trên máy.",
            )
    log = []
    current_path = file_path
    # File trung gian giữa các bước conversion (output bước trước → input bước sau).
    # Chỉ dọn file TRUNG GIAN do chính vòng lặp sinh ra, KHÔNG bao giờ xóa file gốc.
    prev_intermediate: str | None = None

    def _cleanup_intermediate(path: str | None) -> None:
        if path and path != file_path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass

    for conv in req.conversions:
        t0 = time.time()
        try:
            if conv == "spot_to_cmyk":
                from app.core.ink_manager import InkManagerEngine
                engine = InkManagerEngine()
                # COLOR (audit 2026-08-21 §COLOR.33): alternate Lab của màu
                # pha phải quy về đúng profile CMYK đã chọn cho bước RGB.
                # Dùng profile mặc định ở đây sẽ tạo numerics FOGRA39 bên
                # trong artifact đang khai SWOP/GRACoL.
                output = await engine.convert_spot_to_cmyk(
                    current_path, None, cmyk_profile=resolved_cmyk_profile
                )
                _cleanup_intermediate(prev_intermediate)
                prev_intermediate = output
                current_path = output
                ms = round((time.time() - t0) * 1000)
                log.append({"action_id": conv, "status": "success", "message": "Spot → CMYK", "duration_ms": ms})

            elif conv in ("rgb_to_cmyk", "gray_to_cmyk"):
                import uuid, asyncio

                # GS-SUNSET (audit 2026-08-08 §GS.1): chỉ sửa đúng object cần sửa
                # và GIỮ SPOT. Nếu engine nội bộ không chứng minh được kết quả thì
                # dừng ngay; không dựng lại cả tài liệu bằng engine ngoài.
                native_out: str | None = None
                try:
                    from app.core import icc_profiles, pdf_actions_native

                    native_out = str(
                        Path(settings.RESULTS_DIR) / "preflight_output"
                        / f"cc_{conv}_{Path(current_path).stem}_{uuid.uuid4().hex[:6]}.pdf"
                    )
                    Path(native_out).parent.mkdir(parents=True, exist_ok=True)
                    if conv == "rgb_to_cmyk":
                        # COLOR (audit 2026-08-21): các thanh tinh chỉnh trên bản
                        # CMYK là phép đồng nhất khi bằng 0. Chỉ gửi kwargs khác 0 để recipe
                        # và sidecar cũ vẫn chạy được trong lúc core được nâng.
                        adjustment_options = {
                            "brightness_lstar": req.brightness_lstar,
                            "contrast_percent": req.contrast_percent,
                            "vibrance_percent": req.vibrance_percent,
                        }
                        adjustment_options = {
                            key: value
                            for key, value in adjustment_options.items()
                            if value != 0
                        }
                        native = await asyncio.to_thread(
                            pdf_actions_native.convert_to_cmyk,
                            current_path,
                            native_out,
                            resolved_cmyk_profile,
                            icc_profiles.resolve_srgb_profile_path(),
                            rendering_intent=req.rendering_intent,
                            preserve_black=req.preserve_black,
                            black_point_compensation=req.black_point_compensation,
                            gamut_mapping=req.gamut_mapping,
                            adjustment_stage=req.adjustment_stage,
                            **adjustment_options,
                        )
                    else:
                        native = await asyncio.to_thread(
                            pdf_actions_native.convert_to_grayscale,
                            current_path,
                            native_out,
                        )
                except Exception as ne:  # noqa: BLE001
                    _cleanup_intermediate(native_out)
                    logger.warning("convert-colors: engine nội bộ lỗi, dừng an toàn: %s", ne)
                    from app.core.engine_support import (
                        InternalEngineUnsupported,
                        unsupported_message,
                    )

                    raise InternalEngineUnsupported(
                        unsupported_message("Chuyển đổi không gian màu")
                    ) from ne

                if native is not None and native.get("supported"):
                    _cleanup_intermediate(prev_intermediate)
                    prev_intermediate = native_out
                    current_path = native_out
                    ms = round((time.time() - t0) * 1000)
                    label = "RGB → CMYK" if conv == "rgb_to_cmyk" else "Chuyển sang Grayscale (đen trắng)"
                    success_message = f"{label} (pikepdf, giữ spot)"
                    native_warnings = native.get("warnings", []) if isinstance(native, dict) else []
                    if isinstance(native_warnings, list):
                        public_warnings = [
                            re.sub(
                                r"(?i)(?:[a-z]:[\\/]|\\\\)[^;\r\n]*",
                                "[đường dẫn đã ẩn]",
                                item.strip().replace("\r", " ").replace("\n", " "),
                            )[:240]
                            for item in native_warnings
                            if isinstance(item, str) and item.strip()
                        ][:3]
                        if public_warnings:
                            success_message += " Cảnh báo: " + "; ".join(public_warnings)
                    log.append({
                        "action_id": conv, "status": "success",
                        "message": success_message, "duration_ms": ms,
                    })
                    continue
                if native is not None:
                    logger.info(
                        "convert-colors: engine nội bộ không xử lý chắc chắn được (%s)",
                        "; ".join(native.get("blockers", [])),
                    )
                    # COLOR (audit 2026-08-20 §COLOR.04): chỉ đưa mã blocker
                    # nghiệp vụ đã được engine sinh ra vào log; không để path,
                    # stacktrace hoặc dữ liệu PDF lọt ra response của desktop.
                    raw_blockers = native.get("blockers", [])
                    if not isinstance(raw_blockers, list):
                        raw_blockers = []
                    public_blockers = [
                        re.sub(
                            r"(?i)(?:[a-z]:[\\/]|\\\\)[^;\r\n]*",
                            "[đường dẫn đã ẩn]",
                            item.strip().replace("\r", " ").replace("\n", " "),
                        )[:240]
                        for item in raw_blockers
                        if isinstance(item, str) and item.strip()
                    ][:3]
                _cleanup_intermediate(native_out)
                from app.core.engine_support import (
                    InternalEngineUnsupported,
                    unsupported_message,
                )

                label = "RGB → CMYK" if conv == "rgb_to_cmyk" else "Chuyển sang Grayscale"
                detail = (
                    " Chi tiết hậu kiểm: " + "; ".join(public_blockers) + "."
                    if native is not None and public_blockers
                    else ""
                )
                raise InternalEngineUnsupported(unsupported_message(label) + detail)

        except Exception as e:
            # GS-SUNSET (audit 2026-08-08 §GS.1): pipeline thất bại không được
            # để lại output trung gian hoặc tiếp tục trên một file nửa hoàn tất.
            _cleanup_intermediate(prev_intermediate)
            prev_intermediate = None
            current_path = file_path
            ms = round((time.time() - t0) * 1000)
            log.append({"action_id": conv, "status": "error", "message": str(e), "duration_ms": ms})
            break

    all_ok = all(l["status"] == "success" for l in log)
    error_message = None
    if not all_ok:
        error_message = next(
            (
                entry.get("message")
                for entry in reversed(log)
                if entry.get("status") != "success" and entry.get("message")
            ),
            "Một số bước thất bại",
        )
    return {
        "success": all_ok,
        "output_filename": Path(current_path).name if all_ok else None,
        "log": log,
        "error": error_message,
    }


@router.get("/preflight/icc-profiles", response_model=IccProfilesResponse)
async def list_icc_profiles():
    """Danh sách ICC output (soft-proof / convert) — bundle FOGRA39 + OS."""
    from app.core.icc_profiles import list_output_profiles
    profiles = list_output_profiles()
    return {
        "profiles": [
            {
                "id": p["id"],
                "name": p["name"],
                "description": p["description"],
                "available": p["available"],
            }
            for p in profiles
        ]
    }


@router.post("/preflight/softproof")
async def render_softproof(req: SoftProofRequest):
    from app.core.softproof import SoftProofEngine
    engine = SoftProofEngine()
    pdf_path = _get_file_path(req.file_id)
    try:
        result = await engine.render_softproof(
            pdf_path=pdf_path,
            page_num=req.page,
            profile_id=req.profile_id or "fogra39",
            intent=req.intent,
            show_gamut_warning=req.show_gamut_warning,
            dpi=req.dpi,
            simulate_overprint=req.simulate_overprint,
            output_preview_filter=req.output_preview_filter,
            simulate_paper_color=req.simulate_paper_color,
            simulate_black_ink=req.simulate_black_ink,
            page_background_rgb=req.page_background_rgb,
        )
        return result
    except Exception as e:
        logger.exception("Lỗi khi render Soft-Proof")
        return {"success": False, "error": str(e)}


@router.post("/preflight/viewer-accurate")
async def render_viewer_accurate(req: ViewerAccurateRenderRequest, request: Request):
    """Dựng PNG color-managed cho một trang Viewer từ đường dẫn local đã kiểm tra."""
    from app.core.ppe_viewer_session import (
        ViewerBackgroundSessionDeferred,
        ViewerSessionSuperseded,
        resolve_viewer_session_identity,
        viewer_session_identity_is_current,
        viewer_session_manager,
    )
    from app.core.print_engine.facade import PpeRequestSuperseded
    from app.core.softproof import SoftProofEngine
    from app.core.viewer_accurate_cache import (
        AccurateRenderInterest,
        AccurateRequestSuperseded,
        RenderedAccuratePng,
        build_accurate_cache_key,
        build_accurate_request_scope,
        current_accurate_render_is_interested,
        get_or_render_accurate_png,
    )

    pdf_path = _validate_local_pdf_path(req.file_path)
    try:
        profile_id = req.profile_id or "fogra39"
        clip = req.raster_clip
        session_owner_id = req.session_owner_id or req.owner_id
        # PERF/COLOR (audit 2026-08-09 §L2C): cache key và session phải cùng
        # một snapshot PDF + ICC. Không stat lại riêng rẽ rồi có thể ghi
        # pixel revision mới dưới khóa của revision cũ.
        try:
            source_identity = await asyncio.to_thread(
                resolve_viewer_session_identity,
                pdf_path,
                profile_id,
                req.intent,
            )
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Profile/intent Viewer không hợp lệ: {exc}",
            ) from exc
        # Bind trước khi đọc cache để disk-hit cũng giữ owner; native
        # session vẫn chỉ mở lazy khi thật sự cache-miss.
        await viewer_session_manager.bind_owner(
            source_identity,
            owner_id=session_owner_id,
            purpose=req.purpose,
            owner_generation=req.generation,
        )
        interest = AccurateRenderInterest(
            scope=await asyncio.to_thread(
                build_accurate_request_scope, pdf_path, req.owner_id
            ),
            generation=req.generation,
            purpose=req.purpose,
            request_id=req.request_id,
        )
        cache_key = await asyncio.to_thread(
            build_accurate_cache_key,
            pdf_path,
            page=req.page,
            dpi=req.dpi,
            profile_id=profile_id,
            intent=req.intent,
            clip=clip,
            output_preview_filter=req.output_preview_filter,
            simulate_paper_color=req.simulate_paper_color,
            simulate_black_ink=req.simulate_black_ink,
            page_background_rgb=req.page_background_rgb,
            source_identity=source_identity,
        )

        async def render_png() -> RenderedAccuratePng:
            try:
                lease = await viewer_session_manager.render_lease(
                    source_identity,
                    owner_id=session_owner_id,
                    purpose=req.purpose,
                    owner_generation=req.generation,
                    # Cache có thể đã đánh dấu renderer "started" trong khi
                    # nó còn xếp hàng sau request cùng PDF. Kiểm lại ngay
                    # trước khi cấp native generation để zoom cũ không render thừa.
                    still_interested=current_accurate_render_is_interested,
                )
            except (ViewerBackgroundSessionDeferred, ViewerSessionSuperseded) as exc:
                raise AccurateRequestSuperseded(str(exc)) from exc
            try:
                async with lease:
                    result = await SoftProofEngine().render_softproof(
                        pdf_path=pdf_path,
                        page_num=req.page,
                        profile_id=profile_id,
                        intent=req.intent,
                        show_gamut_warning=False,
                        dpi=req.dpi,
                        output_format="png",
                        clip=clip,
                        # PERF (audit 2026-08-08 §RENDER.3): frontend đã giữ PDFium
                        # display; endpoint này không dựng fallback full-page rồi mới loại.
                        accurate_only=True,
                        ppe_session=lease.session,
                        # Native owner/generation là nội bộ của shared session.
                        # Hai tab cùng gửi generation=1 không được hủy nhầm nhau.
                        owner_id=lease.native_owner_id,
                        request_generation=lease.native_generation,
                        # COLOR (feedback 2026-08-10 §VIEWER.C1): Viewer thường
                        # giống Acrobat Page Display; overprint chỉ bật trong
                        # Output Preview/Soft-proof khi người dùng yêu cầu.
                        simulate_overprint=False,
                        output_preview_filter=req.output_preview_filter,
                        simulate_paper_color=req.simulate_paper_color,
                        simulate_black_ink=req.simulate_black_ink,
                        page_background_rgb=req.page_background_rgb,
                    )
                    if not await asyncio.to_thread(
                        viewer_session_identity_is_current,
                        source_identity,
                    ):
                        raise AccurateRequestSuperseded(
                            "PDF hoặc ICC đã thay đổi trong lúc dựng trang"
                        )
            except PpeRequestSuperseded as exc:
                raise AccurateRequestSuperseded(str(exc)) from exc
            if not result.get("success") or not result.get("softproof_b64"):
                raise RuntimeError(result.get("error") or "Bộ dựng màu không trả ảnh.")
            if result.get("accuracy") != "rip_softproof":
                # COLOR (audit 2026-08-07 §GV.3): đường PDFium+LCMS đã mất thông tin
                # CMYK/spot trước khi đổi profile, không được gắn nhãn "CMYK chính xác".
                raise RuntimeError(
                    result.get("warning")
                    or "PPE chưa đủ tin cậy để dựng màu CMYK chính xác cho trang này."
                )
            if result.get("ink_unsound") or result.get("degraded"):
                # COLOR (audit 2026-08-08 §RENDER.4): phòng thủ tại biên cache.
                # Dù engine con gắn nhầm nhãn RIP, ảnh thiếu nội dung/hình học vẫn
                # không được trả về dưới badge CMYK✓ hoặc ghi vào cache accurate.
                raise RuntimeError(
                    result.get("warning")
                    or "Bộ dựng màu chưa giữ đủ nội dung để xác nhận CMYK chính xác."
                )
            if clip is not None and (
                int(result.get("width") or 0) != clip[2]
                or int(result.get("height") or 0) != clip[3]
            ):
                raise RuntimeError("Bộ dựng màu trả sai kích thước viewport clip.")
            # PERF (audit 2026-08-09 §L2C): PNG lớn có thể tạo hàng chục
            # MB base64; decode trên event loop sẽ làm request trang khác khựng.
            image_bytes = await asyncio.to_thread(
                base64.b64decode,
                result["softproof_b64"],
                validate=True,
            )
            if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("Bộ dựng màu không trả đúng PNG lossless.")
            return RenderedAccuratePng(
                data=image_bytes,
                engine=str(result.get("engine") or "unknown"),
                accuracy=str(result.get("accuracy") or "unknown"),
                session_mode=str(
                    (result.get("ppe_session") or {}).get("mode") or "unknown"
                ),
            )

        async def watch_disconnect() -> bool:
            """Theo dõi ngắt kết nối vì ASGI không tự hủy route đang xử lý."""
            try:
                while True:
                    if await request.is_disconnected():
                        return True
                    await asyncio.sleep(0.05)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - phòng thủ adapter ASGI
                logger.debug("Không đọc được trạng thái kết nối Viewer: %s", exc)
                return False

        # PERF (audit 2026-08-08 §RENDER.5): AbortController chỉ đóng kết nối
        # phía client; watcher này hủy waiter backend để job chưa vào PPE rời hàng thật.
        cache_task = asyncio.create_task(
            get_or_render_accurate_png(
                cache_key,
                render_png,
                interest=interest,
            )
        )
        disconnect_task = asyncio.create_task(watch_disconnect())
        try:
            done, _pending = await asyncio.wait(
                {cache_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cache_task not in done and disconnect_task.result():
                cache_task.cancel()
                await asyncio.gather(cache_task, return_exceptions=True)
                raise AccurateRequestSuperseded(
                    f"Request {req.request_id} đã bị hủy vì Viewer ngắt kết nối"
                )
            cached = await cache_task
        finally:
            disconnect_task.cancel()
            if not cache_task.done():
                cache_task.cancel()
            await asyncio.gather(cache_task, disconnect_task, return_exceptions=True)
        # Bao gồm cả disk-hit: không trả/cache artifact của snapshot đã
        # hết hiệu lực sau save-over PDF hoặc thay ICC.
        if not await asyncio.to_thread(
            viewer_session_identity_is_current,
            source_identity,
        ):
            raise AccurateRequestSuperseded(
                "PDF hoặc ICC đã thay đổi trước khi trả ảnh Viewer"
            )
        response_headers = {
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-PrynX-Color-Engine": cached.rendered.engine,
            "X-PrynX-Color-Accuracy": cached.rendered.accuracy,
            "X-PrynX-Viewer-Cache": cached.status,
            "X-PrynX-Viewer-Generation": str(req.generation),
            "X-PrynX-PPE-Session": cached.rendered.session_mode,
        }
        response_headers["X-PrynX-Request-ID"] = req.request_id
        return Response(
            content=cached.rendered.data,
            media_type="image/png",
            headers=response_headers,
        )
    except (AccurateRequestSuperseded, ViewerSessionSuperseded) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Lỗi khi dựng màu chính xác cho Viewer")
        raise HTTPException(
            status_code=500,
            detail=f"Không thể dựng màu chính xác cho trang {req.page}: {exc}",
        ) from exc


@router.delete("/preflight/viewer-accurate/session")
async def release_viewer_accurate_session(
    owner_id: str = Query(min_length=1, max_length=128),
    generation: int | None = Query(default=None, ge=0),
):
    """Nhả cache native đúng owner khi tab/file Viewer đóng hoặc đổi epoch."""
    from app.core.ppe_viewer_session import viewer_session_manager

    released = await viewer_session_manager.release_owner(
        owner_id,
        through_generation=generation,
    )
    return {"success": True, "released": released}




def _page_has_used_overprint(pdf_path: str, page: int) -> bool | None:
    """Đọc ExtGState *được dùng thật* trên page/Form, không suy từ pixel diff.

    Chỉ thấy `/OP` trong Resources chưa đủ vì resource có thể không được gọi. Hàm
    lần theo operator `gs` và Form `Do`, đồng thời chống vòng tham chiếu XObject.
    """
    try:
        with pikepdf.Pdf.open(pdf_path) as doc:
            page_obj = doc.pages[page - 1]
            visited: set[tuple[int, int] | tuple[str, int]] = set()

            def resolve(value):
                resolver = getattr(value, "resolve", None)
                return resolver() if callable(resolver) else value

            def object_key(value) -> tuple[int, int] | tuple[str, int]:
                objgen = getattr(value, "objgen", None)
                if isinstance(objgen, tuple) and objgen != (0, 0):
                    return objgen
                return ("direct", id(value))

            def inspect_stream(container, inherited_resources=None) -> bool:
                resolved = resolve(container)
                key = object_key(resolved)
                if key in visited:
                    return False
                visited.add(key)
                resources = resolve(resolved.get("/Resources") or inherited_resources or {})
                extgstates = resolve(resources.get("/ExtGState") or {})
                xobjects = resolve(resources.get("/XObject") or {})
                try:
                    instructions = pikepdf.parse_content_stream(container)
                except Exception:
                    instructions = []
                for operands, operator in instructions:
                    op = str(operator)
                    if op == "gs" and operands:
                        state_ref = extgstates.get(str(operands[0]))
                        if state_ref is not None:
                            state = resolve(state_ref)
                            if bool(state.get("/OP", False)) or bool(state.get("/op", False)):
                                return True
                    elif op == "Do" and operands:
                        xobject_ref = xobjects.get(str(operands[0]))
                        if xobject_ref is None:
                            continue
                        xobject = resolve(xobject_ref)
                        if str(xobject.get("/Subtype", "")) != "/Form":
                            continue
                        if inspect_stream(xobject, resources):
                            return True
                return False

            return inspect_stream(page_obj, page_obj.get("/Resources"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Không đọc được metadata Overprint trang %s: %s", page, exc)
        return None


def _render_ppe_overprint_pair(
    pdf_path: str,
    page: int,
    dpi: int,
    profile_id: str,
    intent: str,
) -> tuple[dict, dict]:
    """Dựng cùng một trang ở chế độ knockout và overprint bằng PPE.

    Hai ảnh phải đi qua cùng engine/profile; trộn PDFium với PPE sẽ tạo diff màu
    giả trên cả trang. Kết quả thiếu object bị từ chối thay vì báo false-negative.
    """
    intent_code = {
        "perceptual": 0,
        "relative": 1,
        "saturation": 2,
        "absolute": 3,
    }[intent]
    common = {
        "dpi": dpi,
        "cmyk_profile_id": profile_id,
        "render_intent": intent_code,
    }
    knockout = ppe_softproof(
        pdf_path, page, simulate_overprint=False, **common,
    )
    simulated = ppe_softproof(
        pdf_path, page, simulate_overprint=True, **common,
    )
    for label, result in (("knockout", knockout), ("overprint", simulated)):
        if result.get("ink_unsound"):
            raise RuntimeError(f"PPE chưa dựng đủ nội dung ở ảnh {label}")
        width = int(result.get("width") or 0)
        height = int(result.get("height") or 0)
        rgb = bytes(result.get("rgb") or b"")
        if width <= 0 or height <= 0 or len(rgb) != width * height * 3:
            raise RuntimeError(f"PPE trả ảnh {label} không hợp lệ")
    if knockout["width"] != simulated["width"] or knockout["height"] != simulated["height"]:
        raise RuntimeError("Hai trạng thái PPE không cùng kích thước")
    return knockout, simulated


@router.post("/preflight/overprint-preview", response_model=OverprintPreviewResponse)
async def render_overprint_preview(req: OverprintPreviewRequest):
    """
    Render a page with Overprint Simulation ON, and produce a diff overlay
    highlighting areas that change when overprint is applied.
    """
    from io import BytesIO

    pdf_path = _get_file_path(req.file_id)

    try:
        with pikepdf.Pdf.open(pdf_path) as doc:
            if req.page < 1 or req.page > len(doc.pages):
                raise HTTPException(status_code=400, detail=f"Trang {req.page} không tồn tại")

        page_has_overprint = await asyncio.to_thread(
            _page_has_used_overprint, pdf_path, req.page,
        )
        try:
            knockout, simulated = await asyncio.to_thread(
                _render_ppe_overprint_pair,
                pdf_path,
                req.page,
                req.dpi,
                req.profile_id,
                req.intent,
            )
        except Exception as exc:
            # GS-SUNSET (audit 2026-07-27 §4.1): fail-loud thay vì trả hai ảnh
            # giống nhau rồi kết luận sai rằng file không có vùng overprint.
            logger.warning("PPE Overprint Preview không đủ tin cậy: %s", exc)
            return {
                "success": False,
                "error": f"PPE chưa dựng được Overprint Preview tin cậy: {exc}",
                "has_differences": False,
                "engine": "ppe",
            }

        from PIL import Image
        import numpy as np

        w = int(knockout["width"])
        h = int(knockout["height"])
        img_normal = np.frombuffer(bytes(knockout["rgb"]), dtype=np.uint8).reshape(h, w, 3)
        img_overprint = np.frombuffer(bytes(simulated["rgb"]), dtype=np.uint8).reshape(h, w, 3)
        diff = np.abs(img_normal.astype(np.int16) - img_overprint.astype(np.int16))
        diff_magnitude = np.max(diff, axis=2)
        mask = diff_magnitude > 10
        diff_count = int(np.sum(mask))

        overlay = np.zeros((h, w, 4), dtype=np.uint8)
        overlay[mask] = [255, 50, 0, 180]
        buf_diff = BytesIO()
        Image.fromarray(overlay).save(buf_diff, format="PNG")
        buf_op = BytesIO()
        # PREFLIGHT (audit 2026-08-10 §OP.9): ảnh mô phỏng là nguồn màu để đọc,
        # không phải thumbnail; giữ PNG lossless giống Viewer accurate.
        Image.fromarray(img_overprint).save(buf_op, format="PNG")

        return {
            "success": True,
            "has_differences": diff_count > 0,
            "diff_pixel_count": diff_count,
            "diff_overlay": f"data:image/png;base64,{base64.b64encode(buf_diff.getvalue()).decode()}",
            "overprint_image": f"data:image/png;base64,{base64.b64encode(buf_op.getvalue()).decode()}",
            "page_has_overprint": page_has_overprint,
            "profile_id": req.profile_id,
            "intent": req.intent,
            "width": w,
            "height": h,
            "engine": "ppe",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Lỗi khi render Overprint Preview")
        return {"success": False, "error": str(e)}
