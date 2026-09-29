"""Module ghi log debug chi tiết cho luồng Bù xén, Tách tem và Bình bài bế tem.

In trực tiếp ra console (sys.stderr) để người dùng thấy ngay trên terminal khi thao tác,
đồng thời lưu vào %APPDATA%/PrynX/logs/workflow_debug.log.
"""
from __future__ import annotations

import os
import sys
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
_logger = logging.getLogger("workflow_debug")


def _get_log_file_path() -> Path:
    appdata = os.environ.get("APPDATA") or os.environ.get("USERPROFILE") or ""
    if appdata:
        target_dir = Path(appdata) / "PrynX" / "logs"
    else:
        target_dir = Path(__file__).resolve().parents[2] / "logs"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return target_dir / "workflow_debug.log"


def dbg_log(stage: str, message: str, **fields: Any) -> None:
    """Ghi một dòng log debug nổi bật ra console và file log."""
    now_str = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    parts = []
    for k, v in fields.items():
        if v is None:
            continue
        if isinstance(v, float):
            parts.append(f"{k}={v:.2f}")
        else:
            parts.append(f"{k}={v}")
    extra = (" | " + " ".join(parts)) if parts else ""
    line = f"==> [{now_str}] [{stage.upper()}] {message}{extra}"

    # 1. In ngay ra console terminal
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass

    # 2. Đưa qua logging system
    try:
        _logger.warning(line)
    except Exception:
        pass

    # 3. Ghi vào file workflow_debug.log
    try:
        path = _get_log_file_path()
        with _LOCK:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass
