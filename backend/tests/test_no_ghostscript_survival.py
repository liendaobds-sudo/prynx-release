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
    assert result.get("engine") == "ppe", result.get("engine")
    assert str(result.get("accuracy", "")).startswith("rip_separations")
    assert _gs_calls() == 0


def test_softproof_without_gs(no_ghostscript, sample_pdf):
    from app.core import gs_usage
    from app.core.softproof import SoftProofEngine

    gs_usage.reset_for_tests()
    result = asyncio.run(SoftProofEngine().render_softproof(sample_pdf, 1, "fogra39"))
    assert result.get("success") and result.get("softproof_b64"), result.get("warning")
    assert result.get("engine") == "ppe+lcms", result.get("engine")
    assert result.get("accuracy") == "rip_softproof", result.get("accuracy")
    assert _gs_calls() == 0


def test_overprint_preview_without_gs(no_ghostscript, sample_pdf, monkeypatch):
    """Endpoint live phải dùng PPE thật, không còn nhánh GS-only bị bỏ sót."""
    from app.api.routes import preflight as preflight_routes
    from app.core import gs_usage

    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: sample_pdf)
    gs_usage.reset_for_tests()
    result = asyncio.run(
        preflight_routes.render_overprint_preview(
            preflight_routes.OverprintPreviewRequest(file_id="fixture", page=1, dpi=36)
        )
    )
    assert result.get("success"), result.get("error")
    assert result.get("engine") == "ppe"
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
        "FLATTEN_TRANSPARENCY",
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


def test_flatten_is_a_noop_when_there_is_no_transparency(no_ghostscript, tmp_path):
    """Không có gì trong suốt thì đừng đụng vào file.

    Đây là ca phổ biến nhất — người dùng bấm nút phòng xa. Ghostscript vẫn dựng
    lại cả tài liệu (và hạ PDF 1.3, gộp/mất OCG) để thu về đúng thứ đang có.
    """
    import pikepdf

    from app.core import gs_usage, pdf_actions_native
    from app.core.action_engine import ActionEngine

    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 100, 100],
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"0 0 0 1 k 5 5 50 50 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "opaque.pdf"
    pdf.save(str(src))
    pdf.close()

    assert pdf_actions_native.detect_transparency(str(src)) == []

    gs_usage.reset_for_tests()
    engine = ActionEngine()
    engine.gs_path = no_ghostscript
    result = asyncio.run(engine.execute(str(src), "FLATTEN_TRANSPARENCY"))
    assert result.success
    assert result.log[0].report["pages_rasterized"] == 0, "đã raster hoá dù không cần"
    assert _gs_calls() == 0


def test_flatten_removes_transparency_and_says_what_it_cost(no_ghostscript, sample_pdf):
    """Có trong suốt → raster hoá, và PHẢI nói rõ mất vector.

    `sample_pdf` có ảnh + spot CutContour. Raster hoá làm mất vector và gộp spot
    vào CMYK — cả hai đều nghiêm trọng với tem bế, nên im lặng là không chấp
    nhận được.
    """
    import pikepdf

    from app.core import gs_usage, pdf_actions_native
    from app.core.action_engine import ActionEngine

    # Thêm trong suốt vào file mẫu.
    with pikepdf.open(sample_pdf, allow_overwriting_input=True) as pdf:
        gs = pikepdf.Dictionary(Type=pikepdf.Name("/ExtGState"), ca=0.5, CA=0.5)
        pdf.pages[0].Resources["/ExtGState"] = pikepdf.Dictionary(
            GS0=pdf.make_indirect(gs)
        )
        pdf.save(sample_pdf)

    assert pdf_actions_native.detect_transparency(sample_pdf)

    gs_usage.reset_for_tests()
    engine = ActionEngine()
    engine.gs_path = no_ghostscript
    result = asyncio.run(engine.execute(sample_pdf, "FLATTEN_TRANSPARENCY"))
    assert result.success
    assert result.log[0].engine == "ppe"
    assert _gs_calls() == 0

    warnings = result.log[0].report["warnings"]
    assert any("MẤT VECTOR" in w for w in warnings), warnings
    assert any("Spot" in w for w in warnings), "gộp spot mà không cảnh báo"
    assert pdf_actions_native.detect_transparency(result.output_path) == []


def test_pdfx1a_export_without_gs(no_ghostscript, sample_pdf):
    """X-1a phải ra PDF 1.3 — chính phiên bản đó mới bảo đảm hết trong suốt."""
    import pikepdf

    from app.core import gs_usage
    from app.core.pdfx_export import PdfxExportEngine

    gs_usage.reset_for_tests()
    engine = PdfxExportEngine()
    engine.gs_path = no_ghostscript
    out = asyncio.run(engine.export_pdfx(sample_pdf, "x1a"))
    try:
        assert engine.last_engine == "pikepdf"
        assert _gs_calls() == 0
        with pikepdf.open(out) as pdf:
            assert pdf.pdf_version <= "1.4", f"X-1a đòi ≤1.4, có {pdf.pdf_version}"
            assert "PDF/X" in str(pdf.docinfo.get("/GTS_PDFXVersion", ""))
        assert engine.check_compliance(out, "x1a")["passed"]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_font_analysis_does_not_report_unreadable_file_as_complete(tmp_path):
    """Không đọc được file KHÁC không thiếu font.

    Gộp hai thứ đó thì `missing == []` trên một file hỏng sẽ được hiểu là "đủ
    font", và bước nhúng bị bỏ qua đúng lúc cần nhất.
    """
    from app.core import pdf_actions_native

    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"khong phai PDF")

    info = pdf_actions_native.analyze_font_embedding(str(broken))
    assert info["readable"] is False
    assert info["missing"] == []


def test_spot_to_cmyk_without_gs(no_ghostscript, sample_pdf):
    from app.core import gs_usage
    from app.core.ink_manager import InkManagerEngine

    gs_usage.reset_for_tests()
    manager = InkManagerEngine()
    manager.gs_path = no_ghostscript
    out = asyncio.run(manager.convert_spot_to_cmyk(sample_pdf, None))
    assert os.path.isfile(out)
    assert _gs_calls() == 0


def test_convert_colors_paths_work_without_gs(no_ghostscript, sample_pdf, tmp_path):
    """Route /preflight/convert-colors từng gọi Ghostscript THẲNG, không fallback.

    Đây là điểm bị bỏ sót khi kiểm kê §2 vì nó nằm trong file route chứ không
    phải module core — thiếu GS là hỏng hẳn chức năng "Chuyển hệ màu".
    """
    from app.core import gs_usage, icc_profiles, pdf_actions_native

    gs_usage.reset_for_tests()

    cmyk_out = str(tmp_path / "cc_cmyk.pdf")
    res = pdf_actions_native.convert_to_cmyk(
        sample_pdf, cmyk_out,
        icc_profiles.resolve_cmyk_profile_path(),
        icc_profiles.resolve_srgb_profile_path(),
    )
    assert res["supported"], res["blockers"]
    assert os.path.isfile(cmyk_out)

    gray_out = str(tmp_path / "cc_gray.pdf")
    res = pdf_actions_native.convert_to_grayscale(sample_pdf, gray_out)
    assert res["supported"], res["blockers"]
    assert os.path.isfile(gray_out)
    assert _gs_calls() == 0


def test_grayscale_keeps_spot_channels_alive(sample_pdf, tmp_path):
    """Chuyển sang đen trắng KHÔNG được nuốt kênh pha.

    Nút "đen trắng" hứa đổi màu process, không hứa xoá kênh bế / Pantone — gộp
    chúng vào xám là mất hẳn khả năng in bằng mực pha.
    """
    import pikepdf

    from app.core import pdf_actions_native

    out = str(tmp_path / "gray.pdf")
    result = pdf_actions_native.convert_to_grayscale(sample_pdf, out)
    assert result["supported"]

    with pikepdf.open(out) as pdf:
        data = bytes(pdf.pages[0].Contents.read_bytes())
        cs = pdf.pages[0].Resources.ColorSpace.CS0
        assert str(cs[0]) == "/Separation"
        assert str(cs[1]) == "/CutContour"
    assert b"/CS0 cs" in data and b"1 scn" in data, "lệnh tô spot bị viết lại"
    assert b" rg" not in data and b" k\n" not in data, "còn toán tử màu process"


def test_optimize_pdf_without_gs(no_ghostscript, sample_pdf, tmp_path):
    """Route /pdf-tools/optimize cũng từng gọi Ghostscript thẳng.

    Nó có người dùng thật (OptimizeTool + recipe runner), nên thiếu GS là mất
    một nút trên UI.
    """
    from app.core import gs_usage, pdf_actions_native

    gs_usage.reset_for_tests()
    out = str(tmp_path / "opt.pdf")
    result = pdf_actions_native.optimize_pdf(sample_pdf, out, "ebook")

    assert result["supported"], result["warnings"]
    assert os.path.isfile(out) and os.path.getsize(out) > 0
    assert _gs_calls() == 0


def test_optimize_never_returns_a_bigger_file(tmp_path):
    """Bấm "tối ưu" mà nhận file NẶNG hơn là phản tác dụng.

    File đã nén tốt sẵn thì mọi phép ghi lại đều có thể phình ra; khi đó phải
    giữ bản gốc chứ không giao bản to hơn.
    """
    import pikepdf

    from app.core import pdf_actions_native

    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"), MediaBox=[0, 0, 50, 50],
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"0 0 0 1 k 1 1 10 10 re f\n")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    src = tmp_path / "tiny.pdf"
    pdf.save(str(src))
    pdf.close()

    out = str(tmp_path / "tiny_opt.pdf")
    result = pdf_actions_native.optimize_pdf(str(src), out, "ebook")
    assert result["supported"]
    assert os.path.getsize(out) <= os.path.getsize(str(src))
