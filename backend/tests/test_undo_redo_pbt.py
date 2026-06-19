"""
Property-Based Test (Task 11.2 — spec `pdf-object-edit`).

**Property 7: Undo/Redo idempotent theo cặp (Round-trip).**
Undo rồi Redo MỘT thao tác cho trạng thái `Working_File` TƯƠNG ĐƯƠNG trạng thái
SAU thao tác ban đầu — tập (kind, bbox) của các `OpSpan` và tập `Color_Operators`
được GIỮ NGUYÊN (tolerance bbox ≤ 1.0pt).

**Validates: Requirements 11.4**

────────────────────────────────────────────────────────────────────────────
PHẠM VI — Undo/Redo ở MỨC MÔ HÌNH BACKEND
Undo/Redo thực tế là cơ chế FRONTEND (history stack qua `commitWorkingFile`):
Undo = chọn lại file Working_File TRƯỚC thao tác; Redo = áp LẠI cùng thao tác.
PBT này KHÔNG kiểm UI; nó kiểm tính ĐỊNH-TÍNH/idempotent của chu trình ở mức
engine: áp LẠI CÙNG một thao tác trên CÙNG trạng thái trước đó phải cho kết quả
TƯƠNG ĐƯƠNG trạng thái-sau-thao-tác ban đầu.

Mô phỏng undo/redo bằng các file Working_File qua `edit_io.apply_and_save`:
  1. file0 = trạng thái gốc (lưu ra đĩa).
  2. file1 = apply_and_save(file0, op)        → trạng thái SAU thao tác.
  3. "Undo": quay về file0 (history stack giữ file0 — chỉ là chọn lại file0).
  4. "Redo": file2 = apply_and_save(file0, op) → áp LẠI cùng op trên file0.
  5. PROPERTY: trạng thái file2 TƯƠNG ĐƯƠNG file1 — so tập (kind, bbox) của các
     OpSpan + tập Color_Operators của file2 == file1 (tolerance bbox ≤ 1.0pt).

CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis) — đồng bộ các PBT khác của spec
- Dựng content stream THỦ CÔNG bằng pikepdf; mỗi object là một nhóm cô lập
  `q … Q` đặt ở MỘT ô lưới riêng (CELL=150) → bbox KHÔNG chồng nhau (kể cả khi
  to ra sau rotate/resize: rect 40×30, đường chéo ≤ 50pt, scale ≤ 2× ≤ 80pt ≪
  150pt) → `Object_Mapper.map_object` đối khớp DUY NHẤT (không fallback 4.7).
- VECTOR mang màu CMYK `k` DUY NHẤT theo i → kiểm bảo toàn `Color_Operators`.
  IMAGE đặt qua `cm`+`Do` (không mang color op) → đa dạng loại object.
- Sinh ngẫu nhiên MỘT thao tác op ∈ {move, delete, rotate, resize} trên 1 object.

KIỂM CHỨNG (venv backend) — round-trip QUA FILE THẬT
- Ghi file0 ra thư mục tạm; áp op hai lần qua `apply_and_save` (file1, file2).
- Mở lại file1 & file2 bằng pikepdf; trích chữ ký (kind, bbox) OpSpan +
  multiset Color_Operators; yêu cầu file2 == file1.
- Xác nhận file GỐC (file0) KHÔNG đổi (so byte) qua cả hai lần áp.
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
from app.core.stream_editor import (
    delete_objects,
    move_objects,
    resize_objects,
    rotate_objects,
)
from app.schemas.edit import BBOX_TOLERANCE_PT, ObjMeta

# ── Hằng số layout (đồng bộ test Property 2 / 4 / 6) ─────────────────────────
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

# Giới hạn tham số thao tác để object KHÔNG va sang ô lưới khác.
MAX_SHIFT = 30.0   # |dx|,|dy| ≤ 30pt ≪ bước lưới 150pt.
MIN_SCALE = 0.5
MAX_SCALE = 2.0    # 40×30 × 2 = 80×60 ≪ 150pt.


def _rect_for(i: int):
    """(x, y, w, h) cho object thứ i tại một ô lưới KHÔNG chồng nhau."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    """BBox ban đầu [x0, y0, x1, y1] của object thứ i."""
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _sig(kind: str, bbox) -> tuple:
    """Chữ ký hình học (kind, bbox làm tròn) — tolerance ≤ 0.5pt ⊂ 1.0pt."""
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


# ── Trích chữ ký trạng thái (span + color) ───────────────────────────────────
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
    """Đếm multiset các `Color_Operators` (op, operands chuẩn hóa) trên trang."""
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


# ── Áp một thao tác EditOp lên pdf đang mở (mô phỏng FE → BE) ─────────────────
def _apply_op(pdf: pikepdf.Pdf, op: dict):
    """
    Áp thao tác `op` lên trang 0 của `pdf` (in-place) qua stream_editor.

    `op` = {"kind": ..., "i": <chỉ số object mục tiêu>, "kind_obj": <loại object>,
            + tham số theo kind}. Trả kết quả của stream_editor.
    """
    page = pdf.pages[0]
    meta = ObjMeta(
        id=f"obj-{op['i']}",
        drawIndex=op["i"],
        type=op["kind_obj"],
        bbox=_bbox_for(op["i"]),
    )
    kind = op["kind"]
    if kind == "delete":
        return delete_objects(page, [meta], pdf)
    if kind == "move":
        return move_objects(page, [meta], op["dx"], op["dy"], pdf, coord_space="pdf")
    if kind == "resize":
        return resize_objects(page, [meta], op["sx"], op["sy"], op["anchor"], pdf)
    if kind == "rotate":
        return rotate_objects(page, [meta], op["theta"], pdf)
    raise AssertionError(f"kind không hỗ trợ: {kind}")


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _undo_redo_plan(draw):
    """
    Sinh (specs, op): danh sách object + MỘT thao tác ngẫu nhiên trên 1 object.

    op gồm kind ∈ {move, delete, rotate, resize} cùng tham số ràng buộc để object
    không va sang ô lưới khác (giữ map_object đối khớp DUY NHẤT).
    """
    n = draw(st.integers(min_value=2, max_value=6))
    specs = [{"i": i, "kind": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    target_index = draw(st.integers(min_value=0, max_value=n - 1))
    target = specs[target_index]

    kind = draw(st.sampled_from(["move", "delete", "rotate", "resize"]))
    op = {"kind": kind, "i": target["i"], "kind_obj": target["kind"]}
    if kind == "move":
        op["dx"] = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                                  allow_nan=False, allow_infinity=False))
        op["dy"] = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                                  allow_nan=False, allow_infinity=False))
    elif kind == "resize":
        op["sx"] = draw(st.floats(min_value=MIN_SCALE, max_value=MAX_SCALE,
                                  allow_nan=False, allow_infinity=False))
        op["sy"] = draw(st.floats(min_value=MIN_SCALE, max_value=MAX_SCALE,
                                  allow_nan=False, allow_infinity=False))
        op["anchor"] = draw(st.sampled_from(["nw", "ne", "sw", "se"]))
    elif kind == "rotate":
        op["theta"] = draw(st.floats(min_value=-180.0, max_value=180.0,
                                     allow_nan=False, allow_infinity=False))
    return specs, op


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 7 — Undo/Redo idempotent theo cặp (Validates: Requirements 11.4)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_undo_redo_plan())
def test_undo_redo_is_idempotent_per_pair(plan):
    """
    Mô phỏng chu trình undo→redo ở MỨC MÔ HÌNH:
      file1 = áp op trên file0 (trạng thái-sau-thao-tác).
      file2 = áp LẠI cùng op trên file0 ("Undo" về file0 rồi "Redo" op).
    PROPERTY: tập (kind, bbox) OpSpan và multiset Color_Operators của file2 ==
    file1 (tolerance bbox ≤ 1.0pt); file gốc file0 KHÔNG đổi.
    """
    specs, op = plan
    pdf, _ = _build_pdf(specs)

    with tempfile.TemporaryDirectory() as tmp:
        file0 = os.path.join(tmp, "file0.pdf")
        file1 = os.path.join(tmp, "file1.pdf")
        file2 = os.path.join(tmp, "file2.pdf")
        pdf.save(file0)
        pdf.close()

        file0_bytes = open(file0, "rb").read()

        # (2) file1 = SAU thao tác ban đầu.
        saved1, res1 = apply_and_save(file0, lambda d: _apply_op(d, op),
                                      output_path=file1)
        assert res1.changed is True, f"Thao tác {op['kind']} phải tạo thay đổi"
        assert open(file0, "rb").read() == file0_bytes, "file0 bị đổi sau lần áp 1!"

        # (3)+(4) "Undo" về file0 rồi "Redo": áp LẠI cùng op trên file0.
        saved2, res2 = apply_and_save(file0, lambda d: _apply_op(d, op),
                                      output_path=file2)
        assert res2.changed is True
        assert open(file0, "rb").read() == file0_bytes, "file0 bị đổi sau lần áp 2!"

        # (5) PROPERTY — trạng thái file2 TƯƠNG ĐƯƠNG file1.
        spans1, colors1 = _open_signatures(saved1)
        spans2, colors2 = _open_signatures(saved2)

        assert spans2 == spans1, (
            f"Undo→Redo làm lệch tập OpSpan (op={op['kind']}): "
            f"file1={dict(spans1)} file2={dict(spans2)}"
        )
        assert colors2 == colors1, (
            f"Undo→Redo làm lệch Color_Operators (op={op['kind']}): "
            f"file1={dict(colors1)} file2={dict(colors2)}"
        )


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _roundtrip_twice(specs, op):
    """Áp `op` HAI LẦN trên cùng file0; trả ((spans1, colors1), (spans2, colors2))."""
    pdf, _ = _build_pdf(specs)
    with tempfile.TemporaryDirectory() as tmp:
        file0 = os.path.join(tmp, "f0.pdf")
        file1 = os.path.join(tmp, "f1.pdf")
        file2 = os.path.join(tmp, "f2.pdf")
        pdf.save(file0)
        pdf.close()
        s1, _ = apply_and_save(file0, lambda d: _apply_op(d, op), output_path=file1)
        s2, _ = apply_and_save(file0, lambda d: _apply_op(d, op), output_path=file2)
        return _open_signatures(s1), _open_signatures(s2)


def test_undo_redo_move_idempotent_explicit():
    """Move 1 vector (dx=15, dy=-12): redo cho trạng thái tương đương file1."""
    specs = [
        {"i": 0, "kind": "vector"},
        {"i": 1, "kind": "image"},
        {"i": 2, "kind": "vector"},
    ]
    op = {"kind": "move", "i": 0, "kind_obj": "vector", "dx": 15.0, "dy": -12.0}
    (s1, c1), (s2, c2) = _roundtrip_twice(specs, op)
    assert s1 == s2 and c1 == c2
    # Vector 0 đã dịch (15, -12); span gốc biến mất, span mới xuất hiện trong cả hai.
    moved = _sig("vector", [b + d for b, d in zip(_bbox_for(0), (15.0, -12.0, 15.0, -12.0))])
    assert s1.get(moved, 0) == 1


def test_undo_redo_delete_idempotent_explicit():
    """Delete 1 image: redo xóa đúng cùng object → trạng thái tương đương."""
    specs = [
        {"i": 0, "kind": "image"},
        {"i": 1, "kind": "vector"},
    ]
    op = {"kind": "delete", "i": 0, "kind_obj": "image"}
    (s1, c1), (s2, c2) = _roundtrip_twice(specs, op)
    assert s1 == s2 and c1 == c2
    # Image 0 biến mất ở cả hai lần; vector 1 (cùng màu k) còn nguyên.
    assert s1.get(_sig("image", _bbox_for(0)), 0) == 0
    assert s1.get(_sig("vector", _bbox_for(1)), 0) == 1


def test_undo_redo_rotate_idempotent_explicit():
    """Rotate 1 vector 37°: redo cho cùng bbox (đã to ra) + giữ màu k."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "image"}]
    op = {"kind": "rotate", "i": 0, "kind_obj": "vector", "theta": 37.0}
    (s1, c1), (s2, c2) = _roundtrip_twice(specs, op)
    assert s1 == s2 and c1 == c2
    # Màu k của vector 0 được giữ qua thao tác (object sống sót).
    assert c1.get(("k", (round(0.05, 4), 0.2, 0.3, 0.4)), 0) == 1


def test_undo_redo_resize_idempotent_explicit():
    """Resize 1 vector (sx=1.5, sy=0.8, anchor=sw): redo cho trạng thái tương đương."""
    specs = [{"i": 0, "kind": "vector"}, {"i": 1, "kind": "vector"}]
    op = {"kind": "resize", "i": 1, "kind_obj": "vector",
          "sx": 1.5, "sy": 0.8, "anchor": "sw"}
    (s1, c1), (s2, c2) = _roundtrip_twice(specs, op)
    assert s1 == s2 and c1 == c2
