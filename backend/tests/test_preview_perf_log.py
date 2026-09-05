"""Hồi quy telemetry preview phải là opt-in và chỉ ghi một bản."""

import asyncio

import pytest

from app.config import settings
from app.utils import preview_perf_log as perf_log


@pytest.fixture(autouse=True)
def _runtime_dev(monkeypatch):
    monkeypatch.setattr(settings, "DEV_MODE", True)


def _reset_cached_flag() -> None:
    perf_log._enabled = None


def test_preview_perf_mac_dinh_tat(monkeypatch, tmp_path):
    monkeypatch.delenv("PRYNX_PERF", raising=False)
    monkeypatch.delenv("PRYNX_PREVIEW_PERF_LOG", raising=False)
    target = tmp_path / "preview_perf.log"
    monkeypatch.setattr(perf_log, "log_paths", lambda: [target])
    _reset_cached_flag()

    perf_log.log("TEST", "không được ghi")

    assert perf_log._is_enabled() is False
    assert not target.exists()


def test_chi_prynx_perf_bat_telemetry(monkeypatch, tmp_path):
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.delenv("PRYNX_PREVIEW_PERF_LOG", raising=False)
    target = tmp_path / "preview_perf.log"
    monkeypatch.setattr(perf_log, "log_paths", lambda: [target])
    _reset_cached_flag()

    perf_log.log("TEST", "được ghi", page=3)

    assert perf_log._is_enabled() is True
    assert target.read_text(encoding="utf-8").count("được ghi") == 1


def test_binary_release_khong_ghi_du_env_bat(monkeypatch, tmp_path):
    monkeypatch.setenv("PRYNX_PERF", "1")
    monkeypatch.setattr(
        perf_log,
        "development_diagnostic_enabled",
        lambda _name: False,
    )
    target = tmp_path / "preview_perf.log"
    monkeypatch.setattr(perf_log, "log_paths", lambda: [target])
    _reset_cached_flag()

    perf_log.log("TEST", "du-lieu-khong-duoc-ghi")

    assert perf_log._is_enabled() is False
    assert not target.exists()


def test_co_preview_cu_khong_tu_bat_lai(monkeypatch):
    monkeypatch.delenv("PRYNX_PERF", raising=False)
    monkeypatch.setenv("PRYNX_PREVIEW_PERF_LOG", "1")
    _reset_cached_flag()

    assert perf_log._is_enabled() is False


def test_moi_session_chi_co_mot_file_log(monkeypatch, tmp_path):
    appdata = tmp_path / "AppData"
    monkeypatch.setenv("APPDATA", str(appdata))

    assert perf_log.log_paths() == [
        appdata / "PrynX" / "logs" / "preview_perf.log"
    ]


def test_ma_doi_chieu_chan_xuong_dong_va_ky_tu_la():
    assert perf_log.sanitize_diagnostic_id("sr-abc_123.p1") == "sr-abc_123.p1"
    assert perf_log.sanitize_diagnostic_id("sr-ok\nFAKE") == ""
    assert perf_log.sanitize_diagnostic_id("mã-có-dấu") == ""


def test_perf_beacon_release_noop_truoc_khi_doc_payload(monkeypatch):
    from app.api.routes import imposition

    emitted: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        imposition,
        "development_diagnostic_enabled",
        lambda _name: False,
    )
    monkeypatch.setattr(perf_log, "log", lambda *args, **_kwargs: emitted.append(args))

    result = asyncio.run(
        imposition.preview_perf_beacon(
            {
                "msg": "[DIM-DIE-TRACE] ENGINE_SENTINEL",
                "path": r"C:\\KhachHang\\don-hang.pdf",
            },
            {},
        )
    )

    assert result == {"ok": True}
    assert emitted == []
