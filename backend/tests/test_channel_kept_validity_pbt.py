"""Property test: tính hợp lệ của tập kênh giữ (Kept_Channel).

Feature: channel-remover
"""
from hypothesis import given, settings, strategies as st

import pytest

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    validate_params,
)

# Tập đầy đủ bốn kênh process để sinh các tập con.
_ALL_CHANNELS = list(PROCESS_CHANNELS)


# Feature: channel-remover, Property 14: Kept-channel set validity
# For any tập con của {C, M, Y, K}: nếu kích thước thuộc [1, 3] thì validate_params
# chấp nhận; nếu kích thước bằng 0 (bỏ cả 4) hoặc bằng 4 (giữ cả 4) thì bị từ chối.
# Validates: Requirements 1.2, 1.3, 1.4
@settings(max_examples=200)
@given(
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=0,
        max_size=4,
        unique=True,
    )
)
def test_kept_channel_set_validity(kept):
    params = {"kept_channels": list(kept), "mode": "direct"}
    size = len(kept)

    if 1 <= size <= 3:
        # Tập kích thước 1..3 phải được chấp nhận (Req 1.2).
        result = validate_params(params)
        assert set(result.kept_channels) == set(kept)
        assert 1 <= len(result.kept_channels) <= 3
    else:
        # size == 0 (bỏ cả 4, Req 1.4) hoặc size == 4 (giữ cả 4, Req 1.3) → từ chối.
        with pytest.raises(ValueError):
            validate_params(params)
