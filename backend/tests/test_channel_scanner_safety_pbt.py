"""Property test: scanner content stream CHỈ biến đổi toán hạng màu CMYK.

Feature: channel-remover

Property 7 — Scanner only modifies CMYK color operands: sau khi
``ContentStreamTransformer.transform`` chạy, mọi byte KHÔNG thuộc khoảng 4 toán
hạng số của một toán tử màu CMYK *thật* (``k``/``K`` hoặc ``scn``/``SCN`` dưới
DeviceCMYK, NẰM NGOÀI vùng được bảo vệ) đều giữ nguyên bytewise. Cụ thể, mọi
chuỗi *giống* toán tử màu nằm trong:

  - string literal ``( … )``
  - hex string ``< … >``
  - comment ``% … \\n``
  - inline image ``BI … ID … EI``

đều KHÔNG bị thay đổi.

Cách kiểm chứng: dựng ngẫu nhiên một content stream gồm các "item" tự chứa:
token màu GIẢ chèn bên trong các vùng được bảo vệ + các toán tử CMYK THẬT bên
ngoài. Ta tự dựng ``expected`` output bằng cách CHỈ thay khoảng byte toán hạng của
các toán tử thật (dùng đúng ColorMapper + _format_pdf_number của module) và GIỮ
NGUYÊN mọi byte còn lại. Khẳng định ``transform(stream) == expected`` chứng minh
đồng thời: (1) byte trong vùng được bảo vệ không đổi, và (2) chỉ toán hạng CMYK
thật bị biến đổi đúng chỗ.

Validates: Requirements 5.2, 5.5
"""
from hypothesis import HealthCheck, given, settings, strategies as st

from app.core.channel_remover import (
    ChannelRemovalParams,
    ColorMapper,
    ContentStreamTransformer,
    _format_pdf_number,
)

_ALL_CHANNELS = ["C", "M", "Y", "K"]

# Toán hạng số 0..1 ở dạng chuỗi cố định, parse được thành float và KHÔNG chứa
# delimiter PDF. Tránh giá trị làm tổng > tac_limit (giữ ≤ 3 kênh nên an toàn).
_operand_str = st.sampled_from(
    ["0", "0.1", "0.25", "0.4", "0.5", "0.6", "0.75", "0.9", "1"]
)

# Token màu GIẢ để nhét vào vùng được bảo vệ — trông y như toán tử màu thật.
_FAKE_COLOR_TOKENS = [
    "0.5 0.5 0.5 0.5 k",
    "1 0 0 1 K",
    "0.2 0.3 0.4 0.5 scn",
    "0.9 0.8 0.7 0.6 SCN",
    "0 0 0 1 k 1 1 1 1 K",
]
_fake_token = st.sampled_from(_FAKE_COLOR_TOKENS)


def _make_real_op(values, op):
    """Dựng một item toán tử CMYK THẬT '<v0> <v1> <v2> <v3> <op>'.

    Trả (input_bytes, marker) với marker = ('real', values, op) để dựng expected.
    """
    body = " ".join(values) + " " + op
    return body, ("real", tuple(values), op)


def _make_real_scn(values):
    """Item scn DeviceCMYK: '/DeviceCMYK cs <4 toán hạng> scn'."""
    body = "/DeviceCMYK cs " + " ".join(values) + " scn"
    return body, ("real_scn", tuple(values), "scn")


def _make_protected_string(fake):
    body = "(" + fake + ")"
    return body, ("protected", body)


def _make_protected_hex(fake):
    # Hex string: '<' không theo sau bởi '<'; nội dung được scanner bỏ qua tới '>'.
    body = "<" + fake.replace(">", " ") + ">"
    return body, ("protected", body)


def _make_protected_comment(fake):
    # Comment tới hết dòng; kết thúc bằng newline để token sau không dính dòng.
    body = "%" + fake + "\n"
    return body, ("protected", body)


def _make_protected_inline_image(fake):
    # BI là token đầu → scanner nhảy thẳng tới ' EI '. Không chứa 'EI' giữa chừng.
    body = "BI /W 2 /H 2 /CS /G /BPC 8 ID " + fake + " EI"
    return body, ("protected", body)


def _build_expected(items, mapper):
    """Dựng (input_bytes, expected_bytes) từ danh sách item đã sinh."""
    in_parts = []
    exp_parts = []
    for body, marker in items:
        in_parts.append(body)
        kind = marker[0]
        if kind in ("real", "real_scn"):
            values = marker[1]
            op = marker[2]
            source_cmyk = tuple(float(v) * 100.0 for v in values)
            result_cmyk, _de, _oog = mapper.map_color(source_cmyk)
            reps = [
                _format_pdf_number(result_cmyk[idx] / 100.0).decode("ascii")
                for idx in range(4)
            ]
            if kind == "real_scn":
                exp_parts.append("/DeviceCMYK cs " + " ".join(reps) + " scn")
            else:
                exp_parts.append(" ".join(reps) + " " + op)
        else:  # protected → giữ nguyên bytewise
            exp_parts.append(body)

    sep = "\n"
    in_bytes = sep.join(in_parts).encode("latin-1")
    exp_bytes = sep.join(exp_parts).encode("latin-1")
    return in_bytes, exp_bytes


@st.composite
def _content_stream_items(draw):
    """Sinh danh sách item: trộn vùng được bảo vệ + toán tử CMYK thật."""
    n = draw(st.integers(min_value=1, max_value=8))
    items = []
    real_count = 0
    for _ in range(n):
        choice = draw(st.integers(min_value=0, max_value=5))
        if choice == 0:
            items.append(_make_real_op(draw(st.lists(_operand_str, min_size=4, max_size=4)), "k"))
            real_count += 1
        elif choice == 1:
            items.append(_make_real_op(draw(st.lists(_operand_str, min_size=4, max_size=4)), "K"))
            real_count += 1
        elif choice == 2:
            items.append(_make_real_scn(draw(st.lists(_operand_str, min_size=4, max_size=4))))
            real_count += 1
        elif choice == 3:
            items.append(_make_protected_string(draw(_fake_token)))
        elif choice == 4:
            items.append(_make_protected_hex(draw(_fake_token)))
        else:
            # Xen kẽ comment và inline image.
            if draw(st.booleans()):
                items.append(_make_protected_comment(draw(_fake_token)))
            else:
                items.append(_make_protected_inline_image(draw(_fake_token)))

    # Đảm bảo luôn có ít nhất một toán tử CMYK thật để test không "rỗng".
    if real_count == 0:
        items.append(_make_real_op(["0.5", "0.5", "0.5", "0.5"], "k"))
    return items


# Feature: channel-remover, Property 7: Scanner only modifies CMYK color operands
# For any content stream, sau khi biến đổi, mọi byte KHÔNG thuộc khoảng 4 toán
# hạng số của một toán tử màu CMYK được biến đổi đều giữ nguyên bytewise; mọi
# chuỗi giống toán tử màu nằm trong string literal ( ), inline image (BI…EI), hex
# string < >, hoặc comment % đều không bị thay đổi.
# Validates: Requirements 5.2, 5.5
@settings(max_examples=200, deadline=None,
          suppress_health_check=[HealthCheck.too_slow])
@given(
    items=_content_stream_items(),
    kept=st.lists(st.sampled_from(_ALL_CHANNELS), min_size=1, max_size=3, unique=True),
)
def test_scanner_only_modifies_cmyk_operands(items, kept):
    params = ChannelRemovalParams(kept_channels=tuple(kept), mode="direct")
    mapper = ColorMapper(params, engine=None)

    in_bytes, expected = _build_expected(items, mapper)

    transformer = ContentStreamTransformer(mapper=mapper, spot_handling="skip")
    out_bytes, hits = transformer.transform(in_bytes)

    # (1) + (2): toàn bộ output khớp expected → vùng được bảo vệ giữ nguyên
    # bytewise và CHỈ toán hạng CMYK thật bị biến đổi đúng chỗ.
    assert out_bytes == expected, (
        "Scanner biến đổi sai byte.\n"
        f"kept={kept}\nINPUT   ={in_bytes!r}\nOUTPUT  ={out_bytes!r}\n"
        f"EXPECTED={expected!r}"
    )

    # Kiểm tra bổ trợ: mọi vùng được bảo vệ vẫn xuất hiện NGUYÊN VẸN trong output.
    for body, marker in items:
        if marker[0] == "protected":
            assert body.encode("latin-1") in out_bytes, (
                f"Vùng được bảo vệ bị thay đổi: {body!r} không còn trong output "
                f"{out_bytes!r}"
            )

    # Số ColorHit thu được phải bằng số toán tử CMYK thật (mỗi op → 1 hit).
    real_ops = sum(1 for _b, m in items if m[0] in ("real", "real_scn"))
    assert len(hits) == real_ops, (
        f"Số ColorHit ({len(hits)}) khác số toán tử CMYK thật ({real_ops})"
    )
