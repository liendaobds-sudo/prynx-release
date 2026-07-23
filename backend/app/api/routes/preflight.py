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

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, Request
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
from typing import List, Optional, Any
import pikepdf

from app.core.preflight_engine import PreflightEngine, PreflightReport, PreflightIssue
from app.core.separations import SeparationEngine
from app.core.action_engine import ActionEngine, AVAILABLE_ACTIONS
from app.utils.file_handler import save_upload_file
from app.utils.subprocess_utils import run_hidden
from app.utils.errors import raise_http
from app.config import settings
from app.core.license_guard import require_license, require_feature
from app.database import SessionLocal
from app.models.job import UploadedFile

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_feature("prepress.preflight"))])


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

class InspectByIdRequest(BaseModel):
    file_id: str
    rules: Optional[List[str]] = None
    tac_threshold: Optional[int] = 300


class PreflightIssueResponse(BaseModel):
    rule_id: str
    severity: str
    page: Optional[int]
    object_ref: str
    description: str
    auto_fixable: bool
    bbox: Optional[List[float]] = None
    bboxes: Optional[List[List[float]]] = None


class PreflightReportResponse(BaseModel):
    file_name: str
    total_pages: int
    issues: List[PreflightIssueResponse]
    summary: dict
    color_summary: dict
    font_summary: dict
    image_summary: dict


class FixRequest(BaseModel):
    file_id: str
    action_id: str
    params: Optional[dict] = None


class PipelineAction(BaseModel):
    id: str
    params: Optional[dict] = None


class PipelineRequest(BaseModel):
    file_id: str
    actions: List[PipelineAction]


class ChannelReportResponse(BaseModel):
    """Báo cáo bổ sung cho action sinh dữ liệu ΔE (vd REMOVE_CHANNELS).

    Cho phép UI hiển thị cảnh báo vùng ngoài gamut và thống kê ΔE (Req 4.1, 4.2).
    Mọi trường đều optional để các action không sinh report vẫn hoạt động.
    """
    max_delta_e: Optional[float] = None
    avg_delta_e: Optional[float] = None
    out_of_gamut_count: Optional[int] = None
    total_colors: Optional[int] = None
    warnings: List[str] = []
    identical_to_original: Optional[bool] = None


class ActionLogResponse(BaseModel):
    action_id: str
    status: str
    message: str
    duration_ms: int
    # Report bổ sung của riêng step này (None nếu action không sinh report).
    report: Optional[ChannelReportResponse] = None


class FixResponse(BaseModel):
    success: bool
    output_filename: Optional[str] = None
    log: List[ActionLogResponse]
    error: Optional[str] = None
    # Report tổng hợp (lấy từ step gần nhất có report) để UI hiển thị cảnh báo
    # ngoài gamut và thống kê ΔE mà không phải dò trong log (Req 4.1, 4.2).
    report: Optional[ChannelReportResponse] = None


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
        report = engine.run(pdf_path, rules=request.rules, tac_threshold=tac_threshold)
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
        report = engine.run(file_path)
        return _report_to_response(report)
    except Exception as e:
        logger.exception("Preflight inspect-upload failed")
        raise HTTPException(status_code=500, detail=f"Lỗi kiểm tra ({type(e).__name__})")


@router.post("/preflight/fix", response_model=FixResponse)
async def fix_pdf(request: FixRequest):
    """
    Thực thi một Action sửa lỗi trên file PDF.
    Trả về thông tin file đã sửa.
    """
    pdf_path, original_name = _get_file_info(request.file_id)

    try:
        engine = ActionEngine()
        result = await engine.execute(pdf_path, request.action_id, request.params, original_name=original_name)

        return _action_result_to_fix_response(result)
    except Exception as e:
        logger.exception("Preflight fix failed")
        raise HTTPException(status_code=500, detail=f"Lỗi sửa file ({type(e).__name__})")


@router.post("/preflight/pipeline", response_model=FixResponse)
async def pipeline_fix(request: PipelineRequest):
    """
    Chạy chuỗi Actions tuần tự (Pipeline).
    Ví dụ: CONVERT_TO_CMYK → FLATTEN_TRANSPARENCY → EMBED_FONTS
    """
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


class PdfObjectResponse(BaseModel):
    id: str
    type: str  # 'text', 'image', 'drawing'
    bbox: List[float]  # [x0, y0, x1, y1]
    content: Optional[str] = None
    xref: Optional[int] = None

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
        pdf_doc = pdfium.PdfDocument(uploaded.file_path)
        if page < 1 or page > len(pdf_doc):
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
        pdf_doc = pdfium.PdfDocument(file_path)
        if page < 1 or page > len(pdf_doc):
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

@router.get("/preflight/objects/{file_id}/{page}")
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


class ObjectToDelete(BaseModel):
    type: str
    bbox: List[float]
    xref: Optional[int] = None


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

class DeleteObjectRequest(BaseModel):
    file_id: str
    page: int
    preview_dpi: float = 200.0
    preview_max_pixels: Optional[int] = None
    objects: List[ObjectToDelete]

@router.post("/preflight/delete-object")
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


@router.post("/preflight/preview-hide")
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

@router.get("/preflight/layers/{file_id}")
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

class PreviewLayersRequest(BaseModel):
    file_id: str
    page: int
    hidden_layer_ids: List[int] = []

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

class RenameLayerRequest(BaseModel):
    file_id: str
    layer_id: int
    new_name: str

@router.post("/preflight/layers/rename")
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


class ToggleLockRequest(BaseModel):
    file_id: str
    layer_id: int
    locked: bool

@router.post("/preflight/layers/toggle-lock")
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


class SetVisibilityRequest(BaseModel):
    file_id: str
    layer_id: int
    visible: bool

@router.post("/preflight/layers/set-visibility")
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


class DeleteLayerRequest(BaseModel):
    file_id: str
    layer_id: int

@router.post("/preflight/layers/delete")
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


class ReorderLayersRequest(BaseModel):
    file_id: str
    new_order: List[int]

@router.post("/preflight/layers/reorder")
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


class FlattenLayersRequest(BaseModel):
    file_id: str

@router.post("/preflight/layers/flatten")
async def flatten_layers(req: FlattenLayersRequest):
    """Flatten visible layers — gộp tất cả layer hiện tại thành 1 (không có OCG)."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        output = engine.flatten_visible(pdf_path)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi flatten layers")

@router.get("/preflight/separations/{file_id}/{page}")
async def get_separations(file_id: str, page: int, dpi: int = 150, use_gs: bool = False):
    """
    Trích xuất các bản kẽm (Separations) của trang PDF.
    Mặc định dùng pikepdf (nhanh, CMYK process).
    Thêm ?use_gs=true để dùng Ghostscript (chậm, hỗ trợ Spot Color/Pantone).
    """
    pdf_path = _get_file_path(file_id)

    try:
        engine = SeparationEngine()
        result = await engine.extract_separations(pdf_path, page, dpi, use_ghostscript=use_gs)
        return result
    except Exception as e:
        raise_http(e, "Lỗi khi tạo Separations")


class SeparationsPathRequest(BaseModel):
    file_path: str
    page: int = 1
    dpi: int = 150
    use_gs: bool = False

@router.post("/preflight/separations-by-path")
async def get_separations_by_path(req: SeparationsPathRequest):
    """
    Desktop-only: Trích xuất kẽm trực tiếp từ đường dẫn file trên ổ đĩa.
    Không cần upload — backend đọc file tại chỗ. Tức thì.
    """
    safe_path = _validate_local_pdf_path(req.file_path)

    try:
        engine = SeparationEngine()
        result = await engine.extract_separations(safe_path, req.page, req.dpi, use_ghostscript=req.use_gs)
        return result
    except Exception as e:
        raise_http(e, "Lỗi khi tạo Separations (by path)")


# ══════════════════════════════════════════════════════════════
#  PAGE BOXES (Set Page Boxes)
# ══════════════════════════════════════════════════════════════

@router.get("/preflight/page-boxes/{file_id}/{page}")
async def get_page_boxes(file_id: str, page: int):
    """Lấy thông tin 5 box của 1 trang."""
    file_path = _get_file_path(file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        return engine.get_boxes(file_path, page)
    except Exception as e:
        raise_http(e, "Không lấy được thông tin page boxes")


class SetPageBoxesRequest(BaseModel):
    file_id: str
    box_type: str  # mediabox|cropbox|trimbox|bleedbox|artbox
    rect_mm: dict  # {x0, y0, x1, y1}
    pages: Optional[List[int]] = None  # None = all


@router.post("/preflight/set-page-boxes")
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


class CropRegionsRequest(BaseModel):
    """Crop nhiều vùng trên 1 trang → PDF nhiều trang (mỗi vùng = 1 page)."""
    file_id: str
    page: int  # 1-indexed
    rects_mm: List[dict]  # [{x0,y0,x1,y1}, ...] mm theo CropBox đang hiển thị
    keep_other_pages: bool = False  # True = thay trang nguồn bằng N vùng, giữ phần còn lại

    pages: Optional[List[int]] = None  # None = chỉ page; danh sách = áp dụng cùng vùng cho các trang này

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

@router.post("/preflight/crop-regions")
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
        )
        return {
            "success": True,
            "output_filename": Path(output).name,
            "page_count": len(req.rects_mm) * len(req.pages or [req.page]),
        }
    except Exception as e:
        raise_http(e, "Không crop được nhiều vùng")


class AutoTrimRequest(BaseModel):
    file_id: str
    pages: Optional[List[int]] = None
    margin_mm: float = 0


@router.post("/preflight/auto-trim")
async def auto_trim(req: AutoTrimRequest):
    """Xóa lề trắng tự động."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = engine.auto_trim(file_path, req.pages, req.margin_mm)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Không tự động xóa lề trắng được")


class AddBleedRequest(BaseModel):
    file_id: str
    bleed_mm: float = 3
    pages: Optional[List[int]] = None


@router.post("/preflight/add-bleed")
async def add_bleed(req: AddBleedRequest):
    """Tự động set BleedBox = TrimBox + bleed."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = engine.add_bleed_from_trim(file_path, req.bleed_mm, req.pages)
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


@router.post("/preflight/mirror-bleed")
async def mirror_bleed(req: AddBleedRequest, license_info: dict = Depends(require_license)):
    """Tạo bù xén bằng cách LẬT GƯƠNG nội dung mép ra vùng bleed (giữ vector)."""
    file_path = _get_file_path(req.file_id)
    from app.core.page_boxes import PageBoxesEngine
    engine = PageBoxesEngine()
    try:
        output = engine.add_mirror_bleed(file_path, req.bleed_mm, req.pages)
        _safe_watermark_preflight(output, license_info)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Lỗi khi tạo mirror-bleed")


# ══════════════════════════════════════════════════════════════
#  FIX HAIRLINES
# ══════════════════════════════════════════════════════════════

class FixHairlinesRequest(BaseModel):
    file_id: str
    threshold_pt: float = 0.1
    replace_pt: float = 0.25
    pages: Optional[List[int]] = None


@router.post("/preflight/fix-hairlines")
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

@router.get("/preflight/inks/{file_id}")
async def list_inks(file_id: str):
    """Liệt kê toàn bộ kênh mực trong PDF."""
    file_path = _get_file_path(file_id)
    from app.core.ink_manager import InkManagerEngine
    engine = InkManagerEngine()
    try:
        return {"inks": engine.list_inks(file_path)}
    except Exception as e:
        raise_http(e, "Không liệt kê được kênh mực")


class ConvertSpotRequest(BaseModel):
    file_id: str
    spot_name: Optional[str] = None  # None = convert ALL


@router.post("/preflight/convert-spot")
async def convert_spot(req: ConvertSpotRequest):
    """Chuyển Spot Color → CMYK."""
    file_path = _get_file_path(req.file_id)
    from app.core.ink_manager import InkManagerEngine
    engine = InkManagerEngine()
    try:
        output = await engine.convert_spot_to_cmyk(file_path, req.spot_name)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise_http(e, "Chuyển Spot Color sang CMYK thất bại")


# ══════════════════════════════════════════════════════════════
#  TRAP / OVERPRINT
# ══════════════════════════════════════════════════════════════

@router.post("/preflight/set-overprint")
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

@router.get("/preflight/check-pdfx/{file_id}/{standard}")
async def check_pdfx_compliance(file_id: str, standard: str):
    """Kiểm tra compliance PDF/X."""
    file_path = _get_file_path(file_id)
    from app.core.pdfx_export import PdfxExportEngine
    engine = PdfxExportEngine()
    try:
        return engine.check_compliance(file_path, standard)
    except Exception as e:
        raise_http(e, "Kiểm tra compliance PDF/X thất bại")


class ExportPdfxRequest(BaseModel):
    file_id: str
    standard: str = "x4"  # "x1a" | "x4"


@router.post("/preflight/export-pdfx")
async def export_pdfx(req: ExportPdfxRequest):
    """Xuất file chuẩn PDF/X."""
    file_path = _get_file_path(req.file_id)
    from app.core.pdfx_export import PdfxExportEngine, GhostscriptNotFoundError
    engine = PdfxExportEngine()
    try:
        output = await engine.export_pdfx(file_path, req.standard)
        return {"success": True, "output_filename": Path(output).name}
    except GhostscriptNotFoundError as e:
        # Ghostscript thiếu → báo rõ để user cài / kiểm bản cài, không nuốt thành lỗi mơ hồ.
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        # Trả message THẬT (Ghostscript báo gì) thay vì chỉ tên exception — trước đây
        # nuốt sạch nên không ai chẩn đoán được. Log full traceback ở server để debug.
        import logging
        logging.getLogger(__name__).exception("PDF/X export failed")
        raise HTTPException(status_code=500, detail=f"Xuất PDF/X thất bại: {e}")


# ══════════════════════════════════════════════════════════════
#  CONVERT COLORS (RGB→CMYK, Gray→K, Spot→CMYK)
# ══════════════════════════════════════════════════════════════

class ConvertColorsRequest(BaseModel):
    file_id: str
    conversions: list[str] = ["rgb_to_cmyk"]  # "rgb_to_cmyk" | "gray_to_cmyk" | "spot_to_cmyk"
    icc_profile: str = "auto"  # "auto" | "fogra39" | "swop" | "japan_color"
    rendering_intent: str = "relative"  # "relative" | "perceptual" | "saturation" | "absolute"
    preserve_black: bool = True


# Map lựa chọn ICC ở UI → tên file trong settings.ICC_PROFILE_DIR.
# Hiện chỉ bundle FOGRA39 (+ sRGB nguồn). Thêm profile khác = thả file .icc vào
# thư mục ICC rồi thêm một dòng vào map này (UI cũng cần thêm lựa chọn tương ứng).
ICC_FILE_MAP = {
    "fogra39": "FOGRA39.icc",
}


@router.post("/preflight/convert-colors")
async def convert_colors(req: ConvertColorsRequest):
    """Chuyển đổi không gian màu toàn bộ file PDF."""
    import time
    file_path = _get_file_path(req.file_id)
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
                output = await engine.convert_spot_to_cmyk(current_path, None)
                _cleanup_intermediate(prev_intermediate)
                prev_intermediate = output
                current_path = output
                ms = round((time.time() - t0) * 1000)
                log.append({"action_id": conv, "status": "success", "message": "Spot → CMYK", "duration_ms": ms})

            elif conv in ("rgb_to_cmyk", "gray_to_cmyk"):
                import subprocess, uuid, asyncio
                gs_path = settings.GHOSTSCRIPT_PATH
                # Ghi output vào preflight_output — ĐÚNG nơi /preflight/download phục
                # vụ. (Trước đây ghi cạnh file gốc trong UPLOAD_DIR → download 404.)
                out_dir = Path(settings.RESULTS_DIR) / "preflight_output"
                out_dir.mkdir(parents=True, exist_ok=True)
                output = str(out_dir / f"cc_{conv}_{Path(current_path).stem}_{uuid.uuid4().hex[:6]}.pdf")

                # Pre-pass GIỮ ĐEN 100%K: GS biến RGB(0,0,0) thành rich-black 4 màu.
                # Đổi trước màu RGB-đen-thuần sang DeviceGray đen (→ GS map thành K-only).
                # Chỉ áp cho RGB→CMYK; gray/CMYK-đen vốn đã ra K thuần.
                gs_input = str(current_path)
                prepass_tmp = None
                if conv == "rgb_to_cmyk" and req.preserve_black:
                    from app.core.preserve_black import force_pure_black_to_gray
                    prepass_tmp = str(out_dir / f"pb_{Path(current_path).stem}_{uuid.uuid4().hex[:6]}.pdf")
                    try:
                        await asyncio.to_thread(force_pure_black_to_gray, str(current_path), prepass_tmp)
                        gs_input = prepass_tmp
                    except Exception as pe:
                        logger.warning("Pre-pass giữ đen thất bại (%s) — tiếp tục không pre-pass.", pe)
                        prepass_tmp = None

                intent_map = {"relative": 1, "perceptual": 0, "saturation": 2, "absolute": 3}
                ri = intent_map.get(req.rendering_intent, 1)
                strategy = "CMYK" if conv == "rgb_to_cmyk" else "Gray"

                gs_args = [
                    gs_path, "-dNOSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                    "-sDEVICE=pdfwrite",
                    f"-sOutputFile={output}",
                    "-dPDFSETTINGS=/prepress",
                    f"-sColorConversionStrategy={strategy}",
                    "-dConvertCMYKImagesToProcess=false",
                    f"-dRenderIntent={ri}",
                ]
                # Gắn ICC Profile đích theo lựa chọn người dùng (chỉ cho RGB→CMYK).
                # 'auto' = không ép (giữ profile nhúng / mặc định GS). -dNOSAFER ở trên
                # cho phép GS đọc file ICC bundle (GS 10 mặc định SAFER chặn).
                if conv == "rgb_to_cmyk" and req.icc_profile and req.icc_profile != "auto":
                    icc_file = ICC_FILE_MAP.get(req.icc_profile)
                    if icc_file:
                        icc_path = os.path.join(settings.ICC_PROFILE_DIR, icc_file)
                        if os.path.exists(icc_path):
                            gs_args += [
                                "-sProcessColorModel=DeviceCMYK",
                                f"-sOutputICCProfile={icc_path}",
                                "-dOverrideICC=true",
                            ]
                        else:
                            logger.warning(
                                "ICC profile '%s' không tồn tại (%s) — dùng mặc định GS.",
                                req.icc_profile, icc_path,
                            )
                    else:
                        logger.warning("ICC profile '%s' chưa được hỗ trợ — dùng mặc định GS.", req.icc_profile)

                gs_args.append(gs_input)

                proc = await asyncio.to_thread(run_hidden, gs_args, capture_output=True, timeout=300)
                if prepass_tmp:
                    try:
                        os.remove(prepass_tmp)
                    except OSError:
                        pass
                if proc.returncode != 0:
                    raise Exception(f"Ghostscript failed: {proc.stderr.decode()[:200]}")

                _cleanup_intermediate(prev_intermediate)
                prev_intermediate = output
                current_path = output
                label = "RGB → CMYK" if conv == "rgb_to_cmyk" else "Chuyển sang Grayscale (đen trắng)"
                ms = round((time.time() - t0) * 1000)
                log.append({"action_id": conv, "status": "success", "message": label, "duration_ms": ms})

        except Exception as e:
            ms = round((time.time() - t0) * 1000)
            log.append({"action_id": conv, "status": "error", "message": str(e), "duration_ms": ms})

    all_ok = all(l["status"] == "success" for l in log)
    return {
        "success": all_ok,
        "output_filename": Path(current_path).name if all_ok else None,
        "log": log,
        "error": None if all_ok else "Một số bước thất bại",
    }


class SoftProofRequest(BaseModel):
    file_id: str
    page: int = 1
    profile_id: str
    intent: str = "relative"
    show_gamut_warning: bool = False
    dpi: int = 150

@router.post("/preflight/softproof")
async def render_softproof(req: SoftProofRequest):
    from app.core.softproof import SoftProofEngine
    engine = SoftProofEngine()
    pdf_path = _get_file_path(req.file_id)
    try:
        result = await engine.render_softproof(
            pdf_path=pdf_path,
            page_num=req.page,
            profile_id=req.profile_id,
            intent=req.intent,
            show_gamut_warning=req.show_gamut_warning,
            dpi=req.dpi,
        )
        return result
    except Exception as e:
        logger.exception("Lỗi khi render Soft-Proof")
        return {"success": False, "error": str(e)}


class OverprintPreviewRequest(BaseModel):
    file_id: str
    page: int = 1
    dpi: int = 150

@router.post("/preflight/overprint-preview")
async def render_overprint_preview(req: OverprintPreviewRequest):
    """
    Render a page with Overprint Simulation ON, and produce a diff overlay
    highlighting areas that change when overprint is applied.
    """
    import pikepdf
    import base64
    from io import BytesIO

    pdf_path = _get_file_path(req.file_id)

    try:
        doc = pikepdf.Pdf.open(pdf_path)
        if req.page < 1 or req.page > len(doc.pages):
            raise HTTPException(status_code=400, detail=f"Trang {req.page} không tồn tại")
        doc.close()
        # Try Ghostscript-based overprint simulation if available
        import subprocess
        import tempfile

        gs_exe = settings.GHOSTSCRIPT_PATH
        overprint_rendered = False

        if gs_exe:
            tmp_normal_name = None
            tmp_overprint_name = None
            try:
                # Tạo file tạm và đóng ngay để giải phóng lock trên Windows
                with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tn:
                    tmp_normal_name = tn.name
                with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as to:
                    tmp_overprint_name = to.name

                # Normal rendering (knockout)
                cmd_normal = [
                    gs_exe, '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER',
                    '-sDEVICE=png16m',
                    f'-r{req.dpi}',
                    f'-dFirstPage={req.page}', f'-dLastPage={req.page}',
                    '-dSimulateOverprint=false',
                    f'-sOutputFile={tmp_normal_name}',
                    str(pdf_path)
                ]
                import asyncio
                await asyncio.to_thread(run_hidden, cmd_normal, capture_output=True, timeout=30)

                # Overprint simulation rendering
                cmd_overprint = [
                    gs_exe, '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER',
                    '-sDEVICE=png16m',
                    f'-r{req.dpi}',
                    f'-dFirstPage={req.page}', f'-dLastPage={req.page}',
                    '-dSimulateOverprint=true',
                    f'-sOutputFile={tmp_overprint_name}',
                    str(pdf_path)
                ]
                await asyncio.to_thread(run_hidden, cmd_overprint, capture_output=True, timeout=30)

                from PIL import Image
                import numpy as np

                img_normal = np.array(Image.open(tmp_normal_name).convert('RGB'))
                img_overprint = np.array(Image.open(tmp_overprint_name).convert('RGB'))

                # Resize to match if needed
                if img_normal.shape != img_overprint.shape:
                    h = min(img_normal.shape[0], img_overprint.shape[0])
                    w = min(img_normal.shape[1], img_overprint.shape[1])
                    img_normal = img_normal[:h, :w]
                    img_overprint = img_overprint[:h, :w]

                # Calculate difference
                diff = np.abs(img_normal.astype(int) - img_overprint.astype(int))
                diff_magnitude = np.max(diff, axis=2)  # Max channel difference

                # Create overlay: red where different, transparent where same
                h, w = diff_magnitude.shape
                overlay = np.zeros((h, w, 4), dtype=np.uint8)
                threshold = 10  # Ignore tiny rounding differences
                mask = diff_magnitude > threshold
                overlay[mask, 0] = 255  # Red channel
                overlay[mask, 1] = 50   # Slight orange tint
                overlay[mask, 2] = 0
                overlay[mask, 3] = 180  # Semi-transparent alpha
                diff_count = int(np.sum(mask))

                # Encode diff overlay as base64 PNG
                overlay_img = Image.fromarray(overlay)
                buf_diff = BytesIO()
                overlay_img.save(buf_diff, format='PNG')
                overlay_b64 = base64.b64encode(buf_diff.getvalue()).decode()

                # Encode overprint render as base64 JPEG
                overprint_img = Image.fromarray(img_overprint)
                buf_op = BytesIO()
                overprint_img.save(buf_op, format='JPEG', quality=85)
                overprint_b64 = base64.b64encode(buf_op.getvalue()).decode()

                overprint_rendered = True

                # doc đã đóng ngay sau validate (dòng ~1355) — KHÔNG close lại
                # (double-close ném lỗi, rơi vào except → mất kết quả đã dựng xong).
                return {
                    "success": True,
                    "has_differences": diff_count > 0,
                    "diff_pixel_count": diff_count,
                    "diff_overlay": f"data:image/png;base64,{overlay_b64}",
                    "overprint_image": f"data:image/jpeg;base64,{overprint_b64}",
                    "width": w,
                    "height": h,
                }

            except Exception as e:
                logger.warning(f"Ghostscript overprint simulation failed: {e}")
            finally:
                import os
                if tmp_normal_name and os.path.exists(tmp_normal_name):
                    try:
                        os.unlink(tmp_normal_name)
                    except OSError as _e:
                        logger.debug("Không xoá được temp %s: %s", tmp_normal_name, _e)
                if tmp_overprint_name and os.path.exists(tmp_overprint_name):
                    try:
                        os.unlink(tmp_overprint_name)
                    except OSError as _e:
                        logger.debug("Không xoá được temp %s: %s", tmp_overprint_name, _e)

        if not overprint_rendered:
            # doc đã đóng sau validate — không close lại (tránh double-close).
            return {
                "success": False,
                "error": "Ghostscript không khả dụng để mô phỏng Overprint. Kiểm tra cấu hình GS_PATH.",
                "has_differences": False,
            }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Lỗi khi render Overprint Preview")
        return {"success": False, "error": str(e)}

