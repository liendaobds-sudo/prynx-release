"""`OUTLINE_FONTS` lấy hình học chữ từ PPE (kế hoạch §19.7).

Điều được khoá ở đây là ba tính chất khiến nguồn PPE **an toàn khi bật**:

1. path của PPE đúng chỗ — chữ outline phải nằm trùng chữ gốc (so-kẽm);
2. nguồn PPE **cộng thêm**, không thay thế: glyph nào PPE không có vẫn đi đường
   fontTools, nên bật nó không thể làm mất chữ so với bản cũ;
3. chỉ số lệch bị **phát hiện và từ chối**, không im lặng gán path cho glyph khác —
   đây là kiểu hỏng duy nhất mà nguồn PPE có thể tạo ra.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

pdfcompare_native = pytest.importorskip(
    "pdfcompare_native",
    reason="cần build native: maturin develop --release --manifest-path native/Cargo.toml",
)
if not hasattr(pdfcompare_native, "ppe_text_outlines"):
    pytest.skip("native chưa có ppe_text_outlines — cần rebuild", allow_module_level=True)

from app.core import outline_text  # noqa: E402
from app.core.ppe_outlines import PpeGlyphSource, instructions_from_glyph  # noqa: E402

FONT = (
    Path(__file__).resolve().parents[1] / "app" / "assets" / "fonts" / "DejaVuSans.ttf"
)


def _pdf_with_embedded_font(tmp_path: Path, content: bytes, *, scale_cm: bool = False) -> str:
    """PDF một trang, font TrueType nhúng thật (không phải font giả)."""
    if not FONT.is_file():
        pytest.skip("thiếu DejaVuSans.ttf")
    pdf = pikepdf.Pdf.new()
    data = FONT.read_bytes()
    font_file = pdf.make_stream(data)
    font_file["/Length1"] = len(data)
    descriptor = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/FontDescriptor"),
            FontName=pikepdf.Name("/DejaVuSans"),
            Flags=32,
            ItalicAngle=0,
            Ascent=900,
            Descent=-200,
            CapHeight=700,
            StemV=80,
            FontBBox=[-1021, -463, 1793, 1232],
            FontFile2=font_file,
        )
    )
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/TrueType"),
            BaseFont=pikepdf.Name("/DejaVuSans"),
            Encoding=pikepdf.Name("/WinAnsiEncoding"),
            FontDescriptor=descriptor,
        )
    )
    if scale_cm:
        content = b"q 2 0 0 2 0 0 cm\n" + content + b"\nQ\n"
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 300, 300],
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    out = tmp_path / ("scaled.pdf" if scale_cm else "plain.pdf")
    pdf.save(str(out))
    pdf.close()
    return str(out)


TEXT = b"BT /F1 36 Tf 30 120 Td (Hop giay ABC) Tj ET"


# ─────────────────────────────────────────────────────────────────────────────
#  Nguồn PPE
# ─────────────────────────────────────────────────────────────────────────────

def test_source_returns_paths_for_embedded_truetype(tmp_path):
    src = _pdf_with_embedded_font(tmp_path, TEXT)
    source = PpeGlyphSource.for_page(src, 1)
    assert source.complete, source.why_incomplete()
    assert source.missing_glyphs == 0
    path = source.path_for("page", 0, 0)
    assert path, "glyph đầu tiên phải có path"
    ops = {str(op) for _operands, op in path}
    assert "m" in ops and ops & {"l", "c"}


def test_space_has_no_path_and_that_is_not_an_error(tmp_path):
    src = _pdf_with_embedded_font(tmp_path, TEXT)
    source = PpeGlyphSource.for_page(src, 1)
    # "Hop giay ABC" — mã thứ 3 (0-based) là dấu cách.
    assert source.path_for("page", 0, 3) is None
    assert source.complete, "dấu cách không được tính là glyph mất"


def test_glyph_ordinal_counts_spaces_so_indices_stay_aligned(tmp_path):
    """Hợp đồng đồng bộ: chỉ số đếm MỌI mã ký tự, kể cả dấu cách.

    Chỉ đếm glyph vẽ được sẽ làm hai bên lệch ngay ở dấu cách đầu tiên và path bị
    gán cho glyph khác — file vẫn có chữ, chỉ sai chỗ.
    """
    src = _pdf_with_embedded_font(tmp_path, b"BT /F1 36 Tf 30 120 Td (A B) Tj ET")
    source = PpeGlyphSource.for_page(src, 1)
    assert source.path_for("page", 0, 0) is not None  # A
    assert source.path_for("page", 0, 1) is None      # dấu cách
    assert source.path_for("page", 0, 2) is not None  # B


def test_path_is_in_stream_space_not_device_space(tmp_path):
    """`cm` vẫn còn trong stream sau khi thay khối BT…ET ⇒ path không mang CTM.

    Nhân CTM vào đây là nhân hai lần — bug §3.8, chỉ lộ trên trang CÓ `cm`.
    """
    plain = PpeGlyphSource.for_page(_pdf_with_embedded_font(tmp_path, TEXT), 1)
    scaled = PpeGlyphSource.for_page(
        _pdf_with_embedded_font(tmp_path, TEXT, scale_cm=True), 1
    )
    a = plain.path_for("page", 0, 0)
    b = scaled.path_for("page", 0, 0)
    assert a and b
    assert a[0][0] == pytest.approx(b[0][0], abs=0.01), "path bị nhân CTM"


def test_bad_verb_stream_is_rejected_loudly():
    with pytest.raises(ValueError):
        instructions_from_glyph({"verbs": bytes([99]), "coords": []})
    with pytest.raises(ValueError):
        instructions_from_glyph({"verbs": bytes([0]), "coords": [1.0]})


# ─────────────────────────────────────────────────────────────────────────────
#  Đấu nối vào bộ ghi PDF
# ─────────────────────────────────────────────────────────────────────────────

def test_outline_uses_ppe_geometry_and_passes_ink_verify(tmp_path):
    """Đường end-to-end: outline bằng hình học PPE rồi so kẽm với bản gốc."""
    src = _pdf_with_embedded_font(tmp_path, TEXT)
    out = str(tmp_path / "outlined.pdf")
    result = outline_text.outline_fonts(src, out)
    assert result.get("supported"), result
    assert result.get("glyphs", 0) > 0, result
    ok, reason = outline_text.verify_outline(src, out)
    assert ok, reason
    # Không còn text sống: đó là mục đích của action.
    with pikepdf.open(out) as pdf:
        assert "/Font" not in (pdf.pages[0].get("/Resources") or {})


def test_misaligned_source_is_rejected_instead_of_placing_wrong_glyph(tmp_path, monkeypatch):
    """Chốt chống lệch chỉ số — kiểu hỏng duy nhất nguồn PPE có thể tạo ra.

    Ép nguồn trả path của một glyph nằm cách vị trí bút rất xa; bộ ghi phải TỪ CHỐI
    nó và lùi về đường fontTools, chứ không dán path sai chỗ vào bản in.
    """
    src = _pdf_with_embedded_font(tmp_path, TEXT)
    real = PpeGlyphSource.for_page(src, 1)

    class Shifted:
        """Nguồn trả path đã bị dịch 500pt — mô phỏng lệch chỉ số."""

        def __init__(self, inner):
            self._inner = inner

        def path_for(self, stream, bt, ordinal):
            path = self._inner.path_for(stream, bt, ordinal)
            if not path:
                return None
            return [
                ([v + 500.0 for v in operands], op) if operands else (operands, op)
                for operands, op in path
            ]

    out = str(tmp_path / "outlined_shift.pdf")
    monkeypatch.setattr(
        outline_text, "_ppe_source_for_page", lambda *_a, **_k: Shifted(real)
    )
    result = outline_text.outline_fonts(src, out)
    # Vẫn thành công vì đã lùi về fontTools; và bản in vẫn khớp bản gốc.
    assert result.get("supported"), result
    ok, reason = outline_text.verify_outline(src, out)
    assert ok, f"path lệch đã lọt vào bản in: {reason}"


def test_failure_of_ppe_source_never_breaks_the_action(tmp_path, monkeypatch):
    """Nguồn PPE là phần cộng thêm: nó gãy thì tác vụ vẫn phải chạy như trước."""
    src = _pdf_with_embedded_font(tmp_path, TEXT)

    def explode(*_a, **_k):
        raise RuntimeError("native hỏng")

    monkeypatch.setattr(
        "app.core.ppe_outlines.PpeGlyphSource.for_page", staticmethod(explode)
    )
    out = str(tmp_path / "outlined_nofallbacksrc.pdf")
    result = outline_text.outline_fonts(src, out)
    assert result.get("supported"), result
    ok, reason = outline_text.verify_outline(src, out)
    assert ok, reason
