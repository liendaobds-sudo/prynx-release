"""Property tests cho lõi GS1 thuần (PrynX VDP_Engine).

Feature: vdp-upgrade

Phủ các correctness property 15, 16, 17, 19 của design (vdp-upgrade) cho module
`app.workers.vdp_gs1`. Mỗi property test gắn comment tham chiếu và chạy 100 ví dụ.
"""
from __future__ import annotations

import string

import pytest
from hypothesis import given, settings, strategies as st

from app.workers.vdp_gs1 import (
    AIElement,
    GS1Error,
    build_gs1_payload,
    gtin_check_digit,
    human_readable,
    parse_gs1,
    validate_ai,
)


# --------------------------------------------------------------------------- #
# Hypothesis strategies cho AIElement hợp lệ                                    #
# --------------------------------------------------------------------------- #

_ALNUM = string.ascii_letters + string.digits


def _mod10_check_digit(body13: str) -> str:
    """Tính chữ số kiểm tra GTIN độc lập (tham chiếu) để dựng GTIN-14 hợp lệ."""
    total = 0
    for pos, ch in enumerate(reversed(body13)):
        weight = 3 if pos % 2 == 0 else 1
        total += int(ch) * weight
    return str((10 - (total % 10)) % 10)


@st.composite
def _gtin14(draw) -> str:
    """GTIN-14: 13 chữ số thân + 1 chữ số kiểm tra mod-10 hợp lệ."""
    body = draw(st.text(alphabet=string.digits, min_size=13, max_size=13))
    return body + _mod10_check_digit(body)


@st.composite
def _yymmdd(draw) -> str:
    """Ngày YYMMDD hợp lệ: MM trong 01..12, DD trong 00..31."""
    yy = draw(st.integers(min_value=0, max_value=99))
    mm = draw(st.integers(min_value=1, max_value=12))
    dd = draw(st.integers(min_value=0, max_value=31))
    return f"{yy:02d}{mm:02d}{dd:02d}"


_lot_serial = st.text(alphabet=_ALNUM, min_size=1, max_size=20)


@st.composite
def _ai_element(draw) -> AIElement:
    """Một AIElement hợp lệ thuộc tập AI hỗ trợ (01/17/10/21)."""
    ai = draw(st.sampled_from(["01", "17", "10", "21"]))
    if ai == "01":
        data = draw(_gtin14())
    elif ai == "17":
        data = draw(_yymmdd())
    else:  # 10, 21
        data = draw(_lot_serial)
    return AIElement(ai=ai, data=data)


_ai_elements = st.lists(_ai_element(), min_size=1, max_size=6)


# --------------------------------------------------------------------------- #
# Task 6.2 — Property 15                                                         #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 15: GS1 payload chèn FNC1 đúng vị trí và parse lại được
@settings(max_examples=100)
@given(_ai_elements)
def test_property_15_gs1_payload_fnc1_roundtrip(elems):
    """build_gs1_payload bắt đầu bằng FNC1 và parse_gs1 round-trip đúng dãy AI.

    **Validates: Requirements 3.2, 3.3**
    """
    payload = build_gs1_payload(elems)

    # FNC1 đặt ở vị trí khởi đầu.
    assert payload.startswith("\x1d")

    # Parse lại phục hồi đúng dãy (ai, data) ban đầu.
    parsed = parse_gs1(payload)
    assert [(e.ai, e.data) for e in parsed] == [(e.ai, e.data) for e in elems]


# --------------------------------------------------------------------------- #
# Task 6.3 — Property 16                                                         #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 16: Kiểm tra định dạng/độ dài AI
@settings(max_examples=100)
@given(_ai_element())
def test_property_16_validate_ai_accepts_valid_rejects_invalid(el):
    """validate_ai chấp nhận dữ liệu hợp lệ, báo GS1Error với vi phạm.

    **Validates: Requirements 3.4**
    """
    # Dữ liệu hợp lệ được chấp nhận (không raise).
    validate_ai(el)

    # Vi phạm độ dài: AI cố định -> thêm 1 ký tự; AI biến độ dài -> vượt 20.
    if el.ai in ("01", "17"):
        bad_len = AIElement(ai=el.ai, data=el.data + "0")
    else:
        bad_len = AIElement(ai=el.ai, data="A" * 21)
    with pytest.raises(GS1Error):
        validate_ai(bad_len)

    # Vi phạm tập ký tự: chèn ký tự không hợp lệ giữ nguyên độ dài hợp lệ.
    if el.ai == "01":
        # GTIN chỉ chữ số -> thay 1 ký tự bằng chữ cái.
        bad_charset = AIElement(ai="01", data="A" + el.data[1:])
        with pytest.raises(GS1Error):
            validate_ai(bad_charset)
    elif el.ai in ("10", "21"):
        # alnum -> chèn ký tự không phải chữ-số.
        bad_charset = AIElement(ai=el.ai, data=el.data[:-1] + "-")
        with pytest.raises(GS1Error):
            validate_ai(bad_charset)

    # Vi phạm định dạng ngày: MM = 13 không hợp lệ.
    if el.ai == "17":
        bad_date = AIElement(ai="17", data=el.data[:2] + "13" + el.data[4:])
        with pytest.raises(GS1Error):
            validate_ai(bad_date)

    # AI không được hỗ trợ -> báo lỗi.
    with pytest.raises(GS1Error):
        validate_ai(AIElement(ai="99", data=el.data))


# --------------------------------------------------------------------------- #
# Task 6.4 — Property 17                                                         #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 17: Tính chữ số kiểm tra GTIN
@settings(max_examples=100)
@given(st.text(alphabet=string.digits, min_size=13, max_size=13))
def test_property_17_gtin_check_digit_mod10(body13):
    """gtin_check_digit trả 1 chữ số sao cho GTIN-14 đầy đủ qua được mod-10.

    **Validates: Requirements 3.6**
    """
    cd = gtin_check_digit(body13)

    # Là một chữ số đơn.
    assert len(cd) == 1 and cd.isdigit()

    # GTIN-14 đầy đủ: kiểm tra mod-10 chuẩn GS1. Tính từ chữ số PHẢI NHẤT
    # (chính là chữ số kiểm tra) với trọng số 1, rồi xen kẽ 3/1 sang trái —
    # tương đương: chữ số thân phải nhất nhận trọng số 3. Tổng là bội của 10.
    gtin14 = body13 + cd
    total = 0
    for pos, ch in enumerate(reversed(gtin14)):
        weight = 1 if pos % 2 == 0 else 3
        total += int(ch) * weight
    assert total % 10 == 0


# --------------------------------------------------------------------------- #
# Task 6.5 — Property 19                                                         #
# --------------------------------------------------------------------------- #

# Feature: vdp-upgrade, Property 19: Chuỗi human-readable GS1
@settings(max_examples=100)
@given(_ai_elements)
def test_property_19_human_readable_format(elems):
    """human_readable nối '(ai)data' theo thứ tự và chứa từng ai/data.

    **Validates: Requirements 3.10**
    """
    hr = human_readable(elems)

    # Bằng đúng chuỗi nối '(ai)data' theo thứ tự.
    expected = "".join(f"({e.ai}){e.data}" for e in elems)
    assert hr == expected

    # Chứa ai và data của mỗi phần tử.
    for e in elems:
        assert f"({e.ai})" in hr
        assert e.data in hr
