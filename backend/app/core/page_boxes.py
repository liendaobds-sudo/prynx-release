"""
Page Boxes Engine — Quản lý khổ trang PDF (MediaBox, CropBox, TrimBox, BleedBox, ArtBox).

Chức năng tương đương Acrobat Pro → Print Production → Set Page Boxes.
"""
import ctypes
import logging
import math
import uuid
from pathlib import Path

import numpy as np
import pikepdf

from app.config import settings

logger = logging.getLogger(__name__)

# 1 pt = 1/72 inch, 1 inch = 25.4 mm
PT_PER_MM = 72 / 25.4
MAX_CROP_REGIONS = 64
MIN_CROP_SIZE_PT = 1.0
MAX_CROP_DETECT_PIXELS = 20_000_000


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


def _normalise_crop_rects(page, rects_mm: list[dict]) -> tuple[list[float], list[list[float]]]:
    """Validate and clamp crop rectangles to the page's visible CropBox."""
    if not rects_mm:
        raise ValueError("Cần ít nhất 1 vùng crop")
    if len(rects_mm) > MAX_CROP_REGIONS:
        raise ValueError(f"Chỉ xử lý tối đa {MAX_CROP_REGIONS} vùng mỗi lần")

    media = _get_page_box(page, "/MediaBox")
    visible = _get_page_box(page, "/CropBox", fallback=media)
    vx0, vy0, vx1, vy1 = visible
    normalised: list[list[float]] = []

    for idx, rect in enumerate(rects_mm):
        try:
            values = [float(rect[key]) for key in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Vùng #{idx + 1} thiếu hoặc sai tọa độ") from exc
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"Vùng #{idx + 1} chứa tọa độ không hữu hạn")

        x0, y0, x1, y1 = (value * PT_PER_MM for value in values)
        x0, x1 = max(vx0, x0), min(vx1, x1)
        y0, y1 = max(vy0, y0), min(vy1, y1)
        if x1 - x0 < MIN_CROP_SIZE_PT or y1 - y0 < MIN_CROP_SIZE_PT:
            raise ValueError(f"Vùng #{idx + 1} nằm ngoài trang hoặc quá nhỏ")
        normalised.append([x0, y0, x1, y1])

    return visible, normalised


def _page_rect_to_pixel_bbox(rect, pix_w, pix_h, cb, rotate):
    """Map a PDF-space rectangle to the top-left pixel space rendered by PDFium."""
    cb0, cb1, cb2, cb3 = cb
    width, height = cb2 - cb0, cb3 - cb1
    x0, y0, x1, y1 = rect
    u0, u1 = x0 - cb0, x1 - cb0
    v0, v1 = y0 - cb1, y1 - cb1
    rot = rotate % 360

    if rot == 90:
        dx0, dx1, dy0, dy1 = v0, v1, u0, u1
        disp_w, disp_h = height, width
    elif rot == 180:
        dx0, dx1, dy0, dy1 = width - u1, width - u0, v0, v1
        disp_w, disp_h = width, height
    elif rot == 270:
        dx0, dx1 = height - v1, height - v0
        dy0, dy1 = width - u1, width - u0
        disp_w, disp_h = height, width
    else:
        dx0, dx1 = u0, u1
        dy0, dy1 = height - v1, height - v0
        disp_w, disp_h = width, height

    sx = pix_w / disp_w if disp_w else 1.0
    sy = pix_h / disp_h if disp_h else 1.0
    return [
        max(0, min(pix_w, int(math.floor(dx0 * sx)))),
        max(0, min(pix_h, int(math.floor(dy0 * sy)))),
        max(0, min(pix_w, int(math.ceil(dx1 * sx)))),
        max(0, min(pix_h, int(math.ceil(dy1 * sy)))),
    ]


def _pdfium_object_candidates(file_path: str, page_index: int) -> list[tuple[list[float], int]]:
    """Read top-level painted object bounds without rasterising the PDF."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    pdf = pdfium.PdfDocument(file_path)
    try:
        page = pdf[page_index]
        page_raw = page.raw
        count = min(int(pdfium_c.FPDFPage_CountObjects(page_raw)), 20000)
        candidates: list[tuple[list[float], int]] = []
        painted_types = {
            int(pdfium_c.FPDF_PAGEOBJ_PATH),
            int(pdfium_c.FPDF_PAGEOBJ_IMAGE),
            int(pdfium_c.FPDF_PAGEOBJ_SHADING),
            int(pdfium_c.FPDF_PAGEOBJ_FORM),
        }
        for idx in range(count):
            obj = pdfium_c.FPDFPage_GetObject(page_raw, idx)
            if not obj:
                continue
            raw_type = int(pdfium_c.FPDFPageObj_GetType(obj))
            if raw_type not in painted_types:
                continue
            left = ctypes.c_float()
            bottom = ctypes.c_float()
            right = ctypes.c_float()
            top = ctypes.c_float()
            if not pdfium_c.FPDFPageObj_GetBounds(
                obj,
                ctypes.byref(left),
                ctypes.byref(bottom),
                ctypes.byref(right),
                ctypes.byref(top),
            ):
                continue
            box = [float(left.value), float(bottom.value), float(right.value), float(top.value)]
            if all(math.isfinite(value) for value in box) and box[2] > box[0] and box[3] > box[1]:
                candidates.append((box, raw_type))
        return candidates
    finally:
        pdf.close()


def _choose_structural_crop_box(
    rough: list[float],
    candidates: list[tuple[list[float], int]],
    max_trim_pt: float,
) -> list[float] | None:
    """Prefer a page/image/form boundary that lies just inside the rough selection."""
    import pypdfium2.raw as pdfium_c

    rx0, ry0, rx1, ry1 = rough
    rough_area = (rx1 - rx0) * (ry1 - ry0)
    tolerance = 0.6 * PT_PER_MM
    priorities = {
        int(pdfium_c.FPDF_PAGEOBJ_IMAGE): 4,
        int(pdfium_c.FPDF_PAGEOBJ_FORM): 3,
        int(pdfium_c.FPDF_PAGEOBJ_SHADING): 2,
        int(pdfium_c.FPDF_PAGEOBJ_PATH): 1,
    }
    best: tuple[float, list[float]] | None = None

    for box, raw_type in candidates:
        x0, y0, x1, y1 = box
        gaps = [x0 - rx0, y0 - ry0, rx1 - x1, ry1 - y1]
        if any(gap < -tolerance or gap > max_trim_pt + tolerance for gap in gaps):
            continue
        width, height = x1 - x0, y1 - y0
        if width < 10 * PT_PER_MM or height < 10 * PT_PER_MM:
            continue
        ratio = (width * height) / rough_area if rough_area else 0.0
        if ratio < 0.45:
            continue
        clipped = [max(rx0, x0), max(ry0, y0), min(rx1, x1), min(ry1, y1)]
        if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
            continue
        # The outermost painted boundary is safest for print: an inner form must
        # never beat a larger image/path and accidentally remove its bleed.
        trim_ratio = sum(max(0.0, gap) for gap in gaps) / max(1.0, max_trim_pt)
        score = ratio * 1000.0 - trim_ratio + priorities.get(raw_type, 0) * 0.001
        if best is None or score > best[0]:
            best = (score, clipped)
    return best[1] if best else None


def _longest_true_run(values: np.ndarray) -> tuple[int, int] | None:
    """Return the longest [start, end) run from a one-dimensional boolean mask."""
    best: tuple[int, int] | None = None
    start: int | None = None
    for index, enabled in enumerate(np.append(values.astype(bool), False)):
        if enabled and start is None:
            start = index
        elif not enabled and start is not None:
            if best is None or index - start > best[1] - best[0]:
                best = (start, index)
            start = None
    return best


def _detect_uniform_background_rect_box(
    image_arr: np.ndarray,
    rough: list[float],
    pix_w: int,
    pix_h: int,
    cb: list[float],
    rotate: int,
    max_trim_pt: float,
) -> list[float] | None:
    """Detect a solid rectangular card on a uniform raster background.

    This high-confidence path is intentionally stricter than generic pixel
    content detection. Full rows/columns identify the true card rectangle and
    reject soft drop shadows. If the background or rectangle is ambiguous, the
    function returns ``None`` so no automatic crop can remove possible bleed.
    """
    import cv2

    px0, py0, px1, py1 = _page_rect_to_pixel_bbox(rough, pix_w, pix_h, cb, rotate)
    if px1 - px0 < 24 or py1 - py0 < 24:
        return None
    region = image_arr[py0:py1, px0:px1]
    rgb = region[:, :, :3] if region.ndim == 3 else np.repeat(region[:, :, None], 3, axis=2)
    height, width = rgb.shape[:2]
    # Tight selections can leave only one or two background pixels around the
    # card. Prefer a demonstrably uniform page perimeter in that case; it is a
    # reliable background sample for raster scans/screenshots and prevents the
    # artwork-heavy local border from being mistaken for an ambiguous edge.
    page_border_width = max(2, min(12, min(pix_h, pix_w) // 50))
    page_rgb = image_arr[:, :, :3] if image_arr.ndim == 3 else np.repeat(image_arr[:, :, None], 3, axis=2)
    page_border = np.concatenate((
        page_rgb[:page_border_width].reshape(-1, 3),
        page_rgb[-page_border_width:].reshape(-1, 3),
        page_rgb[:, :page_border_width].reshape(-1, 3),
        page_rgb[:, -page_border_width:].reshape(-1, 3),
    ), axis=0).astype(np.float32)
    page_background = np.median(page_border, axis=0)
    page_border_distance = np.linalg.norm(page_border - page_background, axis=1)

    border_width = max(2, min(8, min(height, width) // 20))
    border = np.concatenate((
        rgb[:border_width].reshape(-1, 3),
        rgb[-border_width:].reshape(-1, 3),
        rgb[:, :border_width].reshape(-1, 3),
        rgb[:, -border_width:].reshape(-1, 3),
    ), axis=0).astype(np.float32)
    background = np.median(border, axis=0)
    border_distance = np.linalg.norm(border - background, axis=1)
    if float(np.percentile(page_border_distance, 75)) <= 12.0:
        background = page_background
        border_distance = page_border_distance
    elif float(np.percentile(border_distance, 75)) > 12.0:
        return None

    threshold = max(18.0, float(np.percentile(border_distance, 90)) + 8.0)
    distance = np.linalg.norm(rgb.astype(np.float32) - background, axis=2)
    mask = (distance > threshold).astype(np.uint8)
    kernel3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    kernel5 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel5)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    components = [
        (int(stats[index, cv2.CC_STAT_AREA]), index)
        for index in range(1, count)
        if int(stats[index, cv2.CC_STAT_AREA]) >= int(mask.size * 0.05)
    ]
    if not components:
        return None
    _, component_index = max(components)
    bx = int(stats[component_index, cv2.CC_STAT_LEFT])
    by = int(stats[component_index, cv2.CC_STAT_TOP])
    bw = int(stats[component_index, cv2.CC_STAT_WIDTH])
    bh = int(stats[component_index, cv2.CC_STAT_HEIGHT])
    component = labels[by:by + bh, bx:bx + bw] == component_index

    row_coverage = component.mean(axis=1)
    rows = _longest_true_run(row_coverage >= max(0.82, float(row_coverage.max()) * 0.92))
    if rows is None:
        return None
    local_y0, local_y1 = rows
    column_coverage = component[local_y0:local_y1].mean(axis=0)
    columns = _longest_true_run(column_coverage >= max(0.82, float(column_coverage.max()) * 0.92))
    if columns is None:
        return None
    local_x0, local_x1 = columns
    refined_rows = component[:, local_x0:local_x1].mean(axis=1)
    rows = _longest_true_run(refined_rows >= max(0.88, float(refined_rows.max()) * 0.94))
    if rows is None:
        return None
    local_y0, local_y1 = rows

    rectangle = component[local_y0:local_y1, local_x0:local_x1]
    if rectangle.size == 0 or float(rectangle.mean()) < 0.97:
        return None
    candidate = _pixel_bbox_to_cropbox(
        px0 + bx + local_x0,
        py0 + by + local_y0,
        px0 + bx + local_x1 - 1,
        py0 + by + local_y1 - 1,
        pix_w, pix_h, cb, rotate, 0.0,
    )
    gaps = [candidate[0] - rough[0], candidate[1] - rough[1], rough[2] - candidate[2], rough[3] - candidate[3]]
    tolerance = 0.6 * PT_PER_MM
    if any(gap < -tolerance or gap > max_trim_pt + tolerance for gap in gaps):
        return None
    rough_area = (rough[2] - rough[0]) * (rough[3] - rough[1])
    candidate_area = (candidate[2] - candidate[0]) * (candidate[3] - candidate[1])
    if candidate_area < 0.45 * rough_area:
        return None
    return [max(rough[0], candidate[0]), max(rough[1], candidate[1]), min(rough[2], candidate[2]), min(rough[3], candidate[3])]


def _detect_raster_crop_box(
    image_arr: np.ndarray,
    rough: list[float],
    pix_w: int,
    pix_h: int,
    cb: list[float],
    rotate: int,
    max_trim_pt: float,
) -> list[float] | None:
    """Fallback edge detector. It is accepted only when every removed edge is small."""
    import cv2

    px0, py0, px1, py1 = _page_rect_to_pixel_bbox(rough, pix_w, pix_h, cb, rotate)
    if px1 - px0 < 8 or py1 - py0 < 8:
        return None
    region = image_arr[py0:py1, px0:px1]
    rgb = region[:, :, :3] if region.ndim == 3 else np.repeat(region[:, :, None], 3, axis=2)
    border_width = max(1, min(4, min(rgb.shape[:2]) // 12))
    border = np.concatenate((
        rgb[:border_width].reshape(-1, 3),
        rgb[-border_width:].reshape(-1, 3),
        rgb[:, :border_width].reshape(-1, 3),
        rgb[:, -border_width:].reshape(-1, 3),
    ), axis=0)
    background = np.median(border.astype(np.float32), axis=0)
    distance = np.linalg.norm(rgb.astype(np.float32) - background, axis=2)
    mask = (distance > 16.0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    if not mask.any():
        return None

    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    min_area = max(9, int(mask.size * 0.00005))
    clean = np.zeros_like(mask)
    for idx in range(1, count):
        if stats[idx, cv2.CC_STAT_AREA] >= min_area:
            clean[labels == idx] = 1
    if not clean.any():
        return None

    rows = np.any(clean, axis=1)
    cols = np.any(clean, axis=0)
    local_y0, local_y1 = np.where(rows)[0][[0, -1]]
    local_x0, local_x1 = np.where(cols)[0][[0, -1]]
    candidate = _pixel_bbox_to_cropbox(
        px0 + int(local_x0), py0 + int(local_y0),
        px0 + int(local_x1), py0 + int(local_y1),
        pix_w, pix_h, cb, rotate, 0.0,
    )
    gaps = [candidate[0] - rough[0], candidate[1] - rough[1], rough[2] - candidate[2], rough[3] - candidate[3]]
    tolerance = 0.6 * PT_PER_MM
    if any(gap < -tolerance or gap > max_trim_pt + tolerance for gap in gaps):
        return None
    rough_area = (rough[2] - rough[0]) * (rough[3] - rough[1])
    if (candidate[2] - candidate[0]) * (candidate[3] - candidate[1]) < 0.45 * rough_area:
        return None
    return [max(rough[0], candidate[0]), max(rough[1], candidate[1]), min(rough[2], candidate[2]), min(rough[3], candidate[3])]

def _translate_crop_annotations(page, x0: float, y0: float, width: float, height: float) -> None:
    """Move annotation geometry with physically cropped page content and drop outside links."""
    annotations = page.get("/Annots")
    if not annotations:
        return
    kept = pikepdf.Array()

    def shift_pairs(values):
        shifted = []
        for idx, value in enumerate(values):
            shifted.append(float(value) - (x0 if idx % 2 == 0 else y0))
        return pikepdf.Array(shifted)

    for annotation_ref in annotations:
        try:
            annotation = annotation_ref
            rect = annotation.get("/Rect")
            if rect is not None and len(rect) >= 4:
                ax0 = float(rect[0]) - x0
                ay0 = float(rect[1]) - y0
                ax1 = float(rect[2]) - x0
                ay1 = float(rect[3]) - y0
                clipped = [max(0.0, ax0), max(0.0, ay0), min(width, ax1), min(height, ay1)]
                if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
                    continue
                annotation[pikepdf.Name.Rect] = pikepdf.Array(clipped)
            for key in ("/QuadPoints", "/Vertices", "/L", "/CL"):
                values = annotation.get(key)
                if values is not None:
                    annotation[pikepdf.Name(key)] = shift_pairs(values)
            ink_list = annotation.get("/InkList")
            if ink_list is not None:
                annotation[pikepdf.Name.InkList] = pikepdf.Array(
                    [shift_pairs(stroke) for stroke in ink_list]
                )
            kept.append(annotation_ref)
        except Exception as exc:
            logger.debug("Cannot translate crop annotation: %s", exc)
            kept.append(annotation_ref)
    page[pikepdf.Name.Annots] = kept

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
        pages: list[int] | None = None,
        *,
        sync_mediabox: bool | None = None,
        physical_crop: bool | None = None,
    ) -> str:
        """
        Cập nhật 1 loại box cho danh sách trang.
        box_type: 'mediabox' | 'cropbox' | 'trimbox' | 'bleedbox' | 'artbox'
        rect_mm: {"x0": float, "y0": float, "x1": float, "y1": float}
        pages: list of 1-indexed page numbers, None = all pages
        sync_mediabox:
          - None (mặc định): khi box_type='cropbox' → CŨNG set MediaBox = rect
          - True/False: ép bật/tắt
        physical_crop:
          - None (mặc định): khi box_type='cropbox' → CẮT VẬT LÝ: dịch content
            về gốc (0,0) + MediaBox=[0,0,w,h]. Chỉ set box tuyệt đối [x0,y0,x1,y1]
            khiến nhiều tool (resize/form XObject) clip/scale sai → “cắt lún vào
            object”. Acrobat-style hard crop = translate + zero-origin boxes.
          - True/False: ép bật/tắt
        Returns: output file path.
        """
        doc = pikepdf.Pdf.open(file_path)

        x0_pt = float(rect_mm["x0"]) * PT_PER_MM
        y0_pt = float(rect_mm["y0"]) * PT_PER_MM
        x1_pt = float(rect_mm["x1"]) * PT_PER_MM
        y1_pt = float(rect_mm["y1"]) * PT_PER_MM
        if x1_pt <= x0_pt or y1_pt <= y0_pt:
            doc.close()
            raise ValueError("rect_mm không hợp lệ (x1<=x0 hoặc y1<=y0)")

        w_pt = x1_pt - x0_pt
        h_pt = y1_pt - y0_pt
        target_rect_pt = [x0_pt, y0_pt, x1_pt, y1_pt]
        zero_origin_rect = [0.0, 0.0, w_pt, h_pt]

        box_key_map = {
            "mediabox": "/MediaBox",
            "cropbox": "/CropBox",
            "trimbox": "/TrimBox",
            "bleedbox": "/BleedBox",
            "artbox": "/ArtBox",
        }

        box_type_l = box_type.lower()
        box_key = box_key_map.get(box_type_l)
        if not box_key:
            doc.close()
            raise ValueError(f"box_type '{box_type}' không hợp lệ")

        do_sync_media = (
            sync_mediabox if sync_mediabox is not None
            else (box_type_l == "cropbox")
        )
        do_physical = (
            physical_crop if physical_crop is not None
            else (box_type_l == "cropbox")
        )

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))

        for pnum in target_pages:
            if not (1 <= pnum <= len(doc.pages)):
                continue
            page = doc.pages[pnum - 1]

            if do_physical and box_type_l in ("cropbox", "mediabox"):
                # ── Hard crop: form XObject + trang mới [0,0,w,h] ──
                # Tránh chỉ gán MediaBox=[x0,y0,x1,y1] (content vẫn ở toạ độ cũ →
                # tool sau “nhìn” lệch / clip vào object).
                self._physical_crop_page(doc, page, x0_pt, y0_pt, w_pt, h_pt)
            else:
                page[pikepdf.Name(box_key)] = pikepdf.Array(target_rect_pt)
                if do_sync_media and box_type_l != "mediabox":
                    page[pikepdf.Name.MediaBox] = pikepdf.Array(target_rect_pt)
                    page[pikepdf.Name.CropBox] = pikepdf.Array(target_rect_pt)

        output_name = f"{Path(file_path).stem}_boxes_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(
            "Set %s on %d pages (sync_mediabox=%s physical_crop=%s) → %s",
            box_type, len(target_pages), do_sync_media, do_physical, output_path,
        )
        return output_path

    @staticmethod
    def _physical_crop_page(doc, page, x0: float, y0: float, w: float, h: float) -> None:
        """Cắt thật 1 trang: dịch content (-x0,-y0), MediaBox/CropBox = [0,0,w,h].

        Chỉ gán MediaBox=[x0,y0,x1,y1] (không dịch) khiến form XObject / resize
        clip-scale lệch — user thấy “cắt lún vào object” thay vì đúng khung quét.
        """
        for _bk in ("/TrimBox", "/BleedBox", "/ArtBox"):
            try:
                if _bk in page:
                    del page[pikepdf.Name(_bk)]
            except Exception:
                pass

        # Dịch toàn bộ content stream về gốc (0,0).
        try:
            page.contents_coalesce()
            raw = b""
            if page.get("/Contents") is not None:
                raw = page.Contents.read_bytes()
            # q … Q bọc để không phá balance q/Q bên trong (best-effort).
            prefix = f"q 1 0 0 1 {-x0:.6f} {-y0:.6f} cm\n".encode("latin-1", errors="replace")
            suffix = b"\nQ\n"
            page.Contents = pikepdf.Stream(doc, prefix + raw + suffix)
        except Exception as e:
            logger.warning("physical crop content translate failed: %s — box-only fallback", e)
            absolute_box = pikepdf.Array([x0, y0, x0 + w, y0 + h])
            page.MediaBox = absolute_box
            page.CropBox = pikepdf.Array(absolute_box)
            page.TrimBox = pikepdf.Array(absolute_box)
            return

        _translate_crop_annotations(page, x0, y0, w, h)
        output_box = pikepdf.Array([0.0, 0.0, w, h])
        page.MediaBox = output_box
        page.CropBox = pikepdf.Array(output_box)
        page.TrimBox = pikepdf.Array(output_box)

    def detect_crop_regions(
        self,
        file_path: str,
        page_num: int,
        rects_mm: list[dict],
        max_trim_mm: float = 5.0,
        cancel_event=None,
    ) -> dict:
        """Find likely finished-size edges inside rough selections without destructive cropping.

        A large page/image/form/path boundary is preferred because it can preserve intentional
        white artwork. Raster detection is only a fallback, and is rejected if any edge would
        move farther than ``max_trim_mm``.
        """
        def check_cancelled() -> None:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Đã hủy dò rìa dư")

        check_cancelled()
        if page_num < 1:
            raise ValueError(f"page_num không hợp lệ: {page_num}")
        if not math.isfinite(float(max_trim_mm)) or max_trim_mm <= 0 or max_trim_mm > 20:
            raise ValueError("max_trim_mm phải lớn hơn 0 và không quá 20 mm")

        doc = pikepdf.Pdf.open(file_path)
        try:
            if page_num > len(doc.pages):
                raise ValueError(f"Trang {page_num} không hợp lệ (file có {len(doc.pages)} trang)")
            page = doc.pages[page_num - 1]
            visible, rough_rects = _normalise_crop_rects(page, rects_mm)
            rotate = int(page.get("/Rotate", 0) or 0) % 360
            explicit_bleed = page.get("/BleedBox")
            bleed_box = _pike_box_to_list(explicit_bleed) if explicit_bleed is not None else None
        finally:
            doc.close()

        try:
            object_candidates = _pdfium_object_candidates(file_path, page_num - 1)
        except Exception as exc:
            logger.warning("crop edge object detection failed: %s", exc)
            object_candidates = []
        check_cancelled()

        image_arr = None
        pix_w = pix_h = 0
        render_error = False
        visible_width = visible[2] - visible[0]
        visible_height = visible[3] - visible[1]
        if rotate in (90, 270):
            visible_width, visible_height = visible_height, visible_width
        render_scale = 200.0 / 72.0
        projected_pixels = visible_width * visible_height * render_scale * render_scale
        if projected_pixels > MAX_CROP_DETECT_PIXELS:
            render_scale *= math.sqrt(MAX_CROP_DETECT_PIXELS / projected_pixels)

        def ensure_render():
            nonlocal image_arr, pix_w, pix_h, render_error
            if image_arr is not None or render_error:
                return
            try:
                import pypdfium2 as pdfium
                check_cancelled()
                render_doc = pdfium.PdfDocument(file_path)
                try:
                    bitmap = render_doc[page_num - 1].render(scale=render_scale)
                    image = bitmap.to_pil()
                    image_arr = np.array(image)
                    pix_w, pix_h = image.size
                finally:
                    render_doc.close()
                check_cancelled()
            except Exception as exc:
                render_error = True
                logger.warning("crop edge raster detection failed: %s", exc)

        max_trim_pt = float(max_trim_mm) * PT_PER_MM
        results = []
        for rough in rough_rects:
            check_cancelled()
            # A declared BleedBox is the authoritative outer print boundary. Use
            # it only when it fits this rough region; on imposed sheets it will
            # not fit an individual item and is therefore ignored.
            detected = None
            method = "unchanged"
            if bleed_box is not None:
                detected = _choose_structural_crop_box(rough, [(bleed_box, -1)], max_trim_pt)
                if detected is not None:
                    method = "bleedbox"
            if detected is None:
                detected = _choose_structural_crop_box(rough, object_candidates, max_trim_pt)
                if detected is not None:
                    method = "object"
            confidence = "high" if detected is not None else "low"
            raster_suggestion = None
            if detected is None:
                ensure_render()
                if image_arr is not None:
                    detected = _detect_uniform_background_rect_box(
                        image_arr, rough, pix_w, pix_h, visible, rotate, max_trim_pt,
                    )
                    if detected is not None:
                        # A nearly solid rectangle against a uniform surrounding
                        # background is safe: the detected outer rectangle includes
                        # the card artwork/bleed and excludes only scan background.
                        method = "background"
                        confidence = "high"
                if image_arr is not None and detected is None:
                    raster_suggestion = _detect_raster_crop_box(
                        image_arr, rough, pix_w, pix_h, visible, rotate, max_trim_pt,
                    )
                    if raster_suggestion is not None:
                        # Pixel colour cannot distinguish unwanted whitespace from
                        # intentional white bleed. Keep the user's region and only
                        # return the candidate as a non-destructive suggestion.
                        method = "pixels"
                        confidence = "low"

            final_rect = detected if detected is not None else rough
            trim_values = [
                max(0.0, final_rect[0] - rough[0]),
                max(0.0, final_rect[1] - rough[1]),
                max(0.0, rough[2] - final_rect[2]),
                max(0.0, rough[3] - final_rect[3]),
            ]
            changed = detected is not None and max(trim_values) >= 0.15 * PT_PER_MM
            if not changed:
                final_rect = rough
                if raster_suggestion is None:
                    method = "unchanged"
                    confidence = "low"
                trim_values = [0.0, 0.0, 0.0, 0.0]

            results.append({
                "rect_mm": _box_to_mm(final_rect),
                "changed": changed,
                "method": method,
                "confidence": confidence,
                "trim_mm": {
                    "left": round(trim_values[0] / PT_PER_MM, 2),
                    "bottom": round(trim_values[1] / PT_PER_MM, 2),
                    "right": round(trim_values[2] / PT_PER_MM, 2),
                    "top": round(trim_values[3] / PT_PER_MM, 2),
                },
                "safe_to_apply": bool(changed and method in ("bleedbox", "object", "background")),
                "suggested_rect_mm": _box_to_mm(raster_suggestion) if raster_suggestion is not None else None,
            })

        return {
            "page": page_num,
            "cropbox": _box_to_mm(visible),
            "max_trim_mm": float(max_trim_mm),
            "regions": results,
        }

    def crop_regions_to_pages(
        self,
        file_path: str,
        page_num: int,
        rects_mm: list[dict],
        keep_other_pages: bool = False,
        pages: list[int] | None = None,
    ) -> str:
        """Crop the selected regions on one or more source pages."""
        if page_num < 1:
            raise ValueError(f"page_num không hợp lệ: {page_num}")

        check_doc = pikepdf.Pdf.open(file_path)
        try:
            page_count = len(check_doc.pages)
            if page_num > page_count:
                raise ValueError(f"Trang {page_num} không hợp lệ (file có {page_count} trang)")
            target_pages = sorted(set(pages or [page_num]))
            if not target_pages or any(page < 1 or page > page_count for page in target_pages):
                raise ValueError(f"Danh sách trang crop không hợp lệ: {target_pages}")
            reference_visible, reference_rects = _normalise_crop_rects(check_doc.pages[page_num - 1], rects_mm)
            rvx0, rvy0, _, _ = reference_visible
            relative_rects = [[x0 - rvx0, y0 - rvy0, x1 - rvx0, y1 - rvy0] for x0, y0, x1, y1 in reference_rects]
            rects_by_index: dict[int, list[list[float]]] = {}
            for page in target_pages:
                target_page = check_doc.pages[page - 1]
                target_visible = _get_page_box(target_page, "/CropBox", fallback=_get_page_box(target_page, "/MediaBox"))
                tvx0, tvy0, tvx1, tvy1 = target_visible
                target_rects: list[list[float]] = []
                for dx0, dy0, dx1, dy1 in relative_rects:
                    x0, x1 = max(tvx0, tvx0 + dx0), min(tvx1, tvx0 + dx1)
                    y0, y1 = max(tvy0, tvy0 + dy0), min(tvy1, tvy0 + dy1)
                    if x1 - x0 < MIN_CROP_SIZE_PT or y1 - y0 < MIN_CROP_SIZE_PT:
                        raise ValueError(f"Vùng crop nằm ngoài trang {page} hoặc quá nhỏ")
                    target_rects.append([x0, y0, x1, y1])
                rects_by_index[page - 1] = target_rects
        finally:
            check_doc.close()

        target_indexes = set(rects_by_index)
        out = pikepdf.Pdf.new()
        try:
            # One base document supplies untouched pages. Each crop still reopens the
            # source so physical transforms never accumulate between regions.
            base = pikepdf.Pdf.open(file_path)
            try:
                source_indexes = range(len(base.pages)) if keep_other_pages else sorted(target_indexes)
                for source_index in source_indexes:
                    if source_index not in target_indexes:
                        if keep_other_pages:
                            out.pages.append(base.pages[source_index])
                        continue
                    for x0, y0, x1, y1 in rects_by_index[source_index]:
                        src = pikepdf.Pdf.open(file_path)
                        try:
                            page = src.pages[source_index]
                            self._physical_crop_page(src, page, x0, y0, x1 - x0, y1 - y0)
                            out.pages.append(src.pages[source_index])
                        finally:
                            src.close()
            finally:
                base.close()

            output_name = f"{Path(file_path).stem}_multicrop_{uuid.uuid4().hex[:6]}.pdf"
            output_path = str(self.output_dir / output_name)
            out.save(output_path)
        finally:
            out.close()

        logger.info(
            "crop_regions_to_pages: page=%d targets=%s n=%d keep_other_pages=%s -> %s",
            page_num, sorted(target_indexes), len(rects_mm), keep_other_pages, output_path,
        )
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

            # [MIRROR-ORIGIN 2026-07-28] Dịch toàn bộ nội dung để gốc trang về (0,0).
            #
            # Trước đây hàm chỉ nở box ra ngoài: MediaBox = [x0-b, y0-b, x1+b, y1+b].
            # Với trim bắt đầu tại (0,0) thì gốc MediaBox thành ÂM (-b, -b). Tầng đặt
            # tem của bình bản giả định trang bắt đầu tại (0,0) — `pdf_ops.page_rect()`
            # trả Rect(0, 0, w, h) và bỏ hẳn mb[0]/mb[1], còn `show_pdf_page` tính tâm
            # nguồn bằng `clip.x0 + clip_w/2` — nên mọi tem bị lệch ĐÚNG một lượng
            # bleed mỗi trục. Sai số nằm trước ma trận xoay nên ô xoay 90/180° lệch
            # theo hướng khác → trên tờ bình trông như lệch lung tung.
            # Người dùng từng phải chữa tạm bằng cách Resize đúng khổ hiện tại: resize
            # dựng trang mới ở gốc (0,0) nên nướng mất gốc âm (nhưng làm rơi TrimBox).
            #
            # Cách chuẩn hoá: gói ops trong một phép dịch, KHÔNG sửa từng ma trận con —
            # các ma trận mirror `2*x0`, `2*y1`… vẫn đúng trong hệ toạ độ gốc, chỉ cả
            # khối được dịch. BBox của Form XObject nằm ở hệ toạ độ RIÊNG của form
            # (trước phép dịch) nên phải giữ nguyên mb gốc.
            dx = b - x0
            dy = b - y0
            trim_w = x1 - x0
            trim_h = y1 - y0
            shifted_ops = [
                "q",
                f"1 0 0 1 {dx:.4f} {dy:.4f} cm",
                *ops,
                "Q",
            ]

            new_content = pikepdf.Stream(doc, "\n".join(shifted_ops).encode("ascii"))
            page[pikepdf.Name("/Contents")] = new_content

            page_box = [0.0, 0.0, trim_w + 2 * b, trim_h + 2 * b]
            trim_box = [b, b, b + trim_w, b + trim_h]
            page[pikepdf.Name("/MediaBox")] = pikepdf.Array(page_box)
            page[pikepdf.Name("/CropBox")] = pikepdf.Array(page_box)
            page[pikepdf.Name("/BleedBox")] = pikepdf.Array(page_box)
            page[pikepdf.Name("/TrimBox")] = pikepdf.Array(trim_box)
            page[pikepdf.Name("/ArtBox")] = pikepdf.Array(trim_box)

        output_name = f"{Path(file_path).stem}_mirror_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Mirror-bleed {bleed_mm}mm on {len(target_pages)} pages → {output_path}")
        return output_path
