"""PERF (audit 2026-09-11 §PREWARM.CANCEL): hủy hợp tác cho preview CUT.

Luồng thường chỉ dùng Event cục bộ; chỉ tạo một byte bộ nhớ dùng chung khi
thật sự gửi việc sang process. Chủ token phải đợi mọi future kết thúc (kể cả
future đã yêu cầu hủy) trước khi gọi close; worker chỉ đóng bản attach của nó.
Mô-đun này không giữ hình học và không đọc/ghi memo Simplify.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from multiprocessing import shared_memory
from threading import Event, Lock
from typing import Iterator


class PreviewCancelled(BaseException):
    """Hủy công việc cũ mà không rơi vào các nhánh dự phòng ``except Exception``."""


class PreviewCancellation:
    """Token hủy cục bộ, có thể chia sẻ cờ hủy với worker khi cần."""

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._shared: shared_memory.SharedMemory | None = None
        self._owns_shared = True
        self._closed = False

    @classmethod
    def attach(cls, name: str) -> PreviewCancellation:
        """Mở cờ của chủ token; bản worker không có quyền unlink vùng nhớ."""
        token = cls()
        token._shared = shared_memory.SharedMemory(name=name, create=False)
        token._owns_shared = False
        return token

    def export_shared_name(self) -> str:
        """Cấp cờ liên process lười; gọi lặp dùng lại cùng một vùng nhớ."""
        with self._lock:
            if self._closed:
                raise RuntimeError("Token hủy preview đã đóng.")
            if self._shared is None:
                shared = shared_memory.SharedMemory(create=True, size=1)
                shared.buf[0] = int(self._event.is_set())
                self._shared = shared
            return self._shared.name

    def cancel(self) -> None:
        """Giữ hủy một chiều; gọi sau close vẫn cập nhật trạng thái cục bộ."""
        with self._lock:
            self._event.set()
            if self._shared is not None:
                self._shared.buf[0] = 1

    def check(self) -> None:
        """Dừng tại checkpoint, không trả hình học tính dở như kết quả hợp lệ."""
        if self._event.is_set():
            raise PreviewCancelled("Yêu cầu preview đã bị hủy.")
        with self._lock:
            # PERF (audit 2026-09-11 §PREWARM.CANCEL): khóa cả lúc đọc để
            # close ở thread khác không thu hồi handle giữa hai thao tác.
            if self._shared is not None and self._shared.buf[0]:
                self._event.set()
            if self._event.is_set():
                raise PreviewCancelled("Yêu cầu preview đã bị hủy.")

    def close(self) -> None:
        """Đóng lặp an toàn; chủ token chỉ gọi sau mọi future đã terminal."""
        with self._lock:
            if self._closed:
                return
            shared = self._shared
            if shared is None:
                self._closed = True
                return
            if shared.buf[0]:
                self._event.set()
            try:
                if self._owns_shared:
                    try:
                        shared.unlink()
                    except FileNotFoundError:
                        pass
            finally:
                shared.close()
                self._shared = None
                self._closed = True


_CURRENT_CANCELLATION: ContextVar[PreviewCancellation | None] = ContextVar(
    "cutline_preview_cancellation", default=None
)


@contextmanager
def cancellation_scope(token: PreviewCancellation | None) -> Iterator[None]:
    """Gắn token vào đúng context và khôi phục scope ngoài kể cả khi bị hủy."""
    context_token = _CURRENT_CANCELLATION.set(token)
    try:
        yield
    finally:
        _CURRENT_CANCELLATION.reset(context_token)


def current_cancellation() -> PreviewCancellation | None:
    """Lấy token của công việc hiện tại; luồng cũ không có token trả None."""
    return _CURRENT_CANCELLATION.get()


def check_preview_cancelled() -> None:
    """Không có token thì không tác động pipeline, memo hay hình học CUT."""
    token = _CURRENT_CANCELLATION.get()
    if token is not None:
        token.check()
