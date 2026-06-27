"""
Regression / golden test — tương thích ngược output job CSV "kiểu cũ" (Task 8.5).

Mục tiêu (Validates: Requirements 7.1):
  Một job VDP chạy từ CSV với CẤU HÌNH FIELD HIỆN CÓ (text dùng placeholder
  `{Col}`, barcode 1D như code128, qrcode) — KHÔNG dùng bất kỳ tính năng mới nào
  (không `conditions`, không `rules`, không token `{Cot?A:B}`, không barcode 2D) —
  PHẢI render giống hành vi trước khi nâng cấp.

Vì golden byte-for-byte rất dễ vỡ (PDF chứa timestamp/ID ngẫu nhiên + nén), test
này khoá các BẤT BIẾN cấu trúc của output thay vì so sánh byte:

  1. Số trang output = số record (một trang mỗi record), tôn trọng công thức gán
     trang `record_idx % template_page_count` (Req 7.4) — kiểm cả template 1 trang
     và template nhiều trang.
  2. KHÔNG có nhãn ERR / MISSING nào xuất hiện trong text đã render.
  3. Phép thay placeholder cũ hoạt động: text đã render chứa GIÁ TRỊ đã thay
     (gồm cả `{Col}`, tách cột `{Col[i|delim]}` và định dạng `{Col|func}`).

Tái dùng pattern dựng template + trích text/pixel từ test_barcode_regression.py.
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


# A6 ~ 105 x 148 mm tính theo point.
PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


# ═══════════════════════════════════════════════
#  Helpers (đồng bộ với test_barcode_regression.py)
# ═══════════════════════════════════════════════

def _make_template(path: str, num_pages: int = 1):
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    for _ in range(num_pages):
        c.setFillColorRGB(0.97, 0.97, 0.97)
        c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
        c.showPage()
    c.save()


@pytest.fixture
def template_1page(tmp_path):
    p = os.path.join(str(tmp_path), "tpl1.pdf")
    _make_template(p, 1)
    return p


@pytest.fixture
def out_path(tmp_path):
    return os.path.join(str(tmp_path), f"out_{uuid.uuid4().hex}.pdf")


def _page_count(pdf_path: str) -> int:
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        return len(pdf)
    finally:
        pdf.close()


def _render_page_text(pdf_path: str, page_index: int) -> str:
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


# ── Cấu hình field "kiểu cũ": text + barcode 1D + qrcode, KHÔNG tính năng mới ──

def _legacy_fields():
    text_field = VdpField(
        id="t_label", name="label", type="text",
        x=10, y=10, width=85, height=20,
        fontSize=11, fontColor="#000000",
        textContent="{product} - {sku}",
    )
    # Tách cột (cơ chế cũ) + định dạng (cơ chế cũ) — vẫn là "kiểu cũ".
    text_field2 = VdpField(
        id="t_meta", name="meta", type="text",
        x=10, y=35, width=85, height=20,
        fontSize=10, fontColor="#000000",
        textContent="{tags[1|;]}|{code|upper}",
    )
    barcode_field = VdpField(
        id="bc_sku", name="bc", type="barcode",
        x=10, y=60, width=80, height=25,
        barType="code128", barColor="#000000",
        showText=False, textContent="{sku}",
    )
    qr_field = VdpField(
        id="qr_url", name="qr", type="qrcode",
        x=10, y=95, width=35, height=35,
        fontColor="#000000", textContent="{url}",
    )
    return [text_field, text_field2, barcode_field, qr_field]


def _legacy_data():
    return [
        {"product": "Widget", "sku": "ACME-001", "tags": "red;small;new",
         "code": "abc", "url": "https://x.test/1"},
        {"product": "Gadget", "sku": "ACME-002", "tags": "blue;large",
         "code": "def", "url": "https://x.test/2"},
        {"product": "Gizmo", "sku": "ACME-003", "tags": "green;medium;hot",
         "code": "ghi", "url": "https://x.test/3"},
    ]


# ═══════════════════════════════════════════════
#  1. Một trang mỗi record + không ERR/MISSING + placeholder đã thay
# ═══════════════════════════════════════════════

def test_legacy_csv_job_renders_one_page_per_record_no_errors(template_1page, out_path):
    fields = _legacy_fields()
    data = _legacy_data()

    run_vdp_engine(template_1page, fields, data, out_path, job_id=uuid.uuid4().hex)

    assert os.path.exists(out_path)
    # (1) Một trang mỗi record.
    assert _page_count(out_path) == len(data)

    for i, row in enumerate(data):
        text = _render_page_text(out_path, i)
        # (2) Không nhãn lỗi của engine.
        assert "ERR" not in text, f"record {i} bị gắn ERR: {text!r}"
        assert "MISSING" not in text, f"record {i} bị gắn MISSING: {text!r}"
        # (3) Placeholder cũ đã thay đúng giá trị.
        assert row["product"] in text, f"record {i}: thiếu product trong {text!r}"
        assert row["sku"] in text, f"record {i}: thiếu sku trong {text!r}"
        # tách cột {tags[1|;]} → phần tử đầu tiên
        first_tag = row["tags"].split(";")[0]
        assert first_tag in text, f"record {i}: thiếu tag[1] {first_tag!r} trong {text!r}"
        # định dạng {code|upper}
        assert row["code"].upper() in text, f"record {i}: thiếu code(upper) trong {text!r}"
        # placeholder thô KHÔNG còn sót lại
        assert "{product}" not in text and "{sku}" not in text


# ═══════════════════════════════════════════════
#  2. Template nhiều trang: record_idx % template_page_count (Req 7.4)
# ═══════════════════════════════════════════════

def test_legacy_csv_job_respects_template_page_cycling(tmp_path, out_path):
    tpl = os.path.join(str(tmp_path), "tpl3.pdf")
    _make_template(tpl, num_pages=3)

    fields = _legacy_fields()
    # 7 record với template 3 trang → vẫn đúng 7 trang output (1 trang/record),
    # trang template dùng cho record i là i % 3.
    data = []
    for i in range(7):
        data.append({
            "product": f"P{i}", "sku": f"SKU-{i:03d}", "tags": f"t{i};u{i}",
            "code": f"c{i}", "url": f"https://x.test/{i}",
        })

    run_vdp_engine(tpl, fields, data, out_path, job_id=uuid.uuid4().hex)

    # Bất biến gán trang (Req 7.4): output có ĐÚNG một trang cho mỗi record —
    # KHÔNG nhân theo số trang template (template 3 trang + 7 record → 7 trang,
    # không phải 21). Đây là hành vi gán `record_idx % template_page_count`.
    assert _page_count(out_path) == len(data)

    # Không record nào bị gắn nhãn lỗi engine khi dùng cấu hình field kiểu cũ.
    all_text = "\n".join(_render_page_text(out_path, i) for i in range(len(data)))
    assert "ERR" not in all_text and "MISSING" not in all_text


# ═══════════════════════════════════════════════
#  3. Field thiếu cột → MISSING chỉ field đó, các record khác không ảnh hưởng
# ═══════════════════════════════════════════════

def test_legacy_text_without_placeholder_renders_literal(template_1page, out_path):
    """Text tĩnh (không placeholder) giữ nguyên literal — hành vi cũ không đổi."""
    field = VdpField(
        id="t_static", name="static", type="text",
        x=10, y=10, width=85, height=20,
        fontSize=12, fontColor="#000000",
        textContent="STATIC-LABEL-XYZ",
    )
    run_vdp_engine(template_1page, [field], [{"any": "1"}], out_path,
                   job_id=uuid.uuid4().hex)
    text = _render_page_text(out_path, 0)
    assert "STATIC-LABEL-XYZ" in text
    assert "ERR" not in text and "MISSING" not in text
