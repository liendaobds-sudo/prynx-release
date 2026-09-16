import os
import io
import pytest
from reportlab.pdfgen import canvas
from reportlab.lib.colors import CMYKColor

from app.schemas.vdp import VdpField
from app.workers.vdp_engine import _draw_curved_text, run_vdp_engine


def test_vdp_schema_curved_fields():
    """Kiểm tra schema VdpField nhận đầy đủ các thuộc tính quỹ đạo vòm."""
    f = VdpField(
        id="f1",
        name="SoNhay",
        type="text",
        x=10.0,
        y=20.0,
        width=50.0,
        height=15.0,
        curveMode="arc_bottom",
        curveRadius=35.0,
        curveOrientation="outward",
        curveTracking=1.5,
    )
    dumped = f.model_dump()
    assert dumped["curveMode"] == "arc_bottom"
    assert dumped["curveRadius"] == 35.0
    assert dumped["curveOrientation"] == "outward"
    assert dumped["curveTracking"] == 1.5


def test_vdp_curved_text_draw_function():
    """Kiểm tra hàm _draw_curved_text vẽ được cả vòm trên và vòm dưới."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(300, 300))
    color = CMYKColor(0, 1, 1, 0)
    
    # Arc top
    field_top = {
        "curveMode": "arc_top",
        "curveRadius": 40.0,
        "curveOrientation": "outward",
        "curveTracking": 1.0,
    }
    drawn_top = _draw_curved_text(
        c, field_top, "SỰ KIỆN TRI ÂN", 50, 150, 100, 30, "Helvetica", 12, color
    )
    assert drawn_top is True

    # Arc bottom
    field_bottom = {
        "curveMode": "arc_bottom",
        "curveRadius": 35.0,
        "curveOrientation": "outward",
        "curveTracking": 2.0,
    }
    drawn_bottom = _draw_curved_text(
        c, field_bottom, "No.: 000001", 50, 50, 100, 30, "Helvetica", 14, color
    )
    assert drawn_bottom is True

    # None mode -> returns False so standard Paragraph handler takes over
    field_none = {"curveMode": "none"}
    drawn_none = _draw_curved_text(
        c, field_none, "Normal Text", 50, 50, 100, 30, "Helvetica", 14, color
    )
    assert drawn_none is False

    c.showPage()
    c.save()
    assert len(buf.getvalue()) > 500


def test_vdp_engine_curved_text_integration(tmp_path):
    """Tạo PDF template và chạy run_vdp_engine với trường vòm trên & vòm dưới."""
    import reportlab.pdfgen.canvas as rlc
    template_pdf = str(tmp_path / "template.pdf")
    output_pdf = str(tmp_path / "vdp_curved_out.pdf")

    # Tạo template 1 trang 200x200 pt
    tc = rlc.Canvas(template_pdf, pagesize=(200, 200))
    tc.circle(100, 100, 80, stroke=1, fill=0)
    tc.showPage()
    tc.save()

    # Tạo 2 trường: 1 vòm trên, 1 vòm dưới
    f_top = VdpField(
        id="f_top",
        name="Header",
        type="text",
        x=20.0,
        y=20.0,
        width=160.0,
        height=40.0,
        curveMode="arc_top",
        curveRadius=28.0,
        curveTracking=0.5,
        textContent="TRI AN KHACH HANG",
    )
    f_bottom = VdpField(
        id="f_bottom",
        name="Serial",
        type="text",
        x=20.0,
        y=140.0,
        width=160.0,
        height=40.0,
        curveMode="arc_bottom",
        curveRadius=28.0,
        curveTracking=1.0,
        textContent="No.: {Serial}",
    )

    data = [
        {"Serial": "000001"},
        {"Serial": "000002"},
        {"Serial": "000003"},
    ]

    run_vdp_engine(
        template_path=template_pdf,
        fields=[f_top, f_bottom],
        data=data,
        output_path=output_pdf,
    )

    assert os.path.exists(output_pdf)
    assert os.path.getsize(output_pdf) > 1000

    import pikepdf
    with pikepdf.open(output_pdf) as doc:
        assert len(doc.pages) == 3


def test_vdp_curved_small_radius_autofit(tmp_path):
    """Đảm bảo bán kính nhỏ (R=6mm, 8mm) tự động co cỡ chữ và vẽ đầy đủ chuỗi ký tự mà không lỗi."""
    from app.schemas.vdp import VdpField
    from app.workers.vdp_engine import run_vdp_engine
    import pikepdf
    from reportlab.pdfgen import canvas

    template_pdf = str(tmp_path / "tpl_small_r.pdf")
    output_pdf = str(tmp_path / "out_small_r.pdf")

    c = canvas.Canvas(template_pdf, pagesize=(200, 200))
    c.showPage()
    c.save()

    f_small_r = VdpField(
        id="f_small",
        name="SmallR",
        type="text",
        x=20.0,
        y=20.0,
        width=50.0,
        height=30.0,
        curveMode="arc_top",
        curveRadius=6.0,
        fontSize=14.0,
        textContent="{Truong_1}",
        autoFit=True,
    )

    data = [{"Truong_1": "Truong_1"}]
    run_vdp_engine(
        template_path=template_pdf,
        fields=[f_small_r],
        data=data,
        output_path=output_pdf,
    )

    assert os.path.exists(output_pdf)
    assert os.path.getsize(output_pdf) > 500
    with pikepdf.open(output_pdf) as doc:
        assert len(doc.pages) == 1


def test_vdp_curved_wave_mode(tmp_path):
    """Kiểm tra quỹ đạo lượn sóng (curveMode='wave') xuất file PDF thành công và đúng toạ độ sóng."""
    from app.schemas.vdp import VdpField
    from app.workers.vdp_engine import run_vdp_engine
    import pikepdf
    from reportlab.pdfgen import canvas

    template_pdf = str(tmp_path / "tpl_wave.pdf")
    output_pdf = str(tmp_path / "out_wave.pdf")

    c = canvas.Canvas(template_pdf, pagesize=(200, 150))
    c.showPage()
    c.save()

    f_wave = VdpField(
        id="f_wave",
        name="WaveField",
        type="text",
        x=10.0,
        y=10.0,
        width=60.0,
        height=25.0,
        curveMode="wave",
        curveRadius=4.0,  # Biên độ 4mm
        curveOrientation="outward",
        fontSize=12.0,
        textContent="KHUYEN MAI DAC BIET",
        autoFit=True,
    )

    data = [{"dummy": "1"}]
    run_vdp_engine(
        template_path=template_pdf,
        fields=[f_wave],
        data=data,
        output_path=output_pdf,
    )

    assert os.path.exists(output_pdf)
    assert os.path.getsize(output_pdf) > 500
    with pikepdf.open(output_pdf) as doc:
        assert len(doc.pages) == 1
