"""Property test: tái tách (Re_Separation_Mode) là idempotent trên màu kết quả.

Feature: channel-remover

Phần idempotence của Property 11: với mỗi màu CMYK gốc, áp ``map_color`` ở
Re_Separation_Mode tạo ra một màu chỉ-dùng-Kept_Channel ``r1`` (một điểm lưới
trong LUT kênh-giữ). Áp ``map_color`` lần thứ hai lên chính ``r1`` phải tái tạo
đúng ``r1`` (trong sai số float): ``map(map(x)) == map(x)``.

Bất biến này phản ánh Req 13.3: với màu đã chỉ-dùng-Kept_Channel (trong gamut
của Kept_Channel), tái tách hai lần liên tiếp cho cùng một kết quả.
"""
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

# Sai số float khi so sánh hai màu CMYK kết quả theo từng kênh.
_EPS = 1e-6

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


# Feature: channel-remover, Property 11: Re-separation is idempotent on kept-only
# colors
# For any màu CMYK gốc, ở Re_Separation_Mode: map(map(x)) == map(x) (trong sai số
# float). Áp tái tách lần hai lên màu đã chỉ-dùng-Kept_Channel phải cho cùng kết
# quả.
# Validates: Requirements 13.3
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
def test_reseparation_is_idempotent(cmyk, kept):
    engine = _make_engine(kept)

    # tac_limit cao đủ để không kích hoạt clamp TAC trên màu kết quả: kênh-giữ
    # tối đa 3 kênh × 100% = 300 ≤ 360 (mặc định), nên kết quả vẫn đúng là một
    # điểm lưới trong LUT — điều kiện cần cho tính idempotent thuần.
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="reseparate",
        grid_step=_GRID_STEP,
    )
    mapper = ColorMapper(params, engine)

    # Lần áp đầu tiên: r1 = map(x).
    r1, _, _ = mapper.map_color(cmyk)

    # Lần áp thứ hai: r2 = map(r1).
    r2, _, _ = mapper.map_color(r1)

    # Idempotent: map(map(x)) == map(x) theo từng kênh (trong sai số float).
    for idx in range(len(PROCESS_CHANNELS)):
        assert abs(r2[idx] - r1[idx]) <= _EPS, (
            f"không idempotent ở kênh index={idx}: r1={r1[idx]} vs r2={r2[idx]} "
            f"(cmyk gốc={cmyk}, kept={kept})"
        )
