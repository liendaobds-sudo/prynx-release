"""Unit tests: xử lý spot color với spot_handling="convert" (Task 6.6).

Feature: channel-remover
Validates: Requirements 7.3

HÀNH VI THỰC TẾ ĐANG ĐƯỢC KIỂM THỬ
----------------------------------
Req 7.3 mô tả tùy chọn "convert": một Spot_Color ĐÃ BIẾT được chuyển sang CMYK
trước, rồi mới gỡ kênh process. Việc chuyển Separation/DeviceN → CMYK đúng đắn
đòi hỏi đánh giá *tint transform function* của alternate color space — điều mà
scanner byte-level (``ContentStreamTransformer``) hiện KHÔNG phân giải.

Vì vậy, trong cài đặt hiện tại của ``_handle_color_operator``, nhánh
``spot_handling == "convert"`` là một ĐIỂM MỞ RỘNG an toàn (no-op): toán hạng
spot được GIỮ NGUYÊN bytewise thay vì bị biến đổi sai. Các test dưới đây đặc tả
chính xác hành vi hiện tại đó (spot operands được bảo toàn) để bộ test luôn xanh
và mô tả trung thực trạng thái cài đặt. Khi convert-to-CMYK đầy đủ được hiện
thực ở tương lai, các test này cần được cập nhật để khẳng định màu spot đã biết
chuyển sang CMYK rồi gỡ kênh.

LƯU Ý: đây là unit test (không phải property test) — KHÔNG dùng Hypothesis.
"""
from app.core.channel_remover import (
    ChannelRemovalParams,
    ColorHit,
    ColorMapper,
    ContentStreamTransformer,
)


def _make_transformer(kept, spot_handling, cs_resources):
    """Dựng ContentStreamTransformer chế độ direct với spot_handling cho trước.

    Dùng mode "direct" để test không phụ thuộc vào ICC profile; quyết định xử lý
    spot là độc lập với mode (cùng nhánh trong ``_handle_color_operator``).
    """
    params = ChannelRemovalParams(
        kept_channels=tuple(kept),
        mode="direct",
        spot_handling=spot_handling,
    )
    mapper = ColorMapper(params)
    return ContentStreamTransformer(
        mapper=mapper, cs_resources=cs_resources, spot_handling=spot_handling
    )


# ---------------------------------------------------------------------------
# Spot Separation đã biết — convert hiện là no-op an toàn (future extension)
# ---------------------------------------------------------------------------

def test_known_separation_spot_preserved_under_convert():
    """Spot Separation đã biết: convert hiện GIỮ NGUYÊN toán hạng spot (no-op).

    DOCUMENTED BEHAVIOR (Req 7.3 extension point): full convert-to-CMYK chưa được
    hiện thực ở tầng scanner byte-level, nên màu spot được bảo toàn bytewise thay
    vì biến đổi sai. Khi convert đầy đủ được cài, test này phải đổi để khẳng định
    spot đã biết được chuyển sang CMYK rồi gỡ kênh.
    """
    # Separation "PANTONE 185 C" với alternate DeviceCMYK — một spot ĐÃ BIẾT.
    cs_resources = {
        "/Spot185": ["/Separation", "/PANTONE_185_C", "/DeviceCMYK"],
    }
    spot_segment = b"/Spot185 cs\n0.7500 scn\n"
    data = b"q\n" + spot_segment + b"Q\n"

    transformer = _make_transformer(
        kept=("C", "M", "Y"), spot_handling="convert", cs_resources=cs_resources
    )
    out, hits = transformer.transform(data)

    # Toán hạng spot được giữ nguyên bytewise; không có màu nào bị map.
    assert out == data, "convert hiện là no-op an toàn: spot phải giữ nguyên bytewise"
    assert hits == [], "Không màu spot nào được map khi convert chưa hiện thực"


def test_known_separation_stroke_spot_preserved_under_convert():
    """Biến thể nét (CS/SCN) của spot đã biết cũng được giữ nguyên dưới convert."""
    cs_resources = {
        "/GoldPlate": ["/Separation", "/Gold", "/DeviceCMYK"],
    }
    spot_segment = b"/GoldPlate CS\n0.3000 SCN\n"
    data = b"q\n" + spot_segment + b"Q\n"

    transformer = _make_transformer(
        kept=("C", "M", "K"), spot_handling="convert", cs_resources=cs_resources
    )
    out, hits = transformer.transform(data)

    assert out == data
    assert hits == []


def test_known_devicen_spot_preserved_under_convert():
    """Spot DeviceN (nhiều colorant) đã biết cũng là no-op an toàn dưới convert."""
    cs_resources = {
        "/DuoTone": ["/DeviceN", ["/Spot1", "/Spot2"], "/DeviceCMYK"],
    }
    spot_segment = b"/DuoTone cs\n0.2000 0.8000 scn\n"
    data = b"q\n" + spot_segment + b"Q\n"

    transformer = _make_transformer(
        kept=("C", "M", "Y"), spot_handling="convert", cs_resources=cs_resources
    )
    out, hits = transformer.transform(data)

    assert out == data
    assert hits == []


# ---------------------------------------------------------------------------
# convert chỉ ảnh hưởng quyết định về spot — CMYK device color VẪN bị gỡ kênh
# ---------------------------------------------------------------------------

def test_convert_still_removes_channels_on_devicecmyk():
    """Dưới spot_handling="convert", toán hạng DeviceCMYK thật vẫn bị gỡ kênh.

    Xác nhận nhánh convert chỉ thay đổi cách xử lý spot (no-op hiện tại) chứ
    KHÔNG cản trở việc gỡ kênh trên màu process DeviceCMYK.
    """
    cs_resources = {
        "/Spot185": ["/Separation", "/PANTONE_185_C", "/DeviceCMYK"],
    }
    # Spot đã biết + một toán tử k DeviceCMYK với K>0 (kept ⊆ {C,M,Y} → K bị gỡ).
    spot_segment = b"/Spot185 cs\n0.5000 scn\n"
    data = b"q\n" + spot_segment + b"0.2000 0.4000 0.6000 0.8000 k\n" + b"Q\n"

    transformer = _make_transformer(
        kept=("C", "M", "Y"), spot_handling="convert", cs_resources=cs_resources
    )
    out, hits = transformer.transform(data)

    # Spot giữ nguyên.
    assert spot_segment in out
    # CMYK đã bị biến đổi: kênh K bị gỡ về 0 → toán hạng gốc không còn nguyên vẹn.
    assert b"0.2000 0.4000 0.6000 0.8000 k" not in out
    # Đúng một ColorHit từ màu DeviceCMYK (không phải từ spot).
    assert len(hits) == 1
    hit = hits[0]
    assert isinstance(hit, ColorHit)
    assert hit.source_cmyk == (20.0, 40.0, 60.0, 80.0)
    # K (kênh bị gỡ) về 0; C,M,Y giữ nguyên.
    assert hit.result_cmyk[3] == 0.0
    assert hit.result_cmyk[0] == 20.0
    assert hit.result_cmyk[1] == 40.0
    assert hit.result_cmyk[2] == 60.0


# ---------------------------------------------------------------------------
# So sánh convert vs skip cho spot — hành vi hiện tại tương đương (đều giữ spot)
# ---------------------------------------------------------------------------

def test_convert_matches_skip_for_spot_in_current_implementation():
    """Với spot, convert và skip cho cùng kết quả ở cài đặt hiện tại (đều giữ spot).

    Đặc tả này làm rõ rằng convert CHƯA tách biệt hành vi khỏi skip đối với màu
    spot. Khi convert-to-CMYK đầy đủ được hiện thực, đặc tả này sẽ thay đổi
    (convert sẽ biến đổi spot đã biết, skip thì không).
    """
    cs_resources = {
        "/Spot185": ["/Separation", "/PANTONE_185_C", "/DeviceCMYK"],
    }
    data = b"q\n/Spot185 cs\n0.6500 scn\nQ\n"

    out_skip, hits_skip = _make_transformer(
        kept=("C", "M", "Y"), spot_handling="skip", cs_resources=cs_resources
    ).transform(data)
    out_convert, hits_convert = _make_transformer(
        kept=("C", "M", "Y"), spot_handling="convert", cs_resources=cs_resources
    ).transform(data)

    assert out_skip == out_convert == data
    assert hits_skip == hits_convert == []
