"""Kiểm thử hợp đồng API tiền kiểm Phục hồi & Vector hóa Logo."""

from __future__ import annotations

from io import BytesIO
import random
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from app.api.routes import logo_rebuild as logo_route
from app.main import app
from app.schemas.logo_rebuild import LogoRebuildSettings
from app.workers import logo_rebuild as logo_worker


def _encoded_image(
    image_format: str,
    *,
    size: tuple[int, int] = (320, 180),
    mode: str = "RGB",
    exif: Image.Exif | None = None,
    dpi: tuple[float, float] | None = None,
) -> bytes:
    buffer = BytesIO()
    color = (30, 90, 150, 180) if mode == "RGBA" else (30, 90, 150)
    save_kwargs = {"exif": exif} if exif is not None else {}
    if dpi is not None:
        save_kwargs["dpi"] = dpi
    Image.new(mode, size, color).save(buffer, format=image_format, **save_kwargs)
    return buffer.getvalue()


def _image_bytes(image: Image.Image, image_format: str = "PNG") -> bytes:
    buffer = BytesIO()
    image.save(buffer, format=image_format)
    return buffer.getvalue()


def _preflight(
    client: TestClient,
    *,
    filename: str = "logo.png",
    content: bytes | None = None,
    settings_json: str = '{"mode":"monochrome"}',
):
    source = content if content is not None else _encoded_image("PNG", mode="RGBA")
    return client.post(
        "/api/logo-rebuild/preflight",
        files={"file": (filename, source, "application/octet-stream")},
        data={"settings_json": settings_json},
    )


def test_capabilities_only_expose_approved_mvp_modes(monkeypatch):
    monkeypatch.setattr(logo_route, "logo_vectorizer_capabilities", lambda: None)
    with TestClient(app) as client:
        response = client.get("/api/logo-rebuild/capabilities")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["modes"] == ["monochrome", "fixed_palette"]
    assert payload["auto_color_enabled"] is False
    assert payload["preview_engine_enabled"] is False
    assert payload["supported_formats"] == ["png", "jpeg", "webp"]


def test_fixed_palette_preflight_normalizes_palette_and_reports_source():
    settings_json = """{
        "mode": "fixed_palette",
        "palette": [" #FF0000 ", "#00ff00", "#ff0000"]
    }"""
    with TestClient(app) as client:
        response = _preflight(client, settings_json=settings_json)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ready"
    assert payload["settings"]["palette"] == ["#ff0000", "#00ff00"]
    assert payload["settings"]["smoothing"] == 0.0
    assert payload["settings"]["despeckle_size_px"] == 4
    assert payload["settings"]["illumination_correction"] is False
    assert payload["source"]["width_px"] == 320
    assert payload["source"]["height_px"] == 180
    assert payload["source"]["format"] == "PNG"
    assert payload["source"]["has_alpha"] is True
    assert payload["source"]["has_icc_profile"] is False
    assert payload["palette_suggestions"] == [
        {"color": "#1e5a96", "coverage_ratio": 1.0}
    ]
    assert any("Độ phân giải" in warning for warning in payload["warnings"])
    assert any("ICC profile" in warning for warning in payload["warnings"])


def test_monochrome_rejects_palette():
    with TestClient(app) as client:
        response = _preflight(
            client,
            settings_json='{"mode":"monochrome","palette":["#000000","#ffffff"]}',
        )

    assert response.status_code == 422
    assert "đen trắng không nhận palette" in response.json()["detail"]


def test_explicit_smoothing_from_existing_project_is_preserved():
    settings = LogoRebuildSettings.model_validate(
        {"mode": "fixed_palette", "palette": ["#123456"], "smoothing": 1.0}
    )
    assert settings.smoothing == 1.0


def test_invalid_image_bytes_are_rejected():
    with TestClient(app) as client:
        response = _preflight(client, content=b"day-khong-phai-la-anh")

    assert response.status_code == 400


def test_preflight_suggests_all_four_flat_colors_without_known_k():
    source = Image.new("RGB", (200, 200), "white")
    source.paste("#d32f2f", (0, 0, 100, 100))
    source.paste("#1565c0", (100, 0, 200, 100))
    source.paste("#2e7d32", (0, 100, 100, 200))
    source.paste("#f9a825", (100, 100, 200, 200))

    with TestClient(app) as client:
        response = _preflight(
            client,
            content=_image_bytes(source),
            settings_json='{"mode":"fixed_palette","palette":["#000000"]}',
        )

    assert response.status_code == 200, response.text
    suggestions = response.json()["palette_suggestions"]
    assert {item["color"] for item in suggestions} == {
        "#d32f2f",
        "#1565c0",
        "#2e7d32",
        "#f9a825",
    }
    assert all(item["coverage_ratio"] == pytest.approx(0.25) for item in suggestions)


def test_palette_suggestion_ignores_hidden_rgb_of_transparent_pixels():
    source = Image.new("RGBA", (100, 100), (255, 0, 0, 0))
    source.paste((21, 101, 192, 255), (25, 25, 75, 75))

    with TestClient(app) as client:
        response = _preflight(
            client,
            content=_image_bytes(source),
            settings_json='{"mode":"fixed_palette","palette":["#000000"]}',
        )

    assert response.status_code == 200, response.text
    assert response.json()["palette_suggestions"] == [
        {"color": "#1565c0", "coverage_ratio": 1.0}
    ]


def test_palette_suggestion_is_bounded_and_sorted_for_noisy_image():
    rng = random.Random(20260730)
    source = Image.new("RGB", (80, 80))
    source.putdata(
        [
            (rng.randrange(256), rng.randrange(256), rng.randrange(256))
            for _ in range(80 * 80)
        ]
    )

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    assert warnings == []
    assert 1 <= len(suggestions) <= 12
    coverages = [item.coverage_ratio for item in suggestions]
    assert coverages == sorted(coverages, reverse=True)
    assert all(0.0 < coverage <= 1.0 for coverage in coverages)


def test_palette_suggestion_uses_selected_crop_only():
    source = Image.new("RGB", (200, 100), "#d32f2f")
    source.paste("#1565c0", (100, 0, 200, 100))
    settings = LogoRebuildSettings.model_validate(
        {
            "mode": "fixed_palette",
            "palette": ["#000000"],
            "crop": {"x": 0, "y": 0, "width": 0.5, "height": 1},
        }
    )

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        settings,
    )

    assert warnings == []
    assert [item.color for item in suggestions] == ["#d32f2f"]


def test_fully_transparent_image_returns_no_palette_with_warning():
    source = Image.new("RGBA", (32, 32), (12, 34, 56, 0))

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    assert suggestions == []
    assert any("không có pixel nhìn thấy" in warning for warning in warnings)


def test_jpeg_exif_orientation_is_reflected_in_reported_dimensions():
    exif = Image.Exif()
    exif[274] = 6
    source = _encoded_image("JPEG", size=(640, 360), exif=exif)

    with TestClient(app) as client:
        response = _preflight(client, filename="logo.jpg", content=source)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source"]["width_px"] == 360
    assert payload["source"]["height_px"] == 640


def test_degenerate_perspective_points_are_rejected():
    settings_json = """{
        "mode": "monochrome",
        "perspective_points": [
            {"x": 0.1, "y": 0.1},
            {"x": 0.2, "y": 0.2},
            {"x": 0.3, "y": 0.3},
            {"x": 0.4, "y": 0.4}
        ]
    }"""
    with TestClient(app) as client:
        response = _preflight(client, settings_json=settings_json)

    assert response.status_code == 422
    assert "vùng suy biến" in response.json()["detail"]


def test_preview_returns_svg_from_scheduled_adapter(monkeypatch):
    job_id = UUID("5da3bfe6-013d-4fb3-9fd7-bf18a3790f45")

    token = object()

    def fake_preview(source_bytes, settings, received_job_id, received_token):
        assert source_bytes.startswith(b"\x89PNG")
        assert settings.mode == "fixed_palette"
        assert settings.smoothing == 0.0
        assert received_job_id == str(job_id)
        assert received_token is token
        return logo_worker.LogoPreviewResult(
            svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>',
            width_px=20,
            height_px=10,
            warnings=["preview-test"],
            engine="vtracer",
            engine_version="1.0.0-alpha.2",
        )

    monkeypatch.setattr(logo_route, "process_logo_preview", fake_preview)
    monkeypatch.setattr(logo_route, "reserve_logo_job", lambda _job_id: token)
    settings_json = '{"mode":"fixed_palette","palette":["#ff0000","#ffffff"]}'
    with TestClient(app) as client:
        response = client.post(
            "/api/logo-rebuild/preview",
            files={"file": ("logo.png", _encoded_image("PNG"), "image/png")},
            data={"settings_json": settings_json, "job_id": str(job_id)},
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["job_id"] == str(job_id)
    assert payload["svg"].startswith("<svg")
    assert payload["engine_version"] == "1.0.0-alpha.2"
    assert "preview-test" in payload["warnings"]


def test_cancel_endpoint_reports_active_job(monkeypatch):
    job_id = UUID("15ee226a-95cd-4f1f-bc1b-462bc4fcfbed")
    monkeypatch.setattr(logo_route, "cancel_logo_job", lambda value: value == str(job_id))

    with TestClient(app) as client:
        response = client.delete(f"/api/logo-rebuild/jobs/{job_id}")

    assert response.status_code == 200
    assert response.json() == {
        "job_id": str(job_id),
        "cancelled": True,
        "status": "cancelled",
    }


def test_memory_plan_only_reduces_preview_below_16_gb(monkeypatch):
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (8 * 1024.0, 1200.0))
    reduced, warnings = logo_worker._plan_work_size(5000, 5000)
    assert reduced[0] < 5000
    assert reduced[1] < 5000
    assert warnings

    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (32 * 1024.0, 1500.0))
    with pytest.raises(logo_worker.LogoInputError, match="không còn đủ bộ nhớ"):
        logo_worker._plan_work_size(5000, 5000)


@pytest.mark.parametrize(
    ("total_mb", "expected_shortest_side"),
    [
        (4 * 1024.0, 600),
        (12 * 1024.0, 900),
        (32 * 1024.0, 1200),
        (None, 1200),
    ],
)
def test_small_logo_upscale_only_reduces_target_on_low_memory(
    monkeypatch, total_mb, expected_shortest_side
):
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (total_mb, None))
    target = logo_worker._upscale_target_dimensions(300, 150)
    assert min(target) == expected_shortest_side


def test_small_logo_uses_nearest_upscale_before_trace(monkeypatch):
    monkeypatch.setattr(
        logo_worker, "read_memory_status_mb", lambda: (32 * 1024.0, 24 * 1024.0)
    )
    source = Image.new("RGB", (300, 300), "white")
    source.paste((10, 20, 30), (100, 100, 200, 200))
    buffer = BytesIO()
    source.save(buffer, format="PNG")

    prepared = logo_worker.prepare_logo_image(
        buffer.getvalue(), LogoRebuildSettings(mode="monochrome")
    )

    assert (prepared.width_px, prepared.height_px) == (1200, 1200)
    resized = Image.frombytes(
        "RGBA", (prepared.width_px, prepared.height_px), prepared.rgba
    )
    assert resized.getpixel((399, 600))[:3] == (255, 255, 255)
    assert resized.getpixel((400, 600))[:3] == (10, 20, 30)
    assert any("nội suy giữ biên" in warning for warning in prepared.warnings)


def test_cmyk_icc_transform_runs_before_rgb_conversion(monkeypatch):
    calls = {}

    monkeypatch.setattr(logo_worker.ImageCms, "ImageCmsProfile", lambda _stream: object())
    monkeypatch.setattr(logo_worker.ImageCms, "createProfile", lambda _name: object())

    def fake_profile_to_profile(image, _source, _target, **kwargs):
        calls["mode"] = image.mode
        calls["intent"] = kwargs["renderingIntent"]
        return Image.new("RGB", image.size, (20, 30, 40))

    monkeypatch.setattr(logo_worker.ImageCms, "profileToProfile", fake_profile_to_profile)
    source = Image.new("CMYK", (8, 8), (255, 0, 0, 0))
    source.info["icc_profile"] = b"fixture-profile"
    warnings = []

    converted = logo_worker._convert_to_srgb(source, warnings)

    assert calls == {
        "mode": "CMYK",
        "intent": ImageCms.Intent.RELATIVE_COLORIMETRIC,
    }
    assert converted.mode == "RGB"
    assert warnings == []


def test_worker_crops_rgba_and_passes_confirmed_palette(monkeypatch):
    calls = {}

    class FakeCancel:
        def __init__(self):
            self.cancelled = False

        def cancel(self):
            self.cancelled = True

        def is_cancelled(self):
            return self.cancelled

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return {"engine": "fake-vtracer", "version": "test"}

        @staticmethod
        def logo_vectorize_rgba(width, height, rgba, mode, **kwargs):
            calls.update(
                width=width,
                height=height,
                rgba_size=len(rgba),
                mode=mode,
                palette=kwargs["palette"],
                smoothing=kwargs["smoothing"],
            )
            return '<svg xmlns="http://www.w3.org/2000/svg"/>'

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    settings = LogoRebuildSettings.model_validate(
        {
            "mode": "fixed_palette",
            "palette": ["#ff0000", "#ffffff"],
            "crop": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
            "illumination_correction": False,
        }
    )

    result = logo_worker.process_logo_preview(
        _encoded_image("PNG", size=(100, 80)),
        settings,
        "worker-crop-test",
    )

    assert (result.width_px, result.height_px) == (50, 40)
    assert calls == {
        "width": 50,
        "height": 40,
        "rgba_size": 50 * 40 * 4,
        "mode": "fixed_palette",
        "palette": ["#ff0000", "#ffffff"],
        "smoothing": 0.0,
    }
    assert "worker-crop-test" not in logo_worker._ACTIVE_JOBS


def test_transparent_monochrome_preserves_solid_fill_and_ignores_illumination(monkeypatch):
    calls = {}

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return {"engine": "fake-vtracer", "version": "test"}

        @staticmethod
        def logo_vectorize_rgba(width, height, rgba, _mode, **_kwargs):
            center_offset = ((height // 2) * width + width // 2) * 4
            calls["center"] = tuple(rgba[center_offset : center_offset + 4])
            calls["outside"] = tuple(rgba[0:4])
            return '<svg xmlns="http://www.w3.org/2000/svg"/>'

    source = Image.new("RGBA", (64, 64), (255, 255, 255, 0))
    for y in range(16, 48):
        for x in range(16, 48):
            source.putpixel((x, y), (0, 0, 0, 255))
    buffer = BytesIO()
    source.save(buffer, format="PNG")

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    result = logo_worker.process_logo_preview(
        buffer.getvalue(),
        LogoRebuildSettings(mode="monochrome", illumination_correction=True),
        "transparent-monochrome-test",
    )

    assert calls["center"] == (0, 0, 0, 255)
    assert calls["outside"] == (255, 255, 255, 255)
    assert any("bỏ qua cân bằng ánh sáng" in warning for warning in result.warnings)
    assert "transparent-monochrome-test" not in logo_worker._ACTIVE_JOBS


def test_reserved_job_can_be_cancelled_before_worker_starts(monkeypatch):
    class FakeCancel:
        def __init__(self):
            self.cancelled = False

        def cancel(self):
            self.cancelled = True

        def is_cancelled(self):
            return self.cancelled

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return {"engine": "fake-vtracer", "version": "test"}

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    settings = LogoRebuildSettings(mode="monochrome", illumination_correction=False)
    token = logo_worker.reserve_logo_job("queued-job")
    assert logo_worker.cancel_logo_job("queued-job") is True

    with pytest.raises(logo_worker.LogoJobCancelled):
        logo_worker.process_logo_preview(b"unused", settings, "queued-job", token)
    assert "queued-job" not in logo_worker._ACTIVE_JOBS

def test_worker_removes_confirmed_background_color_from_svg(monkeypatch):
    calls = {}

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return {"engine": "fake-vtracer", "version": "test"}

        @staticmethod
        def logo_vectorize_rgba(_width, _height, _rgba, _mode, **kwargs):
            calls["palette"] = kwargs["palette"]
            return (
                '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
                '<path d="M0 0H10V10H0Z" fill="#233D69"/>'
                '<path d="M2 2H8V8H2Z" fill="#EF4444"/>'
                '<path d="M4 4H6V6H4Z" fill="#233D69"/>'
                '</svg>'
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    settings = LogoRebuildSettings.model_validate(
        {
            "mode": "fixed_palette",
            "palette": ["#ef4444"],
            "background_color": "#233d69",
            "illumination_correction": False,
        }
    )

    result = logo_worker.process_logo_preview(
        _encoded_image("PNG", size=(10, 10)),
        settings,
        "background-strip-test",
    )

    assert calls["palette"] == ["#ef4444", "#233d69"]
    assert "#233D69" not in result.svg
    assert "#EF4444" in result.svg
    assert 'mask="url(#prynx-background-cutout)"' in result.svg
    assert '#000000' in result.svg
    root = logo_worker.ElementTree.fromstring(result.svg)
    mask_rect = root.find(
        ".//{http://www.w3.org/2000/svg}mask/{http://www.w3.org/2000/svg}rect"
    )
    assert mask_rect is not None
    assert mask_rect.attrib["width"] == "10"
    assert mask_rect.attrib["height"] == "10"
    assert "background-strip-test" not in logo_worker._ACTIVE_JOBS


def test_svg_has_viewbox_and_physical_size_from_dpi(monkeypatch):
    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return {"engine": "fake-vtracer", "version": "test"}

        @staticmethod
        def logo_vectorize_rgba(width, height, _rgba, _mode, **_kwargs):
            return (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
                '<path d="M0 0H10V10H0Z" fill="#000000"/>'
                "</svg>"
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    source = _encoded_image("PNG", size=(600, 600), dpi=(300, 300))

    result = logo_worker.process_logo_preview(
        source,
        LogoRebuildSettings(mode="monochrome"),
        "svg-geometry-test",
    )
    root = logo_worker.ElementTree.fromstring(result.svg)

    assert root.attrib["viewBox"] == "0 0 600 600"
    assert float(root.attrib["width"].removesuffix("mm")) == pytest.approx(50.8, abs=0.01)
    assert float(root.attrib["height"].removesuffix("mm")) == pytest.approx(50.8, abs=0.01)
