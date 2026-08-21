"""
export.py — Xuất trang PDF ra ảnh (PNG/JPEG/TIFF) — tương tự Acrobat "Export To > Image".

Phase 1: render trang bằng pypdfium2 → Pillow → ghi ra thư mục người dùng chọn.
CHỈ ĐỌC file nguồn (render), KHÔNG ghi đè/sửa file gốc (đúng invariant an toàn màu).
"""
import os
import asyncio
import logging
import re
import tempfile
import threading
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from app.core.heavy_job_scheduler import run_scheduled_in_threadpool

from app.core.license_guard import require_license
from app.schemas.export import ExportImagesResponse
from app.utils.errors import raise_http

logger = logging.getLogger(__name__)

# KIENTRUC (audit 2026-07-29 §A.2 lô 13): model đã gom về app/schemas/export.py;
# import lại ở đây để mọi đường import cũ (kể cả test) vẫn dùng được.
from app.schemas.export import (  # noqa: F401
    ExportImageBatchJob,
    ExportImagesBatchRequest,
    ExportImagesRequest,
)


router = APIRouter(prefix="/export", tags=["Export"], dependencies=[Depends(require_license)])

# Giới hạn an toàn
_MIN_DPI = 36
_MAX_DPI = 1200
_FORMATS = {"png", "jpeg", "tiff", "webp"}
_EXT = {"png": "png", "jpeg": "jpg", "tiff": "tiff", "webp": "webp"}
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_OUTPUT_RESERVATION_LOCK = threading.Lock()
_RESERVED_OUTPUT_PATHS: set[str] = set()


# ── ICC profile helpers (audit 2026-07-30 §IMG-01 lô 3) ──────────────────────
# ICC bundle đã được kiểm tra danh tính; LittleCMS vẫn là nguồn tạo fallback
# xác định để đường xuất ảnh không phụ thuộc profile hệ điều hành.
# Cache module-level: tạo một lần, dùng lại mãi.

_SRGB_ICC_BYTES: bytes | None = None
_GRAY_ICC_BYTES: bytes | None = None


def _get_srgb_icc_bytes() -> bytes:
    """sRGB IEC61966-2.1 profile bytes (LittleCMS qua Pillow)."""
    global _SRGB_ICC_BYTES
    if _SRGB_ICC_BYTES is None:
        from PIL import ImageCms
        # Pattern chuẩn giống sticker_engine: createProfile → tobytes
        cms_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
        _SRGB_ICC_BYTES = cms_profile.tobytes()
    return _SRGB_ICC_BYTES


def _get_gray_icc_bytes() -> bytes:
    """Gray Gamma 2.2 profile bytes (ICC v2 minimal, D50 illuminant).

    Pillow ``createProfile`` chỉ hỗ trợ LAB/XYZ/sRGB — phải dựng ICC v2
    thủ công (``desc`` + ``wtpt`` + ``kTRC`` gamma 2.2). Profile này tương
    đương "Gray Gamma 2.2" trong Photoshop/Acrobat.
    """
    global _GRAY_ICC_BYTES
    if _GRAY_ICC_BYTES is not None:
        return _GRAY_ICC_BYTES
    import struct

    tags: dict[bytes, bytes] = {}
    # desc — mô tả profile
    desc_text = b"Gray Gamma 2.2\x00"
    desc = b"desc" + struct.pack(">II", 0, len(desc_text)) + desc_text
    desc += b"\x00" * (4 - len(desc) % 4) if len(desc) % 4 else b""
    tags[b"desc"] = desc
    # wtpt — điểm trắng D50 (PCS illuminant chuẩn ICC v2)
    tags[b"wtpt"] = (b"XYZ " + struct.pack(">I", 0)
                     + struct.pack(">iii", 63190, 65536, 54435))  # 0.9642, 1.0, 0.8249
    # kTRC — gamma 2.2 dạng curve với 1 entry (gamma fixed-point u8Fixed8)
    tags[b"kTRC"] = b"curv" + struct.pack(">IIH", 0, 1, int(2.2 * 256))

    n_tags = len(tags)
    tag_table_size = 4 + 12 * n_tags
    data_start = 128 + tag_table_size

    tag_data = b""
    tag_entries = b""
    offset = data_start
    for sig, data in tags.items():
        pad = (4 - len(data) % 4) % 4
        tag_entries += sig + struct.pack(">II", offset, len(data))
        tag_data += data + b"\x00" * pad
        offset += len(data) + pad

    total = 128 + tag_table_size + len(tag_data)

    header = struct.pack(">I", total)
    header += b"none"                                   # preferred CMM
    header += struct.pack(">I", 0x02400000)             # version 2.4
    header += b"mntr"                                   # device class
    header += b"GRAY"                                   # data color space
    header += b"XYZ "                                   # PCS
    header += struct.pack(">6H", 2026, 7, 30, 0, 0, 0) # date/time
    header += b"acsp"                                   # file signature
    header += b"MSFT"                                   # primary platform
    header += b"\x00" * 4                               # flags
    header += b"\x00" * 4                               # device manufacturer
    header += b"\x00" * 4                               # device model
    header += b"\x00" * 8                               # device attributes
    header += struct.pack(">I", 0)                      # rendering intent
    header += struct.pack(">iii", 63190, 65536, 54435)  # PCS illuminant D50
    header += b"\x00" * 4                               # profile creator
    header += b"\x00" * 16                              # profile ID
    header = header.ljust(128, b"\x00")

    tag_table = struct.pack(">I", n_tags) + tag_entries
    _GRAY_ICC_BYTES = header + tag_table + tag_data
    return _GRAY_ICC_BYTES


def _sanitize_base_name(value: Optional[str], fallback: str) -> str:
    """Chuẩn hóa tên file, không cho ``base_name`` tạo đường dẫn ngoài thư mục đích."""
    raw = os.path.basename((value or "").strip())
    cleaned = _INVALID_FILENAME_CHARS.sub("_", raw).strip(" .")
    if not cleaned:
        cleaned = _INVALID_FILENAME_CHARS.sub("_", fallback).strip(" .") or "page"
    if cleaned.upper() in _WINDOWS_RESERVED_NAMES:
        cleaned = f"{cleaned}_"
    return cleaned[:180]


def _reserve_output_path(output_dir: str, filename: str) -> str:
    """Giữ một tên chưa tồn tại để các job trong cùng sidecar không ghi đè nhau."""
    root = os.path.abspath(output_dir)
    stem, suffix = os.path.splitext(filename)
    attempt = 0
    with _OUTPUT_RESERVATION_LOCK:
        while True:
            candidate_name = filename if attempt == 0 else f"{stem}_{attempt + 1}{suffix}"
            candidate = os.path.abspath(os.path.join(root, candidate_name))
            if os.path.commonpath((root, candidate)) != root:
                raise ValueError("Tên file xuất không hợp lệ.")
            key = os.path.normcase(candidate)
            if key not in _RESERVED_OUTPUT_PATHS and not os.path.exists(candidate):
                _RESERVED_OUTPUT_PATHS.add(key)
                return candidate
            attempt += 1


def _release_output_path(path: str) -> None:
    with _OUTPUT_RESERVATION_LOCK:
        _RESERVED_OUTPUT_PATHS.discard(os.path.normcase(os.path.abspath(path)))


def _new_temp_path(output_dir: str, suffix: str) -> str:
    fd, path = tempfile.mkstemp(prefix=".prynx-export-", suffix=f"{suffix}.tmp", dir=output_dir)
    os.close(fd)
    return path


def _save_image_atomic(img, out_path: str, fmt: str, **save_kwargs) -> None:
    """Ghi ảnh hoàn chỉnh vào file tạm rồi mới công bố tên cuối."""
    temp_path = _new_temp_path(os.path.dirname(out_path), os.path.splitext(out_path)[1])
    try:
        img.save(temp_path, format=fmt, **save_kwargs)
        os.replace(temp_path, out_path)
    finally:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        finally:
            _release_output_path(out_path)



class ExportCancelled(Exception):
    """Job xuất ảnh bị hủy bởi client."""


async def _watch_export_disconnect(request: Request, cancel_event: threading.Event) -> None:
    """Bật cờ hủy khi ASGI báo client đã ngắt kết nối."""
    while not cancel_event.is_set():
        if await request.is_disconnected():
            # EXPORT (re-audit 2026-07-31 §RA-03): threadpool không tự dừng khi
            # fetch bị abort; event là cầu nối cooperative cancellation tới worker.
            cancel_event.set()
            return
        await asyncio.sleep(0.1)



# ── CMYK production helpers (audit 2026-07-30 §IMG-04 lô 4) ──────────────────

_CMYK_ICC_BYTES: bytes | None = None


def _get_cmyk_icc_bytes(profile_id: str = "fogra39") -> bytes:
    """Đọc profile CMYK bundle (FOGRA39 mặc định) ra bytes để nhúng vào output."""
    global _CMYK_ICC_BYTES
    if _CMYK_ICC_BYTES is not None:
        return _CMYK_ICC_BYTES
    from app.core.icc_profiles import resolve_cmyk_profile_path
    path = resolve_cmyk_profile_path(profile_id)
    if not path:
        raise FileNotFoundError(f"Không tìm được profile CMYK '{profile_id}'")
    with open(path, "rb") as f:
        _CMYK_ICC_BYTES = f.read()
    return _CMYK_ICC_BYTES


def _render_cmyk_pages(
    src_path: str,
    output_dir: str,
    fmt: str,
    dpi: int,
    pages: Optional[List[int]],
    multipage_tiff: bool,
    jpeg_quality: int,
    base_name: Optional[str],
    cancel_event: Optional[threading.Event],
    include_bleed: bool,
) -> List[str]:
    """Render CMYK production bằng PPE ink-space — KHÔNG đi qua RGB.

    PPE render trong không gian mực, gộp spot, trả CMYK 4 kênh. Caller nhúng
    profile ICC (FOGRA39 mặc định) khi ghi TIFF/JPEG.
    """
    from PIL import Image
    from app.core.print_engine.facade import export_cmyk as ppe_export_cmyk

    ext = _EXT[fmt]
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    source_base = os.path.splitext(os.path.basename(src_path))[0]
    base_nm = _sanitize_base_name(base_name, source_base)
    icc_bytes = _get_cmyk_icc_bytes()

    # Đếm tổng trang bằng pypdfium2 (nhẹ, chỉ mở header)
    import pypdfium2 as pdfium
    from app.core.pdfium_lock import pdfium_guard
    with pdfium_guard("export_cmyk_count"):
        pdf = pdfium.PdfDocument(src_path)
        n = len(pdf)
        pdf.close()

    page_nos = pages if pages else list(range(1, n + 1))
    seen: set[int] = set()
    valid_nos = [pno for pno in page_nos if 1 <= pno <= n and pno not in seen and not seen.add(pno)]  # type: ignore[func-returns-value]
    if not valid_nos:
        raise ValueError("Không có trang hợp lệ để xuất.")

    pad = max(2, len(str(n)))
    written: List[str] = []
    page_box = "media" if include_bleed else "trim"

    def render_page(pno: int):
        result = ppe_export_cmyk(src_path, pno, dpi=dpi, page_box=page_box)
        # EXPORT (re-audit 2026-07-31 §RA-02): output chế bản không được phép
        # âm thầm giao trang mà PPE đã đánh dấu thiếu mực hoặc sai hình học.
        if result.get("ink_unsound"):
            raise ValueError(
                f"Trang {pno}: PPE không thể dựng đủ nội dung/mực; đã dừng xuất CMYK."
            )
        if result.get("degraded"):
            raise ValueError(
                f"Trang {pno}: PPE chỉ dựng được hình học xấp xỉ; đã dừng xuất CMYK."
            )
        return result


    try:
        # TIFF multipage
        if fmt == "tiff" and multipage_tiff:
            from PIL.TiffImagePlugin import AppendingTiffWriter
            multipage_path = _reserve_output_path(output_dir, f"{base_nm}.tiff")
            multipage_temp = _new_temp_path(output_dir, ".tiff")
            writer = AppendingTiffWriter(multipage_temp, True)
            try:
                for page_index, pno in enumerate(valid_nos):
                    if cancel_event is not None and cancel_event.is_set():
                        raise ExportCancelled("Xuất ảnh bị hủy.")
                    result = render_page(pno)
                    img = Image.frombytes("CMYK", (result["width"], result["height"]), bytes(result["cmyk"]))
                    img.save(
                        writer, format="TIFF", compression="tiff_deflate",
                        dpi=(dpi, dpi), icc_profile=icc_bytes,
                    )
                    if page_index < len(valid_nos) - 1:
                        writer.newFrame()
                    img.close()
                writer.close()
                os.replace(multipage_temp, multipage_path)
                written.append(multipage_path)
            finally:
                if os.path.exists(multipage_temp):
                    try:
                        os.remove(multipage_temp)
                    except OSError:
                        pass
                _release_output_path(multipage_path)
            return written

        # Single-page files
        for pno in valid_nos:
            if cancel_event is not None and cancel_event.is_set():
                raise ExportCancelled("Xuất ảnh bị hủy.")
            result = render_page(pno)
            img = Image.frombytes("CMYK", (result["width"], result["height"]), bytes(result["cmyk"]))
            fname = f"{base_nm}_p{str(pno).zfill(pad)}.{ext}"
            out_path = _reserve_output_path(output_dir, fname)
            try:
                if fmt == "jpeg":
                    _save_image_atomic(
                        img, out_path, "JPEG", quality=jpeg_quality,
                        dpi=(dpi, dpi), icc_profile=icc_bytes,
                    )
                else:
                    _save_image_atomic(
                        img, out_path, "TIFF", compression="tiff_deflate",
                        dpi=(dpi, dpi), icc_profile=icc_bytes,
                    )
                written.append(out_path)
            finally:
                img.close()

    except BaseException:
        for path in written:
            try:
                os.remove(path)
            except OSError:
                logger.warning("Không rollback được file xuất CMYK: %s", path)
        raise

    return written


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
    cancel_event: Optional[threading.Event] = None,
    include_bleed: bool = True,
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
    if color_mode not in ("rgb", "gray", "cmyk"):
        raise ValueError(f"color_mode không hợp lệ: {color_mode}")
    # EXPORT (audit 2026-07-30 §IMG-04 lô 4): PNG không hỗ trợ CMYK 4 kênh.
    if color_mode == "cmyk" and fmt in ("png", "webp"):
        raise ValueError("PNG/WebP không hỗ trợ CMYK. Dùng TIFF hoặc JPEG.")
    if not src_path or not os.path.exists(src_path):
        raise FileNotFoundError(f"File nguồn không tồn tại: {src_path}")

    # EXPORT (audit 2026-07-30 §IMG-08 lô 3): không còn clamp âm thầm — Pydantic
    # schema đã reject ngoài range. Giữ cast int cho an toàn khi gọi trực tiếp.
    dpi = int(dpi)
    jpeg_quality = int(jpeg_quality)
    scale = dpi / 72.0

    # EXPORT (audit 2026-07-30 §IMG-04 lô 4): CMYK dùng đường riêng (PPE ink-space).
    if color_mode == "cmyk":
        return _render_cmyk_pages(
            src_path, output_dir, fmt, dpi, pages, multipage_tiff,
            jpeg_quality, base_name, cancel_event, include_bleed,
        )

    pil_mode = "L" if color_mode == "gray" else "RGB"
    ext = _EXT[fmt]
    # EXPORT (audit 2026-07-30 §IMG-01 lô 3): gắn ICC profile đúng vào output
    icc_bytes = _get_gray_icc_bytes() if color_mode == "gray" else _get_srgb_icc_bytes()

    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    source_base = os.path.splitext(os.path.basename(src_path))[0]
    base = _sanitize_base_name(base_name, source_base)

    # KIENTRUC (audit 2026-07-29 §C.1): khóa THEO TỪNG TRANG, không bao cả job — xuất
    # 200 trang ở 600 DPI mà giữ khóa cả lượt sẽ chặn mọi preview khác. `.convert()`
    # trả ảnh MỚI (đã tách khỏi bộ đệm bitmap) nên ghi file làm được ngoài khóa.
    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard("export_images_open"):
        pdf = pdfium.PdfDocument(src_path)
        _n_pages = len(pdf)
    written: List[str] = []
    try:
        n = _n_pages
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

        pad = max(2, len(str(n)))
        multipage_writer = None
        multipage_temp = None
        multipage_path = None
        if fmt == "tiff" and multipage_tiff:
            # PERF (audit 2026-07-30 §IMG-03): giữ khoảng một trang trong RAM
            # thay vì giữ toàn bộ tài liệu trong ``frames[]``.
            from PIL.TiffImagePlugin import AppendingTiffWriter

            multipage_path = _reserve_output_path(output_dir, f"{base}.tiff")
            multipage_temp = _new_temp_path(output_dir, ".tiff")
            multipage_writer = AppendingTiffWriter(multipage_temp, True)

        try:
            for page_index, pno in enumerate(valid_nos):
                # EXPORT (audit 2026-07-30 §IMG-06): hủy sớm khi client disconnect
                if cancel_event is not None and cancel_event.is_set():
                    raise ExportCancelled("Xuất ảnh bị hủy.")
                page = None
                bitmap = None
                original_crop = None
                with pdfium_guard("export_images_page"):
                    try:
                        page = pdf[pno - 1]
                        # EXPORT (re-audit 2026-07-31 §RA-01): PDFium render theo
                        # CropBox hiệu lực. Tạm đặt CropBox thành box người dùng chọn
                        # trong RAM rồi khôi phục trước khi nhả khóa.
                        original_crop = page.get_cropbox()
                        if include_bleed:
                            target_box = page.get_mediabox()
                        else:
                            try:
                                target_box = page.get_trimbox()
                            except Exception:
                                target_box = original_crop
                        page.set_cropbox(*target_box)
                        bitmap = page.render(scale=scale, rotation=0)
                        # ``convert`` tạo buffer độc lập; đóng handle ngay trong khóa.
                        img = bitmap.to_pil().convert(pil_mode)
                    finally:
                        if page is not None and original_crop is not None:
                            page.set_cropbox(*original_crop)
                        if bitmap is not None:
                            bitmap.close()
                        if page is not None:
                            page.close()

                try:
                    if multipage_writer is not None:
                        img.save(
                            multipage_writer,
                            format="TIFF",
                            compression="tiff_deflate",
                            dpi=(dpi, dpi),
                            icc_profile=icc_bytes,
                        )
                        if page_index < len(valid_nos) - 1:
                            multipage_writer.newFrame()
                        continue

                    fname = f"{base}_p{str(pno).zfill(pad)}.{ext}"
                    out_path = _reserve_output_path(output_dir, fname)
                    if fmt == "jpeg":
                        _save_image_atomic(
                            img, out_path, "JPEG", quality=jpeg_quality,
                            dpi=(dpi, dpi), icc_profile=icc_bytes,
                        )
                    elif fmt == "tiff":
                        _save_image_atomic(
                            img, out_path, "TIFF", compression="tiff_deflate",
                            dpi=(dpi, dpi), icc_profile=icc_bytes,
                        )
                    else:
                        save_fmt = "WEBP" if fmt == "webp" else "PNG"
                        save_kwargs = dict(dpi=(dpi, dpi), icc_profile=icc_bytes)
                        if fmt == "webp":
                            save_kwargs["quality"] = jpeg_quality
                        _save_image_atomic(
                            img, out_path, save_fmt, **save_kwargs,
                        )
                    written.append(out_path)
                finally:
                    img.close()

            if multipage_writer is not None and multipage_path and multipage_temp:
                multipage_writer.close()
                multipage_writer = None
                os.replace(multipage_temp, multipage_path)
                multipage_temp = None
                _release_output_path(multipage_path)
                written.append(multipage_path)
        finally:
            if multipage_writer is not None:
                multipage_writer.close()
            if multipage_temp and os.path.exists(multipage_temp):
                os.remove(multipage_temp)
            if multipage_path:
                _release_output_path(multipage_path)
    except BaseException:
        # EXPORT (audit 2026-07-30 §IMG-05): output luôn dùng tên mới; rollback
        # toàn bộ lượt này để không để lại một bộ trang nửa mới, nửa thiếu.
        for path in written:
            try:
                os.remove(path)
            except OSError:
                logger.warning("Không rollback được file xuất ảnh: %s", path)
        raise
    finally:
        with pdfium_guard("export_images_close"):
            pdf.close()

    return written




@router.post("/images", response_model=ExportImagesResponse)
async def export_images(req: ExportImagesRequest, request: Request):
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

    # EXPORT (audit 2026-07-30 §IMG-06): cancel_event cho phép hủy job giữa chừng
    # khi client disconnect (abort signal). Rollback tự động qua except trong render.
    cancel_event = threading.Event()

    try:
        disconnect_watcher = asyncio.create_task(_watch_export_disconnect(request, cancel_event))
        # PERF (audit 2026-07-30 §IMG-02): export lớn chạy ngoài event loop để
        # health/preview/công cụ khác vẫn phản hồi, nhưng vẫn qua scheduler RAM.
        files = await run_scheduled_in_threadpool(
            "export-images",
            render_pdf_to_images,
            src_path,
            req.output_dir,
            req.format,
            req.dpi,
            req.color_mode,
            req.pages,
            req.multipage_tiff,
            req.jpeg_quality,
            req.base_name,
            cancel_event,
            req.include_bleed,
        )
        return {"ok": True, "count": len(files), "output_dir": req.output_dir, "files": files}
    except ExportCancelled:
        logger.info("Export ảnh: job bị hủy bởi client.")
        raise HTTPException(status_code=499, detail="Xuất ảnh đã bị hủy.")
    except FileNotFoundError as e:
        # Không trả str(e) ra client: chứa đường dẫn nội bộ. Log nội bộ, client nhận generic.
        logger.warning("Export ảnh: không tìm thấy file nguồn: %s", e)
        raise HTTPException(status_code=400, detail="Không tìm thấy file nguồn để xuất.")
    except ValueError as e:
        # Tham số sai (dpi/format/pages...) — message có kiểm soát, an toàn trả ra.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise_http(e, "Xuất ảnh thất bại")
    finally:
        cancel_event.set()
        disconnect_watcher.cancel()
        try:
            await disconnect_watcher
        except asyncio.CancelledError:
            pass



def _render_image_batch(
    src_path: str,
    jobs: List[ExportImageBatchJob],
    color_mode: str,
    pages: Optional[List[int]],
    include_bleed: bool,
    cancel_event: threading.Event,
) -> List[str]:
    """Render batch nguyên tử; lỗi/hủy sẽ xóa mọi file batch đã tạo."""
    written: List[str] = []
    try:
        for job in jobs:
            if cancel_event.is_set():
                raise ExportCancelled("Xuất ảnh bị hủy.")
            files = render_pdf_to_images(
                src_path=src_path,
                output_dir=job.output_dir,
                fmt=job.format,
                dpi=job.dpi,
                color_mode=color_mode,
                pages=pages,
                multipage_tiff=job.multipage_tiff,
                jpeg_quality=job.jpeg_quality,
                base_name=job.base_name,
                cancel_event=cancel_event,
                include_bleed=include_bleed,
            )
            written.extend(files)
        return written
    except BaseException:
        # EXPORT (re-audit 2026-07-31 §RA-06): mỗi renderer rollback job hiện tại;
        # lớp ngoài rollback cả các job trước để người dùng không nhận batch dở dang.
        for path in written:
            try:
                os.remove(path)
            except OSError:
                pass
        raise


@router.post("/images/batch", response_model=ExportImagesResponse)
async def export_images_batch(req: ExportImagesBatchRequest, request: Request):
    """Xuất nhiều định dạng/DPI trong một giao dịch rollback toàn batch."""
    src_path = None
    if req.file_path and os.path.exists(req.file_path):
        src_path = req.file_path
    elif req.file_id:
        from app.api.routes.preflight import _get_file_path
        src_path = _get_file_path(req.file_id)
    if not src_path:
        raise HTTPException(status_code=400, detail="Thiếu file_id/file_path hợp lệ.")

    cancel_event = threading.Event()
    disconnect_watcher = asyncio.create_task(_watch_export_disconnect(request, cancel_event))
    try:
        files = await run_scheduled_in_threadpool(
            "export-images-batch",
            _render_image_batch,
            src_path,
            req.jobs,
            req.color_mode,
            req.pages,
            req.include_bleed,
            cancel_event,
        )
        return {"ok": True, "count": len(files), "output_dir": req.jobs[0].output_dir, "files": files}
    except ExportCancelled:
        raise HTTPException(status_code=499, detail="Xuất ảnh đã bị hủy.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise_http(e, "Xuất batch ảnh thất bại")
    finally:
        cancel_event.set()
        disconnect_watcher.cancel()
        try:
            await disconnect_watcher
        except asyncio.CancelledError:
            pass
