"""Hồi quy cho mối nối giữa nền tem và bù xén lấy màu viền."""

from __future__ import annotations

import io

import numpy as np
import pikepdf
import pypdfium2 as pdfium
from PIL import Image
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.workers.sticker_engine import (
    StickerEngine,
    _build_feathered_bleed_join_mask,
)


BLUE = np.array([55, 126, 200], np.int16)
PALE_CYAN = np.array([210, 245, 250], np.int16)


def _make_halo_sticker(path: str) -> None:
    """Tem tròn xanh có fringe sáng/răng cưa 3 px ngay trong mép."""
    side = 260
    center = side // 2
    yy, xx = np.ogrid[:side, :side]
    radius = np.sqrt((xx - center) ** 2 + (yy - center) ** 2)
    angle = (np.arctan2(yy - center, xx - center) + 2 * np.pi) % (2 * np.pi)
    image = np.full((side, side, 3), 255, np.uint8)
    image[radius <= 80] = BLUE.astype(np.uint8)
    fringe = (radius > 77) & (radius <= 80)
    alternating = ((angle * 32 / (2 * np.pi)).astype(int) % 2) == 0
    image[fringe & alternating] = PALE_CYAN.astype(np.uint8)

    png = io.BytesIO()
    Image.fromarray(image).save(png, format="PNG")
    png.seek(0)
    page_points = side * 72.0 / 300.0
    pdf = canvas.Canvas(path, pagesize=(page_points, page_points), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=page_points,
        height=page_points,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _make_low_dpi_alpha_halo_sticker(path: str) -> None:
    """Tem Alpha 72 DPI có hai pixel nguồn bị pha nền sáng ở mép."""
    side = 180
    center = side // 2
    yy, xx = np.ogrid[:side, :side]
    radius = np.sqrt((xx - center) ** 2 + (yy - center) ** 2)
    angle = (np.arctan2(yy - center, xx - center) + 2 * np.pi) % (2 * np.pi)
    rgba = np.zeros((side, side, 4), dtype=np.uint8)
    rgba[radius <= 56, :3] = BLUE.astype(np.uint8)
    fringe = (radius > 54) & (radius <= 56)
    alternating = ((angle * 32 / (2 * np.pi)).astype(int) % 2) == 0
    rgba[fringe & alternating, :3] = PALE_CYAN.astype(np.uint8)
    rgba[radius <= 55, 3] = 255
    outer_alpha = (radius > 55) & (radius <= 56)
    rgba[outer_alpha, 3] = 160

    png = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(png, format="PNG", dpi=(72, 72))
    png.seek(0)
    pdf = canvas.Canvas(path, pagesize=(side, side), pageCompression=0)
    pdf.drawImage(
        ImageReader(png),
        0,
        0,
        width=side,
        height=side,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()


def _content_bytes(page: pikepdf.Page) -> bytes:
    contents = page.obj.get("/Contents")
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(stream.read_bytes() for stream in contents)
    return contents.read_bytes()


def test_feathered_join_phu_du_duong_cheo_tai_goc_gay_nho():
    """Góc lõm 90° không được hở pixel chéo dù cạnh thẳng vẫn giữ mí cũ."""
    footprint = np.full((80, 80), 255, dtype=np.uint8)
    footprint[:40, :40] = 0
    bleed_mask = np.full_like(footprint, 255)

    alpha = _build_feathered_bleed_join_mask(
        bleed_mask,
        footprint,
        solid_overlap_px=3,
        feather_px=1,
    )

    # Pixel (42, 42) cách đỉnh góc 3 px theo cả hai trục nhưng 4,24 px theo
    # Euclid. Nếu chỉ dùng EDT tròn, chính pixel này thành nêm trắng còn sót.
    assert alpha[42, 42] == 255
    # Guard cục bộ phải đi hết đường chéo của dải chuyển tiếp 4 px; đây là ca
    # nguồn 72 DPI được raster ở DPI cao khiến fringe hai trục chồng lên nhau.
    assert alpha[44, 44] == 255
    # Bảo vệ góc phải cục bộ: cạnh thẳng và phần sâu trong artwork không đổi.
    assert alpha[42, 20] == 255
    assert alpha[43, 20] == 0
    assert alpha[50, 50] == 0


def test_sampled_bleed_overprints_and_denoises_the_join(tmp_path):
    source = str(tmp_path / "halo_source.pdf")
    output = str(tmp_path / "halo_bleed.pdf")
    _make_halo_sticker(source)

    success, meta = StickerEngine(dpi=300).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=3.0,
        fill_holes=True,
        remove_white_bg=True,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=False,
    )
    assert success is True
    assert meta.get("warning") is None

    document = pdfium.PdfDocument(output)
    try:
        rendered = np.array(document[0].render(scale=300 / 72).to_pil().convert("RGB"))
    finally:
        document.close()

    height, width = rendered.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - width / 2) ** 2 + (yy - height / 2) ** 2)
    join = (radius > 76.5) & (radius < 81.5)
    colors = rendered[join].astype(np.int16)
    blue_share = float(np.mean(np.max(np.abs(colors - BLUE), axis=1) < 12))
    pale_share = float(np.mean(np.max(np.abs(colors - PALE_CYAN), axis=1) < 12))
    white_share = float(np.mean(np.min(colors, axis=1) > 240))
    assert blue_share > 0.95
    assert pale_share < 0.01
    assert white_share < 0.01

    with pikepdf.Pdf.open(output) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.XObject
        form_names = [name for name, obj in xobjects.items() if str(obj.Subtype) == "/Form"]
        color_images = [
            (name, obj)
            for name, obj in xobjects.items()
            if str(obj.Subtype) == "/Image" and str(obj.ColorSpace) != "/DeviceGray"
        ]
        assert len(form_names) == 1
        assert len(color_images) == 1
        image_name, image_obj = color_images[0]
        assert bool(image_obj.get("/Interpolate", False)) is True
        assert bool(image_obj.SMask.get("/Interpolate", False)) is True
        content = _content_bytes(page)
        assert content.rfind(f"{form_names[0]} Do".encode()) < content.rfind(
            f"{image_name} Do".encode()
        )


def test_low_dpi_alpha_fringe_is_fully_covered_at_bleed_join(tmp_path):
    """Hai pixel fringe 72 DPI không được còn thành dải trắng/mờ sau xuất PDF."""
    source = str(tmp_path / "low_dpi_alpha_source.pdf")
    output = str(tmp_path / "low_dpi_alpha_bleed.pdf")
    _make_low_dpi_alpha_halo_sticker(source)

    # Luồng Ảnh AI giữ DPI nguồn (72); viewer/RIP có thể render lại ở 300 DPI.
    success, meta = StickerEngine(dpi=72).process_pdf(
        input_path=source,
        output_path=output,
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=3.0,
        fill_holes=True,
        remove_white_bg=False,
        bleed_color_type="image",
        draw_cut_contour=False,
        rectangle_mode=False,
        alpha_source_mode=True,
        alpha_source_pixel_mm=25.4 / 72.0,
    )
    assert success is True
    assert meta.get("warning") is None

    document = pdfium.PdfDocument(output)
    try:
        rendered = np.array(document[0].render(scale=300 / 72).to_pil().convert("RGB"))
    finally:
        document.close()

    height, width = rendered.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((xx - width / 2) ** 2 + (yy - height / 2) ** 2)
    source_scale = 300.0 / 72.0
    join = (radius > 53.5 * source_scale) & (radius < 56.5 * source_scale)
    colors = rendered[join].astype(np.int16)
    blue_share = float(np.mean(np.max(np.abs(colors - BLUE), axis=1) < 12))
    pale_share = float(np.mean(np.max(np.abs(colors - PALE_CYAN), axis=1) < 12))
    assert blue_share > 0.95
    assert pale_share < 0.01
