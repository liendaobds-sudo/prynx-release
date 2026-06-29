"""Property test: thống kê ΔE tổng hợp trong report (``_aggregate_report``).

Feature: channel-remover

Property 6: Aggregate Delta_E statistics are correct. Với mọi danh sách ColorHit
và ImageHit ngẫu nhiên, report do ``_aggregate_report`` tạo phải có:

  - ``max_delta_e`` = max trên TẤT CẢ giá trị ΔE hit (ColorHit.delta_e và
    ImageHit.max_delta_e); = 0.0 khi không có hit nào.
  - ``avg_delta_e`` = trung bình cộng của tập đại diện ΔE (mỗi ColorHit đóng góp
    ``delta_e``, mỗi ImageHit đóng góp ``max_delta_e``); = 0.0 khi rỗng.
  - ``out_of_gamut_count`` = số ColorHit out_of_gamut + tổng ImageHit
    .out_of_gamut_pixels.
  - ``total_colors`` = len(color_hits) + len(image_hits).

Validates: Requirements 4.1
"""
import math

from hypothesis import given, settings, strategies as st

from app.core.channel_remover import (
    ColorHit,
    ImageHit,
    _aggregate_report,
)

# Sai số float khi so sánh trung bình/max.
_EPS = 1e-9

# Giá trị ΔE hợp lệ (không âm, hữu hạn).
_delta_e_value = st.floats(
    min_value=0.0, max_value=200.0, allow_nan=False, allow_infinity=False
)

# Một thành phần kênh CMYK trên thang 0..100 (%) cho source/result cmyk.
_channel_value = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)

_cmyk_tuple = st.tuples(
    _channel_value, _channel_value, _channel_value, _channel_value
)


@st.composite
def _color_hits(draw):
    """Sinh danh sách ColorHit ngẫu nhiên (có thể rỗng)."""
    return draw(
        st.lists(
            st.builds(
                ColorHit,
                source_cmyk=_cmyk_tuple,
                result_cmyk=_cmyk_tuple,
                delta_e=_delta_e_value,
                out_of_gamut=st.booleans(),
            ),
            min_size=0,
            max_size=12,
        )
    )


@st.composite
def _image_hits(draw):
    """Sinh danh sách ImageHit ngẫu nhiên (có thể rỗng)."""
    return draw(
        st.lists(
            st.builds(
                ImageHit,
                xobj_name=st.text(max_size=8),
                pixels=st.integers(min_value=0, max_value=1_000_000),
                max_delta_e=_delta_e_value,
                out_of_gamut_pixels=st.integers(min_value=0, max_value=1_000_000),
            ),
            min_size=0,
            max_size=12,
        )
    )


# Feature: channel-remover, Property 6: Aggregate Delta_E statistics are correct
# For any tập ColorHit/ImageHit, report.max_delta_e bằng max trên mọi ΔE hit và
# report.avg_delta_e bằng trung bình tập đại diện ΔE như _aggregate_report cài đặt.
# Validates: Requirements 4.1
@settings(max_examples=200, deadline=None)
@given(color_hits=_color_hits(), image_hits=_image_hits())
def test_aggregate_delta_e_statistics_are_correct(color_hits, image_hits):
    report = _aggregate_report(
        output_filename="out.pdf",
        color_hits=color_hits,
        image_hits=image_hits,
        warnings=[],
    )

    # Tập đại diện ΔE độc lập: ColorHit.delta_e + ImageHit.max_delta_e.
    deltas = (
        [hit.delta_e for hit in color_hits]
        + [hit.max_delta_e for hit in image_hits]
    )

    # max_delta_e = max trên mọi ΔE hit; 0.0 nếu rỗng.
    expected_max = max(deltas) if deltas else 0.0
    assert math.isclose(
        report.max_delta_e, expected_max, rel_tol=0.0, abs_tol=_EPS
    ), f"max_delta_e={report.max_delta_e} != expected {expected_max}"

    # avg_delta_e = trung bình tập đại diện; 0.0 nếu rỗng.
    expected_avg = (sum(deltas) / len(deltas)) if deltas else 0.0
    assert math.isclose(
        report.avg_delta_e, expected_avg, rel_tol=0.0, abs_tol=_EPS
    ), f"avg_delta_e={report.avg_delta_e} != expected {expected_avg}"

    # out_of_gamut_count = ColorHit OOG + tổng pixel OOG của ảnh.
    expected_oog = (
        sum(1 for hit in color_hits if hit.out_of_gamut)
        + sum(hit.out_of_gamut_pixels for hit in image_hits)
    )
    assert report.out_of_gamut_count == expected_oog, (
        f"out_of_gamut_count={report.out_of_gamut_count} != expected {expected_oog}"
    )

    # total_colors = số đại diện màu = len(color_hits) + len(image_hits).
    expected_total = len(color_hits) + len(image_hits)
    assert report.total_colors == expected_total, (
        f"total_colors={report.total_colors} != expected {expected_total}"
    )


def test_aggregate_empty_case():
    """Trường hợp rỗng: không hit nào → max/avg = 0.0, count/total = 0."""
    report = _aggregate_report(
        output_filename=None,
        color_hits=[],
        image_hits=[],
        warnings=[],
    )
    assert report.max_delta_e == 0.0
    assert report.avg_delta_e == 0.0
    assert report.out_of_gamut_count == 0
    assert report.total_colors == 0
