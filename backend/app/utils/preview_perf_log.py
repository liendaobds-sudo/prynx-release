"""Ghi log hiệu năng preview tem/CNC/cắt xén ra file cố định để audit.

File chính (workspace, agent đọc được):
  <repo>/logs/preview_perf.log

File phụ (máy user):
  %APPDATA%/PrynX/logs/preview_perf.log

Bật/tắt: PRYNX_PREVIEW_PERF_LOG=0 để tắt (mặc định bật).
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

_lock = threading.Lock()
_enabled: Optional[bool] = None
_session_id = f"S{int(time.time())}"


def _is_enabled() -> bool:
    global _enabled
    if _enabled is None:
        v = (os.environ.get("PRYNX_PREVIEW_PERF_LOG") or "1").strip().lower()
        _enabled = v not in ("0", "false", "no", "off")
    return _enabled


def log_paths() -> list[Path]:
    """Đường dẫn file log (workspace trước, APPDATA sau)."""
    paths: list[Path] = []
    # backend/app/utils → parents[3] = backend, parents[4] = repo root
    try:
        repo = Path(__file__).resolve().parents[3]
        if (repo / "backend").is_dir() or (repo / "desktop").is_dir():
            paths.append(repo / "logs" / "preview_perf.log")
        else:
            # fallback: backend/logs
            paths.append(Path(__file__).resolve().parents[2] / "logs" / "preview_perf.log")
    except Exception:
        pass
    appdata = os.environ.get("APPDATA") or os.environ.get("HOME") or ""
    if appdata:
        paths.append(Path(appdata) / "PrynX" / "logs" / "preview_perf.log")
    # unique preserve order
    seen: set[str] = set()
    out: list[Path] = []
    for p in paths:
        key = str(p).lower()
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def reset_session(label: str = "new") -> str:
    """Đánh dấu session đo mới (gọi khi detect-shape bắt đầu lần đầu)."""
    global _session_id
    _session_id = f"S{int(time.time())}"
    log("SESSION", f"start label={label} id={_session_id}")
    return _session_id


def log(channel: str, msg: str, **fields: Any) -> None:
    """Ghi 1 dòng log. channel: DETECT | PREVIEW | BATCH | FE | SESSION."""
    if not _is_enabled():
        return
    try:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        extra = ""
        if fields:
            parts = []
            for k, v in fields.items():
                if v is None:
                    continue
                if isinstance(v, float):
                    parts.append(f"{k}={v:.1f}" if abs(v) >= 10 else f"{k}={v:.3f}")
                else:
                    parts.append(f"{k}={v}")
            if parts:
                extra = " | " + " ".join(parts)
        line = f"[{ts}] [{_session_id}] [{channel}] {msg}{extra}\n"
        with _lock:
            for path in log_paths():
                try:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with open(path, "a", encoding="utf-8") as f:
                        f.write(line)
                except Exception:
                    continue
    except Exception:
        pass


class Span:
    """Đo thời gian một đoạn: Span('PREVIEW','open_doc').done()."""

    def __init__(self, channel: str, name: str, **fields: Any):
        self.channel = channel
        self.name = name
        self.fields = fields
        self.t0 = time.perf_counter()
        log(channel, f"BEGIN {name}", **fields)

    def done(self, **more: Any) -> float:
        ms = (time.perf_counter() - self.t0) * 1000.0
        merged = {**self.fields, **more, "ms": ms}
        log(self.channel, f"END   {self.name}", **merged)
        return ms


def mark(channel: str, label: str, t0: float, **fields: Any) -> float:
    """Ghi mốc +elapsed ms kể từ t0 (perf_counter)."""
    ms = (time.perf_counter() - t0) * 1000.0
    log(channel, label, ms_from_start=ms, **fields)
    return ms
