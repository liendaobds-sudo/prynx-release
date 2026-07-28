"""Bản no-GS phải chạy MỘT đường engine xác định ở mọi máy.

GS-SUNSET (audit 2026-07-27 §A.4): artifact `-NoGhostscript` không đóng gói
Ghostscript, nhưng máy khách có thể đã cài GS sẵn. Nếu sản phẩm vẫn tự dò và dùng
bản đó thì cùng một phiên bản PrynX chạy hai đường engine khác nhau tuỳ máy — mà
thiết bị đo tỉ lệ GS đã bị loại khỏi gate, nên không ai biết máy nào đi đường nào.
"""

from __future__ import annotations

import importlib

import pytest

from app.core import gs_availability
from app.core.gs_availability import GhostscriptUnavailable
from app.utils.subprocess_utils import run_hidden


def test_marker_env_override_declares_no_gs_build(monkeypatch):
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "1")
    assert gs_availability.is_no_gs_build() is True
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "0")
    assert gs_availability.is_no_gs_build() is False


def test_marker_file_in_payload_declares_no_gs_build(monkeypatch, tmp_path):
    monkeypatch.delenv("PRYNX_NO_GS_BUILD", raising=False)
    payload = tmp_path / "binaries" / "gs"
    payload.mkdir(parents=True)
    monkeypatch.setattr(
        gs_availability,
        "_payload_dirs",
        lambda: (payload,),
    )
    assert gs_availability.is_no_gs_build() is False
    (payload / gs_availability.MARKER_NAME).write_text("no gs", encoding="utf-8")
    assert gs_availability.is_no_gs_build() is True


def test_no_gs_build_does_not_discover_system_ghostscript(monkeypatch):
    """Bản no-GS không được mượn Ghostscript của máy khách."""
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "1")
    monkeypatch.delenv("GHOSTSCRIPT_PATH", raising=False)
    config = importlib.import_module("app.config")
    assert config._find_ghostscript() == ""
    assert config._default_allow_gs_fallback() is False


def test_operator_override_still_wins_on_no_gs_build(monkeypatch, tmp_path):
    """Đối chiếu có chủ đích vẫn làm được: env trỏ tay vẫn thắng marker."""
    gs = tmp_path / "gswin64c.exe"
    gs.write_bytes(b"")
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "1")
    monkeypatch.setenv("GHOSTSCRIPT_PATH", str(gs))
    config = importlib.import_module("app.config")
    assert config._find_ghostscript() == str(gs)


def test_missing_ghostscript_is_not_silently_a_hardcoded_path(monkeypatch):
    """Không tìm thấy GS ⇒ chuỗi rỗng, không phải một đường dẫn gõ cứng.

    Đường dẫn gõ cứng làm mọi chỗ kiểm `if gs_path:` luôn đúng, và lỗi chỉ lộ ra ở
    tận `FileNotFoundError` của subprocess.
    """
    monkeypatch.delenv("GHOSTSCRIPT_PATH", raising=False)
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "0")
    config = importlib.import_module("app.config")
    monkeypatch.setattr(config, "shutil", _NoWhich())
    monkeypatch.setattr(config.Path, "is_dir", lambda _self: False)
    monkeypatch.setattr(
        "app.core.gs_availability.bundled_ghostscript",
        lambda: "",
    )
    assert config._find_ghostscript() == ""


class _NoWhich:
    @staticmethod
    def which(_name):
        return None


@pytest.mark.parametrize("style", ["empty", "absolute-missing"])
def test_run_hidden_explains_instead_of_file_not_found(monkeypatch, style, tmp_path):
    """Thông điệp ở mức sản phẩm, không phải mã lỗi của công cụ ngoài."""
    from app.config import settings

    exe = "" if style == "empty" else str(tmp_path / "gs" / "bin" / "gswin64c.exe")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", exe)
    with pytest.raises(GhostscriptUnavailable) as err:
        run_hidden([exe, "-dBATCH"], capture_output=True, timeout=5)
    text = str(err.value)
    assert "Ghostscript failed" not in text
    assert "PrynX" in text or "Ghostscript" in text


def test_bare_name_on_path_is_still_blocked(monkeypatch):
    """GS cài trên PATH cũng không được làm thay đổi hành vi sản phẩm."""
    from app.config import settings
    from app.utils import subprocess_utils

    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", "gswin64c.exe")
    calls = []
    monkeypatch.setattr(
        subprocess_utils.subprocess,
        "run",
        lambda cmd, **kw: calls.append(cmd) or "ok",
    )
    with pytest.raises(GhostscriptUnavailable):
        subprocess_utils.run_hidden(["gswin64c.exe", "--version"])
    assert calls == []

def test_configured_but_missing_path_is_reported_as_unavailable(monkeypatch, tmp_path):
    """Đường dẫn cấu hình sai không mang tên gs vẫn phải nhận đúng thông điệp."""
    from app.config import settings

    missing = str(tmp_path / "khong-co-gs.exe")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", missing)
    with pytest.raises(GhostscriptUnavailable):
        run_hidden([missing, "-dBATCH"], capture_output=True, timeout=5)


def test_other_external_tools_keep_their_own_error(monkeypatch, tmp_path):
    """Công cụ ngoài khác (poppler…) không bị gán nhãn Ghostscript."""
    from app.config import settings

    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", str(tmp_path / "gs.exe"))
    with pytest.raises((FileNotFoundError, OSError)):
        run_hidden([str(tmp_path / "pdftoppm.exe")], capture_output=True, timeout=5)


def test_message_is_identical_in_dev_and_packaged_build(monkeypatch):
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "1")
    packaged = gs_availability.unavailable_message("Outline Text")
    monkeypatch.setenv("PRYNX_NO_GS_BUILD", "0")
    dev = gs_availability.unavailable_message("Outline Text")
    assert packaged == dev
    assert "Outline Text" in packaged
    assert "GHOSTSCRIPT_PATH" not in packaged
    assert "Ghostscript" not in packaged
