"""Property test: phân loại Out_Of_Gamut ở mức màu (ColorMapper reseparate).

Feature: channel-remover

Phần màu-level của Property 5: với mỗi màu CMYK gốc ở Re_Separation_Mode, cờ
``is_out_of_gamut`` phải bằng đúng ``(delta_e > gamut_threshold)`` và ``delta_e``
trả về phải nhất quán với cực tiểu ΔE (argmin) mà engine tìm được trên LUT
kênh-giữ cho Lab mục tiêu của màu gốc.
"""
import math

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ReSeparationEngine,
)

# Bước lưới thô để LUT nhỏ, giữ test nhanh (kênh-giữ tối đa 3 → ≤ 6^3 = 216 điểm).
_GRID_STEP = 20.0

# Sai số float khi so sánh ΔE.
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


# Feature: channel-remover, Property 5: Out-of-gamut classification, warning, and
# honesty (phần phân loại + argmin ở mức màu)
# For any màu CMYK gốc, cờ out_of_gamut của kết quả bằng đúng
# (Delta_E_min > Gamut_Threshold) và Delta_E_min là cực tiểu engine tìm được.
# Validates: Requirements 3.4, 4.2, 4.4
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
    gamut_threshold=st.floats(
        min_value=0.0, max_value=120.0,
        allow_nan=False, allow_infinity=False,
    ),
)
def test_oog_flag_matches_threshold_and_argmin(cmyk, kept, gamut_threshold):
    engine = _make_engine(kept)

    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="reseparate",
        gamut_threshold=gamut_threshold,
        grid_step=_GRID_STEP,
    )
    mapper = ColorMapper(params, engine)

    result_cmyk, delta_e, is_out_of_gamut = mapper.map_color(cmyk)

    # delta_e trả về phải khớp với cực tiểu argmin của engine cho Lab mục tiêu.
    target_lab = engine.to_lab(cmyk)
    _, expected_delta_e = engine.best_kept_only(target_lab)
    assert math.isclose(delta_e, expected_delta_e, rel_tol=0.0, abs_tol=_EPS), (
        f"delta_e={delta_e} != argmin engine={expected_delta_e}"
    )

    # Cờ OOG phải bằng đúng (delta_e > gamut_threshold) (Req 3.4, 4.2, 4.4).
    assert is_out_of_gamut == (delta_e > gamut_threshold), (
        f"is_out_of_gamut={is_out_of_gamut} không khớp với "
        f"(delta_e={delta_e} > threshold={gamut_threshold})"
    )

    # Kết quả chỉ dùng Kept_Channel: mọi Removed_Channel phải bằng 0.
    kept_indices = {
        PROCESS_CHANNELS.index(ch) for ch in PROCESS_CHANNELS if ch in kept
    }
    for idx in range(len(PROCESS_CHANNELS)):
        if idx not in kept_indices:
            assert result_cmyk[idx] == 0.0, (
                f"kênh bỏ index={idx} phải = 0, nhận {result_cmyk[idx]}"
            )
