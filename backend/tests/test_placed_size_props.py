"""Property-based tests cho tính kích thước đặt ảnh từ CTM.

Feature: preflight-depth-upgrade
"""
import math

from hypothesis import given, settings, strategies as st

from app.core.preflight_rules.images import _placed_size_from_matrix

_scale = st.floats(min_value=0.01, max_value=2000.0, allow_nan=False, allow_infinity=False)
_angle = st.floats(min_value=-math.pi, max_value=math.pi, allow_nan=False, allow_infinity=False)
_trans = st.floats(min_value=-5000.0, max_value=5000.0, allow_nan=False, allow_infinity=False)


# Feature: preflight-depth-upgrade, Property 2: Kích thước đặt bằng độ dài hai vector cạnh, bất biến theo xoay
@settings(max_examples=100)
@given(sx=_scale, sy=_scale, theta=_angle, e=_trans, f=_trans)
def test_placed_size_rotation_invariant(sx, sy, theta, e, f):
    # Ma trận = scale(sx,sy) rồi xoay theta: áp rotation lên các vector cạnh.
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    # cạnh ngang (sx,0) sau xoay; cạnh dọc (0,sy) sau xoay
    a = sx * cos_t
    b = sx * sin_t
    c = -sy * sin_t
    d = sy * cos_t
    w_pt, h_pt = _placed_size_from_matrix([a, b, c, d, e, f])
    # Độ dài vector cạnh bất biến theo xoay → bằng |sx|, |sy| (tịnh tiến e,f không ảnh hưởng)
    assert math.isclose(w_pt, sx, rel_tol=1e-6, abs_tol=1e-6)
    assert math.isclose(h_pt, sy, rel_tol=1e-6, abs_tol=1e-6)
