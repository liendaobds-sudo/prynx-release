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


def test_run_hidden_counts_ghostscript_but_not_other_tools(monkeypatch):
    """Đếm ở `run_hidden` — chỗ MỌI lệnh GS của sản phẩm đi qua."""
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda cmd, **kw: calls.append(cmd) or "ok"
    )

    subprocess_utils.run_hidden(["gswin64c.exe", "-dBATCH"])
    subprocess_utils.run_hidden(["qpdf", "--version"])

    stats = gs_usage.summary()
    assert stats["total_gs_calls"] == 1, stats
    assert len(calls) == 2, "cả hai lệnh vẫn phải chạy"


def test_reason_points_at_the_real_module_that_asked_for_ghostscript(monkeypatch, tmp_path):
    """Nhãn phải chỉ ra ĐƯỜNG nào còn cần GS — đó là thứ quyết định việc tiếp theo.

    Dùng call site thật (`pdf_tools_engine._gs_downsample`) chứ không phải hàm
    dựng trong test: điều cần chứng minh là cơ chế dò ngăn xếp nhận đúng module
    sản phẩm, và chỉ code sản phẩm mới có ngăn xếp thật.
    """
    from app.config import settings
    from app.workers import pdf_tools_engine

    fake_gs = tmp_path / "gswin64c.exe"
    fake_gs.write_bytes(b"")
    monkeypatch.setattr(settings, "GHOSTSCRIPT_PATH", str(fake_gs))

    class _Done:
        returncode = 1  # để hàm trả False, không cần output thật

    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: _Done())

    pdf_tools_engine._gs_downsample(str(tmp_path / "a.pdf"), str(tmp_path / "b.pdf"), 300)

    reasons = gs_usage.summary()["by_reason"]
    assert sum(reasons.values()) == 1, reasons
    label = next(iter(reasons))
    assert "pdf_tools_engine" in label, f"nhãn không chỉ đúng module: {label}"


def test_counter_failure_never_breaks_the_job(monkeypatch):
    """Một lệnh in KHÔNG được thất bại vì bộ đếm — đó là điều lố bịch nhất có thể."""
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: "ok")

    def explode(*_a, **_k):
        raise RuntimeError("đĩa đầy")

    monkeypatch.setattr(gs_usage, "record_gs_call", explode)
    assert subprocess_utils.run_hidden(["gswin64c.exe"]) == "ok"


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
