"""Orchestrator nhận diện nguồn: ưu tiên dữ liệu chắc chắn trước AI."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import time
import zipfile

import cv2
import numpy as np
import pikepdf
from PIL import Image, ImageDraw, ImageFilter
import pytest

from app.core import sticker_sheet_session as session_store
from app.core.sticker_background import BackgroundInfo
from app.core.sticker_sheet_session import (
    abort_source_detection,
    begin_source_detection,
    confirm_source_session,
    create_source_session,
    promote_source_session,
)
from app.workers.sticker_source_inspector import inspect_sticker_source
from app.workers.sticker_cutline_preview import build_sticker_cutline_preview
from app.workers.cut_export.cut_layer_extractor import CutContour, ExtractResult
from app.workers.sticker_sheet_export import export_sticker_sheet
from app.workers.sticker_source_pipeline import (
    StickerSourcePipelineError,
    _analysis_from_alpha,
    _cut_contour_alpha,
    _recover_single_composite_background,
    _render_pdf_page,
    _simple_bg_preview_needs_geometry_upgrade,
    build_legacy_single_page_approved_contour,
    detect_sticker_source,
)
from app.workers.sticker_engine import (
    StickerEngine,
    _alpha_override_geometry,
    _approved_contour_override,
    _build_adaptive_edge_color_source_mask,
    build_alpha_cutline_geometry,
)
import app.workers.sticker_engine as sticker_engine_module


COREL_CUT_FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "app" / "workers" / "cut_export" / "tests" / "fixtures" / "corel_cut_sample.pdf"
)


@pytest.fixture(autouse=True)
def isolated_sessions(tmp_path, monkeypatch):
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)
    monkeypatch.setattr(session_store, "SESSION_ROOT", tmp_path / "source_pipeline_sessions")
    yield
    for session_id in list(session_store._SESSIONS):
        session_store.close_session(session_id)


def _create_session(path: Path):
    inspection = inspect_sticker_source(str(path), path.name)
    return create_source_session(
        source_path=path,
        original_name=path.name,
        inspection=inspection,
    )


def _two_sticker_image(*, alpha: bool) -> Image.Image:
    background = (255, 255, 255, 0 if alpha else 255)
    image = Image.new("RGBA", (160, 100), background)
    image.paste((220, 40, 80, 255), (12, 15, 65, 80))
    image.paste((40, 120, 220, 255), (92, 20, 148, 82))
    return image


def _full_page_textured_artwork() -> Image.Image:
    """Một nhãn chữ nhật kín trang, có nhiều chi tiết rời bên trong.

    Fixture mô phỏng ảnh quảng cáo thành phẩm: ảnh/phông phủ tới cả bốn mép,
    còn mô hình tách nền chỉ chọn nhầm vài chữ và quả thành nhiều component.
    """
    width, height = 320, 180
    yy, xx = np.indices((height, width))
    rgb = np.empty((height, width, 3), dtype=np.uint8)
    rgb[:, :, 0] = np.clip(224 - yy * 0.45 + (xx // 16 % 2) * 18, 0, 255)
    rgb[:, :, 1] = np.clip(164 - yy * 0.34 + (xx // 13 % 3) * 20, 0, 255)
    rgb[:, :, 2] = np.clip(76 + yy * 0.25 + (xx // 11 % 2) * 24, 0, 255)
    image = Image.fromarray(rgb, "RGB")
    draw = ImageDraw.Draw(image)
    # Cây/trái cây và các dải chữ phủ khắp nền; không có một nền ngoài tem.
    for left, top, color in (
        (-18, -12, (28, 112, 38)),
        (36, 8, (241, 126, 20)),
        (252, -10, (22, 104, 34)),
        (286, 28, (248, 142, 24)),
        (-22, 118, (38, 104, 42)),
    ):
        draw.ellipse((left, top, left + 66, top + 58), fill=color)
    draw.rectangle((0, 96, width, 132), fill=(54, 116, 52))
    draw.rectangle((0, 132, width, height), fill=(235, 164, 102))
    draw.rounded_rectangle((72, 24, 245, 64), radius=12, fill=(246, 150, 24))
    draw.rectangle((86, 76, 236, 88), fill=(250, 245, 218))
    draw.rectangle((104, 101, 254, 112), fill=(248, 214, 72))
    draw.rounded_rectangle((44, 145, 276, 170), radius=10, fill=(250, 248, 224))
    return image


def _fake_internal_art_fragments(
    source_image: Image.Image,
    *,
    model: str,
    alpha_threshold: int,
):
    """AI sai: chỉ lấy hai chi tiết nội bộ của một nhãn kín trang."""
    from app.workers.sticker_source_pipeline import _analysis_from_alpha

    alpha = np.zeros((source_image.height, source_image.width), dtype=np.uint8)
    alpha[24:64, 72:245] = 255
    alpha[28:76, 275:319] = 255
    return _analysis_from_alpha(
        source_image,
        alpha,
        model=model,
        alpha_threshold=alpha_threshold,
    )


def _save_near_white_fragmented_sheet(path: Path) -> list[tuple[int, int, int, int]]:
    """Tạo tờ tem trắng trên nền 253 giống ca JPEG thật: dò thường chỉ còn bóng/chữ."""
    image = Image.new("RGB", (640, 440), (253, 253, 253))
    draw = ImageDraw.Draw(image)
    bodies: list[tuple[int, int, int, int]] = []
    for row in range(2):
        for column in range(3):
            left = 24 + column * 205
            top = 24 + row * 205
            right = left + 165
            bottom = top + 155
            bodies.append((left, top, right, bottom))

            draw.rounded_rectangle(
                (left + 5, top + 6, right + 5, bottom + 6),
                radius=22,
                fill=(205, 205, 205),
            )
            draw.ellipse(
                (right - 20, top + 48, right + 18, top + 88),
                fill=(205, 205, 205),
            )
            draw.rounded_rectangle(
                (left, top, right, bottom),
                radius=22,
                fill=(255, 255, 255),
            )
            draw.ellipse(
                (right - 25, top + 42, right + 13, top + 82),
                fill=(255, 255, 255),
            )
            draw.rounded_rectangle(
                (left + 24, top + 28, left + 68, top + 72),
                radius=8,
                fill=(220, 45, 90),
            )
            draw.ellipse(
                (left + 78, top + 30, left + 122, top + 74),
                fill=(40, 120, 220),
            )
            draw.rounded_rectangle(
                (left + 35, top + 91, left + 132, top + 124),
                radius=7,
                fill=(245, 158, 18),
            )
    image.save(path, format="JPEG", quality=95, subsampling=0)
    return bodies


def _save_near_white_soft_shadow_sheet(path: Path) -> list[tuple[int, int, int, int]]:
    """Tem viền trắng + bóng MỀM trên tờ gần trắng — ca người dùng báo 2026-08-16.

    Khác `_save_near_white_fragmented_sheet` đúng một điểm: bóng không phải một mảng xám
    phẳng 205 mà là gradient tắt dần, nên có một vành luma 249–252 nằm sát viền trắng.
    Vành đó tối hơn nền (không bị trừ làm nền) nhưng sáng hơn ngưỡng bóng (không bị bóc)
    → nhánh phục hồi xác định không được phép tin, phải nhường cho AI.
    """
    image = Image.new("RGB", (640, 440), (253, 253, 253))
    draw = ImageDraw.Draw(image)
    bodies: list[tuple[int, int, int, int]] = []
    for row in range(2):
        for column in range(3):
            left = 24 + column * 205
            top = 24 + row * 205
            right = left + 165
            bottom = top + 155
            bodies.append((left, top, right, bottom))

            # Gradient bóng: vòng ngoài cùng sáng 252 rồi tối dần vào 205.
            for step in range(10, -1, -1):
                level = 205 + int(round((252 - 205) * (step / 10.0)))
                grow = step
                draw.rounded_rectangle(
                    (
                        left + 5 - grow,
                        top + 6 - grow,
                        right + 5 + grow,
                        bottom + 6 + grow,
                    ),
                    radius=22 + grow,
                    fill=(level, level, level),
                )
            draw.rounded_rectangle(
                (left, top, right, bottom), radius=22, fill=(255, 255, 255),
            )
            draw.rounded_rectangle(
                (left + 24, top + 28, left + 68, top + 72), radius=8, fill=(220, 45, 90),
            )
            draw.ellipse(
                (left + 78, top + 30, left + 122, top + 74), fill=(40, 120, 220),
            )
            draw.rounded_rectangle(
                (left + 35, top + 91, left + 132, top + 124), radius=7, fill=(245, 158, 18),
            )
    image.save(path, format="JPEG", quality=95, subsampling=0)
    return bodies


def _composite_single_sticker_fixture() -> tuple[Image.Image, np.ndarray]:
    """Một tem nhiều mảng màu nằm trong vỏ sáng, tương tự ca Desktop 2026-08-20."""
    image = Image.new("RGB", (240, 160), (253, 253, 253))
    rgb = np.asarray(image, dtype=np.uint8).copy()
    mask = np.zeros((160, 240), dtype=np.uint8)

    # Vỏ mỏng tách khỏi artwork; các mảnh bên dưới cố ý có bbox chồng nhau nhưng
    # chưa nối pixel để mô phỏng biên trắng/halo sau raster hoá.
    cv2.rectangle(mask, (18, 12), (222, 148), 255, 2)
    cv2.rectangle(mask, (30, 30), (145, 100), 255, -1)
    cv2.rectangle(mask, (145, 30), (170, 40), 255, -1)
    cv2.rectangle(mask, (150, 70), (215, 140), 255, -1)
    cv2.rectangle(mask, (190, 45), (215, 65), 255, -1)
    cv2.rectangle(mask, (35, 105), (55, 115), 255, -1)
    cv2.rectangle(mask, (72, 105), (92, 115), 255, -1)
    cv2.rectangle(mask, (110, 105), (130, 115), 255, -1)

    rgb[mask > 0] = (50, 180, 220)
    rgb[70:141, 150:216][mask[70:141, 150:216] > 0] = (245, 190, 30)
    rgb[45:66, 190:216][mask[45:66, 190:216] > 0] = (40, 150, 70)
    rgb[105:116, 35:56][mask[105:116, 35:56] > 0] = (220, 40, 80)
    rgb[105:116, 72:93][mask[105:116, 72:93] > 0] = (180, 80, 220)
    rgb[105:116, 110:131][mask[105:116, 110:131] > 0] = (250, 140, 30)
    return Image.fromarray(rgb, "RGB"), mask


def _directional_shadow_composite_fixture(
    shadow_kind: str = "directional",
) -> tuple[
    Image.Image,
    BackgroundInfo,
    np.ndarray,
    np.ndarray,
]:
    """Tem có offset trắng và bóng xám lệch xuống-phải.

    Mask quan sát cố ý giống ảnh raster thực tế: nền trắng làm mất phần offset
    trắng, chỉ còn các mảng artwork màu và dải bóng trung tính. ``expected`` là
    mép ngoài offset trắng, không phải mép ngoài của bóng.
    """
    height, width = 400, 400
    rgb = np.full((height, width, 3), 253, dtype=np.uint8)
    expected = np.zeros((height, width), dtype=np.uint8)
    cv2.rectangle(expected, (42, 38), (312, 300), 255, thickness=-1)
    cv2.circle(expected, (42, 62), 14, 255, thickness=-1)
    cv2.circle(expected, (312, 276), 14, 255, thickness=-1)
    # Bóng đổ lệch xuống-phải; một viền mỏng mọi phía giúp component shell
    # bao được các mảng artwork nhưng phần lớn diện tích vẫn có hướng rõ rệt.
    if shadow_kind == "symmetric":
        shadow_outer = cv2.dilate(
            expected,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)),
            iterations=1,
        )
    else:
        shifted = cv2.warpAffine(
            expected,
            np.float32([[1, 0, 4], [0, 1, 3]]),
            (width, height),
            flags=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        shadow_outer = cv2.dilate(
            shifted,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)),
            iterations=1,
        )
        shadow_outer = cv2.max(
            shadow_outer,
            cv2.dilate(
                expected,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
                iterations=1,
            ),
        )
    shadow = (shadow_outer > 0) & (expected == 0)
    yy, xx = np.indices((height, width))
    if shadow_kind == "colored":
        rgb[shadow] = (188, 205, 232)
    elif shadow_kind == "dark":
        rgb[shadow] = (70, 70, 70)
    else:
        shadow_luma = np.clip(
            235 - ((xx + yy) % 5) * 4,
            190,
            245,
        ).astype(np.uint8)
        for channel in range(3):
            rgb[:, :, channel][shadow] = shadow_luma[shadow]

    rgb[expected > 0] = (255, 255, 255)
    # Artwork màu phủ gần tới mép trong của offset. Hai mảng nhỏ nằm trong
    # bbox mảng lớn nhưng có moat trắng, mô phỏng các mảnh bị nền tách rời.
    core = cv2.erode(
        expected,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)),
    )
    lobe_a = np.zeros_like(expected)
    cv2.rectangle(lobe_a, (178, 74), (204, 101), 255, thickness=-1)
    lobe_a = cv2.bitwise_and(lobe_a, core)
    lobe_b = np.zeros_like(expected)
    cv2.rectangle(lobe_b, (244, 126), (268, 154), 255, thickness=-1)
    lobe_b = cv2.bitwise_and(lobe_b, core)
    main = core.copy()
    moat_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    main[lobe_a > 0] = 0
    main[cv2.dilate(lobe_a, moat_kernel) > 0] = 0
    main[lobe_b > 0] = 0
    main[cv2.dilate(lobe_b, moat_kernel) > 0] = 0
    fragments = np.zeros_like(expected)
    for patch, color in (
        (main, (244, 188, 26)),
        (lobe_a, (38, 164, 220)),
        (lobe_b, (28, 164, 87)),
    ):
        fragments = cv2.bitwise_or(fragments, patch)
        rgb[patch > 0] = color

    observed = np.where((shadow | (fragments > 0)), 255, 0).astype(np.uint8)
    background = BackgroundInfo(
        color=(253, 253, 253),
        tolerance=14,
        foreground_mask=observed,
        confidence=0.90,
        is_near_white=True,
        is_flat=True,
    )
    return Image.fromarray(rgb, "RGB"), background, expected, shadow.astype(np.uint8) * 255


def _directional_shadow_multi_fixture() -> tuple[
    Image.Image,
    BackgroundInfo,
    np.ndarray,
    np.ndarray,
    tuple[tuple[int, int], ...],
]:
    """Hai tem composite, mỗi tem có offset trắng và bóng lệch riêng."""
    one, single_background, expected, shadow = (
        _directional_shadow_composite_fixture()
    )
    width, height = one.size
    origins = ((10, 10), (width + 30, 10))
    canvas = Image.new("RGB", (width * 2 + 40, height + 40), (253, 253, 253))
    observed = np.zeros((height + 40, width * 2 + 40), dtype=np.uint8)
    for left, top in origins:
        canvas.paste(one, (left, top))
        observed[top:top + height, left:left + width] = np.maximum(
            observed[top:top + height, left:left + width],
            np.asarray(single_background.foreground_mask, dtype=np.uint8),
        )
    background = BackgroundInfo(
        color=single_background.color,
        tolerance=single_background.tolerance,
        foreground_mask=observed,
        confidence=single_background.confidence,
        is_near_white=single_background.is_near_white,
        is_flat=single_background.is_flat,
        corner_p95=2.0,
    )
    return canvas, background, expected, shadow, origins


def _save_pdf(path: Path, size: tuple[float, float], *, user_unit: float = 1.0) -> None:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=size)
    page.obj["/UserUnit"] = user_unit
    document.save(path)
    document.close()


def _save_multi_page_pdf(path: Path, page_count: int = 3) -> None:
    document = pikepdf.Pdf.new()
    for index in range(page_count):
        document.add_blank_page(page_size=(120 + index * 10, 90 + index * 10))
    document.save(path)
    document.close()


def _save_soft_mask_pdf(path: Path) -> None:
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(100, 80))
    alpha = pikepdf.Stream(document, bytes([255]) * (60 * 40))
    alpha.Type = pikepdf.Name.XObject
    alpha.Subtype = pikepdf.Name.Image
    alpha.Width = 60
    alpha.Height = 40
    alpha.ColorSpace = pikepdf.Name.DeviceGray
    alpha.BitsPerComponent = 8
    image = pikepdf.Stream(document, bytes([220, 40, 80]) * (60 * 40))
    image.Type = pikepdf.Name.XObject
    image.Subtype = pikepdf.Name.Image
    image.Width = 60
    image.Height = 40
    image.ColorSpace = pikepdf.Name.DeviceRGB
    image.BitsPerComponent = 8
    image.SMask = document.make_indirect(alpha)
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=document.make_indirect(image)),
    )
    page.Contents = document.make_stream(b"q 60 0 0 40 20 20 cm /Im0 Do Q")
    document.save(path)
    document.close()


def _save_full_page_image_pdf(
    path: Path,
    image_sizes: tuple[tuple[int, int], ...],
    *,
    vector_pages: frozenset[int] = frozenset(),
    leading_noop_operators: bool = False,
) -> None:
    """Tạo PDF giống luồng Viewer: mỗi trang chỉ có một ảnh phủ kín trang."""
    document = pikepdf.Pdf.new()
    for page_number, (width, height) in enumerate(image_sizes, start=1):
        page = document.add_blank_page(page_size=(width, height))
        image = pikepdf.Stream(document, bytes([220, 40, 80]) * (width * height))
        image.Type = pikepdf.Name.XObject
        image.Subtype = pikepdf.Name.Image
        image.Width = width
        image.Height = height
        image.ColorSpace = pikepdf.Name.DeviceRGB
        image.BitsPerComponent = 8
        page.Resources = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=document.make_indirect(image)),
        )
        content = f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii")
        if leading_noop_operators:
            # ReportLab/PDF producer thường ghi các toán tử text rỗng trước ảnh.
            # Chúng không đổi nội dung nhưng làm nhánh render phân tích lên 300 DPI.
            content = b"1 0 0 1 0 0 cm BT ET " + content
        if page_number in vector_pages:
            content += f" 0 0 m {width} {height} l S".encode("ascii")
        page.Contents = document.make_stream(content)
    document.save(path)
    document.close()


def _save_full_page_rgb_pdf(path: Path, image: Image.Image) -> None:
    """Nhúng đúng một ảnh RGB phủ kín trang, giữ quy ước 1 px = 1 pt."""
    rgb = image.convert("RGB")
    width, height = rgb.size
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(width, height))
    xobject = pikepdf.Stream(document, rgb.tobytes())
    xobject.Type = pikepdf.Name.XObject
    xobject.Subtype = pikepdf.Name.Image
    xobject.Width = width
    xobject.Height = height
    xobject.ColorSpace = pikepdf.Name.DeviceRGB
    xobject.BitsPerComponent = 8
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=document.make_indirect(xobject)),
    )
    page.Contents = document.make_stream(
        f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii")
    )
    document.save(path)
    document.close()


def _pdf_circle_path(center_x: float, center_y: float, radius: float) -> str:
    handle = radius * 0.5522847498
    return (
        f"{center_x + radius} {center_y} m "
        f"{center_x + radius} {center_y + handle} "
        f"{center_x + handle} {center_y + radius} {center_x} {center_y + radius} c "
        f"{center_x - handle} {center_y + radius} "
        f"{center_x - radius} {center_y + handle} {center_x - radius} {center_y} c "
        f"{center_x - radius} {center_y - handle} "
        f"{center_x - handle} {center_y - radius} {center_x} {center_y - radius} c "
        f"{center_x + handle} {center_y - radius} "
        f"{center_x + radius} {center_y - handle} {center_x + radius} {center_y} c h"
    )


def _save_multi_artwork_vector_pdf(
    path: Path,
    *,
    round_indices: frozenset[int] = frozenset(),
    decorative_circle_indices: frozenset[int] = frozenset(),
) -> None:
    """Tạo một tờ PDF vector nền trắng có năm artwork tách rời, không CutContour."""
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(600, 400))
    # Năm hình có khoảng hở rõ ràng để connected-components không nhập thành một tem.
    rectangles = (
        (35, 245, 120, 105, "0.86 0.12 0.18"),
        (175, 245, 120, 105, "0.12 0.42 0.86"),
        (315, 245, 120, 105, "0.12 0.68 0.42"),
        (105, 55, 120, 105, "0.88 0.56 0.08"),
        (375, 55, 120, 105, "0.48 0.18 0.78"),
    )
    commands = ["1 1 1 rg 0 0 600 400 re f"]
    for index, (x, y, width, height, _color) in enumerate(rectangles, start=1):
        color = rectangles[index - 1][4]
        if index in round_indices:
            commands.append(
                f"{color} rg "
                + _pdf_circle_path(
                    x + width / 2.0,
                    y + height / 2.0,
                    min(width, height) * 0.47,
                )
                + " f"
            )
        else:
            commands.append(f"{color} rg {x} {y} {width} {height} re f")
            if index in decorative_circle_indices:
                commands.append(
                    "1 1 1 RG 3 w "
                    + _pdf_circle_path(
                        x + width / 2.0,
                        y + height / 2.0,
                        min(width, height) * 0.40,
                    )
                    + " S"
                )
    page.obj["/Resources"] = pikepdf.Dictionary()
    page.obj["/Contents"] = document.make_stream(
        ("\n".join(commands) + "\n").encode("ascii")
    )
    document.save(path)
    document.close()


def _save_vector_pdf_with_alpha_silhouettes(path: Path) -> None:
    """Tạo năm tem vector trên nền trong suốt, gồm ba tem tròn có banner nhô."""
    document = pikepdf.Pdf.new()
    page = document.add_blank_page(page_size=(600, 400))
    shapes = (
        (35, 245, 120, 105, "0.86 0.12 0.18", False),
        (175, 245, 120, 105, "0.12 0.42 0.86", True),
        (315, 245, 120, 105, "0.12 0.68 0.42", True),
        (105, 55, 120, 105, "0.88 0.56 0.08", True),
        (375, 55, 120, 105, "0.48 0.18 0.78", False),
    )
    commands: list[str] = []
    for x, y, width, height, color, has_banner in shapes:
        radius = min(width, height) * 0.43
        center_x = x + width / 2.0
        center_y = y + height * 0.57
        commands.append(
            f"{color} rg " + _pdf_circle_path(center_x, center_y, radius) + " f"
        )
        if has_banner:
            # Banner chồng vào đáy vòng tròn và nhô sang hai bên. Đây là oracle
            # của tem 1A2: vòng tròn chỉ là thân chính, không phải đường dao cuối.
            commands.append(
                f"{color} rg "
                f"{x} {y + 7} m "
                f"{x + width} {y + 7} l "
                f"{x + width - 15} {y + 34} l "
                f"{x + 15} {y + 34} l h f"
            )
    page.obj["/Resources"] = pikepdf.Dictionary()
    page.obj["/Contents"] = document.make_stream(
        ("\n".join(commands) + "\n").encode("ascii")
    )
    document.save(path)
    document.close()


def test_auto_uses_clean_alpha_without_ai(tmp_path, monkeypatch):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "alpha"
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == 2
    assert np.count_nonzero(detected.analysis.uncertainty) == 0


def test_auto_uses_simple_background_without_ai_and_keeps_topology(tmp_path, monkeypatch):
    source = tmp_path / "white-bg.png"
    _two_sticker_image(alpha=False).convert("RGB").save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "simple-bg"
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == 2
    assert [item.bbox for item in detected.analysis.instances] == [
        (12, 15, 53, 65),
        (92, 20, 56, 62),
    ]


def test_page_box_dung_mask_kin_toan_trang_va_bo_qua_moi_detector(
    tmp_path,
    monkeypatch,
):
    """Giữ nền trắng tắt: page-box phải đi thẳng vào fitter từ mask kín."""
    source = tmp_path / "page-box.pdf"
    _save_full_page_image_pdf(source, ((120, 80),), vector_pages=frozenset({1}))
    session = _create_session(source)

    def forbidden_detector(*_args, **_kwargs):
        raise AssertionError("page-box không được gọi detector khác")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        forbidden_detector,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        forbidden_detector,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._cut_contour_alpha",
        forbidden_detector,
    )

    detected = detect_sticker_source(session, strategy="page-box", page_number=1)

    assert detected.boundary_source == "page-box"
    assert detected.strategy_confidence == 1.0
    assert detected.needs_review is False
    assert detected.vector_geometry_ref is None
    assert np.array_equal(detected.analysis.alpha, np.full_like(detected.analysis.alpha, 255))
    assert np.array_equal(detected.analysis.labels, np.ones_like(detected.analysis.labels))
    assert detected.analysis.instances[0].bbox == (0, 0, detected.analysis.width, detected.analysis.height)

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    assert promoted is not None
    preview = build_sticker_cutline_preview(
        promoted,
        page_number=1,
        base_revision=1,
        edits=[],
        dpi=detected.dpi[0] if detected.dpi else 72,
        dpi_y=detected.dpi[1] if detected.dpi else 72,
        offset_mm=0,
        bleed_mm=0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1,
    )
    assert len(preview["paths"]) == 1
    assert preview["paths"][0]["d"].startswith("M ")
    assert preview["paths"][0]["d"].endswith(" Z")


@pytest.mark.parametrize("strategy", ["page-box", "alpha"])
def test_page_box_giu_giay_trang_va_alpha_khong_bi_ep_nen(tmp_path, strategy):
    """Giữ trang phải ghép Alpha lên giấy trắng; dò Alpha vẫn giữ nền trong suốt."""
    source = tmp_path / "transparent-black.png"
    image = Image.new("RGBA", (80, 60), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (20, 15, 60, 45))
    image.paste((0, 64, 128, 128), (18, 15, 20, 45))
    original = np.asarray(image, dtype=np.uint8).copy()
    image.save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)

    detected = detect_sticker_source(session, strategy=strategy)

    if strategy == "alpha":
        assert detected.boundary_source == "alpha"
        assert detected.analysis.rgba[0, 0, 3] == 0
        assert tuple(detected.analysis.rgba[20, 19]) == (0, 64, 128, 128)
        assert np.array_equal(np.asarray(detected.source_image), original)
        return

    alpha = original[:, :, 3:4].astype(np.int32)
    expected_rgb = (
        (original[:, :, :3].astype(np.int32) * alpha + 255 * (255 - alpha) + 127) // 255
    ).astype(np.uint8)
    expected = np.dstack((expected_rgb, np.full((60, 80), 255, dtype=np.uint8)))
    assert detected.boundary_source == "page-box"
    assert tuple(detected.analysis.rgba[0, 0]) == (255, 255, 255, 255)
    assert tuple(detected.analysis.rgba[20, 19]) == (127, 159, 191, 255)
    assert tuple(detected.analysis.rgba[20, 30]) == (255, 0, 0, 255)
    assert np.array_equal(detected.analysis.rgba, expected)
    assert np.array_equal(np.asarray(detected.source_image), expected)
    assert np.all(detected.analysis.labels == 1)

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    assert promoted is not None
    with Image.open(promoted.analysis_source_path) as analysis_source:
        assert np.array_equal(np.asarray(analysis_source.convert("RGBA")), expected)
    confirmed = confirm_source_session(session.session_id, page_number=1)
    assert confirmed is not None
    result = export_sticker_sheet(
        confirmed, edits=[], dpi=300, dpi_y=300, offset_mm=0, bleed_mm=0,
        output_format="png_zip", crop_to_sticker=True,
    )
    assert result.sticker_count == 1
    with zipfile.ZipFile(result.path) as archive:
        names = archive.namelist()
        assert len(names) == 1 and names[0].endswith(".png")
        with archive.open(names[0]) as stream, Image.open(stream) as exported:
            assert np.array_equal(np.asarray(exported.convert("RGBA")), expected)
    with Image.open(source) as unchanged_source:
        assert np.array_equal(np.asarray(unchanged_source), original)


def test_auto_mot_tem_dung_ai_cho_hinh_hoc_va_giu_mau_nen_khi_xuat(
    tmp_path,
    monkeypatch,
):
    """Tách nhiều tem: một silhouette nền phẳng không được xuất mask nhị phân."""
    source = tmp_path / "multi-mode-single-sticker.jpg"
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    draw = ImageDraw.Draw(image)
    draw.ellipse((38, 28, 282, 212), fill=(255, 232, 232))
    draw.ellipse((44, 34, 276, 206), fill=(170, 120, 120))
    draw.ellipse((45, 35, 275, 205), fill=(78, 12, 10))
    image.save(source, format="JPEG", quality=95)
    session = _create_session(source)
    ai_calls: list[str] = []

    def fake_ai(source_image: Image.Image, _model: str) -> Image.Image:
        ai_calls.append("ai")
        rgba = source_image.convert("RGBA")
        alpha = Image.new("L", source_image.size, 0)
        ImageDraw.Draw(alpha).ellipse((38, 28, 282, 212), fill=255)
        rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(radius=1.5)))
        return rgba

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )
    detected = detect_sticker_source(session, strategy="auto")

    assert ai_calls == ["ai"]
    assert detected.boundary_source == "ai"
    assert detected.background_rgb == (254, 254, 254)
    assert detected.background_tolerance >= 1
    assert len(detected.analysis.instances) == 1
    assert np.any(
        (detected.analysis.alpha > 0) & (detected.analysis.alpha < 255)
    )

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    assert promoted is not None
    confirmed = confirm_source_session(session.session_id, page_number=1)
    assert confirmed is not None

    captured: list[dict[str, object]] = []

    def capture_adaptive(*args, **kwargs):
        source_mask, selected_peel = _build_adaptive_edge_color_source_mask(
            *args,
            **kwargs,
        )
        image_arg = args[1]
        captured.append({
            "background_rgb": kwargs.get("background_rgb"),
            "background_tolerance": kwargs.get("background_tolerance"),
            "selected_peel": selected_peel,
            "colors": image_arg[source_mask > 0, :3].copy(),
        })
        return source_mask, selected_peel

    monkeypatch.setattr(
        "app.workers.sticker_engine._build_adaptive_edge_color_source_mask",
        capture_adaptive,
    )
    result = export_sticker_sheet(
        confirmed,
        edits=[],
        dpi=72,
        dpi_y=72,
        offset_mm=0,
        bleed_mm=2,
        output_format="pdf",
        cut_mode="original",
        corner_style="round",
        fill_holes=True,
        crop_to_sticker=True,
        bleed_color_type="image",
        shape_mode="contour",
        draw_cut_contour=True,
        preserve_existing_cut=False,
    )

    assert result.sticker_count == 1
    assert result.path.is_file()
    assert captured
    sample = captured[0]
    assert sample["background_rgb"] == (254, 254, 254)
    assert int(sample["background_tolerance"]) >= 1
    assert float(np.median(sample["colors"][:, 1])) < 60
    cache = confirmed.pages[1].cutline_export_cache
    assert isinstance(cache, dict)
    instances = cache.get("instances")
    assert isinstance(instances, list) and len(instances) == 1
    groups = instances[0]["path_groups"]
    assert len(groups) == 1
    segment_count = sum(
        len(group["exterior"])
        + sum(len(interior) for interior in group.get("interiors", ()))
        for group in groups
    )
    assert segment_count < 120


def test_composite_background_giu_du_mau_va_tao_mot_duong_be_an_toan():
    """Vỏ sáng + artwork nhiều màu không được để AI làm lõm silhouette."""
    image, foreground_mask = _composite_single_sticker_fixture()
    recovered = _recover_single_composite_background(
        image,
        BackgroundInfo(
            color=(253, 253, 253),
            tolerance=12,
            foreground_mask=foreground_mask,
            confidence=0.90,
            is_near_white=True,
            is_flat=True,
        ),
        model="birefnet-lite",
        alpha_threshold=128,
    )

    assert recovered is not None
    assert len(recovered.instances) == 1
    assert "simple-bg-composite-recovered" in recovered.warnings
    assert np.count_nonzero(recovered.alpha) > np.count_nonzero(foreground_mask) * 0.9
    # Các mảng vàng/xanh/đỏ đều nằm trong vùng được giữ lại.
    assert recovered.alpha[90, 180] > 0
    assert recovered.alpha[55, 202] > 0
    assert recovered.alpha[110, 45] > 0


def test_composite_directional_shadow_dung_o_me_offset_trang():
    """Bóng lệch phải bị loại, đường bế phải ôm mép offset trắng thật."""
    image, background, expected, shadow = _directional_shadow_composite_fixture()
    recovered = _recover_single_composite_background(
        image,
        background,
        model="birefnet-lite",
        alpha_threshold=128,
        dpi=(300.0, 300.0),
    )

    assert recovered is not None
    assert len(recovered.instances) == 1
    actual = recovered.labels > 0
    expected_bool = expected > 0
    shadow_bool = shadow > 0
    intersection = np.count_nonzero(actual & expected_bool)
    union = np.count_nonzero(actual | expected_bool)
    assert intersection / float(max(1, union)) >= 0.985
    assert np.count_nonzero(actual & expected_bool) / float(
        max(1, np.count_nonzero(expected_bool))
    ) >= 0.998
    assert np.count_nonzero(actual & shadow_bool) / float(
        max(1, np.count_nonzero(shadow_bool))
    ) <= 0.02


@pytest.mark.parametrize("shadow_kind", ["symmetric", "dark", "colored"])
def test_composite_shadow_guard_khong_xoa_khung_hoac_vien_artwork(shadow_kind):
    """Khung đều, bóng đen hoặc viền màu không được bóc như drop shadow."""
    image, _background, _expected, shadow = _directional_shadow_composite_fixture(
        shadow_kind,
    )
    # Dùng mask quan sát từ fixture để giữ đúng topology composite sau khi đổi
    # màu/kiểu bóng; nền vẫn là trắng phẳng như ảnh khách gửi.
    observed = shadow.copy()
    rgb = np.asarray(image, dtype=np.uint8)
    non_background = np.max(np.abs(
        rgb.astype(np.int16) - np.asarray((253, 253, 253), dtype=np.int16)
    ), axis=2) > 14
    observed = np.where(non_background, 255, 0).astype(np.uint8)
    background = BackgroundInfo(
        color=(253, 253, 253),
        tolerance=14,
        foreground_mask=observed,
        confidence=0.90,
        is_near_white=True,
        is_flat=True,
    )
    recovered = _recover_single_composite_background(
        image,
        background,
        model="birefnet-lite",
        alpha_threshold=128,
        dpi=(300.0, 300.0),
    )
    assert recovered is not None
    assert "simple-bg-drop-shadow-removed" not in recovered.warnings
    assert np.count_nonzero((recovered.labels > 0) & (shadow > 0)) > 0


def test_auto_preview_directional_shadow_dung_cung_mask_deterministic(
    tmp_path,
    monkeypatch,
):
    """Cổng preview dùng đúng mask đã khử bóng và không gọi BiRefNet."""
    image, background, expected, shadow = _directional_shadow_composite_fixture()
    source = tmp_path / "directional-shadow.png"
    image.save(source, format="PNG")
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: background,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._looks_like_fragmented_sticker_sheet",
        lambda _analysis: True,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("preview có mép trắng + bóng lệch không được gọi AI")
        ),
    )

    detected = detect_sticker_source(session, strategy="auto", preview_only=True)

    assert detected.boundary_source == "simple-bg"
    assert "simple-bg-drop-shadow-removed" in detected.warnings
    actual = detected.analysis.labels > 0
    assert np.count_nonzero(actual & (expected > 0)) / float(
        max(1, np.count_nonzero(expected))
    ) >= 0.998
    assert np.count_nonzero(actual & (shadow > 0)) / float(
        max(1, np.count_nonzero(shadow))
    ) <= 0.02


@pytest.mark.parametrize("preview_only", [True, False])
def test_auto_tach_nhieu_tem_khu_bong_lech_tren_tung_container(
    tmp_path,
    monkeypatch,
    preview_only,
):
    """Hai chế độ preview và nhận diện đầy đủ phải dùng chung mask nhiều tem."""
    image, background, expected, shadow, origins = (
        _directional_shadow_multi_fixture()
    )
    source = tmp_path / "multi-directional-shadow.png"
    image.save(source, format="PNG")
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: background,
    )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("tem nhiều có offset/bóng rõ không được gọi AI")
        ),
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=preview_only,
    )

    assert detected.boundary_source == "simple-bg"
    assert "simple-bg-drop-shadow-removed" in detected.warnings
    assert len(detected.analysis.instances) == 2
    actual = detected.analysis.labels > 0
    for left, top in origins:
        actual_crop = actual[top:top + expected.shape[0], left:left + expected.shape[1]]
        shadow_crop = shadow > 0
        expected_bool = expected > 0
        intersection = np.count_nonzero(actual_crop & expected_bool)
        union = np.count_nonzero(actual_crop | expected_bool)
        assert intersection / float(max(1, union)) >= 0.985
        assert np.count_nonzero(actual_crop & shadow_crop) / float(
            max(1, np.count_nonzero(shadow_crop))
        ) <= 0.02


def test_composite_shadow_optional_buffer_failure_nhuong_nhan_dien_cu(
    monkeypatch,
):
    """Thiếu buffer ở cổng khử bóng không được biến preview thành HTTP 500."""
    image, background, _expected, _shadow = _directional_shadow_composite_fixture()

    def fail_shadow(*_args, **_kwargs):
        raise MemoryError("shadow distance buffer")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._recover_composite_white_offset_from_shadow",
        fail_shadow,
    )
    recovered = _recover_single_composite_background(
        image,
        background,
        model="birefnet-lite",
        alpha_threshold=128,
        dpi=(300.0, 300.0),
    )
    assert recovered is not None
    assert "simple-bg-drop-shadow-removed" not in recovered.warnings


def test_auto_composite_background_duoc_dung_thay_vi_ai(
    tmp_path,
    monkeypatch,
):
    image, foreground_mask = _composite_single_sticker_fixture()
    source = tmp_path / "composite-sticker.png"
    image.save(source, format="PNG")
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: BackgroundInfo(
            color=(253, 253, 253),
            tolerance=12,
            foreground_mask=foreground_mask,
            confidence=0.90,
            is_near_white=True,
            is_flat=True,
        ),
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("tem composite an toàn không được gọi AI")
        ),
    )

    detected = detect_sticker_source(session, strategy="auto")

    assert detected.boundary_source == "simple-bg"
    assert "simple-bg-composite-recovered" in detected.warnings
    assert len(detected.analysis.instances) == 1


def test_legacy_composite_background_dung_cung_artifact_va_khong_goi_ai(
    tmp_path,
    monkeypatch,
):
    image, foreground_mask = _composite_single_sticker_fixture()
    source = tmp_path / "composite-sticker.pdf"
    _save_full_page_rgb_pdf(source, image)

    def fake_background(rgb):
        assert rgb.shape[:2] == foreground_mask.shape
        return BackgroundInfo(
            color=(253, 253, 253),
            tolerance=12,
            foreground_mask=foreground_mask,
            confidence=0.90,
            is_near_white=True,
            is_flat=True,
        )

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        fake_background,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("legacy phải dùng artifact composite đã duyệt")
        ),
    )

    captured: dict[str, float] = {}
    original_fit = sticker_engine_module.build_alpha_cutline_geometry

    def capture_fit(alpha, **kwargs):
        captured["fidelity"] = float(kwargs["cutline_fidelity"])
        return original_fit(alpha, **kwargs)

    monkeypatch.setattr(
        sticker_engine_module,
        "build_alpha_cutline_geometry",
        capture_fit,
    )

    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=2.0,
        corner_style="round",
        fill_holes=True,
    )

    assert approved is not None
    assert approved.boundary_source == "simple-bg"
    assert approved.edge_background_rgb == (253, 253, 253)
    assert len(approved.path_groups) == 1
    assert captured["fidelity"] == 95.0


@pytest.mark.parametrize("source_kind", ["raster", "pdf"])
def test_preview_only_mot_tem_nen_phang_bo_qua_buoc_nang_hinh_hoc_ai(
    tmp_path,
    monkeypatch,
    source_kind,
):
    """Preview classic dùng mask nền phẳng ngay; luồng mặc định vẫn tự nâng AI."""
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(image).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    if source_kind == "pdf":
        source = tmp_path / "fast-preview.pdf"
        _save_full_page_rgb_pdf(source, image)
    else:
        source = tmp_path / "fast-preview.jpg"
        image.save(source, format="JPEG", quality=95)
    session = _create_session(source)

    def forbidden_ai(*_args, **_kwargs):
        raise AssertionError("preview_only không được nâng simple-bg sang AI")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        forbidden_ai,
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=True,
    )

    assert detected.boundary_source == "simple-bg"
    assert len(detected.analysis.instances) == 1
    assert detected.background_rgb == (254, 254, 254)

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    assert promoted is not None
    dpi_x, dpi_y = detected.dpi or (300.0, 300.0)
    preview = build_sticker_cutline_preview(
        promoted,
        page_number=1,
        base_revision=1,
        edits=[],
        dpi=dpi_x,
        dpi_y=dpi_y,
        offset_mm=0.0,
        bleed_mm=2.0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50.0,
        cutline_fidelity=50.0,
        curve_tension=50.0,
        min_detail_area_mm2=1.0,
    )
    # Proxy ổn định cho preview nhẹ: không khóa wall-clock CI nhưng chặn việc
    # mask deterministic quay lại hàng trăm đoạn Bézier/rời thành nhiều path.
    assert len(preview["paths"]) == 1
    assert int(preview["segment_count"]) < 120


def test_preview_only_nang_ai_khi_mask_nen_phang_co_rang_cua() -> None:
    """Cổng nhanh phải phân biệt đường tròn sạch với viền JPEG zíc zắc."""
    height = width = 300
    rgba = np.full((height, width, 4), 255, dtype=np.uint8)
    source = Image.fromarray(rgba, "RGBA")

    clean = np.zeros((height, width), dtype=np.uint8)
    cv2.circle(clean, (150, 150), 105, 255, thickness=-1)

    jagged_points = []
    for degree in range(360):
        radius = 108 if degree % 6 < 3 else 102
        angle = np.deg2rad(degree)
        jagged_points.append((
            round(150 + radius * np.cos(angle)),
            round(150 + radius * np.sin(angle)),
        ))
    jagged = np.zeros_like(clean)
    cv2.fillPoly(jagged, [np.asarray(jagged_points, dtype=np.int32)], 255)

    clean_analysis = _analysis_from_alpha(
        source,
        clean,
        model="birefnet-lite",
        alpha_threshold=128,
    )
    jagged_analysis = _analysis_from_alpha(
        source,
        jagged,
        model="birefnet-lite",
        alpha_threshold=128,
    )

    assert _simple_bg_preview_needs_geometry_upgrade(clean_analysis) is False
    assert _simple_bg_preview_needs_geometry_upgrade(jagged_analysis) is True


@pytest.mark.parametrize("source_kind", ["raster", "pdf"])
def test_preview_only_mask_tho_dung_alpha_ai_thay_vi_chi_tang_denoise(
    tmp_path,
    monkeypatch,
    source_kind,
):
    """Mask nền thô phải dùng đúng bước nâng Alpha của luồng Tách nhiều tem."""
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(image).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    if source_kind == "pdf":
        source = tmp_path / "rough-preview.pdf"
        _save_full_page_rgb_pdf(source, image)
    else:
        source = tmp_path / "rough-preview.jpg"
        image.save(source, format="JPEG", quality=92)
    session = _create_session(source)
    ai_calls: list[str] = []

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._simple_bg_preview_needs_geometry_upgrade",
        lambda _analysis: True,
    )

    def fake_ai(source_image: Image.Image, *, model: str, alpha_threshold: int):
        ai_calls.append(model)
        rgb = np.asarray(source_image.convert("RGB"), dtype=np.uint8)
        alpha = np.where(np.min(rgb, axis=2) < 200, 255, 0).astype(np.uint8)
        return _analysis_from_alpha(
            source_image,
            alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        fake_ai,
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=True,
    )

    assert ai_calls == ["birefnet-lite"]
    assert detected.boundary_source == "ai"
    assert "simple-bg-color-ai-geometry" in detected.warnings
    assert "simple-bg-preview-denoise-fallback" not in detected.warnings
    assert detected.background_rgb == (254, 254, 254)


def test_preview_only_mask_tho_giu_fallback_khi_ai_het_bo_nho(
    tmp_path,
    monkeypatch,
):
    """Lỗi nâng AI không được làm mất preview simple-bg đã nhận diện an toàn."""
    source = tmp_path / "rough-preview-memory.jpg"
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(image).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    image.save(source, format="JPEG", quality=92)
    session = _create_session(source)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._simple_bg_preview_needs_geometry_upgrade",
        lambda _analysis: True,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(MemoryError()),
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=True,
    )

    assert detected.boundary_source == "simple-bg"
    assert "simple-bg-preview-denoise-fallback" in detected.warnings


def test_preview_only_van_dung_ai_khi_nen_deterministic_khong_du_tin_cay(
    tmp_path,
    monkeypatch,
):
    """Fast path không được đổi thành preview thô khi detector nền từ chối."""
    source = tmp_path / "preview-needs-ai.png"
    image = Image.new("RGB", (180, 120), (22, 46, 75))
    ImageDraw.Draw(image).ellipse((24, 16, 156, 104), fill=(230, 80, 42))
    image.save(source, format="PNG")
    session = _create_session(source)
    ai_calls: list[str] = []

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        lambda *_args, **_kwargs: None,
    )

    def fake_ai(source_image: Image.Image, *, model: str, alpha_threshold: int):
        from app.workers.sticker_source_pipeline import _analysis_from_alpha

        ai_calls.append(model)
        alpha = np.zeros((source_image.height, source_image.width), dtype=np.uint8)
        alpha[16:104, 24:156] = 255
        return _analysis_from_alpha(
            source_image,
            alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        fake_ai,
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=True,
    )

    assert ai_calls == ["birefnet-lite"]
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 1


@pytest.mark.parametrize(
    ("preview_only", "expected_boundary", "expected_instances"),
    (
        (True, "page-box", 1),
        (False, "ai", 2),
    ),
)
def test_auto_preview_nhan_nhan_kin_trang_thay_vi_cac_manh_noi_bo(
    tmp_path,
    monkeypatch,
    preview_only,
    expected_boundary,
    expected_instances,
):
    """Preview classic không được gọi hai chi tiết nội bộ là hai con tem.

    Nhận diện đầy đủ vẫn giữ nguyên hai component để nhánh ``Tách nhiều tem``
    được review độc lập; chỉ hợp đồng preview nhanh một-tem mới suy ra khung trang.
    """
    source = tmp_path / "full-page-textured-artwork.pdf"
    _save_full_page_rgb_pdf(source, _full_page_textured_artwork())
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        _fake_internal_art_fragments,
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=preview_only,
    )

    assert detected.boundary_source == expected_boundary
    assert len(detected.analysis.instances) == expected_instances
    if preview_only:
        assert np.all(detected.analysis.alpha == 255)


def test_cau_noi_legacy_dung_cung_page_box_voi_preview_nhan_kin_trang(
    tmp_path,
    monkeypatch,
):
    """File xuất classic phải dùng cùng khung trang đã suy ra ở preview."""
    source = tmp_path / "legacy-full-page-textured-artwork.pdf"
    _save_full_page_rgb_pdf(source, _full_page_textured_artwork())
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        _fake_internal_art_fragments,
    )
    captured: dict[str, np.ndarray] = {}

    def fake_cutline(alpha: np.ndarray, **_kwargs):
        captured["alpha"] = np.asarray(alpha, dtype=np.uint8).copy()
        return {"path_groups": [{"instance_id": 1, "paths": []}]}

    monkeypatch.setattr(
        "app.workers.sticker_engine.build_alpha_cutline_geometry",
        fake_cutline,
    )

    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=2.0,
        corner_style="preserve",
        fill_holes=True,
    )

    assert approved is not None
    assert approved.boundary_source == "page-box"
    assert approved.instance_count == 1
    assert len(approved.path_groups) == 1
    assert np.all(captured["alpha"] == 255)
    assert np.array_equal(approved.alpha, captured["alpha"])


def test_page_box_approved_alpha_duoc_engine_chap_nhan_va_khong_noi_ai(
    tmp_path,
    monkeypatch,
):
    """Artifact page-box kín trang không bị chặn ở bước Rasterize Page.

    ``mask_tach_duoc_nen`` cố ý từ chối foreground chiếm 100% canvas; cổng
    approved phải mở riêng cho page-box, nhưng không được nới cổng cho Alpha/AI
    gần kín trang (artifact cũ hoặc stale).
    """
    source = tmp_path / "legacy-page-box-engine.pdf"
    output = tmp_path / "legacy-page-box-engine-output.pdf"
    _save_full_page_rgb_pdf(source, _full_page_textured_artwork())
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        _fake_internal_art_fragments,
    )

    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=0.0,
        corner_style="preserve",
        fill_holes=True,
        cutline_denoise=0.0,
    )
    assert approved is not None
    assert approved.boundary_source == "page-box"
    payload = {
        "alpha": approved.alpha,
        "dpi": approved.dpi,
        "source_pixel_mm": approved.source_pixel_mm,
        "boundary_source": approved.boundary_source,
        "path_groups": approved.path_groups,
    }

    accepted = _approved_contour_override(payload, approved.alpha.shape)
    assert accepted is not None
    stale_ai = dict(payload, boundary_source="ai")
    assert _approved_contour_override(stale_ai, approved.alpha.shape) is None

    success, meta = StickerEngine(dpi=72).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="auto_safe",
        cutline_denoise=0.0,
        approved_contour_overrides={0: payload},
    )
    assert success is True
    assert meta["pages"][0]["contour_source"] == "page-box"


def test_preview_va_legacy_khong_nhap_hai_tem_that_thanh_page_box(
    tmp_path,
    monkeypatch,
):
    """Hai silhouette trên nền phẳng vẫn là hai tem, không phải nhãn kín trang."""
    source = tmp_path / "true-two-stickers.pdf"
    image = _two_sticker_image(alpha=False).convert("RGB")
    _save_full_page_rgb_pdf(source, image)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline._background_detection",
        lambda *_args, **_kwargs: None,
    )

    def fake_two_stickers(
        source_image: Image.Image,
        *,
        model: str,
        alpha_threshold: int,
    ):
        from app.workers.sticker_source_pipeline import _analysis_from_alpha

        alpha = np.zeros((source_image.height, source_image.width), dtype=np.uint8)
        alpha[15:80, 12:65] = 255
        alpha[20:82, 92:148] = 255
        return _analysis_from_alpha(
            source_image,
            alpha,
            model=model,
            alpha_threshold=alpha_threshold,
        )

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        fake_two_stickers,
    )

    detected = detect_sticker_source(
        session,
        strategy="auto",
        preview_only=True,
    )
    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=2.0,
        corner_style="preserve",
        fill_holes=True,
    )

    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 2
    assert approved is None


def test_auto_mot_tem_giu_mask_nen_phang_khi_buoc_ai_phu_thieu_bo_nho(
    tmp_path,
    monkeypatch,
):
    """AI nâng hình học là tùy chọn; thiếu RAM không được làm mất preview đã có."""
    source = tmp_path / "single-sticker-memory-fallback.jpg"
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    ImageDraw.Draw(image).ellipse((38, 28, 282, 212), fill=(78, 12, 10))
    image.save(source, format="JPEG", quality=95)
    session = _create_session(source)

    def out_of_memory(*_args, **_kwargs):
        raise MemoryError("Unable to allocate 2.40 MiB for a float32 array")

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        out_of_memory,
    )

    detected = detect_sticker_source(session, strategy="auto")

    assert detected.boundary_source == "simple-bg"
    assert len(detected.analysis.instances) == 1
    assert detected.background_rgb == (254, 254, 254)


def test_auto_recovers_near_white_sticker_bodies_without_ai(tmp_path, monkeypatch):
    """Thân tem và nền cùng gần trắng phải còn sáu silhouette, không thành bóng/chữ rời."""
    source = tmp_path / "near-white-sticker-sheet.jpg"
    bodies = _save_near_white_fragmented_sheet(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.analyze_sticker_sheet",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Ca nền gần trắng có đủ bằng chứng không được gọi AI")
        ),
    )

    detected = detect_sticker_source(session, strategy="auto")

    assert detected.boundary_source == "simple-bg"
    assert detected.strategy_confidence <= 0.84
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == len(bodies) == 6
    for instance, expected in zip(detected.analysis.instances, bodies, strict=True):
        left, top, right, bottom = expected
        assert abs(instance.x - left) <= 2
        assert abs(instance.y - top) <= 2
        # JPEG tạo một vài pixel ringing quanh mép; khóa topology thay vì khóa tuyệt đối từng pixel.
        assert abs(instance.width - (right - left + 14)) <= 10
        assert abs(instance.height - (bottom - top)) <= 10
        component = detected.analysis.labels == instance.id
        assert not component[instance.y, instance.x]
        assert instance.area_px / (instance.width * instance.height) >= 0.75

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    if promoted is None:
        raise AssertionError("Thiếu session để dựng preview tem nền gần trắng")
    preview = build_sticker_cutline_preview(
        promoted,
        page_number=1,
        base_revision=1,
        edits=[],
        dpi=300,
        dpi_y=300,
        offset_mm=0,
        bleed_mm=0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1,
    )
    assert len(preview["paths"]) == 6
    assert all(int(path["segment_count"]) > 4 for path in preview["paths"])


def test_auto_splits_multi_artwork_vector_pdf_without_ai(tmp_path, monkeypatch):
    """PDF nhiều artwork kiểu Corel phải tách đủ vùng bằng auto, không gọi model AI."""
    source = tmp_path / "multi-artwork.pdf"
    _save_multi_artwork_vector_pdf(
        source,
        round_indices=frozenset({1, 3, 5}),
    )
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 16 * 1024),
    )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Auto không được chạy AI")
        ),
    )

    assert session.manifest["cut_contour_count"] == 0
    assert session.manifest["has_vector"] is True

    detected = detect_sticker_source(session, strategy="auto")

    assert detected.boundary_source == "vector"
    assert detected.strategy_confidence >= 0.60
    assert len(detected.analysis.instances) == 5
    fill_ratios = [
        item.area_px / (item.width * item.height)
        for item in detected.analysis.instances
    ]
    assert fill_ratios[0] < 0.86
    assert fill_ratios[1] > 0.94
    assert fill_ratios[2] < 0.86
    assert fill_ratios[3] > 0.94
    assert fill_ratios[4] < 0.86
    assert detected.warnings == (
        "round-sticker-contour-inferred",
        "vector-mask-raster-preview",
    )


def test_vector_rendered_alpha_keeps_banner_and_only_exact_true_circles(tmp_path, monkeypatch):
    """Alpha render là silhouette; vòng tròn có banner không được ép thành circle."""
    source = tmp_path / "alpha-silhouettes.pdf"
    _save_vector_pdf_with_alpha_silhouettes(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 16 * 1024),
    )

    detected = detect_sticker_source(session, strategy="auto")

    exact_shapes = (detected.vector_geometry_ref or {}).get("exact_shapes")
    assert isinstance(exact_shapes, list)
    shape_kinds = {
        int(shape["instance_id"]): shape.get("kind")
        for shape in exact_shapes
    }
    assert (detected.vector_geometry_ref or {}).get("silhouette_source") == "rendered-alpha"
    assert shape_kinds == {1: "circle", 5: "circle"}

    for instance_id in (2, 3, 4):
        instance = detected.analysis.instances[instance_id - 1]
        component = (
            detected.analysis.labels[
                instance.y:instance.y + instance.height,
                instance.x:instance.x + instance.width,
            ]
            == instance_id
        )
        lower = component[round(instance.height * 0.68):, :]
        side_width = max(1, round(instance.width * 0.16))
        assert np.count_nonzero(lower[:, :side_width]) > side_width
        assert np.count_nonzero(lower[:, -side_width:]) > side_width

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )
    if promoted is None or detected.dpi is None:
        raise AssertionError("Thiếu session hoặc DPI để dựng preview")

    preview = build_sticker_cutline_preview(
        promoted,
        page_number=1,
        base_revision=1,
        edits=[],
        dpi=detected.dpi[0],
        dpi_y=detected.dpi[1],
        offset_mm=0,
        bleed_mm=0,
        cut_mode="original",
        corner_style="preserve",
        fill_holes=True,
        cutline_smoothness=50,
        cutline_fidelity=50,
        curve_tension=50,
        min_detail_area_mm2=1,
    )

    path_by_id = {int(path["instance_id"]): path for path in preview["paths"]}
    assert all(path_by_id[instance_id]["segment_count"] == 4 for instance_id in (1, 5))
    assert all(
        path_by_id[instance_id]["quality"]["fit_mode"] == "exact-geometry"
        for instance_id in (1, 5)
    )
    assert all(path_by_id[instance_id]["segment_count"] > 4 for instance_id in (2, 3, 4))
    assert all(
        path_by_id[instance_id]["quality"]["fit_mode"] != "exact-geometry"
        for instance_id in (2, 3, 4)
    )


def test_vector_exact_geometry_ignores_decorative_inner_circle(tmp_path, monkeypatch):
    """Vòng tròn trong artwork chữ nhật không được biến thành dao tròn."""
    source = tmp_path / "decorative-circle.pdf"
    _save_multi_artwork_vector_pdf(
        source,
        round_indices=frozenset({1, 5}),
        decorative_circle_indices=frozenset({2, 3, 4}),
    )
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 16 * 1024),
    )

    detected = detect_sticker_source(session, strategy="auto")

    exact_shapes = (detected.vector_geometry_ref or {}).get("exact_shapes")
    assert isinstance(exact_shapes, list)
    shape_kinds = {
        int(shape["instance_id"]): shape.get("kind")
        for shape in exact_shapes
    }
    assert shape_kinds[1] == "circle"
    assert shape_kinds[5] == "circle"
    assert all(shape_kinds[index] == "rect" for index in (2, 3, 4))


def test_auto_falls_back_to_ai_only_when_deterministic_background_fails(tmp_path, monkeypatch):
    source = tmp_path / "complex.png"
    Image.new("RGB", (100, 80), (90, 80, 70)).save(source, format="PNG")
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (15, 10, 85, 70))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_source_pipeline.detect_background", lambda _rgb: None)
    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert calls == ["ai"]
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 1


def test_legacy_mot_tem_dung_dung_alpha_va_duong_be_da_duyet_cua_ai(
    tmp_path,
    monkeypatch,
):
    """Cùng PDF raster phải dùng đúng artifact AI, nhưng vẫn là một trang/tem legacy."""
    source = tmp_path / "legacy-ai-parity.pdf"
    _save_full_page_image_pdf(source, ((180, 120),))
    session = _create_session(source)

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        rgba = image.convert("RGBA")
        yy, xx = np.mgrid[:image.height, :image.width]
        alpha = np.where(
            ((xx - image.width / 2.0) / 62.0) ** 2
            + ((yy - image.height / 2.0) / 42.0) ** 2
            <= 1.0,
            255,
            0,
        ).astype(np.uint8)
        rgba.putalpha(Image.fromarray(alpha, "L"))
        return rgba

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )

    ai_mode = detect_sticker_source(session, strategy="ai")
    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=3.0,
        corner_style="round",
        fill_holes=True,
    )

    assert approved is not None
    assert approved.boundary_source == "ai"
    assert approved.instance_count == 1
    # PDF một ảnh 180×120 px trên trang 180×120 pt là nguồn 72 DPI. Không được
    # nhầm pixel render AI 300 DPI thành pixel artwork rồi lấy màu fringe quá nông.
    assert approved.source_pixel_mm == pytest.approx(25.4 / 72.0, rel=1e-4)
    assert np.array_equal(approved.alpha, ai_mode.analysis.alpha)
    expected = build_alpha_cutline_geometry(
        ai_mode.analysis.alpha,
        dpi=approved.dpi[0],
        dpi_y=approved.dpi[1],
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=3.0,
        corner_style="round",
        fill_holes=True,
    )
    assert expected is not None
    assert approved.path_groups == expected["path_groups"]


@pytest.mark.parametrize(
    "denoise_input,expected_denoise,expected_presmooth",
    [
        ("missing", 0.0, True),
        (None, 0.0, True),
        (0.0, 0.0, False),
        (35.0, 35.0, False),
    ],
)
def test_legacy_cutline_denoise_phan_biet_thieu_none_va_so_khong(
    tmp_path,
    monkeypatch,
    denoise_input,
    expected_denoise,
    expected_presmooth,
):
    """Số 0 là lệnh tắt; chỉ thiếu/None mới dùng presmooth tự động."""
    source = tmp_path / f"legacy-denoise-{denoise_input}.pdf"
    _save_full_page_image_pdf(source, ((180, 120),))

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (24, 18, image.width - 24, image.height - 18))
        rgba.putalpha(alpha)
        return rgba

    captured = {}

    def capture_geometry(_alpha, **kwargs):
        captured.update(kwargs)
        return {
            "path_groups": [{
                "exterior": [
                    ((0.0, 0.0), (0.0, 0.0), (1.0, 1.0), (1.0, 1.0)),
                ],
                "interiors": [],
            }],
        }

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )
    monkeypatch.setattr(
        "app.workers.sticker_engine.build_alpha_cutline_geometry",
        capture_geometry,
    )
    kwargs = {
        "cut_mode": "original",
        "offset_mm": 0.0,
        "bleed_mm": 2.0,
        "corner_style": "preserve",
        "fill_holes": True,
    }
    if denoise_input != "missing":
        kwargs["cutline_denoise"] = denoise_input

    approved = build_legacy_single_page_approved_contour(str(source), **kwargs)

    assert approved is not None
    assert captured["cutline_denoise"] == pytest.approx(expected_denoise)
    assert captured["presmooth_alpha"] is expected_presmooth


def test_legacy_bridge_giu_dung_pixel_anh_khi_luoi_ai_render_cao_hon(
    tmp_path,
    monkeypatch,
):
    """DPI phân tích 300 không được ghi đè kích thước pixel artwork 72 DPI."""
    source = tmp_path / "legacy-render-grid-is-not-source-grid.pdf"
    _save_full_page_image_pdf(
        source,
        ((180, 120),),
        leading_noop_operators=True,
    )

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (30, 20, image.width - 30, image.height - 20))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )

    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=3.0,
        corner_style="round",
        fill_holes=True,
    )

    assert approved is not None
    assert approved.dpi[0] == pytest.approx(300.0, rel=1e-3)
    assert approved.source_pixel_mm == pytest.approx(25.4 / 72.0, rel=1e-4)


def test_legacy_nen_phang_giu_ai_cho_hinh_hoc_va_truyen_mau_nen_vao_bleed(
    tmp_path,
    monkeypatch,
):
    """72 DPI: AI giữ đường bế mượt, deterministic chỉ cấp màu nền."""
    source = tmp_path / "legacy-flat-background.pdf"
    output = tmp_path / "legacy-flat-background-output.pdf"
    image = Image.new("RGB", (320, 240), (254, 254, 254))
    draw = ImageDraw.Draw(image)
    # Mô phỏng file thật: silhouette bị nối rộng bởi halo hồng,
    # trong khi màu mực đỏ đúng nằm sâu hơn 7 pixel nguồn.
    draw.ellipse((38, 28, 282, 212), fill=(255, 232, 232))
    draw.ellipse((44, 34, 276, 206), fill=(170, 120, 120))
    draw.ellipse((45, 35, 275, 205), fill=(78, 12, 10))
    _save_full_page_rgb_pdf(source, image)

    ai_calls = []

    def fake_ai(source_image: Image.Image, _model: str) -> Image.Image:
        ai_calls.append("ai")
        rgba = source_image.convert("RGBA")
        alpha = Image.new("L", source_image.size, 0)
        ImageDraw.Draw(alpha).ellipse((38, 28, 282, 212), fill=255)
        # AI thật trả dải Alpha chuyển tiếp. Đây là đặc tính hình học mà mask
        # simple-bg nhị phân không được phép thay thế.
        rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(radius=1.5)))
        return rgba

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )
    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=2.0,
        corner_style="round",
        fill_holes=True,
    )

    assert approved is not None
    assert ai_calls == ["ai"]
    assert approved.boundary_source == "ai"
    assert approved.edge_background_rgb == (254, 254, 254)
    assert approved.edge_background_tolerance >= 1
    assert approved.source_pixel_mm == pytest.approx(25.4 / 72.0, rel=1e-4)
    assert len(approved.path_groups) == 1
    approved_segment_count = sum(
        len(group["exterior"])
        + sum(len(interior) for interior in group.get("interiors", ()))
        for group in approved.path_groups
    )
    assert approved_segment_count < 120

    captured_samples = []

    def capture_adaptive(*args, **kwargs):
        source_mask, selected_peel = _build_adaptive_edge_color_source_mask(
            *args,
            **kwargs,
        )
        image_arg = args[1]
        captured_samples.append(
            {
                "background_rgb": kwargs.get("background_rgb"),
                "background_tolerance": kwargs.get("background_tolerance"),
                "interpolation_probe": kwargs.get("max_interpolation_probe_px"),
                "selected_peel": selected_peel,
                "colors": image_arg[source_mask > 0, :3].copy(),
            }
        )
        return source_mask, selected_peel

    monkeypatch.setattr(
        "app.workers.sticker_engine._build_adaptive_edge_color_source_mask",
        capture_adaptive,
    )
    payload = {
        "alpha": approved.alpha,
        "dpi": approved.dpi,
        "source_pixel_mm": approved.source_pixel_mm,
        "boundary_source": approved.boundary_source,
        "path_groups": approved.path_groups,
        "edge_background_rgb": approved.edge_background_rgb,
        "edge_background_tolerance": approved.edge_background_tolerance,
    }
    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=2.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=True,
        shape_mode="contour",
        approved_contour_overrides={0: payload},
    )

    assert success is True
    assert captured_samples
    sample = captured_samples[0]
    assert sample["background_rgb"] == (254, 254, 254)
    assert sample["background_tolerance"] == approved.edge_background_tolerance
    assert sample["interpolation_probe"] == 0
    assert sample["selected_peel"] == 7
    assert sample["colors"].shape[0] > 400
    assert float(np.median(sample["colors"][:, 1])) < 60
    page_meta = meta["pages"][0]
    assert page_meta["render_dpi"] == pytest.approx(72.0, abs=0.01)
    assert page_meta["raster_width_px"] == 320
    assert page_meta["raster_height_px"] == 240
    assert page_meta["edge_background_rgb"] == [254, 254, 254]
    assert page_meta["edge_sample_peel_px"] == 7
    assert page_meta.get("bleed_warning") is None

    # Oracle artifact: vành bù xén phải mang màu đỏ đậm, không phải
    # halo hồng nhạt dù contract approved đã đi qua route/engine.
    with pikepdf.Pdf.open(output) as result:
        xobjects = result.pages[0].Resources.get("/XObject", {})
        bleed_images = [
            xobjects[name]
            for name in xobjects.keys()
            if str(xobjects[name].get("/Subtype")) == "/Image"
            and xobjects[name].get("/SMask") is not None
        ]
        assert len(bleed_images) == 1
        bleed = bleed_images[0]
        width = int(bleed.get("/Width"))
        height = int(bleed.get("/Height"))
        rgb = np.frombuffer(bleed.read_bytes(), dtype=np.uint8).reshape(
            height, width, 3
        )
        alpha = np.frombuffer(
            bleed.get("/SMask").read_bytes(), dtype=np.uint8
        ).reshape(height, width)

    opaque_colors = rgb[alpha >= 250]
    assert opaque_colors.shape[0] > 1000
    median = np.median(opaque_colors, axis=0)
    assert median[0] > median[1] + 35, median.tolist()
    assert median[1] < 60, median.tolist()


def test_sticker_engine_dung_ca_mask_va_path_da_duyet_thay_vi_mask_nen_cu(
    tmp_path,
    monkeypatch,
):
    """Đường bế và footprint phải cùng lấy từ artifact AI nguyên tử."""
    source = tmp_path / "approved-source.pdf"
    output = tmp_path / "approved-output.pdf"
    _save_full_page_image_pdf(source, ((180, 120),))

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        rgba = image.convert("RGBA")
        yy, xx = np.mgrid[:image.height, :image.width]
        alpha = np.where(
            ((xx - 90.0) / 58.0) ** 2 + ((yy - 60.0) / 38.0) ** 2 <= 1.0,
            255,
            0,
        ).astype(np.uint8)
        rgba.putalpha(Image.fromarray(alpha, "L"))
        return rgba

    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        fake_ai,
    )
    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=0.0,
        corner_style="round",
        fill_holes=True,
    )
    assert approved is not None
    payload = {
        "alpha": approved.alpha,
        "dpi": approved.dpi,
        "source_pixel_mm": approved.source_pixel_mm,
        "boundary_source": approved.boundary_source,
        "path_groups": approved.path_groups,
    }

    success, meta = StickerEngine(dpi=72).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=True,
        draw_cut_contour=True,
        shape_mode="auto_safe",
        approved_contour_overrides={0: payload},
    )

    assert success is True
    assert meta["pages"][0]["contour_source"] == "ai"
    restored = _alpha_override_geometry(payload)
    assert restored is not None
    expected_geometry, _paths = restored
    expected_width = expected_geometry.bounds[2] - expected_geometry.bounds[0]
    expected_height = expected_geometry.bounds[3] - expected_geometry.bounds[1]
    with pikepdf.Pdf.open(output) as result:
        trim = [float(value) for value in result.pages[0].TrimBox]
    assert trim[2] - trim[0] == pytest.approx(expected_width, abs=0.02)
    assert trim[3] - trim[1] == pytest.approx(expected_height, abs=0.02)


@pytest.mark.parametrize("kind", ["existing-cut", "vector"])
def test_cau_noi_legacy_khong_chay_ai_voi_bien_pdf_that(
    tmp_path,
    monkeypatch,
    kind,
):
    """CutContour/vector thật phải giữ luồng PDF, không bị đưa qua AI raster."""
    if kind == "existing-cut":
        source = COREL_CUT_FIXTURE
    else:
        source = tmp_path / "vector-and-raster.pdf"
        _save_full_page_image_pdf(
            source,
            ((120, 80),),
            vector_pages=frozenset({1}),
        )
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("PDF đã có biên thật không được chạy AI")
        ),
    )

    approved = build_legacy_single_page_approved_contour(
        str(source),
        cut_mode="original",
        offset_mm=0.0,
        bleed_mm=3.0,
        corner_style="round",
        fill_holes=True,
    )

    assert approved is None


def test_auto_nhuong_ai_khi_tem_vien_trang_co_bong_mem(tmp_path, monkeypatch):
    """§WHITE-SHADOW: viền trắng + bóng mềm phải đi AI, không tự phục hồi silhouette.

    Hồi quy cho lỗi người dùng báo 2026-08-16: nhánh phục hồi xác định hút cả đuôi
    gradient bóng (và halo JPEG) vào thân tem, cho ra silhouette phình, biên lởm chởm và
    mảnh rác. Nhánh tem KHÔNG viền trắng vẫn đi đúng đường cũ nên không nằm trong ca này.
    """
    source = tmp_path / "near-white-soft-shadow.jpg"
    bodies = _save_near_white_soft_shadow_sheet(source)
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        for left, top, right, bottom in bodies:
            alpha.paste(255, (left, top, right, bottom))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session, strategy="auto")

    assert calls == ["ai"], (
        "Bóng mềm sát viền trắng không đủ bằng chứng cho nhánh xác định; "
        "phải nhường cho AI như hành vi trước 2026-08-16."
    )
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == len(bodies) == 6


def test_auto_rejects_nested_simple_background_fragments_and_uses_ai(tmp_path, monkeypatch):
    source = tmp_path / "white-sticker-sheet.png"
    Image.new("RGB", (240, 140), "white").save(source, format="PNG")
    session = _create_session(source)
    fragmented = np.zeros((140, 240), dtype=np.uint8)
    # Hai vỏ tem trắng chỉ còn đường viền; chữ/chi tiết màu ở trong trở thành
    # component rời nhưng tâm vẫn nằm trong bbox của vỏ — đúng lỗi ảnh khách.
    for left, right in ((8, 108), (132, 232)):
        fragmented[10:130, left:left + 3] = 255
        fragmented[10:130, right - 3:right] = 255
        fragmented[10:13, left:right] = 255
        fragmented[127:130, left:right] = 255
        fragmented[35:65, left + 20:left + 42] = 255
        fragmented[78:110, left + 55:left + 82] = 255

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.detect_background",
        lambda _rgb: BackgroundInfo(
            color=(255, 255, 255),
            tolerance=12,
            foreground_mask=fragmented,
            confidence=0.99,
            is_near_white=True,
            is_flat=True,
        ),
    )
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (8, 10, 108, 130))
        alpha.paste(255, (132, 10, 232, 130))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert calls == ["ai"]
    assert detected.boundary_source == "ai"
    assert len(detected.analysis.instances) == 2


def test_real_corel_cutcontour_creates_review_mask_without_ai(monkeypatch):
    session = _create_session(COREL_CUT_FIXTURE)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session, page_number=1)

    assert detected.boundary_source == "existing-cut"
    assert detected.vector_geometry_ref == {
        "kind": "pdf-cut-contours",
        "source_page": 1,
        "contour_count": 75,
        "preserve_original": True,
    }
    assert len(detected.analysis.instances) == 75


def test_promote_keeps_session_id_and_blocks_until_confirmed(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG", dpi=(300, 300))
    session = _create_session(source)
    detected = detect_sticker_source(session)

    promoted = promote_source_session(
        session.session_id,
        analysis=detected.analysis,
        analysis_source=detected.source_image,
        boundary_source=detected.boundary_source,
        strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review,
        dpi=detected.dpi,
        source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref,
        warnings=list(detected.warnings),
    )

    assert promoted is session
    assert promoted.stage == "mask-review"
    assert promoted.analysis_source_path == promoted.directory / "analysis_source.png"
    assert promoted.analysis_source_path.is_file()
    assert (promoted.directory / "source_preview.png").is_file()
    assert (promoted.directory / "labels.npy").is_file()
    assert confirm_source_session(session.session_id) is session
    assert session.stage == "mask-ready"
    assert session.manifest["mask_confirmed"] is True


def test_auto_low_confidence_gradient_falls_back_to_ai(tmp_path, monkeypatch):
    source = tmp_path / "gradient.png"
    x = np.linspace(245, 90, 180, dtype=np.uint8)
    rgb = np.repeat(x[None, :, None], 120, axis=0)
    rgb = np.repeat(rgb, 3, axis=2)
    rgb[25:95, 55:130] = (220, 40, 80)
    Image.fromarray(rgb, "RGB").save(source)
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = image.convert("RGBA")
        alpha = Image.new("L", image.size, 0)
        alpha.paste(255, (55, 25, 130, 95))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "ai"
    assert calls == ["ai"]


def test_auto_background_without_valid_components_falls_back_to_ai(tmp_path, monkeypatch):
    source = tmp_path / "fragments.png"
    image = Image.new("RGB", (400, 400), "white")
    for index in range(20):
        x = 10 + (index % 5) * 70
        y = 10 + (index // 5) * 70
        image.paste((20, 80, 180), (x, y, x + 3, y + 3))
    image.save(source)
    session = _create_session(source)
    calls: list[str] = []

    def fake_ai(source_image: Image.Image, _model: str) -> Image.Image:
        calls.append("ai")
        rgba = source_image.convert("RGBA")
        alpha = Image.new("L", source_image.size, 0)
        alpha.paste(255, (80, 80, 320, 320))
        rgba.putalpha(alpha)
        return rgba

    monkeypatch.setattr("app.workers.sticker_sheet_engine._run_background_model", fake_ai)

    detected = detect_sticker_source(session)

    assert detected.boundary_source == "ai"
    assert calls == ["ai"]


def test_single_transparent_pixel_is_not_clean_alpha(tmp_path, monkeypatch):
    source = tmp_path / "false-alpha.png"
    image = Image.new("RGBA", (100, 80), (255, 255, 255, 255))
    image.paste((220, 40, 80, 255), (20, 15, 80, 65))
    image.putpixel((0, 0), (255, 255, 255, 0))
    image.save(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session, strategy="simple-bg")

    assert session.manifest["has_alpha"] is False
    assert detected.boundary_source == "simple-bg"
    assert detected.analysis.instances[0].bbox == (20, 15, 60, 50)


def test_pdf_user_unit_keeps_physical_size_and_only_caps_low_ram(tmp_path, monkeypatch):
    source = tmp_path / "user-unit.pdf"
    _save_pdf(source, (1000, 500), user_unit=2.0)
    physical_size_mm = (1000 * 2 * 25.4 / 72.0, 500 * 2 * 25.4 / 72.0)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )
    full_image, full_dpi = _render_pdf_page(str(source), 0, physical_size_mm)
    assert max(full_image.size) > 3000
    assert full_dpi[0] == pytest.approx(300, abs=0.2)
    assert full_dpi[1] == pytest.approx(300, abs=0.2)

    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (6 * 1024, 3 * 1024),
    )
    capped_image, capped_dpi = _render_pdf_page(str(source), 0, physical_size_mm)
    assert max(capped_image.size) <= 3000
    assert capped_dpi[0] < full_dpi[0]


def test_image_only_pdf_keeps_native_resolution_for_each_thumbnail_page(tmp_path, monkeypatch):
    source = tmp_path / "viewer-images.pdf"
    native_sizes = ((320, 180), (180, 260))
    _save_full_page_image_pdf(source, native_sizes)
    inspection = inspect_sticker_source(str(source), source.name)
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )

    rendered = []
    for page_index, page in enumerate(inspection.pages):
        image, dpi = _render_pdf_page(
            str(source),
            page_index,
            (float(page.width_mm), float(page.height_mm)),
        )
        rendered.append((image.size, dpi))

    assert [size for size, _dpi in rendered] == list(native_sizes)
    for _size, dpi in rendered:
        assert dpi[0] == pytest.approx(72, abs=0.2)
        assert dpi[1] == pytest.approx(72, abs=0.2)


def test_image_page_with_vector_content_still_renders_at_300_dpi(tmp_path, monkeypatch):
    source = tmp_path / "image-and-vector.pdf"
    _save_full_page_image_pdf(source, ((320, 180),), vector_pages=frozenset({1}))
    inspection = inspect_sticker_source(str(source), source.name)
    page = inspection.pages[0]
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.read_memory_status_mb",
        lambda: (32 * 1024, 24 * 1024),
    )

    image, dpi = _render_pdf_page(
        str(source),
        0,
        (float(page.width_mm), float(page.height_mm)),
    )

    assert image.width > 320 * 4
    assert image.height > 180 * 4
    assert dpi[0] == pytest.approx(300, abs=0.2)
    assert dpi[1] == pytest.approx(300, abs=0.2)


def test_nested_cut_contours_keep_inner_hole(tmp_path, monkeypatch):
    source = tmp_path / "nested.pdf"
    _save_pdf(source, (100, 100))
    monkeypatch.setattr(
        "app.workers.sticker_source_pipeline.extract_cut_contours",
        lambda *_args, **_kwargs: ExtractResult(contours=[
            CutContour([(10, 10), (90, 10), (90, 90), (10, 90)], True),
            CutContour([(30, 30), (70, 30), (70, 70), (30, 70)], True),
        ]),
    )

    alpha, count = _cut_contour_alpha(str(source), 0, (100, 100))

    assert count == 2
    assert alpha[15, 15] == 255
    assert alpha[50, 50] == 0


def test_pdf_soft_mask_is_used_before_simple_background(tmp_path, monkeypatch):
    source = tmp_path / "soft-mask.pdf"
    _save_soft_mask_pdf(source)
    session = _create_session(source)
    monkeypatch.setattr(
        "app.workers.sticker_sheet_engine._run_background_model",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI không được chạy")),
    )

    detected = detect_sticker_source(session)

    assert session.manifest["has_alpha"] is True
    assert detected.boundary_source == "alpha"
    assert len(detected.analysis.instances) == 1


def _save_custom_selection_pdf(
    path: Path, *, rotation: int = 0, user_unit: float = 1,
    crop_box: tuple[float, float, float, float] | None = None,
) -> None:
    """Viền tem trắng, lõi đỏ và artwork xanh không chọn trên cùng một trang."""
    with pikepdf.Pdf.new() as document:
        page = document.add_blank_page(page_size=(144, 96))
        page.obj["/Rotate"] = rotation
        page.obj["/UserUnit"] = user_unit
        if crop_box is not None:
            page.obj["/CropBox"] = pikepdf.Array(crop_box)
        page.obj["/Resources"] = pikepdf.Dictionary()
        commands = [
            "1 1 1 rg 0 0 144 96 re f",
            "1 1 1 rg " + _pdf_circle_path(40.25, 55.25, 20.1) + " f",
            "1 0 0 rg 32 47 16 16 re f",
            "0 0 1 rg 95 20 30 20 re f",
        ]
        page.obj["/Contents"] = document.make_stream("\n".join(commands).encode("ascii"))
        document.save(path)


@pytest.mark.parametrize("rotation,user_unit", [(0, 1), (90, 2), (180, 1), (270, 2)])
def test_custom_pdf_giu_alpha_vien_trang_va_khung_trang_xoay(
    tmp_path, monkeypatch, rotation, user_unit,
):
    source = tmp_path / "custom-white-rim.pdf"
    _save_custom_selection_pdf(source, rotation=rotation, user_unit=user_unit)
    original_bytes = source.read_bytes()
    session = _create_session(source)

    def forbidden_detector(*_args, **_kwargs):
        raise AssertionError("Chọn đối tượng PDF không được chạy AI hoặc dò nền")

    monkeypatch.setattr("app.workers.sticker_source_pipeline.analyze_sticker_sheet", forbidden_detector)
    monkeypatch.setattr("app.workers.sticker_source_pipeline._background_detection", forbidden_detector)
    detected = detect_sticker_source(
        session, strategy="ai", object_ids=["vector-1", "vector-2", "vector-1"],
    )

    assert detected.boundary_source == "manual"
    assert detected.vector_geometry_ref == {
        "kind": "pdf-object-selection", "source_page": 1,
        "object_ids": ["vector-1", "vector-2"], "preserve_original": True,
    }
    assert detected.analysis.model_seconds == 0
    assert len(detected.analysis.instances) == 1
    assert detected.dpi == pytest.approx((300, 300), abs=0.6)
    page = session.manifest["pages"][0]
    assert detected.source_image.width / detected.dpi[0] * 25.4 == pytest.approx(page["width_mm"])
    assert detected.source_image.height / detected.dpi[1] * 25.4 == pytest.approx(page["height_mm"])
    alpha = np.asarray(detected.source_image.getchannel("A"))
    assert np.any((alpha > 0) & (alpha < 255)), "Không được nhị phân hóa dải Alpha mềm"
    assert np.array_equal(detected.analysis.alpha, alpha)
    rgba = np.asarray(detected.source_image)
    assert np.count_nonzero((alpha == 255) & np.all(rgba[:, :, :3] == 255, axis=2)) > 1000
    assert np.count_nonzero((alpha > 0) & (rgba[:, :, 2] > 200) & (rgba[:, :, 0] < 100)) == 0
    centers = {
        0: (40.25 / 144, (96 - 55.25) / 96),
        90: (55.25 / 96, 40.25 / 144),
        180: ((144 - 40.25) / 144, 55.25 / 96),
        270: ((96 - 55.25) / 96, (144 - 40.25) / 144),
    }
    instance = detected.analysis.instances[0]
    assert instance.x + instance.width / 2 == pytest.approx(
        centers[rotation][0] * detected.source_image.width, abs=2,
    )
    assert instance.y + instance.height / 2 == pytest.approx(
        centers[rotation][1] * detected.source_image.height, abs=2,
    )
    assert source.read_bytes() == original_bytes
    assert session.source_path.read_bytes() == original_bytes


def test_custom_pdf_co_the_chon_nhieu_vung_va_khong_lay_artwork_khong_chon(tmp_path):
    source = tmp_path / "custom-multi.pdf"
    _save_custom_selection_pdf(source)
    detected = detect_sticker_source(_create_session(source), object_ids=["vector-1", "vector-3"])
    assert len(detected.analysis.instances) == 2
    rgba = np.asarray(detected.source_image)
    assert not np.any((rgba[:, :, 3] > 0) & (rgba[:, :, 0] > 200) & (rgba[:, :, 1] < 100))


def test_custom_pdf_cropbox_lech_goc_khong_lech_mask_sau_xoay(tmp_path):
    source = tmp_path / "crop-selection.pdf"
    _save_custom_selection_pdf(source, rotation=90, user_unit=2, crop_box=(10, 10, 134, 90))
    detected = detect_sticker_source(_create_session(source), object_ids=["vector-1", "vector-2"])
    assert detected.source_image.width / detected.dpi[0] * 25.4 == pytest.approx(80 * 2 * 25.4 / 72, abs=0.001)
    assert detected.source_image.height / detected.dpi[1] * 25.4 == pytest.approx(124 * 2 * 25.4 / 72, abs=0.001)
    instance = detected.analysis.instances[0]
    assert instance.x + instance.width / 2 == pytest.approx(
        (55.25 - 10) / 80 * detected.source_image.width, abs=2,
    )
    assert instance.y + instance.height / 2 == pytest.approx(
        (40.25 - 10) / 124 * detected.source_image.height, abs=2,
    )


def test_custom_pdf_chon_image_id_giu_alpha_smask(tmp_path, monkeypatch):
    source = tmp_path / "image-selection.pdf"
    _save_soft_mask_pdf(source)

    def forbidden_ai(*_args, **_kwargs):
        raise AssertionError("Đối tượng ảnh đã chọn phải dùng Alpha PDF")

    monkeypatch.setattr("app.workers.sticker_source_pipeline.analyze_sticker_sheet", forbidden_ai)
    detected = detect_sticker_source(_create_session(source), strategy="ai", object_ids=["image-0"])
    assert detected.boundary_source == "manual"
    assert detected.vector_geometry_ref["object_ids"] == ["image-0"]
    assert len(detected.analysis.instances) == 1
    assert np.array_equal(detected.analysis.alpha, np.asarray(detected.source_image.getchannel("A")))


@pytest.mark.parametrize("object_ids", [[], [1], [None], ["vector-1", "bad-id"], "vector-1"])
def test_custom_pdf_tu_choi_lua_chon_rong_hoac_sai_kieu(tmp_path, object_ids):
    source = tmp_path / "invalid-selection.pdf"
    _save_custom_selection_pdf(source)
    with pytest.raises(StickerSourcePipelineError, match="ít nhất một đối tượng"):
        detect_sticker_source(_create_session(source), object_ids=object_ids)


def test_custom_pdf_tu_choi_id_khong_ton_tai_va_khong_roi_ve_toan_trang(tmp_path):
    source = tmp_path / "missing-object.pdf"
    _save_custom_selection_pdf(source)
    with pytest.raises(StickerSourcePipelineError, match="không còn khớp"):
        detect_sticker_source(_create_session(source), object_ids=["vector-99"])


def test_custom_pdf_khong_nhan_lua_chon_doi_tuong_cho_anh(tmp_path):
    source = tmp_path / "raster-selection.png"
    _two_sticker_image(alpha=True).save(source)
    with pytest.raises(StickerSourcePipelineError, match="chỉ áp dụng.*PDF"):
        detect_sticker_source(_create_session(source), object_ids=["image-0"])


def test_detection_reservation_is_exclusive_and_can_be_aborted(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)

    assert begin_source_detection(session.session_id) is session
    assert session.stage == "detecting"
    assert begin_source_detection(session.session_id) is None
    assert abort_source_detection(session.session_id) is True
    assert session.stage == "inspected"


def test_detection_reservations_are_isolated_by_source_page(tmp_path):
    source = tmp_path / "three-pages.pdf"
    _save_multi_page_pdf(source)
    session = _create_session(source)

    assert sorted(session.pages) == [1, 2, 3]
    assert begin_source_detection(session.session_id, page_number=1) is session
    assert begin_source_detection(session.session_id, page_number=2) is session
    assert begin_source_detection(session.session_id, page_number=1) is None
    assert session.pages[1].stage == "detecting"
    assert session.pages[2].stage == "detecting"
    assert session.pages[3].stage == "inspected"

    assert abort_source_detection(session.session_id, page_number=1) is True
    assert session.pages[1].stage == "inspected"
    assert session.pages[2].stage == "detecting"
    assert abort_source_detection(session.session_id, page_number=2) is True

    page_two_directory = session.directory / "pages" / "0002"
    assert session.pages[2].directory == page_two_directory
    assert (page_two_directory / "manifest.json").is_file()


def _promote_detected_selection(session, detected, *, detection_token=None):
    return promote_source_session(
        session.session_id, analysis=detected.analysis, analysis_source=detected.source_image,
        boundary_source=detected.boundary_source, strategy_confidence=detected.strategy_confidence,
        needs_review=detected.needs_review, dpi=detected.dpi, source_page=detected.source_page,
        vector_geometry_ref=detected.vector_geometry_ref, detection_token=detection_token,
    )


def test_redetect_token_ngan_worker_cu_promote_hoac_huy_luot_moi(tmp_path):
    source = tmp_path / "reserved.pdf"
    _save_custom_selection_pdf(source)
    session = _create_session(source)
    page = session.pages[1]
    assert begin_source_detection(session.session_id) is session
    old_token = page.detection_token
    detected = detect_sticker_source(session, object_ids=["vector-1"])
    assert abort_source_detection(session.session_id, detection_token=old_token)
    assert begin_source_detection(session.session_id) is session
    new_token = page.detection_token
    assert old_token != new_token
    assert _promote_detected_selection(session, detected, detection_token=old_token) is None
    assert not abort_source_detection(session.session_id, detection_token=old_token)
    assert page.stage == "detecting"
    assert page.detection_token == new_token
    assert _promote_detected_selection(session, detected, detection_token=new_token) is session
    assert page.manifest["mask_revision"] == 1
    assert page.detection_token is None


@pytest.mark.parametrize("failure_at", ["staging", "publishing", "manifest"])
def test_redetect_loi_ghi_khoi_phuc_mask_da_duyet_va_cache(tmp_path, monkeypatch, failure_at):
    source = tmp_path / "rollback.pdf"
    _save_custom_selection_pdf(source)
    session = _create_session(source)
    detected = detect_sticker_source(session, object_ids=["vector-1", "vector-2"])
    assert _promote_detected_selection(session, detected) is session
    assert confirm_source_session(session.session_id) is session
    page = session.pages[1]
    previous_manifest = dict(page.manifest)
    previous_files = {path.name: path.read_bytes() for path in page.directory.iterdir() if path.is_file()}
    previous_cache = {"fingerprint": "approved-before-redetect"}
    page.cutline_export_cache = previous_cache
    assert begin_source_detection(session.session_id, base_revision=1) is session
    token = page.detection_token
    changed = detect_sticker_source(session, object_ids=["vector-3"])
    if failure_at == "staging":
        def fail_save(*_args, **_kwargs):
            raise OSError("disk-full")
        monkeypatch.setattr(session_store.np, "save", fail_save)
    else:
        original_replace = Path.replace

        def fail_partial_publish(path, target):
            failing_name = "manifest.json" if failure_at == "manifest" else "preview_uncertainty.png"
            if path.parent.name.startswith(".promote-") and path.name == failing_name:
                raise OSError("disk-full")
            return original_replace(path, target)

        monkeypatch.setattr(Path, "replace", fail_partial_publish)
    with pytest.raises(OSError, match="disk-full"):
        _promote_detected_selection(session, changed, detection_token=token)
    assert abort_source_detection(session.session_id, detection_token=token)
    assert page.stage == "mask-ready"
    assert page.manifest == previous_manifest
    assert page.cutline_export_cache is previous_cache
    assert {path.name: path.read_bytes() for path in page.directory.iterdir() if path.is_file()} == previous_files
    assert not list(page.directory.glob(".promote-*"))


def test_concurrent_promote_and_confirm_keep_manifest_consistent(tmp_path):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)
    detected = detect_sticker_source(session)

    def promote():
        return promote_source_session(
            session.session_id,
            analysis=detected.analysis,
            analysis_source=detected.source_image,
            boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review,
            dpi=detected.dpi,
            source_page=detected.source_page,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        promoted = list(executor.map(lambda _index: promote(), range(2)))

    assert promoted.count(session) == 1
    assert promoted.count(None) == 1
    manifest = json.loads((session.directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["stage"] == "mask-review"
    assert len(manifest["instances"]) == 2
    assert not (session.directory / "manifest.json.tmp").exists()
    with Image.open(session.directory / "preview.png") as preview:
        assert preview.size == (160, 100)

    with ThreadPoolExecutor(max_workers=8) as executor:
        confirmed = list(executor.map(
            lambda _index: confirm_source_session(session.session_id),
            range(32),
        ))
    assert confirmed == [session] * 32
    assert session.stage == "mask-ready"


def test_failed_promote_restores_inspected_preview(tmp_path, monkeypatch):
    source = tmp_path / "alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    session = _create_session(source)
    detected = detect_sticker_source(session)
    original_preview = (session.directory / "preview.png").read_bytes()
    monkeypatch.setattr(
        "app.core.sticker_sheet_session.np.save",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk-full")),
    )

    with pytest.raises(OSError, match="disk-full"):
        promote_source_session(
            session.session_id,
            analysis=detected.analysis,
            analysis_source=detected.source_image,
            boundary_source=detected.boundary_source,
            strategy_confidence=detected.strategy_confidence,
            needs_review=detected.needs_review,
            dpi=detected.dpi,
            source_page=detected.source_page,
        )

    assert session.stage == "inspected"
    assert (session.directory / "preview.png").read_bytes() == original_preview
    assert not (session.directory / "analysis_source.png").exists()
    assert not list(session.directory.glob(".promote-*"))


def test_session_copy_gets_fresh_mtime(tmp_path):
    source = tmp_path / "old-alpha.png"
    _two_sticker_image(alpha=True).save(source, format="PNG")
    old_time = time.time() - 72 * 60 * 60
    os.utime(source, (old_time, old_time))

    session = _create_session(source)

    assert session.source_path.stat().st_mtime > old_time + 60 * 60
