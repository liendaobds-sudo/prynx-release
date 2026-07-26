"""ICC registry + separations/softproof quality path smoke tests."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.core.icc_profiles import (
    list_output_profiles,
    resolve_cmyk_profile_path,
    resolve_profile_path,
    resolve_srgb_profile_path,
)


def test_fogra39_resolves_from_bundle():
    path = resolve_cmyk_profile_path("fogra39")
    assert path is not None, "FOGRA39.icc must ship in app/assets/icc"
    assert Path(path).is_file()
    assert Path(path).name.lower() in ("fogra39.icc", "coatedfogra39.icc")


def test_srgb_resolves_from_bundle_or_os():
    path = resolve_srgb_profile_path()
    # Bundle has sRGB.icc — must resolve
    assert path is not None
    assert Path(path).is_file()


def test_list_output_profiles_marks_fogra_available():
    profiles = list_output_profiles()
    fogra = next((p for p in profiles if p["id"] == "fogra39"), None)
    assert fogra is not None
    assert fogra["available"] is True


def test_unknown_profile_returns_none():
    assert resolve_profile_path("not_a_real_profile_xyz") is None


def _make_cmyk_page(tmp_path, name="cmyk_page.pdf"):
    """Trang CMYK vector thuần: `0 1 1 0 k` ⇒ TAC 200% ở vùng tô."""
    import pikepdf

    pdf_path = tmp_path / name
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Contents = pdf.make_stream(b"0 1 1 0 k 10 10 80 80 re f\n")
    pdf.save(pdf_path)
    pdf.close()
    return pdf_path


@pytest.mark.asyncio
async def test_separations_default_path_is_rip_quality_not_approximate(tmp_path):
    """Đường mặc định không được rơi về đường xấp xỉ khi có engine chất lượng RIP.

    Test này CỐ Ý không khoá *danh tính* engine. Ý định cần bảo vệ là "kẽm đủ tin
    để chốt bản", và từ khi có PrynX Print Engine (PPE) thì có hai engine đạt mức
    đó — PPE chạy trước Ghostscript. Khoá tên engine sẽ biến một thay đổi kiến
    trúc hợp lệ thành test đỏ, còn nới `accuracy` thành "bất kỳ" thì mất luôn thứ
    đáng bảo vệ. Vì vậy khoá theo `accuracy`.
    """
    from app.core.separations import SeparationEngine

    pdf_path = _make_cmyk_page(tmp_path)

    engine = SeparationEngine()
    result = await engine.extract_separations(str(pdf_path), 1, dpi=36, use_ghostscript=None)
    assert "plates" in result
    assert len(result["plates"]) >= 4

    # Trang CMYK vector thuần: cả PPE lẫn GS đều phải cho kết quả chuẩn RIP.
    # `rip_separations_approx_geometry` (font không nhúng đã thay) cũng được tính:
    # đỉnh mực vẫn đúng, chỉ diện tích phủ là xấp xỉ — nhưng trang này không có chữ.
    assert result.get("accuracy") == "rip_separations", result.get("quality_note")
    assert result.get("engine") in ("ppe", "ghostscript")


@pytest.mark.asyncio
async def test_separations_ghostscript_path_still_works(tmp_path):
    """Đường Ghostscript phải giữ nguyên tác dụng khi PPE bị tắt.

    GS vẫn là lưới an toàn cho những trang PPE chưa vẽ đủ (shading, transparency),
    nên nó cần test riêng — nếu chỉ còn test đường mặc định thì đường fallback có
    thể mục đi mà không ai biết, và nó chỉ được dùng đúng lúc quan trọng nhất.
    """
    from app.config import settings
    from app.core.separations import SeparationEngine

    if not (settings.GHOSTSCRIPT_PATH and os.path.isfile(str(settings.GHOSTSCRIPT_PATH))):
        pytest.skip("máy này chưa cấu hình Ghostscript")

    pdf_path = _make_cmyk_page(tmp_path, "cmyk_page_gs.pdf")

    engine = SeparationEngine()
    result = await engine.extract_separations(
        str(pdf_path), 1, dpi=36, use_ghostscript=True, use_ppe=False
    )
    assert result["engine"] == "ghostscript"
    assert result["accuracy"] == "rip_separations"
    assert len(result["plates"]) >= 4


@pytest.mark.asyncio
async def test_softproof_returns_image(tmp_path):
    from app.core.softproof import SoftProofEngine
    import pikepdf

    pdf_path = tmp_path / "soft.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(100, 100))
    pdf.save(pdf_path)
    pdf.close()

    engine = SoftProofEngine()
    result = await engine.render_softproof(
        str(pdf_path), page_num=1, profile_id="fogra39", dpi=36,
    )
    assert result.get("softproof_b64")
    assert result.get("profile_available") is True
    assert result.get("engine") in ("ppe+lcms", "ghostscript+icc", "pdfium+lcms")
