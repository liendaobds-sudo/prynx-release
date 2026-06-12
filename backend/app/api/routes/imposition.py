import os
import shutil
import tempfile
import logging
from pathlib import Path
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends
from fastapi.responses import FileResponse
from app.core.imposition_engine import ImpositionEngine, ImpositionError
from app.core.license_guard import require_license
from app.schemas.imposition import ImpositionResponse
import uuid

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imposition", tags=["Imposition"], dependencies=[Depends(require_license)])

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

# ── Allowed directories for file path inputs ──
_ALLOWED_DIRS = [
    os.path.abspath(UPLOAD_DIR),
    os.path.abspath(RESULTS_DIR),
    os.path.abspath(tempfile.gettempdir()),
]


def _validate_file_path(path: str | None, must_exist: bool = True) -> str:
    """
    Validate a client-supplied file path to prevent path traversal attacks.
    Returns the resolved absolute path if valid, raises HTTPException otherwise.
    """
    if not path:
        raise HTTPException(status_code=400, detail="File path is required.")

    # Block obvious traversal attempts
    if '..' in path:
        raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed.")

    resolved = os.path.abspath(path)

    # Reject symbolic links
    if os.path.islink(resolved):
        raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed.")

    # Must be a PDF file
    if not resolved.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    # In Desktop App (Tauri) mode, the user accesses their own local files.
    # Therefore, we remove the _ALLOWED_DIRS restriction to allow any valid local path.

    if must_exist and not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    return resolved

@router.post("/process")
async def process_imposition(
    file: UploadFile = File(...),
    mode: str = Form("booklet"),
    n_up: int = Form(2),
    formsize: str = Form("A4"),
    binding: str = Form("booklet"),
    guides: bool = Form(True),
    margin: int = Form(0),
    multifolio: bool = Form(False),
    foliosize: int = Form(8),
    orientation: str = Form("rd"),
    border: bool = Form(True),
    license_info: dict = Depends(require_license)
):
    """
    Process a PDF file using pdfcpu for Booklet or N-up imposition.
    """
    if not file.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    job_id = str(uuid.uuid4())
    input_path = os.path.join(UPLOAD_DIR, f"{job_id}_input.pdf")
    output_path = os.path.join(RESULTS_DIR, f"{job_id}_imposed.pdf")

    # Save uploaded file
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        await ImpositionEngine.validate_pdf(input_path)
        
        if mode == "booklet":
            await ImpositionEngine.process_booklet(
                input_pdf=input_path,
                output_pdf=output_path,
                n_up=n_up,
                formsize=formsize,
                binding=binding,
                guides=guides,
                margin=margin,
                multifolio=multifolio,
                foliosize=foliosize
            )
        elif mode == "nup":
            await ImpositionEngine.process_nup(
                input_pdf=input_path,
                output_pdf=output_path,
                n_up=n_up,
                formsize=formsize,
                orientation=orientation,
                border=border,
                margin=margin
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported mode: {mode}")

    except ImpositionError as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    finally:
        # Cleanup input file if needed (optional)
        pass

    # Return the file directly for download, or provide a URL to download it later.
    # For a simple UX, we might just return the FileResponse immediately.
    return FileResponse(
        path=output_path, 
        filename=f"imposed_{file.filename}", 
        media_type="application/pdf"
    )

@router.post("/unlock-pdf")
async def unlock_pdf(file: UploadFile = File(...), license_info: dict = Depends(require_license)):
    """
    Unlock and Flatten a PDF using PDFium backend.
    This strips encryption dictionaries and digitally certified signatures,
    and flattens all Annotations (including visual signature stamps) into the vector stream.
    """
    if not file.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    
    try:
        import pypdfium2 as pdfium
        from fastapi import Response
        
        contents = await file.read()
        
        # Load PDF using pdfium (bypasses owner pass automatically usually, or allows interaction)
        pdf = pdfium.PdfDocument(contents)
        
        # Flatten all pages to ensure annotations (visual signatures, stamps) are baked into vector paths
        for i in range(len(pdf)):
            page = pdf[i]
            # FPDFPage_Flatten: 0 = FLAT_NORMALDISPLAY
            pdfium.raw.FPDFPage_Flatten(page, 0)
        
        # Save to buffer
        import io
        out_buffer = io.BytesIO()
        # flags=3 corresponds to FPDF_REMOVE_SECURITY, ensuring the output is perfectly clean and decoded
        pdf.save(out_buffer, flags=3)
        pdf.close()
        
        return Response(content=out_buffer.getvalue(), media_type="application/pdf")
        
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Failed to unlock PDF: {e}")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")

@router.post("/execute-plan")
async def execute_plan_imposition(
    file: UploadFile = File(...),
    plan_json: str = Form(...),
):
    """
    Execute an imposition plan from a JSON Instruction Set (multipart form).
    
    Accepts a PDF file upload + JSON plan string.
    The TypeScript Planner computes all coordinates/rotations and sends this JSON plan.
    This endpoint uses pikepdf to execute the plan with near-zero RAM.
    """
    import json
    from app.core.plan_executor import PlanExecutor, PlanExecutionError
    
    if not file.filename.endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    
    try:
        plan = json.loads(plan_json)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON plan: {str(e)}")
    
    # Save uploaded file
    job_id = str(uuid.uuid4())
    input_path = os.path.join(UPLOAD_DIR, f"{job_id}_plan_input.pdf")
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    try:
        output_path = await PlanExecutor.execute(plan, input_path)
        return FileResponse(
            path=output_path,
            filename=f"imposed_{file.filename}",
            media_type="application/pdf"
        )
    except PlanExecutionError as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    except Exception as e:
        logger.error(f"Plan execution failed: {e}")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

@router.post("/execute-plan-json")
async def execute_plan_json(body: dict):
    """
    Execute an imposition plan from a JSON Instruction Set (JSON body).
    
    Expects body:
    {
        "plan": { ...InstructionSet... },
        "source_pdf_path": "C:/Users/.../catalog.pdf"  (optional override)
    }
    """
    from app.core.plan_executor import PlanExecutor, PlanExecutionError
    
    plan = body.get("plan")
    source_override = body.get("source_pdf_path")
    
    if not plan:
        raise HTTPException(status_code=400, detail="Missing 'plan' in request body.")
    
    # Validate source path if provided
    if source_override:
        source_override = _validate_file_path(source_override)
    
    try:
        output_path = await PlanExecutor.execute(plan, source_override)
        return FileResponse(
            path=output_path,
            filename="imposed_output.pdf",
            media_type="application/pdf"
        )
    except PlanExecutionError as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Plan execution failed: {e}")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")

@router.post("/quick-color-space")
async def quick_color_space(body: dict):
    """
    Quickly detect the color space of a PDF using pikepdf.
    Expects body: { "path": "C:/Users/.../catalog.pdf" }
    """
    pdf_path = _validate_file_path(body.get("path"))
    try:
        import pikepdf
        pdf = pikepdf.open(pdf_path)
        cmyk = 0
        rgb = 0
        
        # Check OutputIntents
        if "/Root" in pdf.trailer and "/OutputIntents" in pdf.trailer.Root:
            for intent in pdf.trailer.Root.OutputIntents:
                val = str(intent.get("/OutputConditionIdentifier", "")).upper()
                if "CMYK" in val or "FOGRA" in val or "SWOP" in val:
                    return {"color_space": "CMYK"}
                if "RGB" in val:
                    return {"color_space": "RGB"}
        
        def check_color_space(cs):
            nonlocal cmyk, rgb
            if isinstance(cs, pikepdf.Array):
                if str(cs[0]) == "/DeviceCMYK": cmyk += 1
                elif str(cs[0]) == "/DeviceRGB": rgb += 1
                elif str(cs[0]) == "/ICCBased" and len(cs) > 1:
                    icc_stream = cs[1]
                    if "/N" in icc_stream:
                        n = int(icc_stream.N)
                        if n == 4: cmyk += 1
                        elif n == 3: rgb += 1
                elif str(cs[0]) == "/Separation" and len(cs) > 2:
                    check_color_space(cs[2])
            else:
                if str(cs) == "/DeviceCMYK": cmyk += 1
                elif str(cs) == "/DeviceRGB": rgb += 1

        # Check page resources (scan up to 50 pages)
        pages_to_scan = min(len(pdf.pages), 50)
        for i in range(pages_to_scan):
            page = pdf.pages[i]
            if "/Resources" in page:
                res = page.Resources
                if "/ColorSpace" in res:
                    for key in res.ColorSpace.keys():
                        check_color_space(res.ColorSpace[key])
                if "/XObject" in res:
                    for key in res.XObject.keys():
                        xobj = res.XObject[key]
                        if "/ColorSpace" in xobj:
                            check_color_space(xobj.ColorSpace)
            
            # Fast return if we find a dominant color space early
            if cmyk > 5: return {"color_space": "CMYK"}
            if rgb > 5: return {"color_space": "RGB"}
        
        # If still 0, check the actual content stream operators!
        # Many vector PDFs just use implicit DeviceCMYK (k, K operators) or DeviceRGB (rg, RG)
        if cmyk == 0 and rgb == 0:
            import pikepdf.models
            for i in range(pages_to_scan):
                try:
                    page = pdf.pages[i]
                    # Read uncompressed raw content stream
                    contents = b""
                    if "/Contents" in page:
                        c = page.Contents
                        if isinstance(c, pikepdf.Array):
                            for stream in c:
                                contents += stream.read_bytes()
                        else:
                            contents = c.read_bytes()
                    # Check for operator patterns
                    # ' k' or ' K' (CMYK), ' rg' or ' RG' (RGB)
                    # This is a heuristic but very effective for simple vectors
                    import re
                    if re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[kK](?:\s|$)', contents):
                        cmyk += 1
                    elif re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[rgRG](?:\s|$)', contents):
                        rgb += 1
                except Exception:
                    pass
        
        pdf.close()
        
        if cmyk > rgb: return {"color_space": "CMYK"}
        if rgb > cmyk: return {"color_space": "RGB"}
        return {"color_space": None}
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Failed to detect color space: {e}")
        return {"color_space": None}
@router.post("/pdf-layers")
async def get_pdf_layers(body: dict):
    """
    Extract OCG layers directly from a file path.
    Expects body: { "path": "C:/Users/.../file.pdf" }
    Returns the same structure as /preflight/layers/{file_id}
    """
    from app.core.layer_engine import LayerEngine
    
    pdf_path = _validate_file_path(body.get("path"))
    engine = LayerEngine()
    try:
        result = engine.get_layer_tree(pdf_path)
        return result
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to extract OCG layers")
        raise HTTPException(status_code=500, detail=f"Cannot read PDF layers: {str(e)}")

@router.post("/pdf-layers/preview")
async def preview_pdf_layers(body: dict):
    """
    Render a page with specified OCG layers hidden.
    Expects body: { "path": "...", "page": 1, "hidden_layer_ids": [5, 7], "dpi": 150 }
    Returns: { "preview_b64": "data:image/jpeg;base64,..." }
    """
    from app.core.layer_engine import LayerEngine
    
    pdf_path = _validate_file_path(body.get("path"))
    page = body.get("page", 1)
    hidden_layer_ids = body.get("hidden_layer_ids", [])
    hidden_object_keys = body.get("hidden_object_keys", [])
    dpi = body.get("dpi", 150)
    
    engine = LayerEngine()
    try:
        preview_b64 = engine.render_with_visibility(pdf_path, page, hidden_layer_ids, dpi, hidden_object_keys=hidden_object_keys)
        return {
            "success": True,
            "preview_b64": preview_b64,
        }
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to render layer preview")
        raise HTTPException(status_code=500, detail=f"Cannot render preview: {str(e)}")

@router.post("/pdf-meta")
async def get_pdf_meta(body: dict):
    """
    Read PDF metadata (page count, dimensions, rotations) using pypdfium2.
    
    This allows the TypeScript Planner to get the info it needs for computation
    WITHOUT loading the entire PDF into the Webview's RAM.
    
    Expects body: { "path": "C:/Users/.../catalog.pdf" }
    """
    from app.workers import pdf_wrapper as pdf_lib
    
    pdf_path = _validate_file_path(body.get("path"))
    
    try:
        pdf = pdf_lib.open(pdf_path)
        page_count = len(pdf)
        pages = []
        max_w = 0.0
        max_h = 0.0
        
        # For huge files (VDP outputs), only scan first few pages
        scan_limit = min(page_count, 10) if page_count > 200 else page_count
        
        _PT_TO_MM = 1.0 / 2.83465
        detected_bleed_mm = 0.0  # bleed suy ra từ (MediaBox - TrimBox)/2 của trang đầu
        for i in range(scan_limit):
            page = pdf[i]
            # Dùng MediaBox = đúng kích thước file người dùng thấy (gồm cả bleed).
            # KHÔNG ưu tiên TrimBox: tránh cắt mất phần bleed ngoài của file.
            src_box = page.mediabox or page.cropbox or page.trimbox or page.rect
            w = src_box.width
            h = src_box.height
            rot = page.rotation

            # Tự nhận bleed từ metadata file: nếu TrimBox nhỏ hơn MediaBox đối xứng
            # thì khoảng chênh /2 chính là bleed (giống cách Acrobat đọc page boxes).
            if i == 0:
                try:
                    _tb = page.trimbox
                    _mb = page.mediabox
                    _bx = (float(_mb.width) - float(_tb.width)) / 2.0
                    _by = (float(_mb.height) - float(_tb.height)) / 2.0
                    if _bx > 0.5 and _by > 0.5 and abs(_bx - _by) < 3.0:
                        detected_bleed_mm = round(((_bx + _by) / 2.0) * _PT_TO_MM, 2)
                except Exception:
                    detected_bleed_mm = 0.0
            
            user_unit = 1.0
            try:
                if "/UserUnit" in page._page:
                    user_unit = float(page._page["/UserUnit"])
            except Exception:
                pass
            
            w *= user_unit
            h *= user_unit
            
            # Adjust visual dimensions for rotation
            if rot in (90, 270):
                visual_w, visual_h = h, w
            else:
                visual_w, visual_h = w, h
            
            if visual_w > max_w:
                max_w = visual_w
            if visual_h > max_h:
                max_h = visual_h
            
            pages.append({
                "index": i,
                "width_pt": round(visual_w, 2),
                "height_pt": round(visual_h, 2),
                "rotation": rot,
            })
        
        pdf.close()
        
        return {
            "page_count": page_count,
            "max_width_pt": round(max_w, 2),
            "max_height_pt": round(max_h, 2),
            "detected_bleed_mm": detected_bleed_mm,
            "pages": pages,
        }
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Failed to read PDF meta: {e}")
        raise HTTPException(status_code=500, detail=f"Cannot read PDF: {str(e)}")

@router.post("/detect-shape")
async def api_detect_shape(body: dict):
    """
    Detect the geometric shape of all pages (for die-cut stickers).
    Uses vector path analysis (not bitmap) for accurate classification.
    """
    import pypdfium2 as pdfium
    from app.workers.shape_analyzer import detect_shape, extract_shape_properties
    
    try:
        file_id = body.get("fileId")
        if not file_id:
            raise ValueError("Missing fileId")
        
        import logging
        _detect_logger = logging.getLogger(__name__)
        
        from app.database import SessionLocal
        from app.models.job import UploadedFile as UploadedFileModel
        db = SessionLocal()
        try:
            db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == file_id).first()
            if not db_file:
                raise ValueError(f"File not found in database: {file_id}")
            file_path = db_file.file_path
            _detect_logger.info(f"[DETECT_SHAPE] Resolved fileId={file_id} → file_path={file_path}")
        finally:
            db.close()
        
        import os
        if not os.path.exists(file_path):
            raise ValueError(f"File not found on disk: {file_path}")
            
        doc = pdfium.PdfDocument(file_path)
        
        from app.core.separations import SeparationEngine
        import numpy as np
        import base64
        import zlib
        
        engine = SeparationEngine()
        tmp_path = file_path
        shapes = []
        dimensions = []
        shape_params_list = []
        max_pages = min(len(doc), 30)
        
        global_spot_w, global_spot_h = None, None
        
        # --- Open via pdf_wrapper for vector path analysis (original flow) ---
        pike_doc = None
        try:
            from app.workers import pdf_wrapper as pdf_lib
            pike_doc = pdf_lib.open(file_path)
        except Exception as e:
            _detect_logger.warning(f"pdf_wrapper open failed: {e}")
        
        for page_idx in range(max_pages):
            page = doc[page_idx]
            
            # Use pike_doc if available for accurate bounding box & UserUnit
            if pike_doc is not None:
                pike_page = pike_doc[page_idx]
                src_box = pike_page.mediabox or pike_page.cropbox or pike_page.trimbox or pike_page.rect
                page_w, page_h = src_box.width, src_box.height
                
                user_unit = 1.0
                try:
                    if "/UserUnit" in pike_page._page:
                        user_unit = float(pike_page._page["/UserUnit"])
                except Exception:
                    pass
                page_w *= user_unit
                page_h *= user_unit
            else:
                page_w, page_h = page.get_size()
            spot_w, spot_h = global_spot_w, global_spot_h
            
            # === PRIMARY: Vector path analysis via extract_vector_paths() + classify_shape() ===
            path_classified = False
            if pike_doc is not None:
                try:
                    pike_page = pike_doc[page_idx]
                    paths = pike_page.extract_vector_paths()
                    
                    if paths:
                        # Filter valid paths (>5pt) and exclude full-page backgrounds
                        valid_paths = [p for p in paths if p['rect'].width > 5 and p['rect'].height > 5]
                        filtered = [p for p in valid_paths
                                    if not (abs(p['rect'].width - pike_page.rect.width) <= 2 
                                            and abs(p['rect'].height - pike_page.rect.height) <= 2)]
                        if filtered:
                            valid_paths = filtered
                        
                        if valid_paths:
                            # Prioritize stroke-only paths (die-cut boundary)
                            stroke_paths = [p for p in valid_paths 
                                            if p.get('type') == 's' or (p.get('fill') is None and p.get('color') is not None)]
                            target_paths = stroke_paths if stroke_paths else valid_paths
                            
                            largest_path = max(target_paths, key=lambda p: p['rect'].width * p['rect'].height)
                            
                            from app.workers.shape_classifier import classify_shape, _sample_bezier_contour, _bounding_box
                            
                            # Get visual dimensions from sampled path points
                            try:
                                samples = _sample_bezier_contour(largest_path.get('items', []))
                                if samples:
                                    min_x, max_x, min_y, max_y = _bounding_box(samples)
                                    visual_w = max_x - min_x
                                    visual_h = max_y - min_y
                                else:
                                    visual_w = largest_path['rect'].width
                                    visual_h = largest_path['rect'].height
                            except Exception:
                                visual_w = largest_path['rect'].width
                                visual_h = largest_path['rect'].height
                            
                            result = classify_shape(largest_path.get('items', []))
                            shapes.append(result['shape_type'].name)
                            shape_params_list.append(result.get('params', {}))
                            
                            rot = pike_page.rotation
                            if rot in (90, 270):
                                visual_w, visual_h = visual_h, visual_w
                            
                            dimensions.append({
                                "w": round(visual_w, 2),
                                "h": round(visual_h, 2)
                            })
                            path_classified = True
                            if page_idx == 0:
                                _detect_logger.info(f"[DETECT_SHAPE] Vector path: {result['shape_type'].name}")
                except Exception as e:
                    _detect_logger.warning(f"Vector path analysis failed: {e}")
            
            if path_classified:
                continue
                
            # === FALLBACK: Mask-based detect_shape() ===
            ink_density = None
            try:
                sep_result = await engine.extract_separations(tmp_path, page_num=page_idx + 1, dpi=144, use_ghostscript=True)
                for p in sep_result.get("plates", []):
                    if p["name"] not in ("Cyan", "Magenta", "Yellow", "Black"):
                        raw_bytes = zlib.decompress(base64.b64decode(p["alpha_data"]))
                        h = sep_result["height"]
                        w = sep_result["width"]
                        ink_density = np.frombuffer(raw_bytes, dtype=np.uint8).reshape((h, w))
                        import cv2
                        contours, _ = cv2.findContours(ink_density, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        if contours:
                            solid_mask = np.zeros_like(ink_density)
                            cv2.drawContours(solid_mask, contours, -1, 255, cv2.FILLED)
                            ink_density = solid_mask
                        y, x = np.where(ink_density > 0)
                        if len(y) > 0:
                            spot_w = float((x.max() - x.min()) * 72 / 144)
                            spot_h = float((y.max() - y.min()) * 72 / 144)
                            _detect_logger.info(f"Spot color '{p['name']}' on page {page_idx + 1} found: {spot_w}x{spot_h} pt")
                        break
            except Exception as e:
                _detect_logger.warning(f"Spot extraction on page {page_idx + 1} failed: {e}")

            if ink_density is not None:
                shape_type_enum = detect_shape(ink_density)
                shape_type_str = shape_type_enum.name
                
                shape_params = extract_shape_properties(ink_density)
                
                if shape_type_enum.name == 'HAMMER':
                    shape_params['effective_body_w_ratio'] = 0.37
                elif shape_type_enum.name == 'DUMBBELL':
                    shape_params['effective_body_w_ratio'] = 0.65
                    
                shapes.append(shape_type_str)
                shape_params_list.append(shape_params)
                dimensions.append({
                    "w": round(spot_w if spot_w else page_w, 2),
                    "h": round(spot_h if spot_h else page_h, 2)
                })
                if page_idx == 0:
                    _detect_logger.info(f"[DETECT_SHAPE] Mask fallback: {shape_type_str}")
            else:
                shapes.append("CUSTOM")
                shape_params_list.append({})
                dimensions.append({
                    "w": round(page_w, 2),
                    "h": round(page_h, 2)
                })

        if pike_doc:
            pike_doc.close()
        
        return {
            "shapes": shapes,
            "dimensions": dimensions,
            "shapeParams": shape_params_list,
            "success": True
        }
    except Exception as e:
        import traceback
        with open("detect_shape_error.log", "w") as f:
            f.write(traceback.format_exc())
        import logging
        logging.getLogger(__name__).error(f"Failed to detect shape: {e}")
        return {"shapes": ["CUSTOM"], "success": False, "error": str(e)}

# =========================================================================
#  N-Up Backend Engine (pikepdf) — for high-volume imposition (50k+ pages)
# =========================================================================

import tempfile
import threading
import glob

# In-memory job store for N-Up jobs
nup_jobs = {}


def _cleanup_job_temp(job_id: str):
    """Dọn file trạng thái/tiến trình tạm của job (Task 19 / Req 9.2)."""
    for name in (f"nup_state_{job_id}.txt", f"nup_prog_{job_id}.txt"):
        p = os.path.join(tempfile.gettempdir(), name)
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass

def _nup_process_worker(source_path: str, output_path: str, settings: dict, job_id: str):
    import tempfile
    import os
    from app.workers.nup_engine import run_nup_engine
    try:
        report_msg = run_nup_engine(source_path, output_path, settings, job_id=job_id, progress_callback=None)
        
        # Write success state
        state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
        with open(state_file, 'w', encoding='utf-8') as f:
            f.write(f"completed|||{report_msg}")
            
    except Exception as e:
        state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
        with open(state_file, 'w', encoding='utf-8') as f:
            f.write(f"failed|||{str(e)}")


def _launch_impose_job(body: dict, prefix: str, license_info: dict = None) -> dict:
    """
    Helper chung cho N-Up & Sticker (Task 18 / Req 9.3).
    Hai chế độ chỉ khác tiền tố tên file; mode thực do settings['isDieCutMode'].
    """
    import multiprocessing

    source_path = _validate_file_path(body.get("source_path"))
    settings = body.get("settings", {})

    # Inject license info for stealth watermark (hashed in watermark module)
    if license_info:
        settings["_license_key"] = license_info.get("license_key", "")
        settings["_hwid"] = license_info.get("hwid", "")

    # Parse detectedShapeParamsByPage từ chuỗi JSON nếu cần
    if 'detectedShapeParamsByPage' in settings:
        for k, v in settings['detectedShapeParamsByPage'].items():
            if isinstance(v, str):
                try:
                    import json
                    settings['detectedShapeParamsByPage'][k] = json.loads(v)
                except Exception:
                    pass

    job_id = str(uuid.uuid4())[:8]
    output_path = os.path.join(RESULTS_DIR, f"{prefix}_{job_id}.pdf")

    nup_jobs[job_id] = {
        "status": "running",
        "progress": "0/0",
        "report": "",
        "output_path": output_path,
        "error": None,
    }

    # Process riêng để bỏ qua GIL; nup_engine tự chunk
    proc = multiprocessing.Process(
        target=_nup_process_worker,
        args=(source_path, output_path, settings, job_id),
        daemon=False,
    )
    proc.start()
    return {"job_id": job_id}


@router.post("/impose-start")
async def start_impose_job(body: dict, license_info: dict = Depends(require_license)):
    """
    Endpoint hợp nhất N-Up & Bế Tem. Tiền tố tên file theo settings.isDieCutMode.
    Expects body: { "source_path": "...", "settings": {...} }
    """
    is_diecut = bool(body.get("settings", {}).get("isDieCutMode", False))
    return _launch_impose_job(body, "sticker" if is_diecut else "nup", license_info)


@router.post("/nup-start")
async def start_nup_job(body: dict, license_info: dict = Depends(require_license)):
    """Alias tương thích ngược — dùng /impose-start. (Task 18)"""
    return _launch_impose_job(body, "nup", license_info)


@router.post("/sticker-start")
async def start_sticker_job(body: dict, license_info: dict = Depends(require_license)):
    """Alias tương thích ngược — dùng /impose-start. (Task 18)"""
    return _launch_impose_job(body, "sticker", license_info)


@router.get("/nup-status/{job_id}")
async def get_nup_status(job_id: str):
    """Poll N-Up job progress."""
    job = nup_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Also check progress file for more granular updates
    prog_file = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt")
    if os.path.exists(prog_file):
        try:
            with open(prog_file, 'r') as f:
                job["progress"] = f.read().strip()
        except (IOError, OSError):
            pass
    
    state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
    if os.path.exists(state_file):
        try:
            with open(state_file, 'r', encoding='utf-8') as f:
                parts = f.read().split('|||', 1)
                job["status"] = parts[0]
                if parts[0] == "completed":
                    job["report"] = parts[1] if len(parts) > 1 else ""
                else:
                    job["error"] = parts[1] if len(parts) > 1 else ""
        except Exception:
            pass

    return {
        "status": job["status"],
        "progress": job["progress"],
        "report": job.get("report", ""),
        "error": job.get("error"),
    }


@router.get("/nup-download/{job_id}")
async def download_nup_result(job_id: str):
    """Download completed N-Up PDF."""
    job = nup_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Job not completed. Status: {job['status']}")
    
    output_path = job["output_path"]
    if not os.path.exists(output_path):
        raise HTTPException(status_code=404, detail="Output file not found")
    
    from starlette.background import BackgroundTask
    return FileResponse(
        path=output_path,
        filename=f"imposed_nup_{job_id}.pdf",
        media_type="application/pdf",
        background=BackgroundTask(_cleanup_job_temp, job_id),
    )

from pydantic import BaseModel, ConfigDict
from typing import Dict, Any, Optional, List

class DebugLogRequest(BaseModel):
    source: str
    data: Dict[str, Any]

@router.post("/debug-log")
async def write_debug_log(req: DebugLogRequest):
    import json, os
    desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
    log_path = os.path.join(desktop, "debug_nup_l_shape.txt")
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"\n--- LOG FROM {req.source} ---\n")
            f.write(json.dumps(req.data, indent=2, ensure_ascii=False) + "\n")
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

class PreviewLayoutRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    
    usable_w: float
    usable_h: float
    item_w: float
    item_h: float
    gap_x: float
    gap_y: float
    strategy: str
    shape_type: str = "CUSTOM"
    shape_props: Dict[str, Any] = {}
    pont_config: Optional[Dict[str, Any]] = None
    sheet_w: float = 0
    sheet_h: float = 0
    margin_left: float = 0
    margin_bottom: float = 0
    file_id: Optional[str] = None
    page_idx: int = 0
    bleed: float = 0.0
    layout_type: Optional[str] = None
    is_die_cut: Optional[bool] = False
    grouping_strategy: str = "none"
    cluster_sizing_mode: str = "dims"
    cluster_cols: int = 2
    cluster_rows: int = 2
    cluster_w: float = 0
    cluster_h: float = 0
    tile_gap_x: float = 0
    tile_gap_y: float = 0
    task_mode: str = "nup"
    total_pages: int = 1
    split_gap: Optional[float] = 0
    target_quantity: Optional[int] = 0
    target_quantities_by_page: Optional[Dict[str, int]] = {}
    # ── Bình Bế Rớt (CNC) ghép nhiều mẫu — preview khớp output ──
    imposer_mode: Optional[str] = None
    cnc_two_sided: Optional[bool] = False
    cnc_flip_edge: Optional[str] = "long"
    cols: int = 0
    rows: int = 0

def apply_preview_collisions(items: List[Dict[str, Any]], item_w: float, item_h: float, req: Any, overall_w: float = 0, overall_h: float = 0, base_poly=None) -> List[Dict[str, Any]]:
    """
    Apply collision detection to preview items, replicating nup_engine process_chunk logic exactly.
    
    Coordinate system must match nup_engine:
    - margins dict: raw MM values from pont_config (nup_engine lines 223-228)
    - abs_x/abs_y: center-aligned, bottom-up (nup_engine lines 56-66, 204-213)
    """
    if not items or not getattr(req, 'pont_config', None) or req.pont_config.get('disableCollision', False) or not getattr(req, 'sheet_w', None) or not getattr(req, 'sheet_h', None):
        return items
        
    try:
        from app.workers.pont_collision import calculate_forbidden_zones, smart_resolve_collisions, detect_collisions, MM_TO_PTS
        
        sheet_w = req.sheet_w
        sheet_h = req.sheet_h
        m_left_pt = getattr(req, 'margin_left', 0) or 0
        m_bottom_pt = getattr(req, 'margin_bottom', 0) or 0
        
        margins = {
            'top': req.pont_config.get('marginTop') * MM_TO_PTS if req.pont_config.get('marginTop') is not None else m_bottom_pt,
            'bottom': req.pont_config.get('marginBottom') * MM_TO_PTS if req.pont_config.get('marginBottom') is not None else m_bottom_pt,
            'left': req.pont_config.get('marginLeft') * MM_TO_PTS if req.pont_config.get('marginLeft') is not None else m_left_pt,
            'right': req.pont_config.get('marginRight') * MM_TO_PTS if req.pont_config.get('marginRight') is not None else m_left_pt
        }
        
        zones = calculate_forbidden_zones(req.pont_config, margins, sheet_w, sheet_h)
        if not zones:
            return items
        
        # Compute usable area (must match nup_engine lines 991-994)
        # In nup_engine, margin_top/bottom/left/right are in PT
        # For preview, we approximate: margin_right ≈ margin_left (symmetric)
        # usable_w = req.usable_w, usable_h = req.usable_h (already provided)
        usable_w = req.usable_w
        usable_h = req.usable_h
        
        # Match nup_engine lines 56-66: center alignment (default)
        # super_base_x = margin_left + (usable_w - overall_w) / 2
        # super_base_y = margin_bottom + (usable_h - overall_h) / 2
        if overall_w <= 0 or overall_h <= 0:
            # Fallback: compute from item bounding box
            if items:
                overall_w = max(it['x'] + it['width'] for it in items)
                overall_h = max(it['y'] + it['height'] for it in items)
            else:
                return items
        
        super_base_x = m_left_pt + (usable_w - overall_w) / 2
        super_base_y = m_bottom_pt + (usable_h - overall_h) / 2
        
        # Match nup_engine lines 204-213:
        # abs_x = super_base_x + cell['x']
        # cell_y_from_bottom = super_base_y + (overall_h - cell['y'] - cell['height'])
        # abs_y = cell_y_from_bottom
        placements = []
        for it in items:
            abs_x = super_base_x + it['x']
            abs_y = super_base_y + (overall_h - it['y'] - it['height'])
            placements.append({
                'cluster_idx': 0,
                'cell': it,
                'abs_x': abs_x,
                'abs_y': abs_y,
                'width': it['width'],
                'height': it['height'],
                'original_cell_y': 0
            })
            
        base_rect_pts = (0, 0, item_w, item_h)
        if base_poly:
            minx, miny, maxx, maxy = base_poly.bounds
            base_rect_pts = (minx, miny, maxx, maxy)
        
        # Match nup_engine lines 243-245: only resolve if collisions actually exist
        initial_cols = detect_collisions(placements, zones, base_poly, base_rect_pts, sheet_h)
        if not initial_cols:
            return items
        
        resolved = smart_resolve_collisions(placements, zones, base_poly, base_rect_pts, sheet_w, sheet_h, margins)
        
        return [r['cell'] for r in resolved]
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Preview collision check failed: {e}")
        return items


@router.post("/preview-layout")
async def preview_layout(req: PreviewLayoutRequest):
    """
    Preview sticker layout — uses the SAME compute function as nup_engine
    to guarantee preview ≡ output.
    """
    
    if req.file_id:
        # ═══ SINGLE SOURCE OF TRUTH PATH ═══
        # Uses compute_sticker_layout_for_page() — identical to nup_engine
        if True:
            from app.workers import pdf_wrapper as pdf_lib
            from app.database import SessionLocal
            from app.models.job import UploadedFile as UploadedFileModel
            from app.workers.sticker_imposer_pkg.layout_compute import compute_sticker_layout_for_page
            
            logger.debug("[PREVIEW] file_id=%s usable=%.2fx%.2f item=%.2fx%.2f gap=%.2fx%.2f strategy=%s shape=%s props=%s",
                         req.file_id, req.usable_w, req.usable_h, req.item_w, req.item_h,
                         req.gap_x, req.gap_y, req.strategy, req.shape_type, req.shape_props)
            
            db = SessionLocal()
            try:
                db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == req.file_id).first()
                file_path = db_file.file_path if db_file else None
            finally:
                db.close()
            
            if not file_path or not os.path.exists(file_path):
                raise ValueError(f"File not found: {req.file_id}")
            
            logger.debug("   file_path=%s", file_path)
            
            doc = pdf_lib.open(file_path)
            
            page_idx = min(req.page_idx, doc.page_count - 1) if getattr(req, 'page_idx', 0) >= 0 else 0
            page = doc[page_idx]
            
            # ── N-Up MULTI-PAGE PREVIEW: bin-pack all pages together ──
            # task_mode can be 'nup' (user selected explicitly) or 'sticker_imposer' (initial default)
            _tm = getattr(req, 'task_mode', None)
            _lt = getattr(req, 'layout_type', None)
            _tq = getattr(req, 'target_quantity', 0)
            logger.debug("[PREVIEW DEBUG] task_mode=%r layout_type=%r target_qty=%s page_count=%d", _tm, _lt, _tq, doc.page_count)
            is_nup_multi = (
                _tm in ('nup', 'booklet', 'sticker_imposer')
                and _lt != 'repeat'
                and doc.page_count > 1
                and (_tq == 0 or bool(getattr(req, 'is_die_cut', False)))
            )
            
            if is_nup_multi:
                from app.workers.sticker_imposer_pkg.bin_packing import solve_auto_fill_mixed
                from app.workers.nup_diecut import _find_largest_die_path
                
                bleed_pt = req.bleed or 0

                # ── CNC ghép nhiều mẫu: dùng CHUNG helper với cnc_render (preview==output) ──
                if getattr(req, 'imposer_mode', None) == 'cnc':
                    from app.workers.cnc_layout import build_cnc_front_layout, select_front_pages
                    cnc_two_sided = bool(getattr(req, 'cnc_two_sided', False))
                    cnc_flip_edge = getattr(req, 'cnc_flip_edge', 'long') or 'long'
                    front_idxs, _back_of = select_front_pages(doc.page_count, cnc_two_sided)

                    _tqbp_cnc = getattr(req, 'target_quantities_by_page', None) or {}
                    _gq_cnc = getattr(req, 'target_quantity', 0) or 0
                    def _qty_cnc(pi):
                        q = _tqbp_cnc.get(str(pi), _tqbp_cnc.get(pi, _gq_cnc))
                        try:
                            q = int(q)
                        except (TypeError, ValueError):
                            q = 0
                        return q if q > 0 else 0

                    page_dims_qty = []
                    for pi in front_idxs:
                        pg = doc[pi]
                        lp = _find_largest_die_path(pg)
                        if lp:
                            tw, th = lp['rect'].width, lp['rect'].height
                        else:
                            tw = pg.rect.width - 2 * bleed_pt
                            th = pg.rect.height - 2 * bleed_pt
                        page_dims_qty.append((pi, tw, th, _qty_cnc(pi)))

                    cnc_layout = build_cnc_front_layout(
                        page_dims_qty, req.usable_w, req.usable_h,
                        gap=max(req.gap_x, req.gap_y),
                        margin_left=getattr(req, 'margin_left', 0) or 0,
                        margin_bottom=getattr(req, 'margin_bottom', 0) or 0,
                        margin_top=getattr(req, 'margin_top', 0) or 0,
                    )
                    doc.close()
                    items = [{
                        'x': c['x'], 'y': c['y'], 'width': c['width'], 'height': c['height'],
                        'isRotated': c['isRotated'], 'isRotated180': False, 'pageIdx': c['pageIdx'],
                    } for c in cnc_layout['cells']]
                    return {
                        "success": True,
                        "cells": items,
                        "overallWidth": cnc_layout['overall_w'],
                        "overallHeight": cnc_layout['overall_h'],
                        "totalItems": cnc_layout['items_per_sheet'],
                        "sheetsNeeded": cnc_layout['sheets_needed'],
                        "strategyUsed": "cnc_mixed",
                        "isMixedPreview": True,
                        "isCncPreview": True,
                        "cncTwoSided": cnc_two_sided,
                        "cncFlipEdge": cnc_flip_edge,
                        "placedByPage": {str(k): v for k, v in (cnc_layout.get('placed_by_page') or {}).items()},
                    }

                page_dims = []
                for pi in range(doc.page_count):
                    pg = doc[pi]
                    lp = _find_largest_die_path(pg)
                    if lp:
                        r = lp['rect']
                        tw, th = r.width, r.height
                    else:
                        # Dùng MediaBox (rect) — khớp nup_engine; không ưu tiên TrimBox.
                        tw, th = pg.rect.width, pg.rect.height
                        tw -= 2 * bleed_pt
                        th -= 2 * bleed_pt
                    page_dims.append((pi, tw, th))
                
                # Sort by min dimension descending — MUST match nup_engine line 330
                grouping_strategy = getattr(req, 'grouping_strategy', None) or 'maximize_area'
                if grouping_strategy != 'none':
                    page_dims.sort(key=lambda x: min(x[1], x[2]), reverse=True)
                
                gap_x_pt = req.gap_x
                gap_y_pt = req.gap_y
                
                # ── Pre-compute forbidden zones from ốc/pont marks ──
                # Convert from sheet-absolute PDF coords to usable-area top-down coords
                exclude_zones = []
                pont_config = getattr(req, 'pont_config', None)
                if pont_config and not pont_config.get('disableCollision', False) and getattr(req, 'sheet_w', None) and getattr(req, 'sheet_h', None):
                    try:
                        from app.workers.pont_collision import calculate_forbidden_zones, MM_TO_PTS
                        
                        sheet_w_full = req.sheet_w
                        sheet_h_full = req.sheet_h
                        m_left_pt = getattr(req, 'margin_left', 0) or 0
                        m_bottom_pt = getattr(req, 'margin_bottom', 0) or 0
                        
                        margins = {
                            'top': pont_config.get('marginTop') * MM_TO_PTS if pont_config.get('marginTop') is not None else m_bottom_pt,
                            'bottom': pont_config.get('marginBottom') * MM_TO_PTS if pont_config.get('marginBottom') is not None else m_bottom_pt,
                            'left': pont_config.get('marginLeft') * MM_TO_PTS if pont_config.get('marginLeft') is not None else m_left_pt,
                            'right': pont_config.get('marginRight') * MM_TO_PTS if pont_config.get('marginRight') is not None else m_left_pt,
                        }
                        
                        zones = calculate_forbidden_zones(pont_config, margins, sheet_w_full, sheet_h_full)
                        if zones:
                            m_top_pt = margins.get('top', m_bottom_pt)
                            for z in zones:
                                # z is a Shapely Polygon/box in PDF coords (origin bottom-left, y-up)
                                # .bounds → (minx, miny, maxx, maxy)
                                zminx, zminy, zmaxx, zmaxy = z.bounds
                                zw = zmaxx - zminx
                                zh = zmaxy - zminy
                                
                                # Convert from sheet PDF coords to usable-area top-down coords
                                # Usable area starts at (margin_left, margin_bottom) in PDF
                                # Packer coords: origin at top-left of usable area, y increases downward
                                px = zminx - m_left_pt
                                py = req.usable_h - (zminy - m_bottom_pt + zh)
                                
                                # Expand zone slightly to include gap buffer
                                gap_buf = max(gap_x_pt, gap_y_pt) / 2
                                px -= gap_buf
                                py -= gap_buf
                                zw += gap_buf * 2
                                zh += gap_buf * 2
                                
                                exclude_zones.append((px, py, zw, zh))
                            
                            logger.debug("[BIN-PACK PREVIEW] %d exclude zones from pont/oc", len(exclude_zones))
                    except Exception as e:
                        import logging
                        logging.getLogger(__name__).warning(f"Mixed preview zone calc failed: {e}")
                        exclude_zones = []
                
                # Chọn solver KHỚP engine: có số lượng → offset_mixed (trộn theo tỉ lệ SL);
                # không số lượng → auto_fill_mixed (nhồi đầy 1 tờ). → preview == output.
                _tqbp = getattr(req, 'target_quantities_by_page', None) or {}
                _global_q = getattr(req, 'target_quantity', 0) or 0
                def _qty_for_page(pi):
                    q = _tqbp.get(str(pi), _tqbp.get(pi, _global_q))
                    try:
                        q = int(q)
                    except (TypeError, ValueError):
                        q = 0
                    return q if q > 0 else 0
                _total_q = sum(_qty_for_page(pi) for pi, _, _ in page_dims)

                if _total_q > 0:
                    from app.workers.sticker_imposer_pkg.bin_packing import solve_offset_mixed
                    page_dims_qty = [(pi, tw, th, _qty_for_page(pi)) for pi, tw, th in page_dims if _qty_for_page(pi) > 0]
                    if not page_dims_qty:
                        page_dims_qty = [(pi, tw, th, 1) for pi, tw, th in page_dims]
                    bp_result = solve_offset_mixed(
                        sheet_w=req.usable_w,
                        sheet_h=req.usable_h,
                        page_dims_qty=page_dims_qty,
                        gap=max(gap_x_pt, gap_y_pt),
                        allow_rotation=True,
                    )
                else:
                    bp_result = solve_auto_fill_mixed(
                        sheet_w=req.usable_w,
                        sheet_h=req.usable_h,
                        page_dims=page_dims,
                        gap=max(gap_x_pt, gap_y_pt),
                        allow_rotation=True,
                        exclude_zones=exclude_zones if exclude_zones else None,
                    )
                
                doc.close()
                
                items = []
                for p in bp_result['placements']:
                    items.append({
                        'x': p['x'],
                        'y': p['y'],
                        'width': p['w'],
                        'height': p['h'],
                        'isRotated': p['is_rotated'],
                        'isRotated180': False,
                        'pageIdx': p['page_idx'],
                    })
                
                overall_w = max((it['x'] + it['width'] for it in items), default=0)
                overall_h = max((it['y'] + it['height'] for it in items), default=0)
                
                logger.debug("[BIN-PACK PREVIEW] %d items, overall=%.1fx%.1f, zones=%d", len(items), overall_w, overall_h, len(exclude_zones))
                
                return {
                    "success": True,
                    "cells": items,
                    "overallWidth": overall_w,
                    "overallHeight": overall_h,
                    "totalItems": len(items),
                    "strategyUsed": "bin_pack_mixed",
                    "isMixedPreview": True,
                }
            
            # ── SINGLE-PAGE PREVIEW (S&R or single-page N-Up) ──
            # Determine shape override from frontend
            shape_override = req.shape_type if req.shape_type and req.shape_type != 'CUSTOM' else None
            if req.shape_type == 'CUSTOM':
                shape_override = 'CUSTOM'  # Explicit CUSTOM choice
            
            logger.debug("shape_override=%s", shape_override)
            logger.debug("CALLING compute_sticker_layout_for_page...")
            
            bleed_pt = req.bleed or 0
            
            is_cluster = req.grouping_strategy == 'cluster_tile'
            req_cluster_w = req.cluster_w
            req_cluster_h = req.cluster_h
            
            if is_cluster:
                if req.cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
                    if req.cluster_sizing_mode == 'split_cols':
                        cluster_cols = max(1, req.cluster_cols or 2)
                        cluster_rows = 1
                    elif req.cluster_sizing_mode == 'split_rows':
                        cluster_cols = 1
                        cluster_rows = max(1, req.cluster_rows or 2)
                    else:
                        cluster_cols = max(1, req.cluster_cols or 2)
                        cluster_rows = max(1, req.cluster_rows or 2)
                        
                    req_cluster_w = (req.usable_w - (cluster_cols - 1) * (req.tile_gap_x or 0)) / cluster_cols
                    req_cluster_h = (req.usable_h - (cluster_rows - 1) * (req.tile_gap_y or 0)) / cluster_rows
                
                # Fallback if invalid
                if not req_cluster_w or not req_cluster_h:
                    req_cluster_w = 148.0 * 2.83465
                    req_cluster_h = 210.0 * 2.83465

            compute_w = req_cluster_w if is_cluster else req.usable_w
            compute_h = req_cluster_h if is_cluster else req.usable_h

            if not getattr(req, 'is_die_cut', False) and _tm in ('nup', 'step_repeat', 'booklet'):
                from app.workers.nup_layout_solver import solve_optimal_layout, solve_manual
                trim_w = max(req.item_w - 2 * bleed_pt, 1.0)
                trim_h = max(req.item_h - 2 * bleed_pt, 1.0)
                if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                    result = solve_manual(trim_w, trim_h, req.gap_x, req.gap_y, req.cols, req.rows)
                else:
                    result = solve_optimal_layout(
                        usable_w=compute_w,
                        usable_h=compute_h,
                        orig_w=trim_w,
                        orig_h=trim_h,
                        gap_x=req.gap_x,
                        gap_y=req.gap_y,
                        strategy=req.strategy,
                        secondary_gap=getattr(req, 'split_gap', None)
                    )
                result['shapeType'] = 'CUSTOM'
                result['strategyUsed'] = req.strategy
                result['widthUsed'] = result.get('overallWidth', 0)
                result['heightUsed'] = result.get('overallHeight', 0)
                result['items'] = result.get('cells', [])
            else:
                from app.workers.nup_sticker import compute_sticker_layout_for_page
                result = compute_sticker_layout_for_page(
                    page=page,
                    sheet_usable_w=compute_w,
                    sheet_usable_h=compute_h,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    strategy=req.strategy,
                    shape_type_override=shape_override,
                    bleed_pt=bleed_pt,
                )

            if is_cluster:
                from app.workers.cluster_tile_engine import run_cluster_tile
                
                # Mock inputs to run_cluster_tile to match exactly what nup_engine does
                p_idx = 0
                items = result.get("items", [])
                full_layouts = {
                    p_idx: {
                        'items': items,
                        'widthUsed': result.get("widthUsed", 0),
                        'heightUsed': result.get("heightUsed", 0)
                    }
                }
                
                ct_placements, _ = run_cluster_tile(
                    page_infos=[(p_idx, 1, req.item_w, req.item_h)],
                    full_layouts=full_layouts,
                    sheet_w=req.usable_w,
                    sheet_h=req.usable_h,
                    cluster_w=req_cluster_w,
                    cluster_h=req_cluster_h,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    tile_gap_x=req.tile_gap_x or req.gap_x,
                    tile_gap_y=req.tile_gap_y or req.gap_y,
                    cluster_nesting=True,
                    is_die_cut=True
                )
                
                if ct_placements:
                    min_x = min(place.get('abs_x', 0) for place in ct_placements)
                    min_y = min(place.get('abs_y', 0) for place in ct_placements)
                else:
                    min_x = 0
                    min_y = 0

                new_items = []
                max_w = 0
                max_h = 0
                for place in ct_placements:
                    c = place.get('cell', {})
                    x = place.get('abs_x', 0) - min_x
                    y = place.get('abs_y', 0) - min_y
                    w = place.get('width', 0)
                    h = place.get('height', 0)
                    max_w = max(max_w, x + w)
                    max_h = max(max_h, y + h)
                    
                    new_items.append({
                        'x': x,
                        'y': y,
                        'width': w,
                        'height': h,
                        'isRotated': c.get('isRotated', False),
                        'isRotated180': c.get('isRotated180', False),
                        'blockId': place.get('cluster_idx', 0)
                    })
                
                result['items'] = new_items
                result['widthUsed'] = max_w
                result['heightUsed'] = max_h
                result['strategyUsed'] = 'cluster_tile'
            base_poly = None
            if getattr(req, 'pont_config', None) and not req.pont_config.get('disableCollision', False):
                if getattr(req, 'shape_type', None) == 'CIRCLE_ELLIPSE':
                    from shapely.geometry import Point
                    from shapely.affinity import scale
                    # Use a highly detailed mathematical polygon (256 sides) for Ellipse
                    base_poly = scale(Point(0,0).buffer(1.0, resolution=64), xfact=req.item_w / 2.0, yfact=req.item_h / 2.0)
                else:
                    from app.workers.pont_collision import build_shapely_polygon_from_paths
                    paths = page.extract_vector_paths()
                    if paths:
                        base_poly = build_shapely_polygon_from_paths(paths, page.rect)
            
            doc.close()
            
            items = result.get("items", [])
            logger.debug("PREVIEW result: items_before_collision=%d", len(items))
            
            # Note: collision resolution is already done inside compute_sticker_layout_for_page
            # via solve_optimal_sticker_layout → resolve_layout_collisions
            # Apply pont collision separately (sheet-level, not item-level)
            items = apply_preview_collisions(items, req.item_w, req.item_h, req, result.get("widthUsed", 0), result.get("heightUsed", 0), base_poly)
            
            logger.debug("PREVIEW result: items_after_pont_collision=%d", len(items))
            
            logger.info(f"[PREVIEW] compute_sticker_layout_for_page: shape={result.get('shapeType')} items={len(items)}")
            
            return {
                "success": True,
                "cells": items,
                "overallWidth": result.get("widthUsed", 0),
                "overallHeight": result.get("heightUsed", 0),
                "totalItems": len(items),
                "strategyUsed": result.get("strategyUsed", "")
            }
            

    # FALLBACK: No file_id — use direct solver (backward compat)
    if not req.file_id:
        logger.debug("[PREVIEW FALLBACK] file_id=%s using direct solver", req.file_id)
        logger.debug("   This means preview will NOT match nup_engine output!")
        
        bleed_pt = req.bleed or 0
        trim_w = max(req.item_w - 2 * bleed_pt, 1.0)
        trim_h = max(req.item_h - 2 * bleed_pt, 1.0)
        
        _tm = getattr(req, 'task_mode', None)
        
        if not getattr(req, 'is_die_cut', False) and _tm in ('nup', 'step_repeat', 'booklet'):
            from app.workers.nup_layout_solver import solve_optimal_layout, solve_manual
            if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                result = solve_manual(trim_w, trim_h, req.gap_x, req.gap_y, req.cols, req.rows)
            else:
                result = solve_optimal_layout(
                    usable_w=req.usable_w,
                    usable_h=req.usable_h,
                    orig_w=trim_w,
                    orig_h=trim_h,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    strategy=req.strategy,
                    secondary_gap=getattr(req, 'split_gap', None)
                )
            result['shapeType'] = 'CUSTOM'
            result['strategyUsed'] = req.strategy
            result['widthUsed'] = result.get('overallWidth', 0)
            result['heightUsed'] = result.get('overallHeight', 0)
            result['items'] = result.get('cells', [])
        else:
            from app.workers.sticker_imposer import solve_optimal_sticker_layout
            result = solve_optimal_sticker_layout(
                usable_w=req.usable_w,
                usable_h=req.usable_h,
                item_w=trim_w,
                item_h=trim_h,
                gap_x=req.gap_x,
                gap_y=req.gap_y,
                shape_type=req.shape_type,
                shape_props=req.shape_props,
                strategy=req.strategy
            )
        
        items = result.get("items", [])
        items = apply_preview_collisions(items, req.item_w, req.item_h, req, result.get("widthUsed", 0), result.get("heightUsed", 0))
        
        ret_data = {
            "success": True,
            "cells": items,
            "overallWidth": result.get("widthUsed", 0),
            "overallHeight": result.get("heightUsed", 0),
            "totalItems": len(items),
            "strategyUsed": result.get("strategyUsed", "")
        }
    
        try:
            import json
            from pathlib import Path
            desktop = os.path.join(str(Path.home()), "Desktop")
            log_path = os.path.join(desktop, "debug_nup_l_shape.txt")
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"\n--- LOG FROM PREVIEW_LAYOUT (BACKEND) ---\n")
                f.write(f"REQUEST PARAMS:\n")
                f.write(json.dumps(req.dict(), indent=2, ensure_ascii=False) + "\n")
                f.write(f"INTERNAL SOLVER PARAMS:\n")
                f.write(json.dumps({
                    "compute_usable_w": req.usable_w,
                    "compute_usable_h": req.usable_h,
                    "trim_w": trim_w,
                    "trim_h": trim_h,
                    "gap_x": req.gap_x,
                    "gap_y": req.gap_y,
                    "strategy": req.strategy,
                    "secondary_gap": getattr(req, 'split_gap', None)
                }, indent=2) + "\n")
                f.write(f"PREVIEW RESULTS (totalItems: {len(items)}, width: {ret_data['overallWidth']}, height: {ret_data['overallHeight']}):\n")
        except Exception as e:
            logger.error(f"Failed to write preview log: {e}")
    
        return ret_data
    
    # If we reached here, something went wrong with the primary flow and we didn't return
    # This shouldn't happen unless an exception was thrown, but we don't catch all exceptions anymore.
    raise HTTPException(status_code=500, detail="Unexpected error during preview layout")


from typing import List

class PreviewLayoutBatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    
    usable_w: float
    usable_h: float
    gap_x: float
    gap_y: float
    strategy: str
    pages: List[Dict[str, Any]]
    pont_config: Optional[Dict[str, Any]] = None
    sheet_w: Optional[float] = None
    sheet_h: Optional[float] = None
    margin_left: Optional[float] = None
    margin_bottom: Optional[float] = None
    task_mode: Optional[str] = None

@router.post("/preview-layouts-batch")
async def preview_layouts_batch(req: PreviewLayoutBatchRequest):
    results = {}
    for p in req.pages:
        page_idx = p.get("page_idx")
        bleed_pt = getattr(req, "bleed", 0) or 0
        item_w = p.get("item_w", 0)
        item_h = p.get("item_h", 0)
        trim_w = max(item_w - 2 * bleed_pt, 1.0)
        trim_h = max(item_h - 2 * bleed_pt, 1.0)
        
        if req.task_mode in ('nup', 'step_repeat', 'booklet'):
            from app.workers.nup_layout_solver import solve_optimal_layout
            res = solve_optimal_layout(
                usable_w=req.usable_w,
                usable_h=req.usable_h,
                orig_w=trim_w,
                orig_h=trim_h,
                gap_x=req.gap_x,
                gap_y=req.gap_y,
                strategy=req.strategy,
                secondary_gap=getattr(req, 'split_gap', None)
            )
            items = res.get('cells', [])
        else:
            from app.workers.sticker_imposer import solve_optimal_sticker_layout
            res = solve_optimal_sticker_layout(
                usable_w=req.usable_w,
                usable_h=req.usable_h,
                item_w=trim_w,
                item_h=trim_h,
                gap_x=req.gap_x,
                gap_y=req.gap_y,
                shape_type=p.get("shape_type", "CUSTOM"),
                shape_props=p.get("shape_props", {}),
                strategy=req.strategy
            )
            items = res.get("items", [])
            
        items = apply_preview_collisions(items, item_w, item_h, req, res.get("widthUsed", res.get('overallWidth', 0)), res.get("heightUsed", res.get('overallHeight', 0)))
        results[page_idx] = len(items)
        
    return {"success": True, "capacities": results}
