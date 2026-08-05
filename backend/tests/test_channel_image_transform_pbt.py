"""Property test: ImageXObjectTransformer maps pixels and preserves structure.

Feature: channel-remover
"""
import zlib

import numpy as np
import pikepdf
from hypothesis import given, settings, strategies as st
from hypothesis.extra import numpy as hnp

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ImageXObjectTransformer,
)

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# TAC_Limit đủ lớn để bước clamp TAC KHÔNG đổi giá trị (tổng tối đa 400) → kết
# quả kiểm chứng pixel deterministic ở chế độ direct.
_NO_CLAMP_TAC_LIMIT = 400.0


@st.composite
def _cmyk_images(draw):
    """Sinh numpy (H, W, 4) uint8 ngẫu nhiên với H, W nhỏ (1..8) cho tốc độ."""
    height = draw(st.integers(min_value=1, max_value=8))
    width = draw(st.integers(min_value=1, max_value=8))
    arr = draw(
        hnp.arrays(
            dtype=np.uint8,
            shape=(height, width, 4),
            elements=st.integers(min_value=0, max_value=255),
        )
    )
    return arr


def _build_cmyk_image_xobject(pdf, arr):
    """Đóng gói numpy (H, W, 4) uint8 thành image XObject CMYK FlateDecode."""
    height, width, _ = arr.shape
    raw = np.ascontiguousarray(arr, dtype=np.uint8).tobytes()
    stream = pikepdf.Stream(pdf, zlib.compress(raw))
    stream.Subtype = pikepdf.Name("/Image")
    stream.Width = int(width)
    stream.Height = int(height)
    stream.ColorSpace = pikepdf.Name("/DeviceCMYK")
    stream.BitsPerComponent = 8
    stream.Filter = pikepdf.Name("/FlateDecode")
    return stream


# Feature: channel-remover, Property 9: Image XObject transform maps pixels and
# preserves structure
# For any CMYK_Image_XObject dùng FlateDecode với DeviceCMYK 4 kênh, mỗi pixel
# kết quả bằng map_color của pixel gốc, và ảnh kết quả giữ nguyên Width, Height,
# số kênh (4) và bộ lọc FlateDecode. Dùng direct mode để kiểm chứng deterministic:
# Removed_Channel → 0, Kept_Channel giữ nguyên.
# Validates: Requirements 6.1, 6.2
# PERF (audit 2026-08-05 §RC3.QA): lần gọi pikepdf đầu tiên có thể nạp DLL
# hàng trăm ms; deadline thời gian không phải bất biến của phép biến đổi pixel.
@settings(max_examples=150, deadline=None)
@given(
    arr=_cmyk_images(),
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=1,
        max_size=3,
        unique=True,
    ),
)
def test_image_transform_maps_pixels_and_preserves_structure(arr, kept):
    height, width, _ = arr.shape

    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="direct",
        tac_limit=_NO_CLAMP_TAC_LIMIT,
    )
    mapper = ColorMapper(params)
    transformer = ImageXObjectTransformer(mapper)

    pdf = pikepdf.new()
    xobj = _build_cmyk_image_xobject(pdf, arr)

    hit = transformer.transform("/Im0", xobj)

    # Ảnh CMYK FlateDecode hợp lệ phải được xử lý (không bỏ qua).
    assert hit is not None
    assert hit.pixels == width * height

    # --- Bảo toàn cấu trúc (Req 6.2) ---
    assert int(xobj.get("/Width")) == width
    assert int(xobj.get("/Height")) == height
    assert int(xobj.get("/BitsPerComponent")) == 8
    assert str(xobj.get("/Filter")) == "/FlateDecode"

    decoded = bytes(xobj.read_bytes())
    # Số byte = W * H * 4 (4 kênh giữ nguyên).
    assert len(decoded) == width * height * 4

    out_arr = np.frombuffer(decoded, dtype=np.uint8).reshape((height, width, 4))
    assert out_arr.shape == (height, width, 4)

    # --- Pixel được map đúng theo ColorMapper (direct mode) ---
    kept_indices = {
        PROCESS_CHANNELS.index(ch) for ch in PROCESS_CHANNELS if ch in kept
    }
    for idx in range(4):
        if idx in kept_indices:
            # Kept_Channel: round-trip uint8 → 0..100 → uint8 giữ nguyên giá trị.
            assert np.array_equal(out_arr[:, :, idx], arr[:, :, idx])
        else:
            # Removed_Channel bị zero hoá.
            assert np.all(out_arr[:, :, idx] == 0)
