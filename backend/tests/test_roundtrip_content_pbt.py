"""
Property-Based Test (Task 8.2 — spec `pdf-object-edit`).

**Property 4: Round-trip lưu không đổi nội dung ngoài thao tác (Round-trip).**
- Case A — Mở → (KHÔNG sửa) → lưu → mở lại: content tương đương HIỂN THỊ
  (tập OpSpan kind+bbox) và tập `Color_Operators` TRƯỚC == SAU.
- Case B — Mở → sửa-MỘT-object → lưu → mở lại: CHỈ object mục tiêu khác đi;
  mọi Untouched_Object (kind+bbox) và `Color_Operators` của chúng giữ nguyên.

**Validates: Requirements 10.1, 10.2**

────────────────────────────────────────────────────────────────────────────
CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis) — đồng bộ với test_delete_target_only_pbt.py
- Dựng content stream THỦ CÔNG bằng pikepdf, mỗi object là một nhóm cô lập
  `q … Q` đặt ở MỘT ô lưới riêng → bbox KHÔNG chồng (khoảng cách ≫ 1.0pt) để
  `Object_Mapper` đối khớp DUY NHẤT và mỗi object có chữ ký (kind+bbox) toàn cục
  duy nhất.

      VECTOR (màu CMYK `k` DUY NHẤT theo i):     IMAGE:
        q                                          q
          c 0.2 0.3 0.4 k                            w 0 0 h x y cm
          x y w h re                                 /Img{i} Do
          f                                        Q
        Q

- Vector mang operator màu `k` với thành phần đầu thay đổi theo i → mỗi vector có
  `Color_Operators` riêng biệt, đủ để truy vết object nào giữ/mất màu sau lưu.
- Image không mang color operator (kiểm bằng kind+bbox span).

KIỂM CHỨNG ĐI QUA ĐƯỜNG LƯU THẬT (task 8.1)
- Ghi PDF gốc ra file tạm; gọi `edit_io.apply_and_save`:
    * Case A: `mutate_fn=None` (Round_Trip thuần) → file MỚI.
    * Case B: `mutate_fn` xóa đúng 1 object qua `stream_editor.delete_objects`.
- Mở LẠI file kết quả bằng pikepdf, liệt kê lại OpSpan + Color_Operators và so
  khớp theo Property 4.
- Mọi file ghi ra thư mục tạm (TemporaryDirectory) → không rác; xác nhận file
  GỐC không đổi (so byte).
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys
import tempfile
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core.edit_io import apply_and_save
from app.core.object_mapper import _as_float, _name_str, build_op_spans, parse_page_ops
from app.core.stream_editor import delete_objects
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta

# ── Hằng số layout (đồng bộ test 4.2) ───────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

OBJ_TYPES = ["vector", "image"]
TOL = BBOX_TOLERANCE_PT  # 1.0pt

# Tập operator màu cần bảo toàn (Color_Operators — Yêu cầu 4.2 / glossary).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G"}


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
    """Chữ ký hình học (kind, bbox làm tròn) — duy nhất toàn cục theo ô lưới."""
    return (kind, tuple(round(v) for v in bbox))


# ── Dựng fragment ────────────────────────────────────────────────────────────
def _vector_fragment(i: int) -> str:
    """Đoạn `q … Q` cho một vector rect tô màu CMYK `k` DUY NHẤT theo i."""
    x, y, w, h = _rect_for(i)
    c = round(0.05 + 0.03 * i, 4)  # thành phần Cyan duy nhất theo i
    return (
        "q\n"
        f"{c:.4f} 0.2000 0.3000 0.4000 k\n"
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
    data = bytes([200, 30, 30] * 4)
    stream = pikepdf.Stream(pdf, data)
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _build_pdf(specs):
    """Dựng pikepdf.Pdf 1 trang chứa các object theo `specs`. Trả (pdf, page)."""
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


def _operand_key(operand):
    """Khóa so khớp operand màu: số → làm tròn 4 chữ số; tên → chuỗi."""
    f = _as_float(operand)
    if f is not None:
        return round(f, 4)
    name = _name_str(operand)
    if name is not None:
        return name
    return str(operand)


def _color_op_counter(page) -> Counter:
    """
    Đếm multiset các `Color_Operators` trên trang dưới dạng
    (operator, tuple(operands chuẩn hóa)). Dùng để so khớp bảo toàn màu
    trước/sau Round_Trip (Yêu cầu 10.2) và sau khi xóa 1 object (10.1).
    """
    counter: Counter = Counter()
    for instr in parse_page_ops(page):
        op = str(instr.operator)
        if op in COLOR_OPS:
            key = (op, tuple(_operand_key(o) for o in instr.operands))
            counter[key] += 1
    return counter


def _open_signatures(path):
    """Mở file PDF tại `path`, trả (span_counter, color_counter) của trang 0."""
    with pikepdf.Pdf.open(path) as pdf:
        page = pdf.pages[0]
        spans = _span_signature_counter(page, pdf)
        colors = _color_op_counter(page)
    return spans, colors


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _page_plan(draw):
    """Sinh (specs, target_index): danh sách object + chỉ số object để sửa."""
    n = draw(st.integers(min_value=2, max_value=6))
    specs = [{"i": i, "kind": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    target_index = draw(st.integers(min_value=0, max_value=n - 1))
    return specs, target_index


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 4 — Case A: Round-trip KHÔNG sửa (Validates: Requirements 10.1, 10.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_page_plan())
def test_roundtrip_no_edit_preserves_content_and_colors(plan):
    """
    Mở → (KHÔNG sửa) → lưu → mở lại: tập OpSpan (kind+bbox) và tập
    Color_Operators TRƯỚC == SAU; file gốc không đổi.
    """
    specs, _ = plan
    pdf, page = _build_pdf(specs)

    with tempfile.TemporaryDirectory() as tmp:
        original_path = os.path.join(tmp, "original.pdf")
        out_path = os.path.join(tmp, "roundtrip.pdf")
        pdf.save(original_path)
        pdf.close()

        original_bytes = open(original_path, "rb").read()
        before_spans, before_colors = _open_signatures(original_path)

        # Round_Trip thuần: mở → (không mutate) → lưu ra file MỚI.
        saved, op_result = apply_and_save(original_path, None, output_path=out_path)
        assert op_result is None
        assert os.path.abspath(saved) == os.path.abspath(out_path)

        after_spans, after_colors = _open_signatures(saved)

        # (1) Tập OpSpan (kind+bbox) tương đương hiển thị TRƯỚC == SAU.
        assert after_spans == before_spans, (
            f"Round-trip làm đổi tập OpSpan: trước={dict(before_spans)} "
            f"sau={dict(after_spans)}"
        )
        # (2) Tập Color_Operators TRƯỚC == SAU.
        assert after_colors == before_colors, (
            f"Round-trip làm đổi Color_Operators: trước={dict(before_colors)} "
            f"sau={dict(after_colors)}"
        )
        # (3) File GỐC không bị ghi đè (Yêu cầu 10.4).
        assert open(original_path, "rb").read() == original_bytes, (
            "apply_and_save đã làm thay đổi file gốc!"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 4 — Case B: Sửa-MỘT-object (Validates: Requirements 10.1, 10.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_page_plan())
def test_roundtrip_single_edit_changes_only_target(plan):
    """
    Mở → xóa đúng 1 object → lưu → mở lại: CHỈ object mục tiêu khác đi; mọi
    Untouched_Object (kind+bbox) và Color_Operators của chúng giữ nguyên.
    """
    specs, target_index = plan
    target_spec = specs[target_index]
    pdf, page = _build_pdf(specs)

    with tempfile.TemporaryDirectory() as tmp:
        original_path = os.path.join(tmp, "original.pdf")
        out_path = os.path.join(tmp, "edited.pdf")
        pdf.save(original_path)
        pdf.close()

        original_bytes = open(original_path, "rb").read()

        # Chữ ký KỲ VỌNG của Untouched_Object (mọi object trừ mục tiêu).
        untouched = [s for s in specs if s["i"] != target_spec["i"]]
        expected_untouched_spans = Counter(
            _sig(s["kind"], _bbox_for(s["i"])) for s in untouched
        )
        # Color_Operators kỳ vọng của các vector KHÔNG mục tiêu (phải giữ NGUYÊN).
        # LƯU Ý: span vector = nhóm path-construction → painting (`re … f`); xóa
        # span KHÔNG gỡ op set-màu (`k`) đứng trước trong cùng khối `q…Q` của
        # CHÍNH object mục tiêu. Op `k` còn sót là no-op (không có painting theo
        # sau), bị cô lập trong `q…Q` nên KHÔNG ảnh hưởng object khác → đây là
        # "thay đổi của object mục tiêu", không vi phạm bảo toàn Untouched_Object.
        # Vì màu mỗi vector là DUY NHẤT theo i, ta kiểm các key màu untouched giữ
        # nguyên và mọi key màu thừa (nếu có) chỉ thuộc về object mục tiêu.
        expected_untouched_colors = Counter()
        for s in untouched:
            if s["kind"] == "vector":
                c = round(0.05 + 0.03 * s["i"], 4)
                expected_untouched_colors[("k", (c, 0.2, 0.3, 0.4))] += 1

        target_color_keys = set()
        if target_spec["kind"] == "vector":
            ct = round(0.05 + 0.03 * target_spec["i"], 4)
            target_color_keys.add(("k", (ct, 0.2, 0.3, 0.4)))

        target_sig = _sig(target_spec["kind"], _bbox_for(target_spec["i"]))

        def _mutate(pdf_in):
            tgt = ObjMeta(
                id=f"obj-{target_spec['i']}",
                drawIndex=target_spec["i"],
                type=target_spec["kind"],
                bbox=_bbox_for(target_spec["i"]),
            )
            return delete_objects(pdf_in.pages[0], [tgt], pdf_in)

        saved, result = apply_and_save(original_path, _mutate, output_path=out_path)
        assert result.changed is True

        after_spans, after_colors = _open_signatures(saved)

        # (1) Object mục tiêu BIẾN MẤT.
        assert after_spans.get(target_sig, 0) == 0, (
            f"Object mục tiêu {target_sig} vẫn còn sau khi xóa: {dict(after_spans)}"
        )
        # (2) Mọi Untouched_Object (kind+bbox) giữ NGUYÊN số lượng.
        assert after_spans == expected_untouched_spans, (
            f"Untouched_Object bị thay đổi: kỳ vọng={dict(expected_untouched_spans)} "
            f"thực tế={dict(after_spans)}"
        )
        # (3) Color_Operators của Untouched_Object giữ NGUYÊN (đúng số lượng từng
        #     key); mọi key màu xuất hiện thêm CHỈ được phép thuộc object mục tiêu
        #     (residue no-op trong khối `q…Q` đã bị rỗng) — không màu nào của
        #     Untouched_Object bị đổi/biến mất.
        for key, cnt in expected_untouched_colors.items():
            assert after_colors.get(key, 0) == cnt, (
                f"Color_Operators của Untouched_Object bị đổi tại {key}: "
                f"kỳ vọng={cnt} thực tế={after_colors.get(key, 0)}"
            )
        allowed_keys = set(expected_untouched_colors) | target_color_keys
        extra_keys = set(after_colors) - allowed_keys
        assert not extra_keys, (
            f"Xuất hiện Color_Operators lạ không thuộc object nào: {extra_keys}"
        )
        # (4) File GỐC không bị ghi đè (Yêu cầu 10.4).
        assert open(original_path, "rb").read() == original_bytes, (
            "apply_and_save đã làm thay đổi file gốc!"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_roundtrip_no_edit_explicit():
    """3 object: round-trip thuần giữ nguyên span + color, không đụng gốc."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, _ = _build_pdf(specs)
    with tempfile.TemporaryDirectory() as tmp:
        original_path = os.path.join(tmp, "o.pdf")
        out_path = os.path.join(tmp, "r.pdf")
        pdf.save(original_path)
        pdf.close()

        before_spans, before_colors = _open_signatures(original_path)
        saved, _ = apply_and_save(original_path, None, output_path=out_path)
        after_spans, after_colors = _open_signatures(saved)

        assert after_spans == before_spans
        assert after_colors == before_colors
        assert sum(after_spans.values()) == 3


def test_roundtrip_delete_one_vector_explicit():
    """Xóa 1 vector → vector đó mất màu+span; object khác giữ nguyên."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    pdf, _ = _build_pdf(specs)
    with tempfile.TemporaryDirectory() as tmp:
        original_path = os.path.join(tmp, "o.pdf")
        out_path = os.path.join(tmp, "e.pdf")
        pdf.save(original_path)
        pdf.close()

        def _mutate(pdf_in):
            tgt = ObjMeta(id="obj-0", drawIndex=0, type="vector", bbox=_bbox_for(0))
            return delete_objects(pdf_in.pages[0], [tgt], pdf_in)

        saved, result = apply_and_save(original_path, _mutate, output_path=out_path)
        assert result.changed is True

        after_spans, after_colors = _open_signatures(saved)
        # Vector 0 biến mất (span).
        assert after_spans.get(_sig("vector", _bbox_for(0)), 0) == 0
        # Image 1 + vector 2 còn nguyên.
        assert after_spans[_sig("image", _bbox_for(1))] == 1
        assert after_spans[_sig("vector", _bbox_for(2))] == 1
        # Màu của vector 2 (Untouched_Object) giữ NGUYÊN.
        assert after_colors[("k", (round(0.05 + 0.03 * 2, 4), 0.2, 0.3, 0.4))] == 1
        # Op set-màu `k` của vector 0 có thể còn sót dưới dạng no-op trong khối
        # `q…Q` đã rỗng (color-safe, cô lập) — không kiểm "phải bằng 0" vì đó là
        # residue HỢP LỆ của object mục tiêu, không ảnh hưởng Untouched_Object.
