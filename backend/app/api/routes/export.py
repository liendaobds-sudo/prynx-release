"""
export.py — Xuất trang PDF ra ảnh (PNG/JPEG/TIFF) — tương tự Acrobat "Export To > Image".

Phase 1: render trang bằng pypdfium2 → Pillow → ghi ra thư mục người dùng chọn.
CHỈ ĐỌC file nguồn (render), KHÔNG ghi đè/sửa file gốc (đúng invariant an toàn màu).
"""
import os
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.license_guard import require_license

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/export", tags=["Export"], dependencies=[Depends(require_license)])

# Giới hạn an toàn
_MIN_DPI = 36
_MAX_DPI = 1200
_FORMATS = {"png", "jpeg", "tiff"}
_EXT = {"png": "png", "jpeg": "jpg", "tiff": "tiff"}


def render_pdf_to_images(
    src_path: str,
    output_dir: str,
    fmt: str = "png",
    dpi: int = 150,
    color_mode: str = "rgb",
    pages: Optional[List[int]] = None,
    multipage_tiff: bool = False,
    jpeg_quality: int = 90,
    base_name: Optional[str] = None,
) -> List[str]:
    """Render các trang PDF thành ảnh và ghi ra ``output_dir``.

    Args:
        src_path: đường dẫn PDF nguồn (server-accessible).
        output_dir: thư mục đích (tạo nếu chưa có).
        fmt: 'png' | 'jpeg' | 'tiff'.
        dpi: độ phân giải (clamp _MIN_DPI.._MAX_DPI).
        color_mode: 'rgb' | 'gray'.
        pages: danh sách số trang 1-based; None = tất cả.
        multipage_tiff: gộp mọi trang vào 1 file TIFF (chỉ khi fmt='tiff').
        jpeg_quality: chất lượng JPEG (1..100).
        base_name: tên gốc cho file ảnh; None → lấy từ tên PDF.

    Returns:
        Danh sách đường dẫn file ảnh đã ghi.
    """
    import pypdfium2 as pdfium
    from PIL import Image  # noqa: F401  (đảm bảo Pillow sẵn sàng)

    fmt = (fmt or "png").lower()
    if fmt not in _FORMATS:
        raise ValueError(f"Định dạng không hỗ trợ: {fmt}")
    color_mode = (color_mode or "rgb").lower()
    if color_mode not in ("rgb", "gray"):
        raise ValueError(f"color_mode không hợp lệ: {color_mode}")
    if not src_path or not os.path.exists(src_path):
        raise FileNotFoundError(f"File nguồn không tồn tại: {src_path}")

    dpi = max(_MIN_DPI, min(_MAX_DPI, int(dpi)))
    jpeg_quality = max(1, min(100, int(jpeg_quality)))
    scale = dpi / 72.0
    pil_mode = "L" if color_mode == "gray" else "RGB"
    ext = _EXT[fmt]

    os.makedirs(output_dir, exist_ok=True)
    base = base_name or os.path.splitext(os.path.basename(src_path))[0]

    pdf = pdfium.PdfDocument(src_path)
    written: List[str] = []
    try:
        n = len(pdf)
        page_nos = pages if pages else list(range(1, n + 1))
        # Lọc/khử trùng & giữ thứ tự, chỉ giữ trang hợp lệ
        seen = set()
        valid_nos = []
        for pno in page_nos:
            if 1 <= pno <= n and pno not in seen:
                seen.add(pno)
                valid_nos.append(pno)
        if not valid_nos:
            raise ValueError("Không có trang hợp lệ để xuất.")

        frames = []  # cho multipage TIFF
        pad = max(2, len(str(n)))
        for pno in valid_nos:
            page = pdf[pno - 1]
            bitmap = page.render(scale=scale, rotation=0)
            img = bitmap.to_pil().convert(pil_mode)

            if fmt == "tiff" and multipage_tiff:
                frames.append(img)
                continue

            fname = f"{base}_p{str(pno).zfill(pad)}.{ext}"
            out_path = os.path.join(output_dir, fname)
            if fmt == "jpeg":
                img.save(out_path, format="JPEG", quality=jpeg_quality, dpi=(dpi, dpi))
            elif fmt == "tiff":
                img.save(out_path, format="TIFF", dpi=(dpi, dpi))
            else:
                img.save(out_path, format="PNG", dpi=(dpi, dpi))
            written.append(out_path)

        if fmt == "tiff" and multipage_tiff and frames:
            out_path = os.path.join(output_dir, f"{base}.tiff")
            frames[0].save(
                out_path, format="TIFF", save_all=True,
                append_images=frames[1:], dpi=(dpi, dpi),
            )
            written.append(out_path)
    finally:
        pdf.close()

    return written


class ExportImagesRequest(BaseModel):
    file_id: Optional[str] = None
    file_path: Optional[str] = None
    output_dir: str
    format: str = "png"            # png | jpeg | tiff
    dpi: int = 150
    color_mode: str = "rgb"        # rgb | gray
    pages: Optional[List[int]] = None  # 1-based; None = tất cả
    multipage_tiff: bool = False
    jpeg_quality: int = 90
    base_name: Optional[str] = None


@router.post("/images")
async def export_images(req: ExportImagesRequest):
    """Xuất trang PDF ra ảnh. Nhận file_id (đã upload) hoặc file_path (desktop)."""
    # Resolve nguồn
    src_path = None
    if req.file_path and os.path.exists(req.file_path):
        src_path = req.file_path
    elif req.file_id:
        from app.api.routes.preflight import _get_file_path
        src_path = _get_file_path(req.file_id)
    if not src_path:
        raise HTTPException(status_code=400, detail="Thiếu file_id/file_path hợp lệ.")

    if not req.output_dir:
        raise HTTPException(status_code=400, detail="Thiếu thư mục đích (output_dir).")

    try:
        files = render_pdf_to_images(
            src_path=src_path,
            output_dir=req.output_dir,
            fmt=req.format,
            dpi=req.dpi,
            color_mode=req.color_mode,
            pages=req.pages,
            multipage_tiff=req.multipage_tiff,
            jpeg_quality=req.jpeg_quality,
            base_name=req.base_name,
        )
        return {"ok": True, "count": len(files), "output_dir": req.output_dir, "files": files}
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Lỗi khi xuất ảnh")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")
