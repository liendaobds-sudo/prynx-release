"""Unit test: ImageXObjectTransformer bỏ qua ảnh DCTDecode (JPEG-CMYK) + cảnh báo.

Feature: channel-remover (task 7.3)

Req 6.3: WHERE một CMYK_Image_XObject dùng bộ lọc DCTDecode (JPEG-CMYK), THE
Channel_Remover SHALL bỏ qua ảnh đó và ghi nhận cảnh báo rằng ảnh JPEG-CMYK chưa
được xử lý ở phiên bản hiện tại.

Kiểm chứng: với một image XObject /ColorSpace /DeviceCMYK + /Filter /DCTDecode,
``transform`` phải:
  - trả về None (ảnh bị bỏ qua),
  - thêm một cảnh báo vào ``transformer.warnings``,
  - KHÔNG sửa đổi byte của stream (transformer không cố decode JPEG, chỉ phát
    hiện filter rồi bỏ qua).
"""
import pikepdf

from app.core.channel_remover import (
    DCT_WARNING_TEMPLATE,
    ChannelRemovalParams,
    ColorMapper,
    ImageXObjectTransformer,
)

#: Payload JPEG-CMYK giả lập — đủ giống header JPEG (SOI 0xFFD8 ... EOI 0xFFD9)
#: nhưng transformer KHÔNG được phép cố decode nó. Chỉ cần phát hiện /DCTDecode.
_FAKE_JPEG_PAYLOAD = bytes(
    [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]
) + b"fake-cmyk-jpeg-data-not-real" + bytes([0xFF, 0xD9])


def _build_dctdecode_cmyk_xobject(pdf, payload):
    """Đóng gói payload JPEG-CMYK giả thành image XObject DCTDecode DeviceCMYK."""
    stream = pikepdf.Stream(pdf, payload)
    stream.Subtype = pikepdf.Name("/Image")
    stream.Width = 16
    stream.Height = 16
    stream.ColorSpace = pikepdf.Name("/DeviceCMYK")
    stream.BitsPerComponent = 8
    stream.Filter = pikepdf.Name("/DCTDecode")
    return stream


def test_dctdecode_cmyk_image_is_skipped_with_warning_and_bytes_unchanged():
    params = ChannelRemovalParams(
        kept_channels=("C", "M", "K"),
        mode="direct",
    )
    mapper = ColorMapper(params)
    transformer = ImageXObjectTransformer(mapper)

    pdf = pikepdf.new()
    xobj = _build_dctdecode_cmyk_xobject(pdf, _FAKE_JPEG_PAYLOAD)

    # Byte raw của stream trước khi gọi transform (không qua bộ lọc decode).
    raw_before = bytes(xobj.read_raw_bytes())

    hit = transformer.transform("/Im0", xobj)

    # --- Ảnh DCTDecode bị bỏ qua: trả None (Req 6.3) ---
    assert hit is None

    # --- Có đúng một cảnh báo được thêm vào, nội dung đề cập tên XObject ---
    assert len(transformer.warnings) == 1
    expected_warning = DCT_WARNING_TEMPLATE.format(name="/Im0")
    assert transformer.warnings[0] == expected_warning

    # --- Byte của stream KHÔNG bị thay đổi (transformer không đụng vào ảnh) ---
    raw_after = bytes(xobj.read_raw_bytes())
    assert raw_after == raw_before
    assert raw_after == _FAKE_JPEG_PAYLOAD

    # --- Cấu trúc ảnh giữ nguyên: filter vẫn là DCTDecode ---
    assert str(xobj.get("/Filter")) == "/DCTDecode"
    assert int(xobj.get("/Width")) == 16
    assert int(xobj.get("/Height")) == 16
