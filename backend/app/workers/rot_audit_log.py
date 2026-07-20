"""Bộ ghi log [ROT-AUDIT] ra FILE dùng chung — để audit lệch lật trục/xoay giữa
preview (Bình trang S&R) và render thật.

Ghi ra: <backend>/rot_audit.log (append). Mỗi process (kể cả worker của
ProcessPoolExecutor) tự gắn 1 FileHandler vào logger 'rot_audit' khi import.
Gọi get_logger() ở mọi nơi cần log audit để bảo đảm cùng đích.
"""
import logging
import os

_LOG_NAME = "rot_audit"
_LOG_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "rot_audit.log",
)
_ROT_AUDIT_ENABLED = os.getenv("PRYNX_ROT_AUDIT", "").strip().lower() in {
    "1", "true", "yes", "on",
}



def get_logger() -> logging.Logger:
    log = logging.getLogger(_LOG_NAME)
    log.setLevel(logging.DEBUG)
    log.propagate = False
    # Tránh gắn trùng handler khi module được import nhiều lần trong cùng process.
    # Per-placement rotation tracing is diagnostic-only. Keeping it enabled in
    # production created multi-million-line files and slowed large impositions.
    if not _ROT_AUDIT_ENABLED:
        log.disabled = True
        return log
    log.disabled = False
    already = any(
        isinstance(h, logging.FileHandler)
        and getattr(h, "_rot_audit", False)
        for h in log.handlers
    )
    if not already:
        try:
            fh = logging.FileHandler(_LOG_FILE, mode="a", encoding="utf-8")
            fh.setLevel(logging.DEBUG)
            fh.setFormatter(logging.Formatter("%(asctime)s %(process)d %(message)s"))
            fh._rot_audit = True  # type: ignore[attr-defined]
            log.addHandler(fh)
        except Exception:
            pass
    return log


def log_path() -> str:
    return _LOG_FILE
