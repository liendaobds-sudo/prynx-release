"""
Property-Based Test (Task 4.2 — spec `pdf-object-edit`).

**Property 3: Xóa chỉ-đúng-mục-tiêu (Invariant).**
Sau khi xóa một tập object mục tiêu khỏi trang, SỐ LƯỢNG và NỘI DUNG của các
Untouched_Object KHÔNG đổi (đúng từng object còn nguyên về loại + bbox + dải
operator), và ĐÚNG các object mục tiêu BIẾN MẤT khỏi content stream.

**Validates: Requirements 3.1, 3.4**

────────────────────────────────────────────────────────────────────────────
CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis)
- Dùng pikepdf dựng content stream THỦ CÔNG để kiểm soát chính xác từng object.
  Mỗi object là một nhóm cô lập `q … Q`:

      VECTOR:                          IMAGE:
        q                                q
          <màu> rg                         w 0 0 h x y cm
          x y w h re                       /Img{i} Do
          f                              Q
        Q

- Mỗi object đặt ở MỘT ô lưới riêng → bbox KHÔNG chồng nhau (khoảng cách ≫ 1.0pt)
  để `Object_Mapper.map_object` đối khớp DUY NHẤT (không kích hoạt fallback 4.7)
  và để mỗi object có "chữ ký" hình học (kind + bbox) TOÀN CỤC DUY NHẤT.
- Theo lưu ý của task: ưu tiên IMAGE/VECTOR (bbox CHÍNH XÁC từ CTM/`re`), KHÔNG
  dùng text (bbox text ở task 3.1 chỉ là ước lượng → dễ flaky).
- Hypothesis chọn ngẫu nhiên loại mỗi object (vector/image) và tập con để XÓA.

KIỂM CHỨNG (qua `build_op_spans` — in-memory, không cần PDFium ghi)
- TRƯỚC khi xóa: liệt kê OpSpan, xác nhận mỗi object có đúng một span với chữ ký
  (kind, bbox) duy nhất khớp spec (tiền đề generator đúng).
- SAU khi `delete_objects` ghi qua pikepdf: liệt kê lại OpSpan và yêu cầu:
    1. Mỗi Untouched_Object còn ĐÚNG một span cùng (kind, bbox) như cũ.
    2. Mỗi object mục tiêu KHÔNG còn span nào (biến mất).
    3. Tổng số span (vector+image) còn lại == số Untouched_Object.
  → "số lượng + nội dung Untouched_Object không đổi; đúng target biến mất".
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys
from collections import Counter

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.object_mapper import build_op_spans
from app.core.stream_editor import delete_objects
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta

# ── Hằng số layout ──────────────────────────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

OBJ_TYPES = ["vector", "image"]
TOL = BBOX_TOLERANCE_PT  # 1.0pt — chữ ký bbox làm tròn dưới ngưỡng này.


def _rect_for(i: int):
    """(x, y, w, h) cho object thứ i tại một ô lưới KHÔNG chồng nhau."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    """BBox kỳ vọng [x0, y0, x1, y1] của object thứ i."""
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _sig(kind: str, bbox) -> tuple:
    """
    Chữ ký hình học của một object/span: (kind, bbox làm tròn).
    Vì các ô lưới cách nhau ≫ 1.0pt, làm tròn về số nguyên là đủ để mỗi object
    có chữ ký TOÀN CỤC DUY NHẤT mà vẫn dung sai sai số ≤ 1.0pt.
    """
    return (kind, tuple(round(v) for v in bbox))


# ── Dựng PDF từ specs ────────────────────────────────────────────────────────
def _vector_fragment(i: int) -> str:
    """Đoạn `q … Q` cho một vector rect tô màu (màu duy nhất theo i)."""
    x, y, w, h = _rect_for(i)
    r = round(0.05 + 0.01 * i, 4)
    return (
        "q\n"
        f"{r:.4f} 0.2000 0.6000 rg\n"
        f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re\n"
        "f\n"
        "Q\n"
    )


def _image_fragment(i: int) -> str:
    """Đoạn `q … Q` đặt một ảnh XObject /Img{i} tại ô lưới thứ i."""
    x, y, w, h = _rect_for(i)
    # cm = [w 0 0 h x y] → hình vuông đơn vị ảnh phủ đúng [x,y]-[x+w,y+h].
    return (
        "q\n"
        f"{w:.4f} 0 0 {h:.4f} {x:.4f} {y:.4f} cm\n"
        f"/Img{i} Do\n"
        "Q\n"
    )


def _make_image_xobject(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """Tạo một XObject ảnh 2x2 RGB tối thiểu (uncompressed)."""
    data = bytes([200, 30, 30] * 4)  # 2x2 px, 3 kênh
    stream = pikepdf.Stream(pdf, data)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _build_pdf(specs):
    """
    Dựng pikepdf.Pdf 1 trang chứa các object theo `specs`
    (mỗi spec = {"i": int, "kind": "vector"|"image"}). Trả về (pdf, page).
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    xobjects = pikepdf.Dictionary()
    has_xobj = False
    fragments = []

    for spec in specs:
        i, kind = spec["i"], spec["kind"]
        if kind == "vector":
            fragments.append(_vector_fragment(i))
        else:
            fragments.append(_image_fragment(i))
            xobjects[pikepdf.Name(f"/Img{i}")] = _make_image_xobject(pdf)
            has_xobj = True

    resources = pikepdf.Dictionary()
    if has_xobj:
        resources[pikepdf.Name("/XObject")] = xobjects
    page.obj[pikepdf.Name("/Resources")] = resources

    stream = "".join(fragments).encode("latin-1")
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)
    return pdf, page


def _span_signature_counter(page, pdf) -> Counter:
    """Đếm chữ ký (kind, bbox) của các OpSpan vector/image trên trang."""
    counter: Counter = Counter()
    for span in build_op_spans(page, pdf=pdf):
        if span.kind in ("vector", "image"):
            counter[_sig(span.kind, span.bbox)] += 1
    return counter


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _page_plan(draw):
    """Sinh (specs, target_flags): danh sách object + cờ xóa mỗi object."""
    n = draw(st.integers(min_value=2, max_value=8))
    specs = [{"i": i, "kind": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    target_flags = [draw(st.booleans()) for _ in range(n)]
    return specs, target_flags


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 3 — Xóa chỉ-đúng-mục-tiêu (Validates: Requirements 3.1, 3.4)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_page_plan())
def test_delete_removes_only_targets(plan):
    """
    Với mọi tập object mục tiêu được chọn để xóa:
      - Untouched_Object giữ NGUYÊN (số lượng + (kind, bbox) từng object).
      - Đúng các object mục tiêu biến mất.
    """
    specs, target_flags = plan
    pdf, page = _build_pdf(specs)

    try:
        untouched = [s for s, flag in zip(specs, target_flags) if not flag]
        targets = [s for s, flag in zip(specs, target_flags) if flag]

        # Chữ ký kỳ vọng (toàn cục duy nhất) cho untouched và target.
        untouched_sigs = Counter(_sig(s["kind"], _bbox_for(s["i"])) for s in untouched)
        target_sigs = Counter(_sig(s["kind"], _bbox_for(s["i"])) for s in targets)

        # ── Tiền đề: stream gốc chứa đúng span của MỌI object (generator đúng) ──
        before = _span_signature_counter(page, pdf)
        all_sigs = untouched_sigs + target_sigs
        for sig, cnt in all_sigs.items():
            assert before[sig] == cnt, (
                f"Tiền đề sai: chữ ký {sig} kỳ vọng {cnt} span trong stream gốc, "
                f"thực tế {before[sig]}"
            )
        assert sum(before.values()) == len(specs), (
            f"Tiền đề sai: tổng span gốc {sum(before.values())} ≠ số object {len(specs)}"
        )

        # ── Xóa tập mục tiêu qua Stream_Editor (đường ghi pikepdf duy nhất) ────
        target_metas = [
            ObjMeta(
                id=f"obj-{s['i']}",
                drawIndex=s["i"],
                type=s["kind"],
                bbox=_bbox_for(s["i"]),
            )
            for s in targets
        ]
        result = delete_objects(page, target_metas, pdf)

        # Có target → phải thay đổi; không target → no-op.
        assert result.changed is bool(targets)

        # ── PROPERTY ───────────────────────────────────────────────────────────
        after = _span_signature_counter(page, pdf)

        # (1) Mỗi Untouched_Object còn nguyên (đúng số lượng từng chữ ký).
        for sig, cnt in untouched_sigs.items():
            assert after[sig] == cnt, (
                f"Untouched_Object bị thay đổi/biến mất: chữ ký {sig} "
                f"trước={cnt} ≠ sau={after[sig]}"
            )

        # (2) Đúng các object mục tiêu biến mất.
        for sig in target_sigs:
            assert after[sig] == 0, (
                f"Object mục tiêu KHÔNG biến mất hết: chữ ký {sig} còn {after[sig]} span"
            )

        # (3) Tổng số span còn lại == số Untouched_Object (không thừa/thiếu).
        assert sum(after.values()) == len(untouched), (
            f"Số span còn lại {sum(after.values())} ≠ số Untouched_Object {len(untouched)}"
        )
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_delete_one_image_keeps_other_objects_explicit():
    """3 object (vector + image + vector); xóa ảnh → 2 vector còn nguyên."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, page = _build_pdf(specs)
    try:
        target = ObjMeta(id="obj-1", drawIndex=1, type="image", bbox=_bbox_for(1))
        result = delete_objects(page, [target], pdf)
        assert result.changed is True

        after = _span_signature_counter(page, pdf)
        # Ảnh biến mất.
        assert after[_sig("image", _bbox_for(1))] == 0
        # Hai vector còn nguyên.
        assert after[_sig("vector", _bbox_for(0))] == 1
        assert after[_sig("vector", _bbox_for(2))] == 1
        assert sum(after.values()) == 2
        # XObject ảnh đã được dọn vì không còn tham chiếu.
        assert "Img1" in result.cleaned_resources
    finally:
        pdf.close()


def test_delete_empty_target_keeps_all_objects_explicit():
    """Tập mục tiêu rỗng → no-op; mọi object giữ nguyên."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "image"}]
    pdf, page = _build_pdf(specs)
    try:
        before = _span_signature_counter(page, pdf)
        result = delete_objects(page, [], pdf)
        assert result.changed is False
        after = _span_signature_counter(page, pdf)
        assert after == before
        assert sum(after.values()) == 2
    finally:
        pdf.close()


def test_delete_all_objects_leaves_none_explicit():
    """Xóa toàn bộ → không còn span object nào."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "vector"}]
    pdf, page = _build_pdf(specs)
    try:
        metas = [
            ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0)),
            ObjMeta(id="obj-1", drawIndex=1, type="vector", bbox=_bbox_for(1)),
        ]
        result = delete_objects(page, metas, pdf)
        assert result.changed is True
        after = _span_signature_counter(page, pdf)
        assert sum(after.values()) == 0
    finally:
        pdf.close()
