"""
Copy/Paste (paste_objects) — nhân bản object, lệch offset, an-toàn-màu.

Trọng tâm:
- Cùng trang: vector/image/text nhân đôi, GIỮ màu (màu set NGOÀI span vẫn phải
  đi theo bản dán nhờ _capture_graphics_state).
- Cross-page: resource (XObject) được copy sang /Resources trang đích + tên
  trong slice được viết lại → render đúng, không mất object.
- An toàn màu: object không map được duy nhất → ObjectMapError, KHÔNG ghi.
"""
from __future__ import annotations

import os
import tempfile

import numpy as np
import pikepdf
import pypdfium2 as pdfium
import pytest
from pikepdf import Dictionary, Name

from app.core.geometry_reader import list_objects
from app.core.stream_editor import ObjectMapError, paste_objects


def _dark_pixels(path: str, page: int = 0, scale: float = 2.0) -> int:
    doc = pdfium.PdfDocument(path)
    try:
        img = np.array(doc[page].render(scale=scale).to_pil().convert("L"))
    finally:
        doc.close()
    return int((img < 180).sum())


def _ops(page) -> list:
    return list(pikepdf.parse_content_stream(page))


# ── Fixtures ────────────────────────────────────────────────────────────────
def _make_red_vector_pdf(path: str) -> None:
    """Một hình chữ nhật ĐỎ tô đặc. Màu (rg) set TRƯỚC path — nằm NGOÀI OpSpan."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))
    page.Contents = pdf.make_stream(
        b"1 0 0 rg\n50 50 80 80 re\nf\n"
    )
    pdf.save(path)
    pdf.close()


def _make_image_pdf(path: str) -> None:
    """Một Image XObject nhỏ đặt bằng `w 0 0 h x y cm /Im0 Do`."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))
    # Ảnh RGB 2x2 raw.
    raw = bytes([255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 0])
    img = pikepdf.Stream(pdf, raw)
    img[Name.Type] = Name.XObject
    img[Name.Subtype] = Name.Image
    img[Name.Width] = 2
    img[Name.Height] = 2
    img[Name.ColorSpace] = Name.DeviceRGB
    img[Name.BitsPerComponent] = 8
    page.Resources = Dictionary(XObject=Dictionary(Im0=img))
    page.Contents = pdf.make_stream(b"q\n60 0 0 60 40 40 cm\n/Im0 Do\nQ\n")
    pdf.save(path)
    pdf.close()


def _make_two_page_image_pdf(path: str) -> None:
    """Trang 0 có ảnh, trang 1 TRỐNG — để test paste cross-page copy resource."""
    pdf = pikepdf.Pdf.new()
    raw = bytes([255, 0, 0,  0, 255, 0,  0, 0, 255,  255, 255, 0])
    img = pikepdf.Stream(pdf, raw)
    img[Name.Type] = Name.XObject
    img[Name.Subtype] = Name.Image
    img[Name.Width] = 2
    img[Name.Height] = 2
    img[Name.ColorSpace] = Name.DeviceRGB
    img[Name.BitsPerComponent] = 8
    p0 = pdf.add_blank_page(page_size=(300, 300))
    p0.Resources = Dictionary(XObject=Dictionary(Im0=img))
    p0.Contents = pdf.make_stream(b"q\n60 0 0 60 40 40 cm\n/Im0 Do\nQ\n")
    pdf.add_blank_page(page_size=(300, 300))  # trang 1 trống
    pdf.save(path)
    pdf.close()


# ── Cùng trang ────────────────────────────────────────────────────────────────
def test_paste_vector_same_page_preserves_color():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "v.pdf")
        out = os.path.join(td, "out.pdf")
        _make_red_vector_pdf(src)

        metas = [m for m in list_objects(src, 0) if m.type == "vector"]
        assert len(metas) == 1

        with pikepdf.open(src) as pdf:
            res = paste_objects(pdf.pages[0], pdf.pages[0], metas, 40.0, 40.0, pdf)
            assert res.changed is True
            assert res.count == 1
            assert res.cross_page is False

            ops = _ops(pdf.pages[0])
            # Phải có HAI lần tô fill (bản gốc + bản dán).
            fills = [o for o in ops if str(o.operator) == "f"]
            assert len(fills) >= 2
            # Bản dán phải mang lại lệnh set màu đỏ (rg) — nếu không, mất màu.
            rg = [o for o in ops if str(o.operator) == "rg"]
            assert len(rg) >= 2, "bản dán phải tái tạo màu 'rg', không được mất màu"
            pdf.save(out)

        # Vùng tối (đỏ→L thấp) TĂNG vì có 2 hình.
        assert _dark_pixels(out) > _dark_pixels(src)


def test_paste_image_same_page_duplicates():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "i.pdf")
        _make_image_pdf(src)

        metas = [m for m in list_objects(src, 0) if m.type == "image"]
        assert len(metas) == 1

        with pikepdf.open(src) as pdf:
            res = paste_objects(pdf.pages[0], pdf.pages[0], metas, 30.0, 30.0, pdf)
            assert res.changed is True and res.count == 1
            do = [o for o in _ops(pdf.pages[0]) if str(o.operator) == "Do"]
            assert len(do) == 2, "phải có 2 lần Do (gốc + bản dán)"


# ── Cross-page ────────────────────────────────────────────────────────────────
def test_paste_image_cross_page_copies_resource():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "2p.pdf")
        out = os.path.join(td, "out.pdf")
        _make_two_page_image_pdf(src)

        metas = [m for m in list_objects(src, 0) if m.type == "image"]
        assert len(metas) == 1

        with pikepdf.open(src) as pdf:
            res = paste_objects(pdf.pages[0], pdf.pages[1], metas, 20.0, 20.0, pdf)
            assert res.changed is True and res.cross_page is True

            # Trang đích PHẢI có resource XObject sau paste (trước đó trống).
            dest_xobj = pdf.pages[1].Resources.get("/XObject")
            assert dest_xobj is not None and len(list(dest_xobj.keys())) >= 1

            # Tên trong slice trang đích phải trỏ một XObject CÓ THẬT trên trang đó.
            do_names = [
                str(o.operands[0]) for o in _ops(pdf.pages[1])
                if str(o.operator) == "Do" and o.operands
            ]
            assert do_names, "trang đích phải có lệnh Do sau paste"
            for nm in do_names:
                assert Name(nm) in dest_xobj, f"tên {nm} phải tồn tại trong /Resources đích"
            pdf.save(out)

        # Trang 1 trước trống (≈0 pixel tối), sau paste phải có nội dung.
        assert _dark_pixels(out, page=1) > 50


# ── An toàn màu ───────────────────────────────────────────────────────────────
def test_paste_empty_targets_is_noop():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "v.pdf")
        _make_red_vector_pdf(src)
        with pikepdf.open(src) as pdf:
            res = paste_objects(pdf.pages[0], pdf.pages[0], [], 10.0, 10.0, pdf)
            assert res.changed is False


def test_paste_unmappable_object_raises():
    """Object không map được duy nhất → ObjectMapError, KHÔNG ghi."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "v.pdf")
        _make_red_vector_pdf(src)
        with pikepdf.open(src) as pdf:
            # meta bịa bbox không khớp span nào → map_object_spans trả []
            fake = {"id": "vector-999", "type": "vector",
                    "bbox": [9999.0, 9999.0, 10000.0, 10000.0], "drawIndex": 999}
            with pytest.raises(ObjectMapError):
                paste_objects(pdf.pages[0], pdf.pages[0], [fake], 10.0, 10.0, pdf)
