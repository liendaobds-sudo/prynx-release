"""Prynx phải chạy được KHI KHÔNG CÓ Ghostscript.

Đây là phép thử quyết định của cả kế hoạch thay GS: không phải "đã viết bao
nhiêu đường non-GS" mà là "gỡ Ghostscript ra thì còn gì gãy". Mọi thứ khác chỉ
là ước lượng; cái này là câu trả lời.

Cách làm: chạy thẳng các đường sản xuất nội bộ trên PDF thật. Tripwire toàn cục
ở `test_gs_usage_telemetry.py` sẽ chặn nếu một đường nào cố tạo tiến trình
Ghostscript; file này tập trung kiểm chứng chất lượng đầu ra native/PPE.
"""

import asyncio
import hashlib
import os
import zlib
from pathlib import Path

import pikepdf
import pytest

from app.config import settings


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


@pytest.fixture
def mixed_page_transparency_pdf(tmp_path):
    """Ba trang CMYK: trang 1 vector đục, trang 2–3 dùng alpha thật."""
    pdf = pikepdf.Pdf.new()
    for page_number in range(1, 4):
        page = pdf.add_blank_page(page_size=(200, 200))
        resources = pikepdf.Dictionary()
        content = b"0 0 0 1 k 10 10 80 80 re f\n"
        if page_number > 1:
            gs = pikepdf.Dictionary(
                Type=pikepdf.Name("/ExtGState"),
                ca=0.5,
                CA=0.5,
            )
            resources[pikepdf.Name("/ExtGState")] = pikepdf.Dictionary(
                GS0=pdf.make_indirect(gs)
            )
            content = b"q /GS0 gs 0 0 0 1 k 10 10 80 80 re f Q\n"
        page[pikepdf.Name("/TrimBox")] = pikepdf.Array([5, 5, 195, 195])
        page[pikepdf.Name("/Resources")] = resources
        page[pikepdf.Name("/Contents")] = pdf.make_indirect(
            pikepdf.Stream(pdf, content)
        )
    path = tmp_path / "mixed_transparency.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def test_separations_ink_accurate_without_gs(sample_pdf):
    """Tách kẽm đo mực — đường mà TAC sản xuất dùng."""
    from app.core.separations import SeparationEngine

    result = asyncio.run(
        SeparationEngine().extract_separations(sample_pdf, 1, 100, ink_accurate=True)
    )
    assert result.get("plates"), "không tách được kẽm nào"
    assert result.get("engine") == "ppe", result.get("engine")
    assert str(result.get("accuracy", "")).startswith("rip_separations")


def test_softproof_without_gs(sample_pdf):
    """Font base-14 không nhúng phải hạ nhãn, nhưng vẫn có ảnh xem và không gọi GS."""
    from app.core.softproof import SoftProofEngine

    result = asyncio.run(SoftProofEngine().render_softproof(sample_pdf, 1, "fogra39"))
    assert result.get("success") and result.get("softproof_b64"), result.get("warning")
    # COLOR (audit 2026-08-08 §RENDER.4): fixture cố ý dùng Helvetica base-14
    # không nhúng. PPE thay font nên màu mực vẫn có ích nhưng hình học không còn
    # đủ điều kiện gắn CMYK✓; đường no-GS phải giữ ảnh gần đúng và nói thật.
    assert result.get("engine") == "pdfium+lcms", result.get("engine")
    assert result.get("accuracy") == "approximate", result.get("accuracy")
    assert result.get("ppe_degraded") is True
    assert result.get("ppe_ink_unsound") is False
    assert result.get("warning")


def test_overprint_preview_without_gs(sample_pdf, monkeypatch):
    """Endpoint live phải dùng PPE thật, không còn nhánh GS-only bị bỏ sót."""
    from app.api.routes import preflight as preflight_routes

    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: sample_pdf)
    result = asyncio.run(
        preflight_routes.render_overprint_preview(
            preflight_routes.OverprintPreviewRequest(file_id="fixture", page=1, dpi=36)
        )
    )
    assert result.get("success"), result.get("error")
    assert result.get("engine") == "ppe"


def test_preflight_full_run_without_gs(sample_pdf):
    """Preflight là đường chạy nhiều nhất — nó mà cần GS thì mọi thứ khác vô nghĩa."""
    from app.core.preflight_engine import PreflightEngine

    report = PreflightEngine().run(sample_pdf)
    assert report is not None


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
def test_action_without_gs(sample_pdf, action):
    from app.core.action_engine import ActionEngine

    engine = ActionEngine()
    result = asyncio.run(engine.execute(sample_pdf, action))
    assert result.success, f"{action}: {result.error}"


def test_pdfx4_export_without_gs(sample_pdf):
    """Xuất PDF/X-4 không cần Ghostscript, và file ra phải ĐẠT chuẩn thật."""
    from app.core.pdfx_export import PdfxExportEngine

    engine = PdfxExportEngine()
    out = asyncio.run(engine.export_pdfx(sample_pdf, "x4"))
    try:
        assert engine.last_engine == "pikepdf"
        report = engine.check_compliance(out, "x4")
        assert report["passed"], [c for c in report["checks"] if not c["passed"]]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_no_gs_product_refuses_action_without_calling_legacy_runner(
    sample_pdf, monkeypatch
):
    """File ngoài phạm vi phải thành REFUSED, không giả thành thiếu GS."""
    from app.core import pdf_actions_native
    from app.core.action_engine import ActionEngine
    monkeypatch.setattr(
        pdf_actions_native,
        "analyze_font_embedding",
        lambda _path: {
            "readable": True,
            "missing": ["FontThieu"],
            "embedded": [],
            "base14": [],
            "warnings": [],
        },
    )
    engine = ActionEngine()
    result = asyncio.run(engine.execute(sample_pdf, "EMBED_FONTS"))

    assert result.success is False
    assert result.log and result.log[0].status == "refused"
    assert result.log[0].engine == "none"
    assert "dừng an toàn" in (result.error or "")
    assert "Ghostscript" not in (result.error or "")


def test_no_gs_product_refuses_pdfx_without_calling_legacy_runner(
    sample_pdf, monkeypatch
):
    """PDF/X native không làm được thì ném giới hạn sản phẩm, không chạy GS."""
    from app.core.engine_support import InternalEngineUnsupported
    from app.core.pdfx_export import PdfxExportEngine

    engine = PdfxExportEngine()
    monkeypatch.setattr(engine, "_export_x4_native", lambda *_a, **_k: False)

    with pytest.raises(InternalEngineUnsupported) as exc:
        asyncio.run(engine.export_pdfx(sample_pdf, "x4"))

    assert "dừng an toàn" in str(exc.value)
    assert "Ghostscript" not in str(exc.value)
    assert engine.last_engine == "none"


def test_pdfx4_warns_when_it_sets_trimbox_itself(tmp_path):
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
    out = asyncio.run(engine.export_pdfx(str(src), "x4"))
    try:
        assert engine.last_warnings, "đặt TrimBox hộ mà không cảnh báo"
        assert any("TrimBox" in w and "bleed" in w for w in engine.last_warnings)
        assert engine.check_compliance(out, "x4")["passed"]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_flatten_is_a_noop_when_there_is_no_transparency(tmp_path):
    """Không có gì trong suốt thì đừng đụng vào file.

    Đây là ca phổ biến nhất — người dùng bấm nút phòng xa. Ghostscript vẫn dựng
    lại cả tài liệu (và hạ PDF 1.3, gộp/mất OCG) để thu về đúng thứ đang có.
    """
    import pikepdf

    from app.core import pdf_actions_native
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

    engine = ActionEngine()
    result = asyncio.run(engine.execute(str(src), "FLATTEN_TRANSPARENCY"))
    assert result.success
    assert result.log[0].report["pages_rasterized"] == 0, "đã raster hoá dù không cần"


def test_flatten_removes_transparency_and_says_what_it_cost(sample_pdf):
    """Có trong suốt → raster hoá, và PHẢI nói rõ mất vector.

    `sample_pdf` có ảnh + spot CutContour. Raster hoá làm mất vector và gộp spot
    vào CMYK — cả hai đều nghiêm trọng với tem bế, nên im lặng là không chấp
    nhận được.
    """
    import pikepdf

    from app.core import pdf_actions_native
    from app.core.action_engine import ActionEngine

    # Thêm trong suốt vào file mẫu.
    with pikepdf.open(sample_pdf, allow_overwriting_input=True) as pdf:
        gs = pikepdf.Dictionary(Type=pikepdf.Name("/ExtGState"), ca=0.5, CA=0.5)
        pdf.pages[0].Resources["/ExtGState"] = pikepdf.Dictionary(
            GS0=pdf.make_indirect(gs)
        )
        pdf.save(sample_pdf)

    assert pdf_actions_native.detect_transparency(sample_pdf)

    engine = ActionEngine()
    result = asyncio.run(engine.execute(sample_pdf, "FLATTEN_TRANSPARENCY"))
    assert result.success
    assert result.log[0].engine == "ppe"

    warnings = result.log[0].report["warnings"]
    assert any("MẤT VECTOR" in w for w in warnings), warnings
    assert any("Spot" in w for w in warnings), "gộp spot mà không cảnh báo"
    assert pdf_actions_native.detect_transparency(result.output_path) == []


def test_flatten_only_rasterizes_pages_that_use_transparency(
    mixed_page_transparency_pdf, tmp_path
):
    """Trang đục phải giữ vector khi trang khác trong cùng file có transparency."""
    from app.core import pdf_actions_native

    source = Path(mixed_page_transparency_pdf)
    output = tmp_path / "mixed_flattened.pdf"
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    assert pdf_actions_native.detect_transparent_pages(str(source)) == [2, 3]
    result = pdf_actions_native.flatten_transparency(
        str(source), str(output), dpi=72
    )

    # CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.2): raster theo trang, không
    # theo cờ cấp tài liệu; source và trang vector sạch phải được bảo toàn.
    assert result["supported"] is True
    assert result["flattened"] == 2
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert pdf_actions_native.detect_transparent_pages(str(output)) == []

    with pikepdf.open(output) as pdf:
        assert len(pdf.pages) == 3
        opaque_content = bytes(pdf.pages[0].Contents.read_bytes())
        assert b" re f" in opaque_content
        assert b"/FlatIm Do" not in opaque_content
        for page in pdf.pages[1:]:
            assert b"/FlatIm Do" in bytes(page.Contents.read_bytes())


def test_pdfx1a_export_without_gs(sample_pdf):
    """X-1a có transparency phải thật sự đi PPE rồi ra PDF 1.3 sạch alpha."""
    import pikepdf

    from app.core import pdf_actions_native
    from app.core.pdfx_export import PdfxExportEngine

    # PPE-SCOPE (audit 2026-08-10 §PPE.SCOPE.3): test cũ chỉ dùng file opaque nên
    # nhánh X-1a đạt mà chưa hề chạm PPE. Gắn ExtGState ĐƯỢC DÙNG THẬT để khóa
    # detect → flatten 300 DPI → writer PDF/X trong cùng một phép thử.
    with pikepdf.open(sample_pdf, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0]
        gs = pikepdf.Dictionary(Type=pikepdf.Name("/ExtGState"), ca=0.5, CA=0.5)
        page.Resources["/ExtGState"] = pikepdf.Dictionary(
            GS0=pdf.make_indirect(gs)
        )
        old_content = bytes(page.Contents.read_bytes())
        page.Contents = pdf.make_indirect(
            pikepdf.Stream(
                pdf,
                b"q /GS0 gs 0 0 0 1 k 10 10 50 50 re f Q\n" + old_content,
            )
        )
        pdf.save(sample_pdf)

    assert pdf_actions_native.detect_transparency(sample_pdf)

    engine = PdfxExportEngine()
    out = asyncio.run(engine.export_pdfx(sample_pdf, "x1a"))
    try:
        assert engine.last_engine == "pikepdf"
        with pikepdf.open(out) as pdf:
            assert pdf.pdf_version <= "1.4", f"X-1a đòi ≤1.4, có {pdf.pdf_version}"
            assert "PDF/X" in str(pdf.docinfo.get("/GTS_PDFXVersion", ""))
        assert pdf_actions_native.detect_transparency(out) == []
        compliance = engine.check_compliance(out, "x1a")
        assert compliance["passed"]
        assert compliance["passed_checks"] == compliance["total_checks"] == 7
        assert any("raster hoá 1 trang" in warning for warning in engine.last_warnings)
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_pdfx1a_mixed_pages_preserves_opaque_vector_page(
    mixed_page_transparency_pdf
):
    """X-1a chỉ được raster hai trang alpha, không phá trang vector đục."""
    from app.core import pdf_actions_native
    from app.core.pdfx_export import PdfxExportEngine

    source = Path(mixed_page_transparency_pdf)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    engine = PdfxExportEngine()
    output = asyncio.run(engine.export_pdfx(str(source), "x1a"))
    try:
        assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
        assert any("raster hoá 2 trang" in warning for warning in engine.last_warnings)
        assert pdf_actions_native.detect_transparent_pages(output) == []
        with pikepdf.open(output) as pdf:
            assert len(pdf.pages) == 3
            assert pdf.pdf_version <= "1.4"
            opaque_content = bytes(pdf.pages[0].Contents.read_bytes())
            assert b" re f" in opaque_content
            assert b"/FlatIm Do" not in opaque_content
            for page in pdf.pages[1:]:
                assert b"/FlatIm Do" in bytes(page.Contents.read_bytes())
        compliance = engine.check_compliance(output, "x1a")
        assert compliance["passed"], [
            check for check in compliance["checks"] if not check["passed"]
        ]
    finally:
        if os.path.isfile(output):
            os.remove(output)


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


def test_spot_to_cmyk_without_gs(sample_pdf):
    from app.core.ink_manager import InkManagerEngine

    manager = InkManagerEngine()
    out = asyncio.run(manager.convert_spot_to_cmyk(sample_pdf, None))
    assert os.path.isfile(out)


def test_spot_to_cmyk_unsupported_fails_closed_and_cleans_output(
    tmp_path, sample_pdf, monkeypatch
):
    """Engine nội bộ từ chối phải trả giới hạn nghiệp vụ, không hướng cài engine ngoài."""
    from app.core import pdf_actions_native
    from app.core.engine_support import InternalEngineUnsupported
    from app.core.ink_manager import InkManagerEngine

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))

    def unsupported(_source, output, *_args):
        from pathlib import Path

        Path(output).write_bytes(b"partial")
        return {"supported": False, "blockers": ["shading RGB chưa hỗ trợ"]}

    monkeypatch.setattr(pdf_actions_native, "convert_spot_to_cmyk", unsupported)
    manager = InkManagerEngine()

    with pytest.raises(InternalEngineUnsupported) as exc_info:
        asyncio.run(manager.convert_spot_to_cmyk(sample_pdf, None))

    assert "PrynX Print Engine" in str(exc_info.value)
    assert "Ghostscript" not in str(exc_info.value)
    assert not list((tmp_path / "preflight_output").glob("*_cmyk_*.pdf"))


def test_convert_colors_paths_work_without_gs(sample_pdf, tmp_path):
    """Route /preflight/convert-colors từng gọi Ghostscript THẲNG, không fallback.

    Đây là điểm bị bỏ sót khi kiểm kê §2 vì nó nằm trong file route chứ không
    phải module core — thiếu GS là hỏng hẳn chức năng "Chuyển hệ màu".
    """
    from app.core import icc_profiles, pdf_actions_native

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


def test_convert_colors_unsupported_fails_closed_and_removes_partial(
    tmp_path, sample_pdf, monkeypatch
):
    """Route không được để lại file nửa hoàn tất khi conversion chưa hỗ trợ."""
    from pathlib import Path

    from app.api.routes import preflight as preflight_routes
    from app.core import pdf_actions_native

    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: sample_pdf)

    def unsupported(_source, output, *_args):
        Path(output).write_bytes(b"partial")
        return {"supported": False, "blockers": ["mesh shading"]}

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", unsupported)
    req = preflight_routes.ConvertColorsRequest(
        file_id="fixture",
        conversions=["rgb_to_cmyk"],
        preserve_black=True,
    )

    result = asyncio.run(preflight_routes.convert_colors(req))

    assert result["success"] is False
    assert result["output_filename"] is None
    assert result["log"][0]["status"] == "error"
    assert "PrynX Print Engine" in result["log"][0]["message"]
    assert "Ghostscript" not in result["log"][0]["message"]
    assert not list((tmp_path / "preflight_output").glob("cc_*.pdf"))


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


def test_optimize_pdf_without_gs(sample_pdf, tmp_path):
    """Route /pdf-tools/optimize cũng từng gọi Ghostscript thẳng.

    Nó có người dùng thật (OptimizeTool + recipe runner), nên thiếu GS là mất
    một nút trên UI.
    """
    from app.core import pdf_actions_native

    out = str(tmp_path / "opt.pdf")
    result = pdf_actions_native.optimize_pdf(sample_pdf, out, "ebook")

    assert result["supported"], result["warnings"]
    assert os.path.isfile(out) and os.path.getsize(out) > 0


def test_optimize_unsupported_is_422_and_cleans_files(tmp_path, monkeypatch):
    """File không hỗ trợ là 422 có chủ đích, không phải lỗi subprocess/HTTP 500."""
    from io import BytesIO
    from pathlib import Path

    from fastapi import HTTPException, UploadFile

    from app.api.routes import pdf_tools as pdf_tools_routes
    from app.core import pdf_actions_native

    source = tmp_path / "uploaded.pdf"
    source.write_bytes(b"%PDF-partial")
    results = tmp_path / "results"
    results.mkdir()
    monkeypatch.setattr(pdf_tools_routes, "RESULTS_DIR", str(results))

    async def fake_save_upload(_file):
        return str(source)

    def unsupported(_source, output, *_args):
        Path(output).write_bytes(b"partial")
        return {"supported": False, "warnings": ["filter ảnh chưa hỗ trợ"]}

    monkeypatch.setattr(pdf_tools_routes, "save_upload", fake_save_upload)
    monkeypatch.setattr(pdf_actions_native, "optimize_pdf", unsupported)
    upload = UploadFile(filename="fixture.pdf", file=BytesIO(b"%PDF"))

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            pdf_tools_routes.optimize_pdf_endpoint(
                file=upload,
                preset="ebook",
                image_dpi=300,
                strip_metadata="true",
                grayscale="false",
                license_info={},
            )
        )

    assert exc_info.value.status_code == 422
    assert "PrynX Print Engine" in str(exc_info.value.detail)
    assert "Ghostscript" not in str(exc_info.value.detail)
    assert not source.exists()
    assert not list(results.glob("optimized_*.pdf"))


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
