"""
text_shaping.py — Shaping chữ phức tạp (Arabic/Thai/Indic/Hebrew…) bằng HarfBuzz.

VÌ SAO: với chữ Latin/CJK/tiếng Việt, mỗi codepoint ↦ 1 glyph theo `cmap`, đặt
tuần tự (Tj đơn giản) là ĐÚNG. Nhưng chữ Arabic/Thai/Indic cần SHAPING: chọn
dạng glyph theo NGỮ CẢNH (đầu/giữa/cuối từ), ghép ligature, đổi thứ tự, đặt dấu
chồng — `cmap` thuần KHÔNG đủ → ra chữ sai. HarfBuzz giải quyết việc này.

Module này CHỈ cung cấp tiện ích shaping THUẦN (không đụng pikepdf/PDF). Tích hợp
vào đường ghi (subset theo GID + đặt glyph) do `stream_editor` đảm nhiệm, và CHỈ
kích hoạt cho text `needs_shaping(...)` → KHÔNG ảnh hưởng đường Latin/CJK đã ổn.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Các khoảng Unicode cần shaping (chọn dạng theo ngữ cảnh / ghép / dấu chồng).
# Arabic, Hebrew, Syriac, Thaana, NKo; Devanagari→các chữ Ấn; Thai, Lao, Myanmar,
# Khmer. (CJK/Hangul/Latin/Cyrillic/Greek KHÔNG cần → vẫn đi đường Tj đơn giản.)
_COMPLEX_RANGES = [
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0700, 0x074F),  # Syriac
    (0x0750, 0x077F),  # Arabic Supplement
    (0x07C0, 0x07FF),  # NKo
    (0x0900, 0x097F),  # Devanagari
    (0x0980, 0x09FF),  # Bengali
    (0x0A00, 0x0D7F),  # Gurmukhi…Malayalam (các chữ Ấn)
    (0x0E00, 0x0E7F),  # Thai
    (0x0E80, 0x0EFF),  # Lao
    (0x1000, 0x109F),  # Myanmar
    (0x1780, 0x17FF),  # Khmer
    (0xFB1D, 0xFDFF),  # Hebrew/Arabic presentation forms A
    (0xFE70, 0xFEFF),  # Arabic presentation forms B
]


def needs_shaping(text: str) -> bool:
    """True nếu `text` chứa ký tự thuộc chữ viết CẦN shaping (Arabic/Thai/Indic…)."""
    for ch in text:
        o = ord(ch)
        for lo, hi in _COMPLEX_RANGES:
            if lo <= o <= hi:
                return True
    return False


def shape_text(font_path: str, text: str, font_number: int = 0) -> list[dict] | None:
    """
    Shape `text` bằng HarfBuzz với font tại `font_path`, trả về danh sách glyph đã
    shape theo THỨ TỰ VẼ:

        [{"gid": int, "x_advance": float, "x_offset": float, "y_offset": float}, ...]

    Đơn vị advance/offset theo EM (chuẩn hoá / units-per-em) → caller nhân với cỡ
    chữ (pt) để ra point. Trả None nếu HarfBuzz/đọc font lỗi (caller fallback).
    """
    try:
        import uharfbuzz as hb
    except Exception as exc:  # noqa: BLE001
        logger.warning("uharfbuzz không khả dụng → bỏ shaping: %s", exc)
        return None
    try:
        with open(font_path, "rb") as f:
            data = f.read()
        face = hb.Face(data, font_number)
        upem = face.upem or 1000
        font = hb.Font(face)

        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()  # tự suy script/direction/language
        hb.shape(font, buf, {})

        infos = buf.glyph_infos
        positions = buf.glyph_positions
        out: list[dict] = []
        for gi, pos in zip(infos, positions):
            out.append({
                "gid": int(gi.codepoint),  # sau shaping, codepoint = GID
                "x_advance": pos.x_advance / upem,
                "x_offset": pos.x_offset / upem,
                "y_offset": pos.y_offset / upem,
            })
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning("shape_text lỗi với font '%s': %s", font_path, exc)
        return None
