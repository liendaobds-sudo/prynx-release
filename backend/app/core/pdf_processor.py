"""
PDF Processor — Convert PDF pages to images using pdf2image (Poppler)
and extract metadata using pypdf + pdfplumber.

Algorithm reference: Formartha/compare-pdf (_convert_to_opencv)
License: All MIT/BSD — commercially safe.
"""
import logging
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pypdfium2 as pdfium
from pypdf import PdfReader
from PIL import Image
import pdfplumber

from app.config import settings

logger = logging.getLogger(__name__)


class PDFProcessor:
    """Convert PDF pages to images using pypdfium2 and extract metadata."""

    def __init__(self):
        # pypdfium2 is self-contained via C++ wheels, no poppler paths needed!
        pass

    def convert_to_images(
        self,
        pdf_path: str,
        dpi: int = 300,
        first_page: int | None = None,
        last_page: int | None = None,
    ) -> list[np.ndarray]:
        """
        Convert PDF pages to RGB numpy arrays.
        Uses pypdfium2 (PDFium C++ core) - Apache-2.0 / BSD 3-Clause.
        Incredibly fast and commercially safe.
        """
        logger.info(f"Converting PDF to images: {pdf_path} @ {dpi} DPI")

        # KIENTRUC (audit 2026-07-29 §C.1): khóa THEO TỪNG TRANG. `np.array(...)` copy
        # pixel ra khỏi bộ đệm bitmap nên phải nằm trong khóa; phần so ảnh phía sau thì
        # không. So sánh nhiều trang mà giữ khóa cả lượt sẽ chặn mọi preview khác.
        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_processor_open_rgb"):
            pdf = pdfium.PdfDocument(pdf_path)
            n_pages = len(pdf)

        start_idx = 0 if first_page is None else max(0, first_page - 1)
        end_idx = n_pages if last_page is None else min(n_pages, last_page)

        scale = dpi / 72.0

        def render_page(i):
            with pdfium_guard("pdf_processor_render_rgb"):
                # KIENTRUC (audit 2026-08-13 §P25.1): đóng page/bitmap TƯỜNG MINH
                # ngay trong khóa. Nếu để GC dọn, finalizer của pypdfium2 có thể
                # chạy trên thread khác NGOÀI pdfium_guard → access violation.
                page = pdf[i]
                try:
                    # rev_byteorder=True ensures RGB output format instead of default BGR
                    bitmap = page.render(scale=scale, rev_byteorder=True)
                    try:
                        pil_img = bitmap.to_pil()
                        # Ensure it is standard 3-channel RGB for OpenCV compatibility
                        # (np.array COPY dữ liệu nên đóng bitmap sau đó là an toàn)
                        return np.array(pil_img.convert("RGB"))
                    finally:
                        bitmap.close()
                finally:
                    page.close()

        try:
            images = [render_page(i) for i in range(start_idx, end_idx)]
        finally:
            with pdfium_guard("pdf_processor_close_rgb"):
                pdf.close()

        logger.info(f"Converted {len(images)} pages")
        return images

    def convert_to_cmyk_images(
        self,
        pdf_path: str,
        dpi: int = 300,
    ) -> list[np.ndarray]:
        """
        Convert PDF pages preserving CMYK color space.
        Uses PDFium and Pillow for CMYK handling.
        """
        logger.info(f"Converting PDF to CMYK images: {pdf_path} @ {dpi} DPI")

        # KIENTRUC (audit 2026-07-29 §C.1): khóa theo từng trang, như convert_to_images.
        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_processor_open_cmyk"):
            pdf = pdfium.PdfDocument(pdf_path)
            n_pages = len(pdf)
        scale = dpi / 72.0

        def render_page_cmyk(i):
            with pdfium_guard("pdf_processor_render_cmyk"):
                # KIENTRUC (audit 2026-08-13 §P25.1): đóng tường minh trong khóa,
                # không để finalizer GC chạy ngoài pdfium_guard (xem render_page).
                page = pdf[i]
                try:
                    bitmap = page.render(scale=scale, rev_byteorder=True)
                    try:
                        pil_img = bitmap.to_pil()
                        if pil_img.mode != "CMYK":
                            pil_img = pil_img.convert("CMYK")
                        return np.array(pil_img)  # Shape: (H, W, 4)
                    finally:
                        bitmap.close()
                finally:
                    page.close()

        try:
            cmyk_images = [render_page_cmyk(i) for i in range(n_pages)]
        finally:
            with pdfium_guard("pdf_processor_close_cmyk"):
                pdf.close()

        logger.info(f"Converted {len(cmyk_images)} CMYK pages")
        return cmyk_images

    def open_document(self, pdf_path: str, dpi: int = 300) -> "PDFDocumentReader":
        """
        Open a PDF for efficient page-by-page reading.
        Usage:
            with processor.open_document("file.pdf", dpi=300) as doc:
                for i in range(doc.page_count):
                    img = doc.render_page(i)  # numpy RGB array
                    process(img)
                    # img is freed when overwritten or goes out of scope
        """
        return PDFDocumentReader(pdf_path, dpi)

    def convert_single_page(
        self, pdf_path: str, page_num: int, dpi: int = 300
    ) -> np.ndarray:
        """Extract a single page as RGB numpy array."""
        images = self.convert_to_images(
            pdf_path, dpi=dpi, first_page=page_num, last_page=page_num
        )
        return images[0] if images else None

    def get_metadata(self, pdf_path: str) -> dict:
        """
        Extract PDF metadata using pypdf (BSD license).
        Returns page_count, page_sizes, creator, producer, etc.
        """
        reader = PdfReader(pdf_path)
        meta = reader.metadata or {}

        pages_info = []
        for i, page in enumerate(reader.pages):
            box = page.mediabox
            pages_info.append({
                "page_number": i + 1,
                "width_pt": float(box.width),
                "height_pt": float(box.height),
                "width_mm": round(float(box.width) * 25.4 / 72, 1),
                "height_mm": round(float(box.height) * 25.4 / 72, 1),
            })

        color_space = None
        try:
            import pikepdf
            with pikepdf.open(pdf_path) as pike_pdf:
                cmyk = 0
                rgb = 0
                
                # Check OutputIntents
                if "/Root" in pike_pdf.trailer and "/OutputIntents" in pike_pdf.trailer.Root:
                    for intent in pike_pdf.trailer.Root.OutputIntents:
                        val = str(intent.get("/OutputConditionIdentifier", "")).upper()
                        if "CMYK" in val or "FOGRA" in val or "SWOP" in val:
                            color_space = "CMYK"
                            break
                        if "RGB" in val:
                            color_space = "RGB"
                            break
                
                if not color_space:
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

                    pages_to_scan = min(len(pike_pdf.pages), 50)
                    for i in range(pages_to_scan):
                        page = pike_pdf.pages[i]
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
                        
                        if cmyk > 5:
                            color_space = "CMYK"
                            break
                        if rgb > 5:
                            color_space = "RGB"
                            break
                    
                    if not color_space and cmyk == 0 and rgb == 0:
                        import re
                        for i in range(pages_to_scan):
                            try:
                                page = pike_pdf.pages[i]
                                contents = b""
                                if "/Contents" in page:
                                    c = page.Contents
                                    if isinstance(c, pikepdf.Array):
                                        for stream in c:
                                            contents += stream.read_bytes()
                                    else:
                                        contents = c.read_bytes()
                                if re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[kK](?:\s|$)', contents):
                                    cmyk += 1
                                elif re.search(b'(?:\s|^)[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[rgRG](?:\s|$)', contents):
                                    rgb += 1
                            except Exception:
                                pass
                    
                    if not color_space:
                        if cmyk > rgb: color_space = "CMYK"
                        elif rgb > cmyk: color_space = "RGB"
        except Exception as e:
            logger.warning(f"Failed to detect color space via pikepdf: {e}")

        return {
            "page_count": len(reader.pages),
            "pages": pages_info,
            "creator": str(meta.get("/Creator", "")),
            "producer": str(meta.get("/Producer", "")),
            "title": str(meta.get("/Title", "")),
            "color_space": color_space,
        }

    def extract_text_blocks(self, pdf_path: str, page_num: int) -> list[dict]:
        """
        Extract text with positions using pdfplumber (MIT license).
        Each block: {text, x0, y0, x1, y1, fontname, size}

        Reference: pdf-diff uses Poppler pdftotext -bbox,
        we use pdfplumber for better Python integration.
        """
        with pdfplumber.open(pdf_path) as pdf:
            if page_num < 1 or page_num > len(pdf.pages):
                return []

            page = pdf.pages[page_num - 1]
            words = page.extract_words(
                keep_blank_chars=True,
                extra_attrs=["fontname", "size"],
            )

            blocks = []
            for w in words:
                blocks.append({
                    "text": w.get("text", ""),
                    "x0": float(w.get("x0", 0)),
                    "y0": float(w.get("top", 0)),
                    "x1": float(w.get("x1", 0)),
                    "y1": float(w.get("bottom", 0)),
                    "fontname": w.get("fontname", ""),
                    "size": float(w.get("size", 0)),
                })
            return blocks

    def get_page_count(self, pdf_path: str) -> int:
        """Quick page count without full metadata extraction."""
        reader = PdfReader(pdf_path)
        return len(reader.pages)
    def get_trim_insets(self, pdf_path: str) -> list[tuple[float, float, float, float] | None]:
        """Return per-page TrimBox insets relative to the rendered CropBox.

        Values are fractions in rendered-image order: left, top, right, bottom.
        ``None`` means the PDF does not define a smaller TrimBox. The compare
        pipeline uses these insets only for source-page to imposed-sheet checks,
        where bleed outside TrimBox must not be reported as an artwork change.
        """
        reader = PdfReader(pdf_path)
        result: list[tuple[float, float, float, float] | None] = []

        for page in reader.pages:
            try:
                # An absent TrimBox inherits CropBox in PDF. Treat that as
                # unknown rather than inventing a bleed amount.
                if page.get("/TrimBox") is None:
                    result.append(None)
                    continue

                crop = page.cropbox
                trim = page.trimbox
                cw = float(crop.right) - float(crop.left)
                ch = float(crop.top) - float(crop.bottom)
                if cw <= 0 or ch <= 0:
                    result.append(None)
                    continue

                left = max(0.0, (float(trim.left) - float(crop.left)) / cw)
                right = max(0.0, (float(crop.right) - float(trim.right)) / cw)
                top = max(0.0, (float(crop.top) - float(trim.top)) / ch)
                bottom = max(0.0, (float(trim.bottom) - float(crop.bottom)) / ch)

                # pypdfium renders after applying /Rotate, so rotate the inset
                # tuple into the same top-left image coordinate system.
                rotation = int(page.get("/Rotate", 0) or 0) % 360
                if rotation == 90:
                    left, top, right, bottom = bottom, left, top, right
                elif rotation == 180:
                    left, top, right, bottom = right, bottom, left, top
                elif rotation == 270:
                    left, top, right, bottom = top, right, bottom, left

                insets = tuple(min(0.45, value) for value in (left, top, right, bottom))
                result.append(insets if max(insets) > 1e-4 else None)
            except Exception as exc:
                logger.warning("Could not read TrimBox for compare: %s", exc)
                result.append(None)

        return result


class PDFDocumentReader:
    """
    Context manager for efficient page-by-page PDF reading.
    Opens the PDF once, renders pages on demand, closes on exit.
    
    Memory-efficient: only 1 page image exists in RAM at a time
    (the caller controls the lifecycle of returned numpy arrays).
    """

    def __init__(self, pdf_path: str, dpi: int = 300):
        self.pdf_path = pdf_path
        self.dpi = dpi
        self.scale = dpi / 72.0
        self._pdf = None

    def __enter__(self):
        # KIENTRUC (audit 2026-07-29 §C.1): mở/đóng tài liệu và mỗi lần render đều nằm
        # trong `pdfium_guard`. Reader này được dùng cho so sánh trang-theo-trang, có thể
        # chạy trong thread cùng lúc với preview của tab khác.
        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_reader_open"):
            self._pdf = pdfium.PdfDocument(self.pdf_path)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        from app.core.pdfium_lock import pdfium_guard

        if self._pdf is not None:
            with pdfium_guard("pdf_reader_close"):
                self._pdf.close()
            self._pdf = None
        return False

    @property
    def page_count(self) -> int:
        return len(self._pdf) if self._pdf else 0
    def page_size(self, page_index: int) -> tuple[float, float]:
        """Return rendered page width/height in PDF points without rasterizing."""
        if self._pdf is None:
            raise RuntimeError("PDFDocumentReader is not open. Use 'with' statement.")
        # KIENTRUC (audit 2026-08-13 §P25.1): get_size() vẫn là lời gọi PDFium —
        # reader này chạy trong thread so sánh nên phải nằm trong pdfium_guard
        # như mọi lời gọi khác của class (trước đây bị sót).
        if page_index < 0 or page_index >= len(self._pdf):
            raise IndexError(f"Page index {page_index} out of range (0-{len(self._pdf)-1})")
        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_reader_page_size"):
            page = self._pdf[page_index]
            try:
                width, height = page.get_size()
            finally:
                page.close()
        return float(width), float(height)

    def render_page(self, page_index: int) -> np.ndarray:
        """Render a single page (0-indexed) to RGB numpy array."""
        if self._pdf is None:
            raise RuntimeError("PDFDocumentReader is not open. Use 'with' statement.")
        if page_index < 0 or page_index >= len(self._pdf):
            raise IndexError(f"Page index {page_index} out of range (0-{len(self._pdf)-1})")

        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_reader_render_rgb"):
            # KIENTRUC (audit 2026-08-13 §P25.1): đóng page/bitmap tường minh trong
            # khóa — reader này chạy song song với pool so-ảnh, GC trên worker
            # thread không được phép còn finalizer PDFium nào để chạy.
            page = self._pdf[page_index]
            try:
                bitmap = page.render(scale=self.scale, rev_byteorder=True)
                try:
                    pil_img = bitmap.to_pil()
                    return np.array(pil_img.convert("RGB"))
                finally:
                    bitmap.close()
            finally:
                page.close()

    def render_page_cmyk(self, page_index: int) -> np.ndarray:
        """Render a single page (0-indexed) to CMYK numpy array."""
        if self._pdf is None:
            raise RuntimeError("PDFDocumentReader is not open. Use 'with' statement.")
        if page_index < 0 or page_index >= len(self._pdf):
            raise IndexError(f"Page index {page_index} out of range (0-{len(self._pdf)-1})")

        from app.core.pdfium_lock import pdfium_guard

        with pdfium_guard("pdf_reader_render_cmyk"):
            page = self._pdf[page_index]
            try:
                bitmap = page.render(scale=self.scale, rev_byteorder=True)
                try:
                    pil_img = bitmap.to_pil()
                    if pil_img.mode != "CMYK":
                        pil_img = pil_img.convert("CMYK")
                    return np.array(pil_img)  # Shape: (H, W, 4)
                finally:
                    bitmap.close()
            finally:
                page.close()
