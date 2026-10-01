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
    assert field.get("fontStyle") == "bold"
    assert field.get("fontWeight") == 700
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


def test_pick_curved_text_writes_cleaned_template(tmp_path):
    """Bóc chữ cong phải ghi phôi sạch; nếu không field mới sẽ chồng lên chữ cũ."""
    import math

    pdf_path = str(tmp_path / "curved_text_clean_source.pdf")
    out_pdf = str(tmp_path / "curved_text_cleaned.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(400, 400))
    c.setFont("Helvetica", 24)
    for ch, angle in zip("NGUYEN", (-30, -18, -6, 6, 18, 30)):
        c.saveState()
        rad = math.radians(angle + 90)
        c.translate(200 + 80 * math.cos(rad), 200 + 80 * math.sin(rad))
        c.rotate(angle)
        c.drawString(0, 0, ch)
        c.restoreState()
    c.save()

    objects = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    result = pick_text_to_vdp_field(
        pdf_path,
        0,
        objects[0].drawIndex,
        remove_original=True,
        output_path=out_pdf,
    )

    assert result["cleanedPdfPath"] == out_pdf
    assert os.path.isfile(out_pdf)
    assert not [obj for obj in geometry_reader.list_objects(out_pdf, 0, include_text_props=True) if obj.type == "text"]


def test_pick_text_fails_closed_when_template_cleanup_fails(sample_vdp_pdf, tmp_path, monkeypatch):
    """Không trả field thành công nếu PDF sạch không được ghi."""
    metas = geometry_reader.list_objects(sample_vdp_pdf, 0, include_text_props=True)
    target = metas[0]
    out_pdf = str(tmp_path / "cleanup_failure.pdf")

    def fail_delete(*_args, **_kwargs):
        raise RuntimeError("synthetic delete failure")

    monkeypatch.setattr("app.workers.vdp_text_picker.stream_editor.delete_objects", fail_delete)
    with pytest.raises(ValueError, match="template VDP đã làm sạch"):
        pick_text_to_vdp_field(
            sample_vdp_pdf, 0, target.drawIndex, remove_original=True, output_path=out_pdf
        )
    assert not os.path.exists(out_pdf)


def test_pick_text_baseline_parity(tmp_path):
    """Kiểm tra baseline parity: ReportLab phải vẽ baseline trùng khít 100% với baseline_y gốc của chữ."""
    pdf_path = str(tmp_path / "baseline_test.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(400, 300))
    # Vẽ chữ tại y=150.0 (baseline_y = 150.0)
    c.setFont("Helvetica", 14)
    c.drawString(50, 150, "<Name C>")
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    target = [m for m in metas if "<Name C>" in (m.content or "")][0]
    res = pick_text_to_vdp_field(pdf_path, 0, target.drawIndex, remove_original=False)
    assert res["success"] is True
    field = res["field"]

    # Quy đổi tọa độ mm của field sang point trong ReportLab:
    # y_pts = field['y'] * MM_TO_PTS * CSS_TO_PT_FACTOR
    # h_pts = field['height'] * MM_TO_PTS * CSS_TO_PT_FACTOR
    from app.workers.vdp_engine import MM_TO_PTS, CSS_TO_PT_FACTOR
    y_pts = field["y"] * MM_TO_PTS * CSS_TO_PT_FACTOR
    h_pts = field["height"] * MM_TO_PTS * CSS_TO_PT_FACTOR
    rl_y = 300 - y_pts - h_pts
    effective_fs = field["fontSize"]

    # ReportLab vẽ baseline tại:
    baseline_rl = rl_y + (h_pts - effective_fs) / 2.0

    # Khẳng định sai số baseline giữa ReportLab và chữ gốc trong PDF < 0.05 pt (< 0.02 mm)
    assert abs(baseline_rl - 150.0) < 0.05, f"Baseline lệch: rl={baseline_rl} vs orig=150.0"


def test_resolve_font_file_comprehensive():
    from app.workers.vdp_text_picker import resolve_font_file, VALID_FONT_EXTENSIONS

    # 1. Font tiêu chuẩn
    arial_path = resolve_font_file("Arial")
    assert arial_path is not None
    assert os.path.isfile(arial_path)
    assert arial_path.lower().endswith(VALID_FONT_EXTENSIONS)

    times_path = resolve_font_file("Times-Roman")
    assert times_path is not None
    assert os.path.isfile(times_path)
    assert not times_path.lower().endswith(".fon")
    assert times_path.lower().endswith(VALID_FONT_EXTENSIONS)

    # 2. Font không tồn tại phải trả về None (không được fallback ngầm)
    assert resolve_font_file("NonExistentFontXYZ987") is None
    assert resolve_font_file("") is None
    assert resolve_font_file(None) is None


def test_vdp_engine_font_resolver_and_registration():
    from app.workers.vdp_engine import _resolve_system_font, _register_font_family
    import io
    from reportlab.pdfgen import canvas
    import pikepdf

    # 1. Kiểm tra _resolve_system_font không fallback ngầm sang Arial
    non_existent = _resolve_system_font("DefinitelyNotAFontOnAnySystem12345")
    assert non_existent is None

    # 2. Kiểm tra _resolve_system_font tìm được font có sẵn trên Windows
    arial = _resolve_system_font("Arial")
    assert arial is not None
    assert os.path.isfile(arial)

    # 3. Kiểm tra _register_font_family gán đúng PostScript name không bị ReportLab chèn dấu '-'
    variants = _register_font_family(arial, "test_arial")
    assert "regular" in variants

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.setFont(variants["regular"], 12)
    c.drawString(50, 50, "Hello Live Text")
    c.save()

    buf.seek(0)
    pdf = pikepdf.open(buf)
    page = pdf.pages[0]
    fonts = page.Resources.Font
    base_fonts = [str(f.BaseFont) for f in fonts.values()]
    # BaseFont phải chứa tên PostScript thật của font
    assert any("Arial" in bf for bf in base_fonts)


def test_pick_text_with_stroke_and_shadow(tmp_path):
    out_pdf = str(tmp_path / "cleaned_effect.pdf")
    pdf_path = str(tmp_path / "card_with_effects.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 200))
    # Layer 1: Shadow text bên dưới (x=41, y=99, màu xám)
    c.setFont("Helvetica-Bold", 16)
    c.setFillColor(HexColor("#333333"))
    c.drawString(41, 99, "GIAM DOC")
    # Layer 2: Main text viền nét (x=40, y=100, màu đỏ, viền xanh)
    c.setFillColor(HexColor("#FF0000"))
    c.setStrokeColor(HexColor("#0000FF"))
    c.setLineWidth(1.5)
    t = c.beginText(40, 100)
    t.setFont("Helvetica-Bold", 16)
    t.setTextRenderMode(2)  # fill and stroke
    t.textOut("GIAM DOC")
    c.drawText(t)
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    assert len(metas) >= 2
    # Chọn text object chính
    main_obj = metas[-1]
    res = pick_text_to_vdp_field(
        pdf_path=pdf_path,
        page_index=0,
        draw_index=main_obj.drawIndex,
        remove_original=True,
        output_path=out_pdf,
    )

    assert res["success"] is True
    f = res["field"]
    assert "GIAM_DOC" in f["name"] or "GIAM" in f["name"]
    # Kiểm tra stroke properties được trích xuất
    if f.get("strokeColor"):
        assert f["strokeColor"].upper() == "#0000FF"
        assert f.get("strokeWidth") is not None and f["strokeWidth"] > 0
    # Kiểm tra shadow text được dọn dẹp khỏi file mẫu sạch (không để hiệu ứng nằm lại)
    assert os.path.isfile(out_pdf)
    cleaned_metas = geometry_reader.list_objects(out_pdf, 0, include_text_props=True)
    cleaned_contents = [m.content for m in cleaned_metas if m.content]
    assert not any("GIAM DOC" in text for text in cleaned_contents)


def test_pick_text_with_vector_outline_paths(tmp_path):
    out_pdf = str(tmp_path / "cleaned_vector_outline.pdf")
    pdf_path = str(tmp_path / "card_with_vector_outlines.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 200))
    # Layer 1: Vector outline paths bên dưới (mô phỏng Illustrator xuất vector paths)
    c.setStrokeColor(HexColor("#CFEDFB"))
    c.setLineWidth(1.0)
    c.setLineJoin(1)  # Round join
    c.setLineCap(1)   # Round cap
    # Vẽ vài vector paths quanh text
    p = c.beginPath()
    p.moveTo(50, 100)
    p.lineTo(60, 115)
    p.lineTo(70, 100)
    c.drawPath(p, stroke=1, fill=0)

    # Layer 2: Main text
    c.setFillColor(HexColor("#005992"))
    t = c.beginText(50, 100)
    t.setFont("Helvetica-Bold", 14)
    t.textOut("Nguyen Le Tuyet Mai")
    c.drawText(t)
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    text_objs = [m for m in metas if m.type == "text"]
    assert len(text_objs) >= 1
    target = text_objs[0]

    res = pick_text_to_vdp_field(
        pdf_path=pdf_path,
        page_index=0,
        draw_index=target.drawIndex,
        remove_original=True,
        output_path=out_pdf,
    )

    assert res["success"] is True
    f = res["field"]
    assert f.get("strokeColor") is not None
    assert f.get("strokeLineJoin") == "round"
    assert f.get("strokeLineCap") == "round"
    # Cả vector path và text đều được dọn sạch khỏi file phôi
    assert os.path.isfile(out_pdf)
    cleaned_metas = geometry_reader.list_objects(out_pdf, 0, include_text_props=True)
    assert not any(m.type == "text" for m in cleaned_metas)
    assert not any(m.type == "vector" for m in cleaned_metas)


def test_pick_fill_only_text_no_stroke(tmp_path):
    """Kiểm tra chữ fill-only (renderMode=0) tuyệt đối không bị gán stroke viền đen mặc định của graphics state."""
    pdf_path = str(tmp_path / "fill_only_text.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 200))
    c.setFillColor(HexColor("#005992"))
    t = c.beginText(50, 100)
    t.setFont("Helvetica", 12)
    t.textOut("Tran trong!")
    c.drawText(t)
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    target = [m for m in metas if m.type == "text"][0]

    # Kiểm tra geometry_reader không gán stroke
    assert target.strokeColor is None
    assert target.strokeWidth is None

    # Kiểm tra pick_text_to_vdp_field không tạo stroke
    res = pick_text_to_vdp_field(pdf_path, 0, target.drawIndex, remove_original=False)
    f = res["field"]
    assert f.get("strokeColor") is None
    assert f.get("strokeWidth") is None


def test_pick_multiline_cluster_with_newlines_and_spaces(tmp_path):
    """Kiểm tra cụm text gồm nhiều đối tượng trên các dòng khác nhau được nối bằng newline và khoảng trắng, không dính chuỗi."""
    pdf_path = str(tmp_path / "multiline_cluster.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(300, 300))
    c.setFillColor(HexColor("#005992"))

    # Line 1: Word 1 and Word 2
    t1 = c.beginText(50, 150)
    t1.setFont("Helvetica", 12)
    t1.textOut("Tran")
    c.drawText(t1)

    t2 = c.beginText(90, 150)
    t2.setFont("Helvetica", 12)
    t2.textOut("trong!")
    c.drawText(t2)

    # Line 2: Giam doc
    t3 = c.beginText(50, 100)
    t3.setFont("Helvetica", 12)
    t3.textOut("Giam doc")
    c.drawText(t3)
    c.save()

    metas = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    text_objs = [m for m in metas if m.type == "text"]
    assert len(text_objs) == 3

    member_indices = [m.drawIndex for m in text_objs]
    res = pick_text_to_vdp_field(
        pdf_path, 0, text_objs[0].drawIndex, remove_original=False, member_draw_indices=member_indices
    )
    f = res["field"]
    # Kiểm tra line 1 có khoảng trắng giữa 'Tran' và 'trong!'
    # và line 2 được ngăn cách bằng '\n', KHÔNG bị nối dính thành 'Trantrong!Giam doc'
    lines = f["textContent"].split("\n")
    assert len(lines) == 2
    assert lines[0] == "Tran trong!"
    assert lines[1] == "Giam doc"


def test_wrap_cff_to_otf_ots_compliance():
    """Kiểm tra font OTF sinh ra từ CFF stream tuân thủ 100% chuẩn OpenType Sanitizer (OTS) của Chromium."""
    import glob
    from fontTools.ttLib import TTFont
    from app.workers.vdp_text_picker import wrap_cff_to_otf, _extract_embedded_font_from_pdf
    
    # Tìm file PDF mẫu nếu có trong Temp
    pdfs = glob.glob(os.path.expanduser(r"~\AppData\Local\Temp\*CMNM*.pdf"))
    if not pdfs:
        pytest.skip("Không có file CMNM PDF mẫu trong Temp")
    
    pdf_path = pdfs[0]
    extracted_font = _extract_embedded_font_from_pdf(pdf_path, 0, "SVN-Gilroy", content="tầng 2,")
    assert extracted_font is not None
    assert os.path.isfile(extracted_font)
    assert extracted_font.endswith(".otf")
    
    tt = TTFont(extracted_font)
    os2 = tt["OS/2"]
    # OTS yêu cầu: usWinAscent và usWinDescent KHÔNG được đồng thời bằng 0
    assert os2.usWinAscent > 0
    assert os2.usWinDescent > 0
    # OTS yêu cầu: fsType == 0 (Installable) để không bị trình duyệt chặn webfont
    assert os2.fsType == 0
    assert os2.achVendID in ("PRYN", b"PRYN")
    
    # Bảng name phải có fullName (nameID 4) và uniqueFontIdentifier (nameID 3)
    name_dict = {rec.nameID: rec.toUnicode() for rec in tt["name"].names if rec.platformID == 3}
    assert 4 in name_dict
    assert "SVN-Gilroy" in name_dict[4]
    assert 3 in name_dict
    
    # Cmap phải nhận diện uni1EA7 (ầ), a, 2, g
    cmap = tt.getBestCmap()
    assert ord("a") in cmap
    assert ord("2") in cmap
    assert ord("g") in cmap
    assert 0x1EA7 in cmap  # ầ


def test_pick_rotated_vertical_text(tmp_path):
    """Kiểm tra chọn text xoay dọc (90 độ theo chiều kim đồng hồ) trích xuất đúng rotation=90, layout dọc."""
    pdf_path = str(tmp_path / "rotated_sample.pdf")
    c = canvas.Canvas(pdf_path, pagesize=(200, 200))
    # ReportLab rotate(-90) hoặc rotate(270) tương đương 90° clockwise trong PDF:
    c.saveState()
    c.translate(50, 150)
    c.rotate(-90)
    c.setFont("Helvetica", 10)
    c.setFillColor(HexColor("#112233"))
    c.drawString(0, 0, "R.2512HX-SP.1000.10-402.1")
    c.restoreState()
    c.save()

    objs = geometry_reader.list_objects(pdf_path, 0, include_text_props=True)
    text_objs = [o for o in objs if o.type == "text"]
    assert len(text_objs) >= 1

    target = text_objs[0]
    res = pick_text_to_vdp_field(pdf_path, 0, target.drawIndex, remove_original=False)
    assert res["success"] is True
    f = res["field"]
    assert f["rotation"] == 90
    assert f["alignment"] == "left"
    # Khung dọc: chiều cao (height) dọc theo dòng chữ phải dài hơn bề ngang (width) của con chữ
    assert f["height"] > f["width"]
    assert "2512HX" in f["textContent"]
    assert f["fontColor"].upper() == "#112233"
