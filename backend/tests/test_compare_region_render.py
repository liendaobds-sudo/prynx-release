"""Parity primitive render vùng cho Compare tile (PERF audit 2026-08-19 §CL.1)."""

import numpy as np
import pytest


def _make_region_pdf(path) -> None:
    from app.workers import pdf_wrapper as pdf_lib

    doc = pdf_lib.open()
    page = doc.new_page(width=301, height=407)
    shape = page.new_shape()
    shape.draw_rect(pdf_lib.Rect(17, 23, 284, 389))
    shape.finish(color=(0.1, 0.3, 0.8), fill=(0.8, 0.2, 0.1))
    shape.commit()
    shape = page.new_shape()
    shape.draw_line(pdf_lib.Point(0, 206), pdf_lib.Point(301, 206))
    shape.finish(color=(0, 0, 0), width=0.75)
    shape.commit()
    doc.save(str(path))
    doc.close()


@pytest.mark.parametrize(
    "region",
    [
        (0, 0, 111, 173),
        (111, 173, 127, 149),
        (238, 322, 181, 244),
        (0, 0, 419, 566),
    ],
)
def test_region_render_matches_full_render_crop(tmp_path, region):
    from app.core.pdf_processor import PDFProcessor

    source = tmp_path / "region.pdf"
    _make_region_pdf(source)
    x_px, y_px, width_px, height_px = region

    with PDFProcessor().open_document(str(source), dpi=100) as doc:
        full = doc.render_page(0)
        assert doc.page_pixel_size(0) == (full.shape[1], full.shape[0])
        rendered, _cmyk = doc.render_page_region(
            0,
            x_px=x_px,
            y_px=y_px,
            width_px=width_px,
            height_px=height_px,
        )

    expected = full[y_px:y_px + height_px, x_px:x_px + width_px]
    assert np.array_equal(rendered, expected)


def test_region_bundle_cmyk_matches_full_bundle_crop(tmp_path):
    from app.core.pdf_processor import PDFProcessor

    source = tmp_path / "region-cmyk.pdf"
    _make_region_pdf(source)
    x_px, y_px, width_px, height_px = (83, 91, 211, 257)

    with PDFProcessor().open_document(str(source), dpi=100) as doc:
        _rgb_full, cmyk_full = doc.render_page_bundle(0, include_cmyk=True)
        _rgb_region, cmyk_region = doc.render_page_region(
            0,
            x_px=x_px,
            y_px=y_px,
            width_px=width_px,
            height_px=height_px,
            include_cmyk=True,
        )

    assert cmyk_full is not None and cmyk_region is not None
    expected = cmyk_full[y_px:y_px + height_px, x_px:x_px + width_px]
    assert np.array_equal(cmyk_region, expected)


def test_region_render_rejects_out_of_bounds(tmp_path):
    from app.core.pdf_processor import PDFProcessor

    source = tmp_path / "region-invalid.pdf"
    _make_region_pdf(source)

    with PDFProcessor().open_document(str(source), dpi=100) as doc:
        width_px, height_px = doc.page_pixel_size(0)
        with pytest.raises(ValueError, match="vượt kích thước trang"):
            doc.render_page_region(
                0,
                x_px=width_px - 10,
                y_px=height_px - 10,
                width_px=11,
                height_px=11,
            )
