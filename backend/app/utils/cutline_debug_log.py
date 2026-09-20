"""Module ghi log debug chi tiết về hiệu năng và tiến trình Cutline / Dieline Preview.
Luôn ghi ra file %APPDATA%/PrynX/logs/cutline_debug.log để người dùng và developer
có thể kiểm tra chính xác từng bước tốn bao nhiêu mili-giây.
"""
from __future__ import annotations

import os
import sys
import time
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

_LOCK = threading.Lock()

def get_log_file_path() -> Path:
    appdata = os.environ.get("APPDATA") or os.environ.get("USERPROFILE") or ""
    if appdata:
        target_dir = Path(appdata) / "PrynX" / "logs"
    else:
        target_dir = Path(__file__).resolve().parents[2] / "logs"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return target_dir / "cutline_debug.log"

def log_cutline(source: str, stage: str, message: str, **fields: Any) -> None:
    """Ghi 1 dòng log debug cutline có timestamp mili-giây ra file."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    extra_parts = []
    for k, v in fields.items():
        if v is None:
            continue
        if isinstance(v, float):
            extra_parts.append(f"{k}={v:.2f}")
        else:
            extra_parts.append(f"{k}={v}")
    extra_str = (" | " + " ".join(extra_parts)) if extra_parts else ""
    line = f"[{now_str}] [{source.upper()}] [{stage.upper()}] {message}{extra_str}\n"

    path = get_log_file_path()
    try:
        sys.stdout.write(f"[CUTLINE-DEBUG] {line}")
        sys.stdout.flush()
    except Exception:
        pass
    written = False
    for attempt in range(5):
        try:
            with _LOCK:
                with open(path, "a", encoding="utf-8", buffering=1) as f:
                    f.write(line)
                    f.flush()
            written = True
            break
        except Exception:
            time.sleep(0.005 * (attempt + 1))
    if not written:
        try:
            sys.stderr.write(f"[CUTLINE_DEBUG_FALLBACK] {line.strip()}\n")
            sys.stderr.flush()
        except Exception:
            pass

class CutlineTimer:
    """Context manager đo thời gian một công đoạn cutline và ghi ra file debug."""
    def __init__(self, source: str, stage: str, message: str, **fields: Any):
        self.source = source
        self.stage = stage
        self.message = message
        self.fields = fields
        self.t0 = 0.0

    def __enter__(self):
        self.t0 = time.perf_counter()
        log_cutline(self.source, self.stage, f"BẮT ĐẦU {self.message}", **self.fields)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        elapsed_ms = (time.perf_counter() - self.t0) * 1000.0
        if exc_type is not None:
            log_cutline(
                self.source,
                self.stage,
                f"LỖI {self.message}",
                elapsed_ms=elapsed_ms,
                error=str(exc_val),
                **self.fields,
            )
        else:
            log_cutline(
                self.source,
                self.stage,
                f"HOÀN THÀNH {self.message}",
                elapsed_ms=elapsed_ms,
                **self.fields,
            )
        return False
