"""
API routes for high-performance PDF tools (pikepdf backend).

Provides endpoints for:
- POST /pdf-tools/merge     — Merge/interleave PDFs
- POST /pdf-tools/split     — Split PDF by range/count/extract
- POST /pdf-tools/resize    — Resize pages
- POST /pdf-tools/shuffle   — Reorder pages
"""

import os
import uuid
import shutil
import time
import logging
import threading
from contextlib import contextmanager
from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Request, Depends
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from typing import List, Optional
import json
from app.core.license_guard import require_license, require_feature, enforce_feature
from app.config import settings
from app.utils.errors import raise_http

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pdf-tools", tags=["PDF Tools"], dependencies=[Depends(require_license)])

# Xếp hàng job tạo viền bế / bù xén khi in liên tục. Mỗi job peak RAM cao
# (raster 300 DPI × workers); chạy chồng chéo dễ OOM. Mặc định 1 job/lúc
# (desktop in ấn). Override: PRYNX_MAX_STICKER_JOBS.
_MAX_CONCURRENT_STICKER = max(
    1, int(os.environ.get("PRYNX_MAX_STICKER_JOBS", "1") or "1")
)
_STICKER_JOB_SEMAPHORE = threading.BoundedSemaphore(_MAX_CONCURRENT_STICKER)


@contextmanager
def _sticker_job_slot(job_id: str = ""):
    """Acquire slot; job vượt mức chờ tới lượt (xếp hàng), không spawn song song."""
    waited = time.perf_counter()
    _STICKER_JOB_SEMAPHORE.acquire()
    wait_s = time.perf_counter() - waited
    if wait_s > 0.05:
        logger.info(
            "[STICKER] job queued job=%s wait_s=%.2f max_concurrent=%d",
            job_id, wait_s, _MAX_CONCURRENT_STICKER,
        )
    try:
        yield
    finally:
        _STICKER_JOB_SEMAPHORE.release()

def _log_sticker_response_complete(started: float, job_id: str, output_path: str) -> None:
    try:
        output_mb = os.path.getsize(output_path) / (1024 * 1024)
    except OSError:
        output_mb = 0.0
    logger.info(
        "[STICKER_TIMING] response_complete job=%s total_s=%.3f output_mb=%.2f",
        job_id,
        time.perf_counter() - started,
        output_mb,
    )

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)


def _safe_watermark(pdf_path: str, license_info: dict) -> None:
    """Nhúng stealth watermark (XMP + invisible text) vào PDF output.

    Non-blocking: mọi lỗi chỉ log, KHÔNG làm hỏng output. Bỏ qua ở dev mode
    (license_key == 'DEV_MODE') để output dev không bị đóng dấu rác.
    """
    lk = (license_info or {}).get("license_key", "") or ""
    if not lk or lk == "DEV_MODE":
        return
    hwid = (license_info or {}).get("hwid", "") or ""
    tmp_path = None
    try:
        import tempfile
        import pikepdf
        from app.core.watermark import embed_watermark
        with pikepdf.Pdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            embed_watermark(pdf, lk, hwid)
            # Ghi atomic: save ra temp cùng thư mục rồi os.replace, tránh hỏng
            # output nếu process chết giữa chừng khi ghi đè in-place.
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
            os.close(fd)
            pdf.save(tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.error(f"[WATERMARK] pdf-tools failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _strip_pdf_metadata(pdf_path: str) -> None:
    """Xóa metadata thật khỏi PDF: XMP (Root/Metadata) + Document Info (tác giả,
    tiêu đề, producer, history Photoshop...).

    Ghostscript KHÔNG xóa metadata — cờ -dFastWebView chỉ liên quan linearization.
    Muốn strip thật phải hậu xử lý bằng pikepdf. Gọi TRƯỚC watermark để XMP watermark
    (thêm sau) không bị xóa nhầm. Non-blocking: lỗi chỉ log, giữ nguyên file."""
    import tempfile
    import pikepdf
    tmp_path = None
    try:
        with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            # XMP metadata stream
            if "/Metadata" in pdf.Root:
                del pdf.Root.Metadata
            # Document Info dictionary (tác giả/tiêu đề/producer/CreationDate...)
            try:
                for k in list(pdf.docinfo.keys()):
                    del pdf.docinfo[k]
            except Exception:
                pass
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
            os.close(fd)
            pdf.save(tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.warning(f"[OPTIMIZE] strip metadata failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _normalize_compat(pdf_path: str) -> None:
    """Chuẩn hóa cấu trúc GS-output về xref cổ điển để pdf-lib (frontend) đọc lại
    được khi onFileFixed nạp blob về working file.

    Ghostscript pdfwrite ghi object stream + xref stream (Flate) mà pdf-lib/pako
    không giải nén được → 'Invalid header in flate stream'. Chạy CUỐI CÙNG (sau
    watermark) để giữ mọi nội dung. Non-blocking: lỗi chỉ log, giữ nguyên file."""
    import tempfile
    import pikepdf
    from app.workers.pdf_tools_engine import save_pdf_compat
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
        os.close(fd)
        with pikepdf.open(pdf_path) as pdf:
            save_pdf_compat(pdf, tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.warning(f"[OPTIMIZE] compat normalize failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


async def save_upload(file: UploadFile) -> str:
    """Save an uploaded file and return its path. 
    Uses async read and seek(0) to bypass FastAPI multipart parsing cursor bugs.
    """
    file_id = uuid.uuid4().hex
    path = os.path.join(UPLOAD_DIR, f"{file_id}.pdf")
    await file.seek(0)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    return path


@router.post("/merge")
async def merge_pdfs_endpoint(
    files: List[UploadFile] = File(...),
    mode: str = Form("merge_files"),
    license_info: dict = Depends(require_license),
):
    """
    Merge multiple PDFs.
    
    Modes: merge_files, interleave
    """
    from app.workers.pdf_tools_engine import merge_pdfs
    
    if len(files) < 1:
        raise HTTPException(status_code=400, detail="At least 1 file required")
    
    file_paths = []
    for f in files:
        file_paths.append(await save_upload(f))
    
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"merged_{job_id}.pdf")
    
    try:
        merge_pdfs(file_paths, output_path, mode=mode)
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename="merged_output.pdf",
            media_type="application/pdf"
        )
    except Exception as e:
        raise_http(e, "Gộp PDF thất bại")
    finally:
        for p in file_paths:
            try: os.remove(p)
            except OSError: pass


@router.post("/split")
async def split_pdf_endpoint(
    file: UploadFile = File(...),
    mode: str = Form("by_count"),
    config: str = Form("{}"),
    license_info: dict = Depends(require_license),
):
    """
    Split a PDF into multiple files.
    Returns a ZIP of the split files, or a single PDF.
    
    Modes: by_range, by_count, extract_pages
    Config JSON: { ranges, pagesPerFile, pageList }
    """
    from app.workers.pdf_tools_engine import split_pdf
    import zipfile
    from fastapi.responses import Response
    
    source_path = await save_upload(file)
    cfg = json.loads(config)
    
    job_id = uuid.uuid4().hex[:8]
    output_dir = os.path.join(RESULTS_DIR, f"split_{job_id}")
    base_name = file.filename.replace('.pdf', '') if file.filename else 'split'
    
    try:
        results = split_pdf(
            source_path, output_dir,
            mode=mode,
            ranges=cfg.get('ranges'),
            pages_per_file=cfg.get('pagesPerFile', 1),
            page_list=cfg.get('pageList'),
            base_name=base_name,
        )
        
        if len(results) == 1:
            _safe_watermark(results[0]["path"], license_info)
            return FileResponse(
                path=results[0]["path"],
                filename=results[0]["filename"],
                media_type="application/pdf"
            )
        
        # Multiple files: return as ZIP
        import io
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for r in results:
                _safe_watermark(r["path"], license_info)
                zf.write(r["path"], r["filename"])
        zip_buffer.seek(0)
        
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=split_{job_id}.zip"}
        )
    except Exception as e:
        raise_http(e, "Tách PDF thất bại")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/resize")
async def resize_pages_endpoint(
    file: UploadFile = File(...),
    target_w: float = Form(210),
    target_h: float = Form(297),
    scale_mode: str = Form("fit"),
    apply_to: str = Form("all"),
    target_dpi: int = Form(0),
    mode: str = Form("auto"),
    license_info: dict = Depends(require_license),
):
    """Resize PDF pages to a new format.

    target_dpi > 0 bật GIẢM DỮ LIỆU theo khổ mới (giống PDF Optimizer): file thu
    nhỏ đúng theo khổ đích thay vì giữ nguyên độ phân giải gốc. mode:
      - 'auto'    : tự chọn (raster khi thuần ảnh & an toàn, còn lại vector).
      - 'vector'  : GS downsample ảnh, giữ vector/text/CMYK (an toàn in ấn).
      - 'raster'  : render lại theo DPI (nhanh/nhỏ nhất, mất vector & CMYK).
      - 'xobject' : chỉ đổi hình học (hành vi cũ, không giảm dung lượng).
    target_dpi=0 → giữ hành vi cũ."""
    from app.workers.pdf_tools_engine import resize_pages_smart

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"resized_{job_id}.pdf")

    try:
        resize_pages_smart(source_path, output_path, target_w, target_h,
                           scale_mode, apply_to, target_dpi=target_dpi, mode=mode)
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"resized_{file.filename}",
            media_type="application/pdf"
        )
    except Exception as e:
        raise_http(e, "Đổi kích thước trang thất bại")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/trim-shift")
async def trim_shift_endpoint(
    file: UploadFile = File(...),
    apply_to: str = Form("all"),
    config: str = Form("{}"),
    license_info: dict = Depends(require_feature("pdf.trim_shift")),
):
    """Trim & Shift — chỉnh box từng cạnh + dịch nội dung (binding/creep).

    Config JSON: {
        trimTop, trimBottom, trimLeft, trimRight,   # mm, ± (dương=nở, âm=cắt)
        shiftX, shiftY,                              # mm
        bindingEnabled, bindingMm, bindingInward,
        creepEnabled, creepMm, creepAxis             # 'x' | 'y'
    }
    """
    from app.workers.trim_shift_engine import trim_shift

    source_path = await save_upload(file)
    cfg = json.loads(config)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"trimshift_{job_id}.pdf")

    try:
        trim_shift(
            source_path, output_path,
            apply_to=apply_to,
            trim_top_mm=float(cfg.get('trimTop', 0)),
            trim_bottom_mm=float(cfg.get('trimBottom', 0)),
            trim_left_mm=float(cfg.get('trimLeft', 0)),
            trim_right_mm=float(cfg.get('trimRight', 0)),
            shift_x_mm=float(cfg.get('shiftX', 0)),
            shift_y_mm=float(cfg.get('shiftY', 0)),
            binding_enabled=bool(cfg.get('bindingEnabled', False)),
            binding_mm=float(cfg.get('bindingMm', 0)),
            binding_inward=bool(cfg.get('bindingInward', True)),
            creep_enabled=bool(cfg.get('creepEnabled', False)),
            creep_mm=float(cfg.get('creepMm', 0)),
            creep_axis=str(cfg.get('creepAxis', 'x')),
            mirror_fill=bool(cfg.get('mirrorFill', False)),
            content_mode=str(cfg.get('contentMode', 'original')),
            keep_bleed=bool(cfg.get('keepBleed', False)),
        )
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"trimshift_{file.filename}",
            media_type="application/pdf"
        )
    except Exception as e:
        raise_http(e, "Trim/shift trang thất bại")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/shuffle")
async def shuffle_pages_endpoint(
    file: UploadFile = File(...),
    action: str = Form("reverse"),
    mapping: str = Form("[]"),
    license_info: dict = Depends(require_license),
):
    """
    Reorder pages in a PDF.
    
    Actions: reverse, odd_first, even_first, custom
    Mapping: JSON array of 1-based page numbers (for custom action)
    """
    from app.workers.pdf_tools_engine import shuffle_pages
    
    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"shuffled_{job_id}.pdf")
    
    mapping_list = json.loads(mapping) if mapping else []
    
    try:
        shuffle_pages(source_path, output_path, action=action, mapping=mapping_list)
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"shuffled_{file.filename}",
            media_type="application/pdf"
        )
    except Exception as e:
        raise_http(e, "Sắp xếp lại trang thất bại")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/ocr-searchable")
async def ocr_searchable_endpoint(
    file: UploadFile = File(...),
    lang: str = Form("vie+eng"),
    dpi: int = Form(300),
    preprocess: str = Form("false"),
    license_info: dict = Depends(require_license),
):
    """
    Create a Searchable PDF by embedding an invisible OCR text layer.

    Takes a scanned/rasterized PDF and runs Tesseract OCR on each page,
    inserting invisible text at the correct coordinates so the PDF becomes
    searchable (Ctrl+F) and text-selectable.

    Args:
        file:       The source PDF file
        lang:       Tesseract language pack(s) (default: "vie+eng")
        dpi:        Render resolution for OCR (default: 300)
        preprocess: "true" to apply denoise/deskew (recommended for scans)
    """
    from app.core.ocr_engine import OCREngine

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"searchable_{job_id}.pdf")

    do_preprocess = preprocess.lower() in ("true", "1", "yes")

    try:
        result = OCREngine.make_searchable_pdf(
            input_path=source_path,
            output_path=output_path,
            lang=lang,
            dpi=dpi,
            preprocess=do_preprocess,
        )

        if result["total_words"] == 0:
            raise HTTPException(
                status_code=422,
                detail="OCR không nhận diện được ký tự nào. File có thể trống hoặc chứa nội dung không phải chữ."
            )

        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"searchable_{file.filename}",
            media_type="application/pdf",
            headers={
                "X-OCR-Total-Pages": str(result["total_pages"]),
                "X-OCR-Pages-With-Text": str(result["pages_with_text"]),
                "X-OCR-Total-Words": str(result["total_words"]),
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("OCR thất bại")
        raise HTTPException(status_code=500, detail=f"OCR thất bại ({type(e).__name__})")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/optimize")
async def optimize_pdf_endpoint(
    file: UploadFile = File(...),
    preset: str = Form("ebook"),
    image_dpi: int = Form(300),
    strip_metadata: str = Form("true"),
    grayscale: str = Form("false"),
    license_info: dict = Depends(require_license),
):
    """
    Compress/optimize a PDF using Ghostscript.

    Presets (maps to -dPDFSETTINGS):
      - screen:   72 DPI images, max compression, smallest file
      - ebook:    150 DPI images, good quality, small file (DEFAULT)
      - printer:  300 DPI images, high quality, larger file
      - prepress: 300 DPI images, preserve all, largest file
      - custom:   Use image_dpi parameter for manual control

    Returns the optimized PDF with compression stats in headers.
    """
    import subprocess
    import asyncio
    from app.config import settings
    from app.utils.subprocess_utils import run_hidden

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"optimized_{job_id}.pdf")

    original_size = os.path.getsize(source_path)
    do_strip = strip_metadata.lower() in ("true", "1", "yes")
    do_gray = grayscale.lower() in ("true", "1", "yes")

    # Build Ghostscript command
    gs_path = settings.GHOSTSCRIPT_PATH
    cmd = [
        gs_path,
        "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
    ]

    # Preset-specific settings
    if preset == "custom":
        cmd += [
            "-dPDFSETTINGS=/default",
            "-dDownsampleColorImages=true",
            f"-dColorImageResolution={image_dpi}",
            "-dDownsampleGrayImages=true",
            f"-dGrayImageResolution={image_dpi}",
            "-dDownsampleMonoImages=true",
            f"-dMonoImageResolution={min(image_dpi * 2, 1200)}",
        ]
    else:
        valid_presets = {"screen", "ebook", "printer", "prepress"}
        if preset not in valid_presets:
            preset = "ebook"
        cmd.append(f"-dPDFSETTINGS=/{preset}")

    # Subset fonts always
    cmd += ["-dSubsetFonts=true", "-dEmbedAllFonts=true"]

    # Grayscale conversion. Đặt SAU preset để thắng: preset /prepress vốn set
    # ColorConversionStrategy=/LeaveColorUnchanged (giữ CMYK) — sẽ nuốt grayscale
    # nếu không ghi đè. -dOverrideICC + strategy Gray ép chuyển xám kể cả prepress.
    if do_gray:
        cmd += [
            "-sProcessColorModel=DeviceGray",
            "-sColorConversionStrategy=Gray",
            "-dOverrideICC=true",
        ]

    # KHÔNG strip metadata bằng Ghostscript ở đây: -dFastWebView chỉ về
    # linearization, không xóa XMP/docinfo. Việc strip thật do _strip_pdf_metadata
    # (pikepdf) làm ở khâu hậu xử lý bên dưới.

    cmd += [f"-sOutputFile={output_path}", source_path]

    try:
        import time as _time
        t0 = _time.perf_counter()

        def _run_gs():
            return run_hidden(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=600,  # 10 min max for large files
            )

        result = await asyncio.to_thread(_run_gs)
        t_gs = _time.perf_counter() - t0

        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(f"Hệ thống nén báo lỗi nội bộ, không thể xử lý file này.")

        if not os.path.exists(output_path):
            raise RuntimeError("Hệ thống nén không xuất được file kết quả.")

        gs_size = os.path.getsize(output_path)
        output_size = gs_size
        ratio = round((1 - output_size / original_size) * 100, 1) if original_size > 0 else 0

        # If output is actually larger, just return original
        if output_size >= original_size:
            os.replace(source_path, output_path)
            output_size = original_size
            ratio = 0

        # Strip metadata THẬT (pikepdf) — trước watermark để XMP watermark thêm
        # sau không bị xóa nhầm. Chạy kể cả khi GS không nén được (đã trả file gốc)
        # vì đây là yêu cầu riêng của user, độc lập với việc nén.
        t1 = _time.perf_counter()
        if do_strip:
            _strip_pdf_metadata(output_path)
        t_strip = _time.perf_counter() - t1

        t2 = _time.perf_counter()
        _safe_watermark(output_path, license_info)
        t_wm = _time.perf_counter() - t2

        # Chuẩn hóa xref cổ điển CUỐI CÙNG để pdf-lib (frontend) mở lại được.
        t3 = _time.perf_counter()
        _normalize_compat(output_path)
        t_compat = _time.perf_counter() - t3

        # Kích thước có thể đổi sau hậu xử lý → cập nhật lại header cho chính xác.
        output_size = os.path.getsize(output_path)
        ratio = round((1 - output_size / original_size) * 100, 1) if original_size > 0 else 0

        t_total = _time.perf_counter() - t0
        logger.info(
            "[OPTIMIZE_TIMING] job=%s preset=%s in=%.2fMB gs_out=%.2fMB final=%.2fMB "
            "gs=%.2fs strip=%.2fs(%s) wm=%.2fs compat=%.2fs total=%.2fs",
            job_id, preset,
            original_size / (1024 * 1024), gs_size / (1024 * 1024), output_size / (1024 * 1024),
            t_gs, t_strip, "on" if do_strip else "off", t_wm, t_compat, t_total,
        )

        return FileResponse(
            path=output_path,
            filename=f"optimized_{file.filename}",
            media_type="application/pdf",
            headers={
                "X-Original-Size": str(original_size),
                "X-Output-Size": str(output_size),
                "X-Compression-Ratio": str(ratio),
            }
        )
    except Exception as e:
        logger.exception("Tối ưu thất bại")
        raise HTTPException(status_code=500, detail=f"Tối ưu thất bại ({type(e).__name__})")
    finally:
        try: os.remove(source_path)
        except OSError: pass

@router.post("/encrypt")
async def encrypt_pdf_endpoint(
    file: UploadFile = File(...),
    user_password: str = Form(""),
    owner_password: str = Form(""),
    allow_print: str = Form("true"),
    allow_copy: str = Form("true"),
    allow_modify: str = Form("false"),
    allow_annotate: str = Form("true"),
    allow_form: str = Form("true"),
    allow_assembly: str = Form("false"),
    open_password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Lock a PDF (AES-256 via pikepdf). Does not modify other pdf-tools pipelines."""
    from app.workers.pdf_tools_engine import encrypt_pdf

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"encrypted_{job_id}.pdf")

    def _flag(v: str) -> bool:
        return (v or "").lower() in ("true", "1", "yes")

    try:
        # Không gọi _safe_watermark sau khi khóa (file đã encrypt → open fail).
        # Watermark stealth vẫn áp dụng trên /decrypt và các tool plain-PDF khác.
        encrypt_pdf(
            source_path,
            output_path,
            user_password=user_password or "",
            owner_password=owner_password or "",
            allow_print=_flag(allow_print),
            allow_copy=_flag(allow_copy),
            allow_modify=_flag(allow_modify),
            allow_annotate=_flag(allow_annotate),
            allow_form=_flag(allow_form),
            allow_assembly=_flag(allow_assembly),
            open_password=open_password or "",
        )
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"encrypted_{base}",
            media_type="application/pdf",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Khóa PDF thất bại")
        raise_http(e, "Khóa PDF thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/decrypt")
async def decrypt_pdf_endpoint(
    file: UploadFile = File(...),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Unlock a PDF when the password is known. Isolated from other tools."""
    from app.workers.pdf_tools_engine import decrypt_pdf

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"decrypted_{job_id}.pdf")

    try:
        decrypt_pdf(source_path, output_path, password=password or "")
        _safe_watermark(output_path, license_info)
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"decrypted_{base}",
            media_type="application/pdf",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Mở khóa PDF thất bại")
        raise_http(e, "Mở khóa PDF thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/encryption-status")
async def encryption_status_endpoint(
    file: UploadFile = File(...),
    license_info: dict = Depends(require_license),
):
    """Lightweight probe: is this PDF encrypted? Does not alter the file."""
    from app.workers.pdf_tools_engine import pdf_is_encrypted

    source_path = await save_upload(file)
    try:
        return {"encrypted": pdf_is_encrypted(source_path)}
    except Exception as e:
        logger.exception("Kiểm tra mã hóa thất bại")
        raise_http(e, "Kiểm tra mã hóa thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/metadata/read")
async def metadata_read_endpoint(
    file: UploadFile = File(...),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Read standard Info metadata. Isolated from optimize strip_metadata."""
    from app.workers.pdf_tools_engine import read_pdf_metadata

    source_path = await save_upload(file)
    try:
        meta = read_pdf_metadata(source_path, password=password or "")
        return {"metadata": meta}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Đọc metadata thất bại")
        raise_http(e, "Đọc metadata thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/metadata/write")
async def metadata_write_endpoint(
    file: UploadFile = File(...),
    title: str = Form(""),
    author: str = Form(""),
    subject: str = Form(""),
    keywords: str = Form(""),
    creator: str = Form(""),
    producer: str = Form(""),
    clear_all: str = Form("false"),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Write or clear Info metadata. Does not change page content / optimize path."""
    from app.workers.pdf_tools_engine import write_pdf_metadata

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"metadata_{job_id}.pdf")
    do_clear = (clear_all or "").lower() in ("true", "1", "yes")

    try:
        fields = {
            "Title": title,
            "Author": author,
            "Subject": subject,
            "Keywords": keywords,
            "Creator": creator,
            "Producer": producer,
        }
        write_pdf_metadata(
            source_path,
            output_path,
            fields=fields,
            clear_all=do_clear,
            password=password or "",
        )
        _safe_watermark(output_path, license_info)
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"metadata_{base}",
            media_type="application/pdf",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Ghi metadata thất bại")
        raise_http(e, "Ghi metadata thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.get("/office-convert/status")
async def office_convert_status(license_info: dict = Depends(require_license)):
    """Probe available Word/Excel/LibreOffice/Google converters (no side effects)."""
    from app.workers.office_convert_engine import probe_converters
    return probe_converters()


@router.post("/office-convert/file")
async def office_convert_file_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    excel_layout: str = Form("preserve"),
    batch_mode: bool = Form(False),
    license_info: dict = Depends(require_license),
):
    """Convert Word/Excel/… → PDF.

    Prefer ``file_path`` (absolute path on same machine as sidecar) — reliable for
    Tauri path-stub Files. Fallback: multipart upload ``file``.
    """
    from app.workers.office_convert_engine import convert_office_file, OFFICE_EXTENSIONS
    if batch_mode:
        enforce_feature("pdf.office_batch", license_info)

    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"converted_{job_id}.pdf")
    source_path: Optional[str] = None
    delete_source = False
    name = "document.docx"

    try:
        path_arg = (file_path or "").strip().strip('"')
        if path_arg:
            if not os.path.isfile(path_arg):
                raise HTTPException(status_code=400, detail=f"Không tìm thấy file: {path_arg}")
            source_path = path_arg
            name = os.path.basename(path_arg)
            delete_source = False  # never delete user's original
        elif file is not None and (file.filename or file.size is not None):
            name = file.filename or "document.docx"
            ext = os.path.splitext(name)[1].lower()
            if ext not in OFFICE_EXTENSIONS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Định dạng không hỗ trợ: {ext}. Hỗ trợ: {', '.join(sorted(OFFICE_EXTENSIONS))}",
                )
            file_id = uuid.uuid4().hex
            source_path = os.path.join(UPLOAD_DIR, f"{file_id}{ext}")
            await file.seek(0)
            content = await file.read()
            if not content:
                raise HTTPException(
                    status_code=400,
                    detail="File upload rỗng. Hãy chọn lại file hoặc dùng đường dẫn đĩa.",
                )
            with open(source_path, "wb") as f:
                f.write(content)
            delete_source = True
        else:
            raise HTTPException(
                status_code=400,
                detail="Thiếu file: gửi file_path (đường dẫn tuyệt đối) hoặc upload file.",
            )

        ext = os.path.splitext(name)[1].lower()
        if ext not in OFFICE_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Định dạng không hỗ trợ: {ext}. Hỗ trợ: {', '.join(sorted(OFFICE_EXTENSIONS))}",
            )

        # COM/LibreOffice are blocking and may take minutes on complex files.
        from fastapi.concurrency import run_in_threadpool
        await run_in_threadpool(convert_office_file, source_path, output_path, excel_layout)
        if not os.path.isfile(output_path) or os.path.getsize(output_path) < 32:
            raise HTTPException(status_code=500, detail="Chuyển đổi xong nhưng file PDF rỗng.")

        _safe_watermark(output_path, license_info)
        base = os.path.splitext(name)[0] + ".pdf"
        return FileResponse(
            path=output_path,
            filename=f"converted_{base}",
            media_type="application/pdf",
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Office convert failed")
        raise_http(e, "Chuyển Office → PDF thất bại")
    finally:
        if delete_source and source_path:
            try:
                os.remove(source_path)
            except OSError:
                pass


@router.post("/office-convert/google")
async def office_convert_google_endpoint(
    url: str = Form(...),
    license_info: dict = Depends(require_license),
):
    """Export PDF from a shareable Google Docs / Sheets / Slides link."""
    from app.workers.office_convert_engine import convert_google_link, parse_google_url

    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"google_{job_id}.pdf")
    try:
        kind, _fid = parse_google_url(url)
        # The engine uses a synchronous HTTP client; keep the API loop responsive.
        from fastapi.concurrency import run_in_threadpool
        await run_in_threadpool(convert_google_link, url, output_path)
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"google_{kind}.pdf",
            media_type="application/pdf",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Google convert failed")
        raise_http(e, "Xuất Google → PDF thất bại")


@router.post("/office-convert/resize-output")
async def office_convert_resize_output(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    target_w: float = Form(...),
    target_h: float = Form(...),
    auto_orientation: bool = Form(True),
    license_info: dict = Depends(require_license),
    batch_mode: bool = Form(False),
):
    """Fit a batch PDF onto a standard paper size without rasterizing or overwriting."""
    from fastapi.concurrency import run_in_threadpool
    from app.workers.pdf_tools_engine import resize_pages

    if batch_mode:
        enforce_feature("pdf.resize_batch", license_info)
    if not (10.0 <= target_w <= 5000.0 and 10.0 <= target_h <= 5000.0):
        raise HTTPException(status_code=400, detail="Kích thước PDF phải từ 10 đến 5000 mm.")

    source_path: Optional[str] = None
    delete_source = False
    name = "document.pdf"
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"batch_resized_{job_id}.pdf")
    try:
        path_arg = (file_path or "").strip().strip('"')
        if path_arg:
            if not os.path.isfile(path_arg) or not path_arg.lower().endswith(".pdf"):
                raise HTTPException(status_code=400, detail="Không tìm thấy file PDF nguồn.")
            source_path = path_arg
            name = os.path.basename(path_arg)
        elif file is not None:
            name = file.filename or "document.pdf"
            if not name.lower().endswith(".pdf"):
                raise HTTPException(status_code=400, detail="File tải lên không phải PDF.")
            source_path = await save_upload(file)
            delete_source = True
        else:
            raise HTTPException(status_code=400, detail="Thiếu file PDF cần chuẩn hóa.")

        await run_in_threadpool(
            resize_pages,
            source_path,
            output_path,
            target_w,
            target_h,
            "fit",
            "all",
            auto_orientation,
        )
        return FileResponse(
            path=output_path,
            filename=f"resized_{name}",
            media_type="application/pdf",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Batch output resize failed")
        raise_http(e, "Chuẩn hóa khổ PDF thất bại")
    finally:
        if delete_source and source_path:
            try:
                os.remove(source_path)
            except OSError:
                pass

@router.post("/sticker-dieline", dependencies=[Depends(require_feature("prepress.cutline"))])
async def sticker_dieline_endpoint(request: Request, license_info: dict = Depends(require_license)):
    """Generate Cut Contour and Bleed for Stickers."""
    request_started = time.perf_counter()
    from app.workers.sticker_engine import StickerEngine
    
    form = await request.form()
    
    file_id = form.get("file_id")
    file_path = form.get("file_path")
    source_path = None
    delete_source = False
    source_kind = "upload"

    # Desktop files already have a real local path. Reading that path directly
    # avoids uploading hundreds of MB to the local sidecar before processing.
    # A baked page-order/rotation edit has no path and automatically falls back
    # to the existing upload flow below.
    if file_path:
        supplied_path = str(file_path)
        if ".." in supplied_path:
            raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed")
        if os.path.islink(supplied_path):
            raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed")
        real_path = os.path.realpath(supplied_path)
        if not os.path.isfile(real_path):
            raise HTTPException(status_code=404, detail="File not found on disk.")
        if not real_path.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Unsupported file type")
        source_path = real_path
        original_name = os.path.basename(real_path)
        source_kind = "local_path"
    elif file_id:
        # The upload endpoint returns a database ID; resolve its temporary copy.
        from app.database import SessionLocal
        from app.models.job import UploadedFile as UploadedFileModel

        db = SessionLocal()
        try:
            db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == file_id).first()
            if not db_file:
                raise HTTPException(status_code=404, detail="File not found in database.")
            source_path = db_file.file_path
            original_name = db_file.original_name
            delete_source = True
        finally:
            db.close()
    else:
        raise HTTPException(
            status_code=400,
            detail="Missing 'file_id' or 'file_path' field.",
        )

    if not os.path.exists(source_path):
        raise HTTPException(status_code=404, detail="File not found on disk.")
        
    # Verify file is not 0 bytes
    if os.path.getsize(source_path) == 0:
        raise HTTPException(status_code=400, detail=f"File rỗng (0 bytes). Vui lòng chọn một file PDF hợp lệ có chứa dữ liệu.")

    cut_mode = form.get("cut_mode", "original")
    offset_mm = float(form.get("offset_mm", 0.0))
    corner_style = form.get("corner_style", "round")
    bleed_mm = float(form.get("bleed_mm", 0.0))
    fill_holes = form.get("fill_holes", "true")
    remove_white_bg = form.get("remove_white_bg", "false")
    draw_cut_contour = form.get("draw_cut_contour", "true")
    bleed_color_type = form.get("bleed_color_type", "image")
    bleed_color_hex = form.get("bleed_color_hex", "#FFFFFF")
    rectangle_mode_raw = form.get("rectangle_mode", "false")
    do_rectangle_mode = rectangle_mode_raw.lower() in ("true", "1", "yes")
    cut_first_page_only_raw = form.get("cut_first_page_only", "false")
    do_cut_first_page_only = cut_first_page_only_raw.lower() in ("true", "1", "yes")
    # auto_safe | contour | force_circle | force_ellipse | force_rect | force_triangle
    shape_mode = (form.get("shape_mode") or "auto_safe").strip().lower()
    try:
        edge_bite_mm = float(form.get("edge_bite_mm", 0.0))
    except (ValueError, TypeError):
        edge_bite_mm = 0.0
    
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"sticker_{job_id}.pdf")
    
    do_fill_holes = fill_holes.lower() in ("true", "1", "yes")
    do_remove_bg = remove_white_bg.lower() in ("true", "1", "yes")
    do_draw_cut_contour = draw_cut_contour.lower() in ("true", "1", "yes")
    
    try:
        # Parse CMYK string (e.g. "100,50,0,0") or fallback to RGB HEX.
        # Bọc an toàn: chuỗi rỗng/thiếu phần tử không được làm sập request.
        solid_bleed_color = (255, 255, 255)
        try:
            if bleed_color_hex and ',' in bleed_color_hex:
                raw = [p.strip() for p in bleed_color_hex.split(',')]
                parts = [int(p) if p else 0 for p in raw]
                if len(parts) == 4:
                    # CMYK input is 0-100, OpenCV/PIL wants 0-255
                    parts = [max(0, min(100, p)) for p in parts]
                    solid_bleed_color = tuple(int(p * 2.55) for p in parts)
            elif bleed_color_hex and bleed_color_hex.startswith("#"):
                h = bleed_color_hex.lstrip('#')
                if len(h) == 6:
                    solid_bleed_color = tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
        except (ValueError, TypeError):
            logger.warning("sticker-dieline: bleed_color_hex không hợp lệ (%r), dùng mặc định trắng.", bleed_color_hex)
            solid_bleed_color = (255, 255, 255)
                
        engine = StickerEngine(dpi=300)
        engine_started = time.perf_counter()
        # Xếp hàng: in liên tục nhiều file không chồng 2 job bù xén (tránh OOM).
        with _sticker_job_slot(job_id):
            success, meta = engine.process_pdf(
                input_path=source_path,
                output_path=output_path,
                cut_mode=cut_mode,
                offset_mm=offset_mm,
                corner_style=corner_style,
                bleed_mm=bleed_mm,
                fill_holes=do_fill_holes,
                remove_white_bg=do_remove_bg,
                bleed_color_type=bleed_color_type,
                solid_bleed_color=solid_bleed_color,
                draw_cut_contour=do_draw_cut_contour,
                rectangle_mode=do_rectangle_mode,
                edge_bite_mm=edge_bite_mm,
                cut_first_page_only=do_cut_first_page_only,
                shape_mode=shape_mode,
            )
        engine_seconds = time.perf_counter() - engine_started
        if not success or not os.path.exists(output_path):
            # success=False kèm meta['error'] = lỗi nghiệp vụ (vd không dò được hình)
            biz_err = meta.get("error") if isinstance(meta, dict) else None
            if biz_err:
                raise HTTPException(status_code=422, detail=biz_err)
            raise RuntimeError("Lỗi lưu file kết quả. (File not found)")

        _safe_watermark(output_path, license_info)

        headers = {
            "X-Sticker-Output-Path": os.path.abspath(output_path),
        }
        if meta and "width_mm" in meta and "height_mm" in meta:
            headers["X-Sticker-Width-MM"] = str(meta["width_mm"])
            headers["X-Sticker-Height-MM"] = str(meta["height_mm"])
            if "boxes" in meta:
                import json
                headers["X-Sticker-Boxes"] = json.dumps(meta["boxes"])
            if "shape_type" in meta:
                headers["X-Sticker-Shape-Type"] = meta["shape_type"]
            if "shape_params" in meta:
                headers["X-Sticker-Shape-Params"] = meta["shape_params"]
            # Hình học đường cắt tự nhận (auto_safe) + độ tin cậy → frontend hiện tên
            # hình đã nhận làm van an toàn thay cho dropdown shape_mode đã ẩn.
            if meta.get("cut_kind"):
                headers["X-Sticker-Cut-Kind"] = str(meta["cut_kind"])
            if meta.get("cut_confidence") is not None:
                headers["X-Sticker-Cut-Confidence"] = str(meta["cut_confidence"])
            if "pages" in meta:
                import json
                headers["X-Sticker-Pages"] = json.dumps(meta["pages"])
        if isinstance(meta, dict) and meta.get("warning"):
            import urllib.parse
            # Header value phải ASCII → percent-encode để giữ được tiếng Việt.
            headers["X-Sticker-Warning"] = urllib.parse.quote(meta["warning"])
            
        logger.info(
            "[STICKER_TIMING] output_ready job=%s engine_s=%.3f ready_s=%.3f "
            "input_mb=%.2f output_mb=%.2f pages=%d rectangle=%s bleed_mode=%s source=%s",
            job_id,
            engine_seconds,
            time.perf_counter() - request_started,
            os.path.getsize(source_path) / (1024 * 1024),
            os.path.getsize(output_path) / (1024 * 1024),
            len(meta.get("pages", [])) if isinstance(meta, dict) else 0,
            do_rectangle_mode,
            bleed_color_type,
            source_kind,
        )
        return FileResponse(
            path=output_path,
            filename=f"dieline_{original_name}",
            media_type="application/pdf",
            headers=headers,
            background=BackgroundTask(
                _log_sticker_response_complete, request_started, job_id, output_path
            ),
        )
    except HTTPException:
        raise
    except Exception as e:
        # Log đầy đủ (kèm stacktrace) ở server để chẩn đoán.
        logger.error("sticker-dieline thất bại: %s", e, exc_info=True)
        # Engine ném RuntimeError("[{debug_step}] {msg}") — tag [debug_step] là NHÃN
        # NỘI BỘ an toàn (vd "[Process Contours Page 1]"), msg là chuỗi lỗi của
        # chính engine (loại + nội dung exception), KHÔNG phải stacktrace/đường dẫn
        # hệ thống. Hiện cả tag lẫn msg ra client để chẩn đoán nhanh chết ở BƯỚC
        # nào + LOẠI lỗi gì mà không cần đọc log server.
        _msg = str(e).strip()
        detail = (
            f"Lỗi tạo viền bế: {_msg}. Vui lòng thử lại hoặc kiểm tra lại file đầu vào."
            if _msg else
            "Lỗi tạo viền bế. Vui lòng thử lại hoặc kiểm tra lại file đầu vào."
        )
        raise HTTPException(status_code=500, detail=detail)
    finally:
        if delete_source and source_path:
            try: os.remove(source_path)
            except OSError: pass

@router.post("/remove-background", dependencies=[Depends(require_feature("util.bgremover"))])
async def remove_background_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    engine: str = Form('general'),
    edge_shift: int = Form(0),
    bg_color: str = Form('transparent'),
    custom_hex: str = Form('#FFFFFF'),
    auto_crop: bool = Form(False)
):
    """
    Remove background from an image using AI model.
    Takes JPG/PNG, applies post-processing, returns PNG.
    """
    from app.workers.image_postprocessor import apply_edge_shift, apply_auto_crop, apply_background
    from fastapi.concurrency import run_in_threadpool
    from PIL import Image
    import io

    if file:
        source_path = await save_upload(file)
        is_temp = True
    elif file_path:
        # Defense-in-depth: validate client-supplied path
        if '..' in file_path:
            raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed")
        real = os.path.realpath(file_path)
        if os.path.islink(real):
            raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed")
        if not os.path.isfile(real):
            raise HTTPException(status_code=400, detail="File not found")
        allowed_exts = ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.pdf')
        if not real.lower().endswith(allowed_exts):
            raise HTTPException(status_code=400, detail="Unsupported file type")
        source_path = real
        is_temp = False
    else:
        raise HTTPException(status_code=400, detail="Vui lòng cung cấp file hoặc file_path hợp lệ")

    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"bg_removed_{job_id}.png")

    # Suy luận AI nặng (BiRefNet ONNX ~927MB / rembg) là tác vụ ĐỒNG BỘ, CPU/GPU-bound.
    # Phải chạy trong threadpool — KHÔNG chạy thẳng trong async endpoint, nếu không sẽ
    # KHOÁ event loop → cả server "đứng hình" suốt lúc tách nền (đó là lý do "nặng/không chạy").
    def _process_bg_removal():
        with Image.open(source_path) as img:
            img.load()
            work = img
            # Chặn OOM/treo với ảnh siêu lớn: mask AI luôn ở 1024px nên ảnh > 6000px
            # không tăng chất lượng mà chỉ ngốn RAM. Hạ về 6000px cạnh dài (giữ tỷ lệ).
            MAX_SIDE = 6000
            if max(work.size) > MAX_SIDE:
                ratio = MAX_SIDE / float(max(work.size))
                work = work.resize((max(1, int(work.width * ratio)), max(1, int(work.height * ratio))), Image.LANCZOS)

            if engine == 'fast':
                # NHANH NHẤT (hàng loạt) — ISNet (~0.1s GPU / 0.6s CPU), chất lượng khá.
                from app.workers.isnet_engine import remove_background as _remove
                result_img = _remove(work)
            elif engine in ('max', 'hair'):
                # TỐI ĐA cho tóc/lông/kính — BiRefNet full (nặng, GPU yếu sẽ rớt CPU ~14s).
                from app.workers.birefnet_engine import remove_background as _remove
                result_img = _remove(work, variant='full')
            else:
                # MẶC ĐỊNH "Chất lượng cao" — BiRefNet-lite (xịn, vừa VRAM GPU ~6s).
                from app.workers.birefnet_engine import remove_background as _remove
                result_img = _remove(work, variant='lite')

            if edge_shift != 0:
                result_img = apply_edge_shift(result_img, edge_shift)
            if auto_crop:
                result_img = apply_auto_crop(result_img)
            if bg_color != 'transparent':
                result_img = apply_background(result_img, bg_color, custom_hex)

            result_img.save(output_path, format="PNG")

    try:
        await run_in_threadpool(_process_bg_removal)

        return FileResponse(
            path=output_path,
            filename=f"bg_removed_{file.filename.split('.')[0]}.png" if file and file.filename else f"bg_removed_{job_id}.png",
            media_type="image/png"
        )
    except Exception as e:
        logger.error("remove-background thất bại: %s", e, exc_info=True)
        # Anti-recon: KHÔNG trả str(e) ra client (có thể lộ path model ~/.u2net / URL / deps).
        # Chi tiết đã ghi log nội bộ (exc_info) để chẩn đoán; client nhận generic + type name
        # (nhất quán với chuẩn xử lý lỗi toàn backend).
        raise HTTPException(status_code=500, detail=f"Tách nền thất bại ({type(e).__name__})")
    finally:
        if is_temp:
            try: os.remove(source_path)
            except OSError: pass


@router.post("/remove-background/warmup", dependencies=[Depends(require_feature("util.bgremover"))])
async def remove_background_warmup(engine: str = Form("general")):
    """Nạp sẵn model tách nền (chạy nền) để lần bấm đầu không phải chờ cold-start.
    FE gọi khi mở công cụ; chạy trong threadpool nên không khoá event loop.

    Warm ĐÚNG engine người dùng đang chọn (trước đây chỉ warm birefnet-lite →
    chọn 'fast'/'hair' vẫn cold-start):
      - 'fast'        → ISNet (~178MB)
      - 'hair'/'max'  → BiRefNet full (927MB, chất lượng tối đa)
      - còn lại       → BiRefNet lite (mặc định 'general')
    """
    from fastapi.concurrency import run_in_threadpool
    e = (engine or "general").strip().lower()
    if e == "fast":
        from app.workers.isnet_engine import warmup
        ok = await run_in_threadpool(warmup)
    elif e in ("hair", "max"):
        from app.workers.birefnet_engine import warmup
        ok = await run_in_threadpool(warmup, "full")
    else:
        from app.workers.birefnet_engine import warmup
        ok = await run_in_threadpool(warmup, "lite")
    return {"ok": bool(ok)}


@router.post("/upscale", dependencies=[Depends(require_feature("util.upscale"))])
async def upscale_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    engine: str = Form('general'),
):
    """Phóng to ảnh 4x bằng AI super-resolution (ONNX). Nhận JPG/PNG/WebP..., trả PNG.

    Chỉ còn một model (general). Giữ alpha nếu ảnh có.
    """
    from fastapi.concurrency import run_in_threadpool
    from PIL import Image

    if file:
        source_path = await save_upload(file)
        is_temp = True
    elif file_path:
        # Defense-in-depth: validate client-supplied path (giống remove-background).
        if '..' in file_path:
            raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed")
        real = os.path.realpath(file_path)
        if os.path.islink(real):
            raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed")
        if not os.path.isfile(real):
            raise HTTPException(status_code=400, detail="File not found")
        allowed_exts = ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff')
        if not real.lower().endswith(allowed_exts):
            raise HTTPException(status_code=400, detail="Unsupported file type")
        source_path = real
        is_temp = False
    else:
        raise HTTPException(status_code=400, detail="Vui lòng cung cấp file hoặc file_path hợp lệ")

    variant = 'general'  # chỉ còn một model
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"upscaled_{job_id}.png")

    def _process_upscale():
        from app.workers.realesrgan_engine import upscale as _upscale
        with Image.open(source_path) as img:
            img.load()
            work = img
            # Chặn OOM: model x4 → ảnh vào quá lớn sẽ ra ảnh khổng lồ (RAM + thời gian
            # phi thực tế). Giới hạn cạnh vào 2000px (ra 8000px) — quá ngưỡng in thường.
            MAX_SIDE = 2000
            if max(work.size) > MAX_SIDE:
                ratio = MAX_SIDE / float(max(work.size))
                work = work.resize((max(1, int(work.width * ratio)), max(1, int(work.height * ratio))), Image.LANCZOS)
            result_img = _upscale(work, variant=variant)
            result_img.save(output_path, format="PNG")

    try:
        await run_in_threadpool(_process_upscale)
        return FileResponse(
            path=output_path,
            filename=f"upscaled_{file.filename.split('.')[0]}.png" if file and file.filename else f"upscaled_{job_id}.png",
            media_type="image/png",
        )
    except Exception as e:
        logger.error("upscale thất bại: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Phóng to ảnh thất bại ({type(e).__name__})")
    finally:
        if is_temp:
            try: os.remove(source_path)
            except OSError: pass


@router.post("/upscale/warmup", dependencies=[Depends(require_feature("util.upscale"))])
async def upscale_warmup(engine: str = Form("general")):
    """Nạp sẵn model upscale (chạy nền) để lần bấm đầu không phải chờ cold-start."""
    from fastapi.concurrency import run_in_threadpool
    from app.workers.realesrgan_engine import warmup
    ok = await run_in_threadpool(warmup, "general")
    return {"ok": bool(ok)}
