from pathlib import Path

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest
from reportlab.lib.colors import HexColor, white
from reportlab.pdfgen import canvas

from app.core.page_boxes import (
    MAX_CROP_REGIONS,
    PT_PER_MM,
    PageBoxesEngine,
    _page_rect_to_pixel_bbox,
    _pixel_bbox_to_cropbox,
)


def _make_two_card_pdf(path: Path) -> list[tuple[float, float]]:
    mm = PT_PER_MM
    pdf = canvas.Canvas(str(path), pagesize=(220 * mm, 130 * mm))
    cards = [
        ("front", HexColor("#167D3A"), "FRONT"),
        ("back", HexColor("#1856A8"), "BACK"),
    ]
    for name, color, label in cards:
        pdf.beginForm(name, 0, 0, 89 * mm, 51 * mm)
        pdf.setFillColor(white)
        pdf.rect(0, 0, 89 * mm, 51 * mm, fill=1, stroke=0)
        pdf.setFillColor(color)
        pdf.rect(52 * mm, 0, 37 * mm, 51 * mm, fill=1, stroke=0)
        pdf.setFont("Helvetica-Bold", 14)
        pdf.drawString(6 * mm, 31 * mm, label)
        pdf.setFont("Helvetica", 8)
        pdf.drawString(6 * mm, 18 * mm, "WHITE AREA MUST STAY")
        pdf.endForm()

    positions = [(12.0, 39.0), (119.0, 39.0)]
    for (x, y), (name, _, _) in zip(positions, cards):
        pdf.saveState()
        pdf.translate(x * mm, y * mm)
        pdf.doForm(name)
        pdf.restoreState()
        pdf.linkURL(
            f"https://example.com/{name}",
            ((x + 5) * mm, (y + 5) * mm, (x + 30) * mm, (y + 12) * mm),
            relative=0,
        )
    pdf.showPage()
    pdf.save()
    return positions


def _rough_rects(positions: list[tuple[float, float]]) -> list[dict]:
    return [
        {"x0": x - 2, "y0": y - 2, "x1": x + 91, "y1": y + 53}
        for x, y in positions
    ]


def test_detect_and_crop_two_card_faces_preserves_white_artwork(tmp_path: Path):
    source = tmp_path / "two-cards.pdf"
    positions = _make_two_card_pdf(source)
    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output"
    engine.output_dir.mkdir()

    detected = engine.detect_crop_regions(str(source), 1, _rough_rects(positions))

    assert len(detected["regions"]) == 2
    for result, (expected_x, expected_y) in zip(detected["regions"], positions):
        assert result["changed"] is True
        assert result["method"] == "object"
        rect = result["rect_mm"]
        assert rect["x0"] == pytest.approx(expected_x, abs=0.02)
        assert rect["y0"] == pytest.approx(expected_y, abs=0.02)
        assert rect["width"] == pytest.approx(89.0, abs=0.02)
        assert rect["height"] == pytest.approx(51.0, abs=0.02)

    output = engine.crop_regions_to_pages(
        str(source), 1, [result["rect_mm"] for result in detected["regions"]],
    )
    with pikepdf.Pdf.open(output) as cropped:
        assert len(cropped.pages) == 2
        for page in cropped.pages:
            expected = [0.0, 0.0, 89 * PT_PER_MM, 51 * PT_PER_MM]
            assert list(map(float, page.MediaBox)) == pytest.approx(expected, abs=0.02)
            assert list(map(float, page.CropBox)) == pytest.approx(expected, abs=0.02)
            assert list(map(float, page.TrimBox)) == pytest.approx(expected, abs=0.02)
            assert len(page.Annots) == 1
            assert list(map(float, page.Annots[0].Rect)) == pytest.approx(
                [5 * PT_PER_MM, 5 * PT_PER_MM, 30 * PT_PER_MM, 12 * PT_PER_MM],
                abs=0.02,
            )

    # Visual-content guard: intentional white area remains, while each card keeps its own colour.
    rendered = pdfium.PdfDocument(output)
    try:
        expected_colours = [(22, 125, 58), (24, 86, 168)]
        for page_index, expected_rgb in enumerate(expected_colours):
            image = np.asarray(rendered[page_index].render(scale=1.5).to_pil().convert("RGB"))
            left_patch = image[10:30, 10:30]
            right_patch = image[image.shape[0] // 3:2 * image.shape[0] // 3, -30:-10]
            assert float(left_patch.mean()) > 245.0
            assert tuple(np.mean(right_patch, axis=(0, 1)).round().astype(int)) == pytest.approx(expected_rgb, abs=3)
    finally:
        rendered.close()


def test_crop_clamps_regions_to_visible_cropbox(tmp_path: Path):
    source = tmp_path / "cropbox.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(300, 200))
    pdf.drawString(30, 30, "visible content")
    pdf.showPage()
    pdf.save()
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        doc.pages[0].CropBox = pikepdf.Array([20, 10, 280, 190])
        doc.save(source)

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output"
    engine.output_dir.mkdir()
    output = engine.crop_regions_to_pages(
        str(source), 1, [{"x0": -100, "y0": -100, "x1": 1000, "y1": 1000}],
    )

    with pikepdf.Pdf.open(output) as cropped:
        expected = [0.0, 0.0, 260.0, 180.0]
        assert list(map(float, cropped.pages[0].MediaBox)) == pytest.approx(expected, abs=0.01)
        assert list(map(float, cropped.pages[0].TrimBox)) == pytest.approx(expected, abs=0.01)


def test_crop_rejects_non_finite_and_excessive_region_lists(tmp_path: Path):
    source = tmp_path / "input.pdf"
    positions = _make_two_card_pdf(source)
    engine = PageBoxesEngine()
    valid = _rough_rects(positions)[0]

    with pytest.raises(ValueError, match="không hữu hạn"):
        engine.crop_regions_to_pages(
            str(source), 1, [{**valid, "x0": float("nan")}],
        )
    with pytest.raises(ValueError, match="tối đa"):
        engine.crop_regions_to_pages(
            str(source), 1, [valid] * (MAX_CROP_REGIONS + 1),
        )


def test_edge_detection_keeps_rough_region_when_white_edge_is_ambiguous(tmp_path: Path):
    source = tmp_path / "intentional-white.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(100 * PT_PER_MM, 60 * PT_PER_MM))
    pdf.setFillColor(HexColor("#167D3A"))
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(18 * PT_PER_MM, 28 * PT_PER_MM, "CONTENT")
    pdf.showPage()
    pdf.save()

    engine = PageBoxesEngine()
    rough = {"x0": 0, "y0": 0, "x1": 100, "y1": 60}
    result = engine.detect_crop_regions(str(source), 1, [rough], max_trim_mm=5)

    assert result["regions"][0]["changed"] is False
    assert result["regions"][0]["method"] == "unchanged"
    assert result["regions"][0]["rect_mm"]["width"] == pytest.approx(100.0, abs=0.02)
    assert result["regions"][0]["rect_mm"]["height"] == pytest.approx(60.0, abs=0.02)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_pixel_mapping_round_trips_all_page_rotations(rotation: int):
    cropbox = [20.0, 10.0, 620.0, 410.0]
    rect = [120.0, 60.0, 420.0, 310.0]
    display_width, display_height = ((400, 600) if rotation in (90, 270) else (600, 400))
    pixel_width, pixel_height = display_width * 2, display_height * 2

    pixel_rect = _page_rect_to_pixel_bbox(
        rect, pixel_width, pixel_height, cropbox, rotation,
    )
    restored = _pixel_bbox_to_cropbox(
        pixel_rect[0], pixel_rect[1], pixel_rect[2] - 1, pixel_rect[3] - 1,
        pixel_width, pixel_height, cropbox, rotation, 0.0,
    )

    assert restored == pytest.approx(rect, abs=0.01)
