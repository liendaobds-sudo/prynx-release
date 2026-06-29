"""Property test: tùy chọn "skip" giữ nguyên màu spot (Separation/DeviceN).

Feature: channel-remover

Property 10 — Skip option preserves spot colors:
  For any content stream chứa toán tử/color space Separation hoặc DeviceN, khi
  spot_handling = "skip", mọi byte của các toán tử và color space đó giữ nguyên
  bytewise.

Validates: Requirements 7.2
"""
from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ContentStreamTransformer,
)

_ALL_CHANNELS = list(PROCESS_CHANNELS)


def _fmt(v: float) -> str:
    """Định dạng một tint spot thành chuỗi cố định, không bị scanner đụng tới."""
    return f"{v:.4f}"


# --- Strategies -------------------------------------------------------------

# Tint spot trên thang 0..1 (toán hạng scn/SCN), format cố định 4 chữ số thập phân.
_tint = st.floats(min_value=0.0, max_value=1.0, allow_nan=False,
                  allow_infinity=False).map(_fmt)

# Tên color space spot tham chiếu trong /Resources/ColorSpace.
_cs_name = st.sampled_from(["/Sep1", "/Sep2", "/SpotCS", "/PantoneCS", "/DN1"])

# Tên mực spot (Separation colorant name / DeviceN names).
_colorant = st.sampled_from(
    ["/PANTONE_185_C", "/Spot1", "/Varnish", "/White", "/Gold", "/All"]
)


@st.composite
def _spot_segment(draw):
    """Sinh một đoạn content stream khai báo + dùng màu spot (Separation/DeviceN).

    Trả ``(segment_bytes, cs_resources_entry)`` trong đó ``cs_resources_entry`` là
    cặp ``(cs_name, cs_value)`` để gộp vào /Resources/ColorSpace; ``segment_bytes``
    là đoạn ``/Name cs|CS <tints> scn|SCN`` cần được giữ nguyên bytewise khi skip.
    """
    cs_name = draw(_cs_name)
    is_stroke = draw(st.booleans())
    family = draw(st.sampled_from(["Separation", "DeviceN"]))

    if family == "Separation":
        colorant = draw(_colorant)
        # [/Separation /Colorant /DeviceCMYK <tintfn>] — scanner chỉ cần items[0].
        cs_value = ["/Separation", colorant, "/DeviceCMYK"]
        tints = [draw(_tint)]
    else:
        names = draw(st.lists(_colorant, min_size=2, max_size=4, unique=True))
        cs_value = ["/DeviceN", list(names), "/DeviceCMYK"]
        tints = [draw(_tint) for _ in names]

    cs_op = "CS" if is_stroke else "cs"
    scn_op = "SCN" if is_stroke else "scn"
    segment = f"/{cs_name.lstrip('/')} {cs_op}\n{' '.join(tints)} {scn_op}\n"
    return segment.encode("latin-1"), (cs_name, cs_value)


@st.composite
def _stream(draw):
    """Sinh content stream: nhiều đoạn spot, tùy chọn xen kẽ toán tử CMYK ``k``.

    Trả ``(data, cs_resources, spot_segments, has_cmyk)``.
    """
    n_spots = draw(st.integers(min_value=1, max_value=4))
    segments = [draw(_spot_segment()) for _ in range(n_spots)]

    spot_bytes = [seg for seg, _entry in segments]
    cs_resources = {name: value for _seg, (name, value) in segments}

    # Tùy chọn xen kẽ một toán tử CMYK device-color thật để xác nhận CMYK VẪN bị
    # biến đổi trong khi màu spot được giữ nguyên.
    has_cmyk = draw(st.booleans())

    parts = [b"q\n"]
    for seg in spot_bytes:
        parts.append(seg)
    if has_cmyk:
        # k với K>0; ở chế độ direct (kept = C,M,Y) kênh K sẽ bị gỡ → byte đổi.
        parts.append(b"0.2000 0.4000 0.6000 0.8000 k\n")
    parts.append(b"Q\n")

    return b"".join(parts), cs_resources, spot_bytes, has_cmyk


# Feature: channel-remover, Property 10: Skip option preserves spot colors
# For any content stream chứa toán tử/color space Separation hoặc DeviceN, khi
# spot_handling = "skip", mọi byte của các toán tử và color space đó giữ nguyên
# bytewise.
# Validates: Requirements 7.2
@settings(max_examples=200)
@given(
    bundle=_stream(),
    # Tập kênh-giữ hợp lệ (1..3 phần tử) — spot phải được giữ nguyên với MỌI tập.
    kept=st.lists(st.sampled_from(_ALL_CHANNELS), min_size=1, max_size=3,
                  unique=True),
)
def test_skip_preserves_spot_colors(bundle, kept):
    data, cs_resources, spot_segments, has_cmyk = bundle

    # Chế độ direct để không phụ thuộc ICC; spot được xử lý giống nhau ở mọi mode.
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="direct",
        spot_handling="skip",
    )
    mapper = ColorMapper(params)
    transformer = ContentStreamTransformer(
        mapper=mapper, cs_resources=cs_resources, spot_handling="skip"
    )

    out, hits = transformer.transform(data)

    # 1) Mỗi đoạn màu spot (color space + toán hạng + scn/SCN) giữ nguyên bytewise:
    #    số lần xuất hiện trong output bằng đúng trong input (luôn ≥ 1).
    for seg in spot_segments:
        assert out.count(seg) == data.count(seg), (
            f"Đoạn spot bị thay đổi/biến mất: {seg!r}"
        )

    # 2) Không có ColorHit nào từ màu spot: skip nghĩa là không map màu spot.
    #    Nếu không có toán tử CMYK xen kẽ thì không có hit nào và output == input.
    if not has_cmyk:
        assert hits == []
        assert out == data, "Stream chỉ chứa spot phải giữ nguyên bytewise khi skip"
    else:
        # 3) CMYK VẪN bị biến đổi: kênh K (bị gỡ vì kept ⊆ {C,M,Y}) → 0, nên đoạn
        #    toán hạng CMYK gốc không còn nguyên vẹn (xác nhận skip chỉ chừa spot).
        assert b"0.2000 0.4000 0.6000 0.8000 k" not in out
        assert len(hits) == 1
