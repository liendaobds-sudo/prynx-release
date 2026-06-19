"""
Baseline / characterization tests cho VDP engine (app.workers.vdp_engine).

Mục tiêu (Pha 0 — lưới an toàn trước khi sửa engine):
  1. Khóa các bất biến (invariants) PHẢI luôn đúng: số trang = số bản ghi,
     text/QR render ra nội dung, đa-template cycle, không crash.
  2. Ghi nhận (characterize) các bug đã biết bằng test xfail — chúng sẽ
     tự động chuyển sang PASS sau khi sửa ở Pha 2, giúp phát hiện regression.

Cách kiểm tra output: rasterize PDF bằng pypdfium2 + trích text, để assert
nội dung và màu pixel một cách xác định.
"""
import os
import sys
import uuid
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.workers.vdp_engine import run_vdp_engine
from app.schemas.vdp import VdpField

import pypdfium2 as pdfium
from reportlab.pdfgen import canvas as rl_canvas


# ═══════════════════════════════════════════════
#  Fixtures & helpers
# ═══════════════════════════════════════════════

# A6 ~ 105 x 148 mm in points (1mm = 2.83465pt)
PAGE_W_PT = 297.5
PAGE_H_PT = 419.5


def _make_template(path: str, num_pages: int = 1):
    """Sinh template PDF trắng num_pages trang, kích thước cố định."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    for i in range(num_pages):
        # Vẽ 1 ký tự mờ để chắc chắn trang không hoàn toàn rỗng
        c.setFillColorRGB(0.95, 0.95, 0.95)
        c.rect(0, 0, PAGE_W_PT, PAGE_H_PT, stroke=0, fill=1)
        c.showPage()
    c.save()


@pytest.fixture
def template_1page(tmp_path):
    p = os.path.join(str(tmp_path), "tpl1.pdf")
    _make_template(p, 1)
    return p


@pytest.fixture
def template_2page(tmp_path):
    p = os.path.join(str(tmp_path), "tpl2.pdf")
    _make_template(p, 2)
    return p


@pytest.fixture
def out_path(tmp_path):
    return os.path.join(str(tmp_path), f"out_{uuid.uuid4().hex}.pdf")


def _text_field(**overrides):
    base = dict(
        id="f1", name="stt", type="text",
        x=10, y=10, width=80, height=15,
        fontColor="#000000", alignment="left",
        textContent="{stt}",
    )
    base.update(overrides)
    return VdpField(**base)


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
    """Trả về (PIL image, width, height) của trang đã rasterize."""
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_index]
        bitmap = page.render(scale=scale)
        pil = bitmap.to_pil().convert("RGB")
        return pil
    finally:
        pdf.close()


def _page_count(pdf_path: str) -> int:
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        return len(pdf)
    finally:
        pdf.close()


def _dark_bbox_size(pil, thresh=100):
    """Trả về (width, height) của bounding box các pixel tối (vạch/chữ)."""
    w, h = pil.size
    minx, miny, maxx, maxy = w, h, -1, -1
    step = max(1, min(w, h) // 300)
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            r, g, b = pil.getpixel((xx, yy))
            if r < thresh and g < thresh and b < thresh:
                if xx < minx: minx = xx
                if xx > maxx: maxx = xx
                if yy < miny: miny = yy
                if yy > maxy: maxy = yy
    if maxx < 0:
        return (0, 0)
    return (maxx - minx, maxy - miny)


def _has_color_near(pil, target_rgb, tol=60):
    """True nếu có pixel gần màu target trong ảnh."""
    w, h = pil.size
    tr, tg, tb = target_rgb
    # Quét thưa để nhanh
    step = max(1, min(w, h) // 200)
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            r, g, b = pil.getpixel((xx, yy))
            if abs(r - tr) <= tol and abs(g - tg) <= tol and abs(b - tb) <= tol:
                return True
    return False


# ═══════════════════════════════════════════════
#  Invariants — PHẢI luôn đúng (trước & sau khi sửa)
# ═══════════════════════════════════════════════

class TestInvariants:
    def test_page_count_equals_records(self, template_1page, out_path):
        data = [{"stt": str(i)} for i in range(5)]
        run_vdp_engine(template_1page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)
        assert _page_count(out_path) == 5

    def test_text_content_rendered(self, template_1page, out_path):
        data = [{"stt": "HELLO123"}]
        run_vdp_engine(template_1page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        text = _render_page_text(out_path, 0)
        assert "HELLO123" in text

    def test_per_record_distinct_values(self, template_1page, out_path):
        data = [{"stt": "AAA"}, {"stt": "BBB"}]
        run_vdp_engine(template_1page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        assert "AAA" in _render_page_text(out_path, 0)
        assert "BBB" in _render_page_text(out_path, 1)

    def test_multi_template_round_robin(self, template_2page, out_path):
        # 4 bản ghi trên template 2 trang → cycle 0,1,0,1
        data = [{"stt": str(i)} for i in range(4)]
        run_vdp_engine(template_2page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        assert _page_count(out_path) == 4

    def test_qrcode_renders_dark_pixels(self, template_1page, out_path):
        qr = VdpField(id="q1", name="code", type="qrcode",
                      x=10, y=10, width=40, height=40,
                      fontColor="#000000", textContent="{code}")
        data = [{"code": "HELLO-QR"}]
        run_vdp_engine(template_1page, [qr], data, out_path,
                       job_id=uuid.uuid4().hex)
        pil = _render_page_pixels(out_path, 0)
        # QR phải tạo ra pixel đen
        assert _has_color_near(pil, (0, 0, 0), tol=50)

    def test_empty_value_does_not_crash(self, template_1page, out_path):
        data = [{"stt": ""}]
        run_vdp_engine(template_1page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)
        assert _page_count(out_path) == 1


# ═══════════════════════════════════════════════
#  Characterization các bug đã biết (xfail → sẽ PASS sau Pha 2)
# ═══════════════════════════════════════════════

class TestKnownBugs:

    def test_special_chars_render_literally(self, template_1page, out_path):
        data = [{"stt": "A & <B>"}]
        run_vdp_engine(template_1page, [_text_field()], data, out_path,
                       job_id=uuid.uuid4().hex)
        text = _render_page_text(out_path, 0)
        assert "ERR" not in text
        assert "A & <B>" in text or "A &amp; <B>" in text

    def test_barcode_uses_barcolor(self, template_1page, out_path):
        bc = VdpField(id="b1", name="code", type="barcode",
                      x=10, y=10, width=80, height=30,
                      barType="code128", barColor="#FF0000",
                      fontColor="#000000", textContent="{code}")
        data = [{"code": "12345"}]
        run_vdp_engine(template_1page, [bc], data, out_path,
                       job_id=uuid.uuid4().hex)
        pil = _render_page_pixels(out_path, 0)
        # Vạch phải có màu đỏ (barColor), không phải đen (fontColor)
        assert _has_color_near(pil, (255, 0, 0), tol=80)

    def test_qrcode_uses_dotcolor(self, template_1page, out_path):
        qr = VdpField(id="q2", name="code", type="qrcode",
                      x=10, y=10, width=50, height=50,
                      fontColor="#000000",
                      qrStyle={"dotColor": "#FF0000", "bgColor": "#FFFFFF",
                               "transparentBg": False},
                      textContent="{code}")
        data = [{"code": "RED-QR"}]
        run_vdp_engine(template_1page, [qr], data, out_path,
                       job_id=uuid.uuid4().hex)
        pil = _render_page_pixels(out_path, 0)
        # Chấm QR phải đỏ (qrStyle.dotColor)
        assert _has_color_near(pil, (255, 0, 0), tol=80)

    def test_rotation_changes_content_orientation(self, template_1page, out_path, tmp_path):
        # Barcode ngang (rotation=0): bbox vạch rộng hơn cao.
        bc0 = VdpField(id="r0", name="code", type="barcode",
                       x=10, y=40, width=80, height=20,
                       barType="code128", textContent="{code}", rotation=0)
        run_vdp_engine(template_1page, [bc0], [{"code": "12345"}], out_path,
                       job_id=uuid.uuid4().hex)
        bw, bh = _dark_bbox_size(_render_page_pixels(out_path, 0))
        assert bw > bh, f"rotation=0 phải rộng hơn cao, được {bw}x{bh}"

        # Barcode dọc (rotation=90, box đã hoán w/h): bbox vạch cao hơn rộng.
        out2 = os.path.join(str(tmp_path), "rot90.pdf")
        bc90 = VdpField(id="r90", name="code", type="barcode",
                        x=40, y=10, width=20, height=80,
                        barType="code128", textContent="{code}", rotation=90)
        run_vdp_engine(template_1page, [bc90], [{"code": "12345"}], out2,
                       job_id=uuid.uuid4().hex)
        bw2, bh2 = _dark_bbox_size(_render_page_pixels(out2, 0))
        assert bh2 > bw2, f"rotation=90 phải cao hơn rộng, được {bw2}x{bh2}"
