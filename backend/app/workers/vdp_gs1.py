"""Lõi GS1 thuần (pure) cho VDP — parse / validate / build / human-readable / check-digit.

Module này KHÔNG import ReportLab và không phụ thuộc engine render, nên dễ kiểm thử
bằng property-based testing (Hypothesis). Phần render thực tế (DataMatrix / GS1-128)
nằm ở `vdp_engine.render_2d` (task 6.6).

Hỗ trợ tối thiểu các Application Identifier (AI) theo design:
  - `01` GTIN      : 14 chữ số (độ dài cố định)
  - `17` hạn dùng  : 6 chữ số YYMMDD (độ dài cố định)
  - `10` số lô     : 1–20 ký tự chữ-số (độ dài thay đổi)
  - `21` serial    : 1–20 ký tự chữ-số (độ dài thay đổi)

Quy ước biểu diễn FNC1 trong payload (dạng chuỗi thuần): ký tự GS ASCII `\\x1d`.
Đây là placeholder logic cho FNC1; lớp render sẽ ánh xạ sang ký hiệu FNC1 thật của
symbology tương ứng.

Tham chiếu requirements: 3.2, 3.3, 3.4, 3.6, 3.10.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# FNC1 — dùng ký tự GS (Group Separator, ASCII 29) làm placeholder logic.
FNC1 = "\x1d"

# Tập ký tự chữ-số (alphanumeric) cho các AI biến độ dài (10, 21).
_ALNUM_RE = re.compile(r"^[0-9A-Za-z]+$")
_DIGITS_RE = re.compile(r"^[0-9]+$")


class GS1Error(ValueError):
    """Lỗi parse/validate GS1. Mang theo mã lỗi và thông báo tiếng Việt."""

    def __init__(self, message: str, code: str = "GS1_INVALID"):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class _AIDef:
    ai: str
    fixed_len: bool
    length: int | None       # độ dài cố định (chỉ với fixed_len=True)
    min_len: int             # độ dài tối thiểu của dữ liệu
    max_len: int             # độ dài tối đa của dữ liệu
    kind: str                # 'digits' | 'alnum' | 'date6'


# Bảng định nghĩa AI được hỗ trợ (Req 3.4).
AI_DEFS: dict[str, _AIDef] = {
    "01": _AIDef("01", fixed_len=True,  length=14, min_len=14, max_len=14, kind="digits"),
    "17": _AIDef("17", fixed_len=True,  length=6,  min_len=6,  max_len=6,  kind="date6"),
    "10": _AIDef("10", fixed_len=False, length=None, min_len=1, max_len=20, kind="alnum"),
    "21": _AIDef("21", fixed_len=False, length=None, min_len=1, max_len=20, kind="alnum"),
}


@dataclass
class AIElement:
    """Một phần tử AI đã được phân giải khỏi chuỗi GS1."""

    ai: str
    data: str
    fixed_len: bool = False

    def __post_init__(self):
        # Tự suy ra fixed_len từ bảng định nghĩa nếu AI được hỗ trợ.
        defn = AI_DEFS.get(self.ai)
        if defn is not None:
            self.fixed_len = defn.fixed_len


def _is_valid_date6(data: str) -> bool:
    """Kiểm tra YYMMDD: 6 chữ số, MM trong 01..12, DD trong 00..31.

    GS1 cho phép DD = '00' để biểu thị 'cuối tháng', nên chấp nhận 00..31.
    """
    if len(data) != 6 or not _DIGITS_RE.match(data):
        return False
    mm = int(data[2:4])
    dd = int(data[4:6])
    return 1 <= mm <= 12 and 0 <= dd <= 31


def validate_ai(el: AIElement) -> None:
    """Kiểm tra định dạng và độ dài dữ liệu của một AI (Req 3.4).

    Raise GS1Error nếu AI không được hỗ trợ hoặc dữ liệu vi phạm độ dài /
    tập ký tự / định dạng ngày.
    """
    defn = AI_DEFS.get(el.ai)
    if defn is None:
        raise GS1Error(f"AI '{el.ai}' chưa được hỗ trợ", code="GS1_AI_UNSUPPORTED")

    data = el.data
    if defn.fixed_len:
        if len(data) != defn.length:
            raise GS1Error(
                f"AI '{el.ai}' yêu cầu đúng {defn.length} ký tự, nhận {len(data)}",
                code="GS1_LENGTH",
            )
    else:
        if not (defn.min_len <= len(data) <= defn.max_len):
            raise GS1Error(
                f"AI '{el.ai}' yêu cầu độ dài {defn.min_len}–{defn.max_len} ký tự, "
                f"nhận {len(data)}",
                code="GS1_LENGTH",
            )

    if defn.kind == "digits":
        if not _DIGITS_RE.match(data):
            raise GS1Error(f"AI '{el.ai}' chỉ chấp nhận chữ số", code="GS1_CHARSET")
    elif defn.kind == "alnum":
        if not _ALNUM_RE.match(data):
            raise GS1Error(
                f"AI '{el.ai}' chỉ chấp nhận ký tự chữ-số", code="GS1_CHARSET"
            )
    elif defn.kind == "date6":
        if not _is_valid_date6(data):
            raise GS1Error(
                f"AI '{el.ai}' phải có định dạng YYMMDD hợp lệ", code="GS1_DATE"
            )


_PAREN_RE = re.compile(r"\((\d{2,4})\)([^(]*)")


def parse_gs1(raw: str) -> list[AIElement]:
    """Phân tích chuỗi GS1 thành danh sách AIElement (Req 3.2, 3.3, 3.4).

    Hỗ trợ hai dạng đầu vào:
      1. Dạng ngoặc người-đọc: ``(01)08412345678905(17)261231(10)LOT42``
      2. Dạng nối FNC1: payload do ``build_gs1_payload`` sinh ra (FNC1 = \\x1d),
         AI cố định đọc theo độ dài đã biết, AI biến độ dài đọc tới FNC1/kết thúc.

    Mỗi phần tử được validate ngay; AI không hỗ trợ hoặc dữ liệu sai → GS1Error.
    """
    if raw is None:
        raise GS1Error("Chuỗi GS1 rỗng", code="GS1_EMPTY")

    if "(" in raw:
        elems = _parse_parenthesized(raw)
    else:
        elems = _parse_concatenated(raw)

    if not elems:
        raise GS1Error("Chuỗi GS1 không chứa AI nào", code="GS1_EMPTY")

    for el in elems:
        validate_ai(el)
    return elems


def _parse_parenthesized(raw: str) -> list[AIElement]:
    elems: list[AIElement] = []
    pos = 0
    for m in _PAREN_RE.finditer(raw):
        if m.start() != pos:
            # Có ký tự lạ giữa các nhóm (AI) → chuỗi dị dạng.
            stray = raw[pos:m.start()].strip()
            if stray:
                raise GS1Error(
                    f"Ký tự không hợp lệ trong chuỗi GS1: '{stray}'",
                    code="GS1_MALFORMED",
                )
        ai = m.group(1)
        data = m.group(2)
        if ai not in AI_DEFS:
            raise GS1Error(f"AI '{ai}' chưa được hỗ trợ", code="GS1_AI_UNSUPPORTED")
        elems.append(AIElement(ai=ai, data=data))
        pos = m.end()
    if pos != len(raw) and raw[pos:].strip():
        raise GS1Error(
            f"Ký tự thừa cuối chuỗi GS1: '{raw[pos:].strip()}'", code="GS1_MALFORMED"
        )
    return elems


def _parse_concatenated(raw: str) -> list[AIElement]:
    elems: list[AIElement] = []
    s = raw
    i = 0
    n = len(s)
    while i < n:
        # Bỏ qua các ký tự phân tách FNC1.
        if s[i] == FNC1:
            i += 1
            continue
        ai = s[i:i + 2]
        defn = AI_DEFS.get(ai)
        if defn is None:
            raise GS1Error(f"AI '{ai}' chưa được hỗ trợ", code="GS1_AI_UNSUPPORTED")
        i += 2
        if defn.fixed_len:
            data = s[i:i + defn.length]
            i += defn.length
        else:
            j = i
            while j < n and s[j] != FNC1:
                j += 1
            data = s[i:j]
            i = j
        elems.append(AIElement(ai=ai, data=data))
    return elems


def build_gs1_payload(elems: list[AIElement]) -> str:
    """Dựng payload GS1 với FNC1 (Req 3.2, 3.3).

    - Đặt FNC1 ở vị trí khởi đầu (đánh dấu khởi đầu dữ liệu GS1).
    - Chèn FNC1 sau một AI có độ dài thay đổi KHI và CHỈ KHI còn AI phía sau,
      để phân tách rõ ranh giới AI biến độ dài (parse lại được không nhập nhằng).
    - AI có độ dài cố định không cần ký tự phân tách phía sau.
    """
    if not elems:
        raise GS1Error("Không có AI để dựng payload", code="GS1_EMPTY")

    parts = [FNC1]
    last = len(elems) - 1
    for idx, el in enumerate(elems):
        validate_ai(el)
        parts.append(el.ai)
        parts.append(el.data)
        if (not el.fixed_len) and idx != last:
            parts.append(FNC1)
    return "".join(parts)


def human_readable(elems: list[AIElement]) -> str:
    """Chuỗi human-readable GS1 dạng ``(AI)dữ_liệu`` theo đúng thứ tự (Req 3.10).

    Ví dụ: ``(01)08412345678905(17)261231(10)LOT42``.
    """
    return "".join(f"({el.ai}){el.data}" for el in elems)


def gtin_check_digit(body13: str) -> str:
    """Tính chữ số kiểm tra GTIN theo mod-10 chuẩn GS1 (Req 3.6).

    Đầu vào là 13 chữ số (phần thân GTIN-14). Trọng số 3 và 1 xen kẽ tính từ
    chữ số PHẢI NHẤT của phần thân (vị trí phải nhất nhận trọng số 3).
    Trả về một ký tự chữ số kiểm tra.
    """
    if not isinstance(body13, str) or len(body13) != 13 or not _DIGITS_RE.match(body13):
        raise GS1Error("Phần thân GTIN phải gồm đúng 13 chữ số", code="GS1_GTIN")
    total = 0
    # Duyệt từ phải sang trái: chữ số phải nhất nhận trọng số 3, rồi 1, 3, 1, ...
    for pos, ch in enumerate(reversed(body13)):
        weight = 3 if pos % 2 == 0 else 1
        total += int(ch) * weight
    return str((10 - (total % 10)) % 10)
