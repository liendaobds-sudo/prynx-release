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


@pytest.mark.asyncio
async def test_separations_prefer_gs_when_available(tmp_path):
    """With GS present, default path should not be forced approximate-only."""
    from app.config import settings
    from app.core.separations import SeparationEngine
    import pikepdf

    pdf_path = tmp_path / "cmyk_page.pdf"
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    # Simple CMYK fill via content
    page.Contents = pdf.make_stream(b"0 1 1 0 k 10 10 80 80 re f\n")
    pdf.save(pdf_path)
    pdf.close()

    engine = SeparationEngine()
    result = await engine.extract_separations(str(pdf_path), 1, dpi=36, use_ghostscript=None)
    assert "plates" in result
    assert len(result["plates"]) >= 4
    assert result.get("engine") in ("ghostscript", "pdfium_approx")
    assert result.get("accuracy") in ("rip_separations", "approximate")
    # If GS configured, expect rip path
    if settings.GHOSTSCRIPT_PATH and os.path.isfile(settings.GHOSTSCRIPT_PATH):
        assert result["engine"] == "ghostscript"
        assert result["accuracy"] == "rip_separations"


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
    assert result.get("engine") in ("ghostscript+icc", "pdfium+lcms")
