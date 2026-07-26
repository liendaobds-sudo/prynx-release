"""Prynx phải chạy được KHI KHÔNG CÓ Ghostscript.

Đây là phép thử quyết định của cả kế hoạch thay GS: không phải "đã viết bao
nhiêu đường non-GS" mà là "gỡ Ghostscript ra thì còn gì gãy". Mọi thứ khác chỉ
là ước lượng; cái này là câu trả lời.

Cách làm: trỏ `GHOSTSCRIPT_PATH` vào đường dẫn không tồn tại rồi chạy các đường
sản xuất trên PDF thật. Đường nào ngã thì đó chính là việc còn lại — và test
này ở lại repo để việc đó không lặng lẽ quay về.
"""

import asyncio
import os
import zlib

import pikepdf
import pytest

from app.config import settings


@pytest.fixture
def no_ghostscript(tmp_path, monkeypatch):
    """Ghostscript biến mất khỏi hệ thống."""
    missing = str(tmp_path / "khong-co-ghostscript.exe")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", missing)
    monkeypatch.setenv("GHOSTSCRIPT_PATH", missing)
    return missing


@pytest.fixture
def sample_pdf(tmp_path):
    """Trang CMYK + RGB + ảnh + spot + font base-14 — đủ chạm mọi đường màu."""
    pdf = pikepdf.Pdf.new()
    w = h = 64
    raw = bytes(((x * 5 + y * 3) % 256) for y in range(h) for x in range(w) for _ in range(3))
    img = pikepdf.Stream(
        pdf, zlib.compress(raw),
        Type=pikepdf.Name("/XObject"), Subtype=pikepdf.Name("/Image"),
        Width=w, Height=h, BitsPerComponent=8,
        ColorSpace=pikepdf.Name("/DeviceRGB"), Filter=pikepdf.Name("/FlateDecode"),
    )
    tint = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=[0, 0.91, 0.76, 0], N=1,
        Range=[0, 1, 0, 1, 0, 1, 0, 1],
    )
    sep = pikepdf.Array([
        pikepdf.Name("/Separation"), pikepdf.Name("/CutContour"),
        pikepdf.Name("/DeviceCMYK"), pdf.make_indirect(tint),
    ])
    font = pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"),
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],
        TrimBox=[5, 5, 195, 195],
        Resources=pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(img)),
            Font=pikepdf.Dictionary(F1=pdf.make_indirect(font)),
            ColorSpace=pikepdf.Dictionary(CS0=pdf.make_indirect(sep)),
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(
            pdf,
            b"q 100 0 0 100 20 20 cm /Im0 Do Q\n"
            b"0.2 0.4 0.6 0.1 k 0 0 40 40 re f\n"
            b"1 0 0 rg 45 0 40 40 re f\n"
            b"/CS0 cs 1 scn 90 0 40 40 re f\n"
            b"BT /F1 12 Tf 20 180 Td (Prynx) Tj ET\n",
        )),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    path = tmp_path / "sample.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _gs_calls():
    from app.core import gs_usage

    return gs_usage.summary()["total_gs_calls"]


def test_separations_ink_accurate_without_gs(no_ghostscript, sample_pdf):
    """Tách kẽm đo mực — đường mà TAC sản xuất dùng."""
    from app.core import gs_usage
    from app.core.separations import SeparationEngine

    gs_usage.reset_for_tests()
    result = asyncio.run(
        SeparationEngine().extract_separations(sample_pdf, 1, 100, ink_accurate=True)
    )
    assert result.get("plates"), "không tách được kẽm nào"
    assert _gs_calls() == 0


def test_softproof_without_gs(no_ghostscript, sample_pdf):
    from app.core import gs_usage
    from app.core.softproof import SoftProofEngine

    gs_usage.reset_for_tests()
    result = asyncio.run(SoftProofEngine().render_softproof(sample_pdf, 1, "fogra39"))
    assert result.get("success") and result.get("softproof_b64"), result.get("warning")
    assert _gs_calls() == 0


def test_preflight_full_run_without_gs(no_ghostscript, sample_pdf):
    """Preflight là đường chạy nhiều nhất — nó mà cần GS thì mọi thứ khác vô nghĩa."""
    from app.core import gs_usage
    from app.core.preflight_engine import PreflightEngine

    gs_usage.reset_for_tests()
    report = PreflightEngine().run(sample_pdf)
    assert report is not None
    assert _gs_calls() == 0


@pytest.mark.parametrize(
    "action",
    [
        "DOWNSCALE_IMAGES",
        "EMBED_FONTS",
        "CONVERT_TO_CMYK",
        "SET_BLACK_OVERPRINT",
        "FIX_METADATA",
        "FIX_HAIRLINES",
    ],
)
def test_action_without_gs(no_ghostscript, sample_pdf, action):
    from app.core import gs_usage
    from app.core.action_engine import ActionEngine

    gs_usage.reset_for_tests()
    engine = ActionEngine()
    engine.gs_path = no_ghostscript
    result = asyncio.run(engine.execute(sample_pdf, action))
    assert result.success, f"{action}: {result.error}"
    assert _gs_calls() == 0, f"{action} vẫn gọi Ghostscript"


def test_pdfx4_export_without_gs(no_ghostscript, sample_pdf):
    """Xuất PDF/X-4 không cần Ghostscript, và file ra phải ĐẠT chuẩn thật."""
    from app.core import gs_usage
    from app.core.pdfx_export import PdfxExportEngine

    gs_usage.reset_for_tests()
    engine = PdfxExportEngine()
    engine.gs_path = no_ghostscript
    out = asyncio.run(engine.export_pdfx(sample_pdf, "x4"))
    try:
        assert engine.last_engine == "pikepdf"
        assert _gs_calls() == 0
        report = engine.check_compliance(out, "x4")
        assert report["passed"], [c for c in report["checks"] if not c["passed"]]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_pdfx4_warns_when_it_sets_trimbox_itself(no_ghostscript, tmp_path):
    """Đặt TrimBox hộ người dùng thì PHẢI nói ra.

    TrimBox = khổ trang ngầm tuyên bố "trang này không có bleed". Với file thật
    sự có bleed thì đó là sai, và im lặng ở đây nghĩa là họ gửi nhà in một file
    sẽ bị xén vào phần bleed.
    """
    import pikepdf

    from app.core.pdfx_export import PdfxExportEngine

    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],  # cố ý KHÔNG có TrimBox
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"0 0 0 1 k 10 10 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "no_trim.pdf"
    pdf.save(str(src))
    pdf.close()

    engine = PdfxExportEngine()
    engine.gs_path = no_ghostscript
    out = asyncio.run(engine.export_pdfx(str(src), "x4"))
    try:
        assert engine.last_warnings, "đặt TrimBox hộ mà không cảnh báo"
        assert any("TrimBox" in w and "bleed" in w for w in engine.last_warnings)
        assert engine.check_compliance(out, "x4")["passed"]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_spot_to_cmyk_without_gs(no_ghostscript, sample_pdf):
    from app.core import gs_usage
    from app.core.ink_manager import InkManagerEngine

    gs_usage.reset_for_tests()
    manager = InkManagerEngine()
    manager.gs_path = no_ghostscript
    out = asyncio.run(manager.convert_spot_to_cmyk(sample_pdf, None))
    assert os.path.isfile(out)
    assert _gs_calls() == 0
