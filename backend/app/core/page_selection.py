"""Bộ phân tích chuỗi chọn trang DÙNG CHUNG cho mọi công cụ PDF.

RESIZE (audit 2026-08-06 §G.6): trước đây có ba bản parser gần-giống-nhau
(`pdf_tools_engine.resize_pages`, `resize_background_engine._parse_pages`,
`PdfSplitter.parseRanges` bên frontend). Ba bản lệch nhau ở chỗ xử lý dải hở
"5-", token rác và số ngoài phạm vi → cùng một chuỗi có thể ra hai tập trang
khác nhau tuỳ đường chạy (nền tĩnh vs nền động). Gom về một chỗ.

Quy ước chuỗi (1-based, inclusive):
  - "all" / "even" / "odd" — từ khoá.
  - "1,3,5"   — số lẻ.
  - "2-6"     — dải đóng.
  - "7-"      — dải hở tới trang cuối.
Token trắng bị bỏ qua. Số ngoài phạm vi tài liệu bị cắt bớt (không lỗi) —
nhưng token SAI CÚ PHÁP thì `validate_page_selection` báo lỗi để API trả 422
thay vì trả về file y nguyên khiến người dùng tưởng đã xử lý (§G.5).
"""
from __future__ import annotations

KEYWORDS = ("all", "even", "odd")


def _tokens(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def normalize_selection(apply_to: str | None) -> str:
    return str(apply_to or "all").strip().lower()


def validate_page_selection(apply_to: str | None) -> None:
    """Ném ValueError nếu chuỗi chọn trang không phân tích được.

    Chuỗi rỗng → coi như "all" (hành vi mặc định của mọi endpoint).
    """
    value = normalize_selection(apply_to)
    if value in KEYWORDS:
        return

    parts = _tokens(value)
    if not parts:
        raise ValueError("Danh sách trang trống — hãy nhập ví dụ: 1,3,5-8.")

    for part in parts:
        if "-" in part:
            raw_start, _, raw_end = part.partition("-")
            start, end = raw_start.strip(), raw_end.strip()
            if not start.isdigit():
                raise ValueError(f"Dải trang không hợp lệ: '{part}'.")
            if end and not end.isdigit():
                raise ValueError(f"Dải trang không hợp lệ: '{part}'.")
            if end and int(end) < int(start):
                raise ValueError(f"Dải trang ngược: '{part}'.")
            if int(start) < 1:
                raise ValueError(f"Số trang phải từ 1 trở lên: '{part}'.")
        elif not part.isdigit():
            raise ValueError(f"Số trang không hợp lệ: '{part}'.")
        elif int(part) < 1:
            raise ValueError(f"Số trang phải từ 1 trở lên: '{part}'.")


def parse_page_selection(apply_to: str | None, total: int) -> set[int]:
    """Trả về tập CHỈ SỐ 0-based các trang được chọn, đã cắt theo `total`."""
    value = normalize_selection(apply_to)
    if total <= 0:
        return set()
    if value == "all":
        return set(range(total))
    if value == "even":
        return set(range(1, total, 2))
    if value == "odd":
        return set(range(0, total, 2))

    selected: set[int] = set()
    for part in _tokens(value):
        if "-" in part:
            raw_start, _, raw_end = part.partition("-")
            start_txt, end_txt = raw_start.strip(), raw_end.strip()
            if not start_txt.isdigit():
                continue
            start = int(start_txt)
            end = int(end_txt) if end_txt.isdigit() else total
            for page_number in range(start, end + 1):
                if 1 <= page_number <= total:
                    selected.add(page_number - 1)
        elif part.isdigit() and 1 <= int(part) <= total:
            selected.add(int(part) - 1)
    return selected
