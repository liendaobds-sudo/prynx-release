"""
Property-Based Test cho `editText` và `add` (spec `pdf-object-edit`).

Bổ sung khoảng trống audit: move/rotate/delete đã có PBT; editText/add trước
đây mới có unit + integration. File này thêm PBT metamorphic/invariant:

**Property E (editText — granular):** sửa nội dung ĐÚNG MỘT run text trong một
cụm BT…ET nhiều run → CHỈ run đó đổi nội dung; các run khác GIỮ NGUYÊN nội dung;
SỐ object text KHÔNG đổi (không gộp/xoá cụm). Validates: granular edit_text.

**Property A (add — chỉ bổ sung):** thêm một text/image mới → các object CŨ giữ
nguyên (kind+bbox), tổng số span TĂNG ĐÚNG 1. Validates: Requirements 9.1/9.4.

Lưu ý kỹ thuật:
- editText: dùng font chuẩn Helvetica + nội dung ASCII (chỉ chữ/số) để PDFium
  trích lại CHÍNH XÁC (giữ font gốc, không fallback) → so khớp nội dung tin cậy.
- add: dùng vector grid (bbox CHÍNH XÁC từ `re`/CTM) cho object cũ, kiểm qua
  `build_op_spans` in-memory (không cần PDFium ghi).
"""
import os
import sys
import tempfile
from collections import Counter
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core import geometry_reader
from app.core.object_mapper import build_op_spans
from app.core.stream_editor import add_image, add_text, edit_text
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta

# ── Strategy nội dung ASCII an toàn (không '(' ')' '\\' để không vỡ literal) ──
_ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
_word = st.text(alphabet=_ASCII, min_size=2, max_size=6)


def _build_text_pdf(words):
    """Dựng PDF 1 trang: 1 cụm BT…ET, mỗi `word` là 1 run trên 1 dòng riêng."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(420, 820))
    pg = pdf.pages[0]
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding,
    )
    pg.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=pdf.make_indirect(font))
    )
    lines = ["BT", "/F1 14 Tf", "60 760 Td"]
    for w in words:
        lines.append(f"({w}) Tj")
        lines.append("0 -32 Td")  # xuống dòng cho run kế tiếp (run riêng biệt)
    lines.append("ET")
    pg.obj[pikepdf.Name.Contents] = pdf.make_stream("\n".join(lines).encode("latin-1"))
    return pdf


def _list_from_memory(pdf):
    """Lưu pdf in-memory ra file tạm rồi liệt kê object qua geometry_reader."""
    buf = BytesIO()
    pdf.save(buf)
    tf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        tf.write(buf.getvalue())
        tf.close()
        return geometry_reader.list_objects(tf.name, 0)
    finally:
        try:
            os.remove(tf.name)
        except OSError:
            pass


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY E — editText granular: chỉ run mục tiêu đổi, run khác nguyên vẹn
# ═══════════════════════════════════════════════════════════════════════════
@st.composite
def _edit_plan(draw):
    words = draw(st.lists(_word, min_size=2, max_size=4, unique=True))
    target_idx = draw(st.integers(min_value=0, max_value=len(words) - 1))
    new_text = draw(_word.filter(lambda w: w not in words))
    return words, target_idx, new_text


@settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(plan=_edit_plan())
def test_edit_text_changes_only_target_run(plan):
    words, target_idx, new_text = plan
    pdf = _build_text_pdf(words)
    try:
        before = _list_from_memory(pdf)
        before_contents = [o.content for o in before if o.type == "text"]
        # Tiền đề: mỗi run trích lại đúng nội dung (font Helvetica ASCII tin cậy).
        if Counter(before_contents) != Counter(words):
            return  # PDFium trích khác kỳ vọng (hiếm) → bỏ qua ví dụ này.

        # Object mục tiêu = run có nội dung words[target_idx] (unique nên duy nhất).
        target_word = words[target_idx]
        target = next(o for o in before if o.type == "text" and o.content == target_word)

        page = pdf.pages[0]
        result = edit_text(page, target, new_text, pdf)
        assert result.changed is True

        after = _list_from_memory(pdf)
        after_contents = [o.content for o in after if o.type == "text"]

        # PROPERTY: số run text KHÔNG đổi; đúng run mục tiêu đổi nội dung; còn lại nguyên.
        assert len(after_contents) == len(before_contents), (
            f"Số run text đổi: trước={len(before_contents)} sau={len(after_contents)} "
            f"(không được gộp/xoá cụm)"
        )
        expected = Counter(words)
        expected[target_word] -= 1
        if expected[target_word] == 0:
            del expected[target_word]
        expected[new_text] += 1
        assert Counter(after_contents) == expected, (
            f"Nội dung sai sau editText: kỳ vọng {dict(expected)}, "
            f"thực tế {dict(Counter(after_contents))}"
        )
    finally:
        pdf.close()


def test_edit_text_three_runs_edit_middle_explicit():
    """Sửa run giữa trong 3 run → chỉ run giữa đổi, 2 run kia nguyên."""
    pdf = _build_text_pdf(["Alpha", "Bravo", "Charlie"])
    try:
        before = _list_from_memory(pdf)
        target = next(o for o in before if o.content == "Bravo")
        edit_text(pdf.pages[0], target, "Zulu", pdf)
        after = _list_from_memory(pdf)
        contents = sorted(o.content for o in after if o.type == "text")
        assert contents == sorted(["Alpha", "Zulu", "Charlie"]), contents
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY A — add chỉ bổ sung: object cũ nguyên vẹn, tổng span +1
# ═══════════════════════════════════════════════════════════════════════════
PAGE_W, PAGE_H, COLS, CELL, RECT_W, RECT_H = 700.0, 500.0, 4, 150.0, 40.0, 30.0


def _rect_for(i):
    return 30.0 + (i % COLS) * CELL, 30.0 + (i // COLS) * CELL, RECT_W, RECT_H


def _bbox_for(i):
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _vector_fragment(i):
    x, y, w, h = _rect_for(i)
    return f"q\n{round(0.05 + 0.01 * i, 4):.4f} 0.2 0.6 rg\n{x:.4f} {y:.4f} {w:.4f} {h:.4f} re\nf\nQ\n"


def _build_vec_pdf(n):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    pg = pdf.pages[0]
    pg.obj[pikepdf.Name("/Resources")] = pikepdf.Dictionary()
    pg.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        "".join(_vector_fragment(i) for i in range(n)).encode("latin-1")
    )
    return pdf


def _sig(span):
    return (span.kind, tuple(round(v) for v in span.bbox))


def _img_bytes():
    from PIL import Image
    b = BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(b, format="PNG")
    return b.getvalue()


@settings(max_examples=40, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(n=st.integers(min_value=1, max_value=6), kind=st.sampled_from(["text", "image"]))
def test_add_keeps_originals_and_adds_one(n, kind):
    pdf = _build_vec_pdf(n)
    try:
        page = pdf.pages[0]
        before = Counter(_sig(s) for s in build_op_spans(page, pdf=pdf) if s.kind in ("vector", "image"))
        assert sum(before.values()) == n, "Tiền đề: đủ n vector span"

        # Vị trí thêm nằm ở vùng trống (xa lưới object) để không trùng bbox.
        add_bbox = [500.0, 420.0, 640.0, 470.0]
        if kind == "text":
            res = add_text(page, "NewLabel", add_bbox, pdf, font_size=14.0)
        else:
            res = add_image(page, _img_bytes(), add_bbox, pdf)
        assert res.changed is True

        after_spans = [s for s in build_op_spans(page, pdf=pdf) if s.kind in ("vector", "image", "text")]
        after_vec_img = Counter(_sig(s) for s in after_spans if s.kind in ("vector", "image"))

        # (1) Mọi object CŨ (vector) còn nguyên chữ ký.
        for sig, cnt in before.items():
            assert after_vec_img[sig] >= cnt, f"Object cũ {sig} bị đổi/biến mất sau add"

        # (2) Tổng span TĂNG đúng 1 (object mới được thêm).
        assert len(after_spans) == n + 1, (
            f"Add phải +1 object: trước={n}, sau={len(after_spans)} "
            f"(kind thêm={kind})"
        )
    finally:
        pdf.close()
