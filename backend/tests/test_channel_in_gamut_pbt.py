"""Property test: màu trong gamut (kept-only) tái tạo trong ngưỡng ΔE.

Feature: channel-remover

Property 4 — In-gamut colors reproduce within threshold: một màu CMYK chỉ được
dựng từ các Kept_Channel (Removed_Channel = 0) và nằm ĐÚNG trên lưới LUT kênh-giữ
thì bản thân nó là một ứng viên kept-only của LUT. Do đó khi áp Re_Separation_Mode,
tổ hợp có ΔE nhỏ nhất chính là (hoặc trùng Lab với) màu gốc → ΔE ≈ 0 ≤
Gamut_Threshold, và màu KHÔNG bị phân loại Out_Of_Gamut.

ΔE được đo bằng littleCMS FOGRA39 thật (PIL.ImageCms) qua ReSeparationEngine.
"""
import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import (
    DEFAULT_GAMUT_THRESHOLD,
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ReSeparationEngine,
)

# Bước lưới thô để LUT nhỏ, giữ test nhanh (kênh-giữ tối đa 3 → ≤ 6^3 = 216 điểm).
_GRID_STEP = 20.0

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# Các mức phủ mực ĐÚNG trên lưới LUT (0, 20, 40, 60, 80, 100) để màu gốc trùng
# một điểm lưới kênh-giữ → best match có ΔE ≈ 0.
_GRID_VALUES = [round(i * _GRID_STEP, 6) for i in range(int(100.0 / _GRID_STEP) + 1)]

_grid_value = st.sampled_from(_GRID_VALUES)


def _make_engine(kept):
    """Dựng ReSeparationEngine cho tập kênh-giữ; skip nếu thiếu ICC FOGRA39."""
    try:
        return ReSeparationEngine(kept_channels=tuple(kept), grid_step=_GRID_STEP)
    except FileNotFoundError as exc:
        pytest.skip(f"ICC FOGRA39 không khả dụng, bỏ qua property test: {exc}")


def _kept_only_cmyk(kept, values):
    """Dựng tuple CMYK chỉ dùng Kept_Channel (Removed_Channel = 0), trên lưới."""
    channels = [0.0, 0.0, 0.0, 0.0]
    kept_indices = [PROCESS_CHANNELS.index(ch) for ch in kept]
    for idx, value in zip(kept_indices, values):
        channels[idx] = value
    return (channels[0], channels[1], channels[2], channels[3])


# Feature: channel-remover, Property 4: In-gamut colors reproduce within threshold
# For any màu CMYK chỉ dùng các Kept_Channel (do đó nằm trong gamut của tập
# kênh-giữ) dùng làm màu gốc, áp Re_Separation_Mode cho ra kết quả có Delta_E ≤
# Gamut_Threshold và KHÔNG bị phân loại Out_Of_Gamut.
# Validates: Requirements 3.3, 13.1
@settings(max_examples=150, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=1,
        max_size=3,
        unique=True,
    ),
    values=st.lists(_grid_value, min_size=3, max_size=3),
)
def test_in_gamut_color_reproduces_within_threshold(kept, values):
    engine = _make_engine(kept)

    # Màu gốc: chỉ dùng Kept_Channel, các mức nằm đúng trên lưới LUT kênh-giữ.
    cmyk = _kept_only_cmyk(kept, values[: len(kept)])

    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="reseparate",
        gamut_threshold=DEFAULT_GAMUT_THRESHOLD,
        grid_step=_GRID_STEP,
    )
    mapper = ColorMapper(params, engine)

    _result, delta_e, is_out_of_gamut = mapper.map_color(cmyk)

    # Màu trong gamut: ΔE ≤ Gamut_Threshold (Req 3.3) và KHÔNG out-of-gamut (Req 13.1).
    assert delta_e <= params.gamut_threshold, (
        f"ΔE={delta_e} vượt ngưỡng {params.gamut_threshold} cho màu kept-only "
        f"cmyk={cmyk}, kept={kept}"
    )
    assert is_out_of_gamut is False, (
        f"màu kept-only cmyk={cmyk} (kept={kept}) bị phân loại nhầm Out_Of_Gamut "
        f"với ΔE={delta_e}"
    )
