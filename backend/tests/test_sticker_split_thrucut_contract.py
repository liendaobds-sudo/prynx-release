"""Hợp đồng artifact: tách từng tem không được làm mất dao đứt ThruCut."""

from __future__ import annotations

import io

import pikepdf
import pytest
from PIL import Image, ImageDraw
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


def _content_bytes(page) -> bytes:
    contents = page.Contents
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(stream.read_bytes() for stream in contents)
    return contents.read_bytes()


@pytest.mark.parametrize("thru_shape", ["rounded_rect", "ellipse", "contour_offset"])
def test_split_multi_sticker_keeps_thrucut_stream_per_output_page(tmp_path, thru_shape):
    """Hai tem trên một trang phải giữ cả CutContour và ThruCut sau khi tách."""
    from app.workers.sticker_engine import StickerEngine
    from app.workers.sticker_page_canvas import split_or_normalize_sticker_tight_crop

    source = tmp_path / "two_stickers.pdf"
    output = tmp_path / "two_stickers_cut.pdf"
    image = Image.new("RGBA", (300, 160), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 30, 110, 120), fill=(230, 30, 40, 255))
    draw.ellipse((180, 30, 270, 120), fill=(20, 80, 220, 255))
    image_bytes = io.BytesIO()
    image.save(image_bytes, format="PNG")
    image_bytes.seek(0)

    width_pt = 300 * 72 / 150
    height_pt = 160 * 72 / 150
    pdf = canvas.Canvas(str(source), pagesize=(width_pt, height_pt), pageCompression=0)
    pdf.drawImage(
        ImageReader(image_bytes),
        0,
        0,
        width=width_pt,
        height=height_pt,
        mask="auto",
    )
    pdf.showPage()
    pdf.save()

    success, metadata = StickerEngine(dpi=150).process_pdf(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        offset_mm=0.0,
        corner_style="round",
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        draw_cut_contour=True,
        shape_mode="contour",
        thrucut_enabled=True,
        thrucut_shape=thru_shape,
        thrucut_margin_mm=3.0,
        thrucut_margin_top_mm=1.25,
        thrucut_margin_bottom_mm=2.5,
        thrucut_margin_left_mm=3.75,
        thrucut_margin_right_mm=5.0,
        thrucut_radius_mm=2.0,
        thrucut_spot_name="ThruCut",
        thrucut_color_hex="#22C55E",
    )
    assert success, metadata.get("error")
    assert len(metadata["pages"][0]["sticker_boxes"]) == 2

    assert split_or_normalize_sticker_tight_crop(str(output), metadata)

    page_trims = []
    with pikepdf.Pdf.open(output) as document:
        assert len(document.pages) == 2
        for page in document.pages:
            content = _content_bytes(page)
            assert b"/CutContour CS" in content
            assert b"/ThruCut CS" in content
            page_trims.append([float(value) for value in page.TrimBox])

    # Tồn tại resource/toán tử là chưa đủ: dao ngoài phải nằm trong khổ trang.
    # Sai phép tịnh tiến lặp hoặc crop chỉ ôm dao Demi sẽ cắt cụt dao ThruCut.
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.nup_diecut import extract_page_die_cut_path_groups

    document = pdf_lib.open(str(output))
    try:
        for page_index, page in enumerate(document):
            outer_groups = [
                group for group in extract_page_die_cut_path_groups(page)
                if group.get("spot_name") == "ThruCut"
            ]
            assert len(outer_groups) == 1
            outer = outer_groups[0]["rect"]
            assert outer.x0 >= -0.01
            assert outer.y0 >= -0.01
            assert outer.x1 <= page.rect.width + 0.01
            assert outer.y1 <= page.rect.height + 0.01

            # TrimBox là dao Demi. Kiểm tra bốn khoảng cách vật lý dao Đứt
            # để phát hiện đảo trên/dưới, margin bị mất và dịch tọa độ lặp.
            trim_x0, trim_y0, trim_x1, trim_y1 = page_trims[page_index]
            top = bottom = left = right = 3.0 * 72.0 / 25.4
            if thru_shape != "contour_offset":
                top, bottom, left, right = [
                    value * 72.0 / 25.4 for value in (1.25, 2.5, 3.75, 5.0)
                ]
            assert outer.x0 == pytest.approx(trim_x0 - left, abs=0.03)
            assert outer.x1 == pytest.approx(trim_x1 + right, abs=0.03)
            assert outer.y0 == pytest.approx(page.rect.height - trim_y1 - top, abs=0.03)
            assert outer.y1 == pytest.approx(page.rect.height - trim_y0 + bottom, abs=0.03)
    finally:
        document.close()

