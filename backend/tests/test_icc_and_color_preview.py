"""ICC registry + separations/softproof quality path smoke tests."""
from __future__ import annotations

import os
import base64
import io
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


def test_srgb_resolver_never_returns_mislabeled_adobe_rgb():
    from PIL import ImageCms

    path = resolve_srgb_profile_path()
    assert path is not None
    profile = ImageCms.getOpenProfile(path)
    identity = " ".join((
        ImageCms.getProfileName(profile),
        ImageCms.getProfileDescription(profile),
    )).lower()
    assert "srgb" in identity or "iec 61966-2.1" in identity
    assert "adobe rgb" not in identity


def test_mislabeled_bundle_is_quarantined_and_lcms_fallback_is_srgb(monkeypatch, tmp_path):
    from PIL import ImageCms
    import app.core.icc_profiles as registry

    wrong_bundle = Path(__file__).resolve().parents[1] / "app" / "assets" / "icc" / "sRGB.icc"
    isolated_bundle = tmp_path / "profiles"
    isolated_bundle.mkdir()
    (isolated_bundle / "sRGB.icc").write_bytes(wrong_bundle.read_bytes())

    monkeypatch.setattr(registry.settings, "ICC_PROFILE_DIR", str(isolated_bundle))
    monkeypatch.setattr(registry, "OS_ICC_SEARCH_PATHS", [])
    registry.resolve_profile_path.cache_clear()
    registry._materialize_builtin_srgb_profile.cache_clear()
    try:
        resolved = registry.resolve_srgb_profile_path()
        assert resolved is not None
        assert Path(resolved).resolve() != (isolated_bundle / "sRGB.icc").resolve()
        profile = ImageCms.getOpenProfile(resolved)
        assert "srgb" in ImageCms.getProfileDescription(profile).lower()
    finally:
        registry.resolve_profile_path.cache_clear()
        registry._materialize_builtin_srgb_profile.cache_clear()


def test_missing_configured_icc_dir_falls_back_to_package(monkeypatch, tmp_path):
    import app.core.icc_profiles as registry

    monkeypatch.setattr(registry.settings, "ICC_PROFILE_DIR", str(tmp_path / "missing"))
    expected = Path(__file__).resolve().parents[1] / "app" / "assets" / "icc"
    assert registry._bundle_icc_dir().resolve() == expected.resolve()


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


@pytest.mark.asyncio
async def test_softproof_png_giu_hop_dong_lossless(tmp_path):
    from PIL import Image
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_png.pdf")
    result = await SoftProofEngine().render_softproof(
        str(pdf_path),
        page_num=1,
        profile_id="fogra39",
        dpi=36,
        output_format="png",
    )

    payload = base64.b64decode(result["softproof_b64"])
    assert result["image_mime"] == "image/png"
    assert payload.startswith(b"\x89PNG\r\n\x1a\n")
    with Image.open(io.BytesIO(payload)) as image:
        assert image.size[0] > 0 and image.size[1] > 0


@pytest.mark.asyncio
async def test_viewer_accurate_route_kiem_path_va_tra_png(monkeypatch, tmp_path):
    from PIL import Image
    from app.api.routes import preflight
    from app.core.softproof import SoftProofEngine
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, "viewer_accurate.pdf")
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (10, 20, 30)).save(buffer, "PNG")
    calls = {}

    async def fake_render(self, **kwargs):
        calls.update(kwargs)
        return {
            "success": True,
            "softproof_b64": base64.b64encode(buffer.getvalue()).decode(),
            "engine": "ppe+lcms",
            "accuracy": "rip_softproof",
        }

    monkeypatch.setattr(SoftProofEngine, "render_softproof", fake_render)
    response = await preflight.render_viewer_accurate(
        ViewerAccurateRenderRequest(
            file_path=str(pdf_path),
            page=1,
            dpi=144,
        )
    )

    assert response.media_type == "image/png"
    assert bytes(response.body).startswith(b"\x89PNG\r\n\x1a\n")
    assert calls["pdf_path"] == os.path.realpath(str(pdf_path))
    assert calls["dpi"] == 144
    assert calls["output_format"] == "png"


@pytest.mark.asyncio
async def test_viewer_accurate_route_khong_nhan_fallback_xap_xi(monkeypatch, tmp_path):
    from fastapi import HTTPException
    from app.api.routes import preflight
    from app.core.softproof import SoftProofEngine
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, "viewer_approximate.pdf")

    async def fake_render(self, **kwargs):
        return {
            "success": True,
            "softproof_b64": base64.b64encode(b"not-used").decode(),
            "engine": "pdfium+lcms",
            "accuracy": "approximate",
            "warning": "Soft-proof gần đúng",
        }

    monkeypatch.setattr(SoftProofEngine, "render_softproof", fake_render)
    with pytest.raises(HTTPException) as exc_info:
        await preflight.render_viewer_accurate(
            ViewerAccurateRenderRequest(file_path=str(pdf_path), page=1, dpi=96)
        )

    assert exc_info.value.status_code == 500
    assert "Soft-proof gần đúng" in str(exc_info.value.detail)
