"""
nup_sticker.py — THIN RE-EXPORT (khử trùng lặp).

Trước đây file này chứa một BẢN SAO gần như y hệt của
`sticker_imposer_pkg.layout_compute.compute_sticker_layout_for_page`
(chỉ khác dòng import + một block ghi log debug ra Desktop). Hai bản đã bắt đầu
lệch nhau → rủi ro preview (dùng layout_compute) khác với render (dùng bản này).

Để đảm bảo "single source of truth" THẬT SỰ, file này giờ chỉ re-export hàm từ
`layout_compute`. Cả preview-layout lẫn nup_engine render đều dùng CHUNG một
hàm → không thể lệch.

Các importer hiện tại (giữ nguyên, không cần sửa):
  - app/workers/nup_engine.py
  - app/api/routes/imposition.py
"""

from app.workers.sticker_imposer_pkg.layout_compute import (  # noqa: F401
    compute_sticker_layout_for_page,
)

__all__ = ["compute_sticker_layout_for_page"]
