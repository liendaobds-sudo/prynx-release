"""OutputIntent của PDF/X phải khai đúng điều kiện in mà app đã kiểm.

Vì sao đáng một file test riêng: OutputIntent là lời khai gửi cho nhà in —
"file này đã được chuẩn bị cho điều kiện in X". Nếu nó khai một profile khác
với profile mà separations / soft-proof / TAC dùng để kiểm, thì mọi con số đã
đo trở nên vô nghĩa với người nhận, và sai lệch đó không hiện ra ở bất kỳ đâu
trong UI.
"""

import asyncio
import os

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.core.engine_support import InternalEngineUnsupported
from app.core.pdfx_export import PdfxExportEngine
from app.main import app
from app.schemas.preflight import ExportPdfxRequest


def test_output_intent_uses_app_cmyk_profile():
    """OutputIntent phải dùng đúng profile CMYK mà app dùng để đo.

    Một profile generic khác với profile đo sẽ khiến lời khai PDF/X không còn
    khớp với số liệu separations, soft-proof và TAC.
    """
    path, cond_id, cond_name = PdfxExportEngine()._resolve_output_intent_icc()

    assert path, "không tìm được ICC nào cho OutputIntent"
    assert os.path.isfile(path)
    normalized = path.replace("\\", "/").lower()
    assert "/assets/icc/" in normalized, (
        f"OutputIntent phải dùng ICC bundled của app, đang dùng: {path}"
    )
    assert "iccprofiles" not in normalized, (
        f"ICC đang lấy từ thư mục profile ngoài app: {path}"
    )
    assert cond_id and cond_name


def test_output_intent_matches_the_profile_used_for_measurement():
    """Cùng một profile với đường đo mực — nếu lệch, số đã kiểm nói về file khác."""
    from app.core import icc_profiles

    path, _cond_id, _cond_name = PdfxExportEngine()._resolve_output_intent_icc()
    assert os.path.normcase(path) == os.path.normcase(
        icc_profiles.resolve_cmyk_profile_path()
    )


# ── Định danh PDF/X-4 ───────────────────────────────────────────────────────

def _pdfx4_ready_pdf(path):
    """PDF tối giản đã đạt phần còn lại của X-4 (font nhúng, có TrimBox)."""
    import pikepdf

    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 200, 200],
        TrimBox=[5, 5, 195, 195],
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(
            pikepdf.Stream(pdf, b"0 0 0 1 k 10 10 100 100 re f\n")
        ),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(path))
    pdf.close()


def _live_alpha_rgb_pdf(path, *, page_count: int = 1, rgb_page: int = 1):
    """PDF có `rg` + ExtGState alpha sống, không cần page transparency group."""
    pdf = pikepdf.Pdf.new()
    for page_number in range(1, page_count + 1):
        page = pdf.add_blank_page(page_size=(200, 200))
        page.TrimBox = pikepdf.Array([5, 5, 195, 195])
        if page_number == rgb_page:
            gs = pikepdf.Dictionary(
                Type=pikepdf.Name("/ExtGState"),
                ca=0.5,
                CA=0.5,
                BM=pikepdf.Name("/Multiply"),
            )
            page.Resources = pikepdf.Dictionary(
                ExtGState=pikepdf.Dictionary(GS0=pdf.make_indirect(gs))
            )
            # Hai paint khiến lane vector-alpha cô lập không được tự mở.
            page.Contents = pdf.make_indirect(
                pikepdf.Stream(
                    pdf,
                    b"/GS0 gs 1 0 0 rg 10 10 80 80 re f "
                    b"0 1 0 rg 40 40 80 80 re f\n",
                )
            )
        else:
            page.Contents = pdf.make_indirect(
                pikepdf.Stream(pdf, b"0 0 0 1 k 10 10 80 80 re f\n")
            )
    pdf.save(str(path))
    pdf.close()


def test_pdfx4_identification_needs_xmp_and_version_16(tmp_path):
    """X-4 (ISO 15930-7) đòi PDF ≥1.6 và định danh trong XMP, không phải Info.

    Chỉ ghi `/GTS_PDFXVersion` vào Info là chưa đủ cho X-4. File khai sai chuẩn
    còn tệ hơn file không khai vì nhà in có thể tin nhầm lời khai đó.
    """
    src = tmp_path / "plain.pdf"
    _pdfx4_ready_pdf(src)

    report = PdfxExportEngine().check_compliance(str(src), "x4")
    ident = next(c for c in report["checks"] if c["id"] == "PDFX_IDENTIFICATION")
    assert ident["passed"] is False, "file chưa xuất mà đã báo có định danh X-4"
    assert "thiếu" in ident["detail"]


def test_pdfx4_export_produces_valid_identification(tmp_path):
    """Sau khi xuất: version ≥1.6, XMP có pdfxid:GTS_PDFXVersion, có OutputIntent."""
    import asyncio

    import pikepdf

    src = tmp_path / "plain2.pdf"
    _pdfx4_ready_pdf(src)

    engine = PdfxExportEngine()
    # GS-SUNSET (audit 2026-08-08 §GS.2): chạy thật đường pikepdf; không skip
    # theo một binary ngoài sản phẩm.
    out = asyncio.run(engine.export_pdfx(str(src), "x4"))
    try:
        with pikepdf.open(out) as pdf:
            assert pdf.pdf_version >= "1.6", f"X-4 đòi ≥1.6, có {pdf.pdf_version}"
            meta = pdf.open_metadata()
            key = "{http://www.npes.org/pdfx/ns/id/}GTS_PDFXVersion"
            assert meta.get(key) == "PDF/X-4", f"XMP thiếu định danh: {meta.get(key)!r}"
            assert pdf.Root.get("/OutputIntents") is not None

        report = engine.check_compliance(out, "x4")
        assert report["passed"], [c for c in report["checks"] if not c["passed"]]
    finally:
        if os.path.isfile(out):
            os.remove(out)


def test_pdfx1a_compliance_parses_rgb_operators_and_live_alpha(tmp_path):
    """`rg` + ExtGState không được báo nhầm CMYK-only/không transparency."""
    src = tmp_path / "live_alpha_rgb.pdf"
    _live_alpha_rgb_pdf(src)

    report = PdfxExportEngine().check_compliance(str(src), "x1a")
    checks = {item["id"]: item for item in report["checks"]}

    assert checks["CMYK_ONLY"]["passed"] is False
    assert "RESIDUAL_RGB" in checks["CMYK_ONLY"]["detail"]
    assert checks["NO_TRANSPARENCY"]["passed"] is False
    assert "alpha" in checks["NO_TRANSPARENCY"]["detail"]


def test_pdfx1a_compliance_scans_beyond_first_ten_pages(tmp_path):
    """RGB ở trang 11 vẫn phải làm `CMYK_ONLY` fail."""
    src = tmp_path / "rgb_on_page_11.pdf"
    _live_alpha_rgb_pdf(src, page_count=11, rgb_page=11)

    report = PdfxExportEngine().check_compliance(str(src), "x1a")
    check = next(item for item in report["checks"] if item["id"] == "CMYK_ONLY")
    assert check["passed"] is False
    assert "RESIDUAL_RGB" in check["detail"]


@pytest.mark.parametrize("standard", ["x3", "../evil", "", "X4"])
def test_pdfx_request_rejects_unknown_standard_before_handler(monkeypatch, standard):
    """Chuẩn lạ trả 422, không được resolve file hay ghép vào output path."""
    from app.api.routes import preflight as preflight_routes

    called = False

    def should_not_resolve(_file_id):
        nonlocal called
        called = True
        raise AssertionError("handler không được chạy với standard sai")

    monkeypatch.setattr(preflight_routes, "_get_file_path", should_not_resolve)
    client = TestClient(app)
    response = client.post(
        "/api/preflight/export-pdfx",
        json={"file_id": "not-used", "standard": standard},
    )

    assert response.status_code == 422, response.text
    assert called is False
    with pytest.raises(Exception):
        ExportPdfxRequest(file_id="not-used", standard=standard)


def test_pdfx_check_route_rejects_unknown_standard_before_file_lookup(monkeypatch):
    from app.api.routes import preflight as preflight_routes

    called = False

    def should_not_resolve(_file_id):
        nonlocal called
        called = True
        raise AssertionError("file lookup không được chạy")

    monkeypatch.setattr(preflight_routes, "_get_file_path", should_not_resolve)
    response = TestClient(app).get("/api/preflight/check-pdfx/not-used/x3")
    assert response.status_code == 422, response.text
    assert called is False


def test_pdfx_engine_rejects_unknown_standard_before_building_output(tmp_path):
    """Caller nội bộ cũng không được dùng giá trị lạ để tạo tên/path output."""
    src = tmp_path / "direct_invalid_standard.pdf"
    _pdfx4_ready_pdf(src)
    engine = PdfxExportEngine()
    before = {path.name for path in engine.output_dir.glob("*.pdf")}

    with pytest.raises(ValueError, match="x1a.*x4"):
        asyncio.run(engine.export_pdfx(str(src), "../evil"))
    with pytest.raises(ValueError, match="x1a.*x4"):
        engine.check_compliance(str(src), "x3")

    after = {path.name for path in engine.output_dir.glob("*.pdf")}
    assert after == before


def test_pdfx4_complex_alpha_surfaces_blocker_and_leaves_no_artifact(tmp_path):
    """X-4 bị từ chối phải nêu đúng blocker, không ghi PDF dở hay `PDF/X-X4`."""
    src = tmp_path / "complex_alpha.pdf"
    _live_alpha_rgb_pdf(src)
    engine = PdfxExportEngine()
    prefix = f"{src.stem}_PDF-X_x4_"
    before = {path.name for path in engine.output_dir.glob(f"{prefix}*.pdf")}

    with pytest.raises(InternalEngineUnsupported) as raised:
        asyncio.run(engine.export_pdfx(str(src), "x4"))

    message = str(raised.value)
    assert "LIVE_TRANSPARENCY_RGB" in message
    assert "PDF/X-X4" not in message
    after = {path.name for path in engine.output_dir.glob(f"{prefix}*.pdf")}
    assert after == before


def test_pdfx4_http_failure_keeps_blocker_and_no_output(tmp_path, monkeypatch):
    """Route thật giữ 422 nghiệp vụ + blocker thay vì generic 500."""
    from app.api.routes import preflight as preflight_routes

    src = tmp_path / "complex_alpha_http.pdf"
    _live_alpha_rgb_pdf(src)
    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _file_id: str(src))

    response = TestClient(app).post(
        "/api/preflight/export-pdfx",
        json={"file_id": "fixture", "standard": "x4"},
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert "LIVE_TRANSPARENCY_RGB" in detail
    assert "PDF/X-X4" not in detail
