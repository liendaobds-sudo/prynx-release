"""ICC registry + separations/softproof quality path smoke tests."""
from __future__ import annotations

import asyncio
import os
import base64
import io
import threading
import zlib
from pathlib import Path

import pytest

from app.core.icc_profiles import (
    list_output_profiles,
    resolve_cmyk_profile_path,
    resolve_profile_path,
    resolve_srgb_profile_path,
)


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


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

    PPE là engine chính duy nhất đủ điều kiện chốt bản; đường xấp xỉ phải mang
    nhãn khác và không được lẫn vào kết quả này.
    """
    from app.core.separations import SeparationEngine

    pdf_path = _make_cmyk_page(tmp_path)

    engine = SeparationEngine()
    result = await engine.extract_separations(str(pdf_path), 1, dpi=36, render_mode="accurate")
    assert "plates" in result
    assert len(result["plates"]) >= 4

    # Trang CMYK vector thuần phải cho kết quả PPE đủ tin.
    assert result.get("accuracy") == "rip_separations", result.get("quality_note")
    assert result.get("engine") == "ppe"
    # PREFLIGHT (audit 2026-08-10 §OP.E1): UI lấy mẫu theo mm cần DPI artifact
    # thật; thiếu field này sẽ âm thầm quay lại giả định 150 DPI.
    assert result.get("render_dpi") == 36


@pytest.mark.asyncio
async def test_separations_route_gan_show_vao_request_va_response(
    monkeypatch, tmp_path
):
    from app.api.routes import preflight
    from app.core.separations import SeparationEngine

    captured = {}
    filtered_plane = bytes((0, 255))

    async def fake_extract(self, _path, _page, _dpi, **kwargs):
        captured.update(kwargs)
        return {
            "width": 2,
            "height": 1,
            "render_dpi": 150,
            "plates": [{
                "name": "Cyan",
                "color": [0, 158, 224],
                "alpha_data": base64.b64encode(
                    zlib.compress(filtered_plane)
                ).decode("ascii"),
                "is_spot": False,
            }],
        }

    monkeypatch.setattr(preflight, "_get_file_path", lambda _file_id: str(tmp_path / "source.pdf"))
    monkeypatch.setattr(SeparationEngine, "extract_separations", fake_extract)
    result = await preflight.get_separations(
        "file-id",
        1,
        output_preview_filter="device-rgb",
    )

    assert captured["output_preview_filter"] == "device-rgb"
    assert result["output_preview_filter"] == "device-rgb"
    decoded = zlib.decompress(base64.b64decode(result["plates"][0]["alpha_data"]))
    assert decoded == filtered_plane
    assert decoded[0] == 0, "vùng DeviceCMYK bị Show=DeviceRGB ẩn phải bằng 0% mực"


def test_separations_by_path_schema_khoa_danh_sach_show_filter():
    from pydantic import ValidationError
    from app.schemas.preflight import SeparationsPathRequest

    request = SeparationsPathRequest(
        file_path="D:/fixture.pdf",
        output_preview_filter="device-rgb",
    )
    assert request.output_preview_filter == "device-rgb"
    with pytest.raises(ValidationError):
        SeparationsPathRequest(
            file_path="D:/fixture.pdf",
            output_preview_filter="khong-hop-le",
        )


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
    assert result.get("engine") in ("ppe+lcms", "pdfium+lcms")


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
async def test_softproof_truyen_viewport_clip_xuong_ppe(monkeypatch, tmp_path):
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_clip.pdf")
    captured = {}

    def fake_softproof(*args, **kwargs):
        captured.update(kwargs)
        return {
            "width": 3,
            "height": 4,
            "rgb": bytes((10, 20, 30) * 12),
            "degraded": False,
            "ink_unsound": False,
        }

    monkeypatch.setattr(print_engine, "softproof", fake_softproof)
    result = await SoftProofEngine().render_softproof(
        str(pdf_path),
        page_num=1,
        profile_id="fogra39",
        dpi=144,
        output_format="png",
        clip=(7, 9, 3, 4),
        simulate_overprint=False,
    )

    assert result["accuracy"] == "rip_softproof"
    assert (result["width"], result["height"]) == (3, 4)
    assert captured["clip"] == (7, 9, 3, 4)
    assert captured["simulate_overprint"] is False


@pytest.mark.asyncio
async def test_softproof_cancel_bao_native_bo_response_cu(tmp_path):
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_session_cancel.pdf")
    started = threading.Event()
    released = threading.Event()
    cancelled = threading.Event()

    class BlockingSession:
        def render(self, **_kwargs):
            started.set()
            released.wait(timeout=5)
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((10, 20, 30)),
                "degraded": False,
                "ink_unsound": False,
            }

        def cancel(self, owner_id, request_generation):
            assert owner_id == "tab-cancel"
            assert request_generation == 7
            cancelled.set()
            released.set()
            return True

    task = asyncio.create_task(
        SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=36,
            accurate_only=True,
            ppe_session=BlockingSession(),
            owner_id="tab-cancel",
            request_generation=7,
        )
    )
    assert await asyncio.to_thread(started.wait, 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_softproof_generation_cu_khong_roi_xuong_pdfium(tmp_path):
    from app.core.print_engine.facade import PpeRequestSuperseded
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_session_stale.pdf")

    class StaleSession:
        def render(self, **_kwargs):
            raise PpeRequestSuperseded("generation cũ")

        def cancel(self, *_args):
            return True

    with pytest.raises(PpeRequestSuperseded, match="generation cũ"):
        await SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=36,
            accurate_only=False,
            ppe_session=StaleSession(),
            owner_id="tab-stale",
            request_generation=2,
        )


@pytest.mark.asyncio
async def test_softproof_hau_kiem_generation_sau_encode(tmp_path):
    from app.core.print_engine.facade import PpeRequestSuperseded
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_session_post_encode.pdf")

    class SupersededAfterEncodeSession:
        def __init__(self):
            self.checks = 0

        def render(self, **kwargs):
            assert kwargs["pdf_path"] == str(pdf_path)
            assert kwargs["cmyk_profile_id"] == "fogra39"
            assert kwargs["render_intent"] == 1
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((10, 20, 30)),
                "degraded": False,
                "ink_unsound": False,
            }

        def ensure_current(self, _owner_id, _request_generation):
            self.checks += 1
            if self.checks >= 3:
                raise PpeRequestSuperseded("generation đổi trong lúc encode")

        def cancel(self, *_args):
            return True

    session = SupersededAfterEncodeSession()
    with pytest.raises(PpeRequestSuperseded, match="trong lúc encode"):
        await SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=36,
            output_format="png",
            accurate_only=False,
            ppe_session=session,
            owner_id="tab-post-encode",
            request_generation=3,
        )
    assert session.checks == 3


@pytest.mark.asyncio
async def test_softproof_khong_che_loi_identity_session_bang_pdfium(monkeypatch, tmp_path):
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_session_identity.pdf")

    class WrongIdentitySession:
        def render(self, **_kwargs):
            raise ValueError("PPE RenderSession không thuộc tài liệu request này")

        def cancel(self, *_args):
            return True

    monkeypatch.setattr(
        SoftProofEngine,
        "_render_lcms_softproof",
        lambda *_args, **_kwargs: pytest.fail("identity sai không được fallback PDFium"),
    )
    with pytest.raises(ValueError, match="tài liệu"):
        await SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=36,
            accurate_only=False,
            ppe_session=WrongIdentitySession(),
            owner_id="tab-wrong-identity",
            request_generation=1,
        )


@pytest.mark.asyncio
async def test_softproof_giu_id_registry_khi_ten_file_icc_khac(monkeypatch, tmp_path):
    """ID `swop` không được biến thành stem `uswebcoatedswop`."""
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_swop.pdf")
    captured = {}

    monkeypatch.setattr(
        SoftProofEngine,
        "_resolve_profile",
        lambda _self, _profile_id: r"C:\profiles\USWebCoatedSWOP.icc",
    )

    def fake_softproof(*args, **kwargs):
        captured.update(kwargs)
        return {
            "width": 1,
            "height": 1,
            "rgb": bytes((10, 20, 30)),
            "degraded": False,
            "ink_unsound": False,
        }

    monkeypatch.setattr(print_engine, "softproof", fake_softproof)
    result = await SoftProofEngine().render_softproof(
        str(pdf_path),
        page_num=1,
        profile_id="swop",
        dpi=96,
        output_format="png",
        accurate_only=True,
    )

    assert result["accuracy"] == "rip_softproof"
    assert captured["cmyk_profile_id"] == "swop"


@pytest.mark.asyncio
async def test_softproof_truyen_day_du_contract_output_preview(monkeypatch, tmp_path):
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_output_preview_contract.pdf")
    captured = {}
    monkeypatch.setattr(
        SoftProofEngine,
        "_resolve_profile",
        lambda _self, _profile_id: r"C:\profiles\FOGRA39.icc",
    )

    def fake_softproof(*_args, **kwargs):
        captured.update(kwargs)
        return {
            "width": 1,
            "height": 1,
            "rgb": bytes((12, 34, 56)),
            "degraded": False,
            "ink_unsound": False,
        }

    monkeypatch.setattr(print_engine, "softproof", fake_softproof)
    result = await SoftProofEngine().render_softproof(
        str(pdf_path),
        page_num=1,
        profile_id="fogra39",
        dpi=36,
        output_format="png",
        output_preview_filter="images",
        simulate_paper_color=True,
        simulate_black_ink=True,
        page_background_rgb=(214, 190, 142),
    )
    assert result["accuracy"] == "rip_softproof"
    assert captured["output_preview_filter"] == "images"
    assert captured["simulate_paper_color"] is True
    assert captured["simulate_black_ink"] is True
    assert captured["page_background_rgb"] == (214, 190, 142)


@pytest.mark.asyncio
async def test_output_preview_contract_khong_roi_xuong_pdfium(monkeypatch, tmp_path):
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_filter_fail_loud.pdf")
    monkeypatch.setattr(
        print_engine,
        "softproof",
        lambda *_args, **_kwargs: {
            "width": 1,
            "height": 1,
            "rgb": bytes((10, 20, 30)),
            "degraded": True,
            "ink_unsound": True,
        },
    )
    monkeypatch.setattr(
        SoftProofEngine,
        "_render_lcms_softproof",
        lambda *_args, **_kwargs: pytest.fail(
            "Show/Paper/Black/Background không được rơi xuống PDFium xấp xỉ"
        ),
    )
    with pytest.raises(RuntimeError, match="chưa dựng đủ"):
        await SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=36,
            output_preview_filter="images",
        )


@pytest.mark.asyncio
async def test_softproof_ppe_khong_du_tin_phai_ha_nhan_va_giu_canh_bao(monkeypatch, tmp_path):
    """PPE thiếu nội dung không được đi xuyên thành ``rip_softproof``."""
    from PIL import Image
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_unsound.pdf")
    rgb = bytes((10, 20, 30) * 4)

    monkeypatch.setattr(print_engine, "softproof", lambda *args, **kwargs: {
        "width": 2,
        "height": 2,
        "rgb": rgb,
        "degraded": True,
        "ink_unsound": True,
        "timings_ms": {"raster": 123.0, "color": 45.0},
    })
    monkeypatch.setattr(
        SoftProofEngine,
        "_render_lcms_softproof",
        lambda *args, **kwargs: Image.new("RGB", (2, 2), (40, 50, 60)),
    )

    result = await SoftProofEngine().render_softproof(
        str(pdf_path), page_num=1, profile_id="fogra39", dpi=36, output_format="png",
    )

    assert result["accuracy"] == "approximate"
    assert result["engine"] == "pdfium+lcms"
    assert result["ppe_degraded"] is True
    assert result["ppe_ink_unsound"] is True
    assert result["warning"]
    assert result["timings_ms"]["raster"] is None
    assert result["timings_ms"]["render_color_total"] is not None
    assert result["ppe_attempt_timings_ms"]["raster"] == 123.0


@pytest.mark.asyncio
async def test_softproof_accurate_only_khong_dung_fallback_pdfium(monkeypatch, tmp_path):
    """Viewer đã có ảnh display nên PPE lỗi phải dừng trước đường full-page tốn RAM."""
    from app.core import print_engine
    from app.core.softproof import SoftProofEngine

    pdf_path = _make_cmyk_page(tmp_path, "softproof_accurate_only.pdf")
    monkeypatch.setattr(print_engine, "softproof", lambda *args, **kwargs: {
        "width": 2,
        "height": 2,
        "rgb": bytes((10, 20, 30) * 4),
        "degraded": True,
        "ink_unsound": True,
    })
    monkeypatch.setattr(
        SoftProofEngine,
        "_render_lcms_softproof",
        lambda *args, **kwargs: pytest.fail("accurate-only không được gọi PDFium fallback"),
    )

    with pytest.raises(RuntimeError, match="chưa dựng đủ"):
        await SoftProofEngine().render_softproof(
            str(pdf_path),
            page_num=1,
            profile_id="fogra39",
            dpi=144,
            output_format="png",
            clip=(0, 0, 2, 2),
            accurate_only=True,
        )


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
            "width": 2,
            "height": 2,
        }

    monkeypatch.setattr(SoftProofEngine, "render_softproof", fake_render)
    response = await preflight.render_viewer_accurate(
        ViewerAccurateRenderRequest(
            file_path=str(pdf_path),
            page=1,
            dpi=144,
            clip_x=10,
            clip_y=20,
            clip_width=2,
            clip_height=2,
            owner_id="viewer-test",
            session_owner_id="viewer-tab-session",
            request_id="request-3",
            generation=3,
            purpose="interactive",
            output_preview_filter="images",
            simulate_paper_color=True,
            simulate_black_ink=True,
            page_background_rgb=(214, 190, 142),
        ),
        _ConnectedRequest(),
    )

    assert response.media_type == "image/png"
    assert bytes(response.body).startswith(b"\x89PNG\r\n\x1a\n")
    assert calls["pdf_path"] == os.path.realpath(str(pdf_path))
    assert calls["dpi"] == 144
    assert calls["output_format"] == "png"
    assert calls["clip"] == (10, 20, 2, 2)
    assert calls["accurate_only"] is True
    assert calls["output_preview_filter"] == "images"
    assert calls["simulate_paper_color"] is True
    assert calls["simulate_black_ink"] is True
    assert calls["page_background_rgb"] == (214, 190, 142)
    assert calls["ppe_session"] is not None
    assert calls["owner_id"].startswith("ppe-viewer:")
    assert calls["owner_id"] != "viewer-test"
    assert calls["request_generation"] == 1
    assert response.headers["X-PrynX-Request-ID"] == "request-3"
    assert response.headers["X-PrynX-Viewer-Generation"] == "3"
    from app.core.ppe_viewer_session import viewer_session_manager

    assert await viewer_session_manager.release_owner("viewer-tab-session") is True


def test_viewer_accurate_schema_tu_choi_clip_thieu_truong(tmp_path):
    from pydantic import ValidationError
    from app.schemas.preflight import ViewerAccurateRenderRequest

    with pytest.raises(ValidationError, match="truyền đủ"):
        ViewerAccurateRenderRequest(
            file_path=str(tmp_path / "job.pdf"),
            owner_id="viewer-schema",
            request_id="request-schema",
            generation=1,
            clip_x=0,
            clip_y=0,
            clip_width=256,
        )

    with pytest.raises(ValidationError):
        ViewerAccurateRenderRequest(
            file_path=str(tmp_path / "job.pdf"),
            owner_id="viewer-schema",
            request_id="request-intent",
            generation=1,
            intent="khong-hop-le",
        )

    with pytest.raises(ValidationError):
        ViewerAccurateRenderRequest(
            file_path=str(tmp_path / "job.pdf"),
            owner_id="viewer-schema",
            request_id="request-filter",
            generation=1,
            output_preview_filter="khong-hop-le",
        )

    with pytest.raises(ValidationError, match="0..255"):
        ViewerAccurateRenderRequest(
            file_path=str(tmp_path / "job.pdf"),
            owner_id="viewer-schema",
            request_id="request-background",
            generation=1,
            page_background_rgb=(0, 128, 999),
        )

    with pytest.raises(ValidationError):
        ViewerAccurateRenderRequest(
            file_path=str(tmp_path / "job.pdf"),
            owner_id="viewer-schema",
            request_id="request-profile",
            generation=1,
            profile_id="../../profile",
        )


@pytest.mark.asyncio
async def test_viewer_accurate_route_tra_422_cho_profile_khong_ton_tai(tmp_path):
    from fastapi import HTTPException
    from app.api.routes import preflight
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, "viewer_bad_profile.pdf")
    with pytest.raises(HTTPException) as exc_info:
        await preflight.render_viewer_accurate(
            ViewerAccurateRenderRequest(
                file_path=str(pdf_path),
                owner_id="viewer-bad-profile",
                session_owner_id="viewer-bad-profile-session",
                request_id="request-bad-profile",
                generation=1,
                profile_id="profile_khong_ton_tai",
            ),
            _ConnectedRequest(),
        )

    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_viewer_accurate_route_tra_409_khi_generation_bi_thay_the(
    monkeypatch, tmp_path,
):
    from fastapi import HTTPException
    from app.api.routes import preflight
    from app.core import viewer_accurate_cache
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, "viewer_stale.pdf")

    async def superseded(*_args, **_kwargs):
        raise viewer_accurate_cache.AccurateRequestSuperseded("generation cũ")

    monkeypatch.setattr(viewer_accurate_cache, "get_or_render_accurate_png", superseded)
    with pytest.raises(HTTPException) as exc_info:
        await preflight.render_viewer_accurate(
            ViewerAccurateRenderRequest(
                file_path=str(pdf_path),
                owner_id="viewer-a",
                request_id="request-stale",
                generation=2,
            ),
            _ConnectedRequest(),
        )

    assert exc_info.value.status_code == 409
    assert "generation cũ" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_viewer_accurate_route_huy_waiter_khi_client_ngat_ket_noi(
    monkeypatch, tmp_path,
):
    from fastapi import HTTPException
    from app.api.routes import preflight
    from app.core import viewer_accurate_cache
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, "viewer_disconnect.pdf")
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def pending_render(*_args, **_kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    class DisconnectAfterStart:
        async def is_disconnected(self) -> bool:
            await started.wait()
            return True

    monkeypatch.setattr(
        viewer_accurate_cache,
        "get_or_render_accurate_png",
        pending_render,
    )
    with pytest.raises(HTTPException) as exc_info:
        await preflight.render_viewer_accurate(
            ViewerAccurateRenderRequest(
                file_path=str(pdf_path),
                owner_id="viewer-disconnect",
                request_id="request-disconnect",
                generation=1,
            ),
            DisconnectAfterStart(),
        )

    assert exc_info.value.status_code == 409
    assert cancelled.is_set()


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
            ViewerAccurateRenderRequest(
                file_path=str(pdf_path),
                page=1,
                dpi=96,
                owner_id="viewer-approximate",
                request_id="request-approximate",
                generation=1,
            ),
            _ConnectedRequest(),
        )

    assert exc_info.value.status_code == 500
    assert "Soft-proof gần đúng" in str(exc_info.value.detail)


@pytest.mark.asyncio
@pytest.mark.parametrize("quality_flag", ["ink_unsound", "degraded"])
async def test_viewer_accurate_route_khong_nhan_ppe_khong_du_tin(
    monkeypatch, tmp_path, quality_flag,
):
    """Phòng thủ hai lớp: nhãn RIP không được lấn át cờ chất lượng của PPE."""
    from fastapi import HTTPException
    from app.api.routes import preflight
    from app.core import viewer_accurate_cache
    from app.core.softproof import SoftProofEngine
    from app.schemas.preflight import ViewerAccurateRenderRequest

    pdf_path = _make_cmyk_page(tmp_path, f"viewer_{quality_flag}.pdf")
    buffer = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (2, 2), (10, 20, 30)).save(buffer, "PNG")

    async def fake_render(self, **kwargs):
        return {
            "success": True,
            "softproof_b64": base64.b64encode(buffer.getvalue()).decode(),
            "engine": "ppe+lcms",
            "accuracy": "rip_softproof",
            "ink_unsound": quality_flag == "ink_unsound",
            "degraded": quality_flag == "degraded",
            "warning": "PPE chưa dựng đủ nội dung.",
        }

    async def run_without_cache(_key, renderer, **_kwargs):
        rendered = await renderer()
        return viewer_accurate_cache.AccurateCacheResult(rendered=rendered, status="miss")

    monkeypatch.setattr(SoftProofEngine, "render_softproof", fake_render)
    monkeypatch.setattr(viewer_accurate_cache, "get_or_render_accurate_png", run_without_cache)

    with pytest.raises(HTTPException) as exc_info:
        await preflight.render_viewer_accurate(
            ViewerAccurateRenderRequest(
                file_path=str(pdf_path),
                page=1,
                dpi=96,
                owner_id=f"viewer-{quality_flag}",
                request_id=f"request-{quality_flag}",
                generation=1,
            ),
            _ConnectedRequest(),
        )

    assert exc_info.value.status_code == 500
    assert "PPE chưa dựng đủ nội dung" in str(exc_info.value.detail)


def test_separation_composite_schema_chan_identity_va_lut_sai():
    from pydantic import ValidationError
    from app.schemas.preflight import SeparationCompositeRequest

    valid_plate = {
        "name": "Brand Blue",
        "alpha_data": "eA==",
        "is_spot": True,
        "alternate_cmyk_lut": [[0.0, 0.0, 0.0, 0.0] for _ in range(33)],
    }
    request = SeparationCompositeRequest(
        width=2,
        height=1,
        plates=[valid_plate],
        enabled_names=["Brand Blue"],
        profile_id="swop",
        intent="perceptual",
    )
    assert request.enabled_names == ["Brand Blue"]

    with pytest.raises(ValidationError, match="không có trong payload"):
        SeparationCompositeRequest(
            width=2,
            height=1,
            plates=[valid_plate],
            enabled_names=["Plate Không Có"],
        )
    with pytest.raises(ValidationError, match="đúng 33 mẫu"):
        SeparationCompositeRequest(
            width=2,
            height=1,
            plates=[{
                **valid_plate,
                "alternate_cmyk_lut": valid_plate["alternate_cmyk_lut"][:-1],
            }],
        )
    with pytest.raises(ValidationError, match="80 triệu pixel"):
        SeparationCompositeRequest(
            width=10_000,
            height=10_000,
            plates=[valid_plate],
        )


@pytest.mark.asyncio
async def test_separation_composite_route_tra_png_nhi_phan(monkeypatch):
    from PIL import Image
    from app.api.routes import preflight
    from app.core.print_engine import facade
    from app.schemas.preflight import SeparationCompositeRequest

    calls = {}

    def fake_compose(**kwargs):
        calls.update(kwargs)
        return {
            "width": 2,
            "height": 1,
            "rgb": bytes((10, 20, 30, 40, 50, 60)),
            "missing_spot_alternates": [],
        }

    monkeypatch.setattr(facade, "compose_separation_subset", fake_compose)
    response = await preflight.compose_separation_preview(
        SeparationCompositeRequest(
            width=2,
            height=1,
            plates=[{
                "name": "Cyan",
                "alpha_data": "eA==",
                "is_spot": False,
            }],
            enabled_names=["Cyan"],
            profile_id="swop",
            intent="perceptual",
        )
    )

    assert response.media_type == "image/png"
    assert bytes(response.body).startswith(b"\x89PNG\r\n\x1a\n")
    assert Image.open(io.BytesIO(response.body)).getpixel((1, 0)) == (40, 50, 60)
    assert response.headers["X-PrynX-Color-Accuracy"] == "rip-separation-subset"
    assert response.headers["X-PrynX-Color-Profile"] == "swop"
    assert calls["enabled_names"] == ["Cyan"]
    assert calls["render_intent"] == 0
