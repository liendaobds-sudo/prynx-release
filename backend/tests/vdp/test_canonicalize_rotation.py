"""Regression cho lệch vị trí VDP khi trang có /Rotate hoặc CropBox lệch MediaBox.

Bug (audit 2026-07-04): editor (pdfium) tôn trọng /Rotate + CropBox và báo khổ đã
hoán w/h; còn backend render_one_record dùng MediaBox THÔ và _canonicalize CỐ TÌNH
bỏ qua trang /Rotate≠0 → field đặt đúng ở view chính nhưng lệch ở preview + output.

Fix: _canonicalize_template_to_cropbox bake CẢ /Rotate lẫn crop lệch vào content
stream, đặt MediaBox = khổ hiển thị (hoán w/h khi 90/270) và /Rotate = 0. Sau đó
cả preview lẫn output khớp view chính.

Cách kiểm: dựng template có /Rotate (hoặc CropBox lệch), đặt một field text ở góc
đã biết, chạy engine, rasterize output và xác nhận chữ nằm ĐÚNG góc mong đợi sau
khi xoay (bbox pixel tối lệch về đúng phần tư của trang).
"""
import os
import uuid

import pytest
import pikepdf
import pypdfium2 as pdfium
from reportlab.pdfgen import canvas as rl_canvas

from app.workers.vdp_engine import (
    _canonicalize_template_to_cropbox,
    run_vdp_engine,
)
from app.schemas.vdp import VdpField


# Trang gốc dọc (portrait) để khi xoay 90/270 thành ngang, dễ phân biệt hoán w/h.
PAGE_W_PT = 300.0
PAGE_H_PT = 500.0


def _make_plain_page(path: str):
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.setFillColorRGB(0.97, 0.97, 0.97)
    c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
    c.showPage()
    c.save()


def _set_rotate(src: str, dst: str, rotate: int):
    pdf = pikepdf.Pdf.open(src)
    pdf.pages[0].Rotate = rotate
    pdf.save(dst)
    pdf.close()


def _set_cropbox(src: str, dst: str, box):
    pdf = pikepdf.Pdf.open(src)
    pdf.pages[0].CropBox = pikepdf.Array([float(v) for v in box])
    pdf.save(dst)
    pdf.close()


def _set_mediabox(src: str, dst: str, box):
    pdf = pikepdf.Pdf.open(src)
    pdf.pages[0].MediaBox = pikepdf.Array([float(v) for v in box])
    if "/CropBox" in pdf.pages[0]:
        del pdf.pages[0].CropBox
    pdf.save(dst)
    pdf.close()


def _mediabox(path: str):
    pdf = pikepdf.Pdf.open(path)
    try:
        mb = [float(v) for v in pdf.pages[0].MediaBox]
        rot = int(pdf.pages[0].get("/Rotate", 0) or 0)
        return mb, rot
    finally:
        pdf.close()


def _page_pixels(pdf_path: str, page_index: int = 0, scale: float = 2.0):
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        return page.render(scale=scale).to_pil().convert("RGB")
    finally:
        pdf.close()


def _dark_centroid(pil, thresh=110):
    """Trọng tâm (cx, cy) của các pixel tối, chuẩn hoá về [0,1] theo (rộng, cao).

    Trả None nếu không có pixel tối. Dùng để xác định chữ rơi vào phần tư nào.
    """
    w, h = pil.size
    sx = sy = 0
    n = 0
    step = max(1, min(w, h) // 300)
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            r, g, b = pil.getpixel((xx, yy))
            if r < thresh and g < thresh and b < thresh:
                sx += xx
                sy += yy
                n += 1
    if n == 0:
        return None
    return (sx / n / w, sy / n / h)


@pytest.fixture
def out_path(tmp_path):
    return os.path.join(str(tmp_path), f"out_{uuid.uuid4().hex}.pdf")


# ─── Canonicalize: bake /Rotate → MediaBox hoán w/h, /Rotate = 0 ─────────────


@pytest.mark.parametrize("rotate,expect_swapped", [
    (0, False), (90, True), (180, False), (270, True),
])
def test_canonicalize_bakes_rotate_into_mediabox(tmp_path, rotate, expect_swapped):
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    rotated = os.path.join(str(tmp_path), f"rot{rotate}.pdf")
    _set_rotate(plain, rotated, rotate)

    canon_path, is_temp = _canonicalize_template_to_cropbox(rotated)

    if rotate == 0:
        # Không xoay, không crop lệch → không cần rewrite.
        assert is_temp is False
        return

    assert is_temp is True
    mb, rot = _mediabox(canon_path)
    assert rot == 0, "phải bake /Rotate về 0"
    w = mb[2] - mb[0]
    h = mb[3] - mb[1]
    if expect_swapped:  # 90/270: khổ hiển thị hoán w/h
        assert abs(w - PAGE_H_PT) < 0.5 and abs(h - PAGE_W_PT) < 0.5
    else:  # 180: giữ khổ
        assert abs(w - PAGE_W_PT) < 0.5 and abs(h - PAGE_H_PT) < 0.5

    if is_temp and os.path.exists(canon_path):
        os.remove(canon_path)


def test_canonicalize_noop_when_plain(tmp_path):
    """Trang không xoay + CropBox trùng MediaBox → giữ nguyên, không tạo temp."""
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    canon_path, is_temp = _canonicalize_template_to_cropbox(plain)
    assert is_temp is False
    assert canon_path == plain


# ─── End-to-end: field đặt trên trang /Rotate xuất ra đúng góc đã xoay ───────


def _text_field_top_left():
    """Field text đặt sát góc TRÊN-TRÁI của KHỔ HIỂN THỊ (đơn vị mm frontend).

    Khổ hiển thị của trang xoay 90/270 là ngang: rộng = PAGE_H_PT, cao = PAGE_W_PT.
    Toạ độ frontend là 'CSS-mm' = point / CSS_TO_PT_FACTOR / MM_TO_PTS. Để đơn giản
    ta đặt field ở ~10% từ trái và từ trên, đủ nhỏ để nằm gọn trong phần tư trên-trái.
    """
    return VdpField(
        id="f1", name="tag", type="text",
        x=6.0, y=6.0, width=28.0, height=10.0,
        fontColor="#000000", fontSize=14, alignment="left",
        textContent="{tag}",
    )


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_rotated_page_field_lands_top_left(tmp_path, out_path, rotate):
    """Field đặt góc trên-trái của khổ hiển thị phải rơi vào phần tư trên-trái của
    trang output, BẤT KỂ /Rotate của template. Trước fix, trang 90/270 lệch vì
    engine dùng MediaBox chưa xoay."""
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    template = os.path.join(str(tmp_path), f"tpl_rot{rotate}.pdf")
    _set_rotate(plain, template, rotate)

    run_vdp_engine(template, [_text_field_top_left()], [{"tag": "ABCDEF"}], out_path,
                   job_id=uuid.uuid4().hex)

    pil = _page_pixels(out_path)
    centroid = _dark_centroid(pil)
    assert centroid is not None, "không thấy chữ trong output"
    cx, cy = centroid
    # Góc trên-trái: cx < 0.5 và cy < 0.5 (gốc ảnh trên-trái).
    assert cx < 0.5, f"rotate={rotate}: chữ lệch phải (cx={cx:.2f})"
    assert cy < 0.5, f"rotate={rotate}: chữ lệch xuống (cy={cy:.2f})"


def test_rotated_output_page_size_matches_display(tmp_path, out_path):
    """Trang output của template xoay 90 phải có khổ HIỂN THỊ (ngang), không phải
    khổ MediaBox gốc (dọc)."""
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    template = os.path.join(str(tmp_path), "tpl_rot90.pdf")
    _set_rotate(plain, template, 90)

    run_vdp_engine(template, [_text_field_top_left()], [{"tag": "X"}], out_path,
                   job_id=uuid.uuid4().hex)

    pdf = pdfium.PdfDocument(out_path)
    try:
        w, h = pdf[0].get_size()
    finally:
        pdf.close()
    # Khổ hiển thị ngang: rộng ≈ PAGE_H_PT, cao ≈ PAGE_W_PT.
    assert abs(w - PAGE_H_PT) < 1.0 and abs(h - PAGE_W_PT) < 1.0


# ─── MediaBox gốc ≠ (0,0): pdfium chuẩn hoá về (0,0), backend phải canonical ──


def test_canonicalize_offset_mediabox_moves_origin_to_zero(tmp_path):
    """MediaBox có gốc lệch (vd [10,20,310,520]) mà KHÔNG có CropBox riêng → phải
    canonical hoá về gốc (0,0), giữ khổ. Trước fix: crop_matches_media=True nên bỏ
    qua → overlay lệch đúng offset (10,20)."""
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    offset = os.path.join(str(tmp_path), "offset.pdf")
    _set_mediabox(plain, offset, [10, 20, 10 + PAGE_W_PT, 20 + PAGE_H_PT])

    canon_path, is_temp = _canonicalize_template_to_cropbox(offset)
    assert is_temp is True, "MediaBox gốc lệch phải được canonical hoá"
    mb, rot = _mediabox(canon_path)
    assert abs(mb[0]) < 0.5 and abs(mb[1]) < 0.5, "gốc phải về (0,0)"
    assert abs((mb[2] - mb[0]) - PAGE_W_PT) < 0.5
    assert abs((mb[3] - mb[1]) - PAGE_H_PT) < 0.5

    if is_temp and os.path.exists(canon_path):
        os.remove(canon_path)


def test_offset_mediabox_field_lands_top_left(tmp_path, out_path):
    """Field góc trên-trái trên template có MediaBox gốc lệch phải rơi vào phần tư
    trên-trái của output (khớp view chính do pdfium chuẩn hoá gốc về 0,0)."""
    plain = os.path.join(str(tmp_path), "plain.pdf")
    _make_plain_page(plain)
    offset = os.path.join(str(tmp_path), "offset.pdf")
    _set_mediabox(plain, offset, [10, 20, 10 + PAGE_W_PT, 20 + PAGE_H_PT])

    run_vdp_engine(offset, [_text_field_top_left()], [{"tag": "ABCDEF"}], out_path,
                   job_id=uuid.uuid4().hex)

    pil = _page_pixels(out_path)
    centroid = _dark_centroid(pil)
    assert centroid is not None, "không thấy chữ trong output"
    cx, cy = centroid
    assert cx < 0.5, f"chữ lệch phải (cx={cx:.2f})"
    assert cy < 0.5, f"chữ lệch xuống (cy={cy:.2f})"
