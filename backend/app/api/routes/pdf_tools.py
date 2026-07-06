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
import logging
from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Request, Depends
from fastapi.responses import FileResponse
from typing import List, Optional
import json
from app.core.license_guard import require_license
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pdf-tools", tags=["PDF Tools"], dependencies=[Depends(require_license)])

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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
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
    license_info: dict = Depends(require_license),
):
    """Resize PDF pages to a new format."""
    from app.workers.pdf_tools_engine import resize_pages
    
    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"resized_{job_id}.pdf")
    
    try:
        resize_pages(source_path, output_path, target_w, target_h, scale_mode, apply_to)
        _safe_watermark(output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"resized_{file.filename}",
            media_type="application/pdf"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
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

    # Grayscale conversion
    if do_gray:
        cmd += [
            "-sProcessColorModel=DeviceGray",
            "-sColorConversionStrategy=Gray",
        ]

    # Strip metadata
    if do_strip:
        cmd += ["-dFastWebView=false"]

    cmd += [f"-sOutputFile={output_path}", source_path]

    try:
        def _run_gs():
            return subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=600,  # 10 min max for large files
            )

        result = await asyncio.to_thread(_run_gs)

        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(f"Hệ thống nén báo lỗi nội bộ, không thể xử lý file này.")

        if not os.path.exists(output_path):
            raise RuntimeError("Hệ thống nén không xuất được file kết quả.")

        output_size = os.path.getsize(output_path)
        ratio = round((1 - output_size / original_size) * 100, 1) if original_size > 0 else 0

        # If output is actually larger, just return original
        if output_size >= original_size:
            os.replace(source_path, output_path)
            output_size = original_size
            ratio = 0

        _safe_watermark(output_path, license_info)
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

@router.post("/sticker-dieline")
async def sticker_dieline_endpoint(request: Request, license_info: dict = Depends(require_license)):
    """Generate Cut Contour and Bleed for Stickers."""
    from app.workers.sticker_engine import StickerEngine
    
    form = await request.form()
    
    file_id = form.get("file_id")
    if not file_id:
        raise HTTPException(status_code=400, detail="Missing 'file_id' field. File must be uploaded first.")
        
    # We query the database or just look for the file in UPLOAD_DIR
    from app.config import settings
    # The upload endpoint returns an integer ID, but we need the stored filename.
    # Actually, uploadPDF returns `{ id: db_file.id, filename: stored_name, ... }`.
    # Let's fetch it from DB to get the filename.
    from app.database import SessionLocal
    from app.models.job import UploadedFile as UploadedFileModel
    
    db = SessionLocal()
    try:
        db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == file_id).first()
        if not db_file:
            raise HTTPException(status_code=404, detail="File not found in database.")
        source_path = db_file.file_path
        original_name = db_file.original_name
    finally:
        db.close()

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
            edge_bite_mm=edge_bite_mm
        )
        if not success or not os.path.exists(output_path):
            # success=False kèm meta['error'] = lỗi nghiệp vụ (vd không dò được hình)
            biz_err = meta.get("error") if isinstance(meta, dict) else None
            if biz_err:
                raise HTTPException(status_code=422, detail=biz_err)
            raise RuntimeError("Lỗi lưu file kết quả. (File not found)")

        _safe_watermark(output_path, license_info)

        headers = {}
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
            if "pages" in meta:
                import json
                headers["X-Sticker-Pages"] = json.dumps(meta["pages"])
        if isinstance(meta, dict) and meta.get("warning"):
            import urllib.parse
            # Header value phải ASCII → percent-encode để giữ được tiếng Việt.
            headers["X-Sticker-Warning"] = urllib.parse.quote(meta["warning"])
            
        return FileResponse(
            path=output_path,
            filename=f"dieline_{original_name}",
            media_type="application/pdf",
            headers=headers
        )
    except HTTPException:
        raise
    except Exception as e:
        # Log đầy đủ (kèm [debug_step]) ở server để chẩn đoán; KHÔNG lộ chi tiết
        # nội bộ ra client (tránh rò rỉ thông tin hệ thống).
        logger.error("sticker-dieline thất bại: %s", e, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Lỗi tạo viền bế. Vui lòng thử lại hoặc kiểm tra lại file đầu vào."
        )
    finally:
        try: os.remove(source_path)
        except OSError: pass

@router.post("/remove-background")
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


@router.post("/remove-background/warmup")
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
