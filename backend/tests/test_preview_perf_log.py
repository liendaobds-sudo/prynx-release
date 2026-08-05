"""Hồi quy telemetry preview phải là opt-in và chỉ ghi một bản."""

from app.utils import preview_perf_log as perf_log


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
