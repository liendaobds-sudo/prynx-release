from __future__ import annotations

from app.core.development_diagnostics import (
    development_diagnostic_enabled,
    development_runtime_enabled,
)


def test_binary_release_khong_the_bat_diagnostic_bang_env(monkeypatch):
    monkeypatch.setenv("PRYNX_NESTING_TRACE_ENABLED", "1")

    assert development_runtime_enabled(compiled=True, configured_dev=True) is False
    assert (
        development_diagnostic_enabled(
            "PRYNX_NESTING_TRACE_ENABLED",
            compiled=True,
            configured_dev=True,
        )
        is False
    )


def test_runtime_dev_van_can_opt_in_cho_diagnostic_mac_dinh_tat(monkeypatch):
    monkeypatch.delenv("PRYNX_ROT_AUDIT", raising=False)
    assert (
        development_diagnostic_enabled(
            "PRYNX_ROT_AUDIT",
            compiled=False,
            configured_dev=True,
        )
        is False
    )

    monkeypatch.setenv("PRYNX_ROT_AUDIT", "yes")
    assert (
        development_diagnostic_enabled(
            "PRYNX_ROT_AUDIT",
            compiled=False,
            configured_dev=True,
        )
        is True
    )


def test_runtime_khong_dev_khong_the_bat_diagnostic(monkeypatch):
    monkeypatch.setenv("STICKER_DEBUG", "true")

    assert (
        development_diagnostic_enabled(
            "STICKER_DEBUG",
            compiled=False,
            configured_dev=False,
        )
        is False
    )


def test_trace_tu_bat_chi_trong_runtime_dev(monkeypatch):
    monkeypatch.delenv("PRYNX_NESTING_TRACE_ENABLED", raising=False)

    assert (
        development_diagnostic_enabled(
            "PRYNX_NESTING_TRACE_ENABLED",
            default_in_dev=True,
            compiled=False,
            configured_dev=True,
        )
        is True
    )
    assert (
        development_diagnostic_enabled(
            "PRYNX_NESTING_TRACE_ENABLED",
            default_in_dev=True,
            compiled=True,
            configured_dev=True,
        )
        is False
    )


def test_sticker_debug_image_bi_khoa_o_binary_release(monkeypatch):
    from app.workers import sticker_engine

    monkeypatch.setenv("STICKER_DEBUG", "1")
    monkeypatch.setattr(sticker_engine, "development_runtime_enabled", lambda: False)
    monkeypatch.setattr(
        sticker_engine,
        "development_diagnostic_enabled",
        lambda _name: True,
    )

    assert sticker_engine.StickerEngine(dpi=72, debug=True).debug is False
