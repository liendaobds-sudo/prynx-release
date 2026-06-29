"""Property test (file-level): tính trung thực của cảnh báo Out_Of_Gamut.

Feature: channel-remover

Phần file-level của Property 5: ở mức báo cáo (``_aggregate_report``), báo cáo
phải TRUNG THỰC về việc kết quả có giống hệt bản gốc hay không:

  - ``identical_to_original`` đúng bằng ``(out_of_gamut_count == 0)`` (Req 4.4).
  - Cảnh báo OOG (``OOG_WARNING``) xuất hiện trong ``warnings`` KHI VÀ CHỈ KHI
    ``out_of_gamut_count > 0`` (Req 4.2) — báo cáo không bao giờ tuyên bố
    "identical" trong khi vẫn tồn tại màu Out_Of_Gamut.

Driver: sinh ngẫu nhiên danh sách ``ColorHit``/``ImageHit`` (một số OOG, một số
không), gọi ``_aggregate_report`` rồi kiểm tra các bất biến trên.
"""
from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    OOG_WARNING,
    ColorHit,
    ImageHit,
    _aggregate_report,
)

# Một thành phần kênh CMYK trên thang 0..100 (%).
_channel_value = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)

_cmyk = st.tuples(
    _channel_value, _channel_value, _channel_value, _channel_value
)

# ΔE không âm, hữu hạn.
_delta_e = st.floats(
    min_value=0.0, max_value=200.0, allow_nan=False, allow_infinity=False
)


@st.composite
def _color_hit(draw):
    """Một ColorHit vector ngẫu nhiên, có/không out_of_gamut."""
    return ColorHit(
        source_cmyk=draw(_cmyk),
        result_cmyk=draw(_cmyk),
        delta_e=draw(_delta_e),
        out_of_gamut=draw(st.booleans()),
    )


@st.composite
def _image_hit(draw):
    """Một ImageHit ảnh ngẫu nhiên; out_of_gamut_pixels <= pixels."""
    pixels = draw(st.integers(min_value=0, max_value=10_000))
    oog_pixels = draw(st.integers(min_value=0, max_value=pixels))
    return ImageHit(
        xobj_name=draw(st.text(min_size=0, max_size=8)),
        pixels=pixels,
        max_delta_e=draw(_delta_e),
        out_of_gamut_pixels=oog_pixels,
    )


# Feature: channel-remover, Property 5 (file-level): Out-of-gamut classification,
# warning, and honesty (phần report + identical_to_original)
# Ở mức báo cáo, identical_to_original == (out_of_gamut_count == 0) và OOG_WARNING
# có mặt khi và chỉ khi out_of_gamut_count > 0 — báo cáo không tuyên bố "identical"
# khi vẫn tồn tại màu Out_Of_Gamut.
# Validates: Requirements 4.2, 4.4
@settings(max_examples=200, deadline=None)
@given(
    color_hits=st.lists(_color_hit(), min_size=0, max_size=30),
    image_hits=st.lists(_image_hit(), min_size=0, max_size=15),
    warnings=st.lists(st.text(min_size=0, max_size=12), min_size=0, max_size=5),
)
def test_report_oog_warning_honesty(color_hits, image_hits, warnings):
    report = _aggregate_report(
        output_filename="out.pdf",
        color_hits=color_hits,
        image_hits=image_hits,
        warnings=warnings,
    )

    # OOG count kỳ vọng = số ColorHit OOG + tổng pixel OOG của ảnh.
    expected_oog = (
        sum(1 for hit in color_hits if hit.out_of_gamut)
        + sum(hit.out_of_gamut_pixels for hit in image_hits)
    )
    assert report.out_of_gamut_count == expected_oog, (
        f"out_of_gamut_count={report.out_of_gamut_count} != kỳ vọng {expected_oog}"
    )

    # Honesty 1: identical_to_original đúng bằng (out_of_gamut_count == 0) (Req 4.4).
    assert report.identical_to_original == (report.out_of_gamut_count == 0), (
        f"identical_to_original={report.identical_to_original} không khớp với "
        f"(out_of_gamut_count={report.out_of_gamut_count} == 0)"
    )

    # Honesty 2: OOG_WARNING có mặt khi và chỉ khi out_of_gamut_count > 0 (Req 4.2).
    oog_warning_present = OOG_WARNING in report.warnings
    assert oog_warning_present == (report.out_of_gamut_count > 0), (
        f"OOG_WARNING present={oog_warning_present} không khớp với "
        f"(out_of_gamut_count={report.out_of_gamut_count} > 0)"
    )

    # Hệ quả: báo cáo không bao giờ vừa "identical" vừa có cảnh báo OOG.
    if report.identical_to_original:
        assert OOG_WARNING not in report.warnings, (
            "Báo cáo tuyên bố identical_to_original nhưng vẫn chứa OOG_WARNING"
        )
