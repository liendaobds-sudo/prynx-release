"""Tripwire ngăn Ghostscript quay lại qua lớp chạy công cụ ngoài."""

import sys

import pytest

from app.utils import subprocess_utils
from app.utils.subprocess_utils import GhostscriptBlocked


@pytest.mark.parametrize("name", ["gs", "gsc", "gswin32c.exe", "GSWIN64C.EXE"])
def test_run_hidden_blocks_ghostscript_executable_stems(
    name, monkeypatch, tmp_path
):
    """Tên trần hoặc đường dẫn tuyệt đối đều phải bị chặn trước subprocess."""
    calls = []
    monkeypatch.setattr(
        subprocess_utils.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)) or "unexpected",
    )

    with pytest.raises(GhostscriptBlocked):
        subprocess_utils.run_hidden([str(tmp_path / name), "-dBATCH"])

    assert calls == []


@pytest.mark.parametrize(
    "command",
    [
        "/usr/bin/gs -dBATCH",
        '"C:\\Program Files\\gs\\bin\\gswin64c.exe" -dBATCH',
    ],
)
def test_run_hidden_blocks_string_commands(command, monkeypatch):
    """Dạng chuỗi vẫn phải nhận ra executable đầu tiên, kể cả đường dẫn có dấu cách."""
    calls = []
    monkeypatch.setattr(
        subprocess_utils.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)) or "unexpected",
    )

    with pytest.raises(GhostscriptBlocked):
        subprocess_utils.run_hidden(command)

    assert calls == []


@pytest.mark.parametrize(
    "command",
    [
        ["qpdf", "--version"],
        ["tesseract", "in.png", "out"],
        ["python", "-c", "print('gs')"],
        ["gsutil", "version"],
        [],
    ],
)
def test_run_hidden_does_not_block_other_tools(command, monkeypatch):
    """Tripwire chỉ nhận executable Ghostscript, không suy diễn từ đối số hay tiền tố."""
    calls = []
    monkeypatch.setattr(
        subprocess_utils.subprocess,
        "run",
        lambda cmd, **kwargs: calls.append((cmd, kwargs)) or "ok",
    )

    assert subprocess_utils.run_hidden(command, timeout=7) == "ok"
    assert calls[0][0] == command
    assert calls[0][1]["timeout"] == 7


def test_run_hidden_preserves_creation_flags_for_external_tools(monkeypatch):
    """Cầu chì no-GS không được làm đổi hợp đồng ẩn console của công cụ khác."""
    captured = {}

    def fake_run(cmd, **kwargs):
        captured.update(kwargs)
        return "ok"

    monkeypatch.setattr(subprocess_utils.subprocess, "run", fake_run)

    assert subprocess_utils.run_hidden(["qpdf"], creationflags=0x20) == "ok"
    expected = 0x20
    if sys.platform == "win32":
        expected |= subprocess_utils._CREATE_NO_WINDOW
    assert captured["creationflags"] == expected
