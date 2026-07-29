import os
import shutil
import tempfile
import logging
import contextlib
import re
import time
import asyncio
from pathlib import Path
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends
from fastapi.responses import FileResponse
from app.core.license_guard import require_license, require_feature, enforce_feature
from app.core.heavy_job_scheduler import scheduled_job
from app.schemas.imposition import ImpositionResponse
import uuid

from app.config import settings
from app.utils.errors import raise_http

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imposition", tags=["Imposition"], dependencies=[Depends(require_license)])

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)

def _setting_value(settings, *names, default=None):
    """Read a setting from either the JSON body or a Pydantic request."""
    for name in names:
        if isinstance(settings, dict) and name in settings:
            return settings[name]
        if hasattr(settings, name):
            return getattr(settings, name)
    return default


def _imposition_feature(settings) -> str:
    """Map an execution/preview request to its exact entitlement."""
    imposer_mode = str(_setting_value(
        settings, "imposerMode", "imposer_mode", default=""
    ) or "").strip().lower()
    task_mode = str(_setting_value(
        settings, "taskMode", "task_mode", default=""
    ) or "").strip().lower()
    is_diecut = bool(_setting_value(
        settings, "isDieCutMode", "is_die_cut", default=False
    ))
    page_sheet_mode = bool(_setting_value(
        settings, "page_sheet_mode", default=False
    ))

    # CNC also carries isDieCutMode=true, so it must be checked first.
    if imposer_mode == "cnc" or task_mode in ("cnc", "cnc_imposer"):
        return "impo.cnc"
    if page_sheet_mode:
        return "impo.diecut"
    if task_mode == "booklet":
        return "impo.booklet"
    if is_diecut or imposer_mode in ("diecut", "sticker", "sticker_imposer"):
        return "impo.diecut"
    return "impo.nup"

# ── Allowed directories for file path inputs ──
# Desktop (Tauri) chạy loopback-only như chính người dùng → mặc định cho phép mọi
# .pdf local hợp lệ. Khi deploy web/đa người dùng, đặt env IMPOSITION_RESTRICT_PATHS=1
# để BẬT allowlist (chống LFI). Thêm thư mục cho phép qua IMPOSITION_ALLOWED_DIRS
# (ngăn cách bằng os.pathsep).
_ALLOWED_DIRS = [
    os.path.abspath(UPLOAD_DIR),
    os.path.abspath(RESULTS_DIR),
    os.path.abspath(tempfile.gettempdir()),
]
for _d in (os.environ.get("IMPOSITION_ALLOWED_DIRS", "") or "").split(os.pathsep):
    if _d.strip():
        _ALLOWED_DIRS.append(os.path.abspath(_d.strip()))

_RESTRICT_PATHS = (os.environ.get("IMPOSITION_RESTRICT_PATHS", "") or "").strip().lower() in ("1", "true", "yes", "on")


def _validate_file_path(path: str | None, must_exist: bool = True) -> str:
    """
    Validate a client-supplied file path to prevent path traversal attacks.
    Returns the resolved absolute path if valid, raises HTTPException otherwise.
    """
    if not path:
        raise HTTPException(status_code=400, detail="File path is required.")

    # Chặn traversal theo THÀNH PHẦN path (không chặn nhầm tên file hợp lệ có chứa
    # chuỗi '..', ví dụ "report..final.pdf"). Chỉ chặn khi '..' là một segment đường dẫn.
    _parts = re.split(r'[\\/]+', path)
    if any(p == '..' for p in _parts):
        raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed.")

    resolved = os.path.abspath(path)

    # Reject symbolic links tại path đích. Khi BẬT chế độ hạn chế (web/đa người dùng),
    # kiểm tra CHẶT hơn: realpath giải mọi symlink/junction ở thư mục cha; nếu khác
    # resolved (đã chuẩn hoá hoa/thường + dấu phân cách) → có link trung gian → từ chối.
    # KHÔNG áp realpath ở desktop mode: trên Windows realpath có thể đổi casing ổ đĩa /
    # giải 8.3 → false-positive chặn nhầm file hợp lệ của chính người dùng.
    if os.path.islink(resolved):
        raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed.")
    if _RESTRICT_PATHS and os.path.normcase(os.path.realpath(resolved)) != os.path.normcase(resolved):
        raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed.")

    # Must be a PDF file
    if not resolved.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    # Desktop App (Tauri) mode: backend loopback-only, người dùng truy cập file local
    # của chính mình → cho phép mọi path. Khi BẬT IMPOSITION_RESTRICT_PATHS (web/đa
    # người dùng) → ép path nằm trong _ALLOWED_DIRS (defense-in-depth chống LFI).
    if _RESTRICT_PATHS:
        if not any(
            os.path.commonpath([resolved, d]) == d
            for d in _ALLOWED_DIRS
        ):
            raise HTTPException(status_code=403, detail="Invalid path: outside allowed directories.")

    if must_exist and not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    return resolved

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
        raise_http(e, "Mở khoá PDF thất bại")

@router.post("/execute-plan")
async def execute_plan_imposition(
    file: UploadFile = File(...),
    plan_json: str = Form(...),
    license_info: dict = Depends(require_feature("impo.booklet")),
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
        logger.warning(f"Invalid JSON plan: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON plan")
    
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
        raise_http(e, "Thực thi kế hoạch bình thất bại")
    except Exception as e:
        raise_http(e, "Thực thi kế hoạch bình thất bại")

@router.post("/execute-plan-json")
async def execute_plan_json(body: dict, license_info: dict = Depends(require_feature("impo.booklet"))):
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
    else:
        # #B3: nếu không có override, đường nguồn lấy từ plan (do client gửi) → vẫn
        # PHẢI validate (chống path traversal / đọc file ngoài phạm vi). Validate ở
        # đây rồi truyền xuống PlanExecutor để bảo đảm đường hiệu dụng đã kiểm.
        _plan_src = plan.get("source_pdf_path") if isinstance(plan, dict) else None
        if not _plan_src:
            raise HTTPException(status_code=400, detail="Missing source PDF path in plan.")
        source_override = _validate_file_path(_plan_src)
    
    try:
        output_path = await PlanExecutor.execute(plan, source_override)
        if body.get("return_output_path"):
            return {
                "success": True,
                "output_path": os.path.abspath(output_path),
                "output_filename": os.path.basename(output_path),
            }
        return FileResponse(
            path=output_path,
            filename="imposed_output.pdf",
            media_type="application/pdf"
        )
    except PlanExecutionError as e:
        raise_http(e, "Thực thi kế hoạch bình thất bại")
    except Exception as e:
        raise_http(e, "Thực thi kế hoạch bình thất bại")

# GS-SUNSET (2026-07-28): ba route `/viewer-preview/*` đã được CÁCH LY sang
# `attic/gs-sunset-2026-07-28/`. Chúng dựng preview tạm bằng Ghostscript, mà GS bị chặn
# vô điều kiện ở `subprocess_utils._guard_ghostscript` → luôn trả 503 → frontend lùi về
# PDFium. Bên gọi duy nhất (`desktop/src/lib/viewerPreview.ts`) cũng không được import ở
# đâu. Muốn có lại lớp preview tạm thì viết bằng PPE/pdfium, đừng khôi phục đường GS.

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
                    if re.search(br'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[kK](?:\s|$)', contents):
                        cmyk += 1
                    elif re.search(br'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[rgRG](?:\s|$)', contents):
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
        raise_http(e, "Trích xuất layer OCG thất bại")

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
        raise_http(e, "Render preview layer thất bại")

@router.post("/pdf-text")
async def get_pdf_text(body: dict):
    """
    Trích text CÓ TOẠ ĐỘ cho chế độ XEM THƯỜNG (quét chữ + copy như Acrobat).
    Chỉ lấy text THẬT trong PDF (không OCR) — file scan/ảnh/chữ đã outline sẽ ra rỗng,
    y hệt Acrobat khi chưa chạy OCR.

    Expects: { "path": "...", "page": 1 }   (page 1-based)
    Returns: {
        "blocks": [ { "lines": [ { "bbox": {x,y,w,h}, "chars": [{c}] } ] } ],
        "page_width_pt": float, "page_height_pt": float
    }
    bbox ở POINT, gốc TRÊN-TRÁI (pdfplumber `top`), khớp cách text layer đặt span.
    Dòng gộp bằng pdfplumber extract_text_lines (theo y_tolerance chuẩn).
    """
    import pdfplumber

    pdf_path = _validate_file_path(body.get("path"))
    page = int(body.get("page", 1))

    try:
        with pdfplumber.open(pdf_path) as pdf:
            if page < 1 or page > len(pdf.pages):
                return {"blocks": [], "page_width_pt": 0.0, "page_height_pt": 0.0}
            pg = pdf.pages[page - 1]
            # extract_text_lines gộp dòng CHUẨN theo y_tolerance của pdfplumber (dựa
            # trên chars, không phình band như gộp thủ công) → không nuốt dòng kề.
            # Mỗi line có: text, x0, x1, top, bottom (đơn vị point, gốc trên-trái).
            text_lines = pg.extract_text_lines(strip=True)

            out_lines = []
            for ln in text_lines:
                text = ln.get("text", "")
                if not text:
                    continue
                x0 = float(ln.get("x0", 0)); top = float(ln.get("top", 0))
                x1 = float(ln.get("x1", 0)); bottom = float(ln.get("bottom", 0))
                out_lines.append({
                    "bbox": {"x": x0, "y": top, "w": x1 - x0, "h": bottom - top},
                    "chars": [{"c": ch} for ch in text],
                })

            return {
                "blocks": [{"lines": out_lines}],
                "page_width_pt": float(pg.width),
                "page_height_pt": float(pg.height),
            }
    except Exception as e:
        raise_http(e, "Trích xuất text PDF thất bại")

@router.post("/pdf-meta")
async def get_pdf_meta(body: dict):
    """
    Read PDF metadata (page count, dimensions, rotations) using pypdfium2.
    
    This allows the TypeScript Planner to get the info it needs for computation
    WITHOUT loading the entire PDF into the Webview's RAM.
    
    Expects body: { "path": "C:/Users/.../catalog.pdf" }
    """
    from app.workers import pdf_wrapper as pdf_lib
    from app.core.imposition_page_box import effective_imposition_box
    
    pdf_path = _validate_file_path(body.get("path"))
    
    try:
        pdf = pdf_lib.open(pdf_path)
        page_count = len(pdf)
        pages = []
        max_w = 0.0
        max_h = 0.0
        
        # Page sizes can differ after resize; return metadata for every page.
        scan_limit = page_count
        
        _PT_TO_MM = 1.0 / 2.83465
        detected_bleed_mm = 0.0  # bleed suy ra từ (MediaBox - TrimBox)/2 của trang đầu
        for i in range(scan_limit):
            page = pdf[i]
            # MediaBox giữ bleed khi chênh lệch nhỏ; CropBox là trang logic khi
            # MediaBox thực chất là canvas lớn chứa nhiều trang đặt cạnh nhau.
            src_box = effective_imposition_box(page)
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
            media_w = float(page.mediabox.width) * user_unit
            media_h = float(page.mediabox.height) * user_unit
            
            # Adjust visual dimensions for rotation
            if rot in (90, 270):
                visual_w, visual_h = h, w
                media_visual_w, media_visual_h = media_h, media_w
            else:
                visual_w, visual_h = w, h
                media_visual_w, media_visual_h = media_w, media_h
            
            if visual_w > max_w:
                max_w = visual_w
            if visual_h > max_h:
                max_h = visual_h
            
            pages.append({
                "index": i,
                "width_pt": round(visual_w, 2),
                "height_pt": round(visual_h, 2),
                "media_width_pt": round(media_visual_w, 2),
                "media_height_pt": round(media_visual_h, 2),
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
        raise_http(e, "Đọc metadata PDF thất bại")

# Cache kết quả nhận diện theo (path tuyệt đối, mtime, size) → đổi công cụ / mở lại
# cùng file trả tức thì, không tính lại. Bounded để tránh phình bộ nhớ.
_DETECT_CACHE: dict = {}
_DETECT_CACHE_MAX = 32
_DETECT_INFLIGHT: dict = {}


def _make_detect_cache_key(file_path, config):
    """Cache key for both the PDF revision and the detection configuration."""
    try:
        st = os.stat(file_path)
        config_key = (
            tuple(config.die_channel_names or ()),
            tuple(tuple(c) for c in (config.die_colors or ())),
            float(config.die_color_tol),
            int(config.raster_fallback_dpi),
        )
        return (
            os.path.normcase(os.path.abspath(file_path)),
            int(st.st_mtime_ns),
            int(st.st_size),
            config_key,
        )
    except Exception:
        return None


async def _run_shared_detection(cache_key, work):
    """Share one in-flight detection task for the same PDF and configuration."""
    if cache_key is None:
        return await work()

    import asyncio
    task = _DETECT_INFLIGHT.get(cache_key)
    if task is None:
        task = asyncio.create_task(work())
        _DETECT_INFLIGHT[cache_key] = task

        def _cleanup(done_task, key=cache_key):
            if _DETECT_INFLIGHT.get(key) is done_task:
                _DETECT_INFLIGHT.pop(key, None)
            try:
                done_task.exception()
            except BaseException:
                pass

        task.add_done_callback(_cleanup)

    # A disconnected/stale client must not cancel work shared with another caller.
    return await asyncio.shield(task)


async def _raster_fallback_shape(engine, file_path, page_idx, config, _logger):
    """Nhánh raster fallback (Ghostscript/IO bất đồng bộ) — gọi build_shape_from_raster.

    Logic phân loại nằm trong module Detection (SSOT); route chỉ làm phần IO.
    Trả DetectedShape (source=raster_fallback) hoặc None nếu không thấy spot.
    """
    import numpy as np
    import base64
    import zlib
    import time as _t
    from app.workers.die_detection import build_shape_from_raster
    from app.utils.preview_perf_log import log as _perf

    _t0 = _t.perf_counter()
    try:
        sep_result = await engine.extract_separations(
            file_path, page_num=page_idx + 1,
            dpi=config.raster_fallback_dpi, use_ghostscript=True,
        )
    except Exception as e:
        _logger.warning(f"Spot extraction on page {page_idx + 1} failed: {e}")
        _perf("DETECT", "raster_fallback FAIL", page=page_idx, ms=(_t.perf_counter() - _t0) * 1000, err=str(e)[:80])
        return None

    plates = [
        p for p in sep_result.get("plates", [])
        # Bất kỳ plate KHÔNG phải process color (CMYK) → ứng viên kênh khuôn (spot).
        if p["name"] not in ("Cyan", "Magenta", "Yellow", "Black")
    ]
    if not plates:
        return None

    # Ưu tiên plate có TÊN khớp kênh khuôn cấu hình (CutContour/Dieline/…) — nhất
    # quán với _select_from_paths ở đường vector (tên kênh > spot bất kỳ). Khi không
    # plate nào khớp tên, giữ THỨ TỰ GỐC (plate spot đầu tiên) như cũ (sort ổn định).
    from app.workers.die_detection import _match_die_channel
    _names = frozenset(n.strip().lower() for n in (config.die_channel_names or ()))
    plates.sort(key=lambda p: 0 if _match_die_channel(p.get("name"), _names) else 1)

    import cv2
    for p in plates:
        try:
            raw_bytes = zlib.decompress(base64.b64decode(p["alpha_data"]))
            h = sep_result["height"]
            w = sep_result["width"]
            mask = np.frombuffer(raw_bytes, dtype=np.uint8).reshape((h, w))
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                solid = np.zeros_like(mask)
                cv2.drawContours(solid, contours, -1, 255, cv2.FILLED)
                mask = solid
            ys, xs = np.where(mask > 0)
            if len(ys) == 0:
                continue
            dpi = config.raster_fallback_dpi
            spot_w = float((xs.max() - xs.min()) * 72.0 / dpi)
            spot_h = float((ys.max() - ys.min()) * 72.0 / dpi)
            shape = build_shape_from_raster(page_idx, mask, spot_w, spot_h)
            _perf(
                "DETECT", "raster_fallback OK",
                page=page_idx, ms=(_t.perf_counter() - _t0) * 1000,
                plate=str(p.get("name", ""))[:40],
            )
            return shape
        except Exception as e:
            _logger.warning(f"Raster classify page {page_idx + 1} failed: {e}")
            continue
    _perf("DETECT", "raster_fallback none", page=page_idx, ms=(_t.perf_counter() - _t0) * 1000)
    return None


def _raster_fallback_budget(
    shapes,
    statuses,
    *,
    max_tries=None,
    fail_streak_stop: int = 2,
) -> dict:
    """Quyết định có chạy Ghostscript raster fallback không / bao nhiêu trang.

    Log thực tế (tron.pdf 28 trang): vector xong ~16ms (1 separation + 27 custom),
    rồi 27× GS @144dpi hits=0 → 9–27s. Budget:
      - Đã có ≥1 trang vector/separation/xobject → chỉ probe 1 trang custom;
        miss → dừng (file homogeneous: khuôn ở 1 trang, còn lại artwork).
      - Toàn custom → tối đa max_tries (mặc định 3), dừng sau fail_streak_stop miss liên tiếp.
      - Hard cap max_tries luôn áp dụng.
    """
    import os as _os

    if max_tries is None:
        try:
            max_tries = int((_os.environ.get("PRYNX_DETECT_RASTER_MAX") or "3").strip())
        except ValueError:
            max_tries = 3
    max_tries = max(0, min(max_tries, 50))

    candidates: list[int] = []
    vector_ok = 0
    for i, shape in enumerate(shapes):
        src = getattr(shape, "source", None) or ""
        st = statuses[i] if i < len(statuses) else None
        ok = bool(getattr(st, "ok", True)) if st is not None else True
        if src in ("vector", "separation", "xobject"):
            vector_ok += 1
            continue
        if src == "custom" and ok:
            candidates.append(i)

    if not candidates or max_tries == 0:
        return {
            "indices": [],
            "max_tries": 0,
            "fail_streak_stop": fail_streak_stop,
            "reason": "none_or_disabled",
            "vector_ok": vector_ok,
            "custom_n": len(candidates),
        }

    # Đã có khuôn vector: raster hiếm khi cứu 20+ trang CUSTOM (hits=0 trên tron.pdf).
    if vector_ok >= 1:
        budget = min(1, max_tries, len(candidates))
        reason = "probe_only_has_vector_master"
    else:
        budget = min(max_tries, len(candidates))
        reason = "all_custom_capped"

    return {
        "indices": candidates[:budget] if budget else [],
        # allow early-stop within the candidate list up to budget
        "max_tries": budget,
        "fail_streak_stop": fail_streak_stop,
        "reason": reason,
        "vector_ok": vector_ok,
        "custom_n": len(candidates),
        # full candidate list for streak logic (we only *start* raster on first `budget`
        # pages, but if first hits we can expand — see loop below)
        "all_custom_indices": candidates,
    }


async def _compute_detect_response(file_path, config, detect_logger):
    """Run vector detection plus raster fallback and return the legacy response."""
    import time as _t
    from app.workers.nup_engine import canonical_page_space
    from app.utils.preview_perf_log import log as _perf, mark as _pmark

    _t0 = _t.perf_counter()
    _fname = os.path.basename(file_path)
    _perf("DETECT", "compute_start", file=_fname)

    # [AUDIT §2.1 2026-07-28] Nhận diện phải đọc CÙNG hệ quy chiếu với export.
    # `run_nup_engine` chuẩn hoá /Rotate + gốc MediaBox trước khi layout, còn route này
    # trước đây mở file thô → trang /Rotate=90 khổ 200×100 báo trim 200×100 trong khi
    # export dựng theo 100×200 (đo được: hoán w/h). Nay dùng chung chốt đó.
    with canonical_page_space(file_path) as _canon_path:
        return await _detect_on_canonical(
            _canon_path, config, detect_logger, _t0, _fname, _perf, _pmark
        )


async def _detect_on_canonical(file_path, config, detect_logger,
                               _t0, _fname, _perf, _pmark):
    """Phần thân nhận diện, chạy trên trang ĐÃ chuẩn hoá (xem _compute_detect_response)."""
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.die_detection import detect_die_shapes, to_legacy_response
    from app.core.separations import SeparationEngine

    doc = pdf_lib.open(file_path)
    _pmark("DETECT", "open_doc", _t0, file=_fname, pages=getattr(doc, "page_count", "?"))
    try:
        from app.workers.die_detection import apply_master_die_inheritance

        result = detect_die_shapes(doc, config)
        _src_counts: dict[str, int] = {}
        for s in result.shapes:
            _src_counts[s.source] = _src_counts.get(s.source, 0) + 1
        _pmark(
            "DETECT", "vector_done", _t0,
            pages=result.total_pages, sources=str(_src_counts),
        )

        # 1 khuôn master + N artwork → trang không bế kế thừa type/trim (UI Tròn/Elip).
        # Chạy TRƯỚC raster để không tốn Ghostscript cho 27 trang CUSTOM (tron.pdf).
        _before_custom = sum(1 for s in result.shapes if s.type.name == "CUSTOM")
        result = apply_master_die_inheritance(result)
        _after_custom = sum(1 for s in result.shapes if s.type.name == "CUSTOM")
        if _after_custom != _before_custom:
            _src_counts = {}
            for s in result.shapes:
                _src_counts[s.source] = _src_counts.get(s.source, 0) + 1
            _perf(
                "DETECT", "master_inherit",
                before_custom=_before_custom, after_custom=_after_custom,
                sources=str(_src_counts),
            )

        budget = _raster_fallback_budget(result.shapes, result.statuses)
        _perf(
            "DETECT", "raster_budget",
            reason=budget.get("reason"),
            max_tries=budget.get("max_tries"),
            vector_ok=budget.get("vector_ok"),
            custom_n=budget.get("custom_n"),
        )

        engine = SeparationEngine()
        raster_tries = 0
        raster_hits = 0
        fail_streak = 0
        max_tries = int(budget.get("max_tries") or 0)
        fail_stop = int(budget.get("fail_streak_stop") or 2)
        # Khi đã có vector master: chỉ probe 1 trang. Khi all-custom: thử tối đa max_tries,
        # dừng sớm nếu fail_streak đạt ngưỡng (GS không có plate trên file này).
        custom_indices = list(budget.get("all_custom_indices") or budget.get("indices") or [])

        for i in custom_indices:
            if raster_tries >= max_tries:
                _perf("DETECT", "raster_skip_cap", tried=raster_tries, left=len(custom_indices) - raster_tries)
                break
            if fail_streak >= fail_stop and raster_hits == 0:
                _perf(
                    "DETECT", "raster_skip_fail_streak",
                    fail_streak=fail_streak, tried=raster_tries,
                    skipped=len(custom_indices) - raster_tries,
                )
                break
            # Sau khi đã có ≥1 hit raster, cho phép nới budget tới max(3, max_tries) trang
            # (file một phần chỉ có spot raster). Không bao giờ quét hết 28 trang mặc định.
            if raster_hits > 0 and raster_tries >= max(max_tries, 3):
                _perf("DETECT", "raster_skip_after_hits", hits=raster_hits, tried=raster_tries)
                break

            shape = result.shapes[i]
            # Đã có type (kể cả kế thừa master) → không cần GS.
            if shape.source != "custom" or shape.type.name != "CUSTOM":
                continue
            raster_tries += 1
            fallback = await _raster_fallback_shape(
                engine, file_path, shape.page, config, detect_logger
            )
            if fallback is not None:
                raster_hits += 1
                fail_streak = 0
                result.shapes[i] = fallback
                result.statuses[i] = type(result.statuses[i])(
                    page=fallback.page,
                    ok=True,
                    source=fallback.source,
                    error=None,
                )
            else:
                fail_streak += 1

        _pmark(
            "DETECT", "compute_done", _t0,
            file=_fname, pages=result.total_pages,
            raster_tries=raster_tries, raster_hits=raster_hits,
            sources=str(_src_counts),
            raster_reason=budget.get("reason"),
        )
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return to_legacy_response(result)


@router.post("/perf-beacon")
async def preview_perf_beacon(body: dict, license_info: dict = Depends(require_license)):
    """FE gửi mốc timeline (detect/preview/batch) → ghi logs/preview_perf.log."""
    from app.utils.preview_perf_log import log as _perf
    msg = str((body or {}).get("msg") or "beacon")[:200]
    fields = {
        k: v for k, v in (body or {}).items()
        if k != "msg" and isinstance(v, (str, int, float, bool))
    }
    _perf("FE", msg, **fields)
    return {"ok": True}


@router.post("/detect-shape")
async def api_detect_shape(body: dict):
    """
    Detect the geometric shape of all pages (for die-cut stickers).

    Nguồn sự thật duy nhất: app.workers.die_detection.detect_die_shapes (vector),
    + raster fallback cho trang không có đường bế vector. Cô lập lỗi theo trang;
    không còn fail toàn cục; xử lý mọi trang (bỏ giới hạn 30).
    (Spec die-shape-detection-ssot — R3.1, R4, R5, R14.1.)
    """
    import logging
    _detect_logger = logging.getLogger(__name__)

    try:
        # Tối ưu tốc độ (desktop): nhận diện ĐỌC TRỰC TIẾP file từ đường dẫn ổ đĩa
        # nếu client gửi 'path' → KHÔNG cần upload (tránh đọc + POST cả file lớn).
        # Web mode (không có path local) vẫn dùng 'fileId' → resolve từ DB như cũ.
        path_in = body.get("path")
        if path_in:
            file_path = _validate_file_path(path_in)  # validate tồn tại + .pdf + chống traversal
            _detect_logger.info(f"[DETECT_SHAPE] Direct path → {file_path}")
        else:
            file_id = body.get("fileId")
            if not file_id:
                raise ValueError("Missing 'path' or 'fileId'")

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

        # Cache theo (path, mtime, size) — trả tức thì khi đổi công cụ / mở lại cùng file.
        from app.workers.die_detection import DetectionConfig

        config = DetectionConfig()
        # Override tuỳ chọn từ client: cho phép người dùng chỉ định kênh/màu đường bế
        # khi auto nhận diện trật (vd file dùng spot tên lạ hoặc màu bế riêng).
        try:
            _names = body.get("dieChannelNames")
            _colors = body.get("dieColors")
            _kw = {}
            if isinstance(_names, list) and _names:
                _kw["die_channel_names"] = tuple(str(n) for n in _names)
            if isinstance(_colors, list) and _colors:
                _kw["die_colors"] = tuple(
                    tuple(float(x) for x in c) for c in _colors if isinstance(c, (list, tuple))
                )
            if _kw:
                config = DetectionConfig(**_kw)
        except Exception as _e:
            _detect_logger.warning(f"[DETECT_SHAPE] override config bỏ qua: {_e}")

        from app.utils.preview_perf_log import log as _perf, reset_session, Span

        _fname = os.path.basename(file_path)
        reset_session(f"detect:{_fname}")
        _span = Span("DETECT", "api_detect_shape", file=_fname)

        _cache_key = _make_detect_cache_key(file_path, config)
        if _cache_key is not None:
            _cached = _DETECT_CACHE.get(_cache_key)
            if _cached is not None:
                _detect_logger.info("[DETECT_SHAPE] cache hit")
                n_shapes = len(_cached.get("shapes") or [])
                _perf("DETECT", "CACHE_HIT", file=_fname, pages=n_shapes)
                _span.done(cache="hit", pages=n_shapes)
                return _cached
            if _cache_key in _DETECT_INFLIGHT:
                _detect_logger.info("[DETECT_SHAPE] joining in-flight detection")
                _perf("DETECT", "JOIN_INFLIGHT", file=_fname)

        async def _work():
            response = await _compute_detect_response(file_path, config, _detect_logger)
            if _cache_key is not None:
                if len(_DETECT_CACHE) >= _DETECT_CACHE_MAX:
                    _DETECT_CACHE.clear()
                _DETECT_CACHE[_cache_key] = response
            return response

        response = await _run_shared_detection(_cache_key, _work)
        n_shapes = len((response or {}).get("shapes") or [])
        shapes_summary = ",".join(str(s) for s in ((response or {}).get("shapes") or [])[:12])
        _span.done(cache="miss", pages=n_shapes, shapes=shapes_summary)
        return response

    except Exception as e:
        import traceback
        _detect_logger.error(f"Failed to detect shape: {e}\n{traceback.format_exc()}")
        try:
            from app.utils.preview_perf_log import log as _perf
            _perf("DETECT", "api_FAIL", err=str(e)[:120])
        except Exception:
            pass
        # Lỗi cấp file (vd không mở được PDF) — vẫn giữ contract cũ.
        return {"shapes": ["CUSTOM"], "dimensions": [], "shapeParams": [],
                "perPage": [], "success": False, "error": str(e)}

# =========================================================================
#  N-Up Backend Engine (pikepdf) — for high-volume imposition (50k+ pages)
# =========================================================================

import tempfile
import threading
import glob
from concurrent.futures import ThreadPoolExecutor

# In-memory job store for N-Up jobs
nup_jobs = {}
_NUP_JOBS_LOCK = threading.RLock()
_NUP_MAX_CONCURRENT_JOBS = max(1, int(os.environ.get('PRYNX_MAX_NUP_JOBS', '1') or '1'))
_NUP_MAX_QUEUED_JOBS = max(0, int(os.environ.get('PRYNX_MAX_NUP_QUEUE', '8') or '8'))
_NUP_EXECUTOR = ThreadPoolExecutor(max_workers=_NUP_MAX_CONCURRENT_JOBS, thread_name_prefix='prynx-nup')
_NUP_SUBMISSION_SLOTS = threading.BoundedSemaphore(_NUP_MAX_CONCURRENT_JOBS + _NUP_MAX_QUEUED_JOBS)

# TTL dọn job quá hạn khỏi RAM + xoá file kết quả (giống vdp `_purge_old_jobs`).
# Trước đây nup_jobs KHÔNG có cơ chế purge → dict tăng đơn điệu theo số lần bình
# bài trong phiên (entry nhỏ nhưng vô hạn) + results/nup_*.pdf đọng ổ đĩa.
NUP_JOB_TTL_SECONDS = 3600


def _purge_old_nup_jobs():
    import time
    now = time.time()
    for jid in list(nup_jobs.keys()):
        job = nup_jobs.get(jid)
        if not job:
            continue
        created = job.get("created_at", now)
        if now - created > NUP_JOB_TTL_SECONDS and job.get("status") in {"completed", "failed", "cancelled"}:
            out = job.get("output_path")
            if out and os.path.exists(out):
                try:
                    os.remove(out)
                except OSError:
                    pass
            nup_jobs.pop(jid, None)
            _cleanup_job_temp(jid)


def _cleanup_nup_chunk_files(job_id: str):
    """Remove chunk PDFs left by completed, failed, or cancelled N-Up workers."""
    temp_dir = tempfile.gettempdir()
    patterns = (
        os.path.join(temp_dir, f"prynx_nup_{job_id}_*.pdf"),
        os.path.join(temp_dir, f"nup_canon_{job_id}_*.pdf"),
        os.path.join(temp_dir, f"nup_perf_{job_id}.json"),
    )
    for pattern in patterns:
        for path in glob.glob(pattern):
            try:
                os.remove(path)
            except OSError:
                pass


def _cleanup_job_temp(job_id: str):
    """Dọn file trạng thái/tiến trình tạm của job (Task 19 / Req 9.2)."""
    for name in (f"nup_state_{job_id}.txt", f"nup_prog_{job_id}.txt"):
        p = os.path.join(tempfile.gettempdir(), name)
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    _cleanup_nup_chunk_files(job_id)


def _read_nup_state(job_id: str):
    state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
    try:
        with open(state_file, "r", encoding="utf-8") as file_obj:
            parts = file_obj.read().split("|||", 1)
    except (OSError, UnicodeDecodeError):
        return None
    status = parts[0]
    if status not in {"completed", "failed"}:
        return None
    return status, parts[1] if len(parts) > 1 else ""


@scheduled_job("nup")
def _spawn_nup_process(source_path: str, output_path: str, settings: dict, job_id: str):
    """Run one outer process only after the bounded executor grants a slot."""
    import multiprocessing
    import time
    # Perf sampling is fully gated: when PRYNX_PERF is off nothing here runs —
    # no temp-dir scan, no sampler thread, no clock read. Any failure inside the
    # instrumentation must NEVER bypass the cleanup/slot-release below, so all of
    # it lives inside try/finally and each measurement is defensively guarded.
    sampler = None
    perf_on = False
    t_start = 0.0
    try:
        try:
            from app.core.perf_sampler import perf_enabled
            perf_on = perf_enabled()
            if perf_on:
                t_start = time.monotonic()
        except Exception:
            perf_on = False

        with _NUP_JOBS_LOCK:
            job = nup_jobs.get(job_id)
            if job is None:
                return
            if job.get("cancel_requested") or job.get("status") == "cancelled":
                job["status"] = "cancelled"
                return
            proc = multiprocessing.Process(
                target=_nup_process_worker,
                args=(source_path, output_path, settings, job_id),
                daemon=False,
            )
            # Publish only a genuinely started Process so cancellation never
            # attempts to terminate an unstarted multiprocessing object.
            job["status"] = "running"
            job["started_at"] = time.time()
            proc.start()
            job["process"] = proc
            job["pid"] = proc.pid
        if perf_on:
            try:
                from app.core.perf_sampler import ProcessRssSampler
                temp_dir = tempfile.gettempdir()
                sampler = ProcessRssSampler(
                    proc.pid or 0,
                    temp_patterns=(
                        os.path.join(temp_dir, f"prynx_nup_{job_id}_*.pdf"),
                        os.path.join(temp_dir, f"nup_canon_{job_id}_*.pdf"),
                        os.path.join(temp_dir, f"nup_perf_{job_id}.json"),
                        os.path.join(temp_dir, f"nup_state_{job_id}.txt"),
                        os.path.join(temp_dir, f"nup_prog_{job_id}.txt"),
                    ),
                )
                sampler.start()
            except Exception:
                sampler = None
        proc.join()
        with _NUP_JOBS_LOCK:
            current_job = nup_jobs.get(job_id)
            cancelled = bool(
                current_job
                and (current_job.get("cancel_requested") or current_job.get("status") == "cancelled")
            )
            if current_job:
                current_job["completed_at"] = current_job.get("completed_at") or time.time()
            if current_job and current_job.get("process") is proc:
                current_job["process"] = None
        if proc.exitcode not in (0, None) and not cancelled:
            state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
            if not os.path.exists(state_file):
                try:
                    with open(state_file, 'w', encoding='utf-8') as f:
                        f.write(f"failed|||N-Up worker exited with code {proc.exitcode}")
                except OSError:
                    pass
    finally:
        if sampler is not None:
            try:
                sampler.stop()
            except Exception:
                pass
        if perf_on:
            try:
                from app.core.perf_sampler import read_perf_stages, write_job_perf
                out_mb = None
                if os.path.exists(output_path):
                    out_mb = round(os.path.getsize(output_path) / (1024.0 * 1024.0), 1)
                perf_record = {
                    "job": "nup",
                    "job_id": job_id,
                    "duration_s": round(time.monotonic() - t_start, 2),
                    "peak_rss_mb": round(sampler.peak_mb, 1) if sampler and sampler.peak_mb else None,
                    "peak_temp_mb": round(sampler.peak_temp_mb, 1) if sampler and sampler.peak_temp_mb is not None else None,
                    "samples": sampler.sample_count if sampler else None,
                    "output_mb": out_mb,
                }
                stage_path = os.path.join(tempfile.gettempdir(), f"nup_perf_{job_id}.json")
                perf_record.update(read_perf_stages(stage_path))
                write_job_perf(perf_record)
            except Exception:
                pass
        _cleanup_nup_chunk_files(job_id)
        _NUP_SUBMISSION_SLOTS.release()


def _terminate_nup_process(proc, timeout: float = 1.0) -> bool:
    """Best-effort stop for a child Process; never raise into the API route."""
    try:
        if not proc.is_alive():
            return True
        proc.terminate()
        proc.join(timeout=timeout)
        if proc.is_alive() and hasattr(proc, "kill"):
            proc.kill()
            proc.join(timeout=timeout)
        return not proc.is_alive()
    except Exception as exc:
        logger.warning("Unable to stop N-Up process cleanly: %s", exc)
        return False


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
    source_path = _validate_file_path(body.get("source_path"))
    settings = dict(body.get("settings", {}) or {})
    page_sheet_raw = settings.get("page_sheet_mode", False)
    if type(page_sheet_raw) is not bool:
        raise HTTPException(status_code=422, detail="page_sheet_mode phải là boolean.")
    imposer_mode = str(settings.get("imposerMode", "") or "").strip().lower()
    task_mode = str(settings.get("taskMode", "") or "").strip().lower()
    if page_sheet_raw and (
        imposer_mode == "cnc" or task_mode in ("cnc", "cnc_imposer")
    ):
        raise HTTPException(status_code=422, detail="Bình nguyên tấm decal không áp dụng cho CNC.")

    enforce_feature(_imposition_feature(settings), license_info or {})
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

    _purge_old_nup_jobs()

    job_id = str(uuid.uuid4())[:8]
    output_path = os.path.join(RESULTS_DIR, f"{prefix}_{job_id}.pdf")

    nup_jobs[job_id] = {
        "status": "queued",
        "progress": "0/0",
        "report": "",
        "output_path": output_path,
        "error": None,
        "created_at": time.time(),
        "started_at": None,
        "completed_at": None,
        "cancel_requested": False,
        "process": None,
        "pid": None,
    }

    # Queue outer processes so concurrent jobs cannot multiply process trees
    # without bound. Each granted process still uses the capped inner pool.
    if not _NUP_SUBMISSION_SLOTS.acquire(blocking=False):
        nup_jobs.pop(job_id, None)
        raise HTTPException(status_code=429, detail="Hàng đợi N-Up đang đầy. Vui lòng chờ job hiện tại hoàn tất.")
    try:
        _NUP_EXECUTOR.submit(_spawn_nup_process, source_path, output_path, settings, job_id)
    except Exception:
        _NUP_SUBMISSION_SLOTS.release()
        nup_jobs.pop(job_id, None)
        raise
    return {"job_id": job_id}


@router.post("/impose-start")
async def start_impose_job(body: dict, license_info: dict = Depends(require_license)):
    """
    Endpoint hợp nhất N-Up & Bế Tem. Tiền tố tên file theo settings.isDieCutMode.
    Expects body: { "source_path": "...", "settings": {...} }
    """
    job_settings = body.get("settings", {}) or {}
    is_diecut = bool(job_settings.get("isDieCutMode", False))
    is_page_sheet = job_settings.get("page_sheet_mode", False) is True
    return _launch_impose_job(body, "sticker" if (is_diecut or is_page_sheet) else "nup", license_info)


@router.post("/nup-start")
async def start_nup_job(body: dict, license_info: dict = Depends(require_license)):
    """Alias tương thích ngược — dùng /impose-start. (Task 18)"""
    return _launch_impose_job(body, "nup", license_info)


@router.post("/sticker-start")
async def start_sticker_job(body: dict, license_info: dict = Depends(require_license)):
    """Alias tương thích ngược — dùng /impose-start. (Task 18)"""
    return _launch_impose_job(body, "sticker", license_info)


@router.get("/nup-status/{job_id}")
async def get_nup_status(job_id: str, _: dict = Depends(require_license)):
    """Poll N-Up job progress."""
    job = nup_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Also check progress file for more granular updates
    prog_file = os.path.join(tempfile.gettempdir(), f"nup_prog_{job_id}.txt")
    if job.get("status") != "cancelled" and os.path.exists(prog_file):
        try:
            with open(prog_file, 'r', encoding='utf-8', errors='replace') as f:
                job["progress"] = f.read().strip()
        except (IOError, OSError, UnicodeDecodeError):
            pass
    
    state_file = os.path.join(tempfile.gettempdir(), f"nup_state_{job_id}.txt")
    if job.get("status") != "cancelled" and os.path.exists(state_file):
        try:
            with open(state_file, 'r', encoding='utf-8') as f:
                parts = f.read().split('|||', 1)
                job["status"] = parts[0]
                if parts[0] in {"completed", "failed"}:
                    job["completed_at"] = job.get("completed_at") or time.time()
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
        "created_at": job.get("created_at"),
        "started_at": job.get("started_at"),
        "completed_at": job.get("completed_at"),
        "output_path": (
            job.get("output_path")
            if settings.IS_DESKTOP_APP and job.get("status") == "completed"
            else None
        ),
    }


@router.post("/nup-cancel/{job_id}")
async def cancel_nup_job(job_id: str, _: dict = Depends(require_license)):
    """Cancel a queued/running N-Up job. Repeated and terminal calls are safe."""
    terminal_state = _read_nup_state(job_id)
    with _NUP_JOBS_LOCK:
        job = nup_jobs.get(job_id)
        if job is None:
            return {
                "job_id": job_id,
                "status": "not_found",
                "cancelled": False,
                "message": "Job not found",
            }
        previous_status = job.get("status", "unknown")
        if previous_status != "cancelled" and terminal_state is not None:
            previous_status, detail = terminal_state
            job["status"] = previous_status
            if previous_status == "completed":
                job["report"] = detail
            else:
                job["error"] = detail
        if previous_status in {"completed", "failed"}:
            return {
                "job_id": job_id,
                "status": previous_status,
                "cancelled": False,
                "message": f"Job is already {previous_status}",
            }
        already_cancelled = previous_status == "cancelled"
        job["cancel_requested"] = True
        job["status"] = "cancelled"
        job["error"] = None
        job["completed_at"] = job.get("completed_at") or time.time()
        proc = job.get("process")

    stopped = True
    if proc is not None:
        stopped = _terminate_nup_process(proc)

    return {
        "job_id": job_id,
        "status": "cancelled",
        "cancelled": True,
        "already_cancelled": already_cancelled,
        "process_stopped": stopped,
    }


@router.get("/nup-download/{job_id}")
async def download_nup_result(job_id: str, _: dict = Depends(require_license)):
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

from pydantic import BaseModel, ConfigDict, Field, StrictBool
from typing import Dict, Any, Optional, List

class PreviewLayoutRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    
    usable_w: float = Field(gt=0, le=10000)
    usable_h: float = Field(gt=0, le=10000)
    item_w: float = Field(gt=0, le=10000)
    item_h: float = Field(gt=0, le=10000)
    gap_x: float = Field(ge=0, le=10000)
    gap_y: float = Field(ge=0, le=10000)
    strategy: str
    shape_type: str = "CUSTOM"
    shape_props: Dict[str, Any] = Field(default_factory=dict)
    pont_config: Optional[Dict[str, Any]] = None
    sheet_w: float = Field(default=0, ge=0, le=10000)
    sheet_h: float = Field(default=0, ge=0, le=10000)
    margin_left: float = Field(default=0, ge=0, le=10000)
    margin_bottom: float = Field(default=0, ge=0, le=10000)
    margin_top: float = Field(default=0, ge=0, le=10000)
    margin_right: float = Field(default=0, ge=0, le=10000)
    # Căn lưới (center|left|right|top|bottom…) — ratio_stack preview khớp nup_engine.
    align: Optional[str] = "center"
    file_id: Optional[str] = None
    path: Optional[str] = None
    page_idx: int = 0
    bleed: float = 0.0
    layout_type: Optional[str] = None
    is_die_cut: Optional[bool] = False
    page_sheet_mode: StrictBool = False
    grouping_strategy: str = "none"
    cluster_sizing_mode: str = "dims"
    cluster_combine_mode: str = "replicate_mixed"
    cluster_nesting: bool = True
    cluster_cols: int = Field(default=2, ge=0, le=1000)
    cluster_rows: int = Field(default=2, ge=0, le=1000)
    cluster_w: float = Field(default=0, ge=0, le=10000)
    cluster_h: float = Field(default=0, ge=0, le=10000)
    tile_gap_x: float = Field(default=0, ge=0, le=10000)
    tile_gap_y: float = Field(default=0, ge=0, le=10000)
    task_mode: str = "nup"
    # 0 = chưa gửi / không biết → dùng doc.page_count. >0 = số trang viewer (sau xóa/sắp).
    total_pages: int = Field(default=0, ge=0, le=200000)
    # N-Up 2 mặt: 'double' | 'normal' (sequential ghép cặp trang trước/sau).
    duplex_flow: Optional[str] = "normal"
    split_gap: Optional[float] = 0
    target_quantity: Optional[int] = Field(default=0, ge=0, le=1000000)
    target_quantities_by_page: Optional[Dict[str, int]] = Field(default_factory=dict)
    # ── Chế độ ĐỒNG NHẤT (sticker-homogeneous-nup) — hình/props nhận diện theo trang ──
    # Cần để preview phát hiện "1 khuôn master + nhiều nội dung" KHỚP output (nup_engine).
    detected_shapes_by_page: Optional[Dict[str, Any]] = None
    detected_shape_params_by_page: Optional[Dict[str, Any]] = None
    # ── Bình Bế Rớt (CNC) ghép nhiều mẫu — preview khớp output ──
    imposer_mode: Optional[str] = None
    cnc_two_sided: Optional[bool] = False
    cnc_flip_edge: Optional[str] = "long"
    cols: int = Field(default=0, ge=0, le=1000)
    rows: int = Field(default=0, ge=0, le=1000)
    # Chế độ 1 Dao (LETA): KC cụm phụ (mm) — preview phải khớp nup_engine secondary_gap.
    cut_type: Optional[str] = "default"
    fill_block_gap: Optional[float] = 0
    # 1 Dao: kiểu khuôn ('die'=đường bế thật / 'page'=mediabox±offset) + offset co-mở (mm).
    die_size_mode: Optional[str] = "die"
    die_offset_mm: Optional[float] = 0
    # ── Chia cọc xén (guillotine batching) — preview khớp nup_engine cluster_type ──
    # cluster_distribution='type' + cluster_mode∈{row,column}: mỗi cọc 1 loại theo tỷ lệ SL.
    cluster_mode: Optional[str] = "none"
    cluster_count: Optional[int] = 2
    cluster_gap: Optional[float] = 0
    cluster_distribution: Optional[str] = "default"

def _build_pont_base_poly_for_preview(page, result: dict, req: Any, shape_type_hint: str = None):
    """Polygon va chạm boong — KHỚP nup_process_chunk (dùng kích thước Ô solver, không item_w FE).

    1 Dao / RECTANGLE: PHẢI dùng chữ nhật ô tem. Trước đây rơi nhánh extract_vector_paths
    → lấy mảng màu artwork làm base_poly → get_item_polygon scale sai → boong không
    đụng outline giả → coi như không va chạm (bug 1 Dao + theo kích thước trang).
    """
    pc = getattr(req, 'pont_config', None)
    if not pc or pc.get('disableCollision', False):
        return None
    items = result.get('items') or []
    pw = float(items[0].get('width', 0) or 0) if items else 0.0
    ph = float(items[0].get('height', 0) or 0) if items else 0.0
    if pw <= 0:
        pw = float(result.get('trimW') or getattr(req, 'item_w', 0) or 0)
    if ph <= 0:
        ph = float(result.get('trimH') or getattr(req, 'item_h', 0) or 0)
    shape = (result.get('shapeType') or shape_type_hint or getattr(req, 'shape_type', None) or '').upper()
    cut_type = (getattr(req, 'cut_type', None) or 'default')
    if pw > 0 and ph > 0 and (cut_type == 'one_dao' or shape == 'RECTANGLE'):
        from shapely.geometry import box as _box
        return _box(0.0, 0.0, pw, ph)
    if shape == 'CIRCLE_ELLIPSE' and pw > 0 and ph > 0:
        from shapely.geometry import Point
        from shapely.affinity import scale
        return scale(Point(0, 0).buffer(1.0, resolution=64), xfact=pw / 2.0, yfact=ph / 2.0)
    try:
        from app.workers.pont_collision import build_shapely_polygon_from_paths
        paths = page.extract_vector_paths()
        if paths:
            return build_shapely_polygon_from_paths(paths, page.rect)
    except Exception:
        pass
    # Không extract được: vẫn chữ nhật ô để dò boong (AABB đủ; poly khớp ô tem).
    if pw > 0 and ph > 0:
        from shapely.geometry import box as _box
        return _box(0.0, 0.0, pw, ph)
    return None

def _resolve_preview_secondary_gap(req: Any) -> Optional[float]:
    """Cùng thứ tự ưu tiên với nup_engine (L1248-1260): one_dao+fillBlockGap → splitGap → None."""
    from app.workers.pont_collision import MM_TO_PTS
    cut_type = getattr(req, 'cut_type', None) or 'default'
    fill_block_gap_mm = float(getattr(req, 'fill_block_gap', None) or 0)
    split_gap_pt = float(getattr(req, 'split_gap', None) or 0)
    if cut_type == 'one_dao' and fill_block_gap_mm > 0:
        return fill_block_gap_mm * MM_TO_PTS
    if split_gap_pt > 0:
        return split_gap_pt
    return None

def _normalize_polygon_to_unit(poly, max_pts: int = 80):
    """Outline shapely (page coords, Y-up PDF) → list [fx, fy] phân số 0..1 đã giản hoá.

    Dùng cho preview vẽ ĐƯỜNG BẾ THẬT của tem búa/tạ (thay hình tổng hợp đoán hướng).
    Trả None nếu không hợp lệ. Giản hoá + cap số đỉnh để payload nhỏ và vẽ nhanh.
    """
    if poly is None:
        return None
    try:
        geom = poly
        if getattr(geom, 'geom_type', None) == 'MultiPolygon':
            geom = max(geom.geoms, key=lambda g: g.area)
        if getattr(geom, 'geom_type', None) != 'Polygon':
            return None
        minx, miny, maxx, maxy = geom.bounds
        w = maxx - minx
        h = maxy - miny
        if w <= 0 or h <= 0:
            return None
        tol = max(w, h) * 0.005
        try:
            ext = geom.simplify(tol, preserve_topology=True).exterior
        except Exception:
            ext = geom.exterior
        coords = list(ext.coords)
        if len(coords) > max_pts:
            step = len(coords) / max_pts
            coords = [coords[int(i * step)] for i in range(max_pts)]
        return [[(x - minx) / w, (y - miny) / h] for x, y in coords]
    except Exception:
        return None


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


MAX_PREVIEW_CELLS = 100_000
MAX_PREVIEW_PAGE_MAP = 200_000

@router.post("/preview-layout")
def preview_layout(req: PreviewLayoutRequest, license_info: dict = Depends(require_license)):
    """
    Preview sticker layout — uses the SAME compute function as nup_engine
    to guarantee preview ≡ output.
    """
    if req.page_sheet_mode:
        _preview_imposer_mode = str(req.imposer_mode or "").strip().lower()
        _preview_task_mode = str(req.task_mode or "").strip().lower()
        if (
            _preview_imposer_mode == "cnc"
            or _preview_task_mode in ("cnc", "cnc_imposer")
        ):
            raise HTTPException(status_code=422, detail="Bình nguyên tấm decal không áp dụng cho CNC.")
        from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
        try:
            resolve_page_sheet_geometry(req.item_w, req.item_h, req.bleed)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        req.is_die_cut = False
        req.task_mode = "step_repeat" if req.task_mode == "step_repeat" else "nup"
        req.shape_type = "RECTANGLE"
        req.shape_props = {}
        # Whole-sheet layout is rectangular, but registration marks still
        # reserve forbidden zones exactly like export.
        req.cut_type = "default"
        req.detected_shapes_by_page = {}
        req.detected_shape_params_by_page = {}
        req.duplex_flow = "normal"

    if req.strategy == 'manual' and (req.cols <= 0 or req.rows <= 0):
        raise HTTPException(
            status_code=422,
            detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng c\u1ea7n s\u1ed1 c\u1ed9t v\u00e0 s\u1ed1 d\u00f2ng l\u1edbn h\u01a1n 0.",
        )

    requested_cells = (req.cols * req.rows) if req.cols > 0 and req.rows > 0 else 0
    cluster_cells = (req.cluster_cols * req.cluster_rows) if req.cluster_cols > 0 and req.cluster_rows > 0 else 0
    page_map = req.target_quantities_by_page or {}
    if requested_cells > MAX_PREVIEW_CELLS or cluster_cells > MAX_PREVIEW_CELLS:
        raise HTTPException(status_code=422, detail="Preview layout v\u01b0\u1ee3t qu\u00e1 gi\u1edbi h\u1ea1n s\u1ed1 \u00f4 cho ph\u00e9p.")
    if len(page_map) > MAX_PREVIEW_PAGE_MAP or any(value > 1_000_000 for value in page_map.values()):
        raise HTTPException(status_code=422, detail="Preview layout v\u01b0\u1ee3t qu\u00e1 gi\u1edbi h\u1ea1n page map ho\u1eb7c quantity.")

    enforce_feature(_imposition_feature(req), license_info)
    
    if req.file_id or req.path:
        # ═══ SINGLE SOURCE OF TRUTH PATH ═══
        # Uses compute_sticker_layout_for_page() — identical to nup_engine
        #
        # [AUDIT §2.1 2026-07-28] ExitStack là ĐIỂM DỌN DUY NHẤT cho bản trang đã
        # chuẩn hoá (xem `_canon_stack.enter_context` bên dưới). Thân hàm này thoát ở
        # ~15 nhánh `return` khác nhau và không có try/finally bao ngoài, nên nếu tự
        # quản file tạm thì chắc chắn rò rỉ ở nhánh ngoại lệ. ExitStack dọn ở MỌI
        # đường ra, kể cả khi ném exception. Đổi từ `if True:` nên thân hàm giữ NGUYÊN
        # mức thụt lề — không có thay đổi logic nào kèm theo.
        with contextlib.ExitStack() as _canon_stack:
            from app.workers import pdf_wrapper as pdf_lib
            from app.database import SessionLocal
            from app.models.job import UploadedFile as UploadedFileModel
            from app.workers.sticker_imposer_pkg.layout_compute import compute_sticker_layout_for_page
            from app.workers.imposition_finalize import finalize_placements, resolve_pont_collisions_on_placements

            # ── TIMING (chẩn đoán preview chậm) → logger + file logs/preview_perf.log ──
            import time as _t_mod
            from app.utils.preview_perf_log import log as _perf, mark as _pmark
            _T_PREVIEW_START = _t_mod.perf_counter()
            def _plog(_lbl):
                elapsed = (_t_mod.perf_counter() - _T_PREVIEW_START) * 1000.0
                logger.debug("[PREVIEW-TIMING] %-32s +%7.1fms", _lbl, elapsed)
                _perf("PREVIEW", _lbl, ms_from_start=elapsed)

            _perf(
                "PREVIEW", "api_start",
                path=os.path.basename(str(req.path or req.file_id or "")),
                task_mode=getattr(req, "task_mode", None),
                layout_type=getattr(req, "layout_type", None),
                is_die_cut=getattr(req, "is_die_cut", None),
                imposer_mode=getattr(req, "imposer_mode", None),
                grouping=getattr(req, "grouping_strategy", None),
                strategy=req.strategy,
                shape=req.shape_type,
                page_idx=getattr(req, "page_idx", 0),
                target_qty=getattr(req, "target_quantity", 0),
            )

            logger.debug("[PREVIEW] file_id=%s path=%s usable=%.2fx%.2f item=%.2fx%.2f gap=%.2fx%.2f strategy=%s shape=%s props=%s",
                         req.file_id, req.path, req.usable_w, req.usable_h, req.item_w, req.item_h,
                         req.gap_x, req.gap_y, req.strategy, req.shape_type, req.shape_props)

            try:
                from app.workers.rot_audit_log import get_logger as _rot_get_logger
                _rot_get_logger().warning(
                    "[ROT-AUDIT][REQ][PREVIEW] path=%s task_mode=%s layout_type=%s is_die_cut=%s "
                    "strategy=%s shape=%s usable=%.1fx%.1f sheet=%.1fx%.1f margins(l/b/t/r)=%.1f/%.1f/%.1f/%.1f "
                    "gap=%.1fx%.1f bleed=%.1f target_qty=%s tqbp=%s pont_type=%s pont_config=%s "
                    "grouping=%s cut_type=%s fill_block_gap=%s split_gap=%s",
                    req.path, getattr(req, 'task_mode', None), getattr(req, 'layout_type', None),
                    getattr(req, 'is_die_cut', None), req.strategy, req.shape_type,
                    req.usable_w, req.usable_h, getattr(req, 'sheet_w', 0), getattr(req, 'sheet_h', 0),
                    getattr(req, 'margin_left', 0), getattr(req, 'margin_bottom', 0),
                    getattr(req, 'margin_top', 0), getattr(req, 'margin_right', 0) if hasattr(req, 'margin_right') else 0,
                    req.gap_x, req.gap_y, getattr(req, 'bleed', 0), getattr(req, 'target_quantity', 0),
                    getattr(req, 'target_quantities_by_page', None), getattr(req, 'pont_config', None) and 'ON',
                    getattr(req, 'pont_config', None), getattr(req, 'grouping_strategy', None),
                    getattr(req, 'cut_type', None), getattr(req, 'fill_block_gap', None),
                    getattr(req, 'split_gap', None),
                )
            except Exception:
                pass
            
            # Desktop: đọc trực tiếp theo path (không cần upload → preview gang nhiều
            # mẫu vẫn chạy mà không phụ thuộc selectionFileId). Web: resolve từ DB.
            if req.path:
                file_path = _validate_file_path(req.path)
            else:
                db = SessionLocal()
                try:
                    db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == req.file_id).first()
                    file_path = db_file.file_path if db_file else None
                finally:
                    db.close()
            
            if not file_path or not os.path.exists(file_path):
                raise ValueError(f"File not found: {req.file_id or req.path}")
            
            logger.debug("   file_path=%s", file_path)
            
            _plog("resolve+validate path")
            # [AUDIT §2.1 2026-07-28] Preview phải đọc CÙNG hệ quy chiếu với export.
            # `run_nup_engine` chuẩn hoá /Rotate + gốc MediaBox trước khi layout; preview
            # trước đây mở file thô nên trang /Rotate=90 khổ 200×100 dựng lưới theo
            # 200×100 trong khi export dựng theo 100×200 (đo được: hoán w/h).
            # File đã chuẩn → hàm trả về CHÍNH đường dẫn đó, không tạo file tạm.
            #
            # KHÔNG gán lại `file_path`: nó là thành phần khoá của _NEST_A_CACHE và cache
            # zone (kèm os.path.getmtime). Đường chuẩn hoá là file tạm mang uuid + mtime
            # MỚI mỗi request → cache sẽ không bao giờ hit, phá hiệu năng preview nesting.
            # Dùng đường GỐC làm khoá vẫn đúng vì cùng một file luôn chuẩn hoá ra cùng
            # hình học.
            from app.workers.nup_engine import canonical_page_space
            _doc_path = _canon_stack.enter_context(canonical_page_space(file_path))
            if _doc_path != file_path:
                _plog("canonicalize page space")
            doc = pdf_lib.open(_doc_path)
            _plog(f"open doc ({file_path.split(chr(92))[-1]}, {doc.page_count}p)")
            src_page_count = doc.page_count
            # SSOT số mẫu đang có trên dải thumbnail. PDF vật lý có thể vẫn chỉ
            # có 1 trang trong lúc các bản nhân đang được materialize.
            _live_preview_page_count = int(getattr(req, 'total_pages', 0) or 0)
            if _live_preview_page_count <= 0:
                _live_preview_page_count = int(doc.page_count or 0)

            # Tách vị trí loại đang xem khỏi chỉ số trang vật lý. Với thumbnail
            # nhân bản, viewer có thể đang ở loại 3 trong khi PDF fallback còn 1 trang.
            _requested_page_idx = max(0, int(getattr(req, 'page_idx', 0) or 0))
            _viewer_page_idx = min(_requested_page_idx, max(0, _live_preview_page_count - 1))
            page_idx = min(_viewer_page_idx, max(0, doc.page_count - 1))
            page = doc[page_idx]
            
            # ── N-Up MULTI-PAGE PREVIEW: bin-pack all pages together ──
            # task_mode can be 'nup' (user selected explicitly) or 'sticker_imposer' (initial default)
            _tm = getattr(req, 'task_mode', None)
            _lt = getattr(req, 'layout_type', None)
            _tq = getattr(req, 'target_quantity', 0)
            logger.debug("[PREVIEW DEBUG] task_mode=%r layout_type=%r target_qty=%s page_count=%d", _tm, _lt, _tq, doc.page_count)
            # cluster_tile (chia cụm) đi nhánh cluster RIÊNG (dùng chung SSOT
            # compute_cluster_placements với export), kể cả file nhiều trang → loại khỏi
            # is_nup_multi để không bị bin-pack trộn nuốt.
            # cluster_tile chạy cho CẢ die-cut (bế/CNC, nest NFP) LẪN guillotine (bình
            # cắt xén, nest grid solve_optimal_layout). _cluster_is_die phân nhánh nest.
            _is_cluster_req = (
                getattr(req, 'grouping_strategy', None) == 'cluster_tile'
                and _lt != 'repeat'
            )
            _cluster_is_die = bool(getattr(req, 'is_die_cut', False))
            is_nup_multi = (
                _tm in ('nup', 'booklet', 'sticker_imposer')
                and _lt != 'repeat'
                and _live_preview_page_count > 1
                and (_tm == 'sticker_imposer' or bool(getattr(req, 'is_die_cut', False)))
                and not _is_cluster_req
            )
            # Lưu ý: "trộn nhiều mẫu / auto-fill" là tính năng DIE-CUT (Bế tem/CNC).
            # Bình bài xén (taskMode='nup', guillotine) dao chém THẲNG → phải dùng
            # LƯỚI ĐỀU (solve_optimal_layout) để preview KHỚP output (render guillotine
            # cũng dùng solve_optimal_layout). KHÔNG đi nhánh bin-pack trộn ở đây.
            
            if _is_cluster_req:
                _plog("ENTER cluster branch")
                # ══ CHIA CỤM (cluster_tile) PREVIEW — DÙNG CHUNG SSOT với export ══
                # compute_cluster_placements xử cả single/multi-page + 3 kiểu ghép
                # (replicate_mixed / zone_per_type / zone_ratio). Preview ≡ output vì
                # cùng hàm, cùng zone_layout_fn (nest 1 loại phủ đầy vùng).
                from app.workers.cluster_tile_engine import compute_cluster_sheets
                from app.workers.nup_diecut import _find_largest_die_path
                from app.workers.nup_sticker import compute_sticker_layout_for_page as _csl_c

                bleed_pt = req.bleed or 0
                MM = 2.83465
                combine_mode = getattr(req, 'cluster_combine_mode', 'replicate_mixed')
                # Guillotine cluster (bình cắt xén, KHÔNG bế): nest trong vùng bằng
                # grid solver, KHÔNG NFP/đường bế → khớp export (_gui_zone_layout_fn).
                _is_gui_cluster = not bool(getattr(req, 'is_die_cut', False))
                from app.workers.nup_layout_solver import solve_manual as _sm_c, solve_optimal_layout as _sol_c
                _uw = req.usable_w
                _uh = req.usable_h
                _ml = getattr(req, 'margin_left', 0) or 0
                _mb = getattr(req, 'margin_bottom', 0) or 0
                _mt = getattr(req, 'margin_top', 0) or 0
                _shapes = getattr(req, 'detected_shapes_by_page', None) or {}
                _sprops = getattr(req, 'detected_shape_params_by_page', None) or {}
                _tqbp = getattr(req, 'target_quantities_by_page', None) or {}
                _gq = getattr(req, 'target_quantity', 0) or 0

                def _qty_c(pi):
                    q = _tqbp.get(str(pi), _tqbp.get(pi, _gq))
                    try:
                        q = int(q)
                    except (TypeError, ValueError):
                        q = 0
                    return q if q > 0 else 1

                # page_infos mọi trang (multi-type). trim từ đường bế nếu có.
                # _die_geo_by_page_c: pi → (die_items, die_rect) để gắn diePolylines
                # PER-CELL (đường bế THẬT + transform xoay/lật) như S&R, thay vì scale
                # outline chuẩn hoá vào bbox (méo).
                page_infos_c = []
                _die_geo_by_page_c = {}
                _genuine_die_idxs_c = []
                from app.workers.nup_diecut import resolve_one_dao_trim as _r1d_cl
                _dsm_cl = getattr(req, 'die_size_mode', 'die')
                _dom_cl = getattr(req, 'die_offset_mm', 0)
                _ct_cl = getattr(req, 'cut_type', 'default')
                for pi in range(doc.page_count):
                    pg = doc[pi]
                    if _is_gui_cluster:
                        if req.page_sheet_mode:
                            from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
                            _geo_c = resolve_page_sheet_geometry(pg.rect.width, pg.rect.height, bleed_pt)
                            tw_c, th_c = _geo_c.trim_width, _geo_c.trim_height
                        elif abs(pg.trimbox.width - pg.rect.width) > 1.0:
                            tw_c, th_c = pg.trimbox.width, pg.trimbox.height
                        else:
                            tw_c = pg.rect.width - 2 * bleed_pt
                            th_c = pg.rect.height - 2 * bleed_pt
                        page_infos_c.append((pi, _qty_c(pi), tw_c, th_c))
                        continue
                    lp = _find_largest_die_path(pg)
                    # 1 Dao + "theo kích thước trang": trim = mediabox ± offset (chung export).
                    _odt = _r1d_cl(pg, _ct_cl, _dsm_cl, _dom_cl)
                    if lp and _odt is None:
                        _genuine_die_idxs_c.append(pi)
                    if _odt is not None:
                        # page mode: cắt là chữ nhật theo trang → KHÔNG gắn contour thật
                        # (tránh preview vẽ đường bế bo góc trong khi cắt thẳng).
                        tw_c, th_c = _odt
                    elif lp:
                        tw_c, th_c = lp['rect'].width, lp['rect'].height
                        if lp.get('items'):
                            _die_geo_by_page_c[pi] = (lp['items'], lp['rect'])
                    else:
                        tw_c = pg.rect.width - 2 * bleed_pt
                        th_c = pg.rect.height - 2 * bleed_pt
                    page_infos_c.append((pi, _qty_c(pi), tw_c, th_c))

                # Cluster dùng cùng master context với S&R/homogeneous. Chỉ đúng
                # một page có geometry thật mới được kế thừa; multi-mold no-op.
                _single_mold_master_c = None
                if (not _is_gui_cluster and doc.page_count >= 2
                        and len(_genuine_die_idxs_c) == 1):
                    _single_mold_master_c = _genuine_die_idxs_c[0]
                    _master_info_c = next(
                        info for info in page_infos_c
                        if info[0] == _single_mold_master_c
                    )
                    _master_geo_c = _die_geo_by_page_c.get(_single_mold_master_c)
                    page_infos_c = [
                        (pi, qty, _master_info_c[2], _master_info_c[3])
                        for pi, qty, _tw, _th in page_infos_c
                    ]
                    if _master_geo_c is not None:
                        for pi in range(doc.page_count):
                            _die_geo_by_page_c[pi] = _master_geo_c

                # PARITY với export (nup_engine): CHỈ replicate_mixed sort theo kích
                # thước (gom mọi loại vào 1 cụm). zone_per_type / zone_ratio giữ THỨ TỰ
                # TRANG (mỗi loại 1 vùng theo trang 1→N) → KHÔNG sort.
                if combine_mode == 'replicate_mixed':
                    page_infos_c.sort(key=lambda x: min(x[2], x[3]), reverse=True)

                _sg_c = _resolve_preview_secondary_gap(req)

                # ── TIMING: đo từng nest preview (ghi rot_audit.log) ──
                import time as _time_c
                _tc_start = _time_c.perf_counter()
                def _tclog(_lbl):
                    try:
                        from app.workers.rot_audit_log import get_logger as _rgl
                        _rgl().warning("[CLUSTER-TIMING][PREVIEW] %-30s (tổng %6.1fms)",
                                       _lbl, (_time_c.perf_counter() - _tc_start) * 1000.0)
                    except Exception:
                        pass

                # Cache nest SỐNG QUA REQUEST (_ZONE_NEST_CACHE, module-level LRU) →
                # lăn chuột / đổi setting không đụng layout KHÔNG nest lại 17 loại (~4.7s).
                # Key gồm file+mtime để tự vô hiệu khi file đổi; zone dims + params layout.
                try:
                    _zc_mtime = int(os.path.getmtime(file_path))
                except OSError:
                    _zc_mtime = 0
                _zc_fp = os.path.abspath(file_path)

                def _zone_layout_fn_c(p_idx, zone_w, zone_h):
                    _geometry_idx_c = (
                        _single_mold_master_c
                        if _single_mold_master_c is not None
                        else p_idx
                    )
                    _ps = (_shapes.get(str(_geometry_idx_c))
                           or _shapes.get(_geometry_idx_c))
                    _pp = (_sprops.get(str(_geometry_idx_c))
                           or _sprops.get(_geometry_idx_c) or {})
                    _ck = (
                        _zc_fp, _zc_mtime, _geometry_idx_c,
                        round(zone_w, 1), round(zone_h, 1),
                        round(req.gap_x, 2), round(req.gap_y, 2),
                        req.strategy, _ps or None,
                        _json_batch.dumps(_pp, sort_keys=True) if _pp else '',
                        round(bleed_pt, 2),
                        round(_sg_c, 2) if _sg_c is not None else None,
                        _is_gui_cluster,
                        _ct_cl, _dsm_cl, round(float(_dom_cl or 0), 3),
                        int(req.cols or 0), int(req.rows or 0),
                    )
                    _hit = _ZONE_NEST_CACHE.get(_ck)
                    if _hit is not None:
                        _ZONE_NEST_CACHE.move_to_end(_ck)
                        return _hit
                    _pg = doc[_geometry_idx_c]
                    _t_n = _time_c.perf_counter()
                    if _is_gui_cluster:
                        if req.page_sheet_mode:
                            from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
                            _geo_g = resolve_page_sheet_geometry(_pg.rect.width, _pg.rect.height, bleed_pt)
                            _tw_g, _th_g = _geo_g.trim_width, _geo_g.trim_height
                        elif abs(_pg.trimbox.width - _pg.rect.width) > 1.0:
                            _tw_g, _th_g = _pg.trimbox.width, _pg.trimbox.height
                        else:
                            _tw_g = _pg.rect.width - 2 * bleed_pt
                            _th_g = _pg.rect.height - 2 * bleed_pt
                        try:
                            if req.strategy == 'manual':
                                _sol = _sm_c(
                                    _tw_g, _th_g, req.gap_x, req.gap_y,
                                    req.cols, req.rows,
                                )
                                if (_sol.get('overallWidth', 0) > zone_w + 0.01
                                        or _sol.get('overallHeight', 0) > zone_h + 0.01):
                                    raise ValueError("Manual grid exceeds cluster area")
                            else:
                                _sol = _sol_c(
                                    zone_w, zone_h, _tw_g, _th_g,
                                    req.gap_x, req.gap_y, req.strategy, _sg_c,
                                )
                            _r = {'items': [{
                                'x': _c['x'], 'y': _c['y'],
                                'width': _c['width'], 'height': _c['height'],
                                'isRotated': _c.get('isRotated', False),
                                'isRotated180': False,
                            } for _c in _sol.get('cells', [])]}
                        except Exception as _e_zg:
                            logger.warning("preview gui zone p_idx=%s lỗi: %s", p_idx, _e_zg)
                            _r = {'items': []}
                        _ZONE_NEST_CACHE[_ck] = _r
                        if len(_ZONE_NEST_CACHE) > _ZONE_NEST_CACHE_MAX:
                            _ZONE_NEST_CACHE.popitem(last=False)
                        return _r
                    try:
                        _r = _csl_c(
                            _pg, zone_w, zone_h, req.gap_x, req.gap_y,
                            strategy=req.strategy,
                            shape_type_override=_ps if _ps else None,
                            shape_props_override=_pp if _pp else None,
                            bleed_pt=bleed_pt,
                            secondary_gap=_sg_c,
                            cut_type=_ct_cl,
                            die_size_mode=_dsm_cl,
                            die_offset_mm=_dom_cl,
                        )
                    except Exception as _e_zc:
                        logger.warning("preview zone_layout_fn p_idx=%s lỗi: %s", p_idx, _e_zc)
                        _r = {'items': []}
                    _tclog(f"nest p_idx={p_idx} zone={round(zone_w,1)}x{round(zone_h,1)} "
                           f"-> {len(_r.get('items', []))} con "
                           f"({(_time_c.perf_counter() - _t_n) * 1000:.0f}ms)")
                    _ZONE_NEST_CACHE[_ck] = _r
                    if len(_ZONE_NEST_CACHE) > _ZONE_NEST_CACHE_MAX:
                        _ZONE_NEST_CACHE.popitem(last=False)
                    return _r

                # cluster_w/h cho replicate_mixed theo sizing mode (mirror export).
                _csm = req.cluster_sizing_mode
                _tgx = (req.tile_gap_x or 0)
                _tgy = (req.tile_gap_y or 0)
                if _csm in ('grid', 'split_cols', 'split_rows'):
                    if _csm == 'split_cols':
                        _cc, _cr = max(1, req.cluster_cols or 2), 1
                    elif _csm == 'split_rows':
                        _cc, _cr = 1, max(1, req.cluster_rows or 2)
                    else:
                        _cc, _cr = max(1, req.cluster_cols or 2), max(1, req.cluster_rows or 2)
                    _cw = (_uw - (_cc - 1) * _tgx) / _cc
                    _ch = (_uh - (_cr - 1) * _tgy) / _cr
                else:
                    _cw = (req.cluster_w or 148.0 * MM)
                    _ch = (req.cluster_h or 210.0 * MM)

                # replicate_mixed cần full_layouts (nest ở kích thước cụm) — dựng như export.
                full_layouts_c = {}
                if combine_mode == 'replicate_mixed':
                    for pi, _q, _tw, _th in page_infos_c:
                        full_layouts_c[pi] = _zone_layout_fn_c(pi, _cw, _ch)

                cluster_sheets = compute_cluster_sheets(
                    page_infos=page_infos_c,
                    full_layouts=full_layouts_c,
                    zone_layout_fn=_zone_layout_fn_c,
                    sheet_w=_uw,
                    sheet_h=_uh,
                    cluster_w=_cw,
                    cluster_h=_ch,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    tile_gap_x=_tgx,
                    tile_gap_y=_tgy,
                    combine_mode=combine_mode,
                    cluster_nesting=bool(getattr(req, 'cluster_nesting', True)),
                    is_die_cut=_cluster_is_die,
                    zone_cols=max(1, req.cluster_cols or 2),
                    zone_rows=max(1, req.cluster_rows or 1),
                )
                doc.close()

                # Dựng MỌI tờ (frontend lật ◄ 1/N ►). zone modes → nhiều tờ (mỗi tờ 1
                # bộ loại); replicate_mixed → 1 tờ mẫu. Mỗi tờ: cells abs + cutLines abs.
                _n_sheets_c = len(cluster_sheets)

                _mt_c = getattr(req, 'margin_top', 0) or 0
                from app.workers.nup_artwork import die_polylines_for_placement as _die_pl_c

                def _sheet_to_abs(ct_placements, tile_cut_lines):
                    _cells = []
                    _mw = 0.0
                    _mh = 0.0
                    for place in ct_placements:
                        c = place.get('cell', {})
                        w = place.get('width', 0)
                        h = place.get('height', 0)
                        _sp = place.get('src_page_idx', 0)
                        abs_x = place.get('abs_x', 0) + _ml
                        abs_y = _uh + _mb - place.get('abs_y', 0) - h
                        _cd = {
                            'x': place.get('abs_x', 0), 'y': place.get('abs_y', 0),
                            'absX': abs_x, 'absY': abs_y,
                            'width': w, 'height': h,
                            'isRotated': c.get('isRotated', False),
                            'isRotated180': c.get('isRotated180', False),
                            'blockId': _sp,   # màu theo LOẠI (mỗi loại/vùng 1 màu)
                            'pageIdx': _sp,
                        }
                        # Đường bế THẬT per-cell (như S&R) → contour đúng + transform xoay/lật.
                        _geo = _die_geo_by_page_c.get(_sp)
                        if _geo is not None:
                            _ay_td = (_uh + _mb + _mt_c) - abs_y - h
                            try:
                                _cd['diePolylines'] = _die_pl_c(
                                    _geo[0], _geo[1], abs_x, _ay_td,
                                    is_rotated=c.get('isRotated', False),
                                    is_rotated_180=c.get('isRotated180', False),
                                )
                            except Exception as _e_dpc:
                                logger.debug("cluster die polylines build failed: %s", _e_dpc)
                        _cells.append(_cd)
                        _mw = max(_mw, abs_x + w)
                        _mh = max(_mh, abs_y + h)
                    _cv = sorted({round(x + _ml, 2) for x in tile_cut_lines.get('v', set())})
                    _ch = sorted({round(_uh + _mb - y, 2) for y in tile_cut_lines.get('h', set())})
                    return _cells, _mw, _mh, {"v": _cv, "h": _ch}

                _sheets_out = []
                for _pls, _cuts in cluster_sheets:
                    _cells, _mw, _mh, _cl = _sheet_to_abs(_pls, _cuts)
                    _sheets_out.append({
                        "cells": _cells,
                        "overallWidth": _mw,
                        "overallHeight": _mh,
                        "totalItems": len(_cells),
                        "cutLines": _cl,
                    })

                # Tờ đầu ở top-level (tương thích code cũ); mọi tờ ở "sheets".
                _first = _sheets_out[0] if _sheets_out else {
                    "cells": [], "overallWidth": 0.0, "overallHeight": 0.0,
                    "totalItems": 0, "cutLines": {"v": [], "h": []},
                }
                return {
                    "success": True,
                    "cells": _first["cells"],
                    "overallWidth": _first["overallWidth"],
                    "overallHeight": _first["overallHeight"],
                    "totalItems": _first["totalItems"],
                    "strategyUsed": "cluster_tile",
                    "clusterCombineMode": combine_mode,
                    "isMixedPreview": True,
                    "absPlacement": True,
                    "cutLines": _first["cutLines"],
                    "sheets": _sheets_out,
                    "sheetsNeeded": max(1, _n_sheets_c),
                }

            if is_nup_multi:
                _plog("ENTER is_nup_multi branch")
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
                    _cnc_die_poly_by_page = {}
                    from app.workers.pont_collision import build_shapely_polygon_from_paths as _bspfp_cnc
                    from app.workers.nup_diecut import resolve_one_dao_trim as _r1d_cnc
                    _dsm_cnc = getattr(req, 'die_size_mode', 'die')
                    _dom_cnc = getattr(req, 'die_offset_mm', 0)
                    _ct_cnc = getattr(req, 'cut_type', 'default')
                    for pi in front_idxs:
                        pg = doc[pi]
                        lp = _find_largest_die_path(pg)
                        _odt = _r1d_cnc(pg, _ct_cnc, _dsm_cnc, _dom_cnc)
                        if _odt is not None:
                            tw, th = _odt
                        elif lp:
                            tw, th = lp['rect'].width, lp['rect'].height
                        else:
                            tw = pg.rect.width - 2 * bleed_pt
                            th = pg.rect.height - 2 * bleed_pt
                        page_dims_qty.append((pi, tw, th, _qty_cnc(pi)))
                        if lp is not None:
                            try:
                                _cnc_die_poly_by_page[pi] = _normalize_polygon_to_unit(
                                    _bspfp_cnc(pg.extract_vector_paths(), pg.rect))
                            except Exception:
                                _cnc_die_poly_by_page[pi] = None

                    cnc_gap = max(req.gap_x, req.gap_y)
                    # Va chạm boong: LOẠI vùng cấm lúc packing — DÙNG CHUNG helper với
                    # cnc_render → preview gang KHỚP output (cùng exclude_zones).
                    cnc_exclude = []
                    _pc = getattr(req, 'pont_config', None)
                    if _pc and not _pc.get('disableCollision', False):
                        try:
                            from app.workers.pont_collision import compute_packer_exclude_zones
                            cnc_exclude = compute_packer_exclude_zones(
                                _pc, getattr(req, 'sheet_w', 0) or 0, getattr(req, 'sheet_h', 0) or 0,
                                req.usable_w, req.usable_h,
                                getattr(req, 'margin_left', 0) or 0,
                                getattr(req, 'margin_bottom', 0) or 0,
                                cnc_gap,
                            )
                        except Exception:
                            cnc_exclude = []

                    cnc_layout = build_cnc_front_layout(
                        page_dims_qty, req.usable_w, req.usable_h,
                        gap=cnc_gap,
                        margin_left=getattr(req, 'margin_left', 0) or 0,
                        margin_bottom=getattr(req, 'margin_bottom', 0) or 0,
                        margin_top=getattr(req, 'margin_top', 0) or 0,
                        exclude_zones=cnc_exclude or None,
                    )
                    doc.close()
                    # ── Branch D: dùng placements (abs_x + original_cell_y TOP-DOWN) khớp
                    # cnc_render. Convert sang abs bottom-up: absY = sheet_h - original_cell_y - h.
                    _sheet_h = getattr(req, 'sheet_h', 0) or 0
                    items = []
                    ov_w = 0.0
                    ov_h = 0.0
                    for pl in cnc_layout['placements']:
                        c = pl['cell']
                        w = pl['width']
                        h = pl['height']
                        abs_x = pl['abs_x']
                        abs_y = _sheet_h - pl['original_cell_y'] - h
                        items.append({
                            'x': c.get('x', 0), 'y': c.get('y', 0),
                            'absX': abs_x, 'absY': abs_y,
                            'width': w, 'height': h,
                            'isRotated': c.get('isRotated', False), 'isRotated180': False,
                            'pageIdx': pl['src_page_idx'],
                        })
                        ov_w = max(ov_w, abs_x + w)
                        ov_h = max(ov_h, abs_y + h)
                    return {
                        "success": True,
                        "cells": items,
                        "overallWidth": ov_w,
                        "overallHeight": ov_h,
                        "totalItems": cnc_layout['items_per_sheet'],
                        "sheetsNeeded": cnc_layout['sheets_needed'],
                        "strategyUsed": "cnc_mixed",
                        "isMixedPreview": True,
                        "isCncPreview": True,
                        "cncTwoSided": cnc_two_sided,
                        "cncFlipEdge": cnc_flip_edge,
                        "absPlacement": True,
                        "placedByPage": {str(k): v for k, v in (cnc_layout.get('placed_by_page') or {}).items()},
                        "diePolygonsByPage": {str(pi): poly for pi, poly in _cnc_die_poly_by_page.items() if poly},
                    }

                page_dims = []
                # Tín hiệu theo CHỈ SỐ TRANG GỐC (pi) cho chế độ ĐỒNG NHẤT — page_dims
                # sẽ bị SORT bên dưới nên KHÔNG dùng được thứ tự của nó để dò master.
                _has_die_by_page = {}
                _genuine_die_by_page = {}  # tín hiệu ĐÁNG TIN (kênh/màu bế) — phân biệt cùng/khác khuôn
                _trim_by_page = {}
                _die_poly_by_page = {}  # pi → đường bế THẬT (0..1) để preview vẽ contour đúng (kể cả CUSTOM)
                # pi → (die_items, die_rect) để gắn diePolylines PER-CELL (đường bế THẬT,
                # transform xoay/lật chính xác) GIỐNG S&R — thay outline scale-vào-bbox (méo).
                _die_geo_by_page = {}
                from app.workers.sticker_homogeneous import page_has_die as _page_has_die
                from app.workers.pont_collision import build_shapely_polygon_from_paths as _bspfp
                from app.workers.nup_diecut import resolve_one_dao_trim as _r1d_b
                _dsm_b = getattr(req, 'die_size_mode', 'die')
                _dom_b = getattr(req, 'die_offset_mm', 0)
                _ct_b = getattr(req, 'cut_type', 'default')
                for pi in range(doc.page_count):
                    pg = doc[pi]
                    # 1 Dao + "theo kích thước trang": trim = mediabox ± offset (chung export).
                    _odt = _r1d_b(pg, _ct_b, _dsm_b, _dom_b)
                    # Page-mode không dùng khuôn thật: bỏ luôn dò path/contour để preview
                    # chỉ còn lưới chữ nhật theo trang và tránh công việc thừa.
                    lp = None if _odt is not None else _find_largest_die_path(pg)
                    if _odt is not None:
                        tw, th = _odt
                    elif lp:
                        r = lp['rect']
                        tw, th = r.width, r.height
                    else:
                        # Dùng MediaBox (rect) — khớp nup_engine; không ưu tiên TrimBox.
                        tw, th = pg.rect.width, pg.rect.height
                        tw -= 2 * bleed_pt
                        th -= 2 * bleed_pt
                    page_dims.append((pi, tw, th))
                    _has_die_by_page[pi] = lp is not None
                    if _odt is not None:
                        _genuine_die_by_page[pi] = False
                    else:
                        try:
                            _genuine_die_by_page[pi] = _page_has_die(pg)
                        except Exception:
                            _genuine_die_by_page[pi] = False
                    _trim_by_page[pi] = (tw, th)
                    # Đường bế THẬT của trang (chỉ khi có khuôn) → preview vẽ đúng contour
                    # cho MỌI hình kể cả CUSTOM (khuôn 'bù xén' trace). extract cache theo Page.
                    if lp is not None and _odt is None:
                        try:
                            _die_poly_by_page[pi] = _normalize_polygon_to_unit(
                                _bspfp(pg.extract_vector_paths(), pg.rect))
                        except Exception:
                            _die_poly_by_page[pi] = None
                        if lp.get('items'):
                            _die_geo_by_page[pi] = (lp['items'], lp['rect'])
                
                # Sort by min dimension descending — MUST match nup_engine line 330
                grouping_strategy = getattr(req, 'grouping_strategy', None) or 'maximize_area'
                if grouping_strategy != 'none':
                    page_dims.sort(key=lambda x: min(x[1], x[2]), reverse=True)
                
                gap_x_pt = req.gap_x
                gap_y_pt = req.gap_y
                
                # ── Pre-compute forbidden zones from ốc/pont marks ──
                # Dùng SSOT compute_packer_exclude_zones — KHỚP đúng output (nup_engine).
                exclude_zones = []
                pont_config = getattr(req, 'pont_config', None)
                if pont_config and not pont_config.get('disableCollision', False) and getattr(req, 'sheet_w', None) and getattr(req, 'sheet_h', None):
                    try:
                        from app.workers.pont_collision import compute_packer_exclude_zones
                        exclude_zones = compute_packer_exclude_zones(
                            pont_config, req.sheet_w, req.sheet_h,
                            req.usable_w, req.usable_h,
                            getattr(req, 'margin_left', 0) or 0,
                            getattr(req, 'margin_bottom', 0) or 0,
                            max(gap_x_pt, gap_y_pt),
                        )
                        if exclude_zones:
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

                # ══ NHÁNH ĐỒNG NHẤT (sticker-homogeneous-nup, Task 7) ══
                # KHỚP output: bật cả khi có SL (không chỉ auto-fill). SL > 1 → mỗi loại
                # lấp đầy tờ (preview tờ 0 = loại nội dung đầu); SL ≤ 1 → rải tuần tự.
                homogeneous_plan = None
                try:
                    from app.workers import sticker_homogeneous as _sh
                    from app.workers.shape_types import (
                        ShapeType as _ShapeType, coerce_shape_type as _coerce,
                    )
                    _det_shapes = getattr(req, 'detected_shapes_by_page', None) or {}
                    _det_params = getattr(req, 'detected_shape_params_by_page', None) or {}
                    _adapters = []
                    # total_pages is the live thumbnail count. The physical PDF may
                    # still be the original file while duplicated thumbnails are
                    # being materialized, so homogeneous preview must not derive the
                    # number of content samples only from doc.page_count.
                    _logical_hom_pages = int(getattr(req, 'total_pages', 0) or 0)
                    if _logical_hom_pages <= 0:
                        _logical_hom_pages = doc.page_count
                    _fallback_trim = _trim_by_page.get(0, (
                        float(getattr(req, 'item_w', 0) or 0),
                        float(getattr(req, 'item_h', 0) or 0),
                    ))
                    for _p in range(_logical_hom_pages):
                        # Page-sized 1 Dao bỏ qua mọi khuôn có sẵn; không được dùng
                        # khuôn cũ làm master/clip homogeneous trong preview.
                        _page_sized_one_dao_pv = (_ct_b == 'one_dao' and _dsm_b == 'page')
                        _hd = (False if _page_sized_one_dao_pv or _p >= doc.page_count
                               else _genuine_die_by_page.get(_p, False))
                        if _hd:
                            _s = (_det_shapes.get(str(_p)) or _det_shapes.get(_p))
                            try:
                                _stype = _coerce(_s) if _s else _ShapeType.CUSTOM
                            except Exception:
                                _stype = _ShapeType.CUSTOM
                        else:
                            _stype = _ShapeType.CUSTOM
                        _tw, _th = _trim_by_page.get(_p, _fallback_trim)
                        _poly = (((0.0, 0.0), (_tw, 0.0), (_tw, _th), (0.0, _th))
                                 if _hd else ())
                        _props = (_det_params.get(str(_p)) or _det_params.get(_p) or {})
                        _adapters.append(_sh.make_shape_adapter(_stype, _poly, _tw, _th, _props, has_die=_hd))
                    homogeneous_plan = _sh.detect_homogeneous(_adapters)
                except Exception as _e_hom:
                    import logging
                    logging.getLogger(__name__).warning(
                        f"[HOMOGENEOUS PREVIEW] Phát hiện thất bại → giữ đường cũ: {_e_hom}")
                    homogeneous_plan = None

                if homogeneous_plan is not None:
                    from app.workers.nup_sticker import compute_sticker_layout_for_page as _csl
                    _master_idx = homogeneous_plan.master_page_idx
                    _master_page = doc[_master_idx]
                    # Nesting master ĐÚNG MỘT LẦN (shape-aware) — dùng làm layout_fn.
                    _master_layout = _csl(
                        _master_page, req.usable_w, req.usable_h, req.gap_x, req.gap_y,
                        strategy='optimal_auto',
                        shape_type_override=homogeneous_plan.shape_type.name,
                        shape_props_override=(homogeneous_plan.shape_props or None),
                        bleed_pt=bleed_pt,
                    )
                    if not (_master_layout and _master_layout.get('items')):
                        # Master nesting trống → bỏ nhánh đồng nhất, rơi xuống đường cũ.
                        logger.info("[HOMOGENEOUS PREVIEW] Master nesting trống → fallback bin-pack trộn")
                        homogeneous_plan = None

                if homogeneous_plan is not None:
                    _content_qtys_pv = [
                        _qty_for_page(_cp) for _cp in homogeneous_plan.content_pages
                    ]
                    # Non-repeat homogeneous luôn là dàn nhiều mẫu, kể cả fixed qty.
                    _use_per_type_pv = False
                    _hom_layout = _sh.build_homogeneous_layout(
                        master_page=None,
                        plan=homogeneous_plan,
                        sheet_usable_w=req.usable_w,
                        sheet_usable_h=req.usable_h,
                        gap_x=req.gap_x,
                        gap_y=req.gap_y,
                        bleed_pt=bleed_pt,
                        secondary_gap=None,
                        quantities=(_content_qtys_pv
                                    if any(q > 0 for q in _content_qtys_pv) else None),
                        layout_fn=(lambda *_a, **_k: _master_layout),
                    )

                    # base_poly master: ellipse chuẩn cho Tròn/Elip; còn lại None (≈ chữ nhật).
                    _master_base_poly = None
                    if homogeneous_plan.shape_type == _sh.ShapeType.CIRCLE_ELLIPSE:
                        try:
                            from shapely.geometry import Point as _Point
                            from shapely.affinity import scale as _scale
                            _rx = homogeneous_plan.trim_w / 2.0
                            _ry = homogeneous_plan.trim_h / 2.0
                            if _rx > 0 and _ry > 0:
                                _master_base_poly = _scale(_Point(0, 0).buffer(1.0, resolution=64),
                                                           xfact=_rx, yfact=_ry)
                        except Exception:
                            _master_base_poly = None

                    _ml = getattr(req, 'margin_left', 0) or 0
                    _mb = getattr(req, 'margin_bottom', 0) or 0
                    _mt = getattr(req, 'margin_top', 0) or 0

                    # TỜ 0: căn-giữa khối ô (SSOT) → gán src_page_idx nội dung → giải boong.
                    _items = list(_hom_layout.items)
                    _pls = finalize_placements(
                        _items, req.usable_w, req.usable_h, _ml, _mb, _mt, _master_idx,
                    )
                    if _use_per_type_pv:
                        # Tờ mẫu loại đầu tiên có SL > 0 (khớp output per-type).
                        _first_src = next(
                            (_cp for _cp, _q in zip(homogeneous_plan.content_pages, _content_qtys_pv)
                             if _q > 0),
                            homogeneous_plan.content_pages[0],
                        )
                        for _pl in _pls:
                            _pl['src_page_idx'] = _first_src
                        _sheet_pls = _pls
                    else:
                        _by_cell = {cc.cell_index: cc.src_page_idx
                                    for cc in _hom_layout.cell_contents if cc.sheet_index == 0}
                        _sheet_pls = []
                        for _ci, _pl in enumerate(_pls):
                            if _ci in _by_cell:
                                _pl['src_page_idx'] = _by_cell[_ci]
                                _sheet_pls.append(_pl)
                    # Boong: CÙNG hàm với output (parity). req đã có pont_config/sheet_w/h/margins.
                    _sheet_pls = resolve_pont_collisions_on_placements(
                        _sheet_pls, req, base_poly=_master_base_poly)

                    doc.close()

                    cells = []
                    ov_w = 0.0
                    ov_h = 0.0
                    for _pl in _sheet_pls:
                        _c = _pl['cell']
                        _w = _pl['width']
                        _h = _pl['height']
                        _ax = _pl['abs_x']
                        _ay = _pl['abs_y']
                        cells.append({
                            'x': _c.get('x', 0), 'y': _c.get('y', 0),
                            'absX': _ax, 'absY': _ay,
                            'width': _w, 'height': _h,
                            'isRotated': _c.get('isRotated', False),
                            'isRotated180': _c.get('isRotated180', False),
                            'pageIdx': _pl['src_page_idx'],
                        })
                        ov_w = max(ov_w, _ax + _w)
                        ov_h = max(ov_h, _ay + _h)

                    # Trả MỌI tờ để frontend lật 1/N. Khi 45 mẫu nhưng sức chứa
                    # chỉ 28, top-level vẫn là tờ 1 (28 ô), còn sheets[1] là 17 ô.
                    # Hình học mọi tờ dùng cùng layout master; chỉ pageIdx thay đổi.
                    _sheets_out_h = []
                    if _use_per_type_pv:
                        _sheets_out_h.append({
                            "cells": [dict(_c) for _c in cells],
                            "overallWidth": ov_w, "overallHeight": ov_h,
                            "totalItems": len(cells),
                        })
                    else:
                        for _si_h in range(max(1, _hom_layout.num_sheets)):
                            _by_cell_h = {
                                _cc.cell_index: _cc.src_page_idx
                                for _cc in _hom_layout.cell_contents
                                if _cc.sheet_index == _si_h
                            }
                            _cells_h = [
                                {**cells[_ci_h], "pageIdx": _src_h}
                                for _ci_h, _src_h in sorted(_by_cell_h.items())
                                if 0 <= _ci_h < len(cells)
                            ]
                            _sheets_out_h.append({
                                "cells": _cells_h, "overallWidth": ov_w,
                                "overallHeight": ov_h, "totalItems": len(_cells_h),
                            })
                    logger.info(
                        "[HOMOGENEOUS PREVIEW] master=trang %d, shape=%s, %d ô (tờ 0, perType=%s)",
                        _master_idx, homogeneous_plan.shape_type.name, len(cells),
                        _use_per_type_pv,
                    )
                    return {
                        "success": True,
                        "cells": cells,
                        "overallWidth": ov_w,
                        "overallHeight": ov_h,
                        # Sức chứa HÌNH HỌC tối đa của khuôn trên một tờ, không phải
                        # số mẫu hiện có đang được rải trên tờ đầu.
                        "totalItems": _hom_layout.cells_per_sheet,
                        "strategyUsed": "homogeneous",
                        "isMixedPreview": True,
                        "absPlacement": True,
                        "isHomogeneousPreview": True,
                        "sheets": _sheets_out_h,
                        # Tổng số mẫu của toàn bộ job, không chỉ số mẫu nằm trên tờ 1.
                        "totalContentItems": len(homogeneous_plan.content_pages),
                        "sheetsNeeded": _hom_layout.num_sheets,
                        # Mọi ô = hình MASTER → map mỗi trang nội dung → đường bế master.
                        "diePolygonsByPage": (
                            {str(_cp): _die_poly_by_page.get(_master_idx)
                             for _cp in homogeneous_plan.content_pages}
                            if _die_poly_by_page.get(_master_idx) else {}
                        ),
                    }

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
                        uniform_if_equal=(_ct_b == 'one_dao' and _dsm_b == 'page'),
                    )
                
                doc.close()

                # ── Branch C: toạ độ TUYỆT ĐỐI khớp export (_finalize_sheet_centering, nup_engine L690-713) ──
                # Packer trả top-left (y-down); căn giữa rồi flip → abs bottom-up sheet space.
                _ml = getattr(req, 'margin_left', 0) or 0
                _mb = getattr(req, 'margin_bottom', 0) or 0
                _mt = getattr(req, 'margin_top', 0) or 0
                _pl = bp_result['placements']
                max_x_used = max((p['x'] + p['w'] for p in _pl), default=0.0)
                max_bottom = max((p['y'] + p['h'] for p in _pl), default=0.0)
                x_off = _ml + (req.usable_w - max_x_used) / 2 if max_x_used < req.usable_w else _ml
                y_off = _mb + (req.usable_h - max_bottom) / 2 if max_bottom < req.usable_h else _mb

                # Đường bế THẬT per-cell (như S&R) → mỗi ô vẽ đúng contour + transform
                # xoay/lật, thay vì scale outline chuẩn hoá vào bbox (méo). Toạ độ TOP-DOWN
                # trang đích: _ay_td = (usable_h + mb + mt) - abs_y - h (nhất quán S&R).
                from app.workers.nup_artwork import die_polylines_for_placement as _die_pl_mixed

                items = []
                ov_w = 0.0
                ov_h = 0.0
                for p in _pl:
                    abs_x = x_off + p['x']
                    abs_y = y_off + (max_bottom - p['y'] - p['h'])
                    _cell_mixed = {
                        'x': p['x'],
                        'y': p['y'],
                        'absX': abs_x,
                        'absY': abs_y,
                        'width': p['w'],
                        'height': p['h'],
                        'isRotated': p['is_rotated'],
                        'isRotated180': False,
                        'pageIdx': p['page_idx'],
                    }
                    _geo = _die_geo_by_page.get(p['page_idx'])
                    if _geo is not None:
                        _ay_td = (req.usable_h + _mb + _mt) - abs_y - p['h']
                        try:
                            _cell_mixed['diePolylines'] = _die_pl_mixed(
                                _geo[0], _geo[1], abs_x, _ay_td,
                                is_rotated=p['is_rotated'],
                                is_rotated_180=False,
                            )
                        except Exception as _e_dpl:
                            logger.debug("mixed die polylines build failed: %s", _e_dpl)
                    items.append(_cell_mixed)
                    ov_w = max(ov_w, abs_x + p['w'])
                    ov_h = max(ov_h, abs_y + p['h'])

                logger.debug("[BIN-PACK PREVIEW] %d items, overall=%.1fx%.1f, zones=%d", len(items), ov_w, ov_h, len(exclude_zones))

                return {
                    "success": True,
                    "cells": items,
                    "overallWidth": ov_w,
                    "overallHeight": ov_h,
                    "totalItems": len(items),
                    "strategyUsed": "bin_pack_mixed",
                    "isMixedPreview": True,
                    "absPlacement": True,
                    # Đường bế THẬT theo từng trang → mỗi ô vẽ đúng contour (kể cả CUSTOM).
                    "diePolygonsByPage": {str(pi): poly for pi, poly in _die_poly_by_page.items() if poly},
                }
            
            # ── CLUSTER-TYPE PREVIEW: chia tỷ lệ + CHIA CỌC theo LOẠI (mỗi loại 1 cọc) ──
            # Khớp nhánh precalc cluster_type trong nup_engine: KHÔNG chia usable đều —
            # giải lưới ĐẦY ĐỦ tờ rồi phân CỘT (mode column) / HÀNG (mode row) cho mỗi loại
            # theo TỶ LỆ SL (bề rộng cọc ∝ SL), chèn gutter giữa các dải, mỗi dải 1 band.
            # Dàn nhiều loại (ratio_stack) + CHIA CỌC → LUÔN mỗi cọc 1 loại.
            _cmode_mp = (getattr(req, 'cluster_mode', None) or 'none')
            if (not getattr(req, 'is_die_cut', False)
                    and _lt == 'ratio_stack'
                    and _cmode_mp in ('row', 'column')
                    and doc.page_count > 1
                    and _tm in ('nup', 'step_repeat', 'booklet')):
                from app.workers.nup_layout_solver import (
                    solve_optimal_layout as _sol_ct, solve_manual as _sm_ct,
                    compute_cluster_type_alloc as _cta,
                )
                import math as _math_ct
                # cluster_gap từ preview payload đã là POINT (frontend nhân MM_TO_PT như
                # gap_x/margins). KHÔNG nhân lại. (Engine nhận mm nên tự nhân — khác đường.)
                _cgap_ct = float(getattr(req, 'cluster_gap', 0) or 0)
                _bleed_ct = req.bleed or 0
                _trim_w_ct = max(req.item_w - 2 * _bleed_ct, 1.0)
                _trim_h_ct = max(req.item_h - 2 * _bleed_ct, 1.0)
                # Nguồn số loại + SL từng loại — CẦN TÍNH TRƯỚC solve để ước tính số band
                # (BUG-2). _nsrc_ct = số trang viewer (khớp execute page_count sau khi
                # xóa/thêm thumbnail); _qtys_ct = SL mỗi đơn vị (cặp trang nếu 2 mặt).
                _tp_ct = int(getattr(req, 'total_pages', 0) or 0)
                _dn_ct = int(doc.page_count or 0)
                _nsrc_ct = (_tp_ct if not (_dn_ct > 0 and _dn_ct < _tp_ct) else _dn_ct) if _tp_ct > 0 else _dn_ct
                _nsrc_ct = max(1, int(_nsrc_ct))
                _tqbp_ct = getattr(req, 'target_quantities_by_page', None) or {}
                _gq_ct = getattr(req, 'target_quantity', 0) or 0

                def _qty_ct(_pi):
                    _q = _tqbp_ct.get(str(_pi), _tqbp_ct.get(_pi, _gq_ct))
                    try:
                        return max(0, int(_q))
                    except (TypeError, ValueError):
                        return 0

                _dup_ct = ((getattr(req, 'duplex_flow', None) or 'normal') == 'double'
                           and _nsrc_ct >= 2 and _nsrc_ct % 2 == 0)
                _nu_ct = (_nsrc_ct // 2) if _dup_ct else _nsrc_ct
                _qtys_ct = [_qty_ct((_u * 2) if _dup_ct else _u) for _u in range(_nu_ct)]

                # Lưới ĐẦY ĐỦ tờ (KHÔNG chia usable đều). CHIA CỌC: ép simple_auto (lưới
                # ĐỀU) — khớp execute (nup_engine). Dao guillotine cần đường xén thẳng;
                # optimal_auto (L-fill) làm ô khối phụ giữ c/r sub-grid 0-based → map
                # _c['c']→loại SAI → xén lẫn lộn.
                # BUG-2 FIX: TRỪ gutter (n_band-1)*cluster_gap khỏi usable TRƯỚC solve để
                # super-grid ≤ usable (không tràn lề). Band tối đa = số loại SL>0.
                _n_bands_est = sum(1 for _q in _qtys_ct if _q > 0) or _nu_ct
                _gutter_total = max(0, _n_bands_est - 1) * _cgap_ct
                _uw_ct = max(_trim_w_ct, req.usable_w - _gutter_total) if cluster_mode == 'column' else req.usable_w
                _uh_ct = max(_trim_h_ct, req.usable_h - _gutter_total) if cluster_mode == 'row' else req.usable_h
                if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                    _lay_ct = _sm_ct(_trim_w_ct, _trim_h_ct, req.gap_x, req.gap_y, req.cols, req.rows)
                else:
                    _lay_ct = _sol_ct(
                        usable_w=_uw_ct, usable_h=_uh_ct,
                        orig_w=_trim_w_ct, orig_h=_trim_h_ct,
                        gap_x=req.gap_x, gap_y=req.gap_y,
                        strategy='simple_auto', secondary_gap=getattr(req, 'split_gap', None),
                    )
                _cells_ct = _lay_ct.get('cells', [])
                _cap_ct = len(_cells_ct)

                if _cap_ct > 0 and _qtys_ct:
                    # Kích thước lưới: số cột × hàng. 'column' chia CỘT, 'row' chia HÀNG.
                    _cols_ct = max((c['c'] for c in _cells_ct), default=0) + 1
                    _rows_ct = max((c['r'] for c in _cells_ct), default=0) + 1
                    if _cmode_mp == 'column':
                        _total_lines_ct, _lines_cross_ct = _cols_ct, _rows_ct
                    else:
                        _total_lines_ct, _lines_cross_ct = _rows_ct, _cols_ct
                    _alloc_ct = _cta(_total_lines_ct, _lines_cross_ct, _qtys_ct)
                    _lines_of_ct = _alloc_ct['linesPerType']

                    # Gán DÒNG → loại + band (giống engine).
                    _line_type_ct = {}
                    _line_band_ct = {}
                    _band_c = 0
                    _cur_line_c = 0
                    for _t, _nl in enumerate(_lines_of_ct):
                        if int(_nl) <= 0:
                            continue
                        for _ in range(int(_nl)):
                            _line_type_ct[_cur_line_c] = _t
                            _line_band_ct[_cur_line_c] = _band_c
                            _cur_line_c += 1
                        _band_c += 1
                    _num_bands_ct = max(1, _band_c)

                    _bw1_ct = max((c['x'] + c['width'] for c in _cells_ct), default=0.0)
                    _bh1_ct = max((c['y'] + c['height'] for c in _cells_ct), default=0.0)
                    if _cmode_mp == 'column':
                        _supw_ct = _bw1_ct + max(0, _num_bands_ct - 1) * _cgap_ct
                        _suph_ct = _bh1_ct
                    else:
                        _supw_ct = _bw1_ct
                        _suph_ct = _bh1_ct + max(0, _num_bands_ct - 1) * _cgap_ct
                    _al_ct = (getattr(req, 'align', None) or 'center')
                    if not isinstance(_al_ct, str):
                        _al_ct = 'center'
                    _ml_ct = getattr(req, 'margin_left', 0) or 0
                    _mb_ct = getattr(req, 'margin_bottom', 0) or 0
                    _mr_ct = getattr(req, 'margin_right', 0) or 0
                    _mt_ct = getattr(req, 'margin_top', 0) or 0
                    _shw_ct = getattr(req, 'sheet_w', 0) or 0
                    _shh_ct = getattr(req, 'sheet_h', 0) or 0
                    if 'left' in _al_ct:
                        _sbx_ct = _ml_ct
                    elif 'right' in _al_ct and _shw_ct > 0:
                        _sbx_ct = _shw_ct - _mr_ct - _supw_ct
                    else:
                        _sbx_ct = _ml_ct + (req.usable_w - _supw_ct) / 2
                    if 'top' in _al_ct and _shh_ct > 0:
                        _sby_ct = _shh_ct - _mt_ct - _suph_ct
                    elif 'bottom' in _al_ct:
                        _sby_ct = _mb_ct
                    else:
                        _sby_ct = _mb_ct + (req.usable_h - _suph_ct) / 2

                    _items_ct = []
                    _ow_ct = _oh_ct = 0.0
                    _pbp_ct = {}
                    for _c in _cells_ct:
                        _line = _c['c'] if _cmode_mp == 'column' else _c['r']
                        _t = _line_type_ct.get(_line)
                        if _t is None:
                            continue
                        _b = _line_band_ct[_line]
                        if _cmode_mp == 'column':
                            _ax = _sbx_ct + _c['x'] + _b * _cgap_ct
                            _ay = _sby_ct + (_bh1_ct - _c['y'] - _c['height'])
                        else:
                            _ax = _sbx_ct + _c['x']
                            _ay = _sby_ct + (_suph_ct - (_c['y'] + _b * _cgap_ct) - _c['height'])
                        _pi_ct = (_t * 2) if _dup_ct else _t  # tờ 0 = mặt trước
                        _items_ct.append({
                            'x': _c['x'], 'y': _c['y'],
                            'absX': _ax, 'absY': _ay,
                            'width': _c['width'], 'height': _c['height'],
                            'isRotated': bool(_c.get('isRotated', False)),
                            'isRotated180': False,
                            'pageIdx': _pi_ct,
                        })
                        _pbp_ct[str(_pi_ct)] = _pbp_ct.get(str(_pi_ct), 0) + 1
                        _ow_ct = max(_ow_ct, _ax + _c['width'])
                        _oh_ct = max(_oh_ct, _ay + _c['height'])
                    # 2 mặt = 1 tờ giấy chạy CẢ 2 mặt trong 1 lượt → số tờ vật lý = nSheets,
                    # KHÔNG nhân đôi (khớp engine report sheet_count=n_sheets, không *2).
                    _sn_ct = max(1, int(_alloc_ct['nSheets']))
                    doc.close()
                    return {
                        "success": True,
                        "cells": _items_ct,
                        "overallWidth": _ow_ct,
                        "overallHeight": _oh_ct,
                        "totalItems": len(_items_ct),
                        "strategyUsed": 'cluster_type_duplex' if _dup_ct else 'cluster_type',
                        "isMixedPreview": True,
                        "absPlacement": True,
                        "sheetsNeeded": max(1, int(_sn_ct)),
                        "ratioUnplaced": _alloc_ct.get('unplaced', []),
                        "placedByPage": _pbp_ct,
                        "clusterTypeMode": True,
                    }

            # ── STEP_REPEAT (nhân bản) + CHIA CỌC "CHIA ĐỀU" PREVIEW ──
            # repeat: mọi cọc CÙNG 1 loại, cluster_count cọc CÙNG kích thước (KHÁC
            # cluster_type chia theo tỷ lệ SL). Output đi nup_engine→chunk: chia usable
            # theo cluster_count rồi nhân cọc + gutter (visual_cy). Preview trước đây bỏ
            # qua 'repeat' → rơi single-page → vẽ lưới đều 1 cọc KHÔNG khe → khác output.
            # Nay dựng đa cọc tuyệt đối KHỚP công thức output (mirror nup_process_chunk).
            _cmode_ce = (getattr(req, 'cluster_mode', None) or 'none')
            _ccount_ce = int(getattr(req, 'cluster_count', 2) or 2)
            if (not getattr(req, 'is_die_cut', False)
                    and _lt == 'repeat'
                    and _cmode_ce in ('row', 'column')
                    and _ccount_ce >= 2
                    and _tm in ('nup', 'step_repeat', 'booklet')):
                from app.workers.nup_layout_solver import (
                    solve_optimal_layout as _sol_ce, solve_manual as _sm_ce,
                )
                _bleed_ce = req.bleed or 0
                _trim_w_ce = max(req.item_w - 2 * _bleed_ce, 1.0)
                _trim_h_ce = max(req.item_h - 2 * _bleed_ce, 1.0)
                _cgap_ce = float(getattr(req, 'cluster_gap', 0) or 0)
                # Số cọc theo trục chia (mirror nup_engine 388-396 + chunk fix tràn mép).
                _cx_ce = _ccount_ce if _cmode_ce == 'column' else 1
                _cy_ce = _ccount_ce if _cmode_ce == 'row' else 1
                # CHIA usable theo số cọc TRƯỚC solve (mỗi cọc chỉ chiếm usable đã chia,
                # KHÔNG cả tờ) — nếu không super-grid vượt khổ → tràn (bug đã sửa ở chunk).
                _uw_ce = req.usable_w
                _uh_ce = req.usable_h
                if _cx_ce >= 2:
                    _uw_ce = (req.usable_w - _cgap_ce * (_cx_ce - 1)) / _cx_ce
                if _cy_ce >= 2:
                    _uh_ce = (req.usable_h - _cgap_ce * (_cy_ce - 1)) / _cy_ce
                _uw_ce = max(_trim_w_ce, _uw_ce)
                _uh_ce = max(_trim_h_ce, _uh_ce)
                if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                    if (_lay_ce.get('overallWidth', 0) > _uw_ce + 0.01
                            or _lay_ce.get('overallHeight', 0) > _uh_ce + 0.01):
                        doc.close()
                        raise HTTPException(
                            status_code=422,
                            detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng.",
                        )
                    _lay_ce = _sm_ce(_trim_w_ce, _trim_h_ce, req.gap_x, req.gap_y, req.cols, req.rows)
                else:
                    _lay_ce = _sol_ce(
                        usable_w=_uw_ce, usable_h=_uh_ce,
                        orig_w=_trim_w_ce, orig_h=_trim_h_ce,
                        gap_x=req.gap_x, gap_y=req.gap_y,
                        strategy=req.strategy, secondary_gap=getattr(req, 'split_gap', None),
                    )
                _cells_ce = _lay_ce.get('cells', [])
                if _cells_ce:
                    _agw_ce = _lay_ce.get('overallWidth', 0) or max((c['x'] + c['width'] for c in _cells_ce), default=0.0)
                    _agh_ce = _lay_ce.get('overallHeight', 0) or max((c['y'] + c['height'] for c in _cells_ce), default=0.0)
                    _supw_ce = _cx_ce * _agw_ce + max(0, _cx_ce - 1) * _cgap_ce
                    _suph_ce = _cy_ce * _agh_ce + max(0, _cy_ce - 1) * _cgap_ce
                    _al_ce = (getattr(req, 'align', None) or 'center')
                    if not isinstance(_al_ce, str):
                        _al_ce = 'center'
                    _ml_ce = getattr(req, 'margin_left', 0) or 0
                    _mb_ce = getattr(req, 'margin_bottom', 0) or 0
                    _mr_ce = getattr(req, 'margin_right', 0) or 0
                    _mt_ce = getattr(req, 'margin_top', 0) or 0
                    _shw_ce = getattr(req, 'sheet_w', 0) or 0
                    _shh_ce = getattr(req, 'sheet_h', 0) or 0
                    # Căn super-grid (mirror nup_engine super_base_x/y; usable = đầy đủ tờ).
                    if 'left' in _al_ce:
                        _sbx_ce = _ml_ce
                    elif 'right' in _al_ce and _shw_ce > 0:
                        _sbx_ce = _shw_ce - _mr_ce - _supw_ce
                    else:
                        _sbx_ce = _ml_ce + (req.usable_w - _supw_ce) / 2
                    if 'top' in _al_ce and _shh_ce > 0:
                        _sby_ce = _shh_ce - _mt_ce - _suph_ce
                    elif 'bottom' in _al_ce:
                        _sby_ce = _mb_ce
                    else:
                        _sby_ce = _mb_ce + (req.usable_h - _suph_ce) / 2
                    # Nhân cọc: cx theo X, cy theo Y (visual_cy — cọc hàng đầu ở ĐỈNH,
                    # khớp output). Mỗi cọc = 1 band (màu riêng để mắt thấy đường xén).
                    _items_ce = []
                    _ow_ce = _oh_ce = 0.0
                    for _cy in range(_cy_ce):
                        _visual_cy = _cy_ce - 1 - _cy
                        for _cx in range(_cx_ce):
                            _base_x = _sbx_ce + _cx * (_agw_ce + _cgap_ce)
                            _base_y = _sby_ce + _visual_cy * (_agh_ce + _cgap_ce)
                            _band = _cy * _cx_ce + _cx
                            for _c in _cells_ce:
                                _ax = _base_x + _c['x']
                                _ay = _base_y + (_agh_ce - _c['y'] - _c['height'])
                                _items_ce.append({
                                    'x': _c['x'], 'y': _c['y'],
                                    'absX': _ax, 'absY': _ay,
                                    'width': _c['width'], 'height': _c['height'],
                                    'isRotated': bool(_c.get('isRotated', False)),
                                    'isRotated180': False,
                                    'blockId': _band,
                                })
                                _ow_ce = max(_ow_ce, _ax + _c['width'])
                                _oh_ce = max(_oh_ce, _ay + _c['height'])
                    doc.close()
                    return {
                        "success": True,
                        "cells": _items_ce,
                        "overallWidth": _ow_ce,
                        "overallHeight": _oh_ce,
                        "totalItems": len(_items_ce),
                        "strategyUsed": 'cluster_even_repeat',
                        "absPlacement": True,
                    }

            # ── MULTI-PAGE N-Up guillotine PREVIEW: sequential | cut_stacks | ratio_stack ──
            # Trước đây chỉ ratio_stack có preview mixed → sequential/cut_stacks rơi single-page
            # (mọi ô cùng 1 trang) → user thấy "sai sai". Tờ 0 + pageIdx từng ô.
            # A straight guillotine grid cannot safely combine different trim
            # sizes. Export rejects this too; preview must not scale every page
            # to the first page's dimensions.
            if (not getattr(req, 'is_die_cut', False)
                    and _lt in ('sequential', 'cut_stacks', 'ratio_stack')):
                _page_trim_sizes = []
                for _dpi in range(doc.page_count):
                    _drect = doc[_dpi].rect
                    _page_trim_sizes.append((
                        max(0.0, float(_drect.width) - 2 * (req.bleed or 0)),
                        max(0.0, float(_drect.height) - 2 * (req.bleed or 0)),
                    ))
                if len(_page_trim_sizes) > 1:
                    _dw0, _dh0 = _page_trim_sizes[0]
                    if any(abs(_dw - _dw0) > 0.5 or abs(_dh - _dh0) > 0.5 for _dw, _dh in _page_trim_sizes[1:]):
                        doc.close()
                        raise HTTPException(
                            status_code=422,
                            detail="D\u00e0n nhi\u1ec1u m\u1eabu c\u1eaft x\u00e9n ch\u1ec9 h\u1ed7 tr\u1ee3 c\u00e1c trang c\u00f9ng k\u00edch th\u01b0\u1edbc.",
                        )
            if (not getattr(req, 'is_die_cut', False)
                    and _lt in ('sequential', 'cut_stacks', 'ratio_stack')
                    and _live_preview_page_count > 1
                    and _tm in ('nup', 'step_repeat', 'booklet')):
                from app.workers.nup_layout_solver import (
                    solve_optimal_layout, solve_manual, compute_ratio_stack_alloc,
                )
                import math as _math_mp
                _bleed_mp = req.bleed or 0
                _trim_w_mp = max(req.item_w - 2 * _bleed_mp, 1.0)
                _trim_h_mp = max(req.item_h - 2 * _bleed_mp, 1.0)
                if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                    _mp_layout = solve_manual(_trim_w_mp, _trim_h_mp, req.gap_x, req.gap_y, req.cols, req.rows)
                    if (_mp_layout.get('overallWidth', 0) > req.usable_w + 0.01
                            or _mp_layout.get('overallHeight', 0) > req.usable_h + 0.01):
                        doc.close()
                        raise HTTPException(
                            status_code=422,
                            detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng.",
                        )
                else:
                    _mp_layout = solve_optimal_layout(
                        usable_w=req.usable_w, usable_h=req.usable_h,
                        orig_w=_trim_w_mp, orig_h=_trim_h_mp,
                        gap_x=req.gap_x, gap_y=req.gap_y,
                        strategy=req.strategy, secondary_gap=getattr(req, 'split_gap', None),
                    )
                _mp_cells = _mp_layout.get('cells', [])
                _mp_cap = len(_mp_cells)
                _n_src = max(1, _live_preview_page_count)
                _tqbp_mp = getattr(req, 'target_quantities_by_page', None) or {}
                _gq_mp = getattr(req, 'target_quantity', 0) or 0

                def _qty_mp(_pi):
                    _q = _tqbp_mp.get(str(_pi), _tqbp_mp.get(_pi, _gq_mp))
                    try:
                        return max(0, int(_q))
                    except (TypeError, ValueError):
                        return 0

                _slot_page = []
                _sheets_needed = 1
                _strategy_label = _lt or 'sequential'

                if _lt == 'ratio_stack' and _mp_cap > 0:
                    # 2 mặt: đơn vị = cặp trang (2u trước | 2u+1 sau); chia tỷ lệ theo
                    # ĐƠN VỊ (SL trang chẵn). Preview tờ 0 = mặt TRƯỚC (trang chẵn 2u) —
                    # khớp nup_engine (xuất 2 tờ front/back, mặt sau lật gương). 1 mặt:
                    # đơn vị = trang, slot → trang trực tiếp.
                    _duplex_rs_mp = (
                        (getattr(req, 'duplex_flow', None) or 'normal') == 'double'
                        and _n_src >= 2
                        and _n_src % 2 == 0
                    )
                    _n_units_mp = (_n_src // 2) if _duplex_rs_mp else _n_src
                    _qtys_mp = [
                        _qty_mp((_u * 2) if _duplex_rs_mp else _u)
                        for _u in range(_n_units_mp)
                    ]
                    _alloc_mp = compute_ratio_stack_alloc(_mp_cap, _qtys_mp)
                    _cpp_mp = _alloc_mp['cellsPerPage']
                    for _ui, _cnt in enumerate(_cpp_mp):
                        _pg_mp = (_ui * 2) if _duplex_rs_mp else _ui
                        _slot_page.extend([_pg_mp] * int(_cnt))
                    # 2 mặt = 1 tờ giấy vật lý chạy duplex (mặt trước + sau cùng 1 tờ),
                    # KHÔNG nhân đôi số tờ. Khớp engine report (sheet_count=n_sheets) —
                    # total_sheets=2 bên engine chỉ là 2 TRANG PDF mẫu, không phải 2 tờ in.
                    _sheets_needed = max(1, int(_alloc_mp.get('nSheets') or 1))
                    _unplaced_mp = _alloc_mp.get('unplaced', [])
                    _strategy_label = 'ratio_stack_duplex' if _duplex_rs_mp else 'ratio_stack'
                elif _lt == 'cut_stacks' and _mp_cap > 0:
                    # Tờ 0: cell j → page j * n_sheets (cọc đầu mỗi stack)
                    _n_sheets_cs = max(1, _math_mp.ceil(_n_src / _mp_cap))
                    for _j in range(_mp_cap):
                        _src = _j * _n_sheets_cs  # sheet 0
                        if _src < _n_src:
                            _slot_page.append(_src)
                    _sheets_needed = _n_sheets_cs
                    _unplaced_mp = []
                    _strategy_label = 'cut_stacks'
                elif _mp_cap > 0:
                    # sequential lần lượt.
                    # 2 mặt: mỗi SP = cặp (2k|2k+1); preview tờ 0 = mặt TRƯỚC (trang chẵn).
                    # 1 mặt: trang0×q0…; trống = lấp 1 tờ wrap.
                    # 2 mặt chỉ khi số trang CHẴN (khớp engine — trang lẻ → 1 mặt).
                    _duplex_mp = (
                        (getattr(req, 'duplex_flow', None) or 'normal') == 'double'
                        and _n_src >= 2
                        and _n_src % 2 == 0
                    )
                    _n_prod_mp = (_n_src // 2) if _duplex_mp else _n_src
                    if _duplex_mp and _n_prod_mp < 1:
                        _duplex_mp = False
                        _n_prod_mp = _n_src

                    def _qty_prod(_pi):
                        if _duplex_mp:
                            return _qty_mp(_pi * 2)
                        return _qty_mp(_pi)

                    _seq_mp = []
                    _any_q = any(_qty_prod(i) > 0 for i in range(_n_prod_mp))
                    if _any_q:
                        for _i in range(_n_prod_mp):
                            _seq_mp.extend([_i] * _qty_prod(_i))
                    elif _gq_mp > 0:
                        for _i in range(_n_prod_mp):
                            _seq_mp.extend([_i] * int(_gq_mp))
                    else:
                        # Trống = lấp đầy 1 tờ, GOM THEO LOẠI (A-A-A B-B-B), KHÔNG xen
                        # kẽ A-B-C-A-B-C. Chia đều capacity thành khối liền (dư dồn loại
                        # đầu) → KHỚP output nup_engine sequential nhánh trống.
                        if _n_prod_mp > 0:
                            _base_mp = _mp_cap // _n_prod_mp
                            _rem_mp = _mp_cap % _n_prod_mp
                            _seq_mp = []
                            for _i in range(_n_prod_mp):
                                _seq_mp.extend([_i] * (_base_mp + (1 if _i < _rem_mp else 0)))
                        else:
                            _seq_mp = [0] * _mp_cap
                    if not _seq_mp:
                        _seq_mp = [0]
                    _n_front_mp = max(1, _math_mp.ceil(len(_seq_mp) / _mp_cap))
                    # Preview tờ 0 (mặt trước nếu duplex): map SP → page index
                    _chunk = _seq_mp[:_mp_cap]
                    if _duplex_mp:
                        _slot_page = [int(sp) * 2 for sp in _chunk]
                        # 2 mặt = 1 tờ giấy chạy CẢ 2 mặt → số tờ vật lý = _n_front_mp,
                        # KHÔNG nhân đôi (khớp ratio_stack). _n_front*2 bên engine chỉ là
                        # số TRANG PDF (mỗi mặt 1 trang), không phải số tờ giấy in.
                        _sheets_needed = _n_front_mp
                        _strategy_label = 'sequential_duplex'
                    else:
                        _slot_page = list(_chunk)
                        _sheets_needed = _n_front_mp
                        _strategy_label = 'sequential'
                    _unplaced_mp = []
                else:
                    _unplaced_mp = []

                if _mp_cap > 0 and _slot_page:
                    _n_used = min(len(_slot_page), _mp_cap)
                    _sc = _mp_cells[:_n_used]
                    _bw = max((c['x'] + c['width'] for c in _sc), default=0.0)
                    _bh = max((c['y'] + c['height'] for c in _sc), default=0.0)
                    _ml = getattr(req, 'margin_left', 0) or 0
                    _mb = getattr(req, 'margin_bottom', 0) or 0
                    _align_mp = (getattr(req, 'align', None) or 'center')
                    if not isinstance(_align_mp, str):
                        _align_mp = 'center'
                    _mr = getattr(req, 'margin_right', 0) or 0
                    _mt = getattr(req, 'margin_top', 0) or 0
                    _sheet_w = getattr(req, 'sheet_w', 0) or 0
                    _sheet_h = getattr(req, 'sheet_h', 0) or 0
                    if 'left' in _align_mp:
                        _bx = _ml
                    elif 'right' in _align_mp and _sheet_w > 0:
                        _bx = _sheet_w - _mr - _bw
                    else:
                        _bx = _ml + (req.usable_w - _bw) / 2
                    if 'top' in _align_mp and _sheet_h > 0:
                        _byb = _sheet_h - _mt - _bh
                    elif 'bottom' in _align_mp:
                        _byb = _mb
                    else:
                        _byb = _mb + (req.usable_h - _bh) / 2
                    _items = []
                    _ov_w = 0.0
                    _ov_h = 0.0
                    _placed_by_page = {}
                    for _j in range(_n_used):
                        _c = _sc[_j]
                        _ax = _bx + _c['x']
                        _ay = _byb + (_bh - _c['y'] - _c['height'])
                        _pi = _slot_page[_j]
                        _items.append({
                            'x': _c['x'], 'y': _c['y'],
                            'absX': _ax, 'absY': _ay,
                            'width': _c['width'], 'height': _c['height'],
                            'isRotated': bool(_c.get('isRotated', False)),
                            'isRotated180': False,
                            'pageIdx': _pi,
                        })
                        _placed_by_page[str(_pi)] = _placed_by_page.get(str(_pi), 0) + 1
                        _ov_w = max(_ov_w, _ax + _c['width'])
                        _ov_h = max(_ov_h, _ay + _c['height'])
                    doc.close()
                    return {
                        "success": True,
                        "cells": _items,
                        "overallWidth": _ov_w,
                        "overallHeight": _ov_h,
                        "totalItems": len(_items),
                        "strategyUsed": _strategy_label,
                        "isMixedPreview": True,
                        "absPlacement": True,
                        "sheetsNeeded": max(1, int(_sheets_needed)),
                        "ratioUnplaced": _unplaced_mp if _lt == 'ratio_stack' else [],
                        "placedByPage": _placed_by_page,
                    }

            # ── SINGLE-PAGE PREVIEW (S&R or single-page N-Up) ──
            # Determine shape override from frontend
            shape_override = req.shape_type if req.shape_type and req.shape_type != 'CUSTOM' else None
            if req.shape_type == 'CUSTOM':
                shape_override = 'CUSTOM'  # Explicit CUSTOM choice → lưới thẳng

            logger.debug("shape_override=%s (req.shape_type=%s)", shape_override, req.shape_type)
            logger.debug("CALLING compute_sticker_layout_for_page...")
            
            bleed_pt = req.bleed or 0

            # cluster_tile đã xử lý ở nhánh _is_cluster_req đầu hàm (SSOT chung export).
            compute_w = req.usable_w
            compute_h = req.usable_h

            if not getattr(req, 'is_die_cut', False) and _tm in ('nup', 'step_repeat', 'booklet'):
                from app.workers.nup_layout_solver import solve_optimal_layout, solve_manual
                trim_w = max(req.item_w - 2 * bleed_pt, 1.0)
                trim_h = max(req.item_h - 2 * bleed_pt, 1.0)
                _split_gap_val = getattr(req, 'split_gap', None)
                if req.strategy == 'manual' and getattr(req, 'cols', 0) > 0 and getattr(req, 'rows', 0) > 0:
                    result = solve_manual(trim_w, trim_h, req.gap_x, req.gap_y, req.cols, req.rows)
                    if (result.get('overallWidth', 0) > compute_w + 0.01
                            or result.get('overallHeight', 0) > compute_h + 0.01):
                        doc.close()
                        raise HTTPException(
                            status_code=422,
                            detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng.",
                        )
                else:
                    result = solve_optimal_layout(
                        usable_w=compute_w,
                        usable_h=compute_h,
                        orig_w=trim_w,
                        orig_h=trim_h,
                        gap_x=req.gap_x,
                        gap_y=req.gap_y,
                        strategy=req.strategy,
                        secondary_gap=_split_gap_val
                    )
                logger.info(f"[PREVIEW SOLVER RESULT] totalItems={result.get('totalItems')} strategy={result.get('strategyUsed')}")
                result['shapeType'] = 'CUSTOM'
                result['strategyUsed'] = req.strategy
                result['widthUsed'] = result.get('overallWidth', 0)
                result['heightUsed'] = result.get('overallHeight', 0)
                result['items'] = result.get('cells', [])
                _plog("branch B: before solve_optimal (nup grid)")
            else:
                from app.workers.nup_sticker import compute_sticker_layout_for_page
                _plog("branch B: before compute_sticker_layout (die-cut/sticker nest)")
                # ── CACHE nest single-page (branch A die-cut/sticker) ──
                # compute_sticker_layout_for_page (parse vector + NFP Shapely) ~280ms/
                # trang → đổi setting KHÔNG đụng layout (vd bật dim, lăn chuột) trước đây
                # nest lại từ đầu. Key = MỌI arg truyền vào hàm nest + (file, mtime,
                # page_idx) → cache CHỈ hit khi mọi tham số ảnh hưởng layout y hệt →
                # không thể lệch preview. deepcopy vào/ra để downstream mutate (finalize/
                # collision) không làm hỏng bản cache.
                _sg_a = _resolve_preview_secondary_gap(req)
                _ct_a = getattr(req, 'cut_type', 'default')
                _dsm_a = getattr(req, 'die_size_mode', 'die')
                _dom_a = getattr(req, 'die_offset_mm', 0)
                try:
                    _mtime_a = os.path.getmtime(file_path)
                except OSError:
                    _mtime_a = 0.0
                _ck_a = _sticker_nest_cache_key(
                    file_path=file_path,
                    mtime=_mtime_a,
                    page_idx=page_idx,
                    compute_w=compute_w,
                    compute_h=compute_h,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    strategy=req.strategy,
                    shape_override=shape_override,
                    shape_props=req.shape_props or {},
                    bleed_pt=bleed_pt,
                    secondary_gap=_sg_a,
                    cut_type=_ct_a,
                    die_size_mode=_dsm_a,
                    die_offset_mm=_dom_a,
                )
                with _NEST_CACHE_LOCK:
                    _hit_a = _NEST_A_CACHE.get(_ck_a)
                    if _hit_a is not None:
                        _NEST_A_CACHE.move_to_end(_ck_a)
                if _hit_a is not None:
                    result = _copy_mod.deepcopy(_hit_a)
                    _plog("compute layout done (nest CACHE HIT)")
                else:
                    result = compute_sticker_layout_for_page(
                        page=page,
                        sheet_usable_w=compute_w,
                        sheet_usable_h=compute_h,
                        gap_x=req.gap_x,
                        gap_y=req.gap_y,
                        strategy=req.strategy,
                        shape_type_override=shape_override,
                        # PARITY (audit shape-detection): truyền props từ Detection (SSOT)
                        # GIỐNG output (nup_process_chunk). Trước đây preview KHÔNG truyền
                        # props → solver tự classify lại → props (vd hướng búa/tạ) lệch
                        # output → preview ≠ output với hình bất đối xứng.
                        shape_props_override=(req.shape_props or None),
                        bleed_pt=bleed_pt,
                        # PARITY (audit): output (nup_process_chunk) truyền secondary_gap
                        # (khe block phụ / split-gap); preview trước đây BỎ → block phụ xếp
                        # khít hơn output. Truyền split_gap (points) frontend đã gửi cho khớp.
                        secondary_gap=_sg_a,
                        # 1 Dao + "theo kích thước trang": trim = mediabox ± offset (chung export).
                        cut_type=_ct_a,
                        die_size_mode=_dsm_a,
                        die_offset_mm=_dom_a,
                    )
                    _plog("compute layout done (nest)")
                    with _NEST_CACHE_LOCK:
                        _NEST_A_CACHE[_ck_a] = _copy_mod.deepcopy(result)
                        if len(_NEST_A_CACHE) > _NEST_A_CACHE_MAX:
                            _NEST_A_CACHE.popitem(last=False)

            base_poly = _build_pont_base_poly_for_preview(page, result, req, shape_override)

            # ── Đường bế THẬT cho preview (vẽ đúng outline, không phụ thuộc hình tổng hợp).
            # Trích cho HAMMER/DUMBBELL (bất đối xứng dễ vẽ sai) VÀ CUSTOM (khuôn tự do /
            # đường cắt 'bù xén' trace từ raster — không khớp hình mẫu nào → trước đây
            # preview vẽ bounding box; nay vẽ contour THẬT). Hình mẫu sạch (tròn/chữ
            # nhật/đa giác…) giữ vẽ schematic (khớp + không tốn thêm).
            die_polygon_norm = None
            _shape_final = (result.get('shapeType') or '').upper()
            # 1 Dao: preview vẽ CHỮ NHẬT ô tem — không extract contour bế cong (lệch layout).
            _ct_preview = (getattr(req, 'cut_type', None) or 'default')
            if _ct_preview != 'one_dao' and _shape_final in ('HAMMER', 'DUMBBELL', 'CUSTOM', 'ARROW'):
                try:
                    _outline = base_poly
                    if _outline is None:
                        from app.workers.pont_collision import build_shapely_polygon_from_paths
                        _paths = page.extract_vector_paths()
                        if _paths:
                            _outline = build_shapely_polygon_from_paths(_paths, page.rect)
                    die_polygon_norm = _normalize_polygon_to_unit(_outline)
                except Exception as _e:
                    logger.debug("die polygon extract failed: %s", _e)
                    die_polygon_norm = None

            # Hình học khuôn THẬT để preview vẽ đường bế bằng CHÍNH transform của file xuất
            # (transform_die_point). Dùng chung → preview không thể lệch output.
            _die_items = None
            _die_rect = None
            if getattr(req, 'is_die_cut', False):
                try:
                    from app.workers.nup_diecut import _find_largest_die_path
                    _lp = _find_largest_die_path(page)
                    if _lp and _lp.get('items'):
                        _die_items = _lp['items']
                        _die_rect = _lp['rect']
                except Exception as _e:
                    logger.debug("die polylines extract failed: %s", _e)

            doc.close()

            items = result.get("items", [])
            logger.debug("PREVIEW result: items_before_collision=%d", len(items))

            try:
                from app.workers.rot_audit_log import get_logger as _rot_get_logger
                _rot_get_logger().warning(
                    "[ROT-AUDIT][solver][PREVIEW] strategy=%s shapeType=%s shapeProps=%s "
                    "secondary_gap=%s n=%d rot180_per_cell=%s",
                    result.get('strategyUsed'), result.get('shapeType'), result.get('shapeProps'),
                    _resolve_preview_secondary_gap(req), len(items),
                    [int(it.get('isRotated180', False)) for it in items],
                )
            except Exception:
                pass

            _is_relative_grid = (not getattr(req, 'is_die_cut', False)) and _tm in ('nup', 'step_repeat', 'booklet')

            if _is_relative_grid:
                # ── Branch E: N-Up lưới thường (KHÔNG die-cut) — giữ toạ độ TƯƠNG ĐỐI,
                # frontend tự canh lưới (export grid honor align). KHÔNG dùng abs.
                items = apply_preview_collisions(items, req.item_w, req.item_h, req, result.get("widthUsed", 0), result.get("heightUsed", 0), base_poly)
                _capacity = len(items)
                if _tm == 'nup':
                    _tqbp = getattr(req, 'target_quantities_by_page', None) or {}
                    _gq = getattr(req, 'target_quantity', 0) or 0
                    _auto_fill = (_gq == 0) and not any(int(v or 0) > 0 for v in _tqbp.values())
                    if not _auto_fill:
                        items = items[:min(src_page_count, _capacity)]
                elif _tm == 'step_repeat':
                    # Bình trang cắt xén: mọi ô là loại thumbnail đang chọn.
                    # Không có pageIdx, frontend mặc định 0 nên luôn hiện loại 1.
                    items = [{**item, 'pageIdx': _viewer_page_idx} for item in items]
                _plog(f"RETURN branch E (relative grid, {_capacity} items)")
                return {
                    "success": True,
                    "cells": items,
                    "overallWidth": result.get("widthUsed", 0),
                    "overallHeight": result.get("heightUsed", 0),
                    "totalItems": _capacity,
                    "strategyUsed": result.get("strategyUsed", ""),
                    "absPlacement": False,
                }

            # ── Branch A: die-cut / sticker S&R → toạ độ TUYỆT ĐỐI (SSOT, khớp export).
            # finalize_placements (căn giữa) + resolve_pont_collisions_on_placements
            # (giữ abs_x/abs_y đã dời/xoay/căn giữa) → preview == output.
            _ml = getattr(req, 'margin_left', 0) or 0
            _mb = getattr(req, 'margin_bottom', 0) or 0
            _mt = getattr(req, 'margin_top', 0) or 0
            placements = finalize_placements(items, req.usable_w, req.usable_h, _ml, _mb, _mt, page_idx)
            _n_before = len(placements)
            _ays_before = sorted(round(p['abs_y'], 1) for p in placements)
            placements = resolve_pont_collisions_on_placements(placements, req, base_poly)
            logger.warning(
                "[PARITY-DBG PREVIEW] file=%s shape=%s strategy=%s base_poly=%s "
                "items_in=%d items_out=%d usable=%.1fx%.1f sheet=%.1fx%.1f "
                "margins(l/b/t)=%.1f/%.1f/%.1f abs_y_before=%s",
                (req.path or req.file_id), result.get('shapeType'), result.get('strategyUsed'),
                'YES' if base_poly is not None else 'NONE',
                _n_before, len(placements), req.usable_w, req.usable_h,
                getattr(req, 'sheet_w', 0), getattr(req, 'sheet_h', 0),
                _ml, _mb, _mt, _ays_before,
            )

            abs_cells = []
            max_w = 0.0
            max_h = 0.0
            from app.workers.nup_artwork import die_polylines_for_placement as _die_polylines
            for p in placements:
                c = p['cell']
                w = p['width']
                h = p['height']
                _cell = {
                    'x': c.get('x', 0), 'y': c.get('y', 0),
                    'absX': p['abs_x'], 'absY': p['abs_y'],
                    'width': w, 'height': h,
                    'isRotated': c.get('isRotated', False),
                    'isRotated180': c.get('isRotated180', False),
                }
                # Đường bế THẬT của ô (toạ độ TOP-DOWN trang đích, pt) — CÙNG transform
                # với file xuất. Frontend chỉ vẽ y nguyên, không tự xoay/lật.
                if _die_items is not None:
                    _ay_td = p.get('original_cell_y')
                    if _ay_td is None:
                        _ay_td = (req.usable_h + _mb + _mt) - p['abs_y'] - h
                    try:
                        _cell['diePolylines'] = _die_polylines(
                            _die_items, _die_rect, p['abs_x'], _ay_td,
                            is_rotated=c.get('isRotated', False),
                            is_rotated_180=c.get('isRotated180', False),
                        )
                    except Exception as _e:
                        logger.debug("die polylines build failed: %s", _e)
                abs_cells.append(_cell)
                max_w = max(max_w, p['abs_x'] + w)
                max_h = max(max_h, p['abs_y'] + h)

            logger.info(f"[PREVIEW] abs S&R: shape={result.get('shapeType')} items={len(abs_cells)} (strategy={result.get('strategyUsed')})")

            _plog(f"RETURN branch A die/S&R ({len(abs_cells)} cells)")
            return {
                "success": True,
                "cells": abs_cells,
                "overallWidth": max_w,
                "overallHeight": max_h,
                "totalItems": len(abs_cells),
                "strategyUsed": result.get("strategyUsed", ""),
                "absPlacement": True,
                "diePolygon": die_polygon_norm,
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
                if (result.get('overallWidth', 0) > req.usable_w + 0.01
                        or result.get('overallHeight', 0) > req.usable_h + 0.01):
                    raise HTTPException(
                        status_code=422,
                        detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng v\u01b0\u1ee3t v\u00f9ng gi\u1ea5y s\u1eed d\u1ee5ng.",
                    )
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
    
        return ret_data
    
    # If we reached here, something went wrong with the primary flow and we didn't return
    # This shouldn't happen unless an exception was thrown, but we don't catch all exceptions anymore.
    raise HTTPException(status_code=500, detail="Unexpected error during preview layout")


from typing import List
import json as _json_batch
from collections import OrderedDict as _OrderedDict_batch

# Cache capacity per-type cho batch endpoint — nesting shape-aware (parse vector +
# NFP Shapely) ĐẮT. LRU cap để không phình RAM. Key gồm file+mtime+page+params.
json = _json_batch
_BATCH_CAP_CACHE: "_OrderedDict_batch[tuple, int]" = _OrderedDict_batch()
_BATCH_CAP_CACHE_MAX = 512

# Cache nest 1 loại (kết quả layout của compute_sticker_layout_for_page) SỐNG QUA
# NHIỀU REQUEST — nest NFP shape-aware ~270ms/loại, chia cụm 17 loại ≈ 4.7s/lần.
# Không cache cross-request → mỗi preview (lăn chuột / đổi setting không đụng layout)
# nest lại từ đầu. Key gồm file+mtime + zone dims + params ảnh hưởng layout.
_ZONE_NEST_CACHE: "_OrderedDict_batch[tuple, dict]" = _OrderedDict_batch()
_ZONE_NEST_CACHE_MAX = 2048

# Cache nest single-page branch A (die-cut/sticker preview 1 trang) — cùng lý do
# _ZONE_NEST_CACHE nhưng cho luồng preview 1 trang. Key = mọi arg của
# compute_sticker_layout_for_page + (file, mtime, page_idx). deepcopy vào/ra.
import copy as _copy_mod
import threading as _threading_batch
_NEST_A_CACHE: "_OrderedDict_batch[tuple, dict]" = _OrderedDict_batch()
_NEST_A_CACHE_MAX = 1024
_NEST_CACHE_LOCK = _threading_batch.RLock()


def _sticker_nest_cache_key(
    *, file_path, mtime, page_idx, compute_w, compute_h, gap_x, gap_y,
    strategy, shape_override, shape_props, bleed_pt, secondary_gap,
    cut_type, die_size_mode, die_offset_mm,
):
    """Một cache key dùng chung cho batch capacity và preview từng trang."""
    return (
        file_path, mtime, int(page_idx),
        round(float(compute_w), 3), round(float(compute_h), 3),
        round(float(gap_x), 3), round(float(gap_y), 3),
        strategy, shape_override,
        _json_batch.dumps(shape_props or {}, sort_keys=True),
        round(float(bleed_pt), 3),
        round(float(secondary_gap), 3) if secondary_gap is not None else None,
        cut_type, die_size_mode, round(float(die_offset_mm or 0), 3),
    )


def _batch_geometry_fingerprint(
    page: dict,
    cut_type: str = 'default',
    die_size_mode: str = 'die',
):
    """Fingerprint bảo thủ để chỉ tái dùng CAPACITY giữa khuôn thật sự tương đương.

    CUSTOM và one-dao/page luôn theo page vì layout còn phụ thuộc contour/MediaBox.
    Với primitive, shape + trim + props nhận dạng quyết định layout; màu/spot/path
    của từng khuôn vẫn được giữ riêng lúc render và preview chi tiết.
    """
    try:
        page_idx = int(page.get('page_idx'))
    except (TypeError, ValueError):
        page_idx = -1
    shape = str(page.get('shape_type') or '').strip().upper()
    if not shape or shape == 'CUSTOM':
        return ('page', page_idx)
    if cut_type == 'one_dao' and die_size_mode == 'page':
        return ('page', page_idx)
    try:
        item_w = round(float(page.get('item_w') or 0), 3)
        item_h = round(float(page.get('item_h') or 0), 3)
    except (TypeError, ValueError):
        return ('page', page_idx)
    if item_w <= 0 or item_h <= 0:
        return ('page', page_idx)
    props = dict(page.get('shape_props') or {})
    props.pop('inheritedFromPage', None)
    return (
        'geometry', shape, item_w, item_h,
        _json_batch.dumps(props, sort_keys=True),
    )


def _group_batch_pages(
    pages: list,
    cut_type: str = 'default',
    die_size_mode: str = 'die',
) -> list[list[dict]]:
    """Giữ thứ tự nguồn, gom các primitive có fingerprint bố cục giống hệt."""
    groups: "_OrderedDict_batch[tuple, list[dict]]" = _OrderedDict_batch()
    for page in pages:
        key = _batch_geometry_fingerprint(page, cut_type, die_size_mode)
        groups.setdefault(key, []).append(page)
    return list(groups.values())

# Cache nest branch A (preview 1 loại die-cut/sticker, /preview-layout) — CÙNG bản chất
# _ZONE_NEST_CACHE nhưng cho preview đơn (không chia cụm). compute_sticker_layout_for_page
# ~280ms/lần → đổi setting KHÔNG đụng layout (vd bật/tắt dim, lăn chuột) nest lại từ đầu.
# Key = MỌI arg thực sự truyền vào hàm nest + (file, mtime, page_idx) → không thể lệch:
# thiếu 1 arg mới sai, mà mọi arg đều có mặt. Chỉ cache RESULT của nest (không cache
# finalize/collision/polylines downstream — chúng rẻ và phụ thuộc thêm state khác).
_SINGLE_NEST_CACHE: "_OrderedDict_batch[tuple, dict]" = _OrderedDict_batch()
_SINGLE_NEST_CACHE_MAX = 1024

class PreviewLayoutBatchRequest(BaseModel):
    """Tính SỐ TEM/TỜ cho MỌI trang trong 1 lần — cột "Tem/tờ" bảng nhập SL.

    Mỗi loại tem tính RIÊNG (đầy 1 tờ của loại đó), độc lập số lượng → dùng CHÍNH
    hàm export (compute_sticker_layout_for_page) để con số KHỚP output. Live preview
    chỉ chạy 1 trang đang xem; endpoint này lấp phần còn lại.
    """
    model_config = ConfigDict(extra='forbid')

    usable_w: float
    usable_h: float
    gap_x: float
    gap_y: float
    strategy: str = "optimal_auto"
    cols: int = 0
    rows: int = 0
    # Mỗi phần tử: {page_idx:int, shape_type?:str, shape_props?:dict, item_w?:float, item_h?:float}
    pages: List[Dict[str, Any]]
    file_id: Optional[str] = None
    path: Optional[str] = None
    bleed: float = 0.0
    task_mode: Optional[str] = "sticker_imposer"
    is_die_cut: Optional[bool] = False
    page_sheet_mode: StrictBool = False
    pont_config: Optional[Dict[str, Any]] = None
    sheet_w: float = 0.0
    sheet_h: float = 0.0
    margin_left: float = 0.0
    margin_right: float = 0.0
    margin_top: float = 0.0
    margin_bottom: float = 0.0
    imposer_mode: Optional[str] = None
    # secondary_gap — PHẢI khớp _resolve_preview_secondary_gap (single preview + export).
    cut_type: Optional[str] = "default"
    fill_block_gap: Optional[float] = 0
    split_gap: Optional[float] = 0
    # 1 Dao: khuôn theo trang + offset co/mở (khớp resolve_one_dao_trim export).
    die_size_mode: Optional[str] = "die"
    die_offset_mm: Optional[float] = 0
    # cluster_tile: kích thước ô cụm (compute_w/h) — mirror single preview.
    grouping_strategy: str = "none"
    cluster_sizing_mode: str = "dims"
    cluster_combine_mode: str = "replicate_mixed"
    cluster_cols: int = 2
    cluster_rows: int = 2
    cluster_w: float = 0
    cluster_h: float = 0
    tile_gap_x: float = 0
    tile_gap_y: float = 0

def _batch_single_mold_master(pages: list) -> Optional[dict]:
    """Chỉ bật fast path khi metadata detect chỉ rõ đúng một master inheritance.

    Không suy single-mold từ ``shape_type``: nhiều genuine CIRCLE khác kích thước
    vẫn là multi-mold. Content pages do detect inherit mang ``inheritedFromPage``.
    """
    if not pages or len(pages) < 2:
        return None

    by_idx: dict[int, dict] = {}
    inherited_sources: set[int] = set()
    for p in pages:
        if not isinstance(p, dict):
            continue
        try:
            page_idx = int(p.get("page_idx"))
        except (TypeError, ValueError):
            continue
        by_idx[page_idx] = p
        raw_source = (p.get("shape_props") or {}).get("inheritedFromPage")
        if isinstance(raw_source, int) and not isinstance(raw_source, bool):
            inherited_sources.add(raw_source)

    if len(inherited_sources) != 1:
        return None
    master_idx = next(iter(inherited_sources))
    master = by_idx.get(master_idx)
    if master is None:
        return None
    master_type = str(master.get("shape_type") or "").strip().upper()
    if not master_type or master_type == "CUSTOM":
        return None

    # Mọi page trừ master phải khai cùng inheritance source; thiếu/mâu thuẫn →
    # fallback full nest an toàn.
    for page_idx, p in by_idx.items():
        if page_idx == master_idx:
            continue
        raw_source = (p.get("shape_props") or {}).get("inheritedFromPage")
        if raw_source != master_idx:
            return None

    try:
        mw = float(master.get("item_w") or 0)
        mh = float(master.get("item_h") or 0)
    except (TypeError, ValueError):
        mw, mh = 0.0, 0.0
    for p in by_idx.values():
        try:
            w = float(p.get("item_w") or 0)
            h = float(p.get("item_h") or 0)
        except (TypeError, ValueError):
            continue
        if mw > 0 and w > 0 and abs(w - mw) > 2.0:
            return None
        if mh > 0 and h > 0 and abs(h - mh) > 2.0:
            return None
    return master


@router.post("/preview-layouts-batch")
def preview_layouts_batch(req: PreviewLayoutBatchRequest, license_info: dict = Depends(require_license)):
    if req.page_sheet_mode:
        _batch_imposer_mode = str(req.imposer_mode or "").strip().lower()
        _batch_task_mode = str(req.task_mode or "").strip().lower()
        if (
            _batch_imposer_mode == "cnc"
            or _batch_task_mode in ("cnc", "cnc_imposer")
        ):
            raise HTTPException(status_code=422, detail="Bình nguyên tấm decal không áp dụng cho CNC.")
        req.is_die_cut = False
        req.task_mode = "step_repeat" if req.task_mode == "step_repeat" else "nup"
        req.cut_type = "default"
    enforce_feature(_imposition_feature(req), license_info)
    if req.strategy == 'manual' and (req.cols <= 0 or req.rows <= 0):
        raise HTTPException(
            status_code=422,
            detail="L\u01b0\u1edbi th\u1ee7 c\u00f4ng c\u1ea7n s\u1ed1 c\u1ed9t v\u00e0 s\u1ed1 d\u00f2ng l\u1edbn h\u01a1n 0.",
        )

    import time as _t_mod
    from app.workers import pdf_wrapper as pdf_lib
    from app.database import SessionLocal
    from app.models.job import UploadedFile as UploadedFileModel
    from app.utils.preview_perf_log import log as _perf, mark as _pmark

    _t0 = _t_mod.perf_counter()
    _n_pages_req = len(getattr(req, "pages", None) or [])
    _perf(
        "BATCH", "api_start",
        path=os.path.basename(str(req.path or req.file_id or "")),
        pages_req=_n_pages_req,
        is_die_cut=getattr(req, "is_die_cut", None),
        task_mode=getattr(req, "task_mode", None),
        grouping=getattr(req, "grouping_strategy", None),
    )

    # ── Resolve file (desktop: path trực tiếp; web: file_id → DB) ──
    if req.path:
        file_path = _validate_file_path(req.path)
    elif req.file_id:
        db = SessionLocal()
        try:
            db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == req.file_id).first()
            file_path = db_file.file_path if db_file else None
        finally:
            db.close()
    else:
        file_path = None

    if not file_path or not os.path.exists(file_path):
        _perf("BATCH", "file_not_found")
        raise HTTPException(status_code=404, detail=f"File not found: {req.file_id or req.path}")

    bleed_pt = req.bleed or 0

    # ── cluster_tile: kích thước ô cụm dùng để nesting (mirror single preview 1922-1947) ──
    is_cluster = (
        req.grouping_strategy == 'cluster_tile'
        and bool(req.is_die_cut)
        and req.task_mode != 'step_repeat'
    )
    compute_w = req.usable_w
    compute_h = req.usable_h
    if is_cluster:
        if req.cluster_sizing_mode in ('grid', 'split_cols', 'split_rows'):
            if req.cluster_sizing_mode == 'split_cols':
                c_cols, c_rows = max(1, req.cluster_cols or 2), 1
            elif req.cluster_sizing_mode == 'split_rows':
                c_cols, c_rows = 1, max(1, req.cluster_rows or 2)
            else:
                c_cols, c_rows = max(1, req.cluster_cols or 2), max(1, req.cluster_rows or 2)
            cw = (req.usable_w - (c_cols - 1) * (req.tile_gap_x or 0)) / c_cols
            ch = (req.usable_h - (c_rows - 1) * (req.tile_gap_y or 0)) / c_rows
        else:
            cw = req.cluster_w
            ch = req.cluster_h
        if not cw or not ch:
            cw, ch = 148.0 * 2.83465, 210.0 * 2.83465
        compute_w, compute_h = cw, ch

    _secondary_gap = _resolve_preview_secondary_gap(req)
    _use_sticker = False if req.page_sheet_mode else (
        bool(req.is_die_cut) or req.task_mode not in ('nup', 'step_repeat', 'booklet')
    )

    # ── Cache: nesting shape-aware (parse vector + NFP Shapely) ĐẮT → cache theo
    # (file+mtime, page_idx, params layout). Đổi trang xem / nhập SL (không đổi params)
    # → hit ngay, không re-parse 17 trang die-cut mỗi debounce. Key gồm MỌI tham số
    # ảnh hưởng số ô/tờ để không trả cache cũ khi user đổi lề/gap/bleed/khổ.
    try:
        _mtime = os.path.getmtime(file_path)
    except OSError:
        _mtime = 0.0

    results: dict = {}
    pages_in = [p for p in (req.pages or []) if isinstance(p, dict)]
    # 1 khuôn (die-cut): nest 1 trang master, copy capacity — nhiều khuôn: full loop.
    if not _use_sticker:
        invalid_pages = []
        page_sheet_trim_dims = []
        from app.workers.page_sheet_geometry import resolve_page_sheet_geometry
        for p in pages_in:
            try:
                _iw = float(p.get("item_w") or 0)
                _ih = float(p.get("item_h") or 0)
                if req.page_sheet_mode:
                    _page_sheet_geo = resolve_page_sheet_geometry(_iw, _ih, bleed_pt)
                    page_sheet_trim_dims.append((
                        _page_sheet_geo.trim_width,
                        _page_sheet_geo.trim_height,
                    ))
                elif _iw <= 2 * bleed_pt or _ih <= 2 * bleed_pt:
                    raise ValueError
            except (TypeError, ValueError):
                invalid_pages.append(p.get("page_idx"))
        if invalid_pages:
            raise HTTPException(status_code=422, detail="K\u00edch th\u01b0\u1edbc trang ch\u01b0a s\u1eb5n s\u00e0ng; ch\u01b0a th\u1ec3 t\u00ednh b\u1ed1 c\u1ee5c.")
        if (
            req.page_sheet_mode
            and req.task_mode != "step_repeat"
            and len(page_sheet_trim_dims) > 1
        ):
            _first_w, _first_h = page_sheet_trim_dims[0]
            if any(
                abs(_w - _first_w) > 0.5 or abs(_h - _first_h) > 0.5
                for _w, _h in page_sheet_trim_dims[1:]
            ):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "D\u00e0n nhi\u1ec1u m\u1eabu B\u00ecnh nguy\u00ean t\u1ea5m decal ch\u1ec9 h\u1ed7 tr\u1ee3 c\u00e1c trang "
                        "c\u00f9ng k\u00edch th\u01b0\u1edbc th\u00e0nh ph\u1ea9m sau khi tr\u1eeb bleed."
                    ),
                )

    _mold_master = _batch_single_mold_master(pages_in) if _use_sticker else None
    if _mold_master is not None:
        _perf(
            "BATCH", "single_mold_fast_path",
            master_page=_mold_master.get("page_idx"),
            shape=_mold_master.get("shape_type"),
            pages_total=len(pages_in),
        )

    def _nest_one_page(p: dict, page_idx: int, doc) -> int:
        _shape = p.get("shape_type")
        shape_override = _shape if (_shape and _shape != 'CUSTOM') else ('CUSTOM' if _shape == 'CUSTOM' else None)
        _layout_ck = None
        _batch_ck = None
        if _use_sticker:
            _layout_ck = _sticker_nest_cache_key(
                file_path=file_path,
                mtime=_mtime,
                page_idx=page_idx,
                compute_w=compute_w,
                compute_h=compute_h,
                gap_x=req.gap_x,
                gap_y=req.gap_y,
                strategy=req.strategy,
                shape_override=shape_override,
                shape_props=p.get("shape_props") or {},
                bleed_pt=bleed_pt,
                secondary_gap=_secondary_gap,
                cut_type=req.cut_type,
                die_size_mode=req.die_size_mode,
                die_offset_mm=req.die_offset_mm,
            )
            with _NEST_CACHE_LOCK:
                _cached_layout = _NEST_A_CACHE.get(_layout_ck)
                if _cached_layout is not None:
                    _NEST_A_CACHE.move_to_end(_layout_ck)
            if _cached_layout is not None:
                return len(_cached_layout.get("items", []))
        else:
            _batch_ck = (
                file_path, _mtime, page_idx, _use_sticker,
                round(compute_w, 3), round(compute_h, 3),
                round(req.gap_x, 3), round(req.gap_y, 3),
                req.strategy, shape_override,
                json.dumps(p.get("shape_props") or {}, sort_keys=True),
                round(bleed_pt, 3),
                round(_secondary_gap, 3) if _secondary_gap is not None else None,
                req.cut_type, req.die_size_mode, round(float(req.die_offset_mm or 0), 3),
                round(p.get("item_w", 0) or 0, 3), round(p.get("item_h", 0) or 0, 3),
                int(req.cols or 0), int(req.rows or 0),
                bool(req.page_sheet_mode),
                round(float(req.sheet_w or 0), 3),
                round(float(req.sheet_h or 0), 3),
                round(float(req.margin_left or 0), 3),
                round(float(req.margin_right or 0), 3),
                round(float(req.margin_top or 0), 3),
                round(float(req.margin_bottom or 0), 3),
                json.dumps(req.pont_config or {}, sort_keys=True),
            )
            with _NEST_CACHE_LOCK:
                _cached = _BATCH_CAP_CACHE.get(_batch_ck)
                if _cached is not None:
                    _BATCH_CAP_CACHE.move_to_end(_batch_ck)
            if _cached is not None:
                return int(_cached)
        try:
            if _use_sticker:
                from app.workers.nup_sticker import compute_sticker_layout_for_page
                result = compute_sticker_layout_for_page(
                    page=doc[page_idx],
                    sheet_usable_w=compute_w,
                    sheet_usable_h=compute_h,
                    gap_x=req.gap_x,
                    gap_y=req.gap_y,
                    strategy=req.strategy,
                    shape_type_override=shape_override,
                    shape_props_override=(p.get("shape_props") or None),
                    bleed_pt=bleed_pt,
                    secondary_gap=_secondary_gap,
                    cut_type=getattr(req, 'cut_type', 'default'),
                    die_size_mode=getattr(req, 'die_size_mode', 'die'),
                    die_offset_mm=getattr(req, 'die_offset_mm', 0),
                )
                _cap = len(result.get("items", []))
                with _NEST_CACHE_LOCK:
                    _NEST_A_CACHE[_layout_ck] = _copy_mod.deepcopy(result)
                    _NEST_A_CACHE.move_to_end(_layout_ck)
                    if len(_NEST_A_CACHE) > _NEST_A_CACHE_MAX:
                        _NEST_A_CACHE.popitem(last=False)
            else:
                from app.workers.nup_layout_solver import solve_manual, solve_optimal_layout
                trim_w = float(p.get("item_w") or 0) - 2 * bleed_pt
                trim_h = float(p.get("item_h") or 0) - 2 * bleed_pt
                if req.strategy == 'manual':
                    if req.cols <= 0 or req.rows <= 0:
                        raise ValueError("Manual grid requires positive columns and rows")
                    res = solve_manual(
                        trim_w, trim_h, req.gap_x, req.gap_y,
                        req.cols, req.rows,
                    )
                    if (res.get('overallWidth', 0) > compute_w + 0.01
                            or res.get('overallHeight', 0) > compute_h + 0.01):
                        raise ValueError("Manual grid exceeds usable sheet area")
                else:
                    res = solve_optimal_layout(
                        usable_w=compute_w,
                        usable_h=compute_h,
                        orig_w=trim_w,
                        orig_h=trim_h,
                        gap_x=req.gap_x,
                        gap_y=req.gap_y,
                        strategy=req.strategy,
                        secondary_gap=_secondary_gap,
                    )
                _cells = list(res.get('cells', []))
                if (
                    req.page_sheet_mode
                    and req.pont_config
                    and not req.pont_config.get('disableCollision', False)
                ):
                    try:
                        from shapely.geometry import box as _box
                        _cells = apply_preview_collisions(
                            _cells,
                            trim_w,
                            trim_h,
                            req,
                            res.get('overallWidth', 0),
                            res.get('overallHeight', 0),
                            _box(0.0, 0.0, trim_w, trim_h),
                        )
                    except Exception as exc:
                        logger.warning(
                            "[BATCH CAPACITY] page-sheet pont collision failed: %s",
                            exc,
                        )
                _cap = len(_cells)
            if not _use_sticker and _batch_ck is not None:
                with _NEST_CACHE_LOCK:
                    _BATCH_CAP_CACHE[_batch_ck] = _cap
                    _BATCH_CAP_CACHE.move_to_end(_batch_ck)
                    if len(_BATCH_CAP_CACHE) > _BATCH_CAP_CACHE_MAX:
                        _BATCH_CAP_CACHE.popitem(last=False)
            return int(_cap)
        except Exception as e:
            logger.warning("[BATCH CAPACITY] page %s failed: %s", page_idx, e)
            return 0

    doc = pdf_lib.open(file_path)
    try:
        if _mold_master is not None:
            # ── FAST PATH: 1 khuôn → nest master, broadcast ──
            try:
                m_idx = int(_mold_master.get("page_idx"))
            except (TypeError, ValueError):
                m_idx = -1
            if m_idx < 0 or m_idx >= doc.page_count:
                m_idx = 0
                _mold_master = {**_mold_master, "page_idx": m_idx}
            _cap = _nest_one_page(_mold_master, m_idx, doc)
            for p in pages_in:
                try:
                    pi = int(p.get("page_idx"))
                except (TypeError, ValueError):
                    continue
                if 0 <= pi < doc.page_count:
                    results[pi] = _cap
            _perf(
                "BATCH", "single_mold_done",
                master_page=m_idx, cap=_cap, pages_out=len(results),
            )
        elif _use_sticker:
            # ── FULL PATH: nhiều khuôn / N-Up xén → nest từng trang ──
            groups = _group_batch_pages(pages_in, req.cut_type, req.die_size_mode)
            valid_groups = []
            for group in groups:
                valid_group = []
                for p in group:
                    try:
                        page_idx = int(p.get("page_idx"))
                    except (TypeError, ValueError):
                        continue
                    if 0 <= page_idx < doc.page_count:
                        valid_group.append((p, page_idx))
                if valid_group:
                    valid_groups.append(valid_group)

            workers = min(4, len(valid_groups))
            _perf(
                "BATCH", "geometry_groups",
                pages=sum(len(group) for group in valid_groups),
                groups=len(valid_groups),
                reused=sum(max(0, len(group) - 1) for group in valid_groups),
                workers=workers,
            )

            def _nest_group(valid_group):
                p, page_idx = valid_group[0]
                local_doc = pdf_lib.open(file_path)
                try:
                    return _nest_one_page(p, page_idx, local_doc)
                finally:
                    local_doc.close()

            if workers <= 1:
                for valid_group in valid_groups:
                    cap = _nest_group(valid_group)
                    for _, page_idx in valid_group:
                        results[page_idx] = cap
            else:
                from concurrent.futures import ThreadPoolExecutor, as_completed
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    pending = {pool.submit(_nest_group, group): group for group in valid_groups}
                    for future in as_completed(pending):
                        valid_group = pending[future]
                        try:
                            cap = future.result()
                        except Exception as exc:
                            logger.warning("[BATCH CAPACITY] geometry group failed: %s", exc)
                            cap = 0
                        for _, page_idx in valid_group:
                            results[page_idx] = cap
        else:
            for p in pages_in:
                page_idx = p.get("page_idx")
                if page_idx is None:
                    continue
                try:
                    page_idx = int(page_idx)
                except (TypeError, ValueError):
                    continue
                if page_idx < 0 or page_idx >= doc.page_count:
                    continue
                results[page_idx] = _nest_one_page(p, page_idx, doc)
    finally:
        doc.close()

    _pmark(
        "BATCH", "api_done", _t0,
        file=os.path.basename(file_path),
        pages_out=len(results),
        pages_req=_n_pages_req,
        single_mold=bool(_mold_master is not None),
        capacities=str({k: results[k] for k in sorted(results)[:8]}),
    )
    return {"success": True, "capacities": results}
