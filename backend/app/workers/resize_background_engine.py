"""Resize vừa khít và lấp vùng trống trong một lần dựng trang.

Artwork gốc vẫn là Form XObject vector. Chỉ lớp nền sinh thêm được raster hóa;
MediaBox đầu ra luôn đúng khổ đích, không đi vòng mở bleed rồi crop lại.
"""
from __future__ import annotations

import io
import logging
import math
import time
import zlib

import cv2
import numpy as np
import pikepdf

from app.core.page_boxes import (
    PageBoxesEngine,
    _canonicalize_rotated_page_for_mirror,
    _find_nonwhite_content_bbox,
    _get_page_box,
    _pixel_bbox_to_cropbox,
)
from app.core.pdfium_lock import pdfium_guard


logger = logging.getLogger(__name__)


PT_PER_MM = 72.0 / 25.4
DYNAMIC_BACKGROUND_MODES = frozenset({"mirror", "trajectory", "image", "inpaint"})
CONTENT_AWARE_BACKGROUND_MODES = DYNAMIC_BACKGROUND_MODES | {"solid", "white"}
PAGE_SIZE_MODES = frozenset({"fixed", "fixed_width", "fixed_height"})
DEFAULT_SAMPLE_INSET_MM = 0.5
DEFAULT_SEAM_OVERLAP_MM = 0.5
_SEAM_NEAR_WHITE_START = 232.0
_SEAM_NEAR_WHITE_FULL = 242.0
DETECT_DPI = 200.0


def normalize_page_size_mode(mode: str) -> str:
    value = str(mode or "fixed").strip().lower()
    if value not in PAGE_SIZE_MODES:
        raise ValueError("Cách đặt khổ trang không hợp lệ.")
    return value


def is_dynamic_background_mode(mode: str) -> bool:
    return str(mode or "").strip().lower() in DYNAMIC_BACKGROUND_MODES


def _parse_pages(apply_to: str, total: int) -> set[int]:
    value = str(apply_to or "all").strip().lower()
    if value == "all":
        return set(range(total))
    if value == "even":
        return set(range(1, total, 2))
    if value == "odd":
        return set(range(0, total, 2))

    selected: set[int] = set()
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            raw_start, _, raw_end = part.partition("-")
            if not raw_start.strip().isdigit():
                continue
            start = int(raw_start)
            end = int(raw_end) if raw_end.strip().isdigit() else total
            for page_number in range(start, end + 1):
                if 1 <= page_number <= total:
                    selected.add(page_number - 1)
        elif part.isdigit() and 1 <= int(part) <= total:
            selected.add(int(part) - 1)
    return selected


def _render_path_page_rgb(path: str, page_index: int, scale: float) -> np.ndarray:
    import pypdfium2 as pdfium

    with pdfium_guard("resize_background_detect"):
        document = pdfium.PdfDocument(path)
        page = None
        bitmap = None
        try:
            page = document[page_index]
            bitmap = page.render(scale=scale)
            bgra = bitmap.to_numpy().copy()
        finally:
            if bitmap is not None:
                bitmap.close()
            if page is not None:
                page.close()
            document.close()
    return cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGB)


def _render_pdf_bytes_rgb(
    data: bytes,
    scale: float,
    crop_px: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> np.ndarray:
    import pypdfium2 as pdfium

    with pdfium_guard("resize_background_source"):
        document = pdfium.PdfDocument(data)
        page = None
        bitmap = None
        try:
            page = document[0]
            # pypdfium2 dùng ceil(crop * scale). Trừ nửa pixel để lượng crop
            # trái/dưới/phải/trên khớp đúng lưới pixel hình học đã tính.
            render_crop = tuple(
                0.0 if pixels <= 0 else (float(pixels) - 0.5) / scale
                for pixels in crop_px
            )
            bitmap = page.render(scale=scale, crop=render_crop)
            bgra = bitmap.to_numpy().copy()
        finally:
            if bitmap is not None:
                bitmap.close()
            if page is not None:
                page.close()
            document.close()
    return cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGB)


def _one_page_bytes(page) -> bytes:
    document = pikepdf.Pdf.new()
    stream = io.BytesIO()
    try:
        document.pages.append(page)
        document.save(stream)
        return stream.getvalue()
    finally:
        document.close()


def _resize_rgb(image: np.ndarray, width: int, height: int) -> np.ndarray:
    if image.shape[1] == width and image.shape[0] == height:
        return image
    shrinking = width < image.shape[1] or height < image.shape[0]
    interpolation = cv2.INTER_AREA if shrinking else cv2.INTER_LANCZOS4
    return cv2.resize(image, (width, height), interpolation=interpolation)


def _edge_canvas(
    content_rgb: np.ndarray,
    target_width: int,
    target_height: int,
    *,
    left: int,
    right: int,
    bottom: int,
    top: int,
    mode: str,
    inset_px: int,
    px_per_mm: float,
) -> np.ndarray:
    inset_x = min(max(0, inset_px), max(0, (content_rgb.shape[1] - 1) // 2))
    inset_y = min(max(0, inset_px), max(0, (content_rgb.shape[0] - 1) // 2))

    if mode in {"inpaint", "trajectory"}:
        from app.workers.sticker_engine import (
            _rectangle_smooth_color_fill,
            _rectangle_trajectory_color_fill,
        )

        # RESIZE (audit 2026-08-01 §RT.14): dùng đúng engine của Xén vuông góc;
        # trajectory giữ ranh giới dải màu, inpaint ưu tiên chuyển tiếp mềm.
        fill_rectangle = (
            _rectangle_trajectory_color_fill
            if mode == "trajectory"
            else _rectangle_smooth_color_fill
        )
        canvas = fill_rectangle(
            content_rgb,
            max(left, right, bottom, top),
            max(inset_x, inset_y),
            px_per_mm,
            pads=(left, right, bottom, top),
        )
    else:
        core = content_rgb[
            inset_y:content_rgb.shape[0] - inset_y if inset_y else content_rgb.shape[0],
            inset_x:content_rgb.shape[1] - inset_x if inset_x else content_rgb.shape[1],
        ]
        border_type = cv2.BORDER_REPLICATE
        if mode == "mirror" and core.shape[0] > 1 and core.shape[1] > 1:
            border_type = cv2.BORDER_REFLECT_101
        canvas = cv2.copyMakeBorder(
            core,
            top + inset_y,
            bottom + inset_y,
            left + inset_x,
            right + inset_x,
            border_type,
        )

    # Sai số làm tròn phải được hấp thụ ở mép phải/dưới, không được đổi khổ đích.
    canvas = canvas[:target_height, :target_width]
    missing_bottom = max(0, target_height - canvas.shape[0])
    missing_right = max(0, target_width - canvas.shape[1])
    if missing_bottom or missing_right:
        canvas = cv2.copyMakeBorder(
            canvas, 0, missing_bottom, 0, missing_right, cv2.BORDER_REPLICATE
        )
    return np.ascontiguousarray(canvas)


def _near_white_seam_alpha(rgb: np.ndarray) -> np.ndarray:
    """Chỉ phủ halo gần trắng; giữ nguyên mực màu thật trong dải lẹm."""
    channel_floor = np.min(rgb[:, :, :3], axis=2).astype(np.float32)
    whiteness = np.clip(
        (channel_floor - _SEAM_NEAR_WHITE_START)
        / (_SEAM_NEAR_WHITE_FULL - _SEAM_NEAR_WHITE_START),
        0.0,
        1.0,
    )
    return np.rint(whiteness * 255.0).astype(np.uint8)


def _add_background_image(
    document: pikepdf.Pdf,
    page,
    rgb: np.ndarray,
    content_rgb: np.ndarray,
    *,
    content_left: int,
    content_top: int,
    content_width: int,
    content_height: int,
    target_width_pt: float,
    target_height_pt: float,
    tuck_px: int,
) -> bytes:
    from app.workers.sticker_engine import _make_srgb_colorspace

    height, width = rgb.shape[:2]
    alpha = np.full((height, width), 255, dtype=np.uint8)
    content_right = min(width, max(0, content_left + content_width))
    content_bottom = min(height, max(0, content_top + content_height))
    content_left = min(content_right, max(0, content_left))
    content_top = min(content_bottom, max(0, content_top))
    content_width = content_right - content_left
    content_height = content_bottom - content_top
    alpha[content_top:content_bottom, content_left:content_right] = 0

    # RESIZE (audit 2026-08-01 §A.4): lớp trên chỉ làm sạch halo/AA gần trắng
    # trong vùng bảo hiểm 0,5 mm. Barcode, hairline và dải màu thật giữ nguyên
    # từ Form vector; cạnh không có nền kéo ra tuyệt đối không bị phủ.
    if content_width > 0 and content_height > 0:
        source = content_rgb[:content_height, :content_width]
        tuck_x = min(max(1, tuck_px), source.shape[1])
        tuck_y = min(max(1, tuck_px), source.shape[0])
        guard_x = min(max(0, tuck_x - 1), max(1, round(tuck_x / 3.0)))
        guard_y = min(max(0, tuck_y - 1), max(1, round(tuck_y / 3.0)))
        kernel_x = np.ones((1, guard_x * 2 + 1), dtype=np.uint8)
        kernel_y = np.ones((guard_y * 2 + 1, 1), dtype=np.uint8)

        if content_top > 0:
            seam = _near_white_seam_alpha(source[:tuck_y])
            if guard_y:
                seam = cv2.dilate(seam, kernel_y)
            region = alpha[
                content_top:content_top + tuck_y,
                content_left:content_right,
            ]
            np.maximum(region, seam[:, :region.shape[1]], out=region)

        if content_bottom < height:
            seam = _near_white_seam_alpha(source[-tuck_y:])
            if guard_y:
                seam = cv2.dilate(seam, kernel_y)
            region = alpha[
                content_bottom - tuck_y:content_bottom,
                content_left:content_right,
            ]
            np.maximum(region, seam[:, :region.shape[1]], out=region)

        if content_left > 0:
            seam = _near_white_seam_alpha(source[:, :tuck_x])
            if guard_x:
                seam = cv2.dilate(seam, kernel_x)
            region = alpha[
                content_top:content_bottom,
                content_left:content_left + tuck_x,
            ]
            np.maximum(region, seam[:region.shape[0]], out=region)

        if content_right < width:
            seam = _near_white_seam_alpha(source[:, -tuck_x:])
            if guard_x:
                seam = cv2.dilate(seam, kernel_x)
            region = alpha[
                content_top:content_bottom,
                content_right - tuck_x:content_right,
            ]
            np.maximum(region, seam[:region.shape[0]], out=region)

    # Giữ RGB quanh mọi pixel alpha có thể nhìn thấy, chỉ zero phần chắc chắn ẩn.
    x0 = min(width, max(0, content_left + tuck_px))
    y0 = min(height, max(0, content_top + tuck_px))
    x1 = min(width, max(x0, content_right - tuck_px))
    y1 = min(height, max(y0, content_bottom - tuck_px))

    # PERF (audit 2026-08-01 §RT.9): phần RGB nằm sâu trong vùng alpha=0
    # không bao giờ hiển thị. Ghi nó về 0 giúp Flate nén nhanh và nhỏ hơn,
    # nhưng vẫn giữ halo 2 px quanh mép để nội suy SMask không đổi màu.
    rgb_for_storage = rgb
    halo_px = 2
    sparse_x0 = x0 + halo_px
    sparse_y0 = y0 + halo_px
    sparse_x1 = x1 - halo_px
    sparse_y1 = y1 - halo_px
    if sparse_x1 > sparse_x0 and sparse_y1 > sparse_y0:
        rgb_for_storage = rgb.copy()
        rgb_for_storage[sparse_y0:sparse_y1, sparse_x0:sparse_x1] = 0

    mask = pikepdf.Stream(document, zlib.compress(alpha.tobytes(), 1))
    mask.Type = pikepdf.Name.XObject
    mask.Subtype = pikepdf.Name.Image
    mask.Width = width
    mask.Height = height
    mask.ColorSpace = pikepdf.Name.DeviceGray
    mask.BitsPerComponent = 8
    mask.Filter = pikepdf.Name.FlateDecode
    mask.Interpolate = True

    image = pikepdf.Stream(document, zlib.compress(rgb_for_storage.tobytes(), 1))
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = width
    image.Height = height
    image.ColorSpace = _make_srgb_colorspace(document)
    image.BitsPerComponent = 8
    image.Filter = pikepdf.Name.FlateDecode
    image.Interpolate = True
    image.SMask = mask

    name = page.add_resource(image, pikepdf.Name.XObject)
    command = (
        f"q {target_width_pt:.5f} 0 0 {target_height_pt:.5f} 0 0 cm "
        f"{str(name)} Do Q"
    ).encode("ascii")
    page.contents_add(pikepdf.Stream(document, command))
    return command


def resize_pages_with_background(
    source_path: str,
    output_path: str,
    target_w_mm: float,
    target_h_mm: float,
    *,
    scale_mode: str = "fit",
    apply_to: str = "all",
    background_mode: str = "image",
    background_dpi: int = 300,
    background_color: str = "#ffffff",
    sample_inset_mm: float = DEFAULT_SAMPLE_INSET_MM,
    page_size_mode: str = "fixed",
    resize_by_content: bool = False,
    transparent_page_indexes: set[int] | None = None,
) -> str:
    """Tính khổ theo trang rồi đặt artwork vector lên canvas đích.

    Trang opaque giữ content-aware hiện có. Trang có transparency chỉ bỏ vùng alpha
    bên ngoài khi người dùng bật ``resize_by_content``; mặc định dùng toàn page box.
    """
    # PERF (audit 2026-08-01 §RT.12): đo từng stage nhưng không đổi worker/DPI.
    perf_started = time.perf_counter()
    stage_seconds = {
        "detect": 0.0,
        "crop": 0.0,
        "background_render": 0.0,
        "background_canvas": 0.0,
        "background_encode": 0.0,
        "form": 0.0,
        "save": 0.0,
    }
    background_pages = 0
    mode = str(background_mode or "").strip().lower()
    if mode not in CONTENT_AWARE_BACKGROUND_MODES:
        raise ValueError("Kiểu nền vùng trống không hợp lệ.")
    size_mode = normalize_page_size_mode(page_size_mode)
    if transparent_page_indexes is None:
        from app.core.pdf_actions_native import detect_transparent_pages

        transparent_indexes = {
            page_number - 1
            for page_number in detect_transparent_pages(source_path)
            if page_number > 0
        }
    else:
        transparent_indexes = {
            int(index)
            for index in transparent_page_indexes
            if isinstance(index, int) and index >= 0
        }
    if size_mode != "fixed" and scale_mode != "fit":
        raise ValueError(
            "Giữ tỷ lệ từng trang chỉ hỗ trợ kiểu Thu vừa khít."
        )
    if size_mode == "fixed" and scale_mode not in {"fit", "center_no_scale"}:
        raise ValueError("Kéo nền động chỉ hỗ trợ vừa khít hoặc giữ nguyên ở giữa.")

    try:
        requested_width_mm = float(target_w_mm)
        requested_height_mm = float(target_h_mm)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Khổ đích không hợp lệ.") from exc
    width_valid = math.isfinite(requested_width_mm) and 1.0 <= requested_width_mm <= 5000.0
    height_valid = math.isfinite(requested_height_mm) and 1.0 <= requested_height_mm <= 5000.0
    if (
        (size_mode == "fixed" and not (width_valid and height_valid))
        or (size_mode == "fixed_width" and not width_valid)
        or (size_mode == "fixed_height" and not height_valid)
    ):
        raise ValueError("Khổ đích không hợp lệ.")

    try:
        dpi = int(background_dpi)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("DPI nền không hợp lệ.") from exc
    if dpi < 72:
        raise ValueError("DPI nền phải từ 72 trở lên.")
    inset_mm = float(sample_inset_mm)
    if not math.isfinite(inset_mm):
        inset_mm = DEFAULT_SAMPLE_INSET_MM
    inset_mm = max(0.0, min(5.0, inset_mm))
    requested_width_pt = requested_width_mm * PT_PER_MM
    requested_height_pt = requested_height_mm * PT_PER_MM

    source = pikepdf.Pdf.open(source_path)
    output = pikepdf.Pdf.new()
    try:
        selected = _parse_pages(apply_to, len(source.pages))
        selected_total = len(selected)
        processed_selected = 0
        logger.info(
            "[RESIZE_TIMING] engine_start mode=%s page_size_mode=%s pages=%d "
            "selected=%d dpi=%d resize_by_content=%s transparent_pages=%d",
            mode, size_mode, len(source.pages), selected_total, dpi,
            bool(resize_by_content), len(transparent_indexes),
        )
        try:
            from app.workers.sticker_engine import _copy_output_intents

            _copy_output_intents(source, output)
        except Exception:
            pass

        for page_index, source_page in enumerate(source.pages):
            if page_index not in selected:
                output.pages.append(source_page)
                continue

            page_started = time.perf_counter()
            page_stage = {
                "detect": 0.0,
                "crop": 0.0,
                "background_render": 0.0,
                "background_canvas": 0.0,
                "background_encode": 0.0,
                "form": 0.0,
            }
            detect_started = time.perf_counter()
            visible = _get_page_box(
                source_page,
                "/CropBox",
                fallback=_get_page_box(source_page, "/MediaBox"),
            )
            rotation = int(source_page.get("/Rotate", 0) or 0) % 360
            page_has_transparency = page_index in transparent_indexes
            # RESIZE (audit 2026-08-03 §TR.1/§TR.2): alpha ngoài con tem là một
            # phần có chủ đích của khổ PNG/PDF. Chỉ crop nó khi user bật lựa chọn;
            # trang opaque vẫn giữ hành vi xén trắng/nền động đã có.
            should_detect_content = not page_has_transparency or bool(resize_by_content)
            if not should_detect_content:
                crop = visible
            else:
                detected_rgb = _render_path_page_rgb(
                    source_path, page_index, DETECT_DPI / 72.0
                )
                min_side_px = max(
                    2,
                    int(0.3 * PT_PER_MM * (DETECT_DPI / 72.0)),
                )
                detection = _find_nonwhite_content_bbox(
                    detected_rgb,
                    min_side_px * min_side_px,
                )
                if detection is None:
                    crop = visible
                else:
                    (x0, y0, x1, y1), _pixels = detection
                    crop = _pixel_bbox_to_cropbox(
                        x0,
                        y0,
                        x1,
                        y1,
                        detected_rgb.shape[1],
                        detected_rgb.shape[0],
                        visible,
                        rotation,
                        0.0,
                    )
            page_stage["detect"] = time.perf_counter() - detect_started
            stage_seconds["detect"] += page_stage["detect"]

            crop_started = time.perf_counter()

            PageBoxesEngine._physical_crop_page(
                source,
                source_page,
                crop[0],
                crop[1],
                crop[2] - crop[0],
                crop[3] - crop[1],
            )
            _canonicalize_rotated_page_for_mirror(source, source_page)
            media = _get_page_box(source_page, "/MediaBox")
            content_width_pt = media[2] - media[0]
            content_height_pt = media[3] - media[1]
            if content_width_pt <= 0 or content_height_pt <= 0:
                raise ValueError(f"Trang {page_index + 1} có contentBox rỗng.")
            page_stage["crop"] = time.perf_counter() - crop_started
            stage_seconds["crop"] += page_stage["crop"]

            # RESIZE (audit 2026-08-01 §R.2): khổ khóa một chiều phải được
            # tính SAU khi dò contentBox và chuẩn hóa /Rotate của chính trang đó.
            if size_mode == "fixed_width":
                target_width_pt = requested_width_pt
                fit_scale = target_width_pt / content_width_pt
                target_height_pt = content_height_pt * fit_scale
            elif size_mode == "fixed_height":
                target_height_pt = requested_height_pt
                fit_scale = target_height_pt / content_height_pt
                target_width_pt = content_width_pt * fit_scale
            else:
                target_width_pt = requested_width_pt
                target_height_pt = requested_height_pt
                if scale_mode == "fit":
                    fit_scale = min(
                        target_width_pt / content_width_pt,
                        target_height_pt / content_height_pt,
                    )
                else:
                    fit_scale = 1.0

            actual_width_mm = target_width_pt / PT_PER_MM
            actual_height_mm = target_height_pt / PT_PER_MM
            if not (
                math.isfinite(actual_width_mm)
                and math.isfinite(actual_height_mm)
                and 1.0 <= actual_width_mm <= 5000.0
                and 1.0 <= actual_height_mm <= 5000.0
            ):
                raise ValueError(
                    f"Trang {page_index + 1} có khổ tự tính ngoài khoảng 1–5000 mm."
                )
            draw_width_pt = content_width_pt * fit_scale
            draw_height_pt = content_height_pt * fit_scale
            offset_x_pt = (target_width_pt - draw_width_pt) / 2.0
            offset_y_pt = (target_height_pt - draw_height_pt) / 2.0

            target_page = output.add_blank_page(
                page_size=(target_width_pt, target_height_pt)
            )
            if mode == "solid":
                from app.workers.pdf_tools_engine import _background_rgb

                bg_r, bg_g, bg_b = _background_rgb(mode, background_color)
                background = (
                    f"q {bg_r:.6f} {bg_g:.6f} {bg_b:.6f} rg "
                    f"0 0 {target_width_pt:.5f} {target_height_pt:.5f} re f Q"
                )
                target_page.contents_add(
                    pikepdf.Stream(output, background.encode("ascii"))
                )
            background_overlay_command: bytes | None = None
            has_gap = (
                draw_width_pt < target_width_pt - 0.01
                or draw_height_pt < target_height_pt - 0.01
            )
            if has_gap and mode in DYNAMIC_BACKGROUND_MODES:
                target_width_px = max(1, round(target_width_pt * dpi / 72.0))
                target_height_px = max(1, round(target_height_pt * dpi / 72.0))
                full_content_width_px = max(1, round(draw_width_pt * dpi / 72.0))
                full_content_height_px = max(1, round(draw_height_pt * dpi / 72.0))

                # RESIZE (audit 2026-08-01 §A.3): center_no_scale có thể tràn
                # một trục nhưng vẫn dư vùng trống ở trục kia. Cắt raster nền theo
                # giao với canvas thay vì bỏ toàn bộ nền khi offset mang giá trị âm.
                placed_left_px = round(offset_x_pt * dpi / 72.0)
                placed_top_px = round(offset_y_pt * dpi / 72.0)
                visible_left_px = max(0, placed_left_px)
                visible_top_px = max(0, placed_top_px)
                visible_right_px = min(
                    target_width_px,
                    placed_left_px + full_content_width_px,
                )
                visible_bottom_px = min(
                    target_height_px,
                    placed_top_px + full_content_height_px,
                )
                if (
                    visible_right_px <= visible_left_px
                    or visible_bottom_px <= visible_top_px
                ):
                    raise ValueError(
                        f"Trang {page_index + 1} không giao với khổ đích."
                    )

                # Render đúng độ phân giải của lớp nền đầu ra. Không hard-cap
                # hệ số phóng trên máy mạnh vì sẽ làm nền mờ trong khi
                # artwork Form XObject phía trên vẫn sắc nét.
                source_left_px = visible_left_px - placed_left_px
                source_top_px = visible_top_px - placed_top_px
                source_right_px = source_left_px + (
                    visible_right_px - visible_left_px
                )
                source_bottom_px = source_top_px + (
                    visible_bottom_px - visible_top_px
                )
                background_render_started = time.perf_counter()

                left_px = visible_left_px
                right_px = target_width_px - visible_right_px
                top_px = visible_top_px
                bottom_px = target_height_px - visible_bottom_px
                content_width_px = visible_right_px - visible_left_px
                content_height_px = visible_bottom_px - visible_top_px

                # PERF (audit 2026-08-01 §RT.11): center_no_scale có thể tràn
                # rất xa khỏi canvas. Crop ngay trong PDFium để không render rồi
                # giữ vào RAM phần raster chắc chắn bị bỏ đi.
                crop_left_px = max(0, source_left_px)
                crop_top_px = max(0, source_top_px)
                crop_right_px = max(0, full_content_width_px - source_right_px)
                crop_bottom_px = max(0, full_content_height_px - source_bottom_px)
                render_scale = (dpi / 72.0) * fit_scale
                content_rgb = _render_pdf_bytes_rgb(
                    _one_page_bytes(source_page),
                    render_scale,
                    (
                        crop_left_px,
                        crop_bottom_px,
                        crop_right_px,
                        crop_top_px,
                    ),
                )
                content_rgb = _resize_rgb(
                    content_rgb,
                    content_width_px,
                    content_height_px,
                )
                page_stage["background_render"] = (
                    time.perf_counter() - background_render_started
                )
                stage_seconds["background_render"] += page_stage["background_render"]

                background_canvas_started = time.perf_counter()
                canvas = _edge_canvas(
                    content_rgb,
                    target_width_px,
                    target_height_px,
                    left=left_px,
                    right=right_px,
                    bottom=bottom_px,
                    top=top_px,
                    mode=mode,
                    inset_px=round(inset_mm * dpi / 25.4),
                    px_per_mm=dpi / 25.4,
                )
                page_stage["background_canvas"] = (
                    time.perf_counter() - background_canvas_started
                )
                stage_seconds["background_canvas"] += page_stage["background_canvas"]

                background_encode_started = time.perf_counter()
                background_overlay_command = _add_background_image(
                    output,
                    target_page,
                    canvas,
                    content_rgb,
                    content_left=visible_left_px,
                    content_top=visible_top_px,
                    content_width=content_width_px,
                    content_height=content_height_px,
                    target_width_pt=target_width_pt,
                    target_height_pt=target_height_pt,
                    tuck_px=max(
                        1,
                        round(DEFAULT_SEAM_OVERLAP_MM * dpi / 25.4),
                    ),
                )
                page_stage["background_encode"] = (
                    time.perf_counter() - background_encode_started
                )
                stage_seconds["background_encode"] += page_stage["background_encode"]
                background_pages += 1

            form_started = time.perf_counter()
            form = source_page.as_form_xobject()
            form_name = target_page.add_resource(form, pikepdf.Name.XObject)
            draw = (
                f"q {fit_scale:.8f} 0 0 {fit_scale:.8f} "
                f"{offset_x_pt:.5f} {offset_y_pt:.5f} cm {str(form_name)} Do Q"
            )
            target_page.contents_add(pikepdf.Stream(output, draw.encode("ascii")))
            if background_overlay_command is not None:
                # Tái sử dụng cùng Image + SMask làm lớp cleanup sau Form;
                # content stream nhỏ này không nhân đôi dữ liệu ảnh nền.
                target_page.contents_add(
                    pikepdf.Stream(output, background_overlay_command)
                )
            page_stage["form"] = time.perf_counter() - form_started
            stage_seconds["form"] += page_stage["form"]

            processed_selected += 1
            if (
                selected_total <= 20
                or processed_selected == 1
                or processed_selected % 10 == 0
                or processed_selected == selected_total
            ):
                logger.info(
                    "[RESIZE_TIMING] page_done page=%d/%d detect_ms=%.1f crop_ms=%.1f "
                    "bg_render_ms=%.1f bg_canvas_ms=%.1f bg_encode_ms=%.1f "
                    "form_ms=%.1f total_ms=%.1f",
                    page_index + 1, len(source.pages),
                    page_stage["detect"] * 1000.0,
                    page_stage["crop"] * 1000.0,
                    page_stage["background_render"] * 1000.0,
                    page_stage["background_canvas"] * 1000.0,
                    page_stage["background_encode"] * 1000.0,
                    page_stage["form"] * 1000.0,
                    (time.perf_counter() - page_started) * 1000.0,
                )

        from app.workers.pdf_tools_engine import save_pdf_compat

        # SMask được chuẩn hóa từ PDF 1.4; giữ cả version cao hơn của file nguồn
        # để header không mô tả thấp hơn các feature thực tế trong object graph.
        output_version = max("1.4", str(source.pdf_version or "1.3"))
        save_started = time.perf_counter()
        save_pdf_compat(output, output_path, min_version=output_version)
        stage_seconds["save"] = time.perf_counter() - save_started
        logger.info(
            "[RESIZE_TIMING] engine_done mode=%s page_size_mode=%s selected=%d "
            "background_pages=%d dpi=%d detect_ms=%.1f crop_ms=%.1f "
            "bg_render_ms=%.1f bg_canvas_ms=%.1f bg_encode_ms=%.1f "
            "form_ms=%.1f save_ms=%.1f total_ms=%.1f",
            mode, size_mode, selected_total, background_pages, dpi,
            stage_seconds["detect"] * 1000.0,
            stage_seconds["crop"] * 1000.0,
            stage_seconds["background_render"] * 1000.0,
            stage_seconds["background_canvas"] * 1000.0,
            stage_seconds["background_encode"] * 1000.0,
            stage_seconds["form"] * 1000.0,
            stage_seconds["save"] * 1000.0,
            (time.perf_counter() - perf_started) * 1000.0,
        )
        return output_path
    finally:
        output.close()
        source.close()
