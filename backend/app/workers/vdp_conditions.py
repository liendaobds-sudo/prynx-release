"""Condition_Engine cho VDP_Engine của PrynX.

Module thuần (không import ReportLab/PDF) hiện thực logic điều kiện đơn giản:
- ``compare``      : so sánh giá trị ô với toán tử hỗ trợ.
- ``is_visible``   : đánh giá điều kiện ẩn/hiện một field cho một record.
- ``apply_rules``  : áp bảng rule theo first-match để xác định nội dung/ảnh nguồn.

Các hàm được gọi từ cả ``process_chunk`` (sinh lô) và ``Preview_Service`` để
bảo đảm parity preview ↔ output.

Tham chiếu: design.md mục "Condition_Engine"; Requirements 2.1, 2.2, 2.5, 2.6, 2.9.

``resolve_inline`` (token nội tuyến ``{Cot?A:B}`` có escape) và
``resolve_field_content`` (điều phối theo thứ tự cố định Req 2.11) được bổ sung
tại task 4.5 — xem cuối file. Cả hai không import ReportLab/PDF; ``_substitute``
của ``vdp_engine`` được nạp trễ (lazy import) bên trong ``resolve_field_content``
để tránh phụ thuộc vòng và giữ module thuần khi chỉ dùng phần điều kiện.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, Union

# Tập toán tử so sánh hỗ trợ (Req 2.9)
Operator = str  # Literal['eq', 'ne', 'contains', 'empty', 'not_empty']

SUPPORTED_OPERATORS: frozenset[str] = frozenset(
    {"eq", "ne", "contains", "empty", "not_empty"}
)

# Toán tử chỉ xét trạng thái rỗng/khác-rỗng của ô (bỏ qua ``value``)
_UNARY_OPERATORS: frozenset[str] = frozenset({"empty", "not_empty"})


@dataclass
class FieldCondition:
    """Điều kiện ẩn/hiện một field dựa trên giá trị một cột (Req 2.1, 2.2)."""

    column: str
    operator: Operator
    value: str = ""
    action: str = "show_if"  # 'show_if' | 'hide_if'


@dataclass
class Rule:
    """Một rule trong bảng rule: nếu cột thoả toán tử với value thì đặt result (Req 2.5)."""

    column: str
    operator: Operator
    value: str = ""
    result: str = ""


def _normalize(text: object) -> str:
    """Chuẩn hoá giá trị để so sánh: ép chuỗi, cắt khoảng trắng hai đầu, casefold.

    ``casefold`` xử lý không phân biệt hoa/thường ổn định hơn ``lower`` với Unicode.
    """
    if text is None:
        return ""
    return str(text).strip().casefold()


def compare(cell: object, operator: Operator, value: object = "") -> bool:
    """So sánh giá trị ``cell`` với ``value`` theo ``operator`` (Req 2.9).

    Quy tắc: so sánh dưới dạng chuỗi sau khi cắt khoảng trắng hai đầu, không
    phân biệt chữ hoa/thường. ``empty`` đúng khi và chỉ khi chuỗi rỗng sau strip.

    Toán tử không nằm trong tập hỗ trợ sẽ ném ``ValueError``.
    """
    if operator not in SUPPORTED_OPERATORS:
        raise ValueError(f"Toán tử so sánh không hỗ trợ: {operator!r}")

    norm_cell = _normalize(cell)

    if operator == "empty":
        return norm_cell == ""
    if operator == "not_empty":
        return norm_cell != ""

    norm_value = _normalize(value)
    if operator == "eq":
        return norm_cell == norm_value
    if operator == "ne":
        return norm_cell != norm_value
    if operator == "contains":
        return norm_value in norm_cell

    # Không thể tới đây vì đã kiểm tra SUPPORTED_OPERATORS ở trên.
    raise ValueError(f"Toán tử so sánh không hỗ trợ: {operator!r}")


def _cell_for(column: str, row: Mapping[str, object]) -> str:
    """Lấy giá trị cột từ record dưới dạng chuỗi.

    Cột không tồn tại được coi là chuỗi rỗng ở mức hàm thuần này; việc gắn lỗi
    cho cột không tồn tại (Req 2.7) do ``resolve_field_content`` (task 4.5) đảm nhiệm.
    """
    return "" if column not in row else ("" if row[column] is None else str(row[column]))


def is_visible(conds: Optional[Sequence[FieldCondition]], row: Mapping[str, object]) -> bool:
    """Đánh giá điều kiện ẩn/hiện một field cho một record (Req 2.1, 2.2).

    Ngữ nghĩa kết hợp:
    - ``hide_if``: nếu điều kiện thoả ⇒ field bị ẩn (không vẽ).
    - ``show_if``: nếu điều kiện KHÔNG thoả ⇒ field bị ẩn; phải thoả mới được vẽ.
    - Không có điều kiện nào ⇒ field hiện như bình thường.

    Trả về True nếu field nên được vẽ, False nếu nên bỏ qua.
    """
    if not conds:
        return True

    for cond in conds:
        cell = _cell_for(cond.column, row)
        matched = compare(cell, cond.operator, cond.value)
        if cond.action == "hide_if":
            if matched:
                return False
        else:  # 'show_if' (mặc định)
            if not matched:
                return False
    return True


def apply_rules(rules: Optional[Sequence[Rule]], row: Mapping[str, object]) -> Optional[str]:
    """Áp bảng rule theo first-match (Req 2.5, 2.6).

    Trả về ``result`` của rule KHỚP ĐẦU TIÊN theo thứ tự khai báo; bỏ qua các
    rule khớp còn lại. Trả về ``None`` khi không rule nào khớp.
    """
    if not rules:
        return None

    for rule in rules:
        cell = _cell_for(rule.column, row)
        if compare(cell, rule.operator, rule.value):
            return rule.result
    return None


# ─── Task 4.5: token nội tuyến {Cot?A:B} + điều phối field theo thứ tự cố định ──


class ConditionError(Exception):
    """Lỗi điều kiện: tham chiếu cột không tồn tại trong nguồn dữ liệu (Req 2.7).

    Engine bắt ngoại lệ này để gắn nhãn lỗi cho record và ghi lý do vào báo cáo
    lỗi, thay vì làm hỏng việc render các field/record khác.
    """

    def __init__(self, column: str, reason: str = "") -> None:
        self.column = column
        self.reason = reason or f"Cột {column!r} không tồn tại trong nguồn dữ liệu"
        super().__init__(self.reason)


@dataclass
class ResolvedField:
    """Kết quả phân giải nội dung một field cho một record (Req 2.11).

    - ``visible=False``: field bị ẩn theo điều kiện ⇒ engine bỏ qua việc vẽ.
    - ``visible=True``: ``content`` là chuỗi đã qua rule → token nội tuyến →
      placeholder cũ, sẵn sàng để engine render theo type (text/image/...).
    """

    visible: bool
    content: str = ""


# Ký tự thoát hợp lệ trong nhánh token điều kiện (Req 2.10).
_ESCAPABLE: frozenset[str] = frozenset({"\\", ":", "}"})


def _scan_branch(text: str, start: int, terminators: frozenset[str]):
    """Quét một nhánh token, giải mã escape ``\\:`` ``\\}`` ``\\\\`` (Req 2.10).

    Trả về ``(decoded, pos, terminator)`` trong đó ``pos`` là chỉ số của ký tự
    kết thúc (hoặc ``len(text)`` nếu chạm hết chuỗi) và ``terminator`` là ký tự
    kết thúc chưa-thoát gặp được (hoặc ``None`` nếu chạm hết chuỗi).

    Ký tự ``\\`` đứng trước một ký tự thoát hợp lệ được thay bằng chính ký tự đó
    và KHÔNG được coi là ranh giới; ``\\`` đứng trước ký tự khác giữ nguyên.
    """
    out: list[str] = []
    i = start
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n and text[i + 1] in _ESCAPABLE:
            out.append(text[i + 1])
            i += 2
            continue
        if ch in terminators:
            return "".join(out), i, ch
        out.append(ch)
        i += 1
    return "".join(out), n, None


def _parse_conditional(text: str, start: int):
    """Thử phân tích token điều kiện ``{Cot?A:B}`` bắt đầu tại ``text[start] == '{'``.

    Trả về ``(column, branch_a, branch_b, end)`` nếu là token điều kiện hợp lệ
    (``end`` là chỉ số ngay sau ``}`` đóng), hoặc ``None`` nếu KHÔNG phải token
    điều kiện hợp lệ (token dị dạng/placeholder thường được giữ nguyên — Req 2.8,
    và phần Error Handling của design).
    """
    n = len(text)
    i = start + 1  # bỏ qua '{'

    # Đọc tên cột tới dấu '?'. Gặp '{', '}' hoặc ':' trước '?' ⇒ không phải token.
    col_chars: list[str] = []
    while i < n:
        c = text[i]
        if c == "?":
            break
        if c in ("{", "}", ":"):
            return None
        col_chars.append(c)
        i += 1
    else:
        return None  # không tìm thấy '?'

    column = "".join(col_chars)
    if column == "":
        return None  # '{?...}' không coi là token điều kiện

    i += 1  # bỏ qua '?'

    # Nhánh A kết thúc tại ':' chưa-thoát. Nếu gặp '}' trước ':' ⇒ dị dạng.
    branch_a, j, term_a = _scan_branch(text, i, frozenset({":", "}"}))
    if term_a != ":":
        return None

    # Nhánh B kết thúc tại '}' chưa-thoát. Chạm hết chuỗi ⇒ dị dạng.
    branch_b, k, term_b = _scan_branch(text, j + 1, frozenset({"}"}))
    if term_b != "}":
        return None

    return column, branch_a, branch_b, k + 1


def resolve_inline(text: str, row: Mapping[str, object]) -> str:
    """Phân giải token nội tuyến ``{Cot?A:B}`` thành nhánh literal (Req 2.3, 2.4, 2.10).

    Với mỗi token điều kiện hợp lệ: nếu giá trị cột ``Cot`` sau khi cắt khoảng
    trắng hai đầu KHÁC rỗng ⇒ chọn nhánh ``A``; ngược lại ⇒ nhánh ``B``. Nhánh
    được chèn vào như VĂN BẢN LITERAL (đã giải mã escape ``\\:`` ``\\}`` ``\\\\``)
    và KHÔNG phân giải đệ quy token điều kiện lồng bên trong (Req 2.3, 2.4).

    Cột không tồn tại trong record ⇒ ném ``ConditionError`` (Req 2.7).

    Placeholder thường (``{Cot}``, ``{Cot[2|-]}``, ``{Cot|func:arg}``) và token
    dị dạng được giữ nguyên ở đây, dành cho ``_substitute`` xử lý sau (Req 2.8).
    """
    if not text:
        return text

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "{":
            parsed = _parse_conditional(text, i)
            if parsed is not None:
                column, branch_a, branch_b, end = parsed
                if column not in row:
                    raise ConditionError(column)
                chosen = branch_a if compare(row[column], "not_empty", "") else branch_b
                out.append(chosen)
                i = end
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _field_get(field: Union[Mapping[str, Any], object], key: str, default: Any = None) -> Any:
    """Lấy thuộc tính từ field dạng dict hoặc object (VdpField pydantic)."""
    if isinstance(field, Mapping):
        return field.get(key, default)
    return getattr(field, key, default)


def _to_condition(obj: Any) -> FieldCondition:
    """Chuẩn hoá một điều kiện (dict/object) về ``FieldCondition``."""
    if isinstance(obj, FieldCondition):
        return obj
    return FieldCondition(
        column=_field_get(obj, "column", ""),
        operator=_field_get(obj, "operator", "eq"),
        value=_field_get(obj, "value", "") or "",
        action=_field_get(obj, "action", "show_if") or "show_if",
    )


def _to_rule(obj: Any) -> Rule:
    """Chuẩn hoá một rule (dict/object) về ``Rule``."""
    if isinstance(obj, Rule):
        return obj
    return Rule(
        column=_field_get(obj, "column", ""),
        operator=_field_get(obj, "operator", "eq"),
        value=_field_get(obj, "value", "") or "",
        result=_field_get(obj, "result", "") or "",
    )


def resolve_field_content(
    field: Union[Mapping[str, Any], object], row: Mapping[str, object]
) -> ResolvedField:
    """Điều phối phân giải nội dung một field theo THỨ TỰ CỐ ĐỊNH (Req 2.11).

    Thứ tự: (1) điều kiện ẩn/hiện → (2) bảng rule first-match xác định nội dung/
    ảnh nguồn → (3) token nội tuyến ``{Cot?A:B}`` → (4) placeholder cũ
    (``_substitute``).

    - Field bị ẩn ⇒ trả ``ResolvedField(visible=False)`` (bỏ qua bước 2–4).
    - Điều kiện/rule/token tham chiếu cột không tồn tại ⇒ ném ``ConditionError``
      (Req 2.7) để engine gắn nhãn lỗi record.
    - Field không dùng tính năng mới ⇒ bước 1–3 là no-op và bước 4 chính là
      ``_substitute`` hiện có, giữ nguyên kết quả cũ (Req 2.8, 7.3).
    """
    conditions = _field_get(field, "conditions", None)
    rules = _field_get(field, "rules", None)

    # (1) Điều kiện ẩn/hiện — kiểm cột tồn tại trước (Req 2.7), rồi đánh giá.
    norm_conds: Optional[list[FieldCondition]] = None
    if conditions:
        norm_conds = [_to_condition(c) for c in conditions]
        for cond in norm_conds:
            if cond.column not in row:
                raise ConditionError(cond.column)
    if not is_visible(norm_conds, row):
        return ResolvedField(visible=False, content="")

    field_name = _field_get(field, "name", "")
    # Nội dung gốc của field: textContent, mặc định {name} như engine hiện tại.
    base_content = _field_get(field, "textContent", None)
    if base_content is None:
        base_content = f"{{{field_name}}}"
    elif field_name in row and "{" not in str(base_content):
        # Nếu field_name có trong row nhưng textContent không chứa bất kỳ placeholder '{' nào
        # (ví dụ: field tạo từ Pick text hoặc text tĩnh), ta coi đây là biến lấy từ row[field_name].
        base_content = f"{{{field_name}}}"

    # (2) Bảng rule first-match — kiểm cột tồn tại trước (Req 2.7), rồi áp dụng.
    content = base_content
    if rules:
        norm_rules = [_to_rule(r) for r in rules]
        for rule in norm_rules:
            if rule.column not in row:
                raise ConditionError(rule.column)
        rule_result = apply_rules(norm_rules, row)
        if rule_result is not None:
            content = rule_result

    # (3) Token nội tuyến {Cot?A:B} (không đệ quy, có escape).
    content = resolve_inline(content, row)

    # (4) Placeholder cũ — nạp trễ để tránh phụ thuộc vòng với vdp_engine.
    from app.workers.vdp_engine import _substitute

    content = _substitute(content, dict(row))

    return ResolvedField(visible=True, content=content)
