"""Hồi quy hợp đồng tách kẽm theo chất lượng accurate/approximate."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import settings
from app.core.print_engine import facade as ppe_facade
from app.core.separations import SeparationEngine


def _engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SeparationEngine:
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    engine = SeparationEngine()
    monkeypatch.setattr(engine, "_detect_spot_inks", lambda _path: [])
    monkeypatch.setattr(
        engine,
        "_run_pikepdf_fallback",
        lambda *_args, **_kwargs: {"width": 1, "height": 1, "plates": []},
    )
    return engine


@pytest.mark.asyncio
async def test_accurate_mode_uses_ppe(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ppe_facade,
        "separations",
        lambda *_args, **_kwargs: {
            "engine": "ppe",
            "accuracy": "rip_separations",
            "plates": [{"name": "Cyan", "is_spot": False}],
        },
    )

    result = await engine.extract_separations(
        "fixture.pdf", 1, render_mode="accurate"
    )

    assert result["engine"] == "ppe"


@pytest.mark.asyncio
async def test_approximate_mode_skips_ppe(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)

    def unexpected_ppe(*_args, **_kwargs):
        raise AssertionError("Chế độ approximate không được gọi PPE")

    monkeypatch.setattr(ppe_facade, "separations", unexpected_ppe)

    result = await engine.extract_separations(
        "fixture.pdf", 1, render_mode="approximate"
    )

    assert result["engine"] == "pdfium_approx"
    assert result["accuracy"] == "approximate"


@pytest.mark.asyncio
async def test_ppe_unavailable_falls_back_to_explicit_approximation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)

    def unavailable_ppe(*_args, **_kwargs):
        raise ppe_facade.PpeUnavailable("not built")

    monkeypatch.setattr(ppe_facade, "separations", unavailable_ppe)

    result = await engine.extract_separations(
        "fixture.pdf", 1, render_mode="accurate"
    )

    assert result["engine"] == "pdfium_approx"
    assert result["accuracy"] == "approximate"
