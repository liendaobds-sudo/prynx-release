"""Regression cho preview/adaptive RGB → CMYK không công bố artifact."""

from __future__ import annotations

import asyncio
import base64
import io
import threading
import time
import zlib
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from skimage.color import deltaE_ciede2000 as skimage_delta_e00

from app.api.routes import preflight as preflight_routes
from app.core import color_conversion_preview as preview
from app.core.license_guard import require_license
from app.main import app
from app.schemas.preflight import ConvertColorsPreviewResponse


def _png_b64(rgb: tuple[int, int, int], size: tuple[int, int] = (4, 3)) -> str:
    image = Image.new("RGB", size, rgb)
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _plate(name: str, value: int, *, spot: bool = False) -> dict:
    raw = bytes([value]) * 12
    return {
        "name": name,
        "alpha_data": base64.b64encode(zlib.compress(raw)).decode("ascii"),
        "is_spot": spot,
    }


def _trusted_tac(value: int = 0) -> dict:
    return {
        "engine": "ppe",
        "width": 4,
        "height": 3,
        "plates": [
            _plate("Cyan", value),
            _plate("Magenta", value),
            _plate("Yellow", value),
            _plate("Black", value),
            _plate("Brand Blue", 255, spot=True),
        ],
    }


def _metric(
    *,
    delta_l: float,
    delta_c: float = -5.0,
    mean_de: float = 2.4,
    p95_de: float = 7.0,
    highlight: float = 0.9,
    paper: float = 0.0,
) -> dict:
    return {
        "sample_pixels": 100,
        "delta_lstar_mean": delta_l,
        "delta_chroma_mean": delta_c,
        "delta_e00_mean": mean_de,
        "delta_e00_p95": p95_de,
        "new_highlight_clip_pct": highlight,
        "new_paper_white_pct": paper,
        "new_shadow_clip_pct": 0.0,
        "neutral_delta_e00_mean": 1.0,
        "skin_delta_e00_mean": 2.0,
        "out_of_gamut_pct": 0.0,
        "tac": {
            "available": True,
            "mean_pct": 120.0,
            "p95_pct": 220.0,
            "max_pct": 306.0,
            "engine": "ppe",
            "spot_excluded": True,
            "spot_plate_count": 1,
        },
    }


def _view(metrics: dict, *, trusted: bool = True, brightness: int = 0) -> dict:
    return {
        "adjustments": {
            "brightness_lstar": brightness,
            "contrast_percent": 0,
            "vibrance_percent": 0,
            "adjustment_stage": "post_cmyk",
        },
        "metrics": metrics,
        "trusted": trusted,
    }


def test_preview_response_rejects_untrusted_recommendation_that_passes_gates():
    """Schema phải chặn proof gần đúng bị gắn nhầm nhãn gợi ý an toàn."""

    metrics = _metric(delta_l=0.0)
    metrics["tac"]["available"] = False
    payload = {
        "success": True,
        "request_id": "contract-proof-gate",
        "page": 1,
        "requested_dpi": 150,
        "effective_dpi": 150,
        "effective_options": {"gamut_mapping": "icc"},
        "effective_adjustments": {
            "brightness_lstar": 1,
            "contrast_percent": 0,
            "vibrance_percent": 4,
            "adjustment_stage": "post_cmyk",
        },
        "preview": {
            "source_b64": _png_b64((255, 255, 255)),
            "output_b64": _png_b64((250, 250, 250)),
            "gamut_b64": None,
            "mime": "image/png",
            "width": 4,
            "height": 3,
            "proof_accuracy": "approximate",
            "proof_engine": "pdfium+lcms",
            "measurement_basis": "display_rgb_vs_approximate_softproof",
        },
        "metrics": metrics,
        "recommendation": {
            "policy": "balanced-v1",
            "status": "recommended",
            "gates_passed": True,
            "reason_codes": [],
        },
        "warnings": [],
    }

    with pytest.raises(ValueError, match="RIP soft-proof"):
        ConvertColorsPreviewResponse.model_validate(payload)


def test_delta_e00_numpy_matches_skimage_oracle():
    rng = np.random.default_rng(20260821)
    first = rng.uniform([0, -100, -100], [100, 100, 100], size=(16, 11, 3))
    second = rng.uniform([0, -100, -100], [100, 100, 100], size=(16, 11, 3))
    actual = preview.delta_e_ciede2000(first, second)
    expected = skimage_delta_e00(first, second)
    assert np.allclose(actual, expected, rtol=1e-11, atol=1e-11)


@pytest.mark.parametrize(
    ("ram_mb", "requested", "expected"),
    [
        (6 * 1024, 150, 72),
        (12 * 1024, 150, 100),
        (16 * 1024, 150, 150),
        (64 * 1024, 240, 240),
        (None, 150, 150),
    ],
)
def test_preview_dpi_only_reduces_on_low_memory(ram_mb, requested, expected):
    assert preview.effective_preview_dpi(
        requested,
        lambda: (ram_mb, None),
    ) == expected


def test_tac_only_sums_process_plates_and_requires_ppe():
    measured = preview.measure_tac(_trusted_tac(128))
    expected = 4 * 128 / 255 * 100
    assert measured["available"] is True
    assert measured["max_pct"] == pytest.approx(expected, abs=1e-4)
    assert measured["spot_excluded"] is True
    assert measured["spot_plate_count"] == 1

    approximate = dict(_trusted_tac(128), engine="pdfium_approx")
    assert preview.measure_tac(approximate)["available"] is False


def test_gamut_warning_uses_lcms_midgray_alarm_and_nonzero_source_metric():
    """Gamut warning must detect the LittleCMS 127 alarm, not fake zero."""

    from app.core.softproof import SoftProofEngine

    source = Image.new("RGB", (4, 1))
    source.putdata(
        [
            (0, 255, 255),
            (255, 0, 255),
            (127, 127, 127),
            (255, 255, 255),
        ]
    )
    overlay_b64, pct = SoftProofEngine().render_gamut_warning(
        source,
        profile_id="fogra39",
        intent="relative",
    )
    assert overlay_b64
    assert pct > 0.0
    with Image.open(io.BytesIO(base64.b64decode(overlay_b64))) as overlay:
        alpha = np.asarray(overlay.convert("RGBA"), dtype=np.uint8)[..., 3]
    assert int(np.count_nonzero(alpha)) == pytest.approx(
        pct / 100.0 * source.width,
        abs=1.0,
    )


def test_balanced_policy_selects_plus_one_and_rejects_plus_two_clip():
    baseline = _view(_metric(delta_l=-1.0))
    plus_one = _view(
        _metric(delta_l=0.2, mean_de=3.1, p95_de=6.8, highlight=2.3, paper=0.04),
        brightness=1,
    )
    plus_two = _view(
        _metric(delta_l=0.9, mean_de=3.5, p95_de=6.5, highlight=3.5, paper=0.05),
        brightness=2,
    )
    selected, reasons = preview.choose_balanced_candidate(
        baseline,
        [plus_one, plus_two],
    )
    assert selected["adjustments"]["brightness_lstar"] == 1
    assert "HIGHLIGHT_CLIP" in reasons
    assert "LIGHTNESS_OVERSHOOT" in reasons


@pytest.mark.asyncio
async def test_core_preview_uses_temp_candidates_and_returns_no_download_artifact(
    monkeypatch,
    tmp_path,
):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF\n")
    seen_paths: list[Path] = []
    options_by_path: dict[str, dict] = {}

    monkeypatch.setattr(
        preview.icc_profiles if hasattr(preview, "icc_profiles") else __import__(
            "app.core.icc_profiles", fromlist=["icc_profiles"]
        ),
        "resolve_cmyk_profile_path",
        lambda _profile: "destination.icc",
        raising=False,
    )
    from app.core import icc_profiles, pdf_actions_native
    from app.core.separations import SeparationEngine
    from app.core.softproof import SoftProofEngine

    monkeypatch.setattr(
        icc_profiles, "resolve_cmyk_profile_path", lambda _profile: "destination.icc"
    )
    monkeypatch.setattr(
        icc_profiles, "resolve_srgb_profile_path", lambda: "source.icc"
    )
    monkeypatch.setattr(preview, "effective_preview_dpi", lambda dpi: dpi)
    monkeypatch.setattr(
        SoftProofEngine,
        "_render_pdfium_rgb",
        lambda _self, _path, _page, _dpi: Image.new("RGB", (4, 3), (80, 120, 160)),
    )

    def fake_convert(_input, output, *_profiles, **options):
        path = Path(output)
        seen_paths.append(path)
        options_by_path[str(path)] = options
        path.write_bytes(b"%PDF-1.4\n% temp candidate\n%%EOF\n")
        return {"supported": True, "postflight": {"passed": True}}

    async def fake_proof(_self, pdf_path, _page, **_kwargs):
        brightness = int(options_by_path[pdf_path]["brightness_lstar"])
        value = 122 + brightness
        return {
            "success": True,
            "softproof_b64": _png_b64((value, value, value)),
            "image_mime": "image/png",
            "gamut_b64": None,
            "out_of_gamut_pct": 0.0,
            "width": 4,
            "height": 3,
            "engine": "ppe+lcms",
            "accuracy": "rip_softproof",
            "degraded": False,
            "ink_unsound": False,
            "ppe_degraded": False,
            "ppe_ink_unsound": False,
        }

    async def fake_separations(_self, _pdf_path, _page, **_kwargs):
        return _trusted_tac(32)

    monkeypatch.setattr(pdf_actions_native, "convert_to_cmyk", fake_convert)
    monkeypatch.setattr(SoftProofEngine, "render_softproof", fake_proof)
    monkeypatch.setattr(SeparationEngine, "extract_separations", fake_separations)

    payload = await preview.create_color_conversion_preview(
        str(source),
        page=1,
        conversions=["rgb_to_cmyk"],
        icc_profile="fogra39",
        rendering_intent="relative",
        preserve_black=True,
        black_point_compensation=True,
        gamut_mapping="adaptive_vivid",
        adjustment_stage="post_cmyk",
        brightness_lstar=0,
        contrast_percent=0,
        vibrance_percent=0,
        preview_policy="manual",
        dpi=150,
        request_id="req-temp",
    )

    assert payload["success"] is True
    assert payload["request_id"] == "req-temp"
    assert payload["effective_options"]["gamut_mapping"] == "adaptive_vivid"
    assert "output_filename" not in payload
    assert seen_paths
    assert all(
        options["gamut_mapping"] == "adaptive_vivid"
        for options in options_by_path.values()
    )
    assert all("prynx-color-preview-" in str(path.parent) for path in seen_paths)
    assert all(not path.exists() for path in seen_paths)


@pytest.mark.asyncio
async def test_cancel_waits_for_converter_then_removes_temporary_directory(
    monkeypatch,
    tmp_path,
):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF\n")
    converter_started = threading.Event()
    created_paths: list[Path] = []

    from app.core import icc_profiles, pdf_actions_native
    from app.core.softproof import SoftProofEngine

    monkeypatch.setattr(
        icc_profiles, "resolve_cmyk_profile_path", lambda _profile: "destination.icc"
    )
    monkeypatch.setattr(
        icc_profiles, "resolve_srgb_profile_path", lambda: "source.icc"
    )
    monkeypatch.setattr(preview, "effective_preview_dpi", lambda dpi: dpi)
    monkeypatch.setattr(
        SoftProofEngine,
        "_render_pdfium_rgb",
        lambda _self, _path, _page, _dpi: Image.new("RGB", (4, 3), (80, 120, 160)),
    )

    def cancellable_convert(_input, output, *_profiles, cancel_check, **_options):
        path = Path(output)
        created_paths.append(path)
        path.write_bytes(b"%PDF-1.4\n% partial preview\n%%EOF\n")
        converter_started.set()
        while not cancel_check():
            time.sleep(0.005)
        return {"supported": True, "postflight": {"passed": True}}

    monkeypatch.setattr(
        pdf_actions_native,
        "convert_to_cmyk",
        cancellable_convert,
    )
    task = asyncio.create_task(
        preview.create_color_conversion_preview(
            str(source),
            page=1,
            conversions=["rgb_to_cmyk"],
            icc_profile="fogra39",
            rendering_intent="relative",
            preserve_black=True,
            black_point_compensation=True,
            gamut_mapping="icc",
            adjustment_stage="post_cmyk",
            brightness_lstar=0,
            contrast_percent=0,
            vibrance_percent=0,
            preview_policy="manual",
            dpi=150,
            request_id="req-cancel",
        )
    )
    assert await asyncio.to_thread(converter_started.wait, 2.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert created_paths
    assert all(not path.exists() for path in created_paths)
    assert all(not path.parent.exists() for path in created_paths)


def _license():
    return {
        "license_key": "TEST",
        "hwid": "TEST",
        "verified": True,
        "plan": "pro",
        "features": ["*"],
    }


def test_preview_http_contract_has_no_output_filename(monkeypatch, tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF\n")
    captured: dict = {}

    async def fake_preview(source_path: str, **kwargs):
        captured.update({"source_path": source_path, **kwargs})
        return {
            "success": True,
            "request_id": kwargs["request_id"],
            "page": kwargs["page"],
            "requested_dpi": kwargs["dpi"],
            "effective_dpi": kwargs["dpi"],
            "effective_options": {"gamut_mapping": kwargs["gamut_mapping"]},
            "effective_adjustments": {
                "brightness_lstar": 1,
                "contrast_percent": 0,
                "vibrance_percent": 0,
                "adjustment_stage": "post_cmyk",
            },
            "preview": {
                "source_b64": _png_b64((10, 20, 30)),
                "output_b64": _png_b64((11, 21, 31)),
                "gamut_b64": None,
                "mime": "image/png",
                "width": 4,
                "height": 3,
                "proof_accuracy": "rip_softproof",
                "proof_engine": "ppe+lcms",
                "measurement_basis": "display_rgb_vs_rip_softproof",
            },
            "metrics": {
                **_metric(delta_l=0.1),
            },
            "recommendation": {
                "policy": "balanced-v1",
                "status": "recommended",
                "gates_passed": True,
                "reason_codes": [],
            },
            "warnings": ["Đo trên trang 2."],
        }

    import app.core.color_conversion_preview as preview_module

    monkeypatch.setattr(preflight_routes, "_get_file_path", lambda _id: str(source))
    monkeypatch.setattr(
        preview_module, "create_color_conversion_preview", fake_preview
    )
    app.dependency_overrides[require_license] = _license
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors/preview",
            json={
                "file_id": "rgb-preview",
                "page": 2,
                "conversions": ["rgb_to_cmyk"],
                "icc_profile": "fogra39",
                "rendering_intent": "relative",
                "preserve_black": True,
                "black_point_compensation": True,
                "gamut_mapping": "adaptive_vivid",
                "adjustment_stage": "post_cmyk",
                "brightness_lstar": 0,
                "contrast_percent": 0,
                "vibrance_percent": 0,
                "preview_policy": "balanced-v1",
                "dpi": 150,
                "request_id": "req-http",
            },
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["request_id"] == "req-http"
        assert payload["page"] == 2
        assert "output_filename" not in payload
        assert captured["preview_policy"] == "balanced-v1"
        assert captured["gamut_mapping"] == "adaptive_vivid"
        assert captured["conversions"] == ["rgb_to_cmyk"]
    finally:
        app.dependency_overrides.pop(require_license, None)


@pytest.mark.parametrize(
    "conversions",
    [
        ["spot_to_cmyk"],
        ["rgb_to_cmyk", "rgb_to_cmyk"],
        ["rgb_to_cmyk", "gray_to_cmyk"],
    ],
)
def test_preview_rejects_ambiguous_or_grayscale_contract(conversions):
    app.dependency_overrides[require_license] = _license
    try:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            "/api/preflight/convert-colors/preview",
            json={
                "file_id": "must-not-reach",
                "conversions": conversions,
                "request_id": "invalid",
            },
        )
        assert response.status_code == 422, response.text
    finally:
        app.dependency_overrides.pop(require_license, None)
