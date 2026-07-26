"""OutputIntent của PDF/X phải khai đúng điều kiện in mà app đã kiểm.

Vì sao đáng một file test riêng: OutputIntent là lời khai gửi cho nhà in —
"file này đã được chuẩn bị cho điều kiện in X". Nếu nó khai một profile khác
với profile mà separations / soft-proof / TAC dùng để kiểm, thì mọi con số đã
đo trở nên vô nghĩa với người nhận, và sai lệch đó không hiện ra ở bất kỳ đâu
trong UI.
"""

import os

from app.core.pdfx_export import PdfxExportEngine


def test_output_intent_uses_app_cmyk_profile_not_ghostscript_default():
    """Phải là profile CMYK của app, không phải ICC generic cạnh binary GS.

    Lỗi đã xảy ra: nhánh tìm profile gọi `softproof.KNOWN_PROFILES`, biểu tượng
    đó bị bỏ trong một lần refactor, và `except Exception: pass` nuốt trọn
    ImportError — PDF/X lặng lẽ khai "Generic CMYK (Ghostscript default)" trong
    khi FOGRA39 vẫn nằm sẵn trong app/assets/icc/.
    """
    path, cond_id, cond_name = PdfxExportEngine()._resolve_output_intent_icc()

    assert path, "không tìm được ICC nào cho OutputIntent"
    assert os.path.isfile(path)
    normalized = path.replace("\\", "/").lower()
    assert "/assets/icc/" in normalized, (
        f"OutputIntent phải dùng ICC bundled của app, đang dùng: {path}"
    )
    assert "iccprofiles" not in normalized, (
        f"ICC đang lấy từ thư mục Ghostscript: {path}"
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


def test_pdfx4_identification_needs_xmp_and_version_16(tmp_path):
    """X-4 (ISO 15930-7) đòi PDF ≥1.6 và định danh trong XMP, không phải Info.

    Ghostscript `-dPDFX=true` chỉ nhắm X-1a/X-3: nó ép version về 1.3 và ghi
    `/GTS_PDFXVersion` vào Info. File xuất ra vì thế KHAI "PDF/X-4" trong khi
    cấu trúc là X-3 — validator từ chối, mà một file khai sai chuẩn còn tệ hơn
    file không khai vì nhà in tin lời khai.
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
    if not engine.gs_path or not os.path.isfile(engine.gs_path):
        import pytest

        pytest.skip("cần Ghostscript cho bước xuất")

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
