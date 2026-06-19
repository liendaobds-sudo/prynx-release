"""
Property-Based Test (Task 5.5 — spec `pdf-object-edit`).

**Property 6: Rotate khả nghịch (Round-trip).**
Xoay một object góc `θ` rồi xoay tiếp `-θ` quanh CÙNG tâm → BBox kết quả TRÙNG
BBox ban đầu trong tolerance ≤ 1.0 point mỗi cạnh. Các `Untouched_Object` giữ
NGUYÊN vị trí qua cả hai lần xoay.

**Validates: Requirements 7.2**

────────────────────────────────────────────────────────────────────────────
CÁCH KIỂM (option (a) — round-trip THỰC TẾ qua engine)
- `rotate_objects` dựng `cm = T(c)·rot(θ)·T(-c)` với `c` = tâm bbox của span TẠI
  THỜI ĐIỂM gọi, rồi BỌC CÔ LẬP `q/cm/Q` quanh span.
- Bất biến hình học mấu chốt: xoay một hình quanh tâm bbox của nó giữ NGUYÊN tâm
  bbox (axis-aligned bbox của hình đã xoay vẫn đối xứng quanh cùng tâm). Vì vậy
  sau lần xoay `θ`, dù bbox (bao trục) có TO RA, TÂM của nó vẫn là tâm ban đầu
  `c0`. Khi gọi lần hai với `-θ`, engine tính lại tâm từ bbox hiện tại = `c0`
  → xoay `-θ` quanh ĐÚNG `c0` → khử trọn phép xoay đầu → bbox trở về ban đầu.
- Do đó áp `rotate_objects(θ)` rồi `rotate_objects(-θ)` qua chính engine và so
  bbox cuối với bbox đầu là kiểm "khả nghịch" đúng tinh thần Property 6.

CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis) — tái dùng layout của Property 2
- Dùng pikepdf dựng content stream THỦ CÔNG; mỗi object là một nhóm cô lập
  `q … Q` (VECTOR: `re`+`f`; IMAGE: `cm`+`Do`). Mỗi object ở MỘT ô lưới riêng
  (CELL=150) → bbox KHÔNG chồng nhau (kể cả khi bbox to ra sau khi xoay: rect
  40×30 có đường chéo ≤ 50pt ≪ 150pt) → `map_object` đối khớp DUY NHẤT.
- CHỈ dùng IMAGE/VECTOR (bbox CHÍNH XÁC từ CTM/`re`), KHÔNG dùng text (bbox text
  ở task 3.1 chỉ là ước lượng → dễ flaky).
- Hypothesis chọn ngẫu nhiên loại mỗi object, tập con để XOAY, và góc `θ` trong
  khoảng −180..180 độ.

KIỂM CHỨNG (qua `build_op_spans` — in-memory, không cần PDFium ghi)
- Tâm bbox được bảo toàn nên mọi object được đối khớp theo (kind, tâm ≈ c0_i).
- Sau khi xoay `θ`: đọc bbox B1 của từng object mục tiêu (tâm vẫn ≈ c0_i), dựng
  lại `ObjMeta(bbox=B1)` cho lần xoay `-θ` (để `map_object` khớp đúng span đã to ra).
- Sau khi xoay `-θ`: bbox cuối của từng object mục tiêu ≈ bbox ban đầu B0 trong
  tolerance ≤ 1.0pt mỗi cạnh; mỗi `Untouched_Object` giữ nguyên bbox.
────────────────────────────────────────────────────────────────────────────
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.object_mapper import build_op_spans
from app.core.stream_editor import rotate_objects
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta, bbox_within_tolerance

# ── Hằng số layout (đồng bộ test Property 2) ─────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

OBJ_TYPES = ["vector", "image"]
TOL = BBOX_TOLERANCE_PT  # 1.0pt
# Tâm bbox được bảo toàn tuyệt đối (chỉ sai số float) → ngưỡng khớp tâm chặt,
# nhưng vẫn ≪ khoảng cách giữa hai ô lưới (150pt) nên không nhầm object.
CENTER_TOL = 0.5


def _rect_for(i: int):
    """(x, y, w, h) cho object thứ i tại một ô lưới KHÔNG chồng nhau."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    """BBox ban đầu [x0, y0, x1, y1] của object thứ i (TRƯỚC xoay)."""
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _center_for(i: int):
    """Tâm bbox (cx, cy) của object thứ i — BẤT BIẾN qua phép xoay quanh tâm."""
    x, y, w, h = _rect_for(i)
    return x + w / 2.0, y + h / 2.0


def _bbox_center(bbox):
    return (bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0


# ── Dựng PDF từ specs (đồng bộ test Property 2) ──────────────────────────────
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


def _bbox_by_center(spans, kind, cx, cy):
    """
    Tìm bbox của span (kind khớp + tâm ≈ (cx, cy) trong CENTER_TOL). Trả None
    nếu không có. Tâm bbox bất biến qua phép xoay quanh tâm → định danh ổn định.
    """
    for k, bbox in spans:
        if k != kind:
            continue
        bx, by = _bbox_center(bbox)
        if abs(bx - cx) <= CENTER_TOL and abs(by - cy) <= CENTER_TOL:
            return bbox
    return None


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _rotate_plan(draw):
    """
    Sinh (specs, target_flags, theta):
      - specs       : danh sách object (kind ngẫu nhiên),
      - target_flags: cờ "có xoay" cho từng object (CÙNG góc cho mọi target),
      - theta       : góc xoay (độ) trong [-180, 180].
    """
    n = draw(st.integers(min_value=2, max_value=6))
    specs = [{"i": i, "kind": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    target_flags = [draw(st.booleans()) for _ in range(n)]
    theta = draw(
        st.floats(min_value=-180.0, max_value=180.0, allow_nan=False, allow_infinity=False)
    )
    return specs, target_flags, theta


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 6 — Rotate khả nghịch (Validates: Requirements 7.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_rotate_plan())
def test_rotate_is_invertible(plan):
    """
    Với mọi tập object được xoay `θ` rồi `-θ` quanh CÙNG tâm:
      - bbox cuối của object mục tiêu ≈ bbox ban đầu (tolerance ≤ 1.0pt mỗi cạnh).
      - Untouched_Object giữ nguyên bbox qua cả hai lần xoay.
    """
    specs, target_flags, theta = plan
    pdf, page = _build_pdf(specs)

    try:
        targets = [s for s, flag in zip(specs, target_flags) if flag]
        untouched = [s for s, flag in zip(specs, target_flags) if not flag]

        # ── Tiền đề: stream gốc chứa đúng span của MỌI object ──────────────────
        before = _spans_of(page, pdf)
        assert len(before) == len(specs), (
            f"Tiền đề sai: tổng span gốc {len(before)} ≠ số object {len(specs)}"
        )

        # ── Lần xoay 1: +θ quanh tâm bbox của từng object mục tiêu ─────────────
        metas_fwd = [
            ObjMeta(id=f"obj-{s['i']}", drawIndex=s["i"], type=s["kind"], bbox=_bbox_for(s["i"]))
            for s in targets
        ]
        res_fwd = rotate_objects(page, metas_fwd, theta, pdf)
        assert res_fwd.changed is bool(targets)

        # Sau lần 1: tâm bbox vẫn là c0 (bất biến) → đọc B1 theo tâm để dựng meta
        # cho lần xoay nghịch (span đã to ra, cần bbox mới để map_object khớp).
        mid = _spans_of(page, pdf)
        assert len(mid) == len(specs), (
            f"Tổng span sau xoay θ {len(mid)} ≠ số object {len(specs)}"
        )

        metas_bwd = []
        for s in targets:
            cx, cy = _center_for(s["i"])
            b1 = _bbox_by_center(mid, s["kind"], cx, cy)
            assert b1 is not None, (
                f"Sau xoay θ, không tìm thấy span obj-{s['i']} ({s['kind']}) "
                f"có tâm ≈ ({cx:.3f}, {cy:.3f}); span hiện có: {mid}"
            )
            metas_bwd.append(
                ObjMeta(id=f"obj-{s['i']}", drawIndex=s["i"], type=s["kind"], bbox=b1)
            )

        # Untouched_Object phải giữ nguyên bbox NGAY sau lần xoay 1.
        for s in untouched:
            cx, cy = _center_for(s["i"])
            b_mid = _bbox_by_center(mid, s["kind"], cx, cy)
            assert b_mid is not None and bbox_within_tolerance(b_mid, _bbox_for(s["i"]), TOL), (
                f"Untouched_Object obj-{s['i']} ({s['kind']}) bị đổi sau xoay θ: "
                f"kỳ vọng ≈ {_bbox_for(s['i'])}, nhận {b_mid}"
            )

        # ── Lần xoay 2: −θ quanh CÙNG tâm (engine tính lại tâm = c0) ───────────
        res_bwd = rotate_objects(page, metas_bwd, -theta, pdf)
        assert res_bwd.changed is bool(targets)

        # ── PROPERTY ───────────────────────────────────────────────────────────
        after = _spans_of(page, pdf)
        assert len(after) == len(specs), (
            f"Tổng span sau round-trip {len(after)} ≠ số object {len(specs)}"
        )

        # (1) Object mục tiêu: bbox cuối ≈ bbox ban đầu B0 (khả nghịch).
        for s in targets:
            cx, cy = _center_for(s["i"])
            b_final = _bbox_by_center(after, s["kind"], cx, cy)
            expected = _bbox_for(s["i"])
            assert b_final is not None and bbox_within_tolerance(b_final, expected, TOL), (
                f"Object obj-{s['i']} ({s['kind']}) KHÔNG khả nghịch sau xoay "
                f"θ={theta:.3f}° rồi −θ: kỳ vọng bbox≈{expected} trong tolerance "
                f"≤ {TOL}pt, nhận {b_final}"
            )

        # (2) Untouched_Object: bbox giữ nguyên qua cả round-trip.
        for s in untouched:
            cx, cy = _center_for(s["i"])
            b_final = _bbox_by_center(after, s["kind"], cx, cy)
            expected = _bbox_for(s["i"])
            assert b_final is not None and bbox_within_tolerance(b_final, expected, TOL), (
                f"Untouched_Object obj-{s['i']} ({s['kind']}) bị đổi vị trí: "
                f"kỳ vọng bbox≈{expected}, nhận {b_final}"
            )
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_rotate_single_vector_roundtrip_explicit():
    """Xoay 1 vector 37° rồi −37°; bbox trở về ban đầu, object khác nguyên."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, page = _build_pdf(specs)
    try:
        theta = 37.0
        meta = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0))
        r1 = rotate_objects(page, [meta], theta, pdf)
        assert r1.changed is True and r1.wrapped_count == 1

        cx, cy = _center_for(0)
        b1 = _bbox_by_center(_spans_of(page, pdf), "vector", cx, cy)
        assert b1 is not None
        # Sau xoay 37°, bbox của rect KHÔNG-vuông phải TO RA (đường chéo lớn hơn cạnh).
        assert (b1[2] - b1[0]) > RECT_W - TOL

        meta_back = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=b1)
        r2 = rotate_objects(page, [meta_back], -theta, pdf)
        assert r2.changed is True

        after = _spans_of(page, pdf)
        b_final = _bbox_by_center(after, "vector", cx, cy)
        assert b_final is not None and bbox_within_tolerance(b_final, _bbox_for(0), TOL)
        # Object khác giữ nguyên.
        assert bbox_within_tolerance(
            _bbox_by_center(after, "image", *_center_for(1)), _bbox_for(1), TOL
        )
        assert bbox_within_tolerance(
            _bbox_by_center(after, "vector", *_center_for(2)), _bbox_for(2), TOL
        )
    finally:
        pdf.close()


def test_rotate_single_image_roundtrip_explicit():
    """Xoay 1 ảnh 90° rồi −90°; bbox trở về ban đầu (khả nghịch cho IMAGE)."""
    specs = [{"i": 0, "kind": "image"}, {"i": 1, "kind": "vector"}]
    pdf, page = _build_pdf(specs)
    try:
        theta = 90.0
        meta = ObjMeta(id="obj-0", drawIndex=0, type="image", bbox=_bbox_for(0))
        rotate_objects(page, [meta], theta, pdf)

        cx, cy = _center_for(0)
        b1 = _bbox_by_center(_spans_of(page, pdf), "image", cx, cy)
        assert b1 is not None
        meta_back = ObjMeta(id="obj-0", drawIndex=0, type="image", bbox=b1)
        rotate_objects(page, [meta_back], -theta, pdf)

        after = _spans_of(page, pdf)
        b_final = _bbox_by_center(after, "image", cx, cy)
        assert b_final is not None and bbox_within_tolerance(b_final, _bbox_for(0), TOL)
        assert bbox_within_tolerance(
            _bbox_by_center(after, "vector", *_center_for(1)), _bbox_for(1), TOL
        )
    finally:
        pdf.close()


def test_rotate_empty_target_is_noop_explicit():
    """Tập mục tiêu rỗng → no-op; mọi object giữ nguyên vị trí."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "image"}]
    pdf, page = _build_pdf(specs)
    try:
        before = _spans_of(page, pdf)
        result = rotate_objects(page, [], 45.0, pdf)
        assert result.changed is False
        after = _spans_of(page, pdf)
        assert len(after) == len(before)
        for kind, bbox in before:
            cx, cy = _bbox_center(bbox)
            assert bbox_within_tolerance(_bbox_by_center(after, kind, cx, cy), bbox, TOL)
    finally:
        pdf.close()


def test_rotate_full_turn_roundtrip_explicit():
    """Xoay 180° rồi −180° quanh tâm trả về bbox ban đầu (sanity góc lớn)."""
    specs = [{"i": 0, "kind": "vector"}]
    pdf, page = _build_pdf(specs)
    try:
        theta = 180.0
        meta = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0))
        rotate_objects(page, [meta], theta, pdf)
        cx, cy = _center_for(0)
        b1 = _bbox_by_center(_spans_of(page, pdf), "vector", cx, cy)
        meta_back = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=b1)
        rotate_objects(page, [meta_back], -theta, pdf)
        after = _spans_of(page, pdf)
        assert bbox_within_tolerance(
            _bbox_by_center(after, "vector", cx, cy), _bbox_for(0), TOL
        )
    finally:
        pdf.close()
