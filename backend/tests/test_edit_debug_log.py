from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.edit_debug_log import (
    edit_bug_log_enabled,
    edit_text_move_log_enabled,
    log_edit_bug,
    log_text_move,
)


def test_edit_bug_log_writes_bounded_jsonl(tmp_path):
    path = tmp_path / "edit_pdf_bug.jsonl"
    written = log_edit_bug(
        "transform.before",
        path=path,
        force=True,
        sessionId="session-test",
        payload={"text": "x" * 1500, "values": list(range(140))},
    )
    assert written == path
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 1
    assert rows[0]["event"] == "transform.before"
    assert rows[0]["sessionId"] == "session-test"
    assert rows[0]["payload"]["text"].endswith("<truncated>")
    assert rows[0]["payload"]["values"][-1] == "<20 more>"


def test_edit_bug_log_disabled_by_default(monkeypatch):
    monkeypatch.delenv("PRYNX_EDIT_BUG_LOG", raising=False)
    assert edit_bug_log_enabled() is False
    path = log_edit_bug("should.skip", path=None)
    assert path is None


def test_edit_bug_log_enabled_when_flag_on(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_EDIT_BUG_LOG", "1")
    # Giả lập runtime app (không phải pytest) — cờ enabled luôn tắt khi PYTEST_*.
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    assert edit_bug_log_enabled() is True
    path = tmp_path / "on.jsonl"
    written = log_edit_bug("transform.before", path=path, sessionId="s1")
    assert written == path
    assert path.read_text(encoding="utf-8").strip()


def test_text_move_log_disabled_by_default(monkeypatch):
    monkeypatch.delenv("PRYNX_EDIT_TEXT_MOVE_LOG", raising=False)
    assert edit_text_move_log_enabled() is False
    assert log_text_move("text.move.begin", dx=1.0) is None


def test_text_move_log_writes_when_flag_on(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setattr(settings, "DEV_MODE", True)
    monkeypatch.setenv("PRYNX_EDIT_TEXT_MOVE_LOG", "1")
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("PRYNX_EDIT_TEXT_MOVE_LOG_PATH", str(tmp_path / "text_move.jsonl"))
    assert edit_text_move_log_enabled() is True
    written = log_text_move("text.move.begin", dx=1.0, dy=2.0, note="unit")
    assert written is not None
    rows = [json.loads(line) for line in written.read_text(encoding="utf-8").splitlines()]
    assert rows[-1]["event"] == "text.move.begin"
    assert rows[-1]["dx"] == 1.0
