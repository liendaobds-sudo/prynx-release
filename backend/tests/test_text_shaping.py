"""
Test cho text_shaping (HarfBuzz) — shaping chữ phức tạp (Arabic/Thai…).

- needs_shaping: phân loại đúng script cần shaping vs Latin/CJK/Vietnamese.
- shape_text: shape được chữ Arabic bằng font có Arabic (Arial trên Windows),
  trả glyph hợp lệ (gid + advance), và shaping ĐỔI chuỗi glyph so với ánh xạ
  cmap thuần (bằng chứng có chọn dạng ngữ cảnh/ligature).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.text_shaping import needs_shaping, shape_text

ARABIC = "\u0633\u0644\u0627\u0645"   # "سلام"
THAI = "\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35"  # "สวัสดี"
_ARIAL = r"C:\Windows\Fonts\arial.ttf"


def test_needs_shaping_classifies_scripts():
    assert needs_shaping(ARABIC) is True
    assert needs_shaping(THAI) is True
    assert needs_shaping("\u05e9\u05dc\u05d5\u05dd") is True  # Hebrew
    # Không cần shaping:
    assert needs_shaping("Hello World") is False
    assert needs_shaping("Tiếng Việt có dấu") is False
    assert needs_shaping("中文字") is False
    assert needs_shaping("한국어") is False
    assert needs_shaping("") is False


@pytest.mark.skipif(not os.path.exists(_ARIAL), reason="Cần font Arial (Windows) có Arabic")
def test_shape_arabic_produces_valid_glyphs():
    glyphs = shape_text(_ARIAL, ARABIC)
    assert glyphs is not None and len(glyphs) >= 1
    for g in glyphs:
        assert isinstance(g["gid"], int) and g["gid"] >= 0
        # advance hữu hạn; phần lớn glyph có advance > 0 (dấu chồng có thể = 0).
        assert g["x_advance"] == g["x_advance"]  # not NaN
    assert any(g["x_advance"] > 0 for g in glyphs), "Phải có glyph tiến (advance>0)"


@pytest.mark.skipif(not os.path.exists(_ARIAL), reason="Cần font Arial (Windows) có Arabic")
def test_shaping_differs_from_naive_cmap():
    """Shaping Arabic phải chọn DẠNG NGỮ CẢNH → chuỗi gid khác cmap thuần."""
    from fontTools.ttLib import TTFont
    font = TTFont(_ARIAL)
    cmap = font.getBestCmap()
    naive_gids = []
    glyph_order = font.getGlyphOrder()
    name_to_gid = {n: i for i, n in enumerate(glyph_order)}
    for ch in ARABIC:
        gname = cmap.get(ord(ch))
        naive_gids.append(name_to_gid.get(gname, -1) if gname else -1)

    shaped = shape_text(_ARIAL, ARABIC)
    assert shaped is not None
    shaped_gids = [g["gid"] for g in shaped]
    # Hoặc số glyph khác (ligature), hoặc chuỗi gid khác (dạng ngữ cảnh).
    assert shaped_gids != naive_gids or len(shaped_gids) != len(naive_gids), (
        f"Shaping không đổi gì so với cmap thuần: shaped={shaped_gids} naive={naive_gids}"
    )
