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
from app.core.bleed_sides import normalize_bleed_sides

logger = logging.getLogger(__name__)

# 1 pt = 1/72 inch, 1 inch = 25.4 mm
PT_PER_MM = 72 / 25.4
MAX_CROP_REGIONS = 64
MIN_CROP_SIZE_PT = 1.0
MAX_CROP_DETECT_PIXELS = 20_000_000


def _pike_box_to_list(box):
    """Convert a pikepdf Array box to [x0, y0, x1, y1] floats."""
    return [float(box[0]), float(box[1]), float(box[2]), float(box[3])]


def _page_user_unit(page) -> float:
    """Hệ số đổi một đơn vị tọa độ trang sang point vật lý 1/72 inch."""
    try:
        value = float(page.get("/UserUnit", 1) or 1)
    except (TypeError, ValueError, OverflowError):
        return 1.0
    return value if math.isfinite(value) and 0 < value <= 75000 else 1.0


def _box_to_mm(box_list: list, user_unit: float = 1.0) -> dict:
    """Đổi PageBox raw sang milimét vật lý, có tính `/UserUnit`."""
    x0, y0, x1, y1 = box_list
    scale = user_unit / PT_PER_MM
    return {
        "x0": round(x0 * scale, 2),
        "y0": round(y0 * scale, 2),
        "x1": round(x1 * scale, 2),
        "y1": round(y1 * scale, 2),
        "width": round((x1 - x0) * scale, 2),
        "height": round((y1 - y0) * scale, 2),
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


def _canonicalize_rotated_page_for_mirror(doc, page) -> None:
    """Bake /Rotate vào content để mirror theo trục trang hiển thị.

    Trang đã auto-trim vẫn có thể giữ /Rotate. Chỉ nới page box cho các trang
    đó tạo ra vùng giấy trắng vì nội dung chưa được phản chiếu. Hàm này chuẩn hóa
    đúng một trang về /Rotate=0 và gốc (0, 0), đồng thời biến đổi mọi box
    phụ bằng cùng ma trận trước khi thuật toán mirror chạy.
    """
    rotate = int(page.get("/Rotate", 0) or 0) % 360
    if rotate == 0:
        return

    mx0, my0, mx1, my1 = _get_page_box(page, "/MediaBox")
    width = mx1 - mx0
    height = my1 - my0
    if rotate == 90:
        matrix = (0.0, -1.0, 1.0, 0.0, -my0, mx0 + width)
        new_width, new_height = height, width
    elif rotate == 180:
        matrix = (-1.0, 0.0, 0.0, -1.0, mx0 + width, my0 + height)
        new_width, new_height = width, height
    elif rotate == 270:
        matrix = (0.0, 1.0, -1.0, 0.0, my0 + height, -mx0)
        new_width, new_height = height, width
    else:
        raise ValueError(f"Góc xoay PDF không được hỗ trợ: {rotate}°")

    a, b, c, d, e, f = matrix
    prefix = f"q {a:.6g} {b:.6g} {c:.6g} {d:.6g} {e:.4f} {f:.4f} cm\n".encode("ascii")
    if "/Contents" in page.obj:
        page.contents_coalesce()
        stream = page.obj["/Contents"]
        stream.write(prefix + stream.read_bytes() + b"\nQ")
    else:
        page.obj[pikepdf.Name("/Contents")] = pikepdf.Stream(doc, prefix + b"Q")

    # RESIZE (audit 2026-07-31 §A.1): mọi box phải đi cùng content; nếu chỉ đổi
    # MediaBox thì trang xoay vẫn lộ dải trắng dù hình học trang nhìn có vẻ đúng.
    for box_name in ("/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"):
        raw_box = page.get(box_name)
        if raw_box is None:
            continue
        x0, y0, x1, y1 = _pike_box_to_list(raw_box)
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        xs = [a * x + c * y + e for x, y in corners]
        ys = [b * x + d * y + f for x, y in corners]
        page[pikepdf.Name(box_name)] = pikepdf.Array(
            [min(xs), min(ys), max(xs), max(ys)]
        )

    page[pikepdf.Name("/MediaBox")] = pikepdf.Array([0.0, 0.0, new_width, new_height])
    page[pikepdf.Name("/Rotate")] = 0


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


def _find_nonwhite_content_bbox(
    arr: np.ndarray,
    min_area: int,
) -> tuple[tuple[int, int, int, int], int] | None:
    """Tìm bbox pixel không trắng sau khi lọc nhiễu, không dựng lại mask theo nhãn."""
    import cv2

    # PERF (audit 2026-07-31 §RT.1): inRange tạo mask 2D trực tiếp. Biểu thức
    # np.any(arr < 248, axis=2) cũ phải cấp phát mảng bool 3D rồi reduce toàn trang.
    if arr.ndim == 3 and arr.shape[2] >= 3:
        white = cv2.inRange(
            arr[:, :, :3],
            (248, 248, 248),
            (255, 255, 255),
        )
        mask = cv2.bitwise_not(white)
    else:
        gray = arr[:, :, 0] if arr.ndim == 3 else arr
        mask = cv2.compare(gray, 248, cv2.CMP_LT)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    _count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
        mask,
        connectivity=8,
    )

    components = stats[1:]  # 0 = nền
    if components.size == 0:
        return None
    kept = components[components[:, cv2.CC_STAT_AREA] >= min_area]
    if kept.size == 0:
        return None

    # PERF (audit 2026-07-31 §RT.1): bbox hợp của stats tương đương chính xác với
    # clean[labels == i] cũ, nhưng tránh quét toàn bộ ảnh thêm một lần cho MỖI nhãn.
    left = kept[:, cv2.CC_STAT_LEFT]
    top = kept[:, cv2.CC_STAT_TOP]
    right = left + kept[:, cv2.CC_STAT_WIDTH] - 1
    bottom = top + kept[:, cv2.CC_STAT_HEIGHT] - 1
    bbox = (
        int(left.min()),
        int(top.min()),
        int(right.max()),
        int(bottom.max()),
    )
    content_pixels = int(kept[:, cv2.CC_STAT_AREA].sum(dtype=np.int64))
    return bbox, content_pixels


def _find_edge_background_content_bbox(
    arr: np.ndarray,
    min_area: int,
) -> tuple[tuple[int, int, int, int], int] | None:
    """Tìm nội dung sau khi bỏ độc lập các viền màu phẳng nối với từng cạnh.

    UIUX (feedback 2026-08-25 §TRIM.COLOR): màu và độ tin cậy được đo riêng
    cho từng cạnh. Cạnh không đủ bằng chứng giữ nguyên tuyệt đối; gradient,
    hoạ tiết hoặc nội dung có ý nghĩa chạm cạnh không bị xén.
    """
    import cv2

    if arr.ndim == 2:
        rgb = np.repeat(arr[:, :, None], 3, axis=2)
    elif arr.ndim == 3 and arr.shape[2] == 1:
        rgb = np.repeat(arr[:, :, :1], 3, axis=2)
    elif arr.ndim == 3 and arr.shape[2] >= 3:
        rgb = arr[:, :, :3]
    else:
        return None

    rgb = np.ascontiguousarray(rgb, dtype=np.uint8)
    height, width = rgb.shape[:2]
    if height < 4 or width < 4:
        return None

    edge_samples = np.concatenate((
        rgb[0, :, :3],
        rgb[-1, :, :3],
        rgb[1:-1, 0, :3],
        rgb[1:-1, -1, :3],
    )).astype(np.int16)
    overall_background = np.median(edge_samples, axis=0)
    near_white = bool(np.min(overall_background) >= 240)

    side_edges = {
        "top": rgb[0, :, :3],
        "bottom": rgb[-1, :, :3],
        "left": rgb[:, 0, :3],
        "right": rgb[:, -1, :3],
    }
    side_backgrounds: dict[str, np.ndarray] = {}
    saw_flat_side = False

    # PERF (audit 2026-08-25 §TRIM.COLOR): viền bốn cạnh cùng màu là ca
    # phổ biến. Tái dùng label-map đầu tiên để không chạy connectedComponents
    # bốn lần trên bitmap A4; cạnh khác màu vẫn được phân tích độc lập.
    cached_color: np.ndarray | None = None
    cached_tolerance = 0
    cached_labels: np.ndarray | None = None
    cached_num_labels = 0
    cached_backgrounds: dict[tuple[int, ...], np.ndarray] = {}
    profile_cache: dict[tuple[str, int, int], np.ndarray] = {}

    for side, edge in side_edges.items():
        edge_length = edge.shape[0]
        guard = max(1, int(round(edge_length * 0.10)))
        if edge_length - (2 * guard) < 4:
            sample_start, sample_stop = 0, edge_length
        else:
            sample_start, sample_stop = guard, edge_length - guard
        samples = edge[sample_start:sample_stop].astype(np.int16)
        background_rgb = np.median(samples, axis=0)
        edge_p95 = float(
            np.percentile(
                np.max(np.abs(samples - background_rgb), axis=1),
                95,
            )
        )
        if edge_p95 > 28.0:
            continue
        saw_flat_side = True

        tolerance = int(np.clip(round(edge_p95) + 8, 12, 36))

        # Gradient vuông góc có outer-line phẳng nhưng chuyển màu từ từ vào
        # trong trang. Viền dư thật phải có một bước chuyển đủ dứt khoát.
        orientation = "horizontal" if side in {"top", "bottom"} else "vertical"
        profile_key = (orientation, sample_start, sample_stop)
        base_profile = profile_cache.get(profile_key)
        if base_profile is None:
            # PERF (audit 2026-08-25 §TRIM.COLOR): median theo chiều sâu chỉ
            # cần mẫu phân bố đều; outer-line vẫn được đo đủ pixel ở trên.
            sample_count = min(33, sample_stop - sample_start)
            positions = np.linspace(
                sample_start,
                sample_stop - 1,
                num=sample_count,
                dtype=np.intp,
            )
            if orientation == "horizontal":
                base_profile = np.median(rgb[:, positions, :3], axis=1)
            else:
                base_profile = np.median(rgb[positions, :, :3], axis=0)
            profile_cache[profile_key] = base_profile
        profile = (
            base_profile[::-1]
            if side in {"bottom", "right"}
            else base_profile
        )
        profile_distance = np.max(
            np.abs(profile.astype(np.float64) - background_rgb),
            axis=1,
        )
        outside = np.flatnonzero(profile_distance > tolerance)
        if outside.size:
            transition = int(outside[0])
            if transition >= 2:
                recent = profile_distance[max(0, transition - 3):transition + 1]
                steps = np.abs(np.diff(recent))
                if steps.size and float(np.max(steps)) < 8.0:
                    continue

        can_reuse_labels = (
            cached_labels is not None
            and cached_color is not None
            and float(np.max(np.abs(background_rgb - cached_color))) <= 4.0
            and abs(tolerance - cached_tolerance) <= 4
        )
        if can_reuse_labels:
            labels = cached_labels
            num_labels = cached_num_labels
            background_cache = cached_backgrounds
        else:
            lower = np.clip(
                np.ceil(background_rgb - tolerance),
                0,
                255,
            ).astype(np.uint8)
            upper = np.clip(
                np.floor(background_rgb + tolerance),
                0,
                255,
            ).astype(np.uint8)
            candidate = cv2.inRange(
                rgb,
                tuple(int(value) for value in lower),
                tuple(int(value) for value in upper),
            )
            num_labels, labels = cv2.connectedComponents(candidate, connectivity=8)
            if num_labels <= 1:
                continue
            background_cache: dict[tuple[int, ...], np.ndarray] = {}
            if cached_labels is None:
                cached_color = background_rgb.copy()
                cached_tolerance = tolerance
                cached_labels = labels
                cached_num_labels = num_labels
                cached_backgrounds = background_cache

        if side == "top":
            seed_labels = labels[0, sample_start:sample_stop]
        elif side == "bottom":
            seed_labels = labels[-1, sample_start:sample_stop]
        elif side == "left":
            seed_labels = labels[sample_start:sample_stop, 0]
        else:
            seed_labels = labels[sample_start:sample_stop, -1]
        selected = np.unique(seed_labels)
        selected = selected[selected != 0]
        if selected.size == 0:
            continue

        selected_key = tuple(int(label) for label in selected)
        side_background = background_cache.get(selected_key)
        if side_background is None:
            lookup = np.zeros(num_labels, dtype=bool)
            lookup[selected] = True
            side_background = lookup[labels]
            background_cache[selected_key] = side_background
        side_backgrounds[side] = side_background

    if not side_backgrounds:
        # Giữ tương thích với tài liệu trắng cũ chỉ khi không cạnh màu phẳng
        # nào được nhận. Cạnh đã bị loại vì gradient thì tuyệt đối không fallback.
        if near_white and not saw_flat_side:
            return _find_nonwhite_content_bbox(arr, min_area)
        return None

    active_sides = set(side_backgrounds)
    foreground: np.ndarray | None = None
    while active_sides:
        background = np.zeros((height, width), dtype=bool)
        for side in active_sides:
            background |= side_backgrounds[side]
        foreground = (~background).astype(np.uint8) * 255

        # Dấu in/nét mảnh có component đủ lớn chạm cạnh phải giữ cạnh đó.
        count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
            foreground,
            connectivity=8,
        )
        blocked: set[str] = set()
        min_contact_depth = max(2, int(np.ceil(np.sqrt(max(1, min_area)))))
        for side in active_sides:
            if side == "top":
                touching = np.unique(labels[0, :])
                depth_stat = cv2.CC_STAT_HEIGHT
            elif side == "bottom":
                touching = np.unique(labels[-1, :])
                depth_stat = cv2.CC_STAT_HEIGHT
            elif side == "left":
                touching = np.unique(labels[:, 0])
                depth_stat = cv2.CC_STAT_WIDTH
            else:
                touching = np.unique(labels[:, -1])
                depth_stat = cv2.CC_STAT_WIDTH
            touching = touching[touching != 0]
            if any(
                stats[label, cv2.CC_STAT_AREA] >= min_area
                and stats[label, depth_stat] >= min_contact_depth
                for label in touching
                if label < count
            ):
                blocked.add(side)

        if not blocked:
            break
        active_sides -= blocked

    if not active_sides or foreground is None:
        return None

    # Tái dùng bộ lọc morphology/component hiện hữu để bỏ noise nhỏ.
    foreground_on_white = cv2.bitwise_not(foreground)
    detection = _find_nonwhite_content_bbox(foreground_on_white, min_area)
    if detection is None:
        return None
    (x0, y0, x1, y1), content_pixels = detection

    # Cạnh không được chính detector xác nhận phải giữ nguyên trong hệ pixel
    # hiển thị; _pixel_bbox_to_cropbox sẽ tự ánh xạ đúng mọi góc /Rotate.
    if "left" not in active_sides:
        x0 = 0
    if "top" not in active_sides:
        y0 = 0
    if "right" not in active_sides:
        x1 = width - 1
    if "bottom" not in active_sides:
        y1 = height - 1
    bbox = (x0, y0, x1, y1)
    if bbox == (0, 0, width - 1, height - 1):
        return None
    return bbox, content_pixels

def _normalise_crop_rects(page, rects_mm: list[dict]) -> tuple[list[float], list[list[float]]]:
    """Validate and clamp crop rectangles to the page's visible CropBox."""
    if not rects_mm:
        raise ValueError("Cần ít nhất 1 vùng crop")
    if len(rects_mm) > MAX_CROP_REGIONS:
        raise ValueError(f"Chỉ xử lý tối đa {MAX_CROP_REGIONS} vùng mỗi lần")

    media = _get_page_box(page, "/MediaBox")
    visible = _get_page_box(page, "/CropBox", fallback=media)
    vx0, vy0, vx1, vy1 = visible
    user_unit = _page_user_unit(page)
    raw_pt_per_mm = PT_PER_MM / user_unit
    min_crop_size = MIN_CROP_SIZE_PT / user_unit
    normalised: list[list[float]] = []

    for idx, rect in enumerate(rects_mm):
        try:
            values = [float(rect[key]) for key in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Vùng #{idx + 1} thiếu hoặc sai tọa độ") from exc
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"Vùng #{idx + 1} chứa tọa độ không hữu hạn")

        x0, y0, x1, y1 = (value * raw_pt_per_mm for value in values)
        x0, x1 = max(vx0, x0), min(vx1, x1)
        y0, y1 = max(vy0, y0), min(vy1, y1)
        if x1 - x0 < min_crop_size or y1 - y0 < min_crop_size:
            raise ValueError(f"Vùng #{idx + 1} nằm ngoài trang hoặc quá nhỏ")
        normalised.append([x0, y0, x1, y1])

    return visible, normalised


def _normalise_display_crop_rects(page, rects_mm: list[dict]) -> tuple[list[float], list[list[float]]]:
    """Đổi vùng mm trên trang hiển thị về CropBox raw riêng của từng trang."""
    if not rects_mm:
        raise ValueError("Cần ít nhất 1 vùng crop hiển thị")
    if len(rects_mm) > MAX_CROP_REGIONS:
        raise ValueError(f"Chỉ xử lý tối đa {MAX_CROP_REGIONS} vùng mỗi lần")

    media = _get_page_box(page, "/MediaBox")
    visible = _get_page_box(page, "/CropBox", fallback=media)
    vx0, vy0, vx1, vy1 = visible
    width, height = vx1 - vx0, vy1 - vy0
    rotation = int(page.get("/Rotate", 0) or 0) % 360
    if rotation not in (0, 90, 180, 270):
        rotation = 0
    display_width, display_height = (
        (height, width) if rotation in (90, 270) else (width, height)
    )
    user_unit = _page_user_unit(page)
    raw_pt_per_mm = PT_PER_MM / user_unit
    min_crop_size = MIN_CROP_SIZE_PT / user_unit
    normalised: list[list[float]] = []

    for idx, rect in enumerate(rects_mm):
        try:
            values = [float(rect[key]) for key in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Vùng hiển thị #{idx + 1} thiếu hoặc sai tọa độ") from exc
        if not all(math.isfinite(value) for value in values):
            raise ValueError(f"Vùng hiển thị #{idx + 1} chứa tọa độ không hữu hạn")

        dx0, dy0, dx1, dy1 = (value * raw_pt_per_mm for value in values)
        dx0, dx1 = max(0.0, dx0), min(display_width, dx1)
        dy0, dy1 = max(0.0, dy0), min(display_height, dy1)
        if dx1 - dx0 < min_crop_size or dy1 - dy0 < min_crop_size:
            raise ValueError(f"Vùng crop nằm ngoài trang hiển thị hoặc quá nhỏ ở vùng #{idx + 1}")

        # PAGEBOX (audit 2026-08-04 §W1.PB4): range/all giữ cùng tọa độ
        # hiển thị theo mm, nhưng mỗi trang phải đảo /Rotate riêng về hệ PDF raw.
        if rotation == 90:
            u0, u1, v0, v1 = dy0, dy1, dx0, dx1
        elif rotation == 180:
            u0, u1 = width - dx1, width - dx0
            v0, v1 = dy0, dy1
        elif rotation == 270:
            u0, u1 = width - dy1, width - dy0
            v0, v1 = height - dx1, height - dx0
        else:
            u0, u1 = dx0, dx1
            v0, v1 = height - dy1, height - dy0
        normalised.append([vx0 + u0, vy0 + v0, vx0 + u1, vy0 + v1])

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

    from app.core.pdfium_lock import pdfium_guard

    # KIENTRUC (audit 2026-07-29 §C.1): dò khung được gọi từ đường chạy trong thread
    # (`/preflight/detect-crop-regions`, `/preflight/page-boxes`). Toàn thân là lời gọi
    # FFI pdfium thô (FPDFPage_*) nên khóa bao cả hàm.
    with pdfium_guard("page_boxes_object_candidates"):
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
                box = [
                    float(left.value),
                    float(bottom.value),
                    float(right.value),
                    float(top.value),
                ]
                if all(math.isfinite(value) for value in box) and box[2] > box[0] and box[3] > box[1]:
                    candidates.append((box, raw_type))
            return candidates
        finally:
            pdf.close()


def _choose_structural_crop_box(
    rough: list[float],
    candidates: list[tuple[list[float], int]],
    max_trim_pt: float,
    user_unit: float = 1.0,
) -> list[float] | None:
    """Prefer a page/image/form boundary that lies just inside the rough selection."""
    import pypdfium2.raw as pdfium_c

    rx0, ry0, rx1, ry1 = rough
    rough_area = (rx1 - rx0) * (ry1 - ry0)
    # PAGEBOX (audit 2026-08-04 §W1.PB6): mọi ngưỡng nghiệp vụ là kích thước
    # vật lý; tọa độ object PDF vẫn là đơn vị raw nên phải chia `/UserUnit`.
    raw_pt_per_mm = PT_PER_MM / user_unit
    tolerance = 0.6 * raw_pt_per_mm
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
        if width < 10 * raw_pt_per_mm or height < 10 * raw_pt_per_mm:
            continue
        ratio = (width * height) / rough_area if rough_area else 0.0
        if ratio < 0.45:
            continue
        clipped = [max(rx0, x0), max(ry0, y0), min(rx1, x1), min(ry1, y1)]
        if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
            continue
        # The outermost painted boundary is safest for print: an inner form must
        # never beat a larger image/path and accidentally remove its bleed.
        # Không dùng sàn `1.0` theo raw unit: với `/UserUnit` lớn, cùng hình học
        # vật lý sẽ bị đổi điểm và có thể chọn nhầm boundary khác.
        # Sàn epsilon cũng biểu diễn theo mm vật lý, không theo raw unit.
        score_denominator = max(max_trim_pt, raw_pt_per_mm * 1e-9)
        trim_ratio = sum(max(0.0, gap) for gap in gaps) / score_denominator
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
    user_unit: float = 1.0,
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
    tolerance = 0.6 * PT_PER_MM / user_unit
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
    user_unit: float = 1.0,
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
    tolerance = 0.6 * PT_PER_MM / user_unit
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
        user_unit = _page_user_unit(page)
        rotation = int(page.get("/Rotate", 0) or 0) % 360
        if rotation not in (0, 90, 180, 270):
            rotation = 0

        page_str = str(page.obj)

        result = {
            "page": page_num,
            "total_pages": len(doc.pages),
            "mediabox": _box_to_mm(mediabox, user_unit),
            "cropbox": _box_to_mm(cropbox, user_unit),
            "trimbox": _box_to_mm(trimbox, user_unit),
            "bleedbox": _box_to_mm(bleedbox, user_unit),
            "artbox": _box_to_mm(artbox, user_unit),
            "has_trimbox": "/TrimBox" in page_str,
            "has_bleedbox": "/BleedBox" in page_str,
            "has_artbox": "/ArtBox" in page_str,
            "has_cropbox": "/CropBox" in page_str,
            # PAGEBOX (audit 2026-08-04 §W1.PB1): CropBox ở hệ PDF gốc,
            # frontend cần /Rotate để đảo đúng vùng người dùng vẽ trên trang hiển thị.
            "rotation": rotation,
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

        try:
            rect_values_mm = [float(rect_mm[key]) for key in ("x0", "y0", "x1", "y1")]
        except (KeyError, TypeError, ValueError) as exc:
            doc.close()
            raise ValueError("rect_mm thiếu hoặc sai tọa độ") from exc
        if not all(math.isfinite(value) for value in rect_values_mm):
            doc.close()
            raise ValueError("rect_mm chứa tọa độ không hữu hạn")
        x0_mm, y0_mm, x1_mm, y1_mm = rect_values_mm
        if x1_mm <= x0_mm or y1_mm <= y0_mm:
            doc.close()
            raise ValueError("rect_mm không hợp lệ (x1<=x0 hoặc y1<=y0)")

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
            raw_pt_per_mm = PT_PER_MM / _page_user_unit(page)
            x0_pt, y0_pt, x1_pt, y1_pt = (
                value * raw_pt_per_mm for value in rect_values_mm
            )
            w_pt = x1_pt - x0_pt
            h_pt = y1_pt - y0_pt
            target_rect_pt = [x0_pt, y0_pt, x1_pt, y1_pt]

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
            user_unit = _page_user_unit(page)
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
        # PDFium đi kèm PrynX trả/render theo đơn vị raw và không tự áp `/UserUnit`.
        # Nhân scale để 200 DPI vẫn là 200 DPI vật lý.
        render_scale = (200.0 / 72.0) * user_unit
        projected_pixels = visible_width * visible_height * render_scale * render_scale
        if projected_pixels > MAX_CROP_DETECT_PIXELS:
            render_scale *= math.sqrt(MAX_CROP_DETECT_PIXELS / projected_pixels)

        def ensure_render():
            nonlocal image_arr, pix_w, pix_h, render_error
            if image_arr is not None or render_error:
                return
            try:
                import pypdfium2 as pdfium
                from app.core.pdfium_lock import pdfium_guard
                check_cancelled()
                # KIENTRUC (audit 2026-07-29 §C.1): `np.array(image)` nằm TRONG khóa
                # là cố ý — nó copy pixel ra khỏi bộ đệm bitmap, phải xong trước khi
                # đóng tài liệu (giữ đúng thứ tự bản gốc).
                with pdfium_guard("page_boxes_crop_render"):
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

        max_trim_pt = float(max_trim_mm) * PT_PER_MM / user_unit
        results = []
        for rough in rough_rects:
            check_cancelled()
            # A declared BleedBox is the authoritative outer print boundary. Use
            # it only when it fits this rough region; on imposed sheets it will
            # not fit an individual item and is therefore ignored.
            detected = None
            method = "unchanged"
            if bleed_box is not None:
                detected = _choose_structural_crop_box(
                    rough, [(bleed_box, -1)], max_trim_pt, user_unit,
                )
                if detected is not None:
                    method = "bleedbox"
            if detected is None:
                detected = _choose_structural_crop_box(
                    rough, object_candidates, max_trim_pt, user_unit,
                )
                if detected is not None:
                    method = "object"
            confidence = "high" if detected is not None else "low"
            raster_suggestion = None
            if detected is None:
                ensure_render()
                if image_arr is not None:
                    detected = _detect_uniform_background_rect_box(
                        image_arr, rough, pix_w, pix_h, visible, rotate, max_trim_pt,
                        user_unit,
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
                        user_unit,
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
            changed = (
                detected is not None
                and max(trim_values) >= 0.15 * PT_PER_MM / user_unit
            )
            if not changed:
                final_rect = rough
                if raster_suggestion is None:
                    method = "unchanged"
                    confidence = "low"
                trim_values = [0.0, 0.0, 0.0, 0.0]

            results.append({
                "rect_mm": _box_to_mm(final_rect, user_unit),
                "changed": changed,
                "method": method,
                "confidence": confidence,
                "trim_mm": {
                    "left": round(trim_values[0] * user_unit / PT_PER_MM, 2),
                    "bottom": round(trim_values[1] * user_unit / PT_PER_MM, 2),
                    "right": round(trim_values[2] * user_unit / PT_PER_MM, 2),
                    "top": round(trim_values[3] * user_unit / PT_PER_MM, 2),
                },
                "safe_to_apply": bool(changed and method in ("bleedbox", "object", "background")),
                "suggested_rect_mm": (
                    _box_to_mm(raster_suggestion, user_unit)
                    if raster_suggestion is not None else None
                ),
            })

        return {
            "page": page_num,
            "cropbox": _box_to_mm(visible, user_unit),
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
        display_rects_mm: list[dict] | None = None,
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
            rects_by_index: dict[int, list[list[float]]] = {}
            if display_rects_mm is not None:
                if len(display_rects_mm) != len(rects_mm):
                    raise ValueError("Số vùng crop raw và hiển thị không khớp")
                for page in target_pages:
                    _, target_rects = _normalise_display_crop_rects(
                        check_doc.pages[page - 1], display_rects_mm,
                    )
                    rects_by_index[page - 1] = target_rects
            else:
                reference_visible, reference_rects = _normalise_crop_rects(
                    check_doc.pages[page_num - 1], rects_mm,
                )
                reference_user_unit = _page_user_unit(check_doc.pages[page_num - 1])
                rvx0, rvy0, _, _ = reference_visible
                relative_rects_mm = [
                    [
                        (x0 - rvx0) * reference_user_unit / PT_PER_MM,
                        (y0 - rvy0) * reference_user_unit / PT_PER_MM,
                        (x1 - rvx0) * reference_user_unit / PT_PER_MM,
                        (y1 - rvy0) * reference_user_unit / PT_PER_MM,
                    ]
                    for x0, y0, x1, y1 in reference_rects
                ]
                for page in target_pages:
                    target_page = check_doc.pages[page - 1]
                    target_visible = _get_page_box(
                        target_page, "/CropBox",
                        fallback=_get_page_box(target_page, "/MediaBox"),
                    )
                    tvx0, tvy0, tvx1, tvy1 = target_visible
                    target_user_unit = _page_user_unit(target_page)
                    raw_pt_per_mm = PT_PER_MM / target_user_unit
                    min_crop_size = MIN_CROP_SIZE_PT / target_user_unit
                    target_rects: list[list[float]] = []
                    for dx0_mm, dy0_mm, dx1_mm, dy1_mm in relative_rects_mm:
                        x0 = max(tvx0, tvx0 + dx0_mm * raw_pt_per_mm)
                        x1 = min(tvx1, tvx0 + dx1_mm * raw_pt_per_mm)
                        y0 = max(tvy0, tvy0 + dy0_mm * raw_pt_per_mm)
                        y1 = min(tvy1, tvy0 + dy1_mm * raw_pt_per_mm)
                        if x1 - x0 < min_crop_size or y1 - y0 < min_crop_size:
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
        Phát hiện viền dư màu phẳng và set CropBox tự động.
        Màu nền được đo độc lập ở chu vi từng trang; trường hợp mơ hồ giữ nguyên.
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

        from app.core.pdfium_lock import pdfium_guard

        doc = pikepdf.Pdf.open(file_path)
        # KIENTRUC (audit 2026-07-29 §C.1): khóa THEO TỪNG TRANG (mở/render/đóng), phần
        # cv2 + numpy dò lề để ngoài khóa — auto-trim nhiều trang không được chặn các
        # request preview khác suốt thời gian chạy.
        with pdfium_guard("auto_trim_open"):
            pdf_render = pdfium.PdfDocument(file_path)

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        # 200 DPI đủ nét cho tem nhỏ mà vẫn nhanh (dò lề, không phải xuất).
        DETECT_SCALE = 200.0 / 72.0

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]

                # Hệ quy chiếu là CROPBOX (chưa xoay); pdfium render đúng vùng
                # CropBox rồi áp /Rotate. .cropbox tự fallback về MediaBox.
                cb = _get_page_box(page, "/CropBox", fallback=_get_page_box(page, "/MediaBox"))
                rotate = int(page.get("/Rotate", 0) or 0) % 360
                user_unit = _page_user_unit(page)
                render_scale = DETECT_SCALE * user_unit
                margin_pt = margin_mm * PT_PER_MM / user_unit

                # Copy thẳng bitmap → NumPy để bỏ vòng bitmap→PIL→bytes→NumPy.
                # Mọi handle PDFium được đóng ngay trong khóa; OpenCV chạy ngoài khóa.
                with pdfium_guard("auto_trim_page_render"):
                    render_page = None
                    bitmap = None
                    try:
                        render_page = pdf_render[pnum - 1]
                        bitmap = render_page.render(scale=render_scale)
                        arr = np.array(bitmap.to_numpy(), copy=True)
                        pix_h, pix_w = arr.shape[:2]
                    finally:
                        if bitmap is not None:
                            bitmap.close()
                        if render_page is not None:
                            render_page.close()

                # Ngưỡng ~ (0.3mm)^2 ở DPI hiện tại — nhỏ hơn coi là nhiễu.
                min_side_px = max(2, int(0.3 * PT_PER_MM * DETECT_SCALE))
                min_area = min_side_px * min_side_px
                detection = _find_edge_background_content_bbox(arr, min_area)
                if detection is None:
                    continue  # Trang trống hoặc không có cạnh đủ rõ → giữ nguyên box
                (x0, y0, x1, y1), content_pixels = detection

                if logger.isEnabledFor(logging.DEBUG):
                    content_ratio = content_pixels / max(1, pix_w * pix_h) * 100
                    logger.debug(
                        "[auto-trim] page=%d render=%dx%d bbox_px=(%d,%d)-(%d,%d) "
                        "old_cb=%s content_coverage=%.1f%%",
                        pnum, pix_w, pix_h, x0, y0, x1, y1,
                        [float(v) for v in cb], content_ratio,
                    )

                new_cb = _pixel_bbox_to_cropbox(
                    x0, y0, x1, y1,
                    pix_w, pix_h, cb, rotate, margin_pt,
                )
                logger.debug(
                    "[auto-trim] page=%d new_box=%s",
                    pnum,
                    [round(v, 2) for v in new_cb],
                )
                # Set cả MediaBox lẫn CropBox → triệt để: các tool downstream
                # (resize, viewer, imposition) đọc MediaBox = vùng nội dung thực,
                # không còn viền trắng ẩn ngoài CropBox.
                page[pikepdf.Name("/MediaBox")] = pikepdf.Array(new_cb)
                page[pikepdf.Name("/CropBox")] = pikepdf.Array(new_cb)
                # Xóa TrimBox/BleedBox/ArtBox cũ (nếu có) vì chúng có thể lớn hơn
                # MediaBox mới → gây nhầm lẫn cho downstream.
                for box_name in ("/TrimBox", "/BleedBox", "/ArtBox"):
                    if pikepdf.Name(box_name) in page:
                        del page[pikepdf.Name(box_name)]

        with pdfium_guard("auto_trim_close"):
            pdf_render.close()

        output_name = f"{Path(file_path).stem}_trimmed_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(self.output_dir / output_name)
        doc.save(output_path)
        doc.close()

        logger.info(f"Auto-trimmed {len(target_pages)} pages → {output_path}")
        return output_path

    def add_bleed_from_trim(
        self,
        file_path: str,
        bleed_mm: float = 3,
        pages: list[int] | None = None,
        sides=None,
    ) -> str:
        """
        Tự động set BleedBox = TrimBox mở rộng thêm bleed_mm ở các cạnh được chọn.

        ``sides`` mặc định cả 4 cạnh (xem ``app.core.bleed_sides``); cạnh tắt giữ
        nguyên mép TrimBox.
        """
        doc = pikepdf.Pdf.open(file_path)

        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        side_l, side_r, side_b, side_t = normalize_bleed_sides(sides)

        for pnum in target_pages:
            if 1 <= pnum <= len(doc.pages):
                page = doc.pages[pnum - 1]
                bleed_pt = bleed_mm * PT_PER_MM / _page_user_unit(page)
                b_l = bleed_pt if side_l else 0.0
                b_r = bleed_pt if side_r else 0.0
                b_b = bleed_pt if side_b else 0.0
                b_t = bleed_pt if side_t else 0.0
                # TrimBox là chuẩn để cộng bleed. Nếu file CHƯA có TrimBox (vd vừa
                # qua auto_trim — chỉ set CropBox), fallback sang CropBox rồi MediaBox.
                # Trước đây fallback thẳng MediaBox → bỏ qua kết quả auto_trim (bù xén
                # quanh CẢ trang gốc thay vì vùng đã xén lề trắng).
                crop = _get_page_box(page, "/CropBox")
                trim = _get_page_box(page, "/TrimBox", fallback=crop)
                mb = _get_page_box(page, "/MediaBox")

                bleed_rect = [
                    trim[0] - b_l,
                    trim[1] - b_b,
                    trim[2] + b_r,
                    trim[3] + b_t,
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

    def add_mirror_bleed(
        self,
        file_path: str,
        bleed_mm: float = 3,
        pages: list[int] | None = None,
        sides=None,
    ) -> str:
        """
        Tạo vùng bù xén bằng cách LẬT GƯƠNG (mirror/reflect) nội dung sát mép trang
        ra ngoài vùng bleed — giữ nguyên 100% vector, không raster hoá.

        Khác hẳn add_bleed_from_trim (chỉ set BleedBox). Hàm này thực sự vẽ nội dung
        phản chiếu vào các dải cạnh + góc quanh trim box, đúng kỹ thuật "mirror bleed"
        của prepress, nên vùng bleed luôn có hình (không lộ viền trắng sau khi xén).

        ``sides`` chọn cạnh nào được bù xén (mặc định cả 4 — xem
        ``app.core.bleed_sides``). Cạnh tắt giữ nguyên mép thành phẩm: không nở khổ,
        không vẽ dải gương; góc chỉ được vẽ khi cả hai cạnh kề đều bật.

        Trim box lấy theo CropBox (kết quả auto_trim) → TrimBox → MediaBox.
        Trang có /Rotate được bake về hệ hiển thị trước khi tạo mirror để mọi cạnh
        đều có mực, không còn nhánh chỉ nới box tạo vùng giấy trắng.
        """
        doc = pikepdf.Pdf.open(file_path)
        target_pages = pages if pages else list(range(1, len(doc.pages) + 1))
        side_l, side_r, side_b, side_t = normalize_bleed_sides(sides)

        for pnum in target_pages:
            if not (1 <= pnum <= len(doc.pages)):
                continue
            page = doc.pages[pnum - 1]
            bleed_pt = bleed_mm * PT_PER_MM / _page_user_unit(page)
            if not (side_l or side_r or side_b or side_t):
                # Không chọn cạnh nào = không bù xén → rơi vào nhánh fallback chỉ set box.
                bleed_pt = 0.0
            if bleed_pt > 0:
                _canonicalize_rotated_page_for_mirror(doc, page)

            mb = _get_page_box(page, "/MediaBox")
            crop = _get_page_box(page, "/CropBox", fallback=mb)
            trim = _get_page_box(page, "/TrimBox", fallback=crop)
            x0, y0, x1, y1 = trim
            b = bleed_pt
            # Lượng nở theo TỪNG cạnh; cạnh tắt = 0 (giữ đúng mép thành phẩm).
            b_l = b if side_l else 0.0
            b_r = b if side_r else 0.0
            b_b = b if side_b else 0.0
            b_t = b if side_t else 0.0

            # Bleed 0 giữ nguyên hành vi cũ, không rewrite content hoặc /Rotate.
            if bleed_pt <= 0:
                bleed_rect = [x0 - b_l, y0 - b_b, x1 + b_r, y1 + b_t]
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
                # Cạnh/góc bị tắt cho ra dải rộng 0 → clip rỗng, bỏ hẳn cho gọn stream.
                if cw <= 0 or ch <= 0:
                    return []
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
            # 2) Các cạnh được chọn — phản chiếu qua trục cạnh tương ứng.
            ops += _draw((x0 - b_l, y0, b_l, y1 - y0), (-1, 0, 0, 1, 2 * x0, 0))   # trái  (x=x0)
            ops += _draw((x1, y0, b_r, y1 - y0),       (-1, 0, 0, 1, 2 * x1, 0))   # phải  (x=x1)
            ops += _draw((x0, y0 - b_b, x1 - x0, b_b), (1, 0, 0, -1, 0, 2 * y0))   # dưới  (y=y0)
            ops += _draw((x0, y1, x1 - x0, b_t),       (1, 0, 0, -1, 0, 2 * y1))   # trên  (y=y1)
            # 3) Góc — chỉ tồn tại khi CẢ HAI cạnh kề đều được bù xén (_draw tự bỏ
            #    qua khi một trong hai chiều = 0).
            ops += _draw((x0 - b_l, y0 - b_b, b_l, b_b), (-1, 0, 0, -1, 2 * x0, 2 * y0))  # BL
            ops += _draw((x1, y0 - b_b, b_r, b_b),       (-1, 0, 0, -1, 2 * x1, 2 * y0))  # BR
            ops += _draw((x0 - b_l, y1, b_l, b_t),       (-1, 0, 0, -1, 2 * x0, 2 * y1))  # TL
            ops += _draw((x1, y1, b_r, b_t),             (-1, 0, 0, -1, 2 * x1, 2 * y1))  # TR

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
            dx = b_l - x0
            dy = b_b - y0
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

            page_box = [0.0, 0.0, trim_w + b_l + b_r, trim_h + b_b + b_t]
            trim_box = [b_l, b_b, b_l + trim_w, b_b + trim_h]
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
