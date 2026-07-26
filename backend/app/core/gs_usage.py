"""Đếm số lần Ghostscript thực sự được gọi — thiết bị đo cho gate §8.1.

Điều kiện gỡ bundle GS đòi "≥95% job prepress trong log 30 ngày không cần GS
fallback". Con số đó không suy ra được từ test nội bộ: nó phụ thuộc file thật
của khách, và mỗi lần ta đóng thêm một đường non-GS thì tỉ lệ lại đổi. Cái duy
nhất làm được từ trong code là **dựng thiết bị đo** rồi để nó chạy.

Thiết kế:

* Ghi ở **một chỗ duy nhất** — `subprocess_utils.run_hidden`, nơi mọi lệnh
  Ghostscript trong sản phẩm đi qua. Đặt bộ đếm ở từng call site sẽ bỏ sót
  đúng những đường mới thêm sau này, tức đúng lúc số liệu quan trọng nhất.
* Ghi **lý do**, không ghi đường dẫn file. Số liệu này để biết đường nào còn
  cần GS, không phải để biết khách in gì; kèm tên file vào là biến một bộ đếm
  kỹ thuật thành dữ liệu cá nhân phải bảo vệ.
* Bền qua khởi động lại (JSONL trên đĩa) nhưng **không bao giờ làm hỏng job**:
  mọi lỗi ghi log đều nuốt. Một lệnh in thất bại vì bộ đếm là điều lố bịch.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import Counter
from pathlib import Path

logger = logging.getLogger(__name__)

# Tên tiến trình được coi là Ghostscript.
_GS_STEMS = {"gswin64c", "gswin32c", "gs", "gsc"}

_lock = threading.Lock()
_counts: Counter = Counter()
_total_calls = 0

# Trần dòng của file log. Vượt thì ngừng ghi đĩa (bộ đếm trong RAM vẫn chạy):
# một máy chạy nhiều tháng không được phép để file này phình vô hạn.
_MAX_LINES = 200_000
_lines_written = 0


def _log_path() -> Path | None:
    try:
        from app.config import settings

        base = Path(getattr(settings, "RESULTS_DIR", "") or "")
        if not str(base):
            return None
        base.mkdir(parents=True, exist_ok=True)
        return base / "gs_usage.jsonl"
    except Exception:  # noqa: BLE001
        return None


def is_ghostscript_command(cmd) -> bool:
    """`True` nếu lệnh sắp chạy là Ghostscript."""
    try:
        first = cmd[0] if isinstance(cmd, (list, tuple)) else str(cmd).split()[0]
    except Exception:  # noqa: BLE001
        return False
    stem = os.path.splitext(os.path.basename(str(first)))[0].lower()
    return stem in _GS_STEMS


def record_gs_call(reason: str, timestamp: float | None = None) -> None:
    """Ghi nhận một lần gọi Ghostscript. Không bao giờ ném ngoại lệ."""
    global _total_calls, _lines_written
    try:
        with _lock:
            _counts[reason] += 1
            _total_calls += 1
            over_cap = _lines_written >= _MAX_LINES
            if not over_cap:
                _lines_written += 1
        if over_cap:
            return
        path = _log_path()
        if path is None:
            return
        if timestamp is None:
            import time

            timestamp = time.time()
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": round(timestamp, 3), "reason": reason}) + "\n")
    except Exception as exc:  # noqa: BLE001 — bộ đếm không được làm hỏng job
        logger.debug("gs_usage: không ghi được (%s)", exc)


def summary() -> dict:
    """Thống kê từ lúc tiến trình khởi động (không đọc lại file đĩa)."""
    with _lock:
        return {
            "total_gs_calls": _total_calls,
            "by_reason": dict(_counts),
        }


def read_log_summary(limit_lines: int = 200_000) -> dict:
    """Tổng hợp từ file JSONL — dùng cho báo cáo 30 ngày của gate §8.1."""
    path = _log_path()
    if path is None or not path.is_file():
        return {"total_gs_calls": 0, "by_reason": {}, "first_ts": None, "last_ts": None}
    counts: Counter = Counter()
    first = last = None
    try:
        with path.open("r", encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                if i >= limit_lines:
                    break
                try:
                    row = json.loads(line)
                except Exception:  # noqa: BLE001 — dòng hỏng: bỏ, không chết
                    continue
                counts[row.get("reason", "?")] += 1
                ts = row.get("ts")
                if ts is not None:
                    first = ts if first is None else min(first, ts)
                    last = ts if last is None else max(last, ts)
    except Exception as exc:  # noqa: BLE001
        logger.debug("gs_usage: không đọc được log (%s)", exc)
    return {
        "total_gs_calls": sum(counts.values()),
        "by_reason": dict(counts),
        "first_ts": first,
        "last_ts": last,
    }


def reset_for_tests() -> None:
    global _total_calls, _lines_written
    with _lock:
        _counts.clear()
        _total_calls = 0
        _lines_written = 0
