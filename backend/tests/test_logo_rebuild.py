"""Kiểm thử hợp đồng API tiền kiểm Phục hồi & Vector hóa Logo."""

from __future__ import annotations

import hashlib
from io import BytesIO
import random
import threading
from uuid import UUID

import anyio
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageCms

from app.api.routes import logo_rebuild as logo_route
from app.core import heavy_job_scheduler as scheduler
from app.main import app
from app.schemas.logo_rebuild import LogoNativeMetrics, LogoRebuildSettings
from app.workers import logo_rebuild as logo_worker


@pytest.fixture(autouse=True)
def _enable_logo_rebuild_dev_runtime(monkeypatch):
    """Các test hợp đồng API chạy trong chế độ nghiệm thu nội bộ."""

    monkeypatch.setattr(logo_route.settings, "DEV_MODE", True)
    monkeypatch.setattr(logo_route.sys, "frozen", False, raising=False)
    monkeypatch.delenv("PRYNX_LOGO_REBUILD_ENABLED", raising=False)
    monkeypatch.delenv("PRYNX_LOGO_LEGACY_VTRACER_ENABLED", raising=False)


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


def _monochrome_logo_bytes(
    size: tuple[int, int], *, dpi: tuple[float, float] | None = None
) -> bytes:
    image = Image.new("RGB", size, (255, 255, 255))
    width, height = size
    image.paste((0, 0, 0), (width // 4, height // 4, width * 3 // 4, height * 3 // 4))
    buffer = BytesIO()
    image.save(buffer, format="PNG", **({"dpi": dpi} if dpi is not None else {}))
    return buffer.getvalue()


def _fake_native_info() -> dict[str, object]:
    return {
        "engine": "fake-vtracer",
        "version": "test-legacy",
        "cancellable": True,
        "structured_result": True,
        "structured_result_version": 1,
        "core_engine": "prynx-logo-core",
        "core_engine_version": "test-core",
    }


def _fake_structured_result(
    svg: str,
    width: int,
    height: int,
    mode: str,
    *,
    physical_width_mm: float | None = None,
    physical_height_mm: float | None = None,
    warnings: list[str] | None = None,
) -> dict[str, object]:
    root = logo_worker.ElementTree.fromstring(svg)
    logo_worker.ElementTree.register_namespace("", "http://www.w3.org/2000/svg")
    root.set("viewBox", f"0 0 {width} {height}")
    if physical_width_mm is not None and physical_height_mm is not None:
        root.set("width", f"{physical_width_mm:g}mm")
        root.set("height", f"{physical_height_mm:g}mm")
    else:
        root.set("width", str(width))
        root.set("height", str(height))
    artifact_svg = logo_worker.ElementTree.tostring(root, encoding="unicode")
    artifact_hash = hashlib.sha256(artifact_svg.encode("utf-8")).hexdigest()
    return {
        "schema_version": 1,
        "scene_version": 1,
        "coordinate_system": "pixel_top_left",
        "svg": artifact_svg,
        "artifact": {
            "sha256": artifact_hash,
            "byte_len": len(artifact_svg.encode("utf-8")),
            "width_px": width,
            "height_px": height,
            "physical_width_mm": physical_width_mm,
            "physical_height_mm": physical_height_mm,
        },
        "provenance": {
            "engine": "prynx-logo-core",
            "engine_version": "test-core",
            "profile": "silhouette" if mode == "monochrome" else "flat_color",
            "settings_hash": "a" * 64,
        },
        "preprocess_hash": "b" * 64,
        "metrics": {
            "layer_count": 1,
            "component_count": 1,
            "outer_count": 1,
            "hole_count": 0,
            "source_nodes": 4,
            "output_nodes": 4,
            "max_error_px": 0.0,
            "artifact_max_tangent_jump_degrees": 90.0,
            "raster_scale": 4,
            "iou": 1.0,
            "mae": 0.0,
        },
        "warnings": list(warnings or []),
    }


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


def test_preflight_palette_uses_heavy_admission_and_memory_reservation(monkeypatch):
    calls = {}

    async def fake_scheduled(kind, function, *args, **kwargs):
        calls["kind"] = kind
        calls["memory_required_mb"] = kwargs.get("memory_required_mb")
        calls["memory_budget_provider"] = kwargs.get("memory_budget_provider")
        return function(*args)

    monkeypatch.setattr(logo_route, "run_scheduled_in_threadpool", fake_scheduled)
    with TestClient(app) as client:
        response = _preflight(
            client,
            settings_json='{"mode":"fixed_palette","palette":["#ff0000"]}',
        )

    assert response.status_code == 200, response.text
    assert calls["kind"] == "logo-rebuild"
    assert calls["memory_required_mb"] >= 64.0
    assert calls["memory_budget_provider"] is logo_worker.logo_memory_budget_mb


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
    assert payload["settings"]["engine"] == "prynx_core"
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
    assert any("kích thước in" in warning.lower() for warning in payload["warnings"])


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



def test_curve_presets_are_explicit_and_legacy_smoothing_remains_compatible():
    for preset in ("automatic", "faithful", "balanced", "trajectory_completion"):
        settings = LogoRebuildSettings.model_validate(
            {"mode": "monochrome", "curve_preset": preset}
        )
        assert settings.curve_preset == preset
    legacy = LogoRebuildSettings.model_validate(
        {"mode": "fixed_palette", "palette": ["#123456"], "smoothing": 0.37}
    )
    assert legacy.curve_preset is None
    assert legacy.smoothing == 0.37
    with pytest.raises(ValueError):
        LogoRebuildSettings.model_validate(
            {
                "mode": "monochrome",
                "engine": "vtracer",
                "curve_preset": "automatic",
            }
        )


def test_geometry_metrics_accept_new_telemetry_and_reject_invalid_ranges():
    metrics = LogoNativeMetrics(
        layer_count=1,
        component_count=1,
        outer_count=1,
        hole_count=0,
        source_nodes=100,
        output_nodes=4,
        max_error_px=0.2,
        max_symmetric_distance_px=0.2,
        line_segments=0,
        cubic_segments=4,
        circle_count=1,
        ellipse_count=0,
        max_smooth_tangent_jump_degrees=0.0,
        artifact_max_tangent_jump_degrees=0.0,
        raster_scale=4,
        iou=0.999,
        mae=0.001,
    )
    assert metrics.circle_count == 1
    assert metrics.output_nodes == 4
    with pytest.raises(ValueError):
        LogoNativeMetrics(
            layer_count=1,
            component_count=1,
            outer_count=1,
            hole_count=0,
            source_nodes=100,
            output_nodes=4,
            max_error_px=0.2,
            max_smooth_tangent_jump_degrees=181.0,
            raster_scale=4,
            iou=0.999,
            mae=0.001,
        )


def test_capabilities_advertise_curve_presets_only_when_native_supports_them(monkeypatch):
    class FakeNative:
        logo_vectorize_structured_rgba = staticmethod(lambda *_args, **_kwargs: None)

        @staticmethod
        def logo_vectorizer_info():
            return {
                **_fake_native_info(),
                "curve_presets": [
                    "automatic",
                    "faithful",
                    "balanced",
                    "trajectory_completion",
                ],
                "geometry_metrics_version": 1,
            }

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    capabilities = logo_worker.logo_vectorizer_capabilities()

    assert capabilities is not None
    assert capabilities["curve_presets"] == [
        "automatic",
        "faithful",
        "balanced",
        "trajectory_completion",
    ]
    assert capabilities["geometry_metrics_version"] == 1


def test_vtracer_legacy_requires_explicit_dev_flag(monkeypatch):
    settings_json = '{"mode":"monochrome","engine":"vtracer"}'
    with TestClient(app) as client:
        blocked = _preflight(client, settings_json=settings_json)
        monkeypatch.setenv("PRYNX_LOGO_LEGACY_VTRACER_ENABLED", "true")
        allowed = _preflight(client, settings_json=settings_json)

    assert blocked.status_code == 422
    assert "VTracer legacy" in blocked.json()["detail"]
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["settings"]["engine"] == "vtracer"
    assert (
        logo_route._legacy_vtracer_runtime_enabled(
            is_development=True,
            is_compiled=True,
            legacy_flag="true",
        )
        is False
    )


def test_capabilities_require_structured_core_and_report_legacy(monkeypatch):
    class FakeNative:
        logo_vectorize_structured_rgba = staticmethod(lambda *_args, **_kwargs: None)

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)

    capabilities = logo_worker.logo_vectorizer_capabilities()

    assert capabilities == {
        "engine": "prynx-logo-core",
        "version": "test-core",
        "cancellable": True,
        "structured_result": True,
        "result_schema_version": 1,
        "legacy_engine": "fake-vtracer",
        "legacy_version": "test-legacy",
    }


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


def test_palette_keeps_connected_small_brand_accent_with_warning():
    """§LR3.02: dấu màu liên kết dưới 1% không được biến mất im lặng."""

    source = Image.new("RGB", (200, 200), "#ffffff")
    source.paste("#1565c0", (0, 0, 100, 100))
    source.paste("#d71920", (150, 150, 160, 160))

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    assert any(item.color == "#d71920" for item in suggestions)
    accent = next(item for item in suggestions if item.color == "#d71920")
    assert accent.coverage_ratio == pytest.approx(0.0025)
    assert any("màu nhấn nhỏ" in warning and "1%" in warning for warning in warnings)


def test_palette_drops_disconnected_small_speckles_without_accent_warning():
    """§LR3.02: cùng coverage nhưng nhiễu rời không được nâng thành màu logo."""

    source = Image.new("RGB", (200, 200), "#ffffff")
    for y in range(0, 200, 20):
        for x in range(0, 200, 20):
            source.putpixel((x, y), (215, 25, 32))

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    assert [item.color for item in suggestions] == ["#ffffff"]
    assert not any("màu nhấn nhỏ" in warning for warning in warnings)


def test_jpeg_holdout_keeps_connected_small_brand_accent():
    """§LR2.03/§LR3.02: giữ màu nhấn qua nhiễu nén JPEG, không chỉ PNG phẳng."""

    source = Image.new("RGB", (240, 160), "#f8f8f8")
    source.paste("#1565c0", (0, 0, 120, 160))
    source.paste("#d71920", (204, 132, 216, 140))
    encoded = BytesIO()
    source.save(encoded, format="JPEG", quality=88, subsampling=2)

    suggestions, warnings = logo_worker.suggest_logo_palette(
        encoded.getvalue(),
        LogoRebuildSettings(mode="monochrome"),
    )

    def distance_from_red(color: str) -> float:
        channels = tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))
        return sum((actual - expected) ** 2 for actual, expected in zip(channels, (215, 25, 32))) ** 0.5

    accents = [item for item in suggestions if distance_from_red(item.color) < 70]
    assert accents, ([item.model_dump() for item in suggestions], warnings)
    assert any(item.coverage_ratio < 0.01 for item in accents)
    assert any("màu nhấn nhỏ" in warning for warning in warnings)


@pytest.mark.parametrize(
    "memory_status",
    [(32 * 1024, 24 * 1024), (12 * 1024, 8 * 1024), (6 * 1024, 4 * 1024), (None, None)],
    ids=["ram-32gb", "ram-12gb", "ram-6gb", "ram-unreadable"],
)
def test_palette_keeps_absolute_small_accent_on_high_res_scan(
    monkeypatch, memory_status
):
    """§LR4.02: dấu 15×15 px trên scan 2000×2000 (coverage 0,0056% — dưới sàn
    tương đối 0,1%) phải vào gợi ý nhờ lưới accent dày + sàn tuyệt đối px nguồn,
    ở mọi tier RAM."""

    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: memory_status)
    source = Image.new("RGB", (2000, 2000), "#ffffff")
    source.paste("#d71920", (1000, 1000, 1015, 1015))

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    def distance_from_red(color: str) -> float:
        channels = tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))
        return sum(
            (actual - expected) ** 2 for actual, expected in zip(channels, (215, 25, 32))
        ) ** 0.5

    accents = [item for item in suggestions if distance_from_red(item.color) < 70]
    assert accents, ([item.model_dump() for item in suggestions], warnings)
    assert any(item.coverage_ratio < 0.001 for item in accents)
    assert any("màu nhấn nhỏ" in warning for warning in warnings)


def test_palette_high_res_scan_does_not_promote_disconnected_speckles(monkeypatch):
    """§LR4.02: sàn tuyệt đối không được nâng nhiễu rời trên scan lớn thành màu."""

    monkeypatch.setattr(
        logo_worker, "read_memory_status_mb", lambda: (32 * 1024, 24 * 1024)
    )
    rng = random.Random(20260813)
    source = Image.new("RGB", (2000, 2000), "#ffffff")
    for _ in range(400):
        x = rng.randrange(0, 1998)
        y = rng.randrange(0, 1998)
        source.putpixel((x, y), (215, 25, 32))

    suggestions, warnings = logo_worker.suggest_logo_palette(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )

    assert [item.color for item in suggestions] == ["#ffffff"]
    assert not any("màu nhấn nhỏ" in warning for warning in warnings)


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


def test_fully_transparent_preview_is_rejected_before_native(monkeypatch):
    calls = {"trace": 0}

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(*_args, **_kwargs):
            calls["trace"] += 1
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg"/>', 32, 32, "fixed_palette"
            )

    source = Image.new("RGBA", (32, 32), (12, 34, 56, 0))
    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/logo-rebuild/preview",
            files={"file": ("transparent.png", _image_bytes(source), "image/png")},
            data={
                "settings_json": '{"mode":"fixed_palette","palette":["#111111"]}',
                "job_id": "708f7941-86d3-4e2d-8eb9-e0c7c59c7829",
            },
        )
        health = client.get("/health")

    assert response.status_code == 422, response.text
    assert "không có pixel nhìn thấy" in response.json()["detail"]
    assert calls["trace"] == 0
    assert health.status_code == 200
    assert "708f7941-86d3-4e2d-8eb9-e0c7c59c7829" not in logo_worker._ACTIVE_JOBS


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

    class FakeToken:
        def is_cancelled(self):
            return False

    token = FakeToken()

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
            engine="prynx-logo-core",
            engine_version="test-core",
            status="review",
            complexity={
                "path_count": 1200,
                "drawable_path_count": 1200,
                "node_count": 6000,
                "tiny_path_count": 1100,
                "tiny_path_ratio": 0.916667,
                "svg_bytes": 123456,
                "removed_redundant_paths": 42,
            },
            review_reasons=["SVG còn nhiều mảng nhỏ, khó chỉnh sửa."],
            review_actions=["Tăng mức khử hạt rồi tạo lại preview."],
            physical_width_mm=20.0,
            physical_height_mm=10.0,
            result_schema_version=1,
            artifact_sha256="c" * 64,
            preprocess_hash="d" * 64,
            native_metrics={
                "layer_count": 2,
                "component_count": 2,
                "outer_count": 2,
                "hole_count": 1,
                "source_nodes": 40,
                "output_nodes": 16,
                "max_error_px": 0.25,
                "raster_scale": 4,
                "iou": 0.99,
                "mae": 0.01,
            },
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
    assert payload["status"] == "review"
    assert payload["complexity"]["path_count"] == 1200
    assert payload["complexity"]["removed_redundant_paths"] == 42
    assert payload["review_reasons"] == ["SVG còn nhiều mảng nhỏ, khó chỉnh sửa."]
    assert payload["review_actions"] == ["Tăng mức khử hạt rồi tạo lại preview."]
    assert payload["physical_width_mm"] == pytest.approx(20.0)
    assert payload["physical_height_mm"] == pytest.approx(10.0)
    assert payload["engine"] == "prynx-logo-core"
    assert payload["engine_version"] == "test-core"
    assert payload["result_schema_version"] == 1
    assert payload["artifact_sha256"] == "c" * 64
    assert payload["preprocess_hash"] == "d" * 64
    assert payload["native_metrics"]["iou"] == pytest.approx(0.99)
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


def test_memory_reservation_blocks_concurrent_overcommit_and_releases(monkeypatch):
    """Hai job không được cùng cam kết một ảnh chụp RAM khả dụng."""

    monkeypatch.setattr(
        logo_worker,
        "read_memory_status_mb",
        lambda: (32 * 1024.0, 12 * 1024.0),
    )
    monkeypatch.setattr(logo_worker, "_RESERVED_LOGO_MEMORY_MB", 0.0)

    with logo_worker._reserve_logo_work_size(8000, 8000) as (planned, warnings):
        assert planned == (8000, 8000)
        assert warnings == []
        assert logo_worker._RESERVED_LOGO_MEMORY_MB > 6800
        with pytest.raises(logo_worker.LogoInputError, match="không còn đủ bộ nhớ"):
            with logo_worker._reserve_logo_work_size(8000, 8000):
                pytest.fail("job cạnh tranh không được admission")

    assert logo_worker._RESERVED_LOGO_MEMORY_MB == pytest.approx(0.0)

    with pytest.raises(RuntimeError, match="lỗi mô phỏng"):
        with logo_worker._reserve_logo_work_size(2000, 2000):
            raise RuntimeError("lỗi mô phỏng")
    assert logo_worker._RESERVED_LOGO_MEMORY_MB == pytest.approx(0.0)


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


def test_curve_preset_keeps_core_source_resolution_and_preserves_legacy_upscale(
    monkeypatch,
):
    """Preset mới đo sai số theo px nguồn; pipeline cũ vẫn giữ upscale lịch sử."""

    monkeypatch.setattr(
        logo_worker, "read_memory_status_mb", lambda: (32 * 1024.0, 24 * 1024.0)
    )
    source = _monochrome_logo_bytes((128, 128))

    assert logo_worker._requested_logo_work_size(
        source,
        LogoRebuildSettings(mode="monochrome", curve_preset="automatic"),
    ) == (128, 128)
    assert logo_worker._requested_logo_work_size(
        source,
        LogoRebuildSettings(mode="monochrome"),
    ) == (1200, 1200)
    assert logo_worker._requested_logo_work_size(
        source,
        LogoRebuildSettings(mode="monochrome", engine="vtracer"),
    ) == (1200, 1200)


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
    assert resized.getpixel((399, 600)) == (0, 0, 0, 0)
    assert resized.getpixel((400, 600)) == (0, 0, 0, 255)
    assert any("nội suy giữ biên" in warning for warning in prepared.warnings)


@pytest.mark.parametrize(
    ("mode", "expected_status"),
    [("monochrome", "review"), ("fixed_palette", "ready")],
)
def test_worker_scales_despeckle_area_with_upscale(
    monkeypatch, mode: str, expected_status: str
):
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
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, _rgba, mode, **kwargs):
            calls.update(
                width=width,
                height=height,
                despeckle_size_px=kwargs["despeckle_size_px"],
            )
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M0 0H200V100H0Z" fill="#000000"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda _width, _height: (200, 100)
    )

    result = logo_worker.process_logo_preview(
        _monochrome_logo_bytes((100, 50)),
        LogoRebuildSettings(
            mode=mode,
            palette=["#000000"] if mode == "fixed_palette" else [],
            despeckle_size_px=4,
            physical_width_mm=50.0,
            physical_height_mm=25.0,
        ),
        "scaled-despeckle-test",
    )

    assert calls == {"width": 200, "height": 100, "despeckle_size_px": 8}
    assert result.engine == "prynx-logo-core"
    assert result.engine_version == "test-core"
    assert result.result_schema_version == 1
    assert result.artifact_sha256 is not None
    assert result.preprocess_hash == "b" * 64
    assert result.native_metrics is not None
    assert result.native_metrics["iou"] == 1.0
    assert result.native_metrics["artifact_max_tangent_jump_degrees"] == 90.0
    assert result.status == expected_status
    assert any("4 px" in warning and "8 px" in warning for warning in result.warnings)
    has_pending_despeckle = any(
        "chưa áp dụng khử hạt" in reason for reason in result.review_reasons
    )
    assert has_pending_despeckle is (mode == "monochrome")
    # LOGO-REBUILD (audit 2026-08-13 §LR4.01): ảnh upscale + despeckle > 0 phải
    # cảnh báo rõ ngưỡng chi tiết bị mất (chỉ FlatColor mới thực thi khử hạt).
    has_loss_warning = any(
        "gộp mọi chi tiết nhỏ hơn 4×4 px" in warning for warning in result.warnings
    )
    assert has_loss_warning is (mode == "fixed_palette")


def test_scaled_despeckle_size_keeps_source_pixel_semantics():
    """§LR4.01: đơn vị khử hạt là px ảnh nguồn, quy đổi theo sqrt(diện tích)."""

    # Upscale 100×100 → 1200×1200 (scale diện tích 144): cạnh 4 px nguồn = 48 px làm việc.
    assert logo_worker._scaled_despeckle_size(4, 144.0) == 48
    # Không upscale thì giữ nguyên.
    assert logo_worker._scaled_despeckle_size(4, 1.0) == 4
    # Downscale (máy yếu giảm ảnh làm việc) thì thu nhỏ tương ứng nhưng không về 0.
    assert logo_worker._scaled_despeckle_size(4, 0.25) == 2
    assert logo_worker._scaled_despeckle_size(1, 0.01) == 1
    # Tắt khử hạt phải giữ nguyên 0 ở mọi hệ số.
    assert logo_worker._scaled_despeckle_size(0, 144.0) == 0
    # Trần an toàn của engine.
    assert logo_worker._scaled_despeckle_size(64, 16.0) == 128


@pytest.mark.parametrize(
    ("despeckle_size_px", "expect_mark_kept"),
    [(0, True), (4, False)],
)
def test_small_source_mark_survival_depends_on_despeckle_real_engine(
    despeckle_size_px: int, expect_mark_kept: bool
):
    """Regression §LR4.01: dấu 3×3 px nguồn trên logo 100×100 qua engine thật.

    Khử hạt tính theo px nguồn nên 4 px nuốt dấu 3×3 (9 < 4² px nguồn) bất kể
    hệ số upscale theo tier RAM; 0 px phải giữ nguyên dấu.
    """

    pytest.importorskip("pdfcompare_native")
    image = Image.new("RGB", (100, 100), (255, 255, 255))
    image.paste((215, 25, 32), (50, 50, 53, 53))
    result = logo_worker.process_logo_preview(
        _image_bytes(image),
        LogoRebuildSettings(
            mode="fixed_palette",
            palette=["#ffffff", "#d71920"],
            despeckle_size_px=despeckle_size_px,
            physical_width_mm=25.0,
            physical_height_mm=25.0,
        ),
        f"lr401-mark-{despeckle_size_px}",
    )
    assert ("#d71920" in result.svg) is expect_mark_kept


def test_curve_preset_reconstructs_small_raster_circle_through_real_worker():
    """Regression 2026-08-25: upscale NEAREST không được biến circle thành bậc thang."""

    pytest.importorskip("pdfcompare_native")
    width = height = 128
    radius = 44.0
    source = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pixels = source.load()
    for y in range(height):
        for x in range(width):
            dx = (x + 0.5 - width * 0.5) / radius
            dy = (y + 0.5 - height * 0.5) / radius
            if dx * dx + dy * dy <= 1.0:
                pixels[x, y] = (0, 0, 0, 255)

    result = logo_worker.process_logo_preview(
        _image_bytes(source),
        LogoRebuildSettings(
            mode="monochrome",
            curve_preset="automatic",
            despeckle_size_px=0,
            physical_width_mm=32.0,
            physical_height_mm=32.0,
        ),
        "curve-preset-circle-real-worker",
    )

    assert (result.width_px, result.height_px) == (128, 128)
    assert result.native_metrics is not None
    assert result.native_metrics["output_nodes"] == 4
    assert result.native_metrics["line_segments"] == 0
    assert result.native_metrics["cubic_segments"] == 4
    assert result.native_metrics["circle_count"] == 1


def test_structured_contract_error_never_falls_back_to_vtracer(monkeypatch):
    calls = {"legacy": 0}

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, _rgba, mode, **kwargs):
            result = _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M8 8H24V24H8Z" fill="#000000"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )
            result["artifact"]["sha256"] = "0" * 64
            return result

        @staticmethod
        def logo_vectorize_rgba(*_args, **_kwargs):
            calls["legacy"] += 1
            return '<svg xmlns="http://www.w3.org/2000/svg"/>'

    source = Image.new("RGB", (32, 32), (255, 255, 255))
    source.paste((0, 0, 0), (8, 8, 24, 24))
    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )

    with pytest.raises(RuntimeError, match="hash artifact"):
        logo_worker.process_logo_preview(
            _image_bytes(source),
            LogoRebuildSettings(mode="monochrome", despeckle_size_px=0),
            "structured-no-fallback",
        )

    assert calls["legacy"] == 0


def test_native_value_error_becomes_input_error_not_500(monkeypatch):
    """§LR4.03: lệch hợp đồng ở biên Rust phải ra LogoInputError (422 kèm
    nguyên nhân), không bị gói thành RuntimeError 500 mù thông tin."""

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(*_args, **_kwargs):
            raise ValueError("Nhãn background nằm ngoài palette")

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )

    with pytest.raises(logo_worker.LogoInputError, match="Nhãn background"):
        logo_worker.process_logo_preview(
            _monochrome_logo_bytes((32, 32)),
            LogoRebuildSettings(mode="monochrome", despeckle_size_px=0),
            "native-value-error-422",
        )


def test_prepare_logo_image_cancels_between_heavy_steps():
    """§LR4.04: nút Hủy phải cắt được giữa các bước prepare, không đợi hết."""

    calls = {"count": 0}

    def cancel_after_first_checkpoint() -> bool:
        calls["count"] += 1
        return calls["count"] > 1

    with pytest.raises(logo_worker.LogoJobCancelled):
        logo_worker.prepare_logo_image(
            _monochrome_logo_bytes((640, 640)),
            LogoRebuildSettings(mode="monochrome", illumination_correction=True),
            cancel_check=cancel_after_first_checkpoint,
        )
    assert calls["count"] > 1


def test_reserve_logo_work_size_serializes_when_memory_unreadable(monkeypatch):
    """§LR4.05: không đo được RAM thì giữ nguyên kích thước nhưng chỉ một job
    Logo mỗi lúc; job xong phải trả slot."""

    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))

    with logo_worker._reserve_logo_work_size(800, 600) as (size, memory_warnings):
        assert size == (800, 600)
        assert memory_warnings == []
        with pytest.raises(logo_worker.LogoInputError, match="Không đo được RAM"):
            with logo_worker._reserve_logo_work_size(400, 300):
                pass

    with logo_worker._reserve_logo_work_size(400, 300) as (size, _memory_warnings):
        assert size == (400, 300)


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


def test_crop_dimensions_and_mm_use_quantized_pixel_box():
    """Regression §LR5.05: UI/worker dùng cùng box 106×60 cho crop 33% trên 320×180."""

    settings = LogoRebuildSettings.model_validate({
        "mode": "fixed_palette",
        "palette": ["#ff0000"],
        "crop": {"x": 0.0, "y": 0.0, "width": 0.33, "height": 0.33},
        "physical_width_mm": 10.0,
        "physical_height_mm": round(10.0 * 60.0 / 106.0, 6),
    })
    assert logo_worker._target_dimensions(320, 180, settings) == (106, 60)
    prepared = logo_worker.prepare_logo_image(
        _encoded_image("PNG", size=(320, 180)),
        settings,
        planned_size=(106, 60),
        memory_warnings=[],
    )
    assert (prepared.width_px, prepared.height_px) == (106, 60)


def test_tiny_mm_rounding_stays_within_ratio_contract():
    """Regression §LR5.05: cặp mm rất nhỏ vẫn qua writer tolerance sau UI rounding."""

    settings = LogoRebuildSettings(
        mode="fixed_palette",
        palette=["#ff0000"],
        physical_width_mm=0.1,
        physical_height_mm=round(0.1 * 100.0 / 314.0, 6),
    )
    prepared = logo_worker.prepare_logo_image(
        _encoded_image("PNG", size=(314, 100)),
        settings,
        planned_size=(314, 100),
        memory_warnings=[],
    )
    assert (prepared.width_px, prepared.height_px) == (314, 100)


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
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, rgba, mode, **kwargs):
            calls.update(
                width=width,
                height=height,
                rgba_size=len(rgba),
                mode=mode,
                palette=kwargs["palette"],
                smoothing=kwargs["smoothing"],
            )
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M0 0H50V40H0Z" fill="#ff0000"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

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


def test_partial_alpha_is_explicitly_flagged_for_review():
    """Regression §LR5.03: alpha 1–254 không được coi là artifact opaque đã đạt."""

    source = Image.new("RGBA", (16, 16), (255, 0, 0, 0))
    source.putpixel((8, 8), (255, 0, 0, 1))
    source.putpixel((9, 8), (255, 0, 0, 255))
    prepared = logo_worker.prepare_logo_image(
        _image_bytes(source),
        LogoRebuildSettings(mode="fixed_palette", palette=["#ff0000"]),
        planned_size=(16, 16),
        memory_warnings=[],
    )
    assert prepared.partial_alpha is True
    assert any("alpha bán trong suốt" in warning for warning in prepared.warnings)


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
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, rgba, mode, **kwargs):
            center_offset = ((height // 2) * width + width // 2) * 4
            calls["center"] = tuple(rgba[center_offset : center_offset + 4])
            calls["outside"] = tuple(rgba[0:4])
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M16 16H48V48H16Z" fill="#000000"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

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
    assert calls["outside"] == (0, 0, 0, 0)
    assert any("bỏ qua cân bằng ánh sáng" in warning for warning in result.warnings)
    assert "transparent-monochrome-test" not in logo_worker._ACTIVE_JOBS


@pytest.mark.parametrize(
    ("background", "logo"),
    [
        ((255, 255, 255), (255, 220, 0)),
        ((24, 24, 24), (245, 245, 245)),
    ],
)
def test_monochrome_detects_background_polarity_and_light_ink(
    monkeypatch, background, logo
):
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    source = Image.new("RGB", (64, 64), background)
    source.paste(logo, (16, 16, 48, 48))

    prepared = logo_worker.prepare_logo_image(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )
    bitmap = Image.frombytes("RGBA", (prepared.width_px, prepared.height_px), prepared.rgba)

    assert bitmap.getpixel((0, 0)) == (0, 0, 0, 0)
    assert bitmap.getpixel((32, 32)) == (0, 0, 0, 255)
    assert any("nền sáng/tối" in warning for warning in prepared.warnings)


def test_monochrome_edge_touch_is_flagged_for_manual_review(monkeypatch):
    """Regression §LR5.04: khung mực chạm biên không bị đảo âm thầm."""

    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    source = Image.new("RGB", (100, 100), (255, 255, 255))
    for x in range(100):
        source.putpixel((x, 0), (0, 0, 0))
        source.putpixel((x, 99), (0, 0, 0))
    for y in range(100):
        source.putpixel((0, y), (0, 0, 0))
        source.putpixel((99, y), (0, 0, 0))

    prepared = logo_worker.prepare_logo_image(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
    )
    bitmap = Image.frombytes("RGBA", (prepared.width_px, prepared.height_px), prepared.rgba)
    assert prepared.polarity_ambiguous is True
    assert bitmap.getpixel((0, 0))[3] == 255
    assert bitmap.getpixel((50, 50))[3] == 0
    assert any("chạm biên ảnh" in warning for warning in prepared.warnings)


def test_monochrome_empty_svg_is_returned_as_rejected(monkeypatch):
    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, _rgba, mode, **kwargs):
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg"/>',
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )

    source = Image.new("RGB", (64, 64), (255, 255, 255))
    source.paste((0, 0, 0), (16, 16, 48, 48))
    result = logo_worker.process_logo_preview(
        _image_bytes(source),
        LogoRebuildSettings(mode="monochrome"),
        "empty-monochrome-test",
    )

    assert result.status == "rejected"
    assert result.complexity["drawable_path_count"] == 0
    assert result.review_actions


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
            return _fake_native_info()

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    settings = LogoRebuildSettings(mode="monochrome", illumination_correction=False)
    token = logo_worker.reserve_logo_job("queued-job")
    assert logo_worker.cancel_logo_job("queued-job") is True

    with pytest.raises(logo_worker.LogoJobCancelled):
        logo_worker.process_logo_preview(b"unused", settings, "queued-job", token)
    assert "queued-job" not in logo_worker._ACTIVE_JOBS


def test_metadata_failure_cleans_reserved_job(monkeypatch):
    """§LR3.08: logo_vectorizer_info lỗi vẫn phải giải phóng UUID."""

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            raise RuntimeError("ABI metadata failure")

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    token = logo_worker.reserve_logo_job("metadata-failure")

    with pytest.raises(RuntimeError, match="ABI metadata failure"):
        logo_worker.process_logo_preview(
            b"unused",
            LogoRebuildSettings(mode="monochrome"),
            "metadata-failure",
            token,
        )

    assert "metadata-failure" not in logo_worker._ACTIVE_JOBS


def test_route_releases_reservation_when_queue_cancelled(monkeypatch):
    class FakeCancel:
        def is_cancelled(self):
            return True

    token = FakeCancel()
    released: list[tuple[str, object]] = []

    async def fake_scheduled(*_args, **_kwargs):
        raise logo_route.HeavyJobQueueCancelled("đã hủy khi chờ")

    monkeypatch.setattr(logo_route, "reserve_logo_job", lambda _job_id: token)
    monkeypatch.setattr(logo_route, "run_scheduled_in_threadpool", fake_scheduled)
    monkeypatch.setattr(
        logo_route,
        "release_logo_job",
        lambda job_id, received: released.append((job_id, received)),
    )
    job_id = UUID("c5dc1432-0293-4ca5-a18d-8ac2df17e889")

    with TestClient(app) as client:
        response = client.post(
            "/api/logo-rebuild/preview",
            files={"file": ("logo.png", _encoded_image("PNG"), "image/png")},
            data={
                "settings_json": '{"mode":"monochrome"}',
                "job_id": str(job_id),
            },
        )

    assert response.status_code == 409
    assert released == [(str(job_id), token)]


def test_logo_queue_waiter_does_not_hold_thread_token_and_can_cancel(monkeypatch):
    """§LR3.01: waiter Logo không được làm nghẹt endpoint DELETE đồng bộ."""

    monkeypatch.setattr(
        scheduler,
        "_HEAVY_JOB_SLOTS",
        threading.BoundedSemaphore(1),
    )

    async def scenario():
        release_first = threading.Event()
        first_started = threading.Event()
        cancel_second = threading.Event()
        second_ran = threading.Event()
        second_errors: list[BaseException] = []
        probe_ran = threading.Event()
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous_total = limiter.total_tokens
        limiter.total_tokens = 2

        def first_job():
            first_started.set()
            release_first.wait(5)

        async def run_first():
            await scheduler.run_scheduled_in_threadpool("logo-rebuild", first_job)

        async def run_second():
            try:
                await scheduler.run_scheduled_in_threadpool(
                    "logo-rebuild",
                    second_ran.set,
                    queue_cancelled=cancel_second.is_set,
                )
            except BaseException as exc:  # noqa: BLE001 - kiểm đúng kiểu ở dưới
                second_errors.append(exc)

        try:
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(run_first)
                for _ in range(100):
                    if first_started.is_set():
                        break
                    await anyio.sleep(0.01)
                assert first_started.is_set()

                task_group.start_soon(run_second)
                for _ in range(100):
                    if scheduler._WAITING_BY_KIND.get("logo-rebuild", 0) >= 1:
                        break
                    await anyio.sleep(0.01)

                with anyio.fail_after(1):
                    await anyio.to_thread.run_sync(probe_ran.set)
                assert probe_ran.is_set()

                cancel_second.set()
                for _ in range(100):
                    if second_errors:
                        break
                    await anyio.sleep(0.01)
                release_first.set()
        finally:
            release_first.set()
            limiter.total_tokens = previous_total

        assert not second_ran.is_set()
        assert len(second_errors) == 1
        assert isinstance(second_errors[0], scheduler.HeavyJobQueueCancelled)

    anyio.run(scenario)


def test_core_background_uses_label_and_skips_legacy_cleanup(monkeypatch):
    from app.workers import logo_svg_cleanup

    calls: dict[str, object] = {}

    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, _rgba, mode, **kwargs):
            calls["palette"] = kwargs["palette"]
            calls["background_label"] = kwargs["background_label"]
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M2 2H8V8H2Z" fill="#ef4444"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    monkeypatch.setattr(
        logo_svg_cleanup,
        "cleanup_redundant_logo_paths",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Core artifact không được đi qua legacy cleanup")
        ),
    )
    result = logo_worker.process_logo_preview(
        _encoded_image("PNG", size=(10, 10)),
        LogoRebuildSettings(
            mode="fixed_palette",
            palette=["#ef4444"],
            background_color="#233d69",
            despeckle_size_px=0,
        ),
        "core-background-label",
    )

    assert calls == {"palette": ["#ef4444", "#233d69"], "background_label": 1}
    assert "#233d69" not in result.svg.lower()
    assert "prynx-background-cutout" not in result.svg
    assert result.artifact_sha256 == hashlib.sha256(result.svg.encode("utf-8")).hexdigest()


def test_worker_removes_confirmed_background_color_from_legacy_svg(monkeypatch):
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
            return _fake_native_info()

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
            "engine": "vtracer",
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


def test_worker_masks_compound_background_path_with_counters():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
        '<path d="M0 0H10V10H0Z" fill="#EF4444"/>'
        '<path d="M0 0H10V10H0Z M2 2H8V8H2Z M4 4H6V6H4Z" '
        'fill="#233D69" fill-rule="evenodd"/>'
        "</svg>"
    )

    stripped, removed = logo_worker._strip_svg_background(svg, "#233d69")

    assert removed == 1
    assert "#233D69" not in stripped
    root = logo_worker.ElementTree.fromstring(stripped)
    namespace = "{http://www.w3.org/2000/svg}"
    mask = root.find(f".//{namespace}mask")
    assert mask is not None
    mask_path = mask.find(f"{namespace}path")
    assert mask_path is not None
    assert mask_path.attrib["fill"] == "#000000"
    assert mask_path.attrib["fill-rule"] == "evenodd"
    assert mask_path.attrib["d"].count("M") == 3
    masked_group = root.find(f"./{namespace}g")
    assert masked_group is not None
    assert masked_group.attrib["mask"] == "url(#prynx-background-cutout)"


def test_svg_cleanup_removes_only_redundant_same_color_fragments():
    from app.workers.logo_svg_cleanup import cleanup_redundant_logo_paths

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<path d="M0 0H100V100H0Z" fill="#0066cc"/>'
        '<path d="M10 10H10.5V10.5H10Z" fill="#0066cc"/>'
        '<path d="M20 20H20.5V20.5H20Z" fill="#0066cc"/>'
        "</svg>"
    )

    result = cleanup_redundant_logo_paths(svg, 100, 100)

    assert result.removed_path_count == 2
    root = logo_worker.ElementTree.fromstring(result.svg)
    paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    assert len(paths) == 1


def test_svg_cleanup_keeps_fragment_that_restores_color_over_another_layer():
    from app.workers.logo_svg_cleanup import cleanup_redundant_logo_paths

    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<path d="M0 0H100V100H0Z" fill="#0066cc"/>'
        '<path d="M9 9H12V12H9Z" fill="#ffffff"/>'
        '<path d="M10 10H10.5V10.5H10Z" fill="#0066cc"/>'
        "</svg>"
    )

    result = cleanup_redundant_logo_paths(svg, 100, 100)

    assert result.removed_path_count == 0
    root = logo_worker.ElementTree.fromstring(result.svg)
    paths = root.findall(".//{http://www.w3.org/2000/svg}path")
    assert len(paths) == 3


def test_svg_quality_preserves_counter_and_rejects_empty_geometry():
    from app.workers.logo_svg_cleanup import analyze_logo_svg, cleanup_redundant_logo_paths

    ring = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<path d="M10 10H90V90H10Z M40 40V60H60V40Z" fill="#0066cc"/>'
        "</svg>"
    )
    cleaned = cleanup_redundant_logo_paths(ring, 100, 100)
    assert cleaned.removed_path_count == 0
    assert cleaned.svg.count("M") == 2

    rejected = analyze_logo_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"/>',
        100,
        100,
    )
    assert rejected.status == "rejected"
    assert rejected.complexity.drawable_path_count == 0
    assert any("không có mảng vector" in reason for reason in rejected.reasons)


def test_svg_quality_marks_excessive_object_count_for_review():
    from app.workers.logo_svg_cleanup import analyze_logo_svg

    paths = "".join(
        f'<path d="M{x} {y}H{x + 1}V{y + 1}H{x}Z" fill="#0066cc"/>'
        for index in range(1001)
        for x, y in [(index % 100, index // 100)]
    )
    quality = analyze_logo_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
        + paths
        + "</svg>",
        200,
        200,
    )

    assert quality.status == "review"
    assert quality.complexity.path_count == 1001
    assert quality.reasons
    assert quality.actions


def test_svg_uses_only_confirmed_physical_size_and_not_dpi_metadata(monkeypatch):
    class FakeCancel:
        def cancel(self):
            return None

        def is_cancelled(self):
            return False

    class FakeNative:
        LogoVectorizerCancel = FakeCancel

        @staticmethod
        def logo_vectorizer_info():
            return _fake_native_info()

        @staticmethod
        def logo_vectorize_structured_rgba(width, height, _rgba, mode, **kwargs):
            return _fake_structured_result(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                '<path d="M0 0H10V10H0Z" fill="#000000"/>'
                "</svg>",
                width,
                height,
                mode,
                physical_width_mm=kwargs["physical_width_mm"],
                physical_height_mm=kwargs["physical_height_mm"],
            )

    monkeypatch.setattr(logo_worker, "_load_native_module", lambda: FakeNative)
    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    roots = []
    for dpi, job_id in ((72, "svg-dpi-72"), (300, "svg-dpi-300")):
        result = logo_worker.process_logo_preview(
            _monochrome_logo_bytes((600, 600), dpi=(dpi, dpi)),
            LogoRebuildSettings(mode="monochrome"),
            job_id,
        )
        roots.append(logo_worker.ElementTree.fromstring(result.svg))
        assert result.physical_width_mm is None
        assert result.physical_height_mm is None
        assert result.status == "review"
        assert any("kích thước in" in reason.lower() for reason in result.review_reasons)

    assert roots[0].attrib["viewBox"] == "0 0 600 600"
    assert roots[0].attrib["width"] == roots[1].attrib["width"] == "600"
    assert roots[0].attrib["height"] == roots[1].attrib["height"] == "600"

    confirmed = logo_worker.process_logo_preview(
        _monochrome_logo_bytes((600, 600), dpi=(72, 72)),
        LogoRebuildSettings(
            mode="monochrome",
            despeckle_size_px=0,
            physical_width_mm=50.8,
            physical_height_mm=50.8,
        ),
        "svg-confirmed-mm",
    )
    confirmed_root = logo_worker.ElementTree.fromstring(confirmed.svg)

    assert confirmed.status == "ready"
    assert confirmed.physical_width_mm == pytest.approx(50.8)
    assert confirmed.physical_height_mm == pytest.approx(50.8)
    assert confirmed_root.attrib["width"] == "50.8mm"
    assert confirmed_root.attrib["height"] == "50.8mm"


def test_physical_size_contract_requires_pair_and_preserves_aspect_ratio(monkeypatch):
    with pytest.raises(ValueError, match="đồng thời"):
        LogoRebuildSettings(mode="monochrome", physical_width_mm=50.0)

    monkeypatch.setattr(logo_worker, "read_memory_status_mb", lambda: (None, None))
    monkeypatch.setattr(
        logo_worker, "_upscale_target_dimensions", lambda width, height: (width, height)
    )
    with pytest.raises(logo_worker.LogoInputError, match="tỷ lệ"):
        logo_worker.prepare_logo_image(
            _encoded_image("PNG", size=(200, 100)),
            LogoRebuildSettings(
                mode="monochrome",
                physical_width_mm=50.0,
                physical_height_mm=50.0,
            ),
        )
    with pytest.raises(logo_worker.LogoInputError, match="tỷ lệ"):
        logo_worker.prepare_logo_image(
            _encoded_image("PNG", size=(200, 100)),
            LogoRebuildSettings(
                mode="monochrome",
                physical_width_mm=50.0,
                physical_height_mm=25.1,
            ),
        )


def test_output_artifact_qc_rejects_wrong_confirmed_mm():
    from app.workers.logo_svg_cleanup import analyze_logo_svg

    quality = analyze_logo_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" '
        'width="49mm" height="25mm">'
        '<path d="M0 0H100V50H0Z" fill="#1565c0"/>'
        "</svg>",
        100,
        50,
        expected_physical_size_mm=(50.0, 25.0),
        require_physical_size=True,
    )

    assert quality.status == "rejected"
    assert any("kích thước vật lý" in reason.lower() for reason in quality.reasons)


def test_independent_qc_rejects_structured_artifact_hash_drift():
    from app.workers.logo_svg_cleanup import analyze_logo_svg

    quality = analyze_logo_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" '
        'width="10" height="10">'
        '<path d="M0 0H10V10H0Z" fill="#1565c0"/>'
        "</svg>",
        10,
        10,
        expected_artifact_sha256="0" * 64,
    )

    assert quality.status == "rejected"
    assert any("hash svg" in reason.lower() for reason in quality.reasons)
