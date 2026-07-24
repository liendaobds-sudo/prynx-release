"""
Regression: di chuyển text KHÔNG được làm chữ biến mất khi text nằm trong clip.

Root cause: nhiều PDF bọc text `q / re / W n / BT…ET / Q`. move_objects ghim Tm
tuyệt đối → glyph ra ngoài clip rectangle → bị cắt hết (nhìn như "mất chữ").
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
from app.core.stream_editor import move_objects


def _dark_pixels(path: str, scale: float = 2.0) -> int:
    doc = pdfium.PdfDocument(path)
    try:
        img = np.array(doc[0].render(scale=scale).to_pil().convert("L"))
    finally:
        doc.close()
    return int((img < 180).sum())


def _make_clipped_text_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    # Clip chặt quanh chữ; dx=+80 sẽ đưa text ra ngoài clip cũ nếu không mở rộng.
    page.Contents = pdf.make_stream(
        b"""
q
50 190 100 40 re
W n
BT
/F1 20 Tf
55 200 Td
(CLIPPED) Tj
ET
Q
"""
    )
    pdf.save(path)
    pdf.close()


def test_move_text_inside_clip_stays_visible():
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "clip.pdf")
        out = os.path.join(td, "out.pdf")
        _make_clipped_text_pdf(src)

        before = _dark_pixels(src)
        assert before > 500, "fixture phải vẽ được text trước move"

        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) == 1

        with pikepdf.open(src) as pdf:
            res = move_objects(pdf.pages[0], metas, 80.0, 0.0, pdf)
            assert res.changed is True
            raw = bytes(pdf.pages[0].Contents.read_bytes())
            shown_text = [
                bytes(args[0]) for args, op in pikepdf.parse_content_stream(pdf.pages[0])
                if str(op) == "Tj" and args
            ]
            assert b"CLIPPED" in shown_text
            # Clip group + text phải được bọc cm (page-space), không chỉ ghim Tm.
            assert b"1 0 0 1 80" in raw or b"1 0 0 1 80.0" in raw
            pdf.save(out)

        after = _dark_pixels(out)
        # Cho phép hao nhẹ anti-alias; KHÔNG được gần như mất hết.
        assert after >= before * 0.7, (
            f"Text bị mất sau move trong clip: before={before} after={after}"
        )

        moved = [m for m in list_objects(out, 0) if m.type == "text"]
        assert len(moved) == 1
        # Bbox đã dịch +80 theo x.
        assert moved[0].bbox[0] == pytest.approx(metas[0].bbox[0] + 80.0, abs=1.5)


def test_move_text_quote_operator_stays_visible():
    """Show-op `'` trong BT…ET nhiều run: ghim Tm granular, chữ vẫn hiện đủ."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "quote.pdf")
        out = os.path.join(td, "out.pdf")
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(400, 300))
        font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            b"""
BT
/F1 18 Tf
18 TL
50 250 Td
(First) Tj
(Second) '
ET
"""
        )
        pdf.save(src)
        pdf.close()

        before = _dark_pixels(src)
        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) >= 2
        target = metas[1]
        with pikepdf.open(src) as pdf:
            move_objects(pdf.pages[0], [target], 20.0, -30.0, pdf)
            raw = bytes(pdf.pages[0].Contents.read_bytes())
            # `'` multi-run → fallback bọc cm cả cụm (tránh double leading).
            assert b" cm" in raw or b"cm\n" in raw
            pdf.save(out)

        after = _dark_pixels(out)
        assert after >= before * 0.85


def test_move_text_clip_group_wrapped_with_cm():
    """Clip + text cô lập phải được bọc cm NGOÀI cả khối (stream có q/cm trước re)."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "clip.pdf")
        out = os.path.join(td, "out.pdf")
        _make_clipped_text_pdf(src)
        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        with pikepdf.open(src) as pdf:
            move_objects(pdf.pages[0], metas, 80.0, 0.0, pdf)
            ops = [str(op) for _a, op in pikepdf.parse_content_stream(pdf.pages[0])]
            # Kỳ vọng: q, cm, q, re, W, n, BT, ...
            assert ops[0] == "q"
            assert ops[1] == "cm"
            pdf.save(out)
        assert _dark_pixels(out) > 500


def _make_nested_clip_text_pdf(path: str) -> None:
    """Clip LỒNG NHAU kiểu InDesign: clip NGOÀI bao 2 run text, clip TRONG riêng
    từng run. move_objects chỉ bọc cm quanh khối TRONG → clip NGOÀI (trước cm) cắt
    mất glyph đã dịch nếu không mở rộng. Đây là cấu trúc thật gây "mất chữ"."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    # Clip NGOÀI: x=50..145 (bao cả 2 run). Clip TRONG: chặt quanh từng run.
    # dx=+100 đưa run "AB" tới ~155..185 → VƯỢT HẲN mép phải clip ngoài (145) →
    # nếu clip ngoài không nới, glyph bị cắt SẠCH (0 px) ở vị trí mới.
    page.Contents = pdf.make_stream(
        b"""
q
50 190 95 40 re
W n
q
52 195 38 30 re
W n
BT
/F1 20 Tf
55 200 Td
(AB) Tj
ET
Q
q
98 195 40 30 re
W n
BT
/F1 20 Tf
100 200 Td
(CD) Tj
ET
Q
Q
"""
    )
    pdf.save(path)
    pdf.close()


def test_move_text_nested_clip_stays_visible():
    """Regression bug thật: clip lồng nhau (InDesign) — clip NGOÀI phải được nới
    theo delta, nếu không glyph đã dịch bị cắt sạch → "mất chữ"."""
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "nested.pdf")
        out = os.path.join(td, "out.pdf")
        _make_nested_clip_text_pdf(src)

        metas = [m for m in list_objects(src, 0) if m.type == "text"]
        assert len(metas) >= 2
        # Chọn run trái ("AB") — dịch phải +100 vượt HẲN mép phải clip NGOÀI.
        target = min(metas, key=lambda m: m.bbox[0])
        before_target = _dark_pixels_in_region(src, target.bbox, 0.0)

        with pikepdf.open(src) as pdf:
            move_objects(pdf.pages[0], [target], 100.0, 0.0, pdf)
            pdf.save(out)

        # Glyph đã dịch phải HIỆN ở vị trí mới (không bị clip ngoài cắt).
        after_target = _dark_pixels_in_region(out, target.bbox, 100.0)
        assert after_target >= before_target * 0.7, (
            f"Glyph bị clip ngoài cắt sau move: before={before_target} "
            f"after_at_new_pos={after_target}"
        )


def _dark_pixels_in_region(path: str, bbox, dx: float, scale: float = 3.0) -> int:
    """Đếm pixel tối trong vùng bbox (đã cộng dx theo x), hệ PDF bottom-left."""
    doc = pdfium.PdfDocument(path)
    try:
        page = doc[0]
        ph = page.get_size()[1]
        img = np.array(page.render(scale=scale).to_pil().convert("L"))
        x0 = int((bbox[0] + dx - 3) * scale)
        x1 = int((bbox[2] + dx + 3) * scale)
        # y PDF (bottom-left) → y ảnh (top-left).
        yt = int((ph - bbox[3] - 3) * scale)
        yb = int((ph - bbox[1] + 3) * scale)
        x0 = max(0, x0); yt = max(0, yt)
        crop = img[yt:yb, x0:x1]
        return int((crop < 180).sum())
    finally:
        doc.close()
