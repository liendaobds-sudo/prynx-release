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

    def test_literal_text_content_substitutes_when_field_name_in_row(self, template_1page, out_path):
        """Field tạo từ picker có textContent là text gốc ('ten') không có ngoặc nhọn.
        Khi row có key 'ten', engine phải thay thế giá trị từ row thay vì giữ nguyên 'ten'."""
        tf = VdpField(id="f_pick", name="ten", type="text",
                      x=10, y=10, width=80, height=30,
                      fontSize=20, fontColor="#000000",
                      textContent="ten")
        data = [{"ten": "No.00001"}]
        run_vdp_engine(template_1page, [tf], data, out_path,
                       job_id=uuid.uuid4().hex)
        txt = _render_page_text(out_path, 0)
        assert "No.00001" in txt


class TestLiveTextIllustratorInteroperability:
    """[VDP-TYPE0-LIVE-TEXT] Kiểm tra hợp đồng tương thích Illustrator:
    1. Text xuất ra dưới dạng Type0 / Identity-H Composite Font với bảng /ToUnicode chuẩn.
    2. Không bị đóng gói trong Form XObject (/NupXo... /Form) làm Illustrator cô lập hoặc ép outline.
    3. Giữ nguyên 100% tiếng Việt có dấu.
    """

    def test_vdp_renders_type0_composite_fonts(self, template_1page, out_path):
        import pikepdf
        from app.workers.vdp_text_picker import resolve_font_file

        font_path = resolve_font_file("Arial") or r"C:\Windows\Fonts\arial.ttf"
        tf = VdpField(
            id="f_vietnamese",
            name="ho_ten",
            type="text",
            x=15,
            y=20,
            width=70,
            height=20,
            fontSize=14,
            fontColor="#B4141E",
            fontName="Arial",
            fontFile=font_path if os.path.exists(font_path) else None,
            alignment="center",
            textContent="{ho_ten}",
        )
        sample_name = "Cháu Nguyễn Thị Minh Thư"
        data = [{"ho_ten": sample_name}]

        run_vdp_engine(template_1page, [tf], data, out_path, job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)

        # 1. Kiểm tra bằng pikepdf
        with pikepdf.open(out_path) as pdf:
            page = pdf.pages[0]
            # Không có Form XObject /NupXo nào
            xobjs = list(page.Resources.get("/XObject", {}).keys())
            assert not any("NupXo" in str(xo) for xo in xobjs), f"Không được có Form XObject: {xobjs}"

            # Phải có font Type0 với Identity-H
            fonts = page.Resources.get("/Font", {})
            type0_fonts = [f for f in fonts.values() if str(f.get("/Subtype")) == "/Type0"]
            assert len(type0_fonts) >= 1, f"Phải có ít nhất 1 font Type0, tìm thấy: {fonts}"
            for t0 in type0_fonts:
                assert str(t0.get("/Encoding")) == "/Identity-H"

        # 2. Kiểm tra trích xuất text tiếng Việt nguyên vẹn
        extracted = _render_page_text(out_path, 0)
        assert sample_name in extracted

    def test_vdp_mixed_barcode_and_type0_text(self, template_1page, out_path):
        import pikepdf

        tf = VdpField(
            id="f_text",
            name="name",
            type="text",
            x=10,
            y=10,
            width=80,
            height=15,
            fontSize=12,
            textContent="{name}",
        )
        bc = VdpField(
            id="f_bc",
            name="code",
            type="barcode",
            x=10,
            y=30,
            width=80,
            height=25,
            barType="code128",
            textContent="{code}",
        )
        data = [{"name": "Trần Văn Bình", "code": "PRYNX-999"}]

        run_vdp_engine(template_1page, [tf, bc], data, out_path, job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)

        with pikepdf.open(out_path) as pdf:
            page = pdf.pages[0]
            xobjs = list(page.Resources.get("/XObject", {}).keys())
            assert not any("NupXo" in str(xo) for xo in xobjs)

        extracted = _render_page_text(out_path, 0)
        assert "Trần Văn Bình" in extracted

    def test_clean_template_dead_text_ops_and_ghost_fonts(self, tmp_path):
        """[VDP-TYPE0-LIVE-TEXT] Kiểm tra tự động dọn dead Tf, xóa ghost font và chuẩn hoá font tĩnh."""
        import pikepdf
        from reportlab.pdfgen import canvas
        from reportlab.lib.colors import HexColor
        from app.workers.vdp_engine import _clean_template_dead_text_ops_and_fonts

        tmpl_file = str(tmp_path / "ghost_font_template.pdf")
        c = canvas.Canvas(tmpl_file, pagesize=(300, 200))
        c.setFont("Helvetica", 12)
        c.drawString(30, 150, "Dong chu giu lai")
        c.setFont("Times-Roman", 14)
        c.drawString(30, 80, "Dong chu se bi xoa")
        c.save()

        # Giả lập xóa text của Times-Roman nhưng để lại dead Tf
        pdf = pikepdf.open(tmpl_file)
        page = pdf.pages[0]
        instructions = pikepdf.parse_content_stream(page)

        # Bỏ Tj của "Dong chu se bi xoa"
        new_instrs = []
        for instr in instructions:
            if str(instr.operator) in ('Tj', 'TJ') and any("Dong chu se bi xoa" in str(op) for op in instr.operands):
                continue
            new_instrs.append(instr)
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(new_instrs))

        # Kiểm tra trước khi dọn: cả 2 font đều có trong Resources
        assert "/Font" in page.Resources
        initial_fonts = list(page.Resources.Font.keys())
        assert len(initial_fonts) >= 2

        # Chạy dọn dẹp
        stats = _clean_template_dead_text_ops_and_fonts(page, pdf)
        assert stats["dead_tf_removed"] >= 1
        assert stats["ghost_fonts_purged"] >= 1

        # Sau khi dọn: font ma bị xóa, font thật của dòng chữ còn lại vẫn nguyên vẹn
        remaining_fonts = list(page.Resources.Font.keys())
        assert len(remaining_fonts) < len(initial_fonts)

        cleaned_file = str(tmp_path / "cleaned_template.pdf")
        pdf.save(cleaned_file)
        pdf.close()

        extracted = _render_page_text(cleaned_file, 0)
        assert "Dong chu giu lai" in extracted
        assert "Dong chu se bi xoa" not in extracted

    def test_vdp_alignment_and_rotation_audit_fixes(self, template_1page, out_path):
        """[VDPALIGN21.03-04] Kiểm tra export VDP với rotation 90 độ, căn giữa và bù gốc ink bearing."""
        import pikepdf

        tf_rot90 = VdpField(
            id="f_rot",
            name="customer",
            type="text",
            x=20,
            y=20,
            width=50,
            height=100,
            fontSize=16,
            rotation=90,
            alignment="center",
            autoFit=True,
            textContent="{customer}",
        )
        tf_center_long = VdpField(
            id="f_long",
            name="title",
            type="text",
            x=10,
            y=140,
            width=80,
            height=20,
            fontSize=18,
            rotation=0,
            alignment="center",
            autoFit=True,
            textContent="{title}",
        )
        data = [{
            "customer": "Nguyễn Hoàng Nam",
            "title": "CHỨNG NHẬN ĐẠT CHUẨN IN ẤN VÀ BAO BÌ CHUYÊN NGHIỆP"
        }]

        run_vdp_engine(template_1page, [tf_rot90, tf_center_long], data, out_path, job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)

        with pikepdf.open(out_path) as pdf:
            page = pdf.pages[0]
            fonts = page.Resources.get("/Font", {})
            assert len(fonts) >= 1

        extracted = _render_page_text(out_path, 0)
        assert "Nguyễn Hoàng Nam" in extracted
        assert "CHỨNG NHẬN" in extracted


class TestNoDuplicateBoldText:
    """Kiểm tra bất biến: Chữ in đậm (Bold/weight >= 600) KHÔNG bao giờ bị nhân đôi text object."""

    def test_is_font_already_bold_helper(self):
        from app.workers.vdp_engine import _is_font_already_bold
        # Các file bold hệ thống phổ biến nếu có
        for p in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\timesbd.ttf"):
            if os.path.exists(p):
                assert _is_font_already_bold(p) is True

    def test_bold_field_produces_single_text_object(self, template_1page, tmp_path):
        out_path = os.path.join(str(tmp_path), "out_single_bold.pdf")
        tf_bold = VdpField(
            id="f_bold",
            name="name",
            type="text",
            x=20,
            y=50,
            width=60,
            height=15,
            fontSize=14,
            fontWeight=700,
            fontStyle="bold",
            fontFile=r"C:\Windows\Fonts\arialbd.ttf" if os.path.exists(r"C:\Windows\Fonts\arialbd.ttf") else None,
            textContent="{name}",
        )
        data = [{"name": "Phạm Sĩ Mạnh"}]
        run_vdp_engine(template_1page, [tf_bold], data, out_path, job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)

        doc = pdfium.PdfDocument(out_path)
        page = doc[0]
        text_objs = [obj for obj in page.get_objects() if obj.type == pdfium.raw.FPDF_PAGEOBJ_TEXT]
        # Bất biến cốt lõi: 1 text field chỉ sinh đúng 1 text object, TUYỆT ĐỐI không sinh đè 2 text objects
        assert len(text_objs) == 1
        doc.close()

    def test_faux_bold_regular_font_produces_single_text_object(self, template_1page, tmp_path):
        out_path = os.path.join(str(tmp_path), "out_single_faux_bold.pdf")
        # Dùng font regular nhưng yêu cầu bold để kích hoạt nhánh faux bold
        tf_faux = VdpField(
            id="f_faux",
            name="name",
            type="text",
            x=20,
            y=50,
            width=60,
            height=15,
            fontSize=14,
            fontWeight=700,
            fontStyle="bold",
            fontFile=r"C:\Windows\Fonts\arial.ttf" if os.path.exists(r"C:\Windows\Fonts\arial.ttf") else None,
            textContent="{name}",
        )
        data = [{"name": "Phạm Sĩ Mạnh Faux"}]
        run_vdp_engine(template_1page, [tf_faux], data, out_path, job_id=uuid.uuid4().hex)
        assert os.path.exists(out_path)

        doc = pdfium.PdfDocument(out_path)
        page = doc[0]
        text_objs = [obj for obj in page.get_objects() if obj.type == pdfium.raw.FPDF_PAGEOBJ_TEXT]
        assert len(text_objs) == 1
        doc.close()




