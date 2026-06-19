"""Property-based tests cho lõi tính DPI hiệu dụng.

Feature: preflight-depth-upgrade
"""
import math

from hypothesis import given, settings, strategies as st

from app.core.preflight_rules.images import (
    MIN_PLACED_PT,
    compute_effective_dpi,
)

_pixels = st.integers(min_value=1, max_value=20000)
_placed = st.floats(min_value=MIN_PLACED_PT, max_value=5000.0,
                    allow_nan=False, allow_infinity=False)


# Feature: preflight-depth-upgrade, Property 1: Effective DPI đúng công thức và lấy min
@settings(max_examples=100)
@given(pixel_w=_pixels, pixel_h=_pixels, placed_w=_placed, placed_h=_placed)
def test_effective_dpi_formula_and_min(pixel_w, pixel_h, placed_w, placed_h):
    res = compute_effective_dpi(pixel_w, pixel_h, placed_w, placed_h)
    assert res is not None
    dpi_x, dpi_y, eff = res
    assert math.isclose(dpi_x, pixel_w / (placed_w / 72.0), rel_tol=1e-9)
    assert math.isclose(dpi_y, pixel_h / (placed_h / 72.0), rel_tol=1e-9)
    assert eff <= dpi_x + 1e-9
    assert eff <= dpi_y + 1e-9
    assert eff == min(dpi_x, dpi_y)


# Feature: preflight-depth-upgrade, Property 4: Placement suy biến bị bỏ qua (trả None)
@settings(max_examples=100)
@given(
    pixel_w=st.integers(min_value=-5, max_value=20000),
    pixel_h=st.integers(min_value=-5, max_value=20000),
    placed_w=st.floats(min_value=0.0, max_value=5000.0, allow_nan=False, allow_infinity=False),
    placed_h=st.floats(min_value=0.0, max_value=5000.0, allow_nan=False, allow_infinity=False),
)
def test_degenerate_placement_returns_none(pixel_w, pixel_h, placed_w, placed_h):
    res = compute_effective_dpi(pixel_w, pixel_h, placed_w, placed_h)
    degenerate = (
        pixel_w < 1 or pixel_h < 1
        or placed_w < MIN_PLACED_PT or placed_h < MIN_PLACED_PT
    )
    if degenerate:
        assert res is None
    else:
        assert res is not None
