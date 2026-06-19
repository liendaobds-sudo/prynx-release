"""
Property-Based Test (Task 5.2 — spec `pdf-object-edit`).

**Property 2: Move = dịch bbox (Metamorphic).**
Sau khi di chuyển một object một đoạn `(dx, dy)`, BBox MỚI của object đó bằng
BBox CŨ cộng `(dx, dy)` trên mỗi tọa độ (mỗi cạnh dịch đúng độ), với sai số
≤ 1.0 point mỗi cạnh. Các `Untouched_Object` giữ NGUYÊN vị trí.

**Validates: Requirements 5.2**

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
  để `Object_Mapper.map_object` đối khớp DUY NHẤT (không kích hoạt fallback 4.7).
- Theo lưu ý của task: CHỈ dùng IMAGE/VECTOR (bbox CHÍNH XÁC từ CTM/`re`), KHÔNG
  dùng text (bbox text ở task 3.1 chỉ là ước lượng → dễ flaky).
- Hypothesis chọn ngẫu nhiên loại mỗi object, tập con để DI CHUYỂN, và độ dịch
  `(dx, dy)` trong khoảng vừa phải (|d| ≤ 40pt) — đủ nhỏ so với bước lưới (150pt)
  để object sau move KHÔNG va vào ô của object khác.

KIỂM CHỨNG (qua `build_op_spans` — in-memory, không cần PDFium ghi)
- `move_objects` bọc cô lập `q/cm/Q` quanh span; `build_op_spans` tính lại bbox
  theo CTM mới nên bbox span SAU move phản ánh đúng phép tịnh tiến.
- Áp `move_objects(page, metas, dx, dy, pdf, coord_space="pdf")` (cùng `(dx,dy)`
  cho TẤT CẢ object được chọn — kiểm cả Yêu cầu 5.5).
- Property: đọc lại span và yêu cầu:
    1. Mỗi object MỤC TIÊU có một span cùng `kind`, bbox ≈ bbox_cũ + (dx,dy)
       trong tolerance ≤ 1.0pt mỗi cạnh.
    2. Mỗi `Untouched_Object` có một span cùng `kind`, bbox ≈ bbox_cũ.
    3. Tổng số span = số object (không thừa/thiếu).
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.object_mapper import build_op_spans
from app.core.stream_editor import move_objects
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta, bbox_within_tolerance

# ── Hằng số layout ──────────────────────────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0
MAX_SHIFT = 40.0  # |dx|,|dy| ≤ 40pt ≪ bước lưới 150pt → không va ô khác.

OBJ_TYPES = ["vector", "image"]
TOL = BBOX_TOLERANCE_PT  # 1.0pt


def _rect_for(i: int):
    """(x, y, w, h) cho object thứ i tại một ô lưới KHÔNG chồng nhau."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    """BBox kỳ vọng [x0, y0, x1, y1] của object thứ i (TRƯỚC move)."""
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _shift_bbox(bbox, dx: float, dy: float):
    """BBox sau khi tịnh tiến (dx, dy) trong hệ PDF (y hướng LÊN)."""
    return [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy]


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


def _spans_of(page, pdf):
    """Danh sách (kind, bbox) của các OpSpan vector/image trên trang."""
    return [
        (span.kind, list(span.bbox))
        for span in build_op_spans(page, pdf=pdf)
        if span.kind in ("vector", "image")
    ]


def _match_and_consume(actual_spans, kind, expected_bbox) -> bool:
    """
    Tìm trong `actual_spans` một span (kind khớp + bbox ≈ expected_bbox trong
    tolerance ≤ 1.0pt mỗi cạnh) rồi loại nó khỏi danh sách. Trả True nếu khớp.
    """
    for idx, (k, bbox) in enumerate(actual_spans):
        if k == kind and bbox_within_tolerance(bbox, expected_bbox, TOL):
            actual_spans.pop(idx)
            return True
    return False


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _move_plan(draw):
    """
    Sinh (specs, target_flags, dx, dy):
      - specs       : danh sách object (kind ngẫu nhiên),
      - target_flags: cờ "có di chuyển" cho từng object,
      - dx, dy      : độ dịch (cùng cho mọi object được chọn — Yêu cầu 5.5).
    """
    n = draw(st.integers(min_value=2, max_value=8))
    specs = [{"i": i, "kind": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    target_flags = [draw(st.booleans()) for _ in range(n)]
    dx = draw(
        st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT, allow_nan=False, allow_infinity=False)
    )
    dy = draw(
        st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT, allow_nan=False, allow_infinity=False)
    )
    return specs, target_flags, dx, dy


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 2 — Move = dịch bbox (Validates: Requirements 5.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_move_plan())
def test_move_translates_bbox(plan):
    """
    Với mọi tập object được di chuyển cùng `(dx, dy)`:
      - bbox object mục tiêu = bbox cũ + (dx, dy) (tolerance ≤ 1.0pt mỗi cạnh).
      - Untouched_Object giữ nguyên bbox.
    """
    specs, target_flags, dx, dy = plan
    pdf, page = _build_pdf(specs)

    try:
        targets = [s for s, flag in zip(specs, target_flags) if flag]
        untouched = [s for s, flag in zip(specs, target_flags) if not flag]

        # ── Tiền đề: stream gốc chứa đúng span của MỌI object ──────────────────
        before = _spans_of(page, pdf)
        assert len(before) == len(specs), (
            f"Tiền đề sai: tổng span gốc {len(before)} ≠ số object {len(specs)}"
        )

        # ── Di chuyển tập mục tiêu qua Stream_Editor (đường ghi pikepdf duy nhất)
        target_metas = [
            ObjMeta(
                id=f"obj-{s['i']}",
                drawIndex=s["i"],
                type=s["kind"],
                bbox=_bbox_for(s["i"]),
            )
            for s in targets
        ]
        result = move_objects(page, target_metas, dx, dy, pdf, coord_space="pdf")

        # Có target → phải thay đổi; không target → no-op.
        assert result.changed is bool(targets)

        # ── PROPERTY ───────────────────────────────────────────────────────────
        after = _spans_of(page, pdf)
        assert len(after) == len(specs), (
            f"Tổng span sau move {len(after)} ≠ số object {len(specs)}"
        )

        # (1) Mỗi object mục tiêu: bbox_mới ≈ bbox_cũ + (dx, dy).
        for s in targets:
            expected = _shift_bbox(_bbox_for(s["i"]), dx, dy)
            assert _match_and_consume(after, s["kind"], expected), (
                f"Object mục tiêu obj-{s['i']} ({s['kind']}) không dịch đúng: "
                f"kỳ vọng bbox≈{expected} (dx={dx:.3f}, dy={dy:.3f}) "
                f"trong tolerance ≤ {TOL}pt; span còn lại: {after}"
            )

        # (2) Mỗi Untouched_Object: bbox giữ nguyên.
        for s in untouched:
            expected = _bbox_for(s["i"])
            assert _match_and_consume(after, s["kind"], expected), (
                f"Untouched_Object obj-{s['i']} ({s['kind']}) bị đổi vị trí: "
                f"kỳ vọng bbox≈{expected}; span còn lại: {after}"
            )

        # (3) Không còn span thừa nào chưa được giải thích.
        assert not after, f"Còn span không khớp object nào sau move: {after}"
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_move_single_vector_shifts_bbox_explicit():
    """Di chuyển 1 vector (dx=25, dy=-15); bbox dịch đúng, object khác nguyên."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, page = _build_pdf(specs)
    try:
        dx, dy = 25.0, -15.0
        meta = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0))
        result = move_objects(page, [meta], dx, dy, pdf, coord_space="pdf")
        assert result.changed is True
        assert result.wrapped_count == 1

        after = _spans_of(page, pdf)
        # Vector 0 đã dịch.
        assert _match_and_consume(after, "vector", _shift_bbox(_bbox_for(0), dx, dy))
        # Image 1 và vector 2 giữ nguyên.
        assert _match_and_consume(after, "image", _bbox_for(1))
        assert _match_and_consume(after, "vector", _bbox_for(2))
        assert not after
    finally:
        pdf.close()


def test_move_multiple_objects_same_delta_explicit():
    """Di chuyển 2 object cùng (dx, dy) trong một thao tác (Yêu cầu 5.5)."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, page = _build_pdf(specs)
    try:
        dx, dy = -20.0, 30.0
        metas = [
            ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0)),
            ObjMeta(id="obj-1", drawIndex=1, type="image", bbox=_bbox_for(1)),
        ]
        result = move_objects(page, metas, dx, dy, pdf, coord_space="pdf")
        assert result.changed is True
        assert result.wrapped_count == 2

        after = _spans_of(page, pdf)
        # Hai object mục tiêu dịch cùng (dx, dy).
        assert _match_and_consume(after, "vector", _shift_bbox(_bbox_for(0), dx, dy))
        assert _match_and_consume(after, "image", _shift_bbox(_bbox_for(1), dx, dy))
        # Object còn lại nguyên.
        assert _match_and_consume(after, "vector", _bbox_for(2))
        assert not after
    finally:
        pdf.close()


def test_move_empty_target_is_noop_explicit():
    """Tập mục tiêu rỗng → no-op; mọi object giữ nguyên vị trí."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "image"}]
    pdf, page = _build_pdf(specs)
    try:
        before = _spans_of(page, pdf)
        result = move_objects(page, [], 10.0, 10.0, pdf, coord_space="pdf")
        assert result.changed is False
        after = _spans_of(page, pdf)
        assert len(after) == len(before)
        for kind, bbox in before:
            assert _match_and_consume(after, kind, bbox)
        assert not after
    finally:
        pdf.close()
