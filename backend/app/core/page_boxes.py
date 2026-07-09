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


def _pixel_bbox_to_cropbox(x0, y0, x1, y1, pix_w, pix_h, cb, rotate, margin_pt):
    """Ánh xạ bounding box nội dung (toạ độ PIXEL, gốc trên-trái, từ ảnh pdfium ĐÃ
    áp /Rotate) → CropBox trong hệ toạ độ trang GỐC (chưa xoay).

    Vì sao cần: pdfium render trang ĐÃ xoay theo /Rotate, nên pix_w/pix_h là chiều
    SAU xoay (hoán đổi khi 90/270). Bản cũ lấy page_w/page_h (chưa xoay) chia thẳng
    cho pix_w/pix_h → với trang /Rotate=90/270 thì tỉ lệ x↔y sai → box xén lệch hẳn.
    Hàm này đảo ĐÚNG phép biến hình render theo từng góc quay (đã kiểm tay 4 góc).

    cb = CropBox gốc [x0,y0,x1,y1] (chưa xoay). Trả CropBox mới [cx0,cy0,cx1,cy1].
    """
    cb0, cb1, cb2, cb3 = cb
    W = cb2 - cb0   # bề rộng trang CHƯA xoay (pt)
    H = cb3 - cb1   # bề cao trang CHƯA xoay (pt)
    rot = rotate % 360

    # Kích thước trang khi HIỂN THỊ (khớp orientation ảnh render).
    if rot in (90, 270):
        disp_w, disp_h = H, W
    else:
        disp_w, disp_h = W, H

    sx = pix_w / disp_w if disp_w else 1.0
    sy = pix_h / disp_h if disp_h else 1.0

    # Khoảng nội dung theo toạ-độ-điểm HIỂN THỊ (gốc trên-trái, +y xuống).
    X0 = x0 / sx
    X1 = (x1 + 1) / sx
    Y0 = y0 / sy
    Y1 = (y1 + 1) / sy

    # Đảo phép render theo góc quay → khoảng nội dung trong toạ độ trang GỐC
    # (u dọc theo bề rộng, v dọc theo bề cao, gốc dưới-trái).
    if rot == 90:
        u_min, u_max = Y0, Y1
        v_min, v_max = X0, X1
    elif rot == 180:
        u_min, u_max = W - X1, W - X0
        v_min, v_max = Y0, Y1
    elif rot == 270:
        u_min, u_max = W - Y1, W - Y0
        v_min, v_max = H - X1, H - X0
    else:  # 0
        u_min, u_max = X0, X1
        v_min, v_max = H - Y1, H - Y0

    cx0 = cb0 + u_min - margin_pt
    cy0 = cb1 + v_min - margin_pt
    cx1 = cb0 + u_max + margin_pt
    cy1 = cb1 + v_max + margin_pt

    # Kẹp trong CropBox gốc (không vượt vùng đang hiển thị).
    cx0 = max(cb0, cx0)
    cy0 = max(cb1, cy0)
    cx1 = min(cb2, cx1)
    cy1 = min(cb3, cy1)
    return [cx0, cy0, cx1, cy1]


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

        Bền với file thực tế (audit 2026-07-08):
        - Render 200 DPI (không phải 72) → biên xén chính xác ~0.13mm/px thay vì
          ~0.35mm/px, nét mảnh không bị mất khỏi mask.
        - Lọc NOISE JPEG: nền trắng của ảnh JPEG có pixel nhiễu 245-249 rải tới sát
          mép → ngưỡng cứng <250 cũ khiến bounding box nở ra cả trang (auto-trim
          "không ăn"). Nay: ngưỡng nới + morphology-open bỏ đốm lẻ + bỏ thành phần
          liên thông quá nhỏ (< diện tích tối thiểu) trước khi lấy bbox.
        - Tôn trọng /Rotate: pdfium render ảnh ĐÃ xoay; ánh xạ pixel→CropBox qua
          _pixel_bbox_to_cropbox (đảo đúng góc quay) thay vì giả định luôn R=0.
        """
        import pypdfium2 as pdfium
        import cv2

        doc = pikepdf.Pdf.open(file_path)
        pdf_render = pdfium.PdfDocument(file_path)

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        margin_pt = margin_mm * PT_PER_MM

        # 200 DPI đủ nét cho tem nhỏ mà vẫn nhanh (dò lề, không phải xuất).
        DETECT_SCALE = 200.0 / 72.0

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]
                render_page = pdf_render[pnum - 1]

                # Hệ quy chiếu là CROPBOX (chưa xoay); pdfium render đúng vùng
                # CropBox rồi áp /Rotate. .cropbox tự fallback về MediaBox.
                cb = _get_page_box(page, "/CropBox", fallback=_get_page_box(page, "/MediaBox"))
                rotate = int(page.get("/Rotate", 0) or 0) % 360

                bitmap = render_page.render(scale=DETECT_SCALE)
                img = bitmap.to_pil()
                arr = np.array(img)
                pix_w, pix_h = img.size

                # Nội dung = pixel KHÔNG-trắng. Ngưỡng 248 (nới nhẹ) rồi lọc noise:
                # nền JPEG lẫn đốm 245-249 lẻ tẻ; morphology-open (erode→dilate) xoá
                # đốm ≤ 1px; connectedComponents bỏ mảng nhỏ hơn ngưỡng diện tích.
                if arr.ndim == 3 and arr.shape[2] >= 3:
                    mask = np.any(arr[:, :, :3] < 248, axis=2).astype(np.uint8)
                else:
                    mask = (arr[:, :, 0] < 248).astype(np.uint8)

                # Bỏ đốm nhiễu 1px (open = erode rồi dilate, kernel 3x3).
                _k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _k)

                # Bỏ thành phần liên thông quá nhỏ (noise còn sót sau open). Ngưỡng
                # ~ (0.3mm)^2 ở DPI hiện tại — nhỏ hơn coi là nhiễu, không phải nội dung.
                _min_side_px = max(2, int(0.3 * PT_PER_MM * DETECT_SCALE))
                _min_area = _min_side_px * _min_side_px
                n_lbl, _lbl, _stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
                clean = np.zeros_like(mask)
                for _i in range(1, n_lbl):  # 0 = nền
                    if _stats[_i, cv2.CC_STAT_AREA] >= _min_area:
                        clean[_lbl == _i] = 1
                mask = clean

                if not mask.any():
                    continue  # Trang trắng (hoặc chỉ có noise) → bỏ qua, giữ nguyên box

                rows = np.any(mask, axis=1)
                cols = np.any(mask, axis=0)
                y0, y1 = np.where(rows)[0][[0, -1]]
                x0, x1 = np.where(cols)[0][[0, -1]]

                new_cb = _pixel_bbox_to_cropbox(
                    int(x0), int(y0), int(x1), int(y1),
                    pix_w, pix_h, cb, rotate, margin_pt,
                )
                page[pikepdf.Name("/CropBox")] = pikepdf.Array(new_cb)

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

            # Snapshot nội dung GỐC của trang thành Form XObject ĐỘC LẬP.
            # QUAN TRỌNG (chống đệ quy vô hạn): KHÔNG dùng page.as_form_xobject() —
            # nó trả về form DÙNG CHUNG chính stream-object với page.Contents. Khi ta
            # ghi đè page.Contents = nội-dung-mirror (có lệnh "/Fmx Do"), stream của
            # form cũng bị đổi thành nội-dung-mirror → form vẽ lại CHÍNH NÓ → đệ quy
            # vô hạn, mọi trình render (pdfium) TREO kể cả file MediaBox==CropBox.
            # Cách chặn: đọc BYTES nội dung gốc TRƯỚC, dựng stream MỚI hoàn toàn tách
            # rời page.Contents; cấp cho fx bản sao Resources gốc (không chứa /Fmx).
            contents_obj = page.obj.get("/Contents")
            if isinstance(contents_obj, pikepdf.Array):
                orig_bytes = b"\n".join(bytes(s.read_bytes()) for s in contents_obj)
            elif contents_obj is not None:
                orig_bytes = bytes(contents_obj.read_bytes())
            else:
                orig_bytes = b""

            try:
                res_src = page.Resources
            except Exception:
                res_src = pikepdf.Dictionary()
            orig_res = doc.make_indirect(pikepdf.Dictionary(res_src))

            fx = pikepdf.Stream(doc, orig_bytes)
            fx.Type = pikepdf.Name.XObject
            fx.Subtype = pikepdf.Name.Form
            fx.BBox = pikepdf.Array([mb[0], mb[1], mb[2], mb[3]])
            fx.Resources = orig_res
            fx_ref = doc.make_indirect(fx)
            page[pikepdf.Name("/Resources")] = pikepdf.Dictionary({
                "/XObject": pikepdf.Dictionary({"/Fmx": fx_ref})
            })
            fx_name = "/Fmx"

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
