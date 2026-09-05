"""Ghi log hiệu năng preview tem/CNC/cắt xén khi người vận hành bật đo.

Mặc định không ghi. Bật thống nhất bằng ``PRYNX_PERF=1``; mỗi sự kiện chỉ ghi
một bản tại ``%APPDATA%/PrynX/logs/preview_perf.log`` (hoặc HOME khi không có
APPDATA). Đây là telemetry chẩn đoán cục bộ, không phải log vận hành bắt buộc.
"""
from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from app.core.development_diagnostics import development_diagnostic_enabled

_lock = threading.Lock()
_enabled: Optional[bool] = None
_session_id = f"S{int(time.time())}"
_DIAGNOSTIC_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,96}$")


def _is_enabled() -> bool:
    global _enabled
    if _enabled is None:
        # SEC (audit 2026-09-05 §LOG.01): PRYNX_PERF chỉ có hiệu lực trong
        # runtime dev thông dịch; binary release luôn fail-closed.
        _enabled = development_diagnostic_enabled("PRYNX_PERF")
    return _enabled


def sanitize_diagnostic_id(value: Any) -> str:
    """Chỉ cho phép mã đối chiếu một dòng; giá trị bẩn không được lọt vào log."""
    text = str(value or "").strip()
    return text if _DIAGNOSTIC_ID_RE.fullmatch(text) else ""


def log_paths() -> list[Path]:
    """Trả đúng một đích ghi để không nhân đôi I/O cho cùng sự kiện."""
    appdata = os.environ.get("APPDATA") or os.environ.get("HOME") or ""
    if appdata:
        return [Path(appdata) / "PrynX" / "logs" / "preview_perf.log"]
    try:
        return [Path(__file__).resolve().parents[2] / "logs" / "preview_perf.log"]
    except Exception:
        return []


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
