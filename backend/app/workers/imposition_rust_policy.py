"""
Chính sách Rust/fallback dùng chung cho imposition (Task 13-ext / Req 7).

Mặc định: Rust (`pdfcompare_native`) là BẮT BUỘC cho việc tính layout/output.
Nếu thiếu Rust → FAIL-FAST (không âm thầm cho kết quả khác bằng Python).
Đặt IMPOSITION_ALLOW_PY_FALLBACK=1 để cho phép fallback Python (có cảnh báo log;
KHÔNG đảm bảo parity — xem tests/parity/KNOWN_DIVERGENCES.md).
"""
import os
import logging

logger = logging.getLogger(__name__)

try:
    import pdfcompare_native  # noqa: F401
    RUST_AVAILABLE = True
except ImportError:
    RUST_AVAILABLE = False

ALLOW_FALLBACK = os.environ.get("IMPOSITION_ALLOW_PY_FALLBACK", "0") == "1"

_warned = False


def require_rust(context: str = "imposition"):
    """Gọi ở đầu các entry tính layout. Fail-fast nếu Rust thiếu mà fallback tắt."""
    global _warned
    if RUST_AVAILABLE:
        return
    if ALLOW_FALLBACK:
        if not _warned:
            logger.warning(
                "[IMPOSITION] %s dùng fallback Python (Rust thiếu, "
                "IMPOSITION_ALLOW_PY_FALLBACK=1) — KHÔNG đảm bảo parity.",
                context,
            )
            _warned = True
        return
    raise RuntimeError(
        f"imposition_core (Rust 'pdfcompare_native') không khả dụng cho '{context}' "
        f"và fallback đang TẮT. Build/cài module Rust, hoặc đặt "
        f"IMPOSITION_ALLOW_PY_FALLBACK=1 nếu chấp nhận khác biệt parity."
    )
