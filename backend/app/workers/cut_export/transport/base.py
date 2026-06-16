"""base.py — Giao diện Transport chung.

Mỗi transport được khởi tạo với tham số riêng (đường dẫn / host:port / cổng COM),
rồi gọi send(data) → SendResult. Việc phân giải tên file theo profile thuộc tầng
service (orchestrator), transport chỉ lo đưa bytes đi.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.workers.cut_export.cut_model import SendResult


@runtime_checkable
class Transport(Protocol):
    """Đưa một khối bytes tới đích. KHÔNG ném exception cho lỗi I/O dự kiến —
    trả SendResult(ok=False, ...) để service báo lỗi rõ, không treo im lặng."""

    channel: str

    def send(self, data: bytes) -> SendResult: ...
