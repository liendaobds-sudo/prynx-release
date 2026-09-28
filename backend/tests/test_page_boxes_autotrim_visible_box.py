"""PAGEBOX (audit 2026-09-28 §WBR28.01): xén theo đúng vùng renderer nhìn thấy."""
from contextlib import closing

import numpy as np
import pikepdf
import pytest

from app.core.page_boxes import PT_PER_MM, PageBoxesEngine
from app.core.pdfium_lock import pdfium_guard

pdfium = pytest.importorskip("pypdfium2")
ALL_SIDES = ["left", "top", "right", "bottom"]


@pytest.fixture
def engine(tmp_path):
    instance = PageBoxesEngine()
    instance.output_dir = tmp_path / "results"
    instance.output_dir.mkdir()
    return instance


def _raw_box(box, origin, user_unit):
    return [value / user_unit + origin[index % 2] for index, value in enumerate(box)]


def _write_pdf(
    path, crop, rotation=0, user_unit=1.0, origin=(0.0, 0.0), *,
    blank=False, inherit_boxes=False, extra_page=False,
):
    """Mốc xanh sát mép trái artwork giúp bắt mất nội dung, không chỉ sai page box."""
    with pikepdf.Pdf.new() as pdf:
        page = pdf.add_blank_page(page_size=(200, 100))
        page.MediaBox = pikepdf.Array(_raw_box([0, 0, 200, 100], origin, user_unit))
        if crop is not None:
            page.CropBox = pikepdf.Array(_raw_box(crop, origin, user_unit))
        page.Rotate = rotation
        page.UserUnit = user_unit
        content = (
            f"q {1 / user_unit:g} 0 0 {1 / user_unit:g} {origin[0]:g} {origin[1]:g} cm\n"
            "1 0 0 rg 40 10 120 80 re f\n"
            "0 0 1 rg 40 10 4 80 re f\nQ\n"
        )
        page.Contents = pikepdf.Stream(pdf, b"" if blank else content.encode("ascii"))
        if inherit_boxes:
            for name in ("/MediaBox", "/CropBox", "/Rotate"):
                if name in page.obj:
                    page.obj.Parent[name] = page.obj[name]
                    del page.obj[name]
        if extra_page:
            other = pdf.add_blank_page(page_size=(130, 170))
            other.CropBox = pikepdf.Array([5, 10, 120, 160])
            other.TrimBox = pikepdf.Array([10, 15, 115, 155])
            other.Rotate = 270
            other.Contents = pikepdf.Stream(pdf, b"0 1 0 rg 10 15 105 140 re f\n")
        pdf.save(path)


def _render(path, page_index=0):
    """Render 288 DPI vật lý; PDFium không tự nhân /UserUnit vào scale."""
    with pikepdf.Pdf.open(path) as pdf:
        user_unit = float(pdf.pages[page_index].get("/UserUnit", 1))
    with pdfium_guard("test_auto_trim_visible_box"):
        with pdfium.PdfDocument(str(path)) as pdf:
            with closing(pdf[page_index]) as page:
                with closing(page.render(scale=4 * user_unit)) as bitmap:
                    return np.array(bitmap.to_pil().convert("RGB"), copy=True)


def _physical_box(path, origin=(0.0, 0.0)):
    with pikepdf.Pdf.open(path) as pdf:
        page = pdf.pages[0]
        user_unit = float(page.get("/UserUnit", 1))
        assert list(page.MediaBox) == list(page.CropBox)
        return [
            (float(value) - origin[index % 2]) * user_unit
            for index, value in enumerate(page.MediaBox)
        ]


def _blue_pixels(rgb):
    return int(((rgb[:, :, 2] > 180) & (rgb[:, :, 0] < 80) & (rgb[:, :, 1] < 80)).sum())


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("user_unit", [1.0, 2.0])
@pytest.mark.parametrize(
    ("origin", "margin_mm"),
    [((0.0, 0.0), 0.0), ((-70.0, 31.0), 0.0), ((-70.0, -31.0), 1.5)],
)
def test_outside_crop_matches_visible_control(
    tmp_path, engine, rotation, user_unit, origin, margin_mm,
):
    """Nguồn giống pixel phải xén giống nhau, giữ mốc xanh và lề vật lý qua mọi góc."""
    control = tmp_path / "intersection.pdf"
    outside = tmp_path / "outside.pdf"
    _write_pdf(control, [20, 0, 200, 100], rotation, user_unit, origin)
    _write_pdf(outside, [20, -10, 220, 110], rotation, user_unit, origin)
    source_bytes = outside.read_bytes()
    source_rgb = _render(outside)
    np.testing.assert_array_equal(source_rgb, _render(control))

    expected = engine.auto_trim(str(control), margin_mm=margin_mm, trim_sides=ALL_SIDES)
    actual = engine.auto_trim(str(outside), margin_mm=margin_mm, trim_sides=ALL_SIDES)

    margin_pt = margin_mm * PT_PER_MM
    expected_box = [40 - margin_pt, 10 - margin_pt, 160 + margin_pt, 90 + margin_pt]
    assert _physical_box(actual, origin) == pytest.approx(expected_box, abs=0.55)
    assert _physical_box(actual, origin) == pytest.approx(_physical_box(expected, origin))
    actual_rgb = _render(actual)
    np.testing.assert_array_equal(actual_rgb, _render(expected))
    # Sai số dò 200 DPI có thể mất một hàng AA, không được cắt nửa dải xanh 4 pt.
    assert _blue_pixels(actual_rgb) >= 0.98 * _blue_pixels(source_rgb)
    with pikepdf.Pdf.open(actual) as pdf:
        assert int(pdf.pages[0].Rotate) == rotation
        assert float(pdf.pages[0].UserUnit) == user_unit
    assert outside.read_bytes() == source_bytes


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("side", ALL_SIDES)
def test_outside_crop_keeps_unselected_display_edges(tmp_path, engine, rotation, side):
    """Cạnh người dùng chọn thuộc ảnh đã xoay; ba cạnh còn lại giữ vùng nhìn thấy."""
    source = tmp_path / "one-side.pdf"
    _write_pdf(source, [20, -10, 220, 110], rotation)
    output = engine.auto_trim(str(source), trim_sides=[side])

    # Chỉ số cạnh raw trong [x0,y0,x1,y1] ứng với trái/trên/phải/dưới hiển thị.
    raw_edges = {
        0: {"left": 0, "top": 3, "right": 2, "bottom": 1},
        90: {"left": 1, "top": 0, "right": 3, "bottom": 2},
        180: {"left": 2, "top": 1, "right": 0, "bottom": 3},
        270: {"left": 3, "top": 2, "right": 1, "bottom": 0},
    }
    edge = raw_edges[rotation][side]
    expected = [20, 0, 200, 100]
    expected[edge] = [40, 10, 160, 90][edge]
    actual = _physical_box(output)
    assert actual == pytest.approx(expected, abs=0.55)
    for index in range(4):
        if index != edge:
            assert actual[index] == pytest.approx(expected[index], abs=1e-6)
    assert _blue_pixels(_render(output)) >= 0.98 * _blue_pixels(_render(source))


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("crop", [None, [20, 5, 180, 95]])
def test_missing_or_inside_crop_keeps_existing_behavior(tmp_path, engine, rotation, crop):
    source = tmp_path / "ordinary.pdf"
    _write_pdf(source, crop, rotation)
    output = engine.auto_trim(str(source), trim_sides=ALL_SIDES)
    assert _physical_box(output) == pytest.approx([40, 10, 160, 90], abs=0.55)
    assert _blue_pixels(_render(output)) >= 0.98 * _blue_pixels(_render(source))


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_inherited_boxes_use_renderer_visible_area(tmp_path, engine, rotation):
    source = tmp_path / "inherited.pdf"
    _write_pdf(source, [20, -10, 220, 110], rotation, inherit_boxes=True)
    with pikepdf.Pdf.open(source, inherit_page_attributes=False) as pdf:
        assert "/CropBox" not in pdf.pages[0].obj
        assert "/CropBox" in pdf.pages[0].obj.Parent
    output = engine.auto_trim(str(source), trim_sides=ALL_SIDES)
    assert _physical_box(output) == pytest.approx([40, 10, 160, 90], abs=0.55)
    assert _blue_pixels(_render(output)) >= 0.98 * _blue_pixels(_render(source))


def test_unselected_page_and_content_streams_are_unchanged(tmp_path, engine):
    source = tmp_path / "page-selection.pdf"
    _write_pdf(source, [20, -10, 220, 110], extra_page=True)
    source_bytes = source.read_bytes()
    output = engine.auto_trim(str(source), pages=[1], trim_sides=ALL_SIDES)
    assert _physical_box(output) == pytest.approx([40, 10, 160, 90], abs=0.55)
    with pikepdf.Pdf.open(source) as original, pikepdf.Pdf.open(output) as result:
        assert len(result.pages) == len(original.pages) == 2
        for index in range(2):
            assert result.pages[index].Contents.read_bytes() == original.pages[index].Contents.read_bytes()
        for name in ("/MediaBox", "/CropBox", "/TrimBox", "/Rotate"):
            assert result.pages[1].obj[name] == original.pages[1].obj[name]
    np.testing.assert_array_equal(_render(output, 1), _render(source, 1))
    assert source.read_bytes() == source_bytes


def test_blank_legacy_page_keeps_original_outside_crop(tmp_path, engine):
    source = tmp_path / "blank.pdf"
    _write_pdf(source, [20, -10, 220, 110], blank=True)
    output = engine.auto_trim(str(source))
    with pikepdf.Pdf.open(output) as pdf:
        assert list(pdf.pages[0].MediaBox) == [0, 0, 200, 100]
        assert list(pdf.pages[0].CropBox) == [20, -10, 220, 110]


@pytest.mark.parametrize("crop", [[200, 0, 220, 100], [0, 100, 200, 120], [210, 0, 230, 100]])
def test_empty_visible_area_fails_without_artifact(tmp_path, engine, crop):
    source = tmp_path / "empty-intersection.pdf"
    _write_pdf(source, crop)
    source_bytes = source.read_bytes()
    with pytest.raises(ValueError, match=r"Trang 1: .*vùng hiển thị"):
        engine.auto_trim(str(source), trim_sides=ALL_SIDES)
    assert list(engine.output_dir.iterdir()) == []
    assert source.read_bytes() == source_bytes


@pytest.mark.parametrize("bbox", [(float("nan"), 0, 200, 100), (0, 0, float("inf"), 100)])
def test_invalid_renderer_bbox_is_rejected_before_render(tmp_path, engine, monkeypatch, bbox):
    """Không chuyển tọa độ không hữu hạn vào phép ánh xạ hoặc tạo bitmap."""
    source = tmp_path / "invalid-bbox.pdf"
    _write_pdf(source, [20, 0, 200, 100])
    monkeypatch.setattr(pdfium.PdfPage, "get_bbox", lambda self: bbox)

    def unexpected_render(self, *args, **kwargs):
        pytest.fail("Không được render khi vùng hiển thị không hợp lệ")

    monkeypatch.setattr(pdfium.PdfPage, "render", unexpected_render)
    with pytest.raises(ValueError, match=r"Trang 1: .*vùng hiển thị"):
        engine.auto_trim(str(source), trim_sides=ALL_SIDES)
    assert list(engine.output_dir.iterdir()) == []
