"""Hồi quy N-Up khi trang logic nằm trong CropBox trên MediaBox lớn."""

from __future__ import annotations

import pikepdf
import pytest

from app.workers import nup_engine
from app.workers import pdf_wrapper as pdf_lib
from app.workers.mixed_guillotine_adapter import resolve_guillotine_trim


LARGE_MEDIA = [50.0, 30.0, 956.15, 1383.60]
LOGICAL_CROP = [100.0, 80.0, 517.04, 225.51]


def _make_cropbox_pdf(path, media_box, crop_box):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(
        page_size=(media_box[2] - media_box[0], media_box[3] - media_box[1]),
    )
    page.obj[pikepdf.Name("/MediaBox")] = pikepdf.Array(media_box)
    page.obj[pikepdf.Name("/CropBox")] = pikepdf.Array(crop_box)
    if "/TrimBox" in page.obj:
        del page.obj[pikepdf.Name("/TrimBox")]
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"q 0 0 0 1 k 100 80 417.04 145.51 re f Q\n",
    )
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _box(path, name):
    with pikepdf.Pdf.open(path) as pdf:
        return [float(value) for value in pdf.pages[0].obj[name]]


def _do_count(path):
    with pikepdf.Pdf.open(path) as pdf:
        return sum(
            str(instruction.operator) == "Do"
            for page in pdf.pages
            for instruction in pikepdf.parse_content_stream(page)
        )


def _minimum_rendered_gray(path):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        bitmap = doc[0].render(scale=0.5)
        return bitmap.to_pil().convert("L").getextrema()[0]
    finally:
        doc.close()


def test_canonicalization_preserves_large_logical_cropbox(tmp_path):
    source = _make_cropbox_pdf(
        tmp_path / "large-canvas.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )

    canonical, is_temporary = nup_engine._canonicalize_page_space(
        source,
        "logical-cropbox",
    )
    assert is_temporary is True
    assert _box(canonical, "/MediaBox") == pytest.approx(
        [0.0, 0.0, LARGE_MEDIA[2] - LARGE_MEDIA[0], LARGE_MEDIA[3] - LARGE_MEDIA[1]],
    )
    assert _box(canonical, "/CropBox") == pytest.approx(
        [
            LOGICAL_CROP[0] - LARGE_MEDIA[0],
            LOGICAL_CROP[1] - LARGE_MEDIA[1],
            LOGICAL_CROP[2] - LARGE_MEDIA[0],
            LOGICAL_CROP[3] - LARGE_MEDIA[1],
        ],
    )

    doc = pdf_lib.open(canonical)
    try:
        assert resolve_guillotine_trim(doc[0], 0.0) == pytest.approx(
            (
                LOGICAL_CROP[2] - LOGICAL_CROP[0],
                LOGICAL_CROP[3] - LOGICAL_CROP[1],
            ),
        )
    finally:
        doc.close()


def test_small_crop_difference_keeps_media_as_logical_page(tmp_path):
    """CropBox chỉ hụt vài pt là crop/bleed thường, không phải trang con."""
    media = [50.0, 30.0, 250.0, 130.0]
    crop = [53.0, 33.0, 247.0, 127.0]
    source = _make_cropbox_pdf(tmp_path / "normal-crop.pdf", media, crop)
    canonical, _ = nup_engine._canonicalize_page_space(source, "normal-cropbox")

    doc = pdf_lib.open(canonical)
    try:
        assert resolve_guillotine_trim(doc[0], 0.0) == pytest.approx((200.0, 100.0))
    finally:
        doc.close()


def test_explicit_trimbox_remains_finished_size_even_when_difference_is_small(tmp_path):
    """TrimBox là khai báo thành phẩm rõ ràng, khác CropBox fallback vài pt."""
    media = [0.0, 0.0, 200.0, 100.0]
    source = _make_cropbox_pdf(tmp_path / "explicit-trim.pdf", media, media)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
        pdf.pages[0].obj[pikepdf.Name("/TrimBox")] = pikepdf.Array(
            [3.0, 3.0, 197.0, 97.0],
        )
        pdf.save(source)

    doc = pdf_lib.open(source)
    try:
        assert resolve_guillotine_trim(doc[0], 0.0) == pytest.approx((194.0, 94.0))
    finally:
        doc.close()


@pytest.mark.parametrize("layout_type", ["sequential", "repeat"])
def test_export_uses_logical_cropbox_and_border_does_not_change_layout(
    tmp_path,
    layout_type,
):
    source = _make_cropbox_pdf(
        tmp_path / f"logical-{layout_type}.pdf",
        LARGE_MEDIA,
        LOGICAL_CROP,
    )
    counts = []
    darkest_pixels = []
    for enabled in (False, True):
        output = tmp_path / f"out-{layout_type}-{int(enabled)}.pdf"
        nup_engine.run_nup_engine(
            source,
            str(output),
            {
                "isDieCutMode": False,
                "sheetWidth": 320.0,
                "sheetHeight": 450.0,
                "layoutType": layout_type,
                "gridStrategy": "optimal_auto",
                "targetQuantity": 1,
                "targetQuantitiesByPage": {"0": 1},
                "gapX": 0.0,
                "gapY": 0.0,
                "markType": "none",
                "pontType": "none",
                "bleed": 0.0,
                "cutBorderEnabled": enabled,
                "cutBorderPosition": "trim",
                "cutBorderColor": "#000000",
                "cutBorderThickness": 0.3,
            },
            job_id=f"logical-{layout_type}-{int(enabled)}",
        )
        counts.append(_do_count(output))
        darkest_pixels.append(_minimum_rendered_gray(output))

    assert counts[0] == counts[1]
    assert counts[0] >= 1
    assert all(value < 64 for value in darkest_pixels), (
        "Artwork trong CropBox phải thật sự hiện trên tờ, không chỉ có toán tử Do."
    )
