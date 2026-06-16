"""base.py — Giao diện Emitter chung.

Emitter nhận CutModel (mm) và trả bytes đầu ra. Cấu hình riêng từng emitter
(tên layer/spot-color, có vẽ ốc...) truyền qua constructor để tách khỏi MachineProfile
(profile được hiện thực ở task 5; service sẽ dựng emitter từ profile).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.workers.cut_export.cut_model import CutModel


@runtime_checkable
class Emitter(Protocol):
    name: str

    def emit(self, model: CutModel) -> bytes: ...
