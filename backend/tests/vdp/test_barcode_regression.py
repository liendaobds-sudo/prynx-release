"""
Regression / golden test — 7 loại barcode 1D + QR KHÔNG đổi sau khi thêm nhánh 2D.

Mục tiêu (Task 6.9 — Validates: Requirements 3.8, 7.2):
  Sau khi bổ sung nhánh barcode 2D (DataMatrix / GS1-128 / GS1-DataMatrix) vào
  `render_one_record`, đường render 1D + QR hiện hữu PHẢI giữ NGUYÊN hành vi:

    1. Mỗi loại 1D ánh xạ đúng symbology ReportLab và tạo được drawing có bounds > 0.
    2. QR sinh ma trận hợp lệ và render ra pixel đậm.
    3. Cả 7 loại 1D + QR render ra PDF thành công, không gắn nhãn ERR.
    4. Nhánh 2D MỚI không can thiệp code path 1D/QR: field 'code128' vẫn đi qua
       `createBarcodeDrawing('Code128', ...)`, còn 'datamatrix' đi qua `render_2d`
       (KHÔNG gọi createBarcodeDrawing) — hai nhánh tách bạch hoàn toàn.

Vì golden byte-for-byte rất dễ vỡ (PDF chứa timestamp/ID ngẫu nhiên), test này
khoá các BẤT BIẾN cấu trúc thay vì so sánh byte.
"""
import os
import sys
import io
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from app.workers import vdp_engine
from app.workers.vdp_engine import (
    run_vdp_engine, render_one_record, MM_TO_PTS, CSS_TO_PT_FACTOR,
)
from app.schemas.vdp import VdpField

import pypdfium2 as pdfium
from reportlab.pdfgen import canvas as rl_canvas


# A6 ~ 105 x 148 mm tính theo point.
PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


# ── 7 loại 1D UI cung cấp → symbology ReportLab kỳ vọng (khớp bt_map trong engine) ──
# Mỗi loại kèm một GIÁ TRỊ HỢP LỆ theo symbology của nó.
ONE_D_TYPES = {
    'code128': ('Code128',    'ABC-12345'),
    'ean13':   ('EAN13',      '5901234123457'),   # 13 chữ số
    'ean8':    ('EAN8',       '96385074'),         # 8 chữ số
    'upca':    ('UPCA',       '03600029145'),       # 11–12 chữ số
    'code39':  ('Standard39', 'CODE39'),
    'itf14':   ('I2of5',      '12345678901234'),   # ITF = Interleaved 2of5, số chữ số chẵn
    'codabar': ('Codabar',    'A12345B'),
}


# ═══════════════════════════════════════════════
#  Helpers
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


def _render_page_pixels(pdf_path: str, page_index: int, scale: float = 2.0):
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        bitmap = page.render(scale=scale)
        return bitmap.to_pil().convert("RGB")
    finally:
        pdf.close()


def _dark_pixel_count(pil, thresh=100):
    """Đếm pixel đậm (vạch barcode / chấm QR / chữ)."""
    w, h = pil.size
    count = 0
    step = max(1, min(w, h) // 300)
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            r, g, b = pil.getpixel((xx, yy))
            if r < thresh and g < thresh and b < thresh:
                count += 1
    return count


def _barcode_field(btype: str, value: str):
    return VdpField(
        id=f"bc_{btype}", name="code", type="barcode",
        x=10, y=40, width=80, height=30,
        barType=btype, barColor="#000000", fontColor="#000000",
        showText=False, textContent=value,
    )


def _qr_field(value: str):
    return VdpField(
        id="qr1", name="code", type="qrcode",
        x=10, y=40, width=40, height=40,
        fontColor="#000000", textContent=value,
    )


def _build_render_args(fields_dict):
    """Tái dựng field_rects / pw / ph / font_variants như process_chunk để gọi
    render_one_record trực tiếp."""
    field_rects = []
    for f in fields_dict:
        field_rects.append({
            'x': f['x'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'y': f['y'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'w': f['width'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
            'h': f['height'] * MM_TO_PTS * CSS_TO_PT_FACTOR,
        })
    return field_rects, PAGE_W_PT, PAGE_H_PT, {}


# ═══════════════════════════════════════════════
#  1. Symbology mapping: mỗi loại 1D → drawing có bounds > 0
# ═══════════════════════════════════════════════

@pytest.mark.parametrize("btype,expected", list(ONE_D_TYPES.items()))
def test_1d_symbology_maps_to_drawable_barcode(btype, expected):
    """Mỗi loại 1D ánh xạ đúng symbology ReportLab và tạo drawing có bounds > 0."""
    from reportlab.graphics.barcode import createBarcodeDrawing
    rl_symbology, value = expected
    drawing = createBarcodeDrawing(rl_symbology, value=value, humanReadable=False)
    x0, y0, x1, y1 = drawing.getBounds()
    assert x1 - x0 > 0, f"{btype}->{rl_symbology}: chiều rộng phải > 0"
    assert y1 - y0 > 0, f"{btype}->{rl_symbology}: chiều cao phải > 0"


# ═══════════════════════════════════════════════
#  2. End-to-end: 7 loại 1D + QR render ra PDF, không ERR, có pixel đậm
# ═══════════════════════════════════════════════

@pytest.mark.parametrize("btype,expected", list(ONE_D_TYPES.items()))
def test_1d_renders_nontrivial_pdf_without_err(btype, expected, template_1page, out_path):
    _, value = expected
    field = _barcode_field(btype, value)
    run_vdp_engine(template_1page, [field], [{"code": value}], out_path,
                   job_id=uuid.uuid4().hex)
    assert os.path.exists(out_path)
    # Không gắn nhãn lỗi → đường 1D giữ nguyên hành vi.
    text = _render_page_text(out_path, 0)
    assert "ERR" not in text, f"{btype} bị gắn nhãn lỗi: {text!r}"
    assert "MISSING" not in text
    # Render ra vạch đậm (output không tầm thường).
    pil = _render_page_pixels(out_path, 0)
    assert _dark_pixel_count(pil) > 20, f"{btype} không sinh vạch barcode"


def test_qr_renders_nontrivial_pdf_without_err(template_1page, out_path):
    field = _qr_field("HELLO-QR-123")
    run_vdp_engine(template_1page, [field], [{"code": "HELLO-QR-123"}], out_path,
                   job_id=uuid.uuid4().hex)
    text = _render_page_text(out_path, 0)
    assert "ERR" not in text
    pil = _render_page_pixels(out_path, 0)
    assert _dark_pixel_count(pil) > 20, "QR không sinh chấm đậm"


def test_qr_produces_nonempty_matrix():
    """QR sinh ma trận hợp lệ (Req 3.8 — QR giữ nguyên)."""
    import segno
    qr = segno.make("HELLO-QR-123", error='m')
    matrix = list(qr.matrix)
    assert len(matrix) > 0
    assert all(len(row) == len(matrix) for row in matrix), "ma trận QR phải vuông"


# ═══════════════════════════════════════════════
#  3. Nhánh 2D MỚI không can thiệp code path 1D / QR
# ═══════════════════════════════════════════════

class _CallRecorder:
    """Bọc createBarcodeDrawing để ghi lại symbology được yêu cầu."""
    def __init__(self, real):
        self._real = real
        self.calls = []

    def __call__(self, codeName, **kwargs):
        self.calls.append(codeName)
        return self._real(codeName, **kwargs)


def test_code128_still_routes_through_1d_path(monkeypatch):
    """Field 'code128' vẫn đi qua createBarcodeDrawing('Code128', ...) — nhánh 2D
    KHÔNG chiếm dụng đường 1D (Req 3.8, 7.2)."""
    field = _barcode_field('code128', 'ABC-12345')
    fields_dict = [field.model_dump()]
    field_rects, pw, ph, fv = _build_render_args(fields_dict)

    import reportlab.graphics.barcode as rl_barcode
    recorder = _CallRecorder(rl_barcode.createBarcodeDrawing)
    monkeypatch.setattr(rl_barcode, "createBarcodeDrawing", recorder)

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(pw, ph))
    render_one_record(c, fields_dict, {"code": "ABC-12345"}, field_rects, pw, ph, fv)
    c.showPage()
    c.save()

    assert recorder.calls == ['Code128'], (
        f"code128 phải đi qua đường 1D Code128, nhưng calls={recorder.calls}"
    )


def test_datamatrix_does_not_touch_1d_path(monkeypatch):
    """Field 'datamatrix' đi qua render_2d (ECC200) — KHÔNG gọi createBarcodeDrawing,
    chứng minh nhánh 2D tách bạch hoàn toàn khỏi đường 1D."""
    field = VdpField(
        id="dm1", name="code", type="barcode",
        x=10, y=10, width=40, height=40,
        barcodeType="datamatrix", barColor="#000000", textContent="DM-VALUE",
    )
    fields_dict = [field.model_dump()]
    field_rects, pw, ph, fv = _build_render_args(fields_dict)

    import reportlab.graphics.barcode as rl_barcode
    recorder = _CallRecorder(rl_barcode.createBarcodeDrawing)
    monkeypatch.setattr(rl_barcode, "createBarcodeDrawing", recorder)

    render_2d_called = {"v": False}
    real_render_2d = vdp_engine.render_2d

    def _spy_render_2d(*args, **kwargs):
        render_2d_called["v"] = True
        return real_render_2d(*args, **kwargs)

    monkeypatch.setattr(vdp_engine, "render_2d", _spy_render_2d)

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(pw, ph))
    render_one_record(c, fields_dict, {"code": "DM-VALUE"}, field_rects, pw, ph, fv)
    c.showPage()
    c.save()

    assert recorder.calls == [], (
        f"datamatrix KHÔNG được đi qua đường 1D, nhưng calls={recorder.calls}"
    )
    assert render_2d_called["v"], "datamatrix phải đi qua render_2d (nhánh 2D)"
