"""
Preflight API Routes — REST endpoints for PDF inspection and auto-fix.

Endpoints:
  POST /api/preflight/inspect     — Run preflight checks
  POST /api/preflight/fix         — Execute a single fix action
  POST /api/preflight/pipeline    — Execute a chain of fix actions
  GET  /api/preflight/actions     — List available fix actions
  GET  /api/preflight/download/{filename} — Download fixed PDF
"""
import logging
import os
import uuid
import base64
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Any
import pikepdf

from app.core.preflight_engine import PreflightEngine, PreflightReport, PreflightIssue
from app.core.separations import SeparationEngine
from app.core.action_engine import ActionEngine, AVAILABLE_ACTIONS
from app.utils.file_handler import save_upload_file
from app.config import settings
from app.core.license_guard import require_license
from app.database import SessionLocal
from app.models.job import UploadedFile

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_license)])


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


class ActionLogResponse(BaseModel):
    action_id: str
    status: str
    message: str
    duration_ms: int


class FixResponse(BaseModel):
    success: bool
    output_filename: Optional[str] = None
    log: List[ActionLogResponse]
    error: Optional[str] = None


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
        raise HTTPException(status_code=400, detail=f"Lỗi hệ thống ({type(e).__name__})")

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

        return FixResponse(
            success=result.success,
            output_filename=Path(result.output_path).name if result.output_path else None,
            log=[
                ActionLogResponse(
                    action_id=entry.action_id,
                    status=entry.status,
                    message=entry.message,
                    duration_ms=entry.duration_ms,
                )
                for entry in result.log
            ],
            error=result.error,
        )
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

        return FixResponse(
            success=result.success,
            output_filename=Path(result.output_path).name if result.output_path else None,
            log=[
                ActionLogResponse(
                    action_id=entry.action_id,
                    status=entry.status,
                    message=entry.message,
                    duration_ms=entry.duration_ms,
                )
                for entry in result.log
            ],
            error=result.error,
        )
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
    file_path = output_dir / filename

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File không tìm thấy hoặc đã hết hạn.")

    return FileResponse(
        path=str(file_path),
        filename=filename,
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
        logger.exception("Lỗi render SVG")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    finally:
        db.close()


@router.get("/preflight/svg-by-path")
async def get_page_svg_by_path(file_path: str, page: int):
    """Render SVG from a local file path (desktop app only)."""
    from fastapi.responses import Response
    try:
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File không tồn tại.")
        
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
        logger.exception("Lỗi render SVG by path")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")

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
                                objects.append(PdfObjectResponse(
                                    id=f"p{page}_img_{obj_idx}",
                                    type='image',
                                    bbox=bbox,
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
        logger.exception("Lỗi khi extract objects")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    finally:
        db.close()


class ObjectToDelete(BaseModel):
    type: str
    bbox: List[float]
    xref: Optional[int] = None

class DeleteObjectRequest(BaseModel):
    file_id: str
    page: int
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

        # 1. Process Images — replace image stream with 1x1 transparent pixel
        logger.info(f"Received request to delete {len(image_objs)} images.")
        
        if image_objs:
            resources = p.get("/Resources")
            if resources:
                xobjects = resources.get("/XObject")
                if xobjects:
                    for name in list(xobjects.keys()):
                        try:
                            obj = xobjects[name]
                            if hasattr(obj, 'resolve'):
                                obj = obj.resolve() if callable(getattr(obj, 'resolve', None)) else obj
                            if str(obj.get("/Subtype", "")) == "/Image":
                                del xobjects[name]
                        except Exception:
                            pass

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
        logger.exception("Lỗi khi xóa object")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
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

        # 1. Process Images — remove from XObject
        if image_objs:
            resources = p.get("/Resources")
            if resources:
                xobjects = resources.get("/XObject")
                if xobjects:
                    for name in list(xobjects.keys()):
                        try:
                            obj = xobjects[name]
                            if hasattr(obj, 'resolve'):
                                obj = obj.resolve() if callable(getattr(obj, 'resolve', None)) else obj
                            if str(obj.get("/Subtype", "")) == "/Image":
                                del xobjects[name]
                        except Exception:
                            pass

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
            bitmap = render_page.render(scale=200/72)
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
        logger.exception("Lỗi khi tạo ảnh preview tắt mắt")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    finally:
        db.close()

@router.get("/preflight/layers/{file_id}")
async def get_ocg_layers(file_id: str):
    """Trích xuất danh sách OCG Layers (cấu trúc cây F7-style) của PDF."""
    from app.core.layer_engine import LayerEngine
    pdf_path = _get_file_path(file_id)
    engine = LayerEngine()
    try:
        result = engine.get_layer_tree(pdf_path)
        return result
    except Exception as e:
        logger.exception("Lỗi khi extract OCG layers")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


class PreviewLayersRequest(BaseModel):
    file_id: str
    page: int
    hidden_layer_ids: List[int] = []

@router.post("/preflight/preview-layers")
async def preview_layers_pdf(req: PreviewLayersRequest):
    """Tạo ảnh preview Base64 của trang với các OCG layers bị ẩn (pikepdf + pypdfium2).
    Ưu tiên dùng EditSession live bytes nếu đang mở (để phản ánh thay đổi OCG chưa commit).
    """
    from app.core.layer_engine import LayerEngine
    import app.core.edit_session as edit_session
    from io import BytesIO
    pdf_path = _get_file_path(req.file_id)
    engine = LayerEngine()
    try:
        # Prefer live session bytes for accurate current OCG state (edit mode)
        session = edit_session.get_active_session(req.file_id)
        if session:
            buf = BytesIO()
            with session.lock:
                session.pdf.save(buf, compress_streams=False)
            live_bytes = buf.getvalue()
            # Layer engine render accepts path or we can temp save? Use bytes path via temp or extend.
            # For simplicity, use a temp file from live bytes (fast, then deleted by engine flow)
            import tempfile, os
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                tmp.write(live_bytes)
                tmp_path = tmp.name
            try:
                preview_b64 = engine.render_with_visibility(tmp_path, req.page, req.hidden_layer_ids)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError as _e:
                    logger.debug("Không xoá được temp %s: %s", tmp_path, _e)
        else:
            preview_b64 = engine.render_with_visibility(pdf_path, req.page, req.hidden_layer_ids)
        return {
            "success": True,
            "preview_b64": preview_b64,
        }
    except Exception as e:
        logger.exception("Lỗi khi tạo ảnh preview layers")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi rename layer")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi toggle lock layer")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi set visibility")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi xóa layer")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi reorder layers")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        logger.exception("Lỗi khi flatten layers")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")

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
        logger.exception("Lỗi khi tạo Separations")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
    if not os.path.exists(req.file_path):
        raise HTTPException(status_code=404, detail=f"File không tồn tại: {req.file_path}")

    try:
        engine = SeparationEngine()
        result = await engine.extract_separations(req.file_path, req.page, req.dpi, use_ghostscript=req.use_gs)
        return result
    except Exception as e:
        logger.exception("Lỗi khi tạo Separations (by path)")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


class ExportPdfxRequest(BaseModel):
    file_id: str
    standard: str = "x4"  # "x1a" | "x4"


@router.post("/preflight/export-pdfx")
async def export_pdfx(req: ExportPdfxRequest):
    """Xuất file chuẩn PDF/X."""
    file_path = _get_file_path(req.file_id)
    from app.core.pdfx_export import PdfxExportEngine
    engine = PdfxExportEngine()
    try:
        output = await engine.export_pdfx(file_path, req.standard)
        return {"success": True, "output_filename": Path(output).name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")


# ══════════════════════════════════════════════════════════════
#  CONVERT COLORS (RGB→CMYK, Gray→K, Spot→CMYK)
# ══════════════════════════════════════════════════════════════

class ConvertColorsRequest(BaseModel):
    file_id: str
    conversions: list[str] = ["rgb_to_cmyk"]  # "rgb_to_cmyk" | "gray_to_cmyk" | "spot_to_cmyk"
    icc_profile: str = "auto"  # "auto" | "fogra39" | "swop" | "japan_color"
    rendering_intent: str = "relative"  # "relative" | "perceptual" | "saturation" | "absolute"
    preserve_black: bool = True


@router.post("/preflight/convert-colors")
async def convert_colors(req: ConvertColorsRequest):
    """Chuyển đổi không gian màu toàn bộ file PDF."""
    import time
    file_path = _get_file_path(req.file_id)
    log = []
    current_path = file_path

    for conv in req.conversions:
        t0 = time.time()
        try:
            if conv == "spot_to_cmyk":
                from app.core.ink_manager import InkManagerEngine
                engine = InkManagerEngine()
                output = await engine.convert_spot_to_cmyk(current_path, None)
                current_path = output
                ms = round((time.time() - t0) * 1000)
                log.append({"action_id": conv, "status": "success", "message": "Spot → CMYK", "duration_ms": ms})

            elif conv in ("rgb_to_cmyk", "gray_to_cmyk"):
                import subprocess
                gs_path = settings.GHOSTSCRIPT_PATH
                output = str(Path(current_path).parent / f"cc_{conv}_{Path(current_path).stem}.pdf")

                intent_map = {"relative": 1, "perceptual": 0, "saturation": 2, "absolute": 3}
                ri = intent_map.get(req.rendering_intent, 1)

                gs_args = [
                    gs_path, "-dBATCH", "-dNOPAUSE", "-dQUIET",
                    "-sDEVICE=pdfwrite",
                    f"-sOutputFile={output}",
                    "-dPDFSETTINGS=/prepress",
                    f"-sColorConversionStrategy={'CMYK' if conv == 'rgb_to_cmyk' else 'Gray'}",
                    "-dConvertCMYKImagesToProcess=false",
                    f"-dRenderIntent={ri}",
                ]
                if req.preserve_black:
                    gs_args.append("-dPreserveBlack=true")

                gs_args.append(str(current_path))

                import asyncio
                proc = await asyncio.to_thread(subprocess.run, gs_args, capture_output=True, timeout=300)
                if proc.returncode != 0:
                    raise Exception(f"Ghostscript failed: {proc.stderr.decode()[:200]}")

                current_path = output
                label = "RGB → CMYK" if conv == "rgb_to_cmyk" else "Grayscale → CMYK K"
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
                await asyncio.to_thread(subprocess.run, cmd_normal, capture_output=True, timeout=30)

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
                await asyncio.to_thread(subprocess.run, cmd_overprint, capture_output=True, timeout=30)

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

                doc.close()
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
            doc.close()
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

