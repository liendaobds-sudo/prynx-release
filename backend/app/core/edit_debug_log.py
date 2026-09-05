"""Bounded JSONL diagnostics for reproducible Edit PDF transform bugs."""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.development_diagnostics import development_diagnostic_enabled


_WRITE_LOCK = threading.Lock()
_DEFAULT_PATH = Path(__file__).resolve().parents[3] / "tmp" / "logs" / "edit_pdf_bug.jsonl"


def edit_bug_log_path() -> Path:
    override = os.environ.get("PRYNX_EDIT_BUG_LOG_PATH", "").strip()
    return Path(override).expanduser().resolve() if override else _DEFAULT_PATH


def edit_bug_log_enabled() -> bool:
    # Mặc định TẮT: bật sẽ snapshot content stream + SHA256 PDF + ghi JSONL
    # mỗi move/resize/rotate → lag Edit PDF rõ. Chỉ bật khi debug:
    #   PRYNX_EDIT_BUG_LOG=1
    return development_diagnostic_enabled(
        "PRYNX_EDIT_BUG_LOG"
    ) and "PYTEST_CURRENT_TEST" not in os.environ


def edit_text_move_log_enabled() -> bool:
    """Log chuyên biệt move text multi-run (nhẹ hơn full transform debug).

    Mặc định TẮT. Bật khi cần chẩn đoán:
      PRYNX_EDIT_TEXT_MOVE_LOG=1
    """
    return development_diagnostic_enabled(
        "PRYNX_EDIT_TEXT_MOVE_LOG"
    ) and "PYTEST_CURRENT_TEST" not in os.environ


def edit_text_move_log_path() -> Path:
    override = os.environ.get("PRYNX_EDIT_TEXT_MOVE_LOG_PATH", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[3] / "tmp" / "logs" / "edit_text_move.jsonl"


def log_text_move(event: str, **payload: Any) -> Path | None:
    """Ghi JSONL + không phụ thuộc PRYNX_EDIT_BUG_LOG (cờ riêng)."""
    if not edit_text_move_log_enabled():
        return None
    return log_edit_bug(
        event,
        path=edit_text_move_log_path(),
        force=True,
        **payload,
    )


def _bounded(value: Any, depth: int = 0) -> Any:
    if depth >= 12:
        return "<max-depth>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 1000 else value[:1000] + "...<truncated>"
    if isinstance(value, (list, tuple)):
        items = [_bounded(item, depth + 1) for item in value[:120]]
        if len(value) > 120:
            items.append(f"<{len(value) - 120} more>")
        return items
    if isinstance(value, dict):
        items = list(value.items())
        result = {str(key): _bounded(item, depth + 1) for key, item in items[:120]}
        if len(items) > 120:
            result["<truncated>"] = len(items) - 120
        return result
    return _bounded(str(value), depth + 1)


def log_edit_bug(event: str, *, path: Path | None = None, force: bool = False, **payload: Any) -> Path | None:
    if not force and not edit_bug_log_enabled():
        return None
    target = path or edit_bug_log_path()
    record = {
        "timestamp": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "pid": os.getpid(),
        "event": event,
        **payload,
    }
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(_bounded(record), ensure_ascii=False, separators=(",", ":"))
        with _WRITE_LOCK:
            with target.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
        return target
    except Exception:
        # Diagnostics must never break an edit operation.
        return None
