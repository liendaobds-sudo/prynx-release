"""Cờ rollout backend cho chiến lược "Nesting tối ưu theo đường bế".

NEST (audit 2026-08-28 §A4a-3). Module **nhẹ**: không import route, không import
engine, không chạm native — để route, worker và test đều dùng được cùng một quy
tắc mà không kéo phụ thuộc vòng.

## Vì sao cờ riêng, không dùng ``PRYNX_MIXED_NESTING_ENABLED``

``PRYNX_MIXED_NESTING_ENABLED`` gác công cụ **Bình lồng ghép tự do standalone**
(route ``/api/mixed-nesting/*``). Chiến lược này là đường **khác**: nó nằm trong
job Bình tem bế/CNC hiện hữu. Hai đường phải tắt/bật độc lập, nếu không thì kill
switch cho một đường sẽ tắt luôn đường kia.

## Cặp cờ phải bật cùng nhau

``build_production.ps1`` nung cả ``VITE_TRUE_SHAPE_NESTING_ENABLED`` (frontend)
và ``PRYNX_TRUE_SHAPE_NESTING_ENABLED`` (backend) cùng một giá trị, và có guard
throw nếu hai bên lệch trước lúc bundle. Bật lệch là trạng thái sai: UI hiện
option nhưng job trả lỗi, hoặc ngược lại.

## Mặc định HOLD

Thiếu biến môi trường ⇒ HOLD. Số đo Lô 0 cho thấy free-angle còn kém cardinal ở
8/9 ca và Cổng Chặng B chưa đóng, nên bản phát hành phải bật tường minh.
"""

from __future__ import annotations

import os
import sys

#: Tên cờ backend. Trùng chính tả với `build_production.ps1`.
TRUE_SHAPE_NESTING_FLAG_NAME = "PRYNX_TRUE_SHAPE_NESTING_ENABLED"

#: Tên cờ frontend, để test parity chốt được cặp cờ.
TRUE_SHAPE_NESTING_FRONTEND_FLAG_NAME = "VITE_TRUE_SHAPE_NESTING_ENABLED"


def _is_compiled() -> bool:
    """Bản Nuitka/frozen không được coi là dev thông dịch."""

    return "__compiled__" in globals() or bool(getattr(sys, "frozen", False))


def true_shape_nesting_enabled(
    *,
    is_development: bool | None = None,
    is_compiled: bool | None = None,
    release_flag: str | None = None,
) -> bool:
    """Mở ở dev thông dịch, hoặc khi bản phát hành bật cờ có chủ ý.

    Cùng quy tắc với ``routes/mixed_nesting._runtime_enabled`` để hai đường không
    có hai định nghĩa "dev" khác nhau.
    """

    compiled = _is_compiled() if is_compiled is None else is_compiled
    if is_development is None:
        # Import muộn: `config` kéo Pydantic settings, không nên nạp ở import-time
        # của một module cờ mà test có thể dùng độc lập.
        from app.config import settings

        development = bool(settings.DEV_MODE)
    else:
        development = is_development
    if development and not compiled:
        return True

    raw_flag = (
        os.getenv(TRUE_SHAPE_NESTING_FLAG_NAME, "false")
        if release_flag is None
        else release_flag
    )
    return raw_flag.strip().lower() == "true"
