"""Chạy parse file KHÔNG tin cậy trong PROCESS CON để crash không hạ sidecar.

Bối cảnh (pentest 2026-08-28 §ATK.04): PDFium (C++), qpdf và codec Pillow parse file do
khách đưa vào NGAY TRONG process sidecar. Một lỗi bộ nhớ ở đó không raise exception Python
mà giết cả tiến trình — mất toàn bộ phiên làm việc của người dùng, xấu nhất là chạy mã.
Nâng parser lên bản có vá (đã làm) giảm rủi ro, nhưng không loại được lỗi CHƯA ai vá.

Module này là ranh giới process cho các đường parse đó.

## Vì sao là pool giữ sẵn, không phải `multiprocessing.Process` mỗi lần

Đo thực trên Windows (spawn), parse một PDF 8 trang, 10 lượt:

| Cấu hình | ms/lần |
|---|---|
| in-process (trước đây) | 0,42 |
| **pool giữ sẵn, tái dùng worker** | **0,74** |
| process mới mỗi lần (khuôn `office_job_runner`) | 165,86 |

Spawn trên Windows phải nạp lại interpreter + `pikepdf`/`pypdfium2` nên tốn ~165 ms —
không thể trả giá đó cho MỖI lần mở file. Pool giữ sẵn chỉ thêm ~0,3 ms (chi phí pickle
+ IPC), tức cách ly gần như miễn phí. `office_job_runner` vẫn dùng khuôn process-mỗi-lần
vì convert Office kéo dài hàng giây, chi phí spawn không đáng kể ở đó.

## Bất biến

- Hàm gửi vào phải ở **cấp module** và picklable (spawn pickle theo tên), trả giá trị
  JSON-an-toàn. KHÔNG gửi `pikepdf.Pdf`/`PdfDocument` qua ranh giới process.
- Worker chết vì lỗi bộ nhớ ⇒ `BrokenProcessPool` ⇒ ta dựng pool mới và raise
  `IsolatedParseCrashed`. Sidecar **sống**, request đó trả lỗi sạch.
- Mỗi process có PDFium/qpdf riêng nên KHÔNG cần `pdfium_guard()` bên trong worker;
  khóa đó chỉ có phạm vi một process (xem `pdfium_lock.py`).
- Tắt được bằng `PRYNX_PARSER_SANDBOX=off` để gỡ lỗi. Mặc định BẬT (fail-safe).
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Trần thời gian cho MỘT lần parse. Một file dựng độc có thể đẩy parser vào vòng lặp
# gần-vô-hạn; không có trần thì worker treo và mọi lần mở file sau bị chặn theo.
# Người vận hành nới được qua env cho tài liệu cực lớn.
_DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("PRYNX_PARSER_SANDBOX_TIMEOUT", "120") or 120)

_pool_lock = threading.Lock()
_pool: ProcessPoolExecutor | None = None


class IsolatedParseError(RuntimeError):
    """Gốc cho mọi thất bại của tầng cách ly (không phải lỗi nghiệp vụ của parser)."""


class IsolatedParseCrashed(IsolatedParseError):
    """Process con chết bất thường — dấu hiệu lỗi bộ nhớ trong parser."""


class IsolatedParseTimeout(IsolatedParseError):
    """Parse vượt trần thời gian; worker đã bị thu hồi."""


def sandbox_enabled() -> bool:
    """`False` khi người vận hành tắt tường minh bằng `PRYNX_PARSER_SANDBOX=off`."""
    raw = (os.environ.get("PRYNX_PARSER_SANDBOX") or "").strip().lower()
    return raw not in {"off", "0", "false", "no"}


def _new_pool() -> ProcessPoolExecutor:
    # `spawn` tường minh: `fork` sao chép trạng thái PDFium/khóa của tiến trình cha,
    # đúng loại lỗi khó tái lập mà ta đang tránh. Windows chỉ có spawn; ép luôn để
    # hành vi giống nhau trên mọi nền.
    context = multiprocessing.get_context("spawn")
    # Một worker là đủ và là lựa chọn có chủ ý: PrynX là app desktop một người dùng,
    # còn PDFium vốn không thread-safe nên song song thật đến từ nhiều PROCESS ở tầng
    # job nặng, không phải ở tầng mở file. Một worker cũng giữ RAM thấp cho máy yếu.
    return ProcessPoolExecutor(max_workers=1, mp_context=context)


def _discard_pool_locked(pool: ProcessPoolExecutor, *, kill: bool) -> None:
    """Bỏ pool hiện tại. `kill=True` diệt worker đang treo thay vì chờ nó xong."""
    if kill:
        # Timeout: worker vẫn đang chạy nên `shutdown(wait=True)` sẽ treo theo. Phải
        # diệt tiến trình. `_processes` là API nội bộ của CPython nên bọc phòng hờ.
        try:
            for process in list(getattr(pool, "_processes", {}).values()):
                try:
                    process.kill()
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            logger.debug("Không liệt kê được worker để diệt", exc_info=True)
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:  # noqa: BLE001
        logger.debug("shutdown pool cách ly thất bại", exc_info=True)


def reset_pool() -> None:
    """Đóng pool hiện tại (dùng cho test và lúc dọn tiến trình)."""
    global _pool
    with _pool_lock:
        pool, _pool = _pool, None
    if pool is not None:
        _discard_pool_locked(pool, kill=True)


def run_isolated(
    function: Callable[..., T],
    *args: Any,
    timeout: float | None = None,
    **kwargs: Any,
) -> T:
    """Chạy `function(*args, **kwargs)` trong process con và trả kết quả.

    Ném `IsolatedParseCrashed` nếu worker chết (nghi lỗi bộ nhớ parser),
    `IsolatedParseTimeout` nếu vượt trần. Exception NGHIỆP VỤ do chính `function`
    raise (ví dụ `pikepdf.PdfError`) được truyền nguyên vẹn về caller như khi chạy
    cùng process — nhờ vậy chỗ gọi không phải viết lại logic phân loại lỗi.

    Khi sandbox bị tắt bằng env, hàm chạy thẳng trong process hiện tại.
    """
    if not sandbox_enabled():
        return function(*args, **kwargs)

    global _pool
    deadline = _DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout

    with _pool_lock:
        if _pool is None:
            _pool = _new_pool()
        pool = _pool

    try:
        return pool.submit(function, *args, **kwargs).result(timeout=deadline)
    except BrokenProcessPool as exc:
        # Đây là tín hiệu ta dựng module này để bắt: worker chết giữa lúc parse.
        with _pool_lock:
            if _pool is pool:
                _pool = None
        _discard_pool_locked(pool, kill=True)
        logger.error(
            "[SEC][§ATK.04] Process con parse file đã chết — nghi lỗi bộ nhớ trong "
            "parser. Sidecar vẫn sống nhờ cách ly. Hàm: %s",
            getattr(function, "__qualname__", function),
        )
        raise IsolatedParseCrashed(
            "Tiến trình đọc file đã dừng bất thường. File có thể bị hỏng hoặc không an toàn."
        ) from exc
    except TimeoutError as exc:
        with _pool_lock:
            if _pool is pool:
                _pool = None
        _discard_pool_locked(pool, kill=True)
        logger.warning(
            "[SEC][§ATK.04] Parse file vượt %.0fs, đã thu hồi worker. Hàm: %s",
            deadline,
            getattr(function, "__qualname__", function),
        )
        raise IsolatedParseTimeout(
            f"Đọc file vượt quá {deadline:.0f} giây và đã được dừng an toàn."
        ) from exc
