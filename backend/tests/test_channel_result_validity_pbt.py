"""Property test: bất biến hợp lệ của màu kết quả (result color validity).

Feature: channel-remover
"""
import math

import pytest
from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ReSeparationEngine,
)

# Epsilon nhỏ cho so sánh số thực (sai số tích lũy của phép scale TAC).
_EPS = 1e-4

# Bốn kênh process để sinh tập con kênh-giữ.
_ALL_CHANNELS = list(PROCESS_CHANNELS)

# Bước lưới thô để giữ thời gian build LUT hợp lý cho chế độ reseparate
# (bất biến hợp lệ đúng với mọi grid_step).
_GRID_STEP = 20.0

# Thử dựng một ReSeparationEngine để biết ICC FOGRA39 có sẵn không. Nếu thiếu
# profile, chế độ reseparate sẽ được bỏ qua với lý do rõ ràng (ưu tiên chạy được).
try:
    ReSeparationEngine(kept_channels=("K",), grid_step=_GRID_STEP)
    _ENGINE_AVAILABLE = True
    _ENGINE_SKIP_REASON = ""
except Exception as exc:  # pragma: no cover - chỉ chạy khi thiếu profile
    _ENGINE_AVAILABLE = False
    _ENGINE_SKIP_REASON = f"ReSeparationEngine không khả dụng: {exc!r}"

# Cache engine theo tập kênh-giữ để tái dùng LUT giữa các ví dụ Hypothesis.
_ENGINE_CACHE: dict[tuple, ReSeparationEngine] = {}


def _get_engine(kept: tuple[str, ...]) -> ReSeparationEngine:
    key = tuple(kept)
    engine = _ENGINE_CACHE.get(key)
    if engine is None:
        engine = ReSeparationEngine(kept_channels=key, grid_step=_GRID_STEP)
        _ENGINE_CACHE[key] = engine
    return engine


_cmyk = st.tuples(
    st.floats(min_value=0.0, max_value=100.0),
    st.floats(min_value=0.0, max_value=100.0),
    st.floats(min_value=0.0, max_value=100.0),
    st.floats(min_value=0.0, max_value=100.0),
)
_kept = st.lists(st.sampled_from(_ALL_CHANNELS), min_size=1, max_size=3, unique=True)
_tac_limit = st.floats(min_value=50.0, max_value=400.0)
_mode = st.sampled_from(["direct", "reseparate"])


# Feature: channel-remover, Property 2: Result color validity invariant
# For any màu CMYK gốc, for any mode (direct AND reseparate) và for any tac_limit
# hợp lệ, màu kết quả của ColorMapper.map_color luôn thoả: mọi kênh ∈ [0, 100] VÀ
# tổng TAC ≤ tac_limit (trong sai số float nhỏ).
# Validates: Requirements 3.2, 8.2, 8.3
@settings(max_examples=120, deadline=None)
@given(cmyk=_cmyk, kept=_kept, tac_limit=_tac_limit, mode=_mode)
def test_result_color_validity_invariant(cmyk, kept, tac_limit, mode):
    if mode == "reseparate" and not _ENGINE_AVAILABLE:
        pytest.skip(_ENGINE_SKIP_REASON)

    kept_tuple = tuple(ch for ch in PROCESS_CHANNELS if ch in set(kept))
    params = ChannelRemovalParams(
        kept_channels=kept_tuple,
        mode=mode,
        tac_limit=tac_limit,
        grid_step=_GRID_STEP,
    )
    engine = _get_engine(kept_tuple) if mode == "reseparate" else None
    mapper = ColorMapper(params, engine=engine)

    result, _delta_e, _oog = mapper.map_color(cmyk)

    # Mọi kênh phải nằm trong [0, 100] (Req 8.3).
    for value in result:
        assert -_EPS <= value <= 100.0 + _EPS, (
            f"Kênh ngoài [0,100]: {value} (mode={mode}, kept={kept_tuple})"
        )

    # Tổng phủ mực (TAC) phải ≤ tac_limit (Req 8.2).
    total = sum(result)
    assert total <= tac_limit + _EPS, (
        f"TAC {total} vượt tac_limit {tac_limit} (mode={mode}, kept={kept_tuple})"
    )

    # Removed_Channel phải bằng 0 (Req 3.2 cho reseparate; Direct cũng đặt 0).
    kept_indices = {PROCESS_CHANNELS.index(ch) for ch in kept_tuple}
    for idx, value in enumerate(result):
        if idx not in kept_indices:
            assert abs(value) <= _EPS, (
                f"Removed_Channel {PROCESS_CHANNELS[idx]} != 0: {value}"
            )
