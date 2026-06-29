"""Property test: parity giữa preview (base_image) và output transform.

Feature: channel-remover

Property 13 — Preview/output parity within threshold: với một trang/raster kết
quả, ΔE giữa raster preview và raster output cho cùng một vùng phải ≤
Gamut_Threshold.

Cốt lõi của parity (Req 10.2): preview và output ĐỀU đi qua cùng một
``ColorMapper.map_color``. ``compute_oog_preview`` áp ``map_color`` cho mọi
pixel CMYK rồi chuyển kết quả sang RGB qua ``_cmyk100_to_rgb_array`` để dựng lớp
``base_image`` (lớp parity, KHÔNG tô đỏ). Do đó, với cùng một mảng CMYK đầu vào,
màu ``base_image`` của preview phải khớp với màu output được map độc lập bằng
chính ``map_color`` — sai khác chỉ ở mức round-trip raster (nằm sâu dưới
Gamut_Threshold).

Test này dựng mảng CMYK ngẫu nhiên (H, W, 4) thang 0..100, map độc lập từng màu
duy nhất bằng ``mapper.map_color`` → RGB, rồi so với ``preview.base_image``. Cả
hai chế độ "direct" và "reseparate" đều được kiểm (reseparate dùng grid_step thô
để giữ test nhanh và để LUT/argmin thực sự được luyện).
"""
import math

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import (
    DEFAULT_GAMUT_THRESHOLD,
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ReSeparationEngine,
    _cmyk100_to_rgb_array,
    compute_oog_preview,
)

# Bước lưới thô để LUT nhỏ, giữ test nhanh (kênh-giữ tối đa 3 → ≤ 5^3 = 125 điểm).
_GRID_STEP = 25.0

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# Ngưỡng parity: ΔE (khoảng cách Euclid trong RGB) giữa preview và output cho
# cùng một vùng phải ≤ Gamut_Threshold (Req 10.2 / Property 13). Preview và
# output dùng chung map_color nên thực tế ΔE ≈ 0; ta vẫn so với ngưỡng chuẩn.
_PARITY_THRESHOLD = DEFAULT_GAMUT_THRESHOLD

# Một thành phần kênh CMYK trên thang 0..100 (%).
_channel_value = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)
_color = st.tuples(
    _channel_value, _channel_value, _channel_value, _channel_value
)


def _build_mapper(kept, mode):
    """Dựng ColorMapper (+ engine cho reseparate); skip nếu thiếu ICC FOGRA39."""
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode=mode,
        gamut_threshold=DEFAULT_GAMUT_THRESHOLD,
        grid_step=_GRID_STEP,
    )
    engine = None
    if mode == "reseparate":
        try:
            engine = ReSeparationEngine(
                kept_channels=tuple(kept), grid_step=_GRID_STEP
            )
        except FileNotFoundError as exc:
            pytest.skip(f"ICC FOGRA39 không khả dụng, bỏ qua property test: {exc}")
    return ColorMapper(params, engine)


def _independent_output_rgb(cmyk100, mapper):
    """Map độc lập từng màu duy nhất bằng ``map_color`` → RGB (phía 'output').

    Mô phỏng đúng phép biến đổi mà ``remove_channels`` áp lên màu: với mỗi màu
    CMYK duy nhất (đã lượng tử hoá 2 chữ số như pipeline preview để so apples-to-
    apples), gọi ``mapper.map_color`` rồi chuyển sang RGB qua chính
    ``_cmyk100_to_rgb_array``. Đây là tham chiếu ĐỘC LẬP với ``compute_oog_preview``.
    """
    h, w, _ = cmyk100.shape
    flat = cmyk100.reshape(-1, 4)
    quant = np.round(flat, 2)
    uniq, inverse = np.unique(quant, axis=0, return_inverse=True)

    out_uniq = np.empty_like(uniq, dtype=np.float32)
    for i in range(len(uniq)):
        cmyk = (
            float(uniq[i, 0]), float(uniq[i, 1]),
            float(uniq[i, 2]), float(uniq[i, 3]),
        )
        result, _delta_e, _is_oog = mapper.map_color(cmyk)
        out_uniq[i] = result

    result_cmyk = out_uniq[inverse].reshape(h, w, 4)
    return _cmyk100_to_rgb_array(result_cmyk)


# Feature: channel-remover, Property 13: Preview/output parity within threshold
# For any trang kết quả, Delta_E giữa raster preview và raster output cho cùng
# một vùng phải ≤ Gamut_Threshold. Preview (base_image) và output đều áp cùng
# ColorMapper.map_color nên màu khớp nhau trong ngưỡng.
# Validates: Requirements 10.2
@settings(max_examples=120, deadline=None,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=1,
        max_size=3,
        unique=True,
    ),
    mode=st.sampled_from(["direct", "reseparate"]),
    colors=st.lists(_color, min_size=1, max_size=6),
)
def test_preview_base_matches_output_within_threshold(kept, mode, colors):
    mapper = _build_mapper(kept, mode)

    # Dựng mảng CMYK (1, N, 4) từ các màu sinh ngẫu nhiên (mỗi màu một "vùng").
    cmyk100 = np.array(colors, dtype=np.float32).reshape(1, len(colors), 4)

    # Lớp parity của preview: base_image (đã gỡ kênh, CHƯA tô đỏ).
    preview = compute_oog_preview(cmyk100, mapper)
    base_rgb = np.asarray(preview.base_image, dtype=np.int32)

    # Phía output: map độc lập cùng map_color rồi chuyển RGB.
    output_rgb = _independent_output_rgb(cmyk100, mapper).astype(np.int32)

    assert base_rgb.shape == output_rgb.shape, (
        f"kích thước preview {base_rgb.shape} != output {output_rgb.shape}"
    )

    # ΔE per-region: khoảng cách Euclid trong RGB cho từng pixel/vùng.
    diff = base_rgb - output_rgb
    per_pixel_delta_e = np.sqrt((diff.astype(np.float64) ** 2).sum(axis=-1))
    max_delta_e = float(per_pixel_delta_e.max())

    assert max_delta_e <= _PARITY_THRESHOLD, (
        f"parity vi phạm: ΔE_max={max_delta_e:.3f} > ngưỡng {_PARITY_THRESHOLD} "
        f"(mode={mode}, kept={kept})"
    )
    assert not math.isnan(max_delta_e)
