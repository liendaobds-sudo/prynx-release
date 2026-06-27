"""Regression: cô lập overlay khi template NHIỀU TRANG (VDP_Engine).

Bug gốc: ``pdf_ops.show_pdf_page`` cache XObject "embed-once" trên PDF đích, khóa
bằng ``(id(src_pdf), page_idx)``. Trong ``process_chunk`` mỗi record tạo MỘT
``overlay_pdf`` mới rồi đặt đúng một lần. Khi overlay của record trước bị GC,
Python tái dùng địa chỉ → ``id()`` trùng → cache trả XObject của record CŨ, khiến
một số record về sau hiển thị nội dung của record khác (thường là record sớm hơn).

Test dựng template nhiều trang + N record (đủ lớn để chắc chắn kích hoạt tái dùng
id nếu chưa sửa), mỗi record có MỘT marker DUY NHẤT, không-phải-chuỗi-con
``[[R0007]]`` (zero-pad + bao ngoặc nên ``[[R0001]]`` KHÔNG là chuỗi con của
``[[R0011]]``). Sau đó trích text từng trang output và khẳng định trang i chỉ
chứa marker của chính nó, không lẫn marker record khác.
"""
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from app.workers.vdp_engine import run_vdp_engine
from app.schemas.vdp import VdpField

import pypdfium2 as pdfium
from reportlab.pdfgen import canvas as rl_canvas


PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


def _marker(i: int) -> str:
    # Bao ngoặc + zero-pad ⇒ không marker nào là chuỗi con của marker khác.
    return f"[[R{i:04d}]]"


def _make_template(path: str, num_pages: int):
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    for _ in range(num_pages):
        c.setFillColorRGB(0.97, 0.97, 0.97)
        c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
        c.showPage()
    c.save()


def _page_text(pdf_path: str, page_index: int) -> str:
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        tp = page.get_textpage()
        try:
            return tp.get_text_bounded()
        finally:
            tp.close()
    finally:
        pdf.close()


@pytest.mark.parametrize("num_pages", [1, 3])
def test_each_record_overlay_is_isolated(tmp_path, num_pages):
    """Mỗi record hiển thị ĐÚNG overlay của chính nó (không lẫn record khác)."""
    tpl = os.path.join(str(tmp_path), f"tpl_{num_pages}.pdf")
    _make_template(tpl, num_pages)

    field = VdpField(
        id="t_rec", name="rec", type="text",
        x=10, y=10, width=80, height=20,
        fontSize=12, fontColor="#000000", textContent="{rec}",
    )
    # N đủ lớn để va chạm id() xảy ra nếu cache chưa được sửa.
    n_records = 40
    data = [{"rec": _marker(i)} for i in range(n_records)]
    out_path = os.path.join(str(tmp_path), f"out_{uuid.uuid4().hex}.pdf")

    run_vdp_engine(tpl, [field], data, out_path, job_id=uuid.uuid4().hex)

    pdf = pdfium.PdfDocument(out_path)
    try:
        assert len(pdf) == n_records, "phải có đúng một trang cho mỗi record"
    finally:
        pdf.close()

    wrong = []
    for i in range(n_records):
        text = _page_text(out_path, i)
        if _marker(i) not in text:
            wrong.append((i, text))
            continue
        for j in range(n_records):
            if j != i and _marker(j) in text:
                wrong.append((i, text))
                break

    assert not wrong, f"overlay bị lẫn giữa các record (bug cô lập): {wrong[:5]}"
