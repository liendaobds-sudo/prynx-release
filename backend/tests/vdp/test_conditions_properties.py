"""Property tests cho Condition_Engine (VDP_Engine của PrynX).

Feature: vdp-upgrade

Mỗi property test gắn comment tham chiếu và chạy >= 100 ví dụ.
"""
from __future__ import annotations

from hypothesis import given, settings, strategies as st

from app.workers.vdp_conditions import (
    FieldCondition,
    Rule,
    _cell_for,
    apply_rules,
    compare,
    is_visible,
)


# Tên cột dùng cho rule/record — giữ ASCII đơn giản để sinh record khớp được.
_columns = st.sampled_from(["A", "B", "C", "Status", "Loai"])

# Giá trị ô / value: gồm chuỗi rỗng, khoảng trắng, và chuỗi thường (kể cả tiếng Việt).
_values = st.one_of(
    st.just(""),
    st.just("   "),
    st.text(alphabet="abcXYZ Đỏ ", min_size=0, max_size=6),
)

_operators = st.sampled_from(["eq", "ne", "contains", "empty", "not_empty"])


@st.composite
def _rule(draw) -> Rule:
    return Rule(
        column=draw(_columns),
        operator=draw(_operators),
        value=draw(_values),
        result=draw(st.text(min_size=0, max_size=8)),
    )


@st.composite
def _row(draw) -> dict:
    cols = ["A", "B", "C", "Status", "Loai"]
    return {c: draw(_values) for c in cols}


# Cần ép buộc nội tại của compare để xác định "rule khớp" độc lập với apply_rules,
# nhằm khẳng định first-match thực sự đúng.
def _matches(rule: Rule, row: dict) -> bool:
    from app.workers.vdp_conditions import compare, _cell_for

    return compare(_cell_for(rule.column, row), rule.operator, rule.value)


# Feature: vdp-upgrade, Property 11: Bảng rule áp dụng theo first-match
@settings(max_examples=100)
@given(rules=st.lists(_rule(), min_size=0, max_size=8), row=_row())
def test_apply_rules_first_match(rules, row):
    result = apply_rules(rules, row)

    # Xác định rule khớp đầu tiên độc lập với apply_rules.
    first_match = next((r for r in rules if _matches(r, row)), None)

    if first_match is None:
        # Không rule nào khớp ⇒ phải trả None (kể cả khi rules rỗng).
        assert result is None
    else:
        # Phải trả result của rule khớp ĐẦU TIÊN; rule khớp sau bị bỏ qua.
        assert result == first_match.result


# ---------------------------------------------------------------------------
# Property 9 — Điều kiện ẩn/hiện đúng ngữ nghĩa (Task 4.2)
# ---------------------------------------------------------------------------

_actions = st.sampled_from(["show_if", "hide_if"])


@st.composite
def _condition(draw) -> FieldCondition:
    return FieldCondition(
        column=draw(_columns),
        operator=draw(_operators),
        value=draw(_values),
        action=draw(_actions),
    )


def _cond_matches(cond: FieldCondition, row: dict) -> bool:
    """Đánh giá độc lập một điều kiện qua compare để tái dựng kỳ vọng."""
    return compare(_cell_for(cond.column, row), cond.operator, cond.value)


def _expected_visible(conds, row: dict) -> bool:
    """Tái dựng kỳ vọng ẩn/hiện độc lập với is_visible.

    - hide_if thoả ⇒ ẩn (False).
    - show_if KHÔNG thoả ⇒ ẩn (False).
    - Không điều kiện (None/[]) ⇒ hiện (True).
    """
    if not conds:
        return True
    for cond in conds:
        matched = _cond_matches(cond, row)
        if cond.action == "hide_if":
            if matched:
                return False
        else:  # show_if
            if not matched:
                return False
    return True


# Feature: vdp-upgrade, Property 9: Điều kiện ẩn/hiện đúng ngữ nghĩa
@settings(max_examples=100)
@given(
    conds=st.one_of(
        st.none(),
        st.lists(_condition(), min_size=0, max_size=6),
    ),
    row=_row(),
)
def test_is_visible_semantics(conds, row):
    result = is_visible(conds, row)

    # Tái dựng kỳ vọng độc lập bằng compare trên từng điều kiện.
    expected = _expected_visible(conds, row)
    assert result == expected

    # Bất biến rõ ràng: không có điều kiện ⇒ luôn hiện.
    if not conds:
        assert result is True


# ---------------------------------------------------------------------------
# Property 12 — Ngữ nghĩa toán tử so sánh (Task 4.4)
# ---------------------------------------------------------------------------

# Giá trị có chủ đích bao gồm tiếng Việt, khoảng trắng hai đầu, hoa/thường lẫn lộn.
_compare_values = st.one_of(
    st.just(""),
    st.just("   "),
    st.just("  Đỏ  "),
    st.just("đỏ"),
    st.just("ĐỎ"),
    st.just("Xanh Lá"),
    st.just(" abc "),
    st.just("ABC"),
    st.text(alphabet="abcXYZ Đỏđỏ \t", min_size=0, max_size=8),
)


def _ref_compare(cell, operator: str, value) -> bool:
    """Ngữ nghĩa tham chiếu độc lập với compare.

    Chuẩn hoá = ép chuỗi, strip hai đầu, casefold.
    """
    def norm(x) -> str:
        return "" if x is None else str(x).strip().casefold()

    nc = norm(cell)
    if operator == "empty":
        return nc == ""
    if operator == "not_empty":
        return nc != ""
    nv = norm(value)
    if operator == "eq":
        return nc == nv
    if operator == "ne":
        return nc != nv
    if operator == "contains":
        return nv in nc
    raise AssertionError(f"toán tử ngoài phạm vi: {operator!r}")


# Feature: vdp-upgrade, Property 12: Ngữ nghĩa toán tử so sánh
@settings(max_examples=100)
@given(
    cell=_compare_values,
    value=_compare_values,
    operator=_operators,
)
def test_compare_operator_semantics(cell, value, operator):
    result = compare(cell, operator, value)
    expected = _ref_compare(cell, operator, value)
    assert result == expected

    # Bất biến: empty là phủ định của not_empty trên cùng giá trị ô.
    if operator == "empty":
        assert result == (not compare(cell, "not_empty", value))


# ---------------------------------------------------------------------------
# Bổ sung task 4.6 / 4.7 / 4.8 — token nội tuyến {Cot?A:B}, escape, back-compat
# ---------------------------------------------------------------------------

from app.workers.vdp_conditions import (  # noqa: E402
    ConditionError,
    resolve_field_content,
    resolve_inline,
)
from app.workers.vdp_engine import _substitute  # noqa: E402


def _cell_str(row: dict, col: str) -> str:
    """Lấy giá trị ô dạng chuỗi như resolve_inline xét (None ⇒ '')."""
    v = row.get(col)
    return "" if v is None else str(v)


# ---------------------------------------------------------------------------
# Property 10 — Token {Cot?A:B} chọn nhánh literal, không đệ quy (Task 4.6)
# ---------------------------------------------------------------------------

# Nhánh literal: cố tình gồm '{' và '?' (token-giả) nhưng KHÔNG có ':' '}' '\\'
# chưa-thoát để không tạo ranh giới/đệ quy — đúng ràng buộc Property 10.
_branch_plain = st.text(alphabet="abcXY {?Đỏ", min_size=0, max_size=10)


# Feature: vdp-upgrade, Property 10: Token {Cot?A:B} chọn nhánh literal, không đệ quy
@settings(max_examples=100)
@given(col=_columns, branch_a=_branch_plain, branch_b=_branch_plain, row=_row())
def test_resolve_inline_literal_branch(col, branch_a, branch_b, row):
    token = "{" + col + "?" + branch_a + ":" + branch_b + "}"
    result = resolve_inline(token, row)

    # Chọn nhánh: A khi giá trị cột sau strip khác rỗng, ngược lại B.
    cell = _cell_str(row, col)
    expected = branch_a if cell.strip() != "" else branch_b

    # Nhánh được chèn LITERAL: kết quả bằng đúng nhánh đã chọn (không substitution,
    # không phân giải đệ quy token-giả '{...?' lồng bên trong nhánh).
    assert result == expected


# ---------------------------------------------------------------------------
# Property 13 — Escape trong nhánh token điều kiện (Task 4.7)
# ---------------------------------------------------------------------------

# Văn bản nhánh ở dạng ĐÃ GIẢI MÃ, cố ý gồm ':' '}' '\\' (và '{' '?') để round-trip.
_decoded_text = st.text(alphabet="abc:}\\{?XY Đỏ", min_size=0, max_size=12)


def _encode_branch(s: str) -> str:
    """Mã hoá nhánh: '\\'→'\\\\', ':'→'\\:', '}'→'\\}' (đảo của bước giải mã)."""
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("}", "\\}")


# Feature: vdp-upgrade, Property 13: Escape trong nhánh token điều kiện
@settings(max_examples=100)
@given(col=_columns, dec_a=_decoded_text, dec_b=_decoded_text, row=_row())
def test_resolve_inline_escapes(col, dec_a, dec_b, row):
    token = "{" + col + "?" + _encode_branch(dec_a) + ":" + _encode_branch(dec_b) + "}"
    result = resolve_inline(token, row)

    # Escape '\\:' '\\}' '\\\\' giải mã thành ':' '}' '\\' và KHÔNG kết thúc nhánh:
    # round-trip phải phục hồi đúng văn bản nhánh đã chọn.
    cell = _cell_str(row, col)
    expected = dec_a if cell.strip() != "" else dec_b
    assert result == expected


# ---------------------------------------------------------------------------
# Property 14 — Tương thích ngược với cơ chế thay placeholder cũ (Task 4.8)
# ---------------------------------------------------------------------------

_legacy_cols = ["A", "B", "C"]
# Đoạn văn thuần KHÔNG chứa '{' '}' '?' ':' '\\' để không vô tình tạo token mới.
_plain_seg = st.text(alphabet="abc XYĐỏ123", min_size=0, max_size=6)


@st.composite
def _legacy_content(draw) -> str:
    """Nội dung chỉ gồm văn bản thuần và placeholder cũ {Col} (không {Col?A:B})."""
    n = draw(st.integers(min_value=0, max_value=6))
    parts: list[str] = []
    for _ in range(n):
        if draw(st.booleans()):
            parts.append(draw(_plain_seg))
        else:
            parts.append("{" + draw(st.sampled_from(_legacy_cols)) + "}")
    return "".join(parts)


@st.composite
def _legacy_row(draw) -> dict:
    return {c: draw(_values) for c in _legacy_cols}


# Feature: vdp-upgrade, Property 14: Tương thích ngược với cơ chế thay placeholder cũ
@settings(max_examples=100)
@given(content=_legacy_content(), row=_legacy_row())
def test_legacy_placeholder_backcompat(content, row):
    # Field không có điều kiện/rule và chỉ dùng placeholder cũ trong textContent.
    field = {"textContent": content, "name": "fld"}
    resolved = resolve_field_content(field, row)

    # Kết quả pipeline mới phải bằng đúng cơ chế cũ _substitute (Req 2.8, 7.3).
    expected = _substitute(content, dict(row))
    assert resolved.visible is True
    assert resolved.content == expected
