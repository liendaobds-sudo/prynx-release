"""Các route đọc/sửa PDF dùng chung cho viewer, tách khỏi god-file imposition."""

from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from typing import BinaryIO

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.heavy_job_scheduler import run_scheduled_in_threadpool
from app.core.imposition_file_access import (
    validate_imposition_pdf_path as _validate_file_path,
)
from app.core.license_guard import require_license
from app.core.pdfium_lock import pdfium_guard
from app.utils.errors import raise_http

router = APIRouter(
    prefix="/imposition",
    tags=["Imposition"],
    dependencies=[Depends(require_license)],
)

_UPLOAD_CHUNK_BYTES = 1024 * 1024


def _copy_upload_file(source: BinaryIO, target_path: str) -> int:
    source.seek(0)
    with open(target_path, "wb") as target:
        shutil.copyfileobj(source, target, length=_UPLOAD_CHUNK_BYTES)
    return os.path.getsize(target_path)


def _cleanup_files(*paths: str) -> None:
    for path in paths:
        if not path:
            continue
        try:
            os.remove(path)
        except OSError:
            pass


def _unlock_pdf_to_path(source_path: str, output_path: str) -> str:
    import pypdfium2 as pdfium

    # KIENTRUC (audit 2026-08-02 §BE.1/BE.2): chỉ phần PDFium nằm trong khóa;
    # upload, kiểm output và FileResponse đều chạy ngoài vùng khóa.
    with pdfium_guard("document_tools_unlock_pdf"):
        pdf = pdfium.PdfDocument(source_path)
        try:
            for page_index in range(len(pdf)):
                page = pdf[page_index]
                try:
                    pdfium.raw.FPDFPage_Flatten(page, 0)
                finally:
                    page.close()
            pdf.save(output_path, flags=3)
        finally:
            pdf.close()

    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 32:
        raise RuntimeError("PDF sau mở khóa không hợp lệ.")
    with open(output_path, "rb") as output_file:
        if output_file.read(5) != b"%PDF-":
            raise RuntimeError("PDF sau mở khóa không có header hợp lệ.")
    return output_path


def _quick_color_space(body: dict):
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
def _get_pdf_layers(body: dict):
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

def _preview_pdf_layers(body: dict):
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

def _get_pdf_text(body: dict):
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

def _get_pdf_meta(body: dict):
    """
    Read PDF metadata (page count, dimensions, rotations) using pypdfium2.

    This allows the TypeScript Planner to get the info it needs for computation
    WITHOUT loading the entire PDF into the Webview's RAM.

    Expects body: {
        "path": "C:/Users/.../catalog.pdf",
        "page_box_policy": "imposition" | "visible"  # tùy chọn
    }
    """
    from app.workers import pdf_wrapper as pdf_lib
    from app.core.imposition_page_box import effective_imposition_box
    from app.workers.mixed_guillotine_adapter import resolve_guillotine_trim

    pdf_path = _validate_file_path(body.get("path"))
    use_visible_page_box = body.get("page_box_policy") == "visible"

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
            user_unit = 1.0
            try:
                if "/UserUnit" in page._page:
                    user_unit = float(page._page["/UserUnit"])
                if not (0 < user_unit <= 75000):
                    user_unit = 1.0
            except (TypeError, ValueError, OverflowError):
                user_unit = 1.0
            # UIUX (audit 2026-08-03 §MG-AUTO): trả đúng footprint mà preview/export
            # Bình cắt xén dùng để frontend phân loại cùng khổ/khác khổ trước khi gọi solver.
            # Bleed không ảnh hưởng phép so sánh vì mọi trang đều trừ cùng một giá trị.
            guillotine_w, guillotine_h = resolve_guillotine_trim(page, 0.0)
            # PAGEBOX (audit 2026-08-04 §W1.PB3): resolver trả tọa độ raw;
            # metadata còn lại đã là point vật lý nên footprint phải cùng hệ.
            guillotine_w *= user_unit
            guillotine_h *= user_unit
            # PAGEBOX (audit 2026-08-04 §W1.PB2): fallback của Viewer phải dùng
            # đúng vùng trang nhìn thấy như PDFium; caller bình bản không truyền
            # policy này nên vẫn giữ nguyên quy tắc MediaBox/CropBox hiện hữu.
            src_box = (
                page.cropbox
                if use_visible_page_box
                else effective_imposition_box(page)
            )
            w = src_box.width
            h = src_box.height
            rot = page.rotation

            # Tự nhận bleed từ metadata file: nếu TrimBox nhỏ hơn MediaBox đối xứng
            # thì khoảng chênh /2 chính là bleed (giống cách Acrobat đọc page boxes).
            if i == 0:
                try:
                    _tb = page.trimbox
                    _mb = page.mediabox
                    _bx = (
                        (float(_mb.width) - float(_tb.width))
                        * user_unit
                        / 2.0
                    )
                    _by = (
                        (float(_mb.height) - float(_tb.height))
                        * user_unit
                        / 2.0
                    )
                    if _bx > 0.5 and _by > 0.5 and abs(_bx - _by) < 3.0:
                        detected_bleed_mm = round(((_bx + _by) / 2.0) * _PT_TO_MM, 2)
                except Exception:
                    detected_bleed_mm = 0.0

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

            # [PREVIEW-UNIT FIX 2026-08-06] Làm tròn 4 số, KHÔNG phải 2.
            # 500mm = 1417.325pt, làm tròn 2 số thành 1417.33 (+0.005pt/cột);
            # ở khổ vừa khít 1500mm phần dư đó vượt dung sai 0.01pt của solver
            # → preview mất hẳn một cột (9 con hiển thị thành 7).
            pages.append({
                "index": i,
                "width_pt": round(visual_w, 4),
                "height_pt": round(visual_h, 4),
                "media_width_pt": round(media_visual_w, 4),
                "media_height_pt": round(media_visual_h, 4),
                "guillotine_width_pt": round(guillotine_w, 4),
                "guillotine_height_pt": round(guillotine_h, 4),
                "rotation": rot,
            })

        pdf.close()

        return {
            "page_count": page_count,
            "max_width_pt": round(max_w, 4),
            "max_height_pt": round(max_h, 4),
            "detected_bleed_mm": detected_bleed_mm,
            "pages": pages,
        }
    except Exception as e:
        raise_http(e, "Đọc metadata PDF thất bại")

@router.post("/quick-color-space")
async def quick_color_space(body: dict):
    return await run_in_threadpool(_quick_color_space, body)


@router.post("/pdf-layers")
async def get_pdf_layers(body: dict):
    return await run_in_threadpool(_get_pdf_layers, body)


@router.post("/pdf-layers/preview")
async def preview_pdf_layers(body: dict):
    return await run_scheduled_in_threadpool(
        "pdf-tools", _preview_pdf_layers, body
    )


@router.post("/pdf-text")
async def get_pdf_text(body: dict):
    return await run_in_threadpool(_get_pdf_text, body)


@router.post("/pdf-meta")
async def get_pdf_meta(body: dict):
    return await run_in_threadpool(_get_pdf_meta, body)


@router.post("/unlock-pdf")
async def unlock_pdf(
    file: UploadFile = File(...),
    _license_info: dict = Depends(require_license),
):
    """Mở khóa/flatten PDF bằng đường file, không giữ toàn bộ input/output trong RAM."""
    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file PDF.")

    token = uuid.uuid4().hex
    source_path = os.path.join(settings.UPLOAD_DIR, f"unlock_{token}.pdf")
    output_path = os.path.join(settings.RESULTS_DIR, f"unlocked_{token}.pdf")
    try:
        size = await asyncio.to_thread(_copy_upload_file, file.file, source_path)
        if size <= 0:
            raise HTTPException(status_code=400, detail="File PDF rỗng. Hãy chọn lại file.")
        await run_scheduled_in_threadpool(
            "pdf-tools", _unlock_pdf_to_path, source_path, output_path
        )
        return FileResponse(
            output_path,
            filename=f"unlocked_{os.path.basename(filename)}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_files, source_path, output_path),
        )
    except HTTPException:
        await asyncio.to_thread(_cleanup_files, source_path, output_path)
        raise
    except Exception as exc:  # noqa: BLE001
        await asyncio.to_thread(_cleanup_files, source_path, output_path)
        raise_http(exc, "Mở khóa PDF thất bại")
