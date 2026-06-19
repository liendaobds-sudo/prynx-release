"""Property test: chuẩn hoá ngưỡng TAC.

Feature: preflight-depth-upgrade
"""
from hypothesis import given, settings, strategies as st

from app.core.preflight_rules.ink import (
    _normalize_tac_threshold,
    TAC_DEFAULT_THRESHOLD,
    TAC_THRESHOLD_MIN,
    TAC_THRESHOLD_MAX,
)


# Feature: preflight-depth-upgrade, Property 9: Chuẩn hoá ngưỡng TAC
@settings(max_examples=100)
@given(st.one_of(
    st.integers(min_value=-1000, max_value=2000),
    st.floats(allow_nan=True, allow_infinity=True),
    st.text(max_size=8),
    st.none(),
))
def test_normalize_tac_threshold(value):
    result = _normalize_tac_threshold(value)
    assert isinstance(result, int)
    is_number = isinstance(value, (int, float)) and not isinstance(value, bool)
    in_range = (
        is_number
        and value == value  # not NaN
        and value not in (float("inf"), float("-inf"))
        and TAC_THRESHOLD_MIN <= value <= TAC_THRESHOLD_MAX
    )
    if in_range:
        assert result == int(value)
    else:
        assert result == TAC_DEFAULT_THRESHOLD
