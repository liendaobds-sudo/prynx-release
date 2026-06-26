"""
Page Boxes Engine — Quản lý khổ trang PDF (MediaBox, CropBox, TrimBox, BleedBox, ArtBox).

Chức năng tương đương Acrobat Pro → Print Production → Set Page Boxes.
"""
import logging
import uuid
from pathlib import Path

import numpy as np
import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)

# 1 pt = 1/72 inch, 1 inch = 25.4 mm
PT_PER_MM = 72 / 25.4


def _pike_box_to_list(box):
    """Convert a pikepdf Array box to [x0, y0, x1, y1] floats."""
    return [float(box[0]), float(box[1]), float(box[2]), float(box[3])]


def _box_to_mm(box_list: list) -> dict:
    """Convert box [x0, y0, x1, y1] in points to mm dict."""
    x0, y0, x1, y1 = box_list
    return {
        "x0": round(x0 / PT_PER_MM, 2),
        "y0": round(y0 / PT_PER_MM, 2),
        "x1": round(x1 / PT_PER_MM, 2),
        "y1": round(y1 / PT_PER_MM, 2),
        "width": round((x1 - x0) / PT_PER_MM, 2),
        "height": round((y1 - y0) / PT_PER_MM, 2),
    }


def _get_page_box(page, box_name: str, fallback=None):
    """Get a page box, resolving inheritance from parent."""
    box = page.get(box_name)
    if box is not None:
        return _pike_box_to_list(box)
    # Fallback to MediaBox if not explicitly set
    if fallback is not None:
        return fallback
    mb = page.get("/MediaBox")
    if mb is not None:
        return _pike_box_to_list(mb)
    return [0, 0, 595, 842]  # A4 default


class PageBoxesEngine:

    def __init__(self):
        self.output_dir = Path(settings.RESULTS_DIR) / "preflight_output"
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def get_boxes(self, file_path: str, page_num: int) -> dict:
        """
        Trả về thông tin 5 box của 1 trang (mm).
        page_num: 1-indexed.
        """
        doc = pikepdf.Pdf.open(file_path)
        if page_num < 1 or page_num > len(doc.pages):
            doc.close()
            raise ValueError(f"Trang {page_num} không hợp lệ (file có {len(doc.pages)} trang)")

        page = doc.pages[page_num - 1]

        mediabox = _get_page_box(page, "/MediaBox")
        cropbox = _get_page_box(page, "/CropBox", fallback=mediabox)
        trimbox = _get_page_box(page, "/TrimBox", fallback=mediabox)
        bleedbox = _get_page_box(page, "/BleedBox", fallback=mediabox)
        artbox = _get_page_box(page, "/ArtBox", fallback=mediabox)

        page_str = str(page.obj)

        result = {
            "page": page_num,
            "total_pages": len(doc.pages),
            "mediabox": _box_to_mm(mediabox),
            "cropbox": _box_to_mm(cropbox),
            "trimbox": _box_to_mm(trimbox),
            "bleedbox": _box_to_mm(bleedbox),
            "artbox": _box_to_mm(artbox),
            "has_trimbox": "/TrimBox" in page_str,
            "has_bleedbox": "/BleedBox" in page_str,
            "has_artbox": "/ArtBox" in page_str,
            "has_cropbox": "/CropBox" in page_str,
        }

        doc.close()
        return result

    def set_boxes(
        self, file_path: str, box_type: str, rect_mm: dict,
        pages: list[int] | None = None
    ) -> str:
        """
        Cập nhật 1 loại box cho danh sách trang.
        box_type: 'mediabox' | 'cropbox' | 'trimbox' | 'bleedbox' | 'artbox'
        rect_mm: {"x0": float, "y0": float, "x1": float, "y1": float}
        pages: list of 1-indexed page numbers, None = all pages
        Returns: output file path.
        """
        doc = pikepdf.Pdf.open(file_path)

        target_rect_pt = pikepdf.Array([
            rect_mm["x0"] * PT_PER_MM,
            rect_mm["y0"] * PT_PER_MM,
            rect_mm["x1"] * PT_PER_MM,
            rect_mm["y1"] * PT_PER_MM,
        ])

        box_key_map = {
            "mediabox": "/MediaBox",
            "cropbox": "/CropBox",
            "trimbox": "/TrimBox",
            "bleedbox": "/BleedBox",
            "artbox": "/ArtBox",
        }

        box_key = box_key_map.get(box_type.lower())
        if not box_key:
            doc.close()
            raise ValueError(f"box_type '{box_type}' không hợp lệ")

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]
                page[pikepdf.Name(box_key)] = pikepdf.Array(target_rect_pt)

        output_name = f"{Path(file_path).stem}_boxes_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Set {box_type} on {len(target_pages)} pages → {output_path}")
        return output_path

    def auto_trim(self, file_path: str, pages: list[int] | None = None, margin_mm: float = 0) -> str:
        """
        Phát hiện lề trắng và set CropBox tự động.
        margin_mm: lề bổ sung xung quanh nội dung (mm).
        """
        import pypdfium2 as pdfium

        doc = pikepdf.Pdf.open(file_path)
        pdf_render = pdfium.PdfDocument(file_path)

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        margin_pt = margin_mm * PT_PER_MM

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]
                render_page = pdf_render[pnum - 1]

                # Get page dimensions
                mb = _get_page_box(page, "/MediaBox")
                page_w = mb[2] - mb[0]
                page_h = mb[3] - mb[1]

                # Render at low DPI for fast detection
                bitmap = render_page.render(scale=1.0)  # 72 DPI
                img = bitmap.to_pil()
                arr = np.array(img)
                pix_w, pix_h = img.size

                # Detect non-white region
                if arr.ndim == 3 and arr.shape[2] >= 3:
                    mask = np.any(arr[:, :, :3] < 250, axis=2)
                else:
                    mask = arr[:, :, 0] < 250

                if not mask.any():
                    continue  # All white page, skip

                rows = np.any(mask, axis=1)
                cols = np.any(mask, axis=0)
                y0, y1 = np.where(rows)[0][[0, -1]]
                x0, x1 = np.where(cols)[0][[0, -1]]

                # Convert pixel coords to points
                scale_x = page_w / pix_w
                scale_y = page_h / pix_h

                # pikepdf uses bottom-left origin (PDF standard)
                crop_x0 = mb[0] + x0 * scale_x - margin_pt
                crop_y0 = mb[1] + (pix_h - y1 - 1) * scale_y - margin_pt
                crop_x1 = mb[0] + (x1 + 1) * scale_x + margin_pt
                crop_y1 = mb[1] + (pix_h - y0) * scale_y + margin_pt

                # Clamp to mediabox
                crop_x0 = max(mb[0], crop_x0)
                crop_y0 = max(mb[1], crop_y0)
                crop_x1 = min(mb[2], crop_x1)
                crop_y1 = min(mb[3], crop_y1)

                page[pikepdf.Name("/CropBox")] = pikepdf.Array([crop_x0, crop_y0, crop_x1, crop_y1])

        pdf_render.close()

        output_name = f"{Path(file_path).stem}_trimmed_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Auto-trimmed {len(target_pages)} pages → {output_path}")
        return output_path

    def add_bleed_from_trim(self, file_path: str, bleed_mm: float = 3, pages: list[int] | None = None) -> str:
        """
        Tự động set BleedBox = TrimBox mở rộng thêm bleed_mm mỗi cạnh.
        """
        doc = pikepdf.Pdf.open(file_path)

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        bleed_pt = bleed_mm * PT_PER_MM

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]
                # TrimBox là chuẩn để cộng bleed. Nếu file CHƯA có TrimBox (vd vừa
                # qua auto_trim — chỉ set CropBox), fallback sang CropBox rồi MediaBox.
                # Trước đây fallback thẳng MediaBox → bỏ qua kết quả auto_trim (bù xén
                # quanh CẢ trang gốc thay vì vùng đã xén lề trắng).
                crop = _get_page_box(page, "/CropBox")
                trim = _get_page_box(page, "/TrimBox", fallback=crop)
                mb = _get_page_box(page, "/MediaBox")

                bleed_rect = [
                    trim[0] - bleed_pt,
                    trim[1] - bleed_pt,
                    trim[2] + bleed_pt,
                    trim[3] + bleed_pt,
                ]

                # Expand MediaBox if needed
                new_mb = [
                    min(mb[0], bleed_rect[0]),
                    min(mb[1], bleed_rect[1]),
                    max(mb[2], bleed_rect[2]),
                    max(mb[3], bleed_rect[3]),
                ]

                page[pikepdf.Name("/MediaBox")] = pikepdf.Array(new_mb)
                page[pikepdf.Name("/CropBox")] = pikepdf.Array(new_mb)
                page[pikepdf.Name("/BleedBox")] = pikepdf.Array(bleed_rect)
                page[pikepdf.Name("/TrimBox")] = pikepdf.Array(trim)

        output_name = f"{Path(file_path).stem}_bleed_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Added {bleed_mm}mm bleed on {len(target_pages)} pages → {output_path}")
        return output_path

    def add_mirror_bleed(self, file_path: str, bleed_mm: float = 3, pages: list[int] | None = None) -> str:
        """
        Tạo vùng bù xén bằng cách LẬT GƯƠNG (mirror/reflect) nội dung sát mép trang
        ra ngoài vùng bleed — giữ nguyên 100% vector, không raster hoá.

        Khác hẳn add_bleed_from_trim (chỉ set BleedBox). Hàm này thực sự vẽ nội dung
        phản chiếu vào 4 dải cạnh + 4 góc quanh trim box, đúng kỹ thuật "mirror bleed"
        của prepress, nên vùng bleed luôn có hình (không lộ viền trắng sau khi xén).

        Trim box lấy theo CropBox (kết quả auto_trim) → TrimBox → MediaBox.
        Lưu ý: không xử lý trang có /Rotate ≠ 0 (giữ nguyên, chỉ set bleed box).
        """
        doc = pikepdf.Pdf.open(file_path)
        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        bleed_pt = bleed_mm * PT_PER_MM

        for pnum in target_pages:
            if not (1 <= pnum <= len(doc.pages)):
                continue
            page = doc.pages[pnum - 1]

            mb = _get_page_box(page, "/MediaBox")
            crop = _get_page_box(page, "/CropBox", fallback=mb)
            trim = _get_page_box(page, "/TrimBox", fallback=crop)
            x0, y0, x1, y1 = trim
            b = bleed_pt

            # Trang xoay: kỹ thuật mirror theo trục thẳng sẽ sai → fallback set box.
            rotate = int(page.get("/Rotate", 0) or 0) % 360
            if rotate != 0 or bleed_pt <= 0:
                bleed_rect = [x0 - b, y0 - b, x1 + b, y1 + b]
                new_mb = [
                    min(mb[0], bleed_rect[0]), min(mb[1], bleed_rect[1]),
                    max(mb[2], bleed_rect[2]), max(mb[3], bleed_rect[3]),
                ]
                page[pikepdf.Name("/MediaBox")] = pikepdf.Array(new_mb)
                page[pikepdf.Name("/CropBox")] = pikepdf.Array(new_mb)
                page[pikepdf.Name("/BleedBox")] = pikepdf.Array(bleed_rect)
                page[pikepdf.Name("/TrimBox")] = pikepdf.Array(trim)
                continue

            # Snapshot nội dung trang hiện tại thành Form XObject (vector nguyên bản).
            fx = page.as_form_xobject()
            fx_name = page.add_resource(fx, pikepdf.Name.XObject)

            def _draw(clip, matrix):
                cx, cy, cw, ch = clip
                a, bb, c, d, e, f = matrix
                return [
                    "q",
                    f"{cx:.4f} {cy:.4f} {cw:.4f} {ch:.4f} re W n",
                    f"{a:.6f} {bb:.6f} {c:.6f} {d:.6f} {e:.4f} {f:.4f} cm",
                    f"{fx_name} Do",
                    "Q",
                ]

            ops = []
            # 1) Nội dung gốc (identity), clip trong trim để không đè dải mirror.
            ops += _draw((x0, y0, x1 - x0, y1 - y0), (1, 0, 0, 1, 0, 0))
            # 2) 4 cạnh — phản chiếu qua trục cạnh tương ứng.
            ops += _draw((x0 - b, y0, b, y1 - y0), (-1, 0, 0, 1, 2 * x0, 0))   # trái  (x=x0)
            ops += _draw((x1, y0, b, y1 - y0),     (-1, 0, 0, 1, 2 * x1, 0))   # phải  (x=x1)
            ops += _draw((x0, y0 - b, x1 - x0, b), (1, 0, 0, -1, 0, 2 * y0))   # dưới  (y=y0)
            ops += _draw((x0, y1, x1 - x0, b),     (1, 0, 0, -1, 0, 2 * y1))   # trên  (y=y1)
            # 3) 4 góc — phản chiếu qua cả hai trục.
            ops += _draw((x0 - b, y0 - b, b, b), (-1, 0, 0, -1, 2 * x0, 2 * y0))  # BL
            ops += _draw((x1, y0 - b, b, b),     (-1, 0, 0, -1, 2 * x1, 2 * y0))  # BR
            ops += _draw((x0 - b, y1, b, b),     (-1, 0, 0, -1, 2 * x0, 2 * y1))  # TL
            ops += _draw((x1, y1, b, b),         (-1, 0, 0, -1, 2 * x1, 2 * y1))  # TR

            new_content = pikepdf.Stream(doc, "\n".join(ops).encode("ascii"))
            page[pikepdf.Name("/Contents")] = new_content

            bleed_rect = [x0 - b, y0 - b, x1 + b, y1 + b]
            page[pikepdf.Name("/MediaBox")] = pikepdf.Array(bleed_rect)
            page[pikepdf.Name("/CropBox")] = pikepdf.Array(bleed_rect)
            page[pikepdf.Name("/BleedBox")] = pikepdf.Array(bleed_rect)
            page[pikepdf.Name("/TrimBox")] = pikepdf.Array(trim)
            page[pikepdf.Name("/ArtBox")] = pikepdf.Array(trim)

        output_name = f"{Path(file_path).stem}_mirror_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Mirror-bleed {bleed_mm}mm on {len(target_pages)} pages → {output_path}")
        return output_path
