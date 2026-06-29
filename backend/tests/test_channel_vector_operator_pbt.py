"""Property test: biến đổi toán hạng màu CMYK của các Vector_Color_Operator.

Feature: channel-remover

Property 8 — Vector CMYK color operators are transformed.
ContentStreamTransformer.transform phải biến đổi đúng 4 toán hạng CMYK của các
toán tử ``k``/``K`` (DeviceCMYK) và ``scn``/``SCN`` đang ở color space
DeviceCMYK (hoặc ICCBased N=4) theo ``ColorMapper.map_color`` (quy đổi 0..1 ↔
0..100 ở biên), và thu thập một ColorHit cho mỗi toán tử như vậy.
"""
from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    PROCESS_CHANNELS,
    ChannelRemovalParams,
    ColorMapper,
    ContentStreamTransformer,
)

_ALL_CHANNELS = list(PROCESS_CHANNELS)

# TAC_Limit = 400 (tổng tối đa C+M+Y+K khi mỗi kênh ≤ 100) → bước clamp TAC
# KHÔNG bao giờ kích hoạt, giữ phép so sánh xác định cho chế độ direct.
_NO_CLAMP_TAC_LIMIT = 400.0

# Sai số khi so sánh toán hạng đã định dạng lại (rstrip 6 chữ số thập phân).
_EPS = 1e-6

# Một toán hạng màu PDF DeviceCMYK trên thang 0..1.
_operand = st.floats(
    min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False
)
_cmyk_operands = st.tuples(_operand, _operand, _operand, _operand)

# Bốn biến thể toán tử màu CMYK trong phạm vi Property 8.
_op_type = st.sampled_from(["k", "K", "scn", "SCN"])

# Một "lệnh" đặt màu: (loại toán tử, 4 toán hạng CMYK).
_instruction = st.tuples(_op_type, _cmyk_operands)

# Toán tử màu cần phân tích lại ở đầu ra.
_COLOR_OPS = ("k", "K", "scn", "SCN")


def _build_stream(instructions):
    """Dựng content stream tổng hợp; mỗi lệnh màu nằm trên một dòng riêng.

    - ``k``/``K``: ``c m y k k`` (DeviceCMYK trực tiếp).
    - ``scn``/``SCN``: đặt color space hiện hành bằng ``/DeviceCMYK cs`` (hoặc
      ``CS``) trước, rồi ``c m y k scn`` (hoặc ``SCN``).
    """
    lines: list[str] = []
    for op_type, cmyk in instructions:
        ops_str = " ".join(f"{v:.6f}" for v in cmyk)
        if op_type == "scn":
            lines.append("/DeviceCMYK cs")
            lines.append(f"{ops_str} scn")
        elif op_type == "SCN":
            lines.append("/DeviceCMYK CS")
            lines.append(f"{ops_str} SCN")
        else:  # k / K
            lines.append(f"{ops_str} {op_type}")
    return ("\n".join(lines) + "\n").encode("latin-1")


def _parse_color_operands(out: bytes):
    """Phân tích lại các dòng toán tử màu trong đầu ra → list[(op, [4 floats])]."""
    parsed: list[tuple[str, list[float]]] = []
    for line in out.decode("latin-1").splitlines():
        toks = line.split()
        if toks and toks[-1] in _COLOR_OPS:
            nums = [float(t) for t in toks[-5:-1]]
            parsed.append((toks[-1], nums))
    return parsed


# Feature: channel-remover, Property 8: Vector CMYK color operators are transformed
# For any content stream chứa toán tử k/K với 4 toán hạng, hoặc scn/SCN đang ở
# color space DeviceCMYK (hoặc ICCBased 4 kênh) với 4 toán hạng, các toán hạng
# CMYK đó sau biến đổi bằng đúng map_color(cmyk) theo mode đã chọn.
# Validates: Requirements 5.3, 5.4
@settings(max_examples=200, deadline=None)
@given(
    instructions=st.lists(_instruction, min_size=1, max_size=8),
    kept=st.lists(
        st.sampled_from(_ALL_CHANNELS),
        min_size=1,
        max_size=3,
        unique=True,
    ),
)
def test_vector_cmyk_operators_are_transformed(instructions, kept):
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="direct",  # chế độ direct cho phép so sánh xác định
        tac_limit=_NO_CLAMP_TAC_LIMIT,
    )
    mapper = ColorMapper(params)
    transformer = ContentStreamTransformer(mapper=mapper)

    data = _build_stream(instructions)
    out, hits = transformer.transform(data)

    # Mỗi toán tử CMYK (k/K/scn/SCN dưới DeviceCMYK) thu đúng một ColorHit.
    assert len(hits) == len(instructions)

    parsed = _parse_color_operands(out)
    assert len(parsed) == len(instructions)

    kept_indices = {PROCESS_CHANNELS.index(ch) for ch in kept}

    for (op_type, cmyk), (parsed_op, nums), hit in zip(instructions, parsed, hits):
        # Toán tử giữ nguyên loại (không bị scanner làm hỏng).
        assert parsed_op == op_type

        # Giá trị nguồn sau định dạng (giống token đọc lại bởi scanner).
        src_operands = tuple(float(f"{v:.6f}") for v in cmyk)
        # Quy 0..1 → 0..100 (%) như scanner làm ở biên (Req 5.3, 5.4).
        source_percent = tuple(v * 100.0 for v in src_operands)

        expected_result, _de, _oog = mapper.map_color(source_percent)

        for idx in range(4):
            # Toán hạng đầu ra phải bằng map_color(...)/100 (quy ngược về 0..1).
            assert abs(nums[idx] - expected_result[idx] / 100.0) <= _EPS, (
                f"op={op_type} idx={idx} got={nums[idx]} "
                f"expected={expected_result[idx] / 100.0}"
            )

            # Bất biến chế độ direct: kênh bỏ → 0, kênh giữ → bảo toàn.
            if idx in kept_indices:
                assert abs(nums[idx] - src_operands[idx]) <= _EPS
            else:
                assert abs(nums[idx]) <= _EPS

        # ColorHit phản ánh đúng phép biến đổi (thang 0..100).
        assert hit.result_cmyk == expected_result
        for idx in range(4):
            if idx not in kept_indices:
                assert hit.result_cmyk[idx] == 0.0
