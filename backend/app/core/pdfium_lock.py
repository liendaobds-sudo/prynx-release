"""Khóa serialize hoá mọi truy cập PDFium trong MỘT process.

KIENTRUC (audit 2026-07-29 §C.1)

PDFium KHÔNG thread-safe: upstream pypdfium2 khẳng định gọi hàm pdfium đồng thời từ
nhiều thread là KHÔNG được phép, hậu quả tuỳ ý (kể cả lỗi bộ nhớ/bảo mật). Trong
backend này rủi ro là THẬT chứ không lý thuyết: rất nhiều đường đi đẩy việc sang
thread bằng `asyncio.to_thread` (softproof, layer_engine, page_boxes, geometry_reader,
separations) trên executor mặc định — KHÔNG có admission control, nên 2 request đồng
thời là 2 thread cùng gọi PDFium.

Khóa bao CẢ hai đường:
  - `pdfcompare_native` (Rust/pdfium-render) — PyO3 nhả GIL khi làm việc nặng nên hai
    lời gọi Rust từ hai thread Python chạy song song thật;
  - `pypdfium2` phía Python.
Không tách hai khóa vì `native/src/pdfium_init.rs` có nhánh nạp CHÍNH file
`pypdfium2_raw/pdfium.dll` → hai bên có thể dùng chung một instance thư viện.

Module này CỐ TÌNH không import gì nặng (không `pdfcompare_native`, không `pypdfium2`):
nơi nào chỉ cần khóa thì import được mà không kéo theo việc nạp extension Rust hay
tác dụng lề đặt biến môi trường của `rust_bridge`. `rust_bridge` re-export lại hai tên
này để đường import đã ghi trong AGENTS.md vẫn dùng được.

HIỆU NĂNG (rule #1): khóa chỉ giới hạn TRONG process. Song song thật của việc nặng
(bình bản, VDP, tem, preflight file lớn) đến từ `ProcessPoolExecutor` /
`multiprocessing.Process` — mỗi process có PDFium riêng nên không bị khóa này chặn.
Vì vậy PHẢI giữ nguyên nguyên tắc: việc nặng đi process, không đi thread.
"""

from __future__ import annotations

import logging
import sys
import threading
from contextlib import contextmanager
from typing import Iterator

logger = logging.getLogger(__name__)

# RLock (không phải Lock): một thread đã giữ khóa còn gọi tiếp hàm khác cũng có guard
# thì không tự deadlock (vd `render_with_hidden_layers` → `render_page_image`).
PDFIUM_PY_LOCK = threading.RLock()

# KIENTRUC (audit 2026-08-13 §P25.1, thuộc W7-U01): pypdfium2 đóng tài nguyên bằng
# `weakref.finalize` — khi một wrapper (PdfPage/PdfBitmap/PdfDocument) chết trong
# CHU KỲ GC thay vì refcount, finalizer chạy trên THREAD BẤT KỲ đang cấp phát tại
# thời điểm GC, tức gọi FPDF_ClosePage/... NGOÀI pdfium_guard, song song với thread
# khác đang ở trong khóa → access violation (đã tái hiện 4/30 lần trên pipeline so
# sánh song song). Bịt trung tâm: bọc `_close_template` của pypdfium2 để MỌI
# finalizer tương lai phải đi qua PDFIUM_PY_LOCK. Cài đặt lười + idempotent, chỉ
# khi pypdfium2 đã nạp — module này vẫn không kéo import nặng.
_FINALIZER_GUARD_DONE = False


def _maybe_install_pypdfium2_finalizer_guard() -> None:
    """Cài guard cho finalizer pypdfium2 (gọi khi ĐANG giữ PDFIUM_PY_LOCK)."""
    global _FINALIZER_GUARD_DONE
    bases = sys.modules.get("pypdfium2.internal.bases")
    if bases is None:
        # pypdfium2 chưa được import → chưa tồn tại wrapper nào cần bảo vệ.
        # Thử lại ở lần vào guard kế tiếp (cờ chưa bật).
        return
    original = getattr(bases, "_close_template", None)
    if original is None:
        # pypdfium2 đổi internal — không chặn được ở tầng này; ghi nhận một lần
        # để re-audit khi nâng cấp thư viện, không làm hỏng luồng chính.
        logger.warning(
            "pypdfium2.internal.bases._close_template không tồn tại — "
            "finalizer GC sẽ KHÔNG được bọc pdfium_guard; kiểm tra lại khi nâng cấp pypdfium2."
        )
        _FINALIZER_GUARD_DONE = True
        return
    if getattr(original, "_prynx_pdfium_guarded", False):
        _FINALIZER_GUARD_DONE = True
        return

    def _guarded_close_template(*args, **kwargs):
        with PDFIUM_PY_LOCK:
            return original(*args, **kwargs)

    _guarded_close_template._prynx_pdfium_guarded = True  # type: ignore[attr-defined]
    bases._close_template = _guarded_close_template
    _FINALIZER_GUARD_DONE = True
    logger.info("Đã bọc finalizer pypdfium2 trong PDFIUM_PY_LOCK (chống GC chạy ngoài khóa).")


@contextmanager
def pdfium_guard(what: str = "pdfium") -> Iterator[None]:
    """Vào vùng truy cập PDFium độc quyền trong process.

    Giữ vùng khóa NGẮN: chỉ bọc lời gọi PDFium (mở tài liệu, render, đọc object),
    KHÔNG bọc encode ảnh, ghi đĩa, subprocess hay chờ mạng — giữ lâu là biến khóa an
    toàn thành nút cổ chai.

    `what` chỉ để đọc log/trace khi cần chẩn đoán; không ảnh hưởng hành vi.
    """
    with PDFIUM_PY_LOCK:
        if not _FINALIZER_GUARD_DONE:
            _maybe_install_pypdfium2_finalizer_guard()
        yield
