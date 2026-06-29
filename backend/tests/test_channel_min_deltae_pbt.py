"""Property test: tái tách màu chọn tổ hợp kênh-giữ có ΔE nhỏ nhất.

Feature: channel-remover
"""
import math
import os

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ReSeparationEngine,
)

# Bước lưới thô để LUT nhỏ, giữ test nhanh (kênh-giữ tối đa 3 → ≤ 6^3 = 216 điểm).
_GRID_STEP = 20.0

# Sai số float khi so sánh ΔE giữa argmin của engine và brute-force.
_EPS = 1e-9

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# Một thành phần kênh CMYK trên thang 0..100 (%).
_channel_value = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)


def _make_engine(kept):
    """Dựng ReSeparationEngine cho tập kênh-giữ; skip nếu thiếu ICC FOGRA39."""
    try:
        return ReSeparationEngine(kept_channels=tuple(kept), grid_step=_GRID_STEP)
    except FileNotFoundError as exc:
        pytest.skip(f"ICC FOGRA39 không khả dụng, bỏ qua property test: {exc}")


# Feature: channel-remover, Property 3: Re-separation chooses the minimum Delta_E
# kept-only combination
# For any màu CMYK gốc, ở Re_Separation_Mode kết quả phải là tổ hợp chỉ-dùng-
# Kept_Channel có Delta_E nhỏ nhất so với màu gốc trên lưới ứng viên: không tồn
# tại ứng viên kept-only nào khác có Delta_E nhỏ hơn kết quả.
# Validates: Requirements 3.1
@settings(max_examples=150, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    cmyk=st.tuples(
        _channel_value, _channel_value, _channel_value, _channel_value
    ),
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=1,
        max_size=3,
        unique=True,
    ),
)
def test_best_kept_only_is_global_minimum_delta_e(cmyk, kept):
    engine = _make_engine(kept)

    # Màu gốc → Lab mục tiêu (qua FOGRA39 thật).
    target_lab = engine.to_lab(cmyk)

    result_cmyk, delta_e_min = engine.best_kept_only(target_lab)

    # Brute-force quét toàn bộ LUT của engine để tìm ΔE nhỏ nhất.
    lut = engine._ensure_lut()
    brute_min = min(
        ReSeparationEngine.delta_e_cie76(target_lab, lab) for _, lab in lut
    )

    # delta_e_min trả về phải đúng bằng cực tiểu brute-force (trong sai số float).
    assert math.isclose(delta_e_min, brute_min, rel_tol=0.0, abs_tol=_EPS), (
        f"delta_e_min={delta_e_min} != brute_min={brute_min}"
    )

    # Không tồn tại ứng viên kept-only nào có ΔE nhỏ hơn kết quả.
    for _, lab in lut:
        assert ReSeparationEngine.delta_e_cie76(target_lab, lab) >= delta_e_min - _EPS

    # Kết quả chỉ dùng Kept_Channel: mọi Removed_Channel phải bằng 0 (Req 3.2).
    kept_indices = {
        PROCESS_CHANNELS.index(ch) for ch in PROCESS_CHANNELS if ch in kept
    }
    for idx in range(len(PROCESS_CHANNELS)):
        if idx not in kept_indices:
            assert result_cmyk[idx] == 0.0, (
                f"kênh bỏ index={idx} phải = 0, nhận {result_cmyk[idx]}"
            )
