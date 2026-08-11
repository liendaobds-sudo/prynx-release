"""
Test outline-fonts hardening: flatten annotation/form + verify + detect unembedded.

Các chốt an toàn của engine nội bộ:
  - Text trong AcroForm field / annotation phải flatten vào content trước.
  - Font chưa nhúng hoặc không có dữ liệu glyph phải bị từ chối.
  - Output phải được hậu kiểm text còn sót và so kẽm.
"""
import pikepdf
import pytest

from app.core.outline_fonts import (
    count_live_text,
    detect_unembedded_fonts,
    flatten_annotations_and_forms,
)


def _make_form_field_pdf(path: str) -> None:
    """PDF có 1 AcroForm text field mang giá trị 'HELLOFORM' (text nằm trong
    appearance stream của widget, KHÔNG trong content stream trang)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))

    helv = pikepdf.Dictionary({
        "/Type": "/Font", "/Subtype": "/Type1", "/BaseFont": "/Helvetica",
    })
    dr = pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/Helv": pdf.make_indirect(helv)})})

    # Appearance stream của widget chứa text "HELLOFORM".
    ap_stream = pdf.make_stream(
        b"/Tx BMC q BT /Helv 12 Tf 2 2 Td (HELLOFORM) Tj ET Q EMC",
        {"/Type": pikepdf.Name("/XObject"), "/Subtype": pikepdf.Name("/Form"),
         "/BBox": pikepdf.Array([0, 0, 200, 20]),
         "/Resources": pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/Helv": pdf.make_indirect(helv)})})},
    )

    widget = pikepdf.Dictionary({
        "/Type": "/Annot", "/Subtype": "/Widget", "/FT": "/Tx",
        "/T": pikepdf.String("field1"), "/V": pikepdf.String("HELLOFORM"),
        "/Rect": pikepdf.Array([100, 700, 300, 720]),
        # /F=4 (Print): FLAT_PRINT chỉ bake annotation có cờ Print → cần đặt để
        # flatten widget vào content stream (giống annotation in thực tế).
        "/F": 4,
        "/AP": pikepdf.Dictionary({"/N": ap_stream}),
        "/DA": pikepdf.String("/Helv 12 Tf 0 g"),
    })
    widget_ref = pdf.make_indirect(widget)
    widget["/P"] = page.obj
    page.obj["/Annots"] = pikepdf.Array([widget_ref])

    pdf.Root["/AcroForm"] = pikepdf.Dictionary({
        "/Fields": pikepdf.Array([widget_ref]), "/DR": dr,
        "/DA": pikepdf.String("/Helv 12 Tf 0 g"), "/NeedAppearances": False,
    })
    pdf.save(path)
    pdf.close()


def _make_unembedded_font_pdf(path: str) -> None:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    descriptor = pikepdf.Dictionary({
        "/Type": "/FontDescriptor", "/FontName": "/FakeFontQA", "/Flags": 32,
        "/ItalicAngle": 0, "/Ascent": 800, "/Descent": -200,
        "/CapHeight": 700, "/StemV": 80,
    })
    font = pikepdf.Dictionary({
        "/Type": "/Font", "/Subtype": "/TrueType", "/BaseFont": "/FakeFontQA",
        "/FirstChar": 32, "/LastChar": 126, "/Widths": pikepdf.Array([500] * 95),
        "/FontDescriptor": pdf.make_indirect(descriptor),
    })
    page["/Resources"] = pikepdf.Dictionary({
        "/Font": pikepdf.Dictionary({"/F1": pdf.make_indirect(font)}),
    })
    page["/Contents"] = pdf.make_stream(b"BT /F1 24 Tf 72 700 Td (Unembedded) Tj ET")
    pdf.save(path)
    pdf.close()


def test_flatten_bakes_form_text_into_content(tmp_path):
    """Text trong form field ban đầu KHÔNG có trong content stream; sau flatten
    phải nằm trong content stream (GS outline được)."""
    src = str(tmp_path / "form.pdf")
    out = str(tmp_path / "form_flat.pdf")
    _make_form_field_pdf(src)

    before = count_live_text(src)
    # Text form nằm trong widget → content stream trang gần như rỗng.
    assert 1 in before["annot_text_pages"], "phải phát hiện annotation mang text trước flatten"

    flattened = flatten_annotations_and_forms(src, out)
    assert flattened >= 1, "phải flatten được ít nhất 1 trang"

    after = count_live_text(out)
    assert after["content_chars"] > 0, "text form phải được bake vào content stream sau flatten"
    assert after["annot_text_pages"] == [], "annotation mang text phải bị gỡ sau flatten"


def test_detect_unembedded_fonts_flags_fake_font(tmp_path):
    src = str(tmp_path / "unembedded.pdf")
    _make_unembedded_font_pdf(src)
    fonts = detect_unembedded_fonts(src)
    assert any("FakeFontQA" in f for f in fonts), f"phải phát hiện font chưa nhúng, got {fonts}"


def test_detect_unembedded_ignores_base14(tmp_path):
    """Base-14 (Helvetica) không cần nhúng → không bị flag."""
    src = str(tmp_path / "form.pdf")
    _make_form_field_pdf(src)  # chỉ dùng Helvetica base-14
    fonts = detect_unembedded_fonts(src)
    assert not any("Helvetica" in f for f in fonts), f"base-14 không được flag, got {fonts}"


def test_detect_unembedded_fonts_inside_form_xobject(tmp_path):
    """OUT-FONT (audit 2026-07-27 §4.3): phải quét font trong Form lồng."""
    page_level = str(tmp_path / "page_font.pdf")
    nested = str(tmp_path / "form_font.pdf")
    _make_unembedded_font_pdf(page_level)

    with pikepdf.open(page_level) as pdf:
        page = pdf.pages[0]
        fonts = page.Resources.Font
        content = bytes(page.Contents.read_bytes())
        form = pdf.make_stream(content)
        form["/Type"] = pikepdf.Name("/XObject")
        form["/Subtype"] = pikepdf.Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 612, 792])
        form["/Resources"] = pikepdf.Dictionary(Font=fonts)
        page["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm=pdf.make_indirect(form))
        )
        page["/Contents"] = pdf.make_stream(b"q /Fm Do Q")
        pdf.save(nested)

    fonts = detect_unembedded_fonts(nested)
    assert any("FakeFontQA" in name for name in fonts), fonts



def test_detect_unembedded_fonts_invalid_pdf_fails_closed(tmp_path):
    """Không đọc được file không được hiểu nhầm thành 'không thiếu font'."""
    missing = str(tmp_path / "khong-ton-tai.pdf")
    with pytest.raises(RuntimeError, match="không mở được PDF"):
        detect_unembedded_fonts(missing)

def test_count_live_text_empty_pdf(tmp_path):
    src = str(tmp_path / "blank.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)
    pdf.close()
    result = count_live_text(src)
    assert result["content_chars"] == 0
    assert result["annot_text_pages"] == []
    assert result["total"] == 0


@pytest.mark.asyncio
async def test_outline_pipeline_refuses_base14_without_glyph_data(tmp_path):
    """Base-14 hiển thị được nhưng không có glyph nhúng để dựng path an toàn."""
    from app.core.action_engine import ActionEngine

    src = str(tmp_path / "form.pdf")
    _make_form_field_pdf(src)

    engine = ActionEngine()
    result = await engine.execute(src, "OUTLINE_FONTS")

    # GS-SUNSET (audit 2026-08-08 §GS.2): không skip theo môi trường. Fixture
    # chỉ có Helvetica base-14 nên engine phải từ chối thay vì mượn glyph khác.
    assert result.success is False
    assert result.output_path is None
    assert result.log[0].status == "refused"
    assert result.log[0].engine == "none"
    assert "dừng an toàn" in (result.error or "")


@pytest.mark.asyncio
async def test_outline_pipeline_embeds_before_outline(tmp_path):
    """PDF có font chưa nhúng → pipeline chạy bước embed trước outline. Font giả
    không có trong hệ thống phải làm tác vụ dừng, không outline bằng font thay thế."""
    from app.core.action_engine import ActionEngine

    src = str(tmp_path / "unembedded.pdf")
    _make_unembedded_font_pdf(src)

    engine = ActionEngine()
    result = await engine.execute(src, "OUTLINE_FONTS")

    # OUT-FONT (audit 2026-07-27 §4.3): không giao output dùng font thay thế.
    assert result.success is False
    assert result.output_path is None
    joined = " ".join(entry.message for entry in result.log)
    assert "font" in joined.lower(), f"phải cảnh báo về font, got: {joined}"


@pytest.mark.asyncio
async def test_outline_pipeline_skip_embed_fails_closed(tmp_path):
    """skip_embed không được biến font chưa nhúng thành một success không an toàn."""
    from app.core.action_engine import ActionEngine

    src = str(tmp_path / "unembedded.pdf")
    _make_unembedded_font_pdf(src)

    engine = ActionEngine()
    result = await engine.execute(src, "OUTLINE_FONTS", {"skip_embed": True})

    assert result.success is False
    assert result.output_path is None
    joined = " ".join(entry.message for entry in result.log)
    assert "chưa nhúng" in joined.lower() or "font" in joined.lower(), (
        f"skip_embed phải cảnh báo font chưa nhúng, got: {joined}"
    )
