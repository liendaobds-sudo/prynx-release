from pathlib import Path

import numpy as np
import pikepdf
from pypdf import PdfReader
import pypdfium2 as pdfium
import pytest
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw

from app.core.page_boxes import (
    MAX_CROP_REGIONS,
    PT_PER_MM,
    PageBoxesEngine,
    _page_rect_to_pixel_bbox,
    _pixel_bbox_to_cropbox,
    _choose_structural_crop_box,
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


def _make_user_unit_pdf(path: Path, user_unit: float = 2.0) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100.0, 50.0))
    page.obj[pikepdf.Name("/UserUnit")] = user_unit
    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array([10.0, 5.0, 90.0, 45.0])
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"0 0 0 rg 0 0 100 50 re f\n",
    )
    pdf.save(str(path))
    pdf.close()


def _physical_box_size(path: str, box_name: str = "/MediaBox") -> tuple[float, float]:
    with pikepdf.Pdf.open(path) as pdf:
        page = pdf.pages[0].obj
        unit = float(page.get("/UserUnit", 1))
        box = [float(value) for value in page[box_name]]
        return (
            (box[2] - box[0]) * unit / PT_PER_MM,
            (box[3] - box[1]) * unit / PT_PER_MM,
        )


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


def test_user_unit_page_boxes_and_exact_crop_use_physical_mm(tmp_path: Path):
    """PAGEBOX (audit 2026-08-04 §W1.PB6): không nhân kích thước Crop hai lần."""
    source = tmp_path / "user-unit-2.pdf"
    _make_user_unit_pdf(source)
    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output-user-unit"
    engine.output_dir.mkdir()

    boxes = engine.get_boxes(str(source), 1)
    assert boxes["mediabox"]["width"] == pytest.approx(200 / PT_PER_MM, abs=0.01)
    assert boxes["mediabox"]["height"] == pytest.approx(100 / PT_PER_MM, abs=0.01)
    assert boxes["cropbox"]["width"] == pytest.approx(160 / PT_PER_MM, abs=0.01)
    assert boxes["cropbox"]["height"] == pytest.approx(80 / PT_PER_MM, abs=0.01)

    output = engine.crop_regions_to_pages(
        str(source),
        1,
        [{"x0": 10.0, "y0": 5.0, "x1": 30.0, "y1": 15.0}],
    )
    assert _physical_box_size(output) == pytest.approx((20.0, 10.0), abs=0.01)
    cropped_boxes = engine.get_boxes(output, 1)
    assert cropped_boxes["mediabox"]["width"] == pytest.approx(20.0, abs=0.01)
    assert cropped_boxes["mediabox"]["height"] == pytest.approx(10.0, abs=0.01)


def test_set_page_boxes_converts_physical_mm_through_user_unit(tmp_path: Path):
    source = tmp_path / "user-unit-set-boxes.pdf"
    _make_user_unit_pdf(source)
    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output-set-user-unit"
    engine.output_dir.mkdir()

    output = engine.set_boxes(
        str(source),
        "cropbox",
        {"x0": 5.0, "y0": 5.0, "x1": 25.0, "y1": 15.0},
        pages=[1],
    )

    assert _physical_box_size(output) == pytest.approx((20.0, 10.0), abs=0.01)


def test_crop_range_keeps_physical_size_across_mixed_user_units(tmp_path: Path):
    """PB6: cùng vùng mm không được đổi kích thước giữa các trang khác `/UserUnit`."""
    source = tmp_path / "mixed-user-units.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200.0, 100.0))
    second = pdf.add_blank_page(page_size=(100.0, 50.0))
    second.obj[pikepdf.Name("/UserUnit")] = 2.0
    pdf.save(source)
    pdf.close()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output-mixed-user-units"
    engine.output_dir.mkdir()
    output = engine.crop_regions_to_pages(
        str(source),
        1,
        [{"x0": 10.0, "y0": 5.0, "x1": 30.0, "y1": 15.0}],
        pages=[1, 2],
    )

    with pikepdf.Pdf.open(output) as cropped:
        assert len(cropped.pages) == 2
        physical_sizes = []
        for page in cropped.pages:
            unit = float(page.get("/UserUnit", 1) or 1)
            box = [float(value) for value in page.MediaBox]
            physical_sizes.append((
                (box[2] - box[0]) * unit / PT_PER_MM,
                (box[3] - box[1]) * unit / PT_PER_MM,
            ))
    assert physical_sizes[0] == pytest.approx((20.0, 10.0), abs=0.01)
    assert physical_sizes[1] == pytest.approx((20.0, 10.0), abs=0.01)


def test_edge_detection_thresholds_and_results_use_physical_user_unit_mm(
    tmp_path: Path,
    monkeypatch,
):
    """PB6: ngưỡng 3 mm và kết quả API phải là mm vật lý, không phải raw unit."""
    import app.core.page_boxes as page_boxes
    import pypdfium2.raw as pdfium_c

    source = tmp_path / "user-unit-detect.pdf"
    _make_user_unit_pdf(source)
    unit = 2.0
    visible = [10.0, 5.0, 90.0, 45.0]
    inset_raw = 3.0 * PT_PER_MM / unit
    candidate = [
        visible[0] + inset_raw,
        visible[1] + inset_raw,
        visible[2] - inset_raw,
        visible[3] - inset_raw,
    ]
    monkeypatch.setattr(
        page_boxes,
        "_pdfium_object_candidates",
        lambda *_args: [(candidate, int(pdfium_c.FPDF_PAGEOBJ_PATH))],
    )
    rough = {
        "x0": visible[0] * unit / PT_PER_MM,
        "y0": visible[1] * unit / PT_PER_MM,
        "x1": visible[2] * unit / PT_PER_MM,
        "y1": visible[3] * unit / PT_PER_MM,
    }

    result = PageBoxesEngine().detect_crop_regions(
        str(source), 1, [rough], max_trim_mm=5.0,
    )["regions"][0]

    assert result["changed"] is True
    assert result["method"] == "object"
    assert result["trim_mm"] == {
        "left": 3.0, "bottom": 3.0, "right": 3.0, "top": 3.0,
    }
    assert result["rect_mm"]["x0"] == pytest.approx(rough["x0"] + 3.0, abs=0.01)
    assert result["rect_mm"]["y0"] == pytest.approx(rough["y0"] + 3.0, abs=0.01)


def test_crop_can_replace_source_page_and_preserve_document_order(tmp_path: Path):
    source = tmp_path / "three-pages.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(100 * PT_PER_MM, 60 * PT_PER_MM))
    for label in ("FIRST", "MIDDLE", "LAST"):
        pdf.setFont("Helvetica-Bold", 16)
        pdf.drawString(20 * PT_PER_MM, 30 * PT_PER_MM, label)
        pdf.showPage()
    pdf.save()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output"
    engine.output_dir.mkdir()
    output = engine.crop_regions_to_pages(
        str(source),
        2,
        [{"x0": 10, "y0": 10, "x1": 90, "y1": 50}],
        keep_other_pages=True,
    )

    with pikepdf.Pdf.open(output) as cropped:
        assert len(cropped.pages) == 3
        assert list(map(float, cropped.pages[0].MediaBox)) == pytest.approx([0, 0, 100 * PT_PER_MM, 60 * PT_PER_MM], abs=0.02)
        assert list(map(float, cropped.pages[1].MediaBox)) == pytest.approx([0, 0, 80 * PT_PER_MM, 40 * PT_PER_MM], abs=0.02)
        assert list(map(float, cropped.pages[2].MediaBox)) == pytest.approx([0, 0, 100 * PT_PER_MM, 60 * PT_PER_MM], abs=0.02)

    page_text = [page.extract_text() or "" for page in PdfReader(output).pages]
    assert "FIRST" in page_text[0]
    assert "MIDDLE" in page_text[1]
    assert "LAST" in page_text[2]


def test_crop_can_apply_same_regions_to_multiple_pages(tmp_path: Path):
    source = tmp_path / "three-pages-scope.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(100 * PT_PER_MM, 60 * PT_PER_MM))
    for label in ("FIRST", "MIDDLE", "LAST"):
        pdf.drawString(20 * PT_PER_MM, 30 * PT_PER_MM, label)
        pdf.showPage()
    pdf.save()

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output"
    engine.output_dir.mkdir()
    output = engine.crop_regions_to_pages(
        str(source),
        1,
        [{"x0": 10, "y0": 10, "x1": 90, "y1": 50}],
        keep_other_pages=True,
        pages=[1, 3],
    )

    with pikepdf.Pdf.open(output) as cropped:
        assert len(cropped.pages) == 3
        assert list(map(float, cropped.pages[0].MediaBox)) == pytest.approx([0, 0, 80 * PT_PER_MM, 40 * PT_PER_MM], abs=0.02)
        assert list(map(float, cropped.pages[1].MediaBox)) == pytest.approx([0, 0, 100 * PT_PER_MM, 60 * PT_PER_MM], abs=0.02)
        assert list(map(float, cropped.pages[2].MediaBox)) == pytest.approx([0, 0, 80 * PT_PER_MM, 40 * PT_PER_MM], abs=0.02)


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


@pytest.mark.parametrize(
    ("rotation", "raw_rect", "expected_rgb", "expected_display_size"),
    [
        (0, [0, 50, 100, 100], (30, 180, 70), (100, 50)),
        (90, [0, 0, 100, 50], (220, 30, 30), (50, 100)),
        (180, [100, 0, 200, 50], (30, 80, 220), (100, 50)),
        (270, [100, 50, 200, 100], (230, 190, 20), (50, 100)),
    ],
)
def test_visible_top_left_quarter_crops_and_reopens_for_every_rotation(
    tmp_path: Path,
    rotation: int,
    raw_rect: list[float],
    expected_rgb: tuple[int, int, int],
    expected_display_size: tuple[int, int],
):
    """Khóa artifact cho cùng bảng ánh xạ /Rotate mà CropDialog sử dụng."""
    source = tmp_path / f"crop-rotate-{rotation}.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(200, 100))
    for color, x, y in (
        (HexColor("#DC1E1E"), 0, 0),
        (HexColor("#1E50DC"), 100, 0),
        (HexColor("#1EB446"), 0, 50),
        (HexColor("#E6BE14"), 100, 50),
    ):
        pdf.setFillColor(color)
        pdf.rect(x, y, 100, 50, fill=1, stroke=0)
    pdf.showPage()
    pdf.save()
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        doc.pages[0].Rotate = rotation
        doc.save(source)

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / f"output-{rotation}"
    engine.output_dir.mkdir()
    assert engine.get_boxes(str(source), 1)["rotation"] == rotation

    x0, y0, x1, y1 = raw_rect
    output = engine.crop_regions_to_pages(
        str(source),
        1,
        [{
            "x0": x0 / PT_PER_MM,
            "y0": y0 / PT_PER_MM,
            "x1": x1 / PT_PER_MM,
            "y1": y1 / PT_PER_MM,
        }],
    )

    rendered = pdfium.PdfDocument(output)
    try:
        image = np.asarray(rendered[0].render(scale=1).to_pil().convert("RGB"))
    finally:
        rendered.close()
    assert (image.shape[1], image.shape[0]) == expected_display_size
    center_patch = image[
        image.shape[0] // 2 - 2:image.shape[0] // 2 + 3,
        image.shape[1] // 2 - 2:image.shape[1] // 2 + 3,
    ]
    assert tuple(np.mean(center_patch, axis=(0, 1))) == pytest.approx(expected_rgb, abs=5)


def test_crop_range_uses_same_display_coordinates_across_mixed_rotations(tmp_path: Path):
    """PB4: cùng khung nhìn phải chọn đúng nội dung trên từng /Rotate."""
    source = tmp_path / "crop-mixed-rotations.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(200, 100))
    for _ in range(2):
        for color, x, y in (
            (HexColor("#DC1E1E"), 0, 0),
            (HexColor("#1E50DC"), 100, 0),
            (HexColor("#1EB446"), 0, 50),
            (HexColor("#E6BE14"), 100, 50),
        ):
            pdf.setFillColor(color)
            pdf.rect(x, y, 100, 50, fill=1, stroke=0)
        pdf.showPage()
    pdf.save()
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        doc.pages[0].Rotate = 0
        doc.pages[1].Rotate = 90
        doc.save(source)

    engine = PageBoxesEngine()
    engine.output_dir = tmp_path / "output-mixed-rotations"
    engine.output_dir.mkdir()
    raw_rect = {"x0": 0, "y0": 50 / PT_PER_MM, "x1": 100 / PT_PER_MM, "y1": 100 / PT_PER_MM}
    display_rect = {"x0": 0, "y0": 0, "x1": 100 / PT_PER_MM, "y1": 50 / PT_PER_MM}
    output = engine.crop_regions_to_pages(
        str(source), 1, [raw_rect], pages=[1, 2], display_rects_mm=[display_rect],
    )

    rendered = pdfium.PdfDocument(output)
    try:
        first = np.asarray(rendered[0].render(scale=1).to_pil().convert("RGB"))
        second = np.asarray(rendered[1].render(scale=1).to_pil().convert("RGB"))
    finally:
        rendered.close()

    # Cả hai trang giữ đúng khung hiển thị 100×50 pt. Trang 0° lấy trọn ô xanh
    # lá; trang 90° lấy cùng tọa độ mm nên gồm nửa đỏ bên trái, nửa xanh lá bên phải.
    assert (first.shape[1], first.shape[0]) == (100, 50)
    assert (second.shape[1], second.shape[0]) == (100, 50)
    assert tuple(np.mean(first[20:30, 45:55], axis=(0, 1))) == pytest.approx((30, 180, 70), abs=5)
    assert tuple(np.mean(second[20:30, 20:30], axis=(0, 1))) == pytest.approx((220, 30, 30), abs=5)
    assert tuple(np.mean(second[20:30, 70:80], axis=(0, 1))) == pytest.approx((30, 180, 70), abs=5)


def test_edge_detection_preserves_declared_bleedbox(tmp_path: Path):
    source = tmp_path / "declared-bleed.pdf"
    page_w, page_h = 110.0, 60.0
    pdf = canvas.Canvas(str(source), pagesize=(page_w * PT_PER_MM, page_h * PT_PER_MM))
    pdf.setFillColor(HexColor("#167D3A"))
    pdf.rect(2 * PT_PER_MM, 2 * PT_PER_MM, 106 * PT_PER_MM, 56 * PT_PER_MM, fill=1, stroke=0)
    pdf.showPage()
    pdf.save()
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as doc:
        page = doc.pages[0]
        page.TrimBox = pikepdf.Array([5 * PT_PER_MM, 5 * PT_PER_MM, 105 * PT_PER_MM, 55 * PT_PER_MM])
        page.BleedBox = pikepdf.Array([2 * PT_PER_MM, 2 * PT_PER_MM, 108 * PT_PER_MM, 58 * PT_PER_MM])
        doc.save(source)

    result = PageBoxesEngine().detect_crop_regions(
        str(source), 1, [{"x0": 0, "y0": 0, "x1": page_w, "y1": page_h}], max_trim_mm=5,
    )["regions"][0]

    assert result["changed"] is True
    assert result["safe_to_apply"] is True
    assert result["method"] == "bleedbox"
    assert result["rect_mm"] == {
        "x0": 2.0, "y0": 2.0, "x1": 108.0, "y1": 58.0,
        "width": 106.0, "height": 56.0,
    }


def test_pixel_only_edge_is_suggestion_and_never_auto_trims(tmp_path: Path, monkeypatch):
    import app.core.page_boxes as page_boxes

    source = tmp_path / "white-bleed.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(100 * PT_PER_MM, 60 * PT_PER_MM))
    pdf.drawString(20 * PT_PER_MM, 30 * PT_PER_MM, "CONTENT")
    pdf.showPage()
    pdf.save()

    monkeypatch.setattr(page_boxes, "_pdfium_object_candidates", lambda *_args: [])
    suggestion = [
        3 * PT_PER_MM, 3 * PT_PER_MM,
        97 * PT_PER_MM, 57 * PT_PER_MM,
    ]
    monkeypatch.setattr(page_boxes, "_detect_raster_crop_box", lambda *_args: suggestion)

    result = PageBoxesEngine().detect_crop_regions(
        str(source), 1, [{"x0": 0, "y0": 0, "x1": 100, "y1": 60}], max_trim_mm=5,
    )["regions"][0]

    assert result["changed"] is False
    assert result["safe_to_apply"] is False
    assert result["method"] == "pixels"
    assert result["rect_mm"]["width"] == pytest.approx(100.0)
    assert result["rect_mm"]["height"] == pytest.approx(60.0)
    assert result["suggested_rect_mm"]["x0"] == pytest.approx(3.0)
    assert result["suggested_rect_mm"]["y0"] == pytest.approx(3.0)


def test_structural_detection_prefers_outermost_artwork_boundary():
    import pypdfium2.raw as pdfium_c

    rough = [0, 0, 100 * PT_PER_MM, 60 * PT_PER_MM]
    inner_image = ([3 * PT_PER_MM, 3 * PT_PER_MM, 97 * PT_PER_MM, 57 * PT_PER_MM], int(pdfium_c.FPDF_PAGEOBJ_IMAGE))
    outer_path = ([1 * PT_PER_MM, 1 * PT_PER_MM, 99 * PT_PER_MM, 59 * PT_PER_MM], int(pdfium_c.FPDF_PAGEOBJ_PATH))

    detected = _choose_structural_crop_box(rough, [inner_image, outer_path], 5 * PT_PER_MM)

    assert detected == pytest.approx(outer_path[0])


@pytest.mark.parametrize("user_unit", [1.0, 100.0])
def test_structural_detection_score_is_invariant_across_user_unit(user_unit: float):
    """PB6: cùng hai boundary vật lý phải chọn giống nhau ở mọi `/UserUnit`."""
    import pypdfium2.raw as pdfium_c

    raw_per_mm = PT_PER_MM / user_unit
    rough = [0.0, 0.0, 100.0 * raw_per_mm, 60.0 * raw_per_mm]
    # Hai boundary cố ý nằm hai phía của lỗi cũ: sàn `1.0` raw unit chọn B ở
    # `/UserUnit=1` nhưng lại chọn A ở `/UserUnit=100` dù hình học vật lý như nhau.
    candidate_a_mm = [2.0, 0.0, 98.0, 60.0]
    candidate_b_mm = [0.0, 1.209, 100.0, 58.791]
    candidates = [
        ([value * raw_per_mm for value in candidate], int(pdfium_c.FPDF_PAGEOBJ_PATH))
        for candidate in (candidate_a_mm, candidate_b_mm)
    ]

    detected = _choose_structural_crop_box(
        rough,
        candidates,
        5.0 * raw_per_mm,
        user_unit,
    )
    assert detected is not None
    detected_mm = [value / raw_per_mm for value in detected]

    assert detected_mm == pytest.approx(candidate_b_mm, abs=1e-6)


def test_raster_cards_on_uniform_background_are_safely_split(tmp_path: Path):
    width, height = 503, 570
    image_path = tmp_path / "two-raster-cards.png"
    image = Image.new("RGB", (width, height), (208, 208, 208))
    draw = ImageDraw.Draw(image)
    draw.rectangle((80, 35, 427, 260), fill=(18, 55, 105))
    draw.rectangle((80, 290, 427, 515), fill=(250, 250, 250))
    draw.rectangle((80, 470, 427, 515), fill=(18, 55, 105))
    image.save(image_path)

    source = tmp_path / "two-raster-cards.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(width, height))
    pdf.drawImage(ImageReader(str(image_path)), 0, 0, width=width, height=height)
    pdf.showPage()
    pdf.save()

    # Only two pixels of background are left around each card. This mirrors a
    # user dragging tightly around the artwork: the local selection border is
    # mostly card pixels, so detection must use the uniform page background.
    visual_rough_rects = [
        (78, 33, 430, 263),
        (78, 288, 430, 518),
    ]
    rough_rects_mm = [
        {
            "x0": x0 / PT_PER_MM,
            "y0": (height - y1) / PT_PER_MM,
            "x1": x1 / PT_PER_MM,
            "y1": (height - y0) / PT_PER_MM,
        }
        for x0, y0, x1, y1 in visual_rough_rects
    ]

    regions = PageBoxesEngine().detect_crop_regions(
        str(source), 1, rough_rects_mm, max_trim_mm=6,
    )["regions"]

    assert len(regions) == 2
    assert all(region["method"] == "background" for region in regions)
    assert all(region["changed"] is True for region in regions)
    assert all(region["safe_to_apply"] is True for region in regions)
    visual_results = [
        [
            round(region["rect_mm"]["x0"] * PT_PER_MM),
            round(height - region["rect_mm"]["y1"] * PT_PER_MM),
            round(region["rect_mm"]["x1"] * PT_PER_MM),
            round(height - region["rect_mm"]["y0"] * PT_PER_MM),
        ]
        for region in regions
    ]
    assert visual_results[0] == pytest.approx([80, 35, 428, 261], abs=1)
    assert visual_results[1] == pytest.approx([80, 290, 428, 516], abs=1)
