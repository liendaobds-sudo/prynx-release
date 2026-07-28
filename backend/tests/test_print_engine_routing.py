"""Hồi quy hợp đồng separation PPE/no-GS cố định."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import settings
from app.core.print_engine import facade as ppe_facade
from app.core.separations import SeparationEngine


def _engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SeparationEngine:
    monkeypatch.setattr(settings, "RESULTS_DIR", str(tmp_path))
    engine = SeparationEngine()
    # Cố ý giả lập GS "có sẵn": engine vẫn tuyệt đối không được gọi nó.
    engine.gs_path = str(__file__)
    monkeypatch.setattr(engine, "_detect_spot_inks", lambda _path: [])
    monkeypatch.setattr(
        engine,
        "_run_pikepdf_fallback",
        lambda *_args, **_kwargs: {"width": 1, "height": 1, "plates": []},
    )
    return engine


@pytest.mark.asyncio
async def test_ppe_result_is_used_without_ghostscript(
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

    async def unexpected_gs(*_args, **_kwargs):
        raise AssertionError("Không được gọi Ghostscript")

    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", unexpected_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "ppe"


@pytest.mark.asyncio
async def test_legacy_true_parameter_cannot_force_ghostscript(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)
    # Kể cả code ngoài cố sửa các khóa legacy sau khi Settings đã khởi tạo.
    monkeypatch.setattr(
        ppe_facade,
        "separations",
        lambda *_args, **_kwargs: {
            "engine": "ppe",
            "accuracy": "rip_separations",
            "plates": [{"name": "Black", "is_spot": False}],
        },
    )

    async def unexpected_gs(*_args, **_kwargs):
        raise AssertionError("Cấu hình legacy không được bật lại Ghostscript")

    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", unexpected_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "ppe"


@pytest.mark.asyncio
async def test_ppe_unavailable_falls_back_to_explicit_approximation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    engine = _engine(monkeypatch, tmp_path)

    def unavailable_ppe(*_args, **_kwargs):
        raise ppe_facade.PpeUnavailable("not built")

    async def unexpected_gs(*_args, **_kwargs):
        raise AssertionError("PPE lỗi cũng không được rơi về Ghostscript")

    monkeypatch.setattr(ppe_facade, "separations", unavailable_ppe)
    monkeypatch.setattr(engine, "_run_ghostscript_tiffsep", unexpected_gs)
    result = await engine.extract_separations("fixture.pdf", 1, use_ghostscript=True)
    assert result["engine"] == "pdfium_approx"
    assert result["accuracy"] == "approximate"
