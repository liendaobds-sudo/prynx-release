"""Chuẩn hoá lựa chọn CẠNH bù xén cho "Bù xén - Tạo đường cắt" (Xén vuông góc).

Trước đây bù xén luôn nở ĐỀU 4 cạnh. Thực tế nhà in nhiều khi chỉ cần bù một
hoặc hai cạnh:

* Tem/nhãn cắt từ cuộn: chỉ bù 2 cạnh dọc (trái/phải), 2 đầu đã có sẵn lề.
* Bài đã dán biên một phía (gáy sách, mép dán hộp) — bù thêm sẽ lệch khổ.
* File thiết kế tràn lề sẵn 2 cạnh, chỉ thiếu 2 cạnh còn lại.

Module CỐ TÌNH giữ thật nhẹ (không import pikepdf/cv2/pdfium) để cả tầng
``app.core.page_boxes`` (nhánh Lật gương) lẫn ``app.workers.sticker_engine``
(nhánh Kéo giãn/Làm mượt/Đổ màu trơn) và tầng API đều dùng chung được một bộ
quy tắc phân giải, tránh lệch ngữ nghĩa giữa các nhánh.

Thứ tự chuẩn (canonical) của tuple trả về: ``(trái, phải, dưới, trên)``.
"""

from __future__ import annotations

import re

# Thứ tự chuẩn dùng xuyên suốt backend. Đổi thứ tự này là phá vỡ mọi caller.
BLEED_SIDE_NAMES: tuple[str, str, str, str] = ("left", "right", "bottom", "top")

# Mặc định lịch sử: nở đều 4 cạnh (giữ nguyên hành vi các build cũ).
ALL_BLEED_SIDES: tuple[bool, bool, bool, bool] = (True, True, True, True)

NO_BLEED_SIDES: tuple[bool, bool, bool, bool] = (False, False, False, False)

# Bí danh chấp nhận được cho từng cạnh. Nhận cả tiếng Việt không dấu để payload
# từ UI/recipe cũ hay script nội bộ đều đọc được, và cả 1 ký tự viết tắt (L/R/B/T)
# cho dạng mask gọn "LR", "TB".
_SIDE_ALIASES: dict[str, str] = {
    "left": "left", "l": "left", "trai": "left", "west": "left", "w": "left",
    "right": "right", "r": "right", "phai": "right", "east": "right", "e": "right",
    "bottom": "bottom", "b": "bottom", "duoi": "bottom", "south": "bottom", "s": "bottom",
    "top": "top", "t": "top", "tren": "top", "north": "top", "n": "top",
}

# Từ khoá "bật hết" / "tắt hết" — tiện cho form-data và CLI.
_ALL_TOKENS = {"all", "tatca", "tat_ca", "4", "full", "*"}
_NONE_TOKENS = {"none", "khong", "0", "empty", "-"}

_SPLIT_RE = re.compile(r"[,;+|/\s]+")

_TRUE_TOKENS = {"1", "true", "yes", "y", "on", "co"}
_FALSE_TOKENS = {"0", "false", "no", "n", "off", "khong"}


def _as_bool(value) -> bool:
    """Ép một giá trị lẻ về bool, chịu được chuỗi "true"/"0" từ form-data."""
    if isinstance(value, str):
        token = value.strip().lower()
        if token in _TRUE_TOKENS:
            return True
        if token in _FALSE_TOKENS:
            return False
        return bool(token)
    return bool(value)


def _from_names(names) -> tuple[bool, bool, bool, bool]:
    """Dựng tuple từ tập tên cạnh đã tách. Tên lạ bị bỏ qua (không raise)."""
    enabled = {"left": False, "right": False, "bottom": False, "top": False}
    saw_keyword_all = False
    for raw in names:
        token = str(raw).strip().lower().replace("-", "").replace("_", "")
        if not token:
            continue
        if token in _ALL_TOKENS:
            saw_keyword_all = True
            continue
        if token in _NONE_TOKENS:
            continue
        canonical = _SIDE_ALIASES.get(token)
        if canonical is not None:
            enabled[canonical] = True
            continue
        # Dạng mask liền không dấu phân cách: "lr", "tb", "tblr".
        if all(ch in _SIDE_ALIASES for ch in token):
            for ch in token:
                enabled[_SIDE_ALIASES[ch]] = True
    if saw_keyword_all:
        return ALL_BLEED_SIDES
    return tuple(enabled[name] for name in BLEED_SIDE_NAMES)  # type: ignore[return-value]


def normalize_bleed_sides(value) -> tuple[bool, bool, bool, bool]:
    """Phân giải mọi dạng biểu diễn "cạnh nào được bù xén" về ``(trái, phải, dưới, trên)``.

    Chấp nhận:

    * ``None`` / chuỗi rỗng → nở đều 4 cạnh (mặc định tương thích ngược, BẮT BUỘC
      giữ để build UI cũ và recipe cũ không đổi kết quả).
    * chuỗi: ``"left,right"``, ``"trai phai"``, ``"LR"``, ``"all"``, ``"none"``.
    * dict: ``{"left": True, "top": False, ...}`` (bỏ sót khoá = cạnh đó tắt).
    * iterable tên cạnh: ``["left", "bottom"]``.
    * iterable 4 bool theo đúng thứ tự chuẩn: ``(True, False, True, False)``.

    Không bao giờ raise: dữ liệu rác → coi như không chọn cạnh nào để tầng gọi tự
    quyết (thường là hạ bù xén về 0) thay vì làm sập job bù xén của người dùng.
    """
    if value is None:
        return ALL_BLEED_SIDES

    if isinstance(value, str):
        token = value.strip().lower()
        if not token:
            return ALL_BLEED_SIDES
        return _from_names(_SPLIT_RE.split(token))

    if isinstance(value, dict):
        # Dict chỉ liệt kê cạnh BẬT cũng hợp lệ; khoá thiếu = tắt.
        enabled = {"left": False, "right": False, "bottom": False, "top": False}
        for raw_key, raw_val in value.items():
            key = str(raw_key).strip().lower().replace("-", "").replace("_", "")
            canonical = _SIDE_ALIASES.get(key)
            if canonical is not None:
                enabled[canonical] = _as_bool(raw_val)
        return tuple(enabled[name] for name in BLEED_SIDE_NAMES)  # type: ignore[return-value]

    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        # Tuple 4 bool theo thứ tự chuẩn (không lẫn chuỗi tên cạnh).
        if len(items) == 4 and all(isinstance(item, (bool, int)) and not isinstance(item, str) for item in items):
            return tuple(bool(item) for item in items)  # type: ignore[return-value]
        return _from_names(items)

    return ALL_BLEED_SIDES


def bleed_sides_to_names(sides) -> list[str]:
    """Danh sách tên cạnh đang bật — dùng cho log/meta để đọc được bằng mắt."""
    resolved = normalize_bleed_sides(sides)
    return [name for name, on in zip(BLEED_SIDE_NAMES, resolved) if on]


def bleed_side_amounts(
    bleed: float,
    sides=None,
) -> tuple[float, float, float, float]:
    """Quy lượng bù xén thành 4 số theo cạnh: cạnh tắt = 0, cạnh bật = ``bleed``.

    Trả về theo thứ tự chuẩn ``(trái, phải, dưới, trên)``.
    """
    amount = max(0.0, float(bleed or 0.0))
    left, right, bottom, top = normalize_bleed_sides(sides)
    return (
        amount if left else 0.0,
        amount if right else 0.0,
        amount if bottom else 0.0,
        amount if top else 0.0,
    )
