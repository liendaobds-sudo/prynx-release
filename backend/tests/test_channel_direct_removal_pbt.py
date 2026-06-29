"""Property test: chế độ xóa thẳng (Direct_Removal_Mode) của Channel_Remover.

Feature: channel-remover
"""
from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
)

# Tập đầy đủ bốn kênh process để sinh các tập con kênh-giữ.
_ALL_CHANNELS = list(PROCESS_CHANNELS)

# TAC_Limit đủ lớn để bước clamp TAC KHÔNG làm thay đổi giá trị: mỗi kênh ≤ 100
# nên tổng tối đa = 400; chọn 400 đảm bảo ΣTAC ≤ tac_limit luôn đúng → xét đúng
# hành vi xóa thẳng trước bước clamp TAC.
_NO_CLAMP_TAC_LIMIT = 400.0

# Sinh một thành phần kênh CMYK trên thang 0..100 (%).
_channel_value = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)


# Feature: channel-remover, Property 1: Direct removal zeroes removed channels and
# preserves kept channels
# For any màu CMYK gốc và for any tập Kept_Channel hợp lệ (1..3 phần tử), khi áp
# Direct_Removal_Mode, mỗi Removed_Channel của kết quả phải bằng 0 và mỗi
# Kept_Channel phải giữ nguyên giá trị gốc (xét trước bước clamp TAC).
# Validates: Requirements 2.1, 2.2
@settings(max_examples=200)
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
def test_direct_removal_zeroes_removed_preserves_kept(cmyk, kept):
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="direct",
        # tac_limit đủ lớn để clamp TAC không thay đổi giá trị (xét trước clamp).
        tac_limit=_NO_CLAMP_TAC_LIMIT,
    )
    mapper = ColorMapper(params)

    result, delta_e, is_out_of_gamut = mapper.map_color(cmyk)

    kept_indices = {
        PROCESS_CHANNELS.index(ch) for ch in PROCESS_CHANNELS if ch in kept
    }

    for idx in range(len(PROCESS_CHANNELS)):
        if idx in kept_indices:
            # Kept_Channel giữ nguyên giá trị gốc (Req 2.2).
            assert result[idx] == cmyk[idx]
        else:
            # Removed_Channel bằng 0 (Req 2.1).
            assert result[idx] == 0.0

    # Xóa thẳng không bù màu: không đo ΔE / không phân loại Out_Of_Gamut.
    assert delta_e == 0.0
    assert is_out_of_gamut is False
