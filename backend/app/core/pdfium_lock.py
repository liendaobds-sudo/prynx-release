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

import threading
from contextlib import contextmanager
from typing import Iterator

# RLock (không phải Lock): một thread đã giữ khóa còn gọi tiếp hàm khác cũng có guard
# thì không tự deadlock (vd `render_with_hidden_layers` → `render_page_image`).
PDFIUM_PY_LOCK = threading.RLock()


@contextmanager
def pdfium_guard(what: str = "pdfium") -> Iterator[None]:
    """Vào vùng truy cập PDFium độc quyền trong process.

    Giữ vùng khóa NGẮN: chỉ bọc lời gọi PDFium (mở tài liệu, render, đọc object),
    KHÔNG bọc encode ảnh, ghi đĩa, subprocess hay chờ mạng — giữ lâu là biến khóa an
    toàn thành nút cổ chai.

    `what` chỉ để đọc log/trace khi cần chẩn đoán; không ảnh hưởng hành vi.
    """
    with PDFIUM_PY_LOCK:
        yield
