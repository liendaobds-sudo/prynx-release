import os
import io
import pytest
import pikepdf
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

from app.core import geometry_reader
from app.workers.vdp_text_picker import pick_text_to_vdp_field, auto_detect_vdp_tags


@pytest.fixture
def sample_vdp_pdf(tmp_path):
    pdf_path = str(tmp_path / "sample_card.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 200))
    # Text 1: Tag
    c.setFont("Helvetica", 14)
    c.setFillColor(HexColor("#FF0000"))
    c.drawString(40, 140, "Ho ten: {{HO_TEN}}")

    # Text 2: Text thường
    c.setFont("Helvetica-Bold", 11)
    c.setFillColor(HexColor("#008800"))
    c.drawString(40, 90, "Chuc vu: Giam doc")
    c.save()
    return pdf_path


def test_pick_text_to_vdp_field(sample_vdp_pdf, tmp_path):
    out_pdf = str(tmp_path / "cleaned_card.pdf")
    
    # Liệt kê để lấy drawIndex của 'Chuc vu: Giam doc'
    metas = geometry_reader.list_objects(sample_vdp_pdf, 0, include_text_props=True)
    assert len(metas) >= 2
    
    target = [m for m in metas if "Giam doc" in (m.content or "")][0]
    result = pick_text_to_vdp_field(
        pdf_path=sample_vdp_pdf,
        page_index=0,
        draw_index=target.drawIndex,
        remove_original=True,
        output_path=out_pdf,
    )
    
    assert result["success"] is True
    field = result["field"]
    assert "Giam_doc" in field["name"] or "Chuc_vu" in field["name"]
    assert field["fontSize"] == 11.0 or field["fontSize"] == 11
    assert field["fontColor"].upper() == "#008800"
    assert field["x"] > 0
    assert field["y"] > 0
    assert field["width"] > 0
    assert field["height"] > 0
    assert field["autoFit"] is True
    
    # Kiểm tra file đã xóa text đó
    assert os.path.isfile(out_pdf)
    cleaned_metas = geometry_reader.list_objects(out_pdf, 0, include_text_props=True)
    contents = [m.content for m in cleaned_metas if m.content]
    assert not any("Giam doc" in c for c in contents)
    assert any("HO_TEN" in c for c in contents)


def test_auto_detect_vdp_tags(sample_vdp_pdf, tmp_path):
    out_pdf = str(tmp_path / "cleaned_tags.pdf")
    result = auto_detect_vdp_tags(
        pdf_path=sample_vdp_pdf,
        page_index=0,
        remove_original=True,
        output_path=out_pdf,
    )
    
    assert result["success"] is True
    assert result["detectedCount"] == 1
    field = result["fields"][0]
    assert field["name"] == "HO_TEN"
    assert "{{HO_TEN}}" in field["textContent"]
    assert field["fontColor"].upper() == "#FF0000"
    assert field["fontSize"] == 14.0 or field["fontSize"] == 14
    
    # Kiểm tra file đã làm sạch tag
    assert os.path.isfile(out_pdf)
    cleaned_metas = geometry_reader.list_objects(out_pdf, 0, include_text_props=True)
    contents = [m.content for m in cleaned_metas if m.content]
    assert not any("HO_TEN" in c for c in contents)
    assert any("Giam doc" in c for c in contents)


def test_font_resolution_registry():
    from app.workers.vdp_text_picker import _find_font_in_windows_registry, _resolve_font_file
    # Arial chắc chắn có trên mọi máy Windows
    path = _find_font_in_windows_registry("Arial")
    assert path is not None
    assert os.path.isfile(path)
    assert path.lower().endswith(".ttf")

    # _resolve_font_file cũng tìm được
    assert _resolve_font_file("Arial") is not None


def test_extract_embedded_font(tmp_path):
    from app.workers.vdp_text_picker import _extract_embedded_font_from_pdf
    # Tạo PDF nhúng 1 stream font giả lập
    fake_font_data = b"\x00\x01\x00\x00" + b"\x00" * 200  # header ttf
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    fontfile = pikepdf.Stream(pdf, fake_font_data)
    cidfont = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.CIDFontType2,
        BaseFont=pikepdf.Name("/CustomScriptFont"),
        FontDescriptor=pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.FontDescriptor, FontName=pikepdf.Name("/CustomScriptFont"),
            FontFile2=pdf.make_indirect(fontfile),
        )),
    )
    type0 = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type0,
        BaseFont=pikepdf.Name("/ABCDEF+CustomScriptFont"), Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([pdf.make_indirect(cidfont)]),
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F0=pdf.make_indirect(type0))
    )
    page.Contents = pdf.make_stream(b"BT /F0 12 Tf 10 10 Td <0001> Tj ET")
    pdf_path = str(tmp_path / "embedded_font_doc.pdf")
    pdf.save(pdf_path)
    pdf.close()

    extracted = _extract_embedded_font_from_pdf(pdf_path, 0, "ABCDEF+CustomScriptFont")
    assert extracted is not None
    assert os.path.isfile(extracted)
    assert os.path.getsize(extracted) == len(fake_font_data)



def test_pick_curved_text_font_size(tmp_path):
    import math
    pdf_path = str(tmp_path / "curved_text_doc.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(400, 400))
    c.setFont("Helvetica", 24)
    chars = "NGUYEN"
    R = 80.0
    cx, cy = 200.0, 200.0
    angles = [-30, -18, -6, 6, 18, 30]
    for ch, a in zip(chars, angles):
        c.saveState()
        rad = math.radians(a + 90)
        x = cx + R * math.cos(rad)
        y = cy + R * math.sin(rad)
        c.translate(x, y)
        c.rotate(a)
        c.drawString(0, 0, ch)
        c.restoreState()
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    res = pick_text_to_vdp_field(pdf_path, 0, metas[0].drawIndex, remove_original=False)
    assert res["success"] is True
    field = res["field"]
    assert field["name"] == "NGUYEN"
    assert field["fontSize"] == 24.0
    assert field["curveMode"] == "arc_top"
    assert field["curveRadius"] > 0
