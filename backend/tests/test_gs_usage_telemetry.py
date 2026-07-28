"""Thiết bị đo cho gate §8.1 (≥95% job không cần Ghostscript).

Điều được khoá ở đây không phải "bộ đếm đếm đúng" mà là hai tính chất khiến nó
dùng được thật: nó **bắt mọi lệnh GS** kể cả từ call site chưa tồn tại lúc viết
test, và nó **không bao giờ làm hỏng job** dù ghi log thất bại.
"""

import subprocess
import sys

import pytest

from app.core import gs_usage
from app.utils import subprocess_utils


@pytest.fixture(autouse=True)
def _clean_counters():
    gs_usage.reset_for_tests()
    yield
    gs_usage.reset_for_tests()


def test_recognizes_ghostscript_by_executable_stem():
    assert gs_usage.is_ghostscript_command([r"C:\Program Files\gs\gs10.04.0\bin\gswin64c.exe"])
    assert gs_usage.is_ghostscript_command(["/usr/bin/gs", "-dBATCH"])
    assert gs_usage.is_ghostscript_command(["gswin32c"])
    # Không nhầm công cụ khác — bộ đếm phồng lên vì tesseract/qpdf thì vô dụng.
    assert not gs_usage.is_ghostscript_command(["tesseract", "in.png", "out"])
    assert not gs_usage.is_ghostscript_command(["python", "-c", "gs"])
    assert not gs_usage.is_ghostscript_command([])


def test_run_hidden_blocks_ghostscript_but_runs_other_tools(monkeypatch, tmp_path):
    """Chốt toàn cục phải từ chối GS trước subprocess và trước telemetry."""
    from app.core.gs_availability import GhostscriptUnavailable

    fake_gs = tmp_path / "gswin64c.exe"
    fake_gs.write_bytes(b"")
    fake_qpdf = tmp_path / "qpdf.exe"
    fake_qpdf.write_bytes(b"")
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda cmd, **kw: calls.append(cmd) or "ok"
    )

    with pytest.raises(GhostscriptUnavailable):
        subprocess_utils.run_hidden([str(fake_gs), "-dBATCH"])
    assert subprocess_utils.run_hidden([str(fake_qpdf), "--version"]) == "ok"

    assert gs_usage.summary()["total_gs_calls"] == 0
    assert calls == [[str(fake_qpdf), "--version"]]

def test_product_call_is_blocked_before_subprocess(monkeypatch, tmp_path):
    """Một call site legacy thật cũng không được vượt qua chốt no-GS."""
    from app.config import settings
    from app.workers import pdf_tools_engine

    fake_gs = tmp_path / "gswin64c.exe"
    fake_gs.write_bytes(b"")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", str(fake_gs))
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda cmd, **kw: calls.append(cmd) or None
    )

    ok = pdf_tools_engine._gs_downsample(
        str(tmp_path / "a.pdf"), str(tmp_path / "b.pdf"), 300
    )
    assert ok is False
    assert calls == []
    assert gs_usage.summary()["total_gs_calls"] == 0

def test_non_gs_job_is_independent_from_telemetry(monkeypatch, tmp_path):
    """Lỗi telemetry không được ảnh hưởng công cụ ngoài không phải GS."""
    fake_qpdf = tmp_path / "qpdf.exe"
    fake_qpdf.write_bytes(b"")
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: "ok")

    def explode(*_a, **_k):
        raise RuntimeError("đĩa đầy")

    monkeypatch.setattr(gs_usage, "record_gs_call", explode)
    assert subprocess_utils.run_hidden([str(fake_qpdf)]) == "ok"

def test_record_swallows_disk_errors(monkeypatch):
    monkeypatch.setattr(gs_usage, "_log_path", lambda: (_ for _ in ()).throw(OSError("x")))
    gs_usage.record_gs_call("app.core.test")  # không được ném
    assert gs_usage.summary()["total_gs_calls"] == 1


def test_summary_groups_by_reason():
    gs_usage.record_gs_call("app.core.separations.render")
    gs_usage.record_gs_call("app.core.separations.render")
    gs_usage.record_gs_call("app.core.pdfx_export.export")
    stats = gs_usage.summary()
    assert stats["total_gs_calls"] == 3
    assert stats["by_reason"]["app.core.separations.render"] == 2
    assert stats["by_reason"]["app.core.pdfx_export.export"] == 1
