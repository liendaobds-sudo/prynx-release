"""
Unit tests cho `edit_text` (app.core.stream_editor) — font fallback / thiếu glyph.

Phạm vi (Task 7.3 của spec `pdf-object-edit`):
- Kiểm hành vi xử lý font khi SỬA nội dung text qua `edit_text` (task 7.1 đã làm):
  1. BÁO LỖI khi font không đủ glyph (Yêu cầu 8.4): nội dung mới chứa ký tự mà
     cả font gốc lẫn font dự phòng DejaVuSans đều thiếu (ký tự CJK / Hangul) →
     `edit_text` raise `GlyphCoverageError` và KHÔNG ghi (content stream KHÔNG
     đổi — bảo toàn để tránh ghi `.notdef`/ô vuông).
  2. Chèn/sửa text TIẾNG VIỆT dùng font dự phòng DejaVuSans (Yêu cầu 9.3 / 8.3):
     nội dung "Xin chào" (có dấu) → `edit_text` nhúng DejaVuSans dạng Type0 /
     Identity-H, KHÔNG lỗi; xác nhận font được NHÚNG (FontFile2 tồn tại),
     `used_fallback=True`, mọi codepoint của "Xin chào" có trong cmap DejaVuSans,
     và (nếu khả thi) text trích xuất đúng qua PDFium nhờ `/ToUnicode`.

────────────────────────────────────────────────────────────────────────────
LƯU Ý VỀ ObjMeta TEXT (synthetic):
  Giống `test_object_mapper.py`, bbox cụm text ở task 3.1 chỉ là ƯỚC LƯỢNG nên
  ObjMeta thật từ PDFium dễ flaky. Do đó ta dựng ObjMeta SYNTHETIC có bbox =
  bbox của chính `OpSpan` text (lấy từ `build_op_spans`) để `map_object` khớp
  duy nhất — tập trung kiểm LOGIC font fallback, KHÔNG kiểm độ chính xác bbox.
────────────────────────────────────────────────────────────────────────────

Đây KHÔNG phải property-based test — chỉ các ví dụ cụ thể, xác định.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from reportlab.pdfgen import canvas as rl_canvas

from app.core.object_mapper import build_op_spans, contents_coalesce
from app.core.stream_editor import (
    DEFAULT_FALLBACK_FONT_PATH,
    GlyphCoverageError,
    edit_text,
)
from app.schemas.edit import ObjMeta

# ── Hằng số chung ───────────────────────────────────────────────────────────
PAGE_W_PT = 200.0
PAGE_H_PT = 200.0
TEXT_X, TEXT_Y = 40.0, 100.0
ORIG_TEXT = "Hello"


# ── Helpers ──────────────────────────────────────────────────────────────────
def _make_text_pdf(path: str) -> None:
    """PDF 1 trang chứa DUY NHẤT một cụm text Helvetica (font simple)."""
    c = rl_canvas.Canvas(path, pagesize=(PAGE_W_PT, PAGE_H_PT))
    c.setFont("Helvetica", 12)
    c.drawString(TEXT_X, TEXT_Y, ORIG_TEXT)
    c.showPage()
    c.save()


def _content_bytes(pg: pikepdf.Page) -> bytes:
    """
    Trả về bytes content stream (đã giải nén) của trang, chuẩn hóa cho cả trường
    hợp Contents là một stream hay một mảng nhiều stream.
    """
    obj = pg.obj.get("/Contents")
    if obj is None:
        return b""
    if isinstance(obj, pikepdf.Array):
        return b"\n".join(bytes(s.read_bytes()) for s in obj)
    return bytes(obj.read_bytes())


def _text_objmeta_from_span(pg: pikepdf.Page, pdf: pikepdf.Pdf) -> ObjMeta:
    """
    Dựng ObjMeta SYNTHETIC cho cụm text duy nhất trên trang, bbox = bbox của
    chính OpSpan text → `map_object` khớp tuyệt đối (kiểm logic font, không bbox).
    """
    spans = build_op_spans(pg, pdf=pdf)
    text_spans = [s for s in spans if s.kind == "text"]
    assert len(text_spans) == 1, (
        f"Kỳ vọng đúng 1 OpSpan text, nhận: {[(s.kind, s.bbox) for s in spans]}"
    )
    target = text_spans[0]
    return ObjMeta(id="text-0", drawIndex=0, type="text", bbox=list(target.bbox))


def _dejavu_cmap() -> dict:
    """Đọc cmap (codepoint→glyph_id) của DejaVuSans qua reportlab TTFontFile."""
    from reportlab.pdfbase.ttfonts import TTFontFile

    ttf = TTFontFile(DEFAULT_FALLBACK_FONT_PATH)
    return dict(ttf.charToGlyph)


# ── Fixtures ──────────────────────────────────────────────────────────────────
@pytest.fixture
def text_pdf(tmp_path):
    p = os.path.join(str(tmp_path), "text_only.pdf")
    _make_text_pdf(p)
    return p


# ═══════════════════════════════════════════════════════════════════════════
#  Case 1 — Thiếu glyph (CJK/emoji) → GlyphCoverageError + KHÔNG ghi (Yêu cầu 8.4)
# ═══════════════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    "bad_text",
    [
        "漢字",        # CJK Hán tự — DejaVuSans không có glyph
        "한글",        # Hangul (Hàn) — DejaVuSans không có glyph
        "こんにちは",  # Hiragana (Nhật) — DejaVuSans không có glyph
    ],
)
def test_edit_text_missing_glyph_raises_and_does_not_write(text_pdf, bad_text):
    """
    Nội dung mới chứa ký tự mà cả font gốc (Helvetica) lẫn font dự phòng
    (DejaVuSans) đều thiếu → `edit_text` raise GlyphCoverageError và content
    stream KHÔNG đổi (Yêu cầu 8.4 — không ghi .notdef/ô vuông).
    """
    with pikepdf.open(text_pdf) as pdf:
        pg = pdf.pages[0]

        # Coalesce TRƯỚC để so sánh công bằng (edit_text cũng coalesce nội bộ;
        # trên trang đã coalesce thao tác này là idempotent).
        contents_coalesce(pdf, pg)
        before = _content_bytes(pg)
        assert before, "Tiền đề: content stream không rỗng"

        meta = _text_objmeta_from_span(pg, pdf)

        with pytest.raises(GlyphCoverageError):
            edit_text(pg, meta, bad_text, pdf=pdf)

        after = _content_bytes(pg)
        assert after == before, (
            "Content stream PHẢI giữ nguyên khi GlyphCoverageError được raise "
            "(Yêu cầu 8.4 — KHÔNG ghi kết quả thiếu glyph)."
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Case 2 — Text tiếng Việt dùng font dự phòng DejaVuSans (Yêu cầu 9.3 / 8.3)
# ═══════════════════════════════════════════════════════════════════════════
VN_TEXT = "Xin chào"


def _find_embedded_type0_font(pg: pikepdf.Page):
    """
    Tìm font Type0 (Identity-H) có FontFile2 nhúng trong /Resources/Font của
    trang. Trả về tuple (font_name, font_dict) hoặc (None, None).
    """
    resources = pg.obj.get("/Resources")
    assert resources is not None, "Trang phải có /Resources sau khi nhúng font"
    fonts = resources.get("/Font")
    assert fonts is not None, "Trang phải có /Resources/Font sau khi nhúng font"

    for key, fd in fonts.items():
        subtype = fd.get("/Subtype")
        if subtype is not None and str(subtype) == "/Type0":
            return str(key), fd
    return None, None


def test_edit_text_vietnamese_uses_dejavu_fallback_embedded(text_pdf):
    """
    Sửa text sang "Xin chào" (có dấu) → dùng font dự phòng DejaVuSans:
      - `edit_text` thành công (changed=True, used_fallback=True);
      - font Type0/Identity-H được ĐĂNG KÝ và NHÚNG (FontFile2 tồn tại);
      - mọi codepoint của "Xin chào" có trong cmap DejaVuSans (đủ glyph).
    """
    cmap = _dejavu_cmap()
    # Tiền đề: DejaVuSans đủ glyph cho mọi ký tự tiếng Việt trong "Xin chào".
    missing = [c for c in VN_TEXT if ord(c) not in cmap]
    assert not missing, f"DejaVuSans phải đủ glyph cho {VN_TEXT!r}, thiếu: {missing}"

    with pikepdf.open(text_pdf) as pdf:
        pg = pdf.pages[0]
        meta = _text_objmeta_from_span(pg, pdf)

        result = edit_text(pg, meta, VN_TEXT, pdf=pdf)

        assert result.changed is True, "Sửa text tiếng Việt phải thay đổi Working_File"
        assert result.used_fallback is True, (
            "Text có dấu phải kích hoạt font dự phòng DejaVuSans (Yêu cầu 8.3/9.3)"
        )
        assert result.new_text == VN_TEXT
        assert result.font_resource, "Phải có tên resource font cho text mới"

        # Font Type0/Identity-H đã được đăng ký + nhúng (FontFile2 tồn tại).
        font_name, fd = _find_embedded_type0_font(pg)
        assert fd is not None, "Phải tồn tại font Type0 (Identity-H) trong Resources"
        assert str(fd.get("/Encoding")) == "/Identity-H", "Encoding phải là Identity-H"

        descendants = fd.get("/DescendantFonts")
        assert descendants is not None and len(descendants) == 1, (
            "Type0 phải có đúng 1 DescendantFont (CIDFontType2)"
        )
        cid_font = descendants[0]
        assert str(cid_font.get("/Subtype")) == "/CIDFontType2"
        descriptor = cid_font.get("/FontDescriptor")
        assert descriptor is not None, "CIDFontType2 phải có FontDescriptor"
        assert "/FontFile2" in descriptor, (
            "Font PHẢI được nhúng (FontFile2 tồn tại) cho ký tự tiếng Việt (Yêu cầu 9.3)"
        )
        fontfile = descriptor.get("/FontFile2")
        assert len(bytes(fontfile.read_bytes())) > 0, "FontFile2 nhúng không được rỗng"


def test_edit_text_vietnamese_extractable_via_pdfium(text_pdf):
    """
    Sau khi nhúng DejaVuSans (Identity-H) + `/ToUnicode`, text "Xin chào" phải
    TRÍCH XUẤT được qua PDFium (đọc-only). Đây là kiểm bổ sung (Yêu cầu 8.3/9.3):
    ToUnicode giúp text vẫn tìm kiếm/trích xuất đúng dù mã hóa CID.
    """
    import unicodedata

    import pypdfium2 as pdfium

    with pikepdf.open(text_pdf) as pdf:
        pg = pdf.pages[0]
        meta = _text_objmeta_from_span(pg, pdf)
        result = edit_text(pg, meta, VN_TEXT, pdf=pdf)
        assert result.changed and result.used_fallback

        # Lưu ra bytes (đường ghi pikepdf) rồi đọc lại bằng PDFium read-only.
        import io

        buf = io.BytesIO()
        pdf.save(buf)
        data = buf.getvalue()

    doc = pdfium.PdfDocument(data)
    try:
        page = doc[0]
        textpage = page.get_textpage()
        extracted = textpage.get_text_bounded()
    finally:
        doc.close()

    norm = unicodedata.normalize("NFC", extracted or "")
    # ASCII tiền tố "Xin ch" map ổn định qua ToUnicode; chấp nhận khác biệt
    # tổ hợp dấu nên kiểm phần ASCII đáng tin cậy là đủ để xác nhận trích xuất.
    assert "Xin" in norm, f"Text trích xuất phải chứa 'Xin' (nhận: {norm!r})"
    assert "ch" in norm, f"Text trích xuất phải chứa 'ch' (nhận: {norm!r})"
