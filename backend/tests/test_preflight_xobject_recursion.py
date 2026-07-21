"""
Regression cho các điểm mù preflight đã sửa (audit 2026-07-20):

  B. Font Type0/CID nhúng đầy đủ KHÔNG bị báo sai "chưa nhúng".
  C. Font nằm trong Form XObject lồng ĐƯỢC quét (không chỉ page-level).
  D. Ảnh nằm trong Form XObject lồng ĐƯỢC quét.
  E. Ảnh RGB dạng [/ICCBased <stream N=3>] bị bắt là RGB.
  F. Transparency SMask / blend / ca<1 trong ExtGState bị bắt.
"""
import pikepdf

from app.core.preflight_engine import PreflightEngine


def _rule_ids(report, rid):
    return [i for i in report.issues if i.rule_id == rid]


def _make_embedded_type0(path: str) -> None:
    """PDF có 1 font Type0/CIDFontType2 nhúng ĐẦY ĐỦ (FontFile2 trong CIDFont)."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    fontfile = pikepdf.Stream(pdf, b"\x00" * 64)
    cidfont = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.CIDFontType2,
        BaseFont=pikepdf.Name("/EmbCID"),
        FontDescriptor=pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.FontDescriptor, FontName=pikepdf.Name("/EmbCID"),
            FontFile2=pdf.make_indirect(fontfile),
        )),
    )
    type0 = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type0,
        BaseFont=pikepdf.Name("/EmbCID"), Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([pdf.make_indirect(cidfont)]),
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F0=pdf.make_indirect(type0))
    )
    page.Contents = pdf.make_stream(b"BT /F0 12 Tf 10 10 Td <0001> Tj ET")
    pdf.save(path)
    pdf.close()


def _make_xobject_with_font_and_rgb_image(path: str) -> None:
    """Form XObject lồng chứa: 1 font TrueType KHÔNG nhúng + 1 ảnh RGB ICCBased."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))

    # Font chưa nhúng (không FontDescriptor/FontFile) đặt TRONG XObject.
    bad_font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.TrueType,
        BaseFont=pikepdf.Name("/GhostFontQA"),
    )
    # Ảnh RGB dạng ICCBased N=3 (str(cs) KHÔNG chứa "RGB").
    icc = pikepdf.Stream(pdf, b"\x00" * 16)
    icc.N = 3
    img = pikepdf.Stream(pdf, b"\xff" * (4 * 4 * 3))
    img.Type = pikepdf.Name.XObject
    img.Subtype = pikepdf.Name.Image
    img.Width = 4
    img.Height = 4
    img.BitsPerComponent = 8
    img.ColorSpace = pikepdf.Array([pikepdf.Name.ICCBased, pdf.make_indirect(icc)])

    form = pikepdf.Stream(pdf, b"q 10 0 0 10 0 0 cm /ImRGB Do Q BT /GhostFontQA 10 Tf ET")
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([0, 0, 400, 400])
    form.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(ImRGB=pdf.make_indirect(img)),
        Font=pikepdf.Dictionary(GhostFontQA=pdf.make_indirect(bad_font)),
    )

    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))
    )
    page.Contents = pdf.make_stream(b"/Fm0 Do")
    pdf.save(path)
    pdf.close()


def _make_transparency_smask(path: str) -> None:
    """Trang KHÔNG có /Group nhưng ExtGState có SMask + ca<1 → phải bị bắt."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    gs = pikepdf.Dictionary(
        Type=pikepdf.Name.ExtGState,
        ca=0.5,
        SMask=pikepdf.Dictionary(
            Type=pikepdf.Name.Mask, S=pikepdf.Name.Alpha,
        ),
    )
    page.Resources = pikepdf.Dictionary(
        ExtGState=pikepdf.Dictionary(GS0=pdf.make_indirect(gs))
    )
    page.Contents = pdf.make_stream(b"/GS0 gs 0 0 100 100 re f")
    pdf.save(path)
    pdf.close()


def test_type0_embedded_not_flagged(tmp_path):
    """B: font Type0 nhúng đầy đủ → 0 issue FONT_NOT_EMBEDDED."""
    src = str(tmp_path / "type0.pdf")
    _make_embedded_type0(src)
    report = PreflightEngine().run(src, rules=["FONT_NOT_EMBEDDED"])
    assert _rule_ids(report, "FONT_NOT_EMBEDDED") == []


def test_font_in_xobject_detected(tmp_path):
    """C: font chưa nhúng nằm trong Form XObject lồng → bị bắt."""
    src = str(tmp_path / "xobj.pdf")
    _make_xobject_with_font_and_rgb_image(src)
    report = PreflightEngine().run(src, rules=["FONT_NOT_EMBEDDED"])
    hits = _rule_ids(report, "FONT_NOT_EMBEDDED")
    assert any("GhostFontQA" in i.object_ref for i in hits), (
        f"phải bắt font chưa nhúng trong XObject, got {[i.object_ref for i in hits]}"
    )


def test_rgb_iccbased_image_in_xobject_detected(tmp_path):
    """D+E: ảnh RGB ICCBased trong Form XObject lồng → COLOR_RGB_DETECTED."""
    src = str(tmp_path / "xobj.pdf")
    _make_xobject_with_font_and_rgb_image(src)
    report = PreflightEngine().run(src, rules=["COLOR_RGB_DETECTED"])
    assert _rule_ids(report, "COLOR_RGB_DETECTED"), "phải bắt ảnh RGB ICCBased lồng XObject"


def test_transparency_smask_detected(tmp_path):
    """F: SMask + ca<1 trong ExtGState (không /Group) → TRANSPARENCY_DETECTED."""
    src = str(tmp_path / "smask.pdf")
    _make_transparency_smask(src)
    report = PreflightEngine().run(src, rules=["TRANSPARENCY_DETECTED"])
    assert _rule_ids(report, "TRANSPARENCY_DETECTED"), "phải bắt transparency qua SMask/ca"
