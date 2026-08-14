"""Hồi quy tương thích Adobe khi nhúng ảnh JPEG-CMYK đảo kênh."""

from __future__ import annotations

import io

import numpy as np
import pikepdf
from PIL import Image

from app.workers.pdf_ops import show_pdf_page
from app.workers.pdf_types import Rect


REVERSED_CMYK_DECODE = [1, 0, 1, 0, 1, 0, 1, 0]


def _make_cmyk_jpeg_pdf(path):
    image = Image.new("CMYK", (12, 8), (0, 0, 220, 0))
    for x in range(6, 12):
        for y in range(8):
            image.putpixel((x, y), (220, 40, 0, 0))
    payload = io.BytesIO()
    image.save(payload, format="JPEG", quality=100, subsampling=0)

    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(120, 80))
    image_xobject = pikepdf.Stream(
        pdf,
        payload.getvalue(),
        Filter=pikepdf.Name("/DCTDecode"),
    )
    image_xobject["/Type"] = pikepdf.Name("/XObject")
    image_xobject["/Subtype"] = pikepdf.Name("/Image")
    image_xobject["/Width"] = image.width
    image_xobject["/Height"] = image.height
    image_xobject["/BitsPerComponent"] = 8
    image_xobject["/ColorSpace"] = pikepdf.Name("/DeviceCMYK")
    image_xobject["/Decode"] = pikepdf.Array(REVERSED_CMYK_DECODE)
    page.obj["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=image_xobject),
    )
    page.obj["/Contents"] = pikepdf.Stream(
        pdf,
        b"q 120 0 0 80 0 0 cm /Im0 Do Q\n",
    )
    pdf.save(path)
    pdf.close()


def _first_image_xobject(pdf):
    seen = set()
    stack = [pdf.pages[0].obj]
    while stack:
        node = stack.pop()
        resources = node.get("/Resources") or {}
        for _name, xobject in (resources.get("/XObject") or {}).items():
            key = tuple(xobject.objgen)
            if key in seen:
                continue
            seen.add(key)
            subtype = str(xobject.get("/Subtype", ""))
            if subtype == "/Image":
                return xobject
            if subtype == "/Form":
                stack.append(xobject)
    raise AssertionError("Không tìm thấy image XObject trong PDF")


def _render_rgb(path):
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    try:
        bitmap = document[0].render(scale=2)
        return np.asarray(bitmap.to_pil().convert("RGB"))
    finally:
        document.close()


def test_show_pdf_page_normalizes_reversed_cmyk_jpeg_for_adobe_embed(tmp_path):
    """Output không giữ cặp DCT+Decode đảo kênh khiến Adobe Embed thành ảnh đen."""
    source_path = tmp_path / "reversed-cmyk-source.pdf"
    output_path = tmp_path / "reversed-cmyk-output.pdf"
    _make_cmyk_jpeg_pdf(source_path)

    source = pikepdf.Pdf.open(source_path)
    output = pikepdf.Pdf.new()
    output_page = output.add_blank_page(page_size=(120, 80))
    show_pdf_page(
        output,
        output_page,
        Rect(0, 0, 120, 80),
        source,
        0,
    )
    output.save(output_path)
    output.close()
    source.close()

    with pikepdf.Pdf.open(output_path) as normalized:
        image_xobject = _first_image_xobject(normalized)
        assert str(image_xobject.get("/Filter")) == "/FlateDecode"
        assert image_xobject.get("/Decode") is None
        assert str(image_xobject.get("/ColorSpace")) == "/DeviceCMYK"

    # Chuẩn hóa cấu trúc nhưng không được đổi bất kỳ pixel hiển thị nào.
    assert np.array_equal(_render_rgb(source_path), _render_rgb(output_path))


def test_show_pdf_page_keeps_regular_rgb_jpeg_compressed(tmp_path):
    """Ảnh JPEG-RGB bình thường không bị giải nén làm tăng dung lượng vô ích."""
    source_path = tmp_path / "rgb-source.pdf"
    output_path = tmp_path / "rgb-output.pdf"

    image = Image.new("RGB", (8, 8), (240, 80, 20))
    payload = io.BytesIO()
    image.save(payload, format="JPEG", quality=95)
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(80, 80))
    image_xobject = pikepdf.Stream(
        pdf,
        payload.getvalue(),
        Filter=pikepdf.Name("/DCTDecode"),
    )
    image_xobject["/Type"] = pikepdf.Name("/XObject")
    image_xobject["/Subtype"] = pikepdf.Name("/Image")
    image_xobject["/Width"] = 8
    image_xobject["/Height"] = 8
    image_xobject["/BitsPerComponent"] = 8
    image_xobject["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
    page.obj["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=image_xobject),
    )
    page.obj["/Contents"] = pikepdf.Stream(
        pdf,
        b"q 80 0 0 80 0 0 cm /Im0 Do Q\n",
    )
    pdf.save(source_path)
    pdf.close()

    source = pikepdf.Pdf.open(source_path)
    output = pikepdf.Pdf.new()
    output_page = output.add_blank_page(page_size=(80, 80))
    show_pdf_page(output, output_page, Rect(0, 0, 80, 80), source, 0)
    output.save(output_path)
    output.close()
    source.close()

    with pikepdf.Pdf.open(output_path) as result:
        copied = _first_image_xobject(result)
        assert str(copied.get("/Filter")) == "/DCTDecode"
