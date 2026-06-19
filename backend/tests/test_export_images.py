"""Test xuất trang PDF ra ảnh (export.render_pdf_to_images)."""
import io
import os

import pytest

from app.api.routes.export import render_pdf_to_images
from app.workers import pdf_wrapper as pdf_lib


def _make_pdf(tmp_path, pages=3):
    doc = pdf_lib.open()
    for _ in range(pages):
        pg = doc.new_page(width=200, height=300)
        sh = pg.new_shape()
        sh.draw_rect(pdf_lib.Rect(20, 20, 120, 120))
        sh.finish(color=(0, 0, 0), fill=(0, 0, 0))
        sh.commit()
    p = str(tmp_path / "src.pdf")
    buf = io.BytesIO(); doc.save(buf); doc.close()
    open(p, "wb").write(buf.getvalue())
    return p


def _is_image(path, expect_fmt):
    from PIL import Image
    with Image.open(path) as im:
        im.verify()
        return im.format.lower() == expect_fmt


def test_export_png_all_pages(tmp_path):
    src = _make_pdf(tmp_path, 3)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72)
    assert len(files) == 3
    for f in files:
        assert os.path.exists(f)
        assert _is_image(f, "png")


def test_export_jpeg_page_range(tmp_path):
    src = _make_pdf(tmp_path, 4)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="jpeg", dpi=72, pages=[1, 3])
    assert len(files) == 2
    assert all(_is_image(f, "jpeg") for f in files)


def test_export_grayscale(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="png", dpi=72, color_mode="gray")
    from PIL import Image
    with Image.open(files[0]) as im:
        assert im.mode == "L"


def test_export_multipage_tiff(tmp_path):
    src = _make_pdf(tmp_path, 3)
    out = str(tmp_path / "out")
    files = render_pdf_to_images(src, out, fmt="tiff", dpi=72, multipage_tiff=True)
    assert len(files) == 1
    from PIL import Image
    with Image.open(files[0]) as im:
        assert getattr(im, "n_frames", 1) == 3


def test_dpi_clamped(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    # dpi quá lớn vẫn chạy (bị clamp), không crash
    files = render_pdf_to_images(src, out, fmt="png", dpi=99999)
    assert len(files) == 1


def test_invalid_format_raises(tmp_path):
    src = _make_pdf(tmp_path, 1)
    out = str(tmp_path / "out")
    with pytest.raises(ValueError):
        render_pdf_to_images(src, out, fmt="bmp")


def test_no_valid_pages_raises(tmp_path):
    src = _make_pdf(tmp_path, 2)
    out = str(tmp_path / "out")
    with pytest.raises(ValueError):
        render_pdf_to_images(src, out, fmt="png", pages=[99])
