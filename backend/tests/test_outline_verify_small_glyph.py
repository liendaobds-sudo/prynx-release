"""Chốt hậu kiểm OUT FONT phải bắt được chữ **nhỏ** bị đặt sai chỗ.

Audit lần 3 §3.2 tái hiện được ca đối nghịch nguy hiểm nhất của action "Khóa Font":
bản in không còn text sống, mở được bình thường, nhưng một dấu chấm hoặc một chữ nhỏ
nằm sai chỗ — và hậu kiểm báo `True`, nên output được giao cho người dùng.

Nguyên nhân: chốt theo ô bỏ qua hẳn mọi ô có dưới 64 px mực, tức đúng những glyph nhỏ
nhất; hai lưới mean/coverage toàn trang thì bị nền trắng lớn pha loãng.

Bảng đo gốc của audit (trang 612×792 pt, render 150 DPI, dịch 30 pt):

| glyph | cỡ | px mực | kết quả CŨ |
|---|---|---|---|
| `.` | 12pt | 9  | lọt |
| `i` | 12pt | 34 | lọt |
| `A` | 8pt  | 49 | lọt |
| `A` | 10pt | 75 | bị bắt |

Test này khoá cả ba ca từng lọt, và khoá luôn chiều ngược lại: outline **đúng** không
được báo động giả chỉ vì nét dày thêm dưới một pixel.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

from app.core import outline_text

FONT = (
    Path(__file__).resolve().parents[1] / "app" / "assets" / "fonts" / "DejaVuSans.ttf"
)


def _page_with_text(tmp_path: Path, name: str, x: float, size: float, text: bytes) -> str:
    """Trang 612×792 với đúng một chuỗi chữ, font nhúng thật."""
    if not FONT.is_file():
        pytest.skip("thiếu DejaVuSans.ttf")
    pdf = pikepdf.Pdf.new()
    data = FONT.read_bytes()
    ff = pdf.make_stream(data)
    ff["/Length1"] = len(data)
    desc = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/FontDescriptor"), FontName=pikepdf.Name("/DejaVuSans"),
        Flags=32, ItalicAngle=0, Ascent=900, Descent=-200, CapHeight=700, StemV=80,
        FontBBox=[-1021, -463, 1793, 1232], FontFile2=ff,
    ))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/TrueType"),
        BaseFont=pikepdf.Name("/DejaVuSans"), Encoding=pikepdf.Name("/WinAnsiEncoding"),
        FontDescriptor=desc,
    ))
    content = (
        b"0 0 0 1 k BT /F1 " + f"{size:g}".encode() + b" Tf "
        + f"{x:g} 400".encode() + b" Td (" + text + b") Tj ET"
    )
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 612, 792],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    out = tmp_path / name
    pdf.save(str(out))
    pdf.close()
    return str(out)


@pytest.mark.parametrize(
    "label,size,text",
    [
        ("dau cham 12pt", 12, b"."),
        ("chu i 12pt", 12, b"i"),
        ("chu A 8pt", 8, b"A"),
        ("chu A 10pt", 10, b"A"),
    ],
)
def test_small_glyph_shifted_30pt_is_caught(tmp_path, label, size, text):
    """Ba ca đầu từng lọt hoàn toàn; ca cuối là ca duy nhất chốt cũ bắt được."""
    original = _page_with_text(tmp_path, "orig.pdf", 40.0, size, text)
    shifted = _page_with_text(tmp_path, "shifted.pdf", 70.0, size, text)

    ok, reason = outline_text.verify_outline(original, shifted)
    assert ok is False, f"{label}: chữ dịch 30pt vẫn báo hậu kiểm thành công"
    assert "mất mực" in reason, reason


def test_identical_file_passes(tmp_path):
    """Chiều ngược lại: không được báo động giả trên bản không đổi gì."""
    original = _page_with_text(tmp_path, "same_a.pdf", 40.0, 12, b".")
    same = _page_with_text(tmp_path, "same_b.pdf", 40.0, 12, b".")
    ok, reason = outline_text.verify_outline(original, same)
    assert ok is True, reason


def test_extra_tiny_glyph_is_caught(tmp_path):
    """Giữ nguyên dấu chấm gốc nhưng vẽ thêm một dấu nhỏ vẫn phải bị chặn.

    Audit lần 4 tái hiện Black 9 px → 18 px nhưng chốt cũ trả ``True``: recall
    không mất gì, precision bỏ qua dưới 64 px, mean/coverage bị nền trắng pha
    loãng. Đây là chiều đối nghịch với ca dịch glyph và phải được khóa riêng.
    """
    original = _page_with_text(tmp_path, "one_dot.pdf", 40.0, 12, b".")
    duplicated = _page_with_text(tmp_path, "two_dots.pdf", 40.0, 12, b"..")

    ok, reason = outline_text.verify_outline(original, duplicated)
    assert ok is False, "một dấu chấm nhỏ được thêm vẫn lọt qua hậu kiểm"
    assert "thêm mực" in reason, reason


def test_sub_pixel_thickening_of_a_tiny_glyph_is_not_an_error():
    """Nét dày thêm dưới một pixel là hành vi BÌNH THƯỜNG của outline.

    Path outline đi qua vành fill-adjust của raster nên nở ở mọi biên; với glyph nhỏ
    phần nở đó lớn so với diện tích chữ. Nếu chốt phạt nó thì mọi trang có dấu câu sẽ
    bị chặn — đúng loại báo động giả khiến người dùng học cách bỏ qua cảnh báo.

    Dựng trực tiếp trên mảng để tách bạch: mực gốc 9 px, mực sau bao trọn nó và nở
    thêm một vòng.
    """
    import numpy as np

    before = np.zeros((64, 64), dtype=np.int32)
    before[30:33, 30:33] = 255  # 9 px, cỡ một dấu chấm 12pt @150 DPI
    after = np.zeros((64, 64), dtype=np.int32)
    after[29:34, 29:34] = 255  # nở một vòng quanh chính nó

    assert outline_text._local_ink_mismatch(before, after) is None


def test_tiny_glyph_moved_by_one_pixel_is_tolerated():
    """Lệch đúng 1 px là sai số raster, không phải chữ sai chỗ.

    Không có bước nở 1 px thì một dấu chấm 9 px lệch 1 px sẽ tụt recall về 0 và chặn
    oan cả file.
    """
    import numpy as np

    before = np.zeros((64, 64), dtype=np.int32)
    before[30:33, 30:33] = 255
    after = np.zeros((64, 64), dtype=np.int32)
    after[31:34, 31:34] = 255  # dịch chéo 1 px

    assert outline_text._local_ink_mismatch(before, after) is None


def test_tiny_glyph_moved_far_is_caught():
    """Cùng kích thước ấy nhưng dịch xa thì phải bị bắt."""
    import numpy as np

    before = np.zeros((64, 64), dtype=np.int32)
    before[30:33, 30:33] = 255
    after = np.zeros((64, 64), dtype=np.int32)
    after[30:33, 45:48] = 255  # dịch 15 px

    found = outline_text._local_ink_mismatch(before, after)
    assert found is not None
    assert found[3] == "mat_muc"


def test_tiny_disconnected_ink_is_caught_below_old_precision_floor():
    """Cụm mực mới 9 px phải bị bắt dù nhỏ hơn trần precision cũ 64 px."""
    import numpy as np

    before = np.zeros((64, 64), dtype=np.int32)
    before[20:23, 20:23] = 255
    after = before.copy()
    after[40:43, 40:43] = 255

    found = outline_text._local_ink_mismatch(before, after)
    assert found is not None
    assert found[3] == "them_muc"
