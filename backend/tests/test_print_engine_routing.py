"""Regression tests for the configurable PPE/Ghostscript routing policy."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import settings
from app.core.print_engine import facade as ppe_facade
from app.core.separations import SeparationEngine


def _engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SeparationEngine:
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    engine = SeparationEngine()
    engine.gs_path = str(__file__)  # Existing path: makes GS "available" without running it.
    monkeypatch.setattr(engine, "_detect_spot_inks", lambda _path: [])
    monkeypatch.setattr(
        engine,
        "_run_pikepdf_fallback",
        lambda *_args, **_kwargs: {"width": 1, "height": 1, "plates": []},
    )
    return engine


@pytest.mark.asyncio
async def test_ppe_mode_does_not_fall_through_to_ghostscript(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "PRYNX_PRINT_ENGINE", "ppe")
    monkeypatch.setattr(settings, "PRYNX_FORCE_GS", False)
    monkeypatch.setattr(settings, "PRYNX_ALLOW_GS_FALLBACK", True)
    monkeypatch.setattr(
        ppe_facade,
        "separations",
        lambda *_args, **_kwargs: {
            "engine": "ppe",
            "accuracy": "rip_separations",
            "plates": [{"name": "Cyan", "is_spot": False}],
        },
    )

    async def unexpected_gs(*_args, **_kwargs):
        raise AssertionError("PPE-only mode must not call Ghostscript")

    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", unexpected_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "ppe"


@pytest.mark.asyncio
async def test_force_gs_bypasses_ppe(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "PRYNX_PRINT_ENGINE", "auto")
    monkeypatch.setattr(settings, "PRYNX_FORCE_GS", True)
    monkeypatch.setattr(settings, "PRYNX_ALLOW_GS_FALLBACK", True)

    def unexpected_ppe(*_args, **_kwargs):
        raise AssertionError("PRYNX_FORCE_GS must bypass PPE")

    async def fake_gs(*_args, **_kwargs):
        return {
            "width": 1,
            "height": 1,
            "plates": [{"name": "Cyan", "is_spot": False}],
        }

    monkeypatch.setattr(ppe_facade, "separations", unexpected_ppe)
    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", fake_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "ghostscript"
    assert result["accuracy"] == "rip_separations"


@pytest.mark.asyncio
async def test_auto_mode_can_disable_ghostscript_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)
    monkeypatch.setattr(settings, "PRYNX_PRINT_ENGINE", "auto")
    monkeypatch.setattr(settings, "PRYNX_FORCE_GS", False)
    monkeypatch.setattr(settings, "PRYNX_ALLOW_GS_FALLBACK", False)

    def unavailable_ppe(*_args, **_kwargs):
        raise ppe_facade.PpeUnavailable("not built")

    async def unexpected_gs(*_args, **_kwargs):
        raise AssertionError("Ghostscript fallback is disabled")

    monkeypatch.setattr(ppe_facade, "separations", unavailable_ppe)
    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", unexpected_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "pdfium_approx"
    assert result["accuracy"] == "approximate"
