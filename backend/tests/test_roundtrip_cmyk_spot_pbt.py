"""
Property-Based Test (Task 8.3 — spec `pdf-object-edit`).

**Property 5: Round-trip màu CMYK/spot (Round-trip).**
Object dùng `k` (CMYK) / `scn` (spot/separation) sau Round_Trip
(mở → sửa → lưu ra FILE → mở lại) GIỮ NGUYÊN:
  - operator màu (`k`, `cs`+`scn`),
  - giá trị màu (các thành phần CMYK / tint),
  - định nghĩa colorspace `/Separation` trong `/Resources/ColorSpace`
    (tint transform function + alternate space) còn nguyên.

**Validates: Requirements 4.3, 4.4**

────────────────────────────────────────────────────────────────────────────
KHÁC BIỆT VỚI TASK 4.3 (test_delete_color_preservation_pbt.py)
- Task 4.3 kiểm bảo toàn màu IN-MEMORY (gọi `delete_objects` rồi parse lại trang
  đang mở trong RAM).
- Task 8.3 này kiểm Round_Trip QUA FILE THẬT: dùng `edit_io.apply_and_save`
  (task 8.1) để mở file gốc → áp một thao tác (delete/move) → LƯU RA FILE MỚI
  trên đĩa → MỞ LẠI file đó. Đường này bắt được lỗi serialize/deserialize của
  pikepdf (vd. làm hỏng `/Separation` array, mất tint function, đổi giá trị) mà
  test in-memory không thấy.

CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis)
- Dựng content stream THỦ CÔNG bằng pikepdf để kiểm soát chính xác Color_Operators
  (chỉ CMYK `k` và spot `/Separation … scn` — đúng phạm vi Yêu cầu 4.3/4.4). Mỗi
  object là một nhóm cô lập `q … <color> … re f Q` ở MỘT ô lưới riêng (bbox KHÔNG
  chồng nhau) để `Object_Mapper.map_object` đối khớp DUY NHẤT (không fallback 4.7).
- Mỗi object nhận GIÁ TRỊ MÀU duy nhất theo chỉ số i (chữ ký màu toàn cục duy
  nhất) + spot có ColorSpace `/Separation` + tint function RIÊNG theo i.
- Hypothesis chọn ngẫu nhiên: loại màu mỗi object (cmyk|spot), thao tác áp
  (delete|move), và tập con object bị thao tác (bảo đảm còn ≥ 1 object SỐNG SÓT
  để có cái mà kiểm round-trip).

KIỂM CHỨNG
- Trích chữ ký Color_Operators + định nghĩa `/Separation` của các object SỐNG SÓT
  (không bị xóa) TRƯỚC khi lưu, round-trip qua file, rồi parse lại file MỚI và
  yêu cầu:
    1. Mỗi chữ ký màu của object sống sót xuất hiện ĐÚNG số lần như cũ.
    2. Định nghĩa `/Separation` (tint transform + alternate space) của object spot
       sống sót còn NGUYÊN trong `/Resources/ColorSpace` của file mới.
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
from app.core.object_mapper import parse_page_ops
from app.core.stream_editor import delete_objects, move_objects
from app.schemas.edit import ObjMeta

# ── Hằng số layout ──────────────────────────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0
MAX_SHIFT = 30.0  # |dx|,|dy| ≤ 30pt ≪ bước lưới 150pt → không va ô khác.

COLOR_TYPES = ["cmyk", "spot"]

# Color_Operators liên quan tới Yêu cầu 4.3/4.4.
COLOR_OPS = {"k", "scn", "cs"}


def _rect_for(i: int):
    """BBox không-chồng (x, y, w, h) cho object thứ i (hệ PDF, gốc dưới-trái)."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    """BBox [x0, y0, x1, y1] của object thứ i."""
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


def _color_values(i: int, ctype: str):
    """
    Sinh giá trị màu DUY NHẤT theo chỉ số i. Trả về (operands, op, extra_setup):
      - operands, op : color op chính (k cho cmyk, scn cho spot).
      - extra_setup  : danh sách (op, raw_operands) đặt TRƯỚC color op chính
                       (vd. `/SepN cs` cho spot).
    """
    if ctype == "cmyk":
        vals = [round(0.05 + 0.01 * i, 4), round(0.10 + 0.011 * i, 4),
                round(0.15 + 0.012 * i, 4), round(0.20 + 0.013 * i, 4)]
        return vals, "k", []
    # spot/separation: `/SepN cs` rồi `tint scn`.
    tint = round(0.10 + 0.02 * i, 4)
    return [tint], "scn", [("cs", [f"/Sep{i}"])]


def _make_sig_from_raw(op: str, raw_operands: list):
    """Chuẩn hóa (op, raw_operands) → chữ ký so khớp được."""
    canon = []
    for o in raw_operands:
        if isinstance(o, str):
            canon.append(("name", o))
        else:
            canon.append(("num", round(float(o), 4)))
    return (op, tuple(canon))


def _make_sig_from_instr(instr):
    """Chuẩn hóa một ContentStreamInstruction đã parse → chữ ký so khớp được."""
    canon = []
    for o in instr.operands:
        try:
            canon.append(("num", round(float(o), 4)))
        except (TypeError, ValueError):
            canon.append(("name", str(o)))
    return (str(instr.operator), tuple(canon))


def _object_color_signatures(i: int, ctype: str):
    """Danh sách chữ ký Color_Operators mà object thứ i phát ra."""
    sigs = []
    operands, op, extra = _color_values(i, ctype)
    for ex_op, ex_raw in extra:
        sigs.append(_make_sig_from_raw(ex_op, ex_raw))
    sigs.append(_make_sig_from_raw(op, operands))
    return sigs


def _object_stream_fragment(i: int, ctype: str) -> str:
    """Đoạn content stream cô lập `q … Q` cho object thứ i."""
    x, y, w, h = _rect_for(i)
    lines = ["q"]
    operands, op, extra = _color_values(i, ctype)
    for ex_op, ex_raw in extra:
        lines.append(" ".join(ex_raw) + f" {ex_op}")
    lines.append(" ".join(f"{v:.4f}" for v in operands) + f" {op}")
    lines.append(f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re")
    lines.append("f")
    lines.append("Q")
    return "\n".join(lines) + "\n"


def _build_pdf(specs):
    """
    Dựng pikepdf.Pdf 1 trang chứa object CMYK/spot theo `specs`
    (mỗi spec = {"i": int, "ctype": "cmyk"|"spot"}). Trả về (pdf, page).
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    cs_dict = pikepdf.Dictionary()
    has_cs = False
    fragments = []

    for spec in specs:
        i, ctype = spec["i"], spec["ctype"]
        fragments.append(_object_stream_fragment(i, ctype))

        if ctype == "spot":
            # tint transform RIÊNG theo i (C1 khác nhau → định nghĩa duy nhất).
            func = pdf.make_indirect(pikepdf.Dictionary(
                FunctionType=2,
                Domain=pikepdf.Array([0, 1]),
                C0=pikepdf.Array([0, 0, 0, 0]),
                C1=pikepdf.Array([0, 0, 0, round(0.5 + 0.01 * i, 4)]),
                N=1,
            ))
            sep = pikepdf.Array([
                pikepdf.Name("/Separation"),
                pikepdf.Name(f"/Spot{i}"),
                pikepdf.Name("/DeviceCMYK"),
                func,
            ])
            cs_dict[pikepdf.Name(f"/Sep{i}")] = pdf.make_indirect(sep)
            has_cs = True

    resources = pikepdf.Dictionary()
    if has_cs:
        resources[pikepdf.Name("/ColorSpace")] = cs_dict
    page.obj[pikepdf.Name("/Resources")] = resources

    stream = "".join(fragments).encode("latin-1")
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)
    return pdf, page


def _color_counter(page) -> Counter:
    """Đếm chữ ký Color_Operators (k/cs/scn) hiện diện trong content stream."""
    counter: Counter = Counter()
    for instr in parse_page_ops(page):
        if str(instr.operator) in COLOR_OPS:
            counter[_make_sig_from_instr(instr)] += 1
    return counter


def _serialize(obj):
    """
    Serialize đệ quy một pikepdf object → cấu trúc Python so khớp được
    (để so sánh định nghĩa colorspace `/Separation` trước/sau round-trip).
    """
    if isinstance(obj, pikepdf.Array):
        return ["array"] + [_serialize(x) for x in obj]
    if isinstance(obj, pikepdf.Dictionary):
        return {"dict": {str(k): _serialize(v) for k, v in obj.items()}}
    if isinstance(obj, pikepdf.Stream):
        return {"stream": {str(k): _serialize(v) for k, v in obj.stream_dict.items()}}
    if isinstance(obj, pikepdf.Name):
        return ("name", str(obj))
    try:
        return ("num", round(float(obj), 6))
    except (TypeError, ValueError):
        return ("raw", str(obj))


def _separation_defs(page) -> dict:
    """
    Trích định nghĩa `/Separation` trong `/Resources/ColorSpace` của trang →
    {sep_name: serialized_def}. Rỗng nếu không có ColorSpace.
    """
    out: dict = {}
    resources = page.obj.get("/Resources")
    if resources is None:
        return out
    cs = resources.get("/ColorSpace")
    if cs is None:
        return out
    for key, val in cs.items():
        out[str(key)] = _serialize(val)
    return out


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _roundtrip_plan(draw):
    """
    Sinh (specs, op, target_flags, dx, dy):
      - specs       : danh sách object CMYK/spot,
      - op          : 'delete' | 'move' — thao tác áp,
      - target_flags: cờ "bị thao tác" cho từng object (bảo đảm còn ≥ 1 sống sót),
      - dx, dy      : độ dịch (chỉ dùng khi op == 'move').
    """
    n = draw(st.integers(min_value=2, max_value=5))
    specs = [{"i": i, "ctype": draw(st.sampled_from(COLOR_TYPES))} for i in range(n)]
    op = draw(st.sampled_from(["delete", "move"]))
    target_flags = [draw(st.booleans()) for _ in range(n)]
    # Bảo đảm còn ≥ 1 object sống sót (không bị xóa hết) để kiểm round-trip.
    if all(target_flags):
        target_flags[draw(st.integers(min_value=0, max_value=n - 1))] = False
    dx = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                        allow_nan=False, allow_infinity=False))
    dy = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                        allow_nan=False, allow_infinity=False))
    return specs, op, target_flags, dx, dy


def _targets_metas(specs, target_flags):
    """ObjMeta cho các object bị thao tác."""
    return [
        ObjMeta(id=f"obj-{s['i']}", drawIndex=s["i"], type="vector",
                bbox=_bbox_for(s["i"]))
        for s, flag in zip(specs, target_flags) if flag
    ]


def _roundtrip_apply(specs, op, target_flags, dx, dy):
    """
    Round-trip QUA FILE THẬT: dựng PDF → lưu file gốc → apply_and_save áp thao
    tác ra FILE MỚI → trả (saved_path, orig_path) để caller mở lại và kiểm.
    Caller chịu trách nhiệm dọn file.
    """
    pdf, _ = _build_pdf(specs)
    orig_fd, orig_path = tempfile.mkstemp(suffix="_orig.pdf")
    os.close(orig_fd)
    out_fd, out_path = tempfile.mkstemp(suffix="_rt.pdf")
    os.close(out_fd)
    pdf.save(orig_path)
    pdf.close()

    def mutate(doc: pikepdf.Pdf):
        page = doc.pages[0]
        metas = _targets_metas(specs, target_flags)
        if op == "delete":
            return delete_objects(page, metas, doc)
        return move_objects(page, metas, dx, dy, doc, coord_space="pdf")

    saved, _result = apply_and_save(orig_path, mutate, output_path=out_path)
    return saved, orig_path


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 5 — Round-trip màu CMYK/spot qua FILE (Validates: 4.3, 4.4)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_roundtrip_plan())
def test_roundtrip_preserves_cmyk_spot(plan):
    """
    Với mọi thao tác (delete/move) áp lên một tập con object, các object SỐNG SÓT
    dùng `k`/`scn` GIỮ NGUYÊN operator + giá trị màu + định nghĩa `/Separation`
    sau Round_Trip qua FILE THẬT (mở → sửa → lưu ra đĩa → mở lại).
    """
    specs, op, target_flags, dx, dy = plan

    # Object SỐNG SÓT = không bị xóa (move giữ lại tất cả).
    if op == "delete":
        survivors = [s for s, flag in zip(specs, target_flags) if not flag]
    else:
        survivors = list(specs)

    # Chữ ký màu kỳ vọng của các object sống sót (toàn cục duy nhất theo i).
    expected_sigs: Counter = Counter()
    for s in survivors:
        for sig in _object_color_signatures(s["i"], s["ctype"]):
            expected_sigs[sig] += 1

    # Định nghĩa /Separation kỳ vọng của các object spot sống sót.
    expected_seps: dict = {}
    for s in survivors:
        if s["ctype"] == "spot":
            expected_seps[f"/Sep{s['i']}"] = None  # điền sau từ file gốc

    saved, orig_path = _roundtrip_apply(specs, op, target_flags, dx, dy)
    try:
        # Định nghĩa /Separation TRƯỚC round-trip (đọc lại từ file gốc đã lưu).
        with pikepdf.Pdf.open(orig_path) as src:
            before_seps = _separation_defs(src.pages[0])
        for name in expected_seps:
            assert name in before_seps, (
                f"Tiền đề sai: file gốc thiếu định nghĩa colorspace {name}"
            )
            expected_seps[name] = before_seps[name]

        # Mở lại FILE MỚI sau round-trip.
        with pikepdf.Pdf.open(saved) as rt:
            page2 = rt.pages[0]
            after_color = _color_counter(page2)
            after_seps = _separation_defs(page2)

        # PROPERTY (1): mỗi chữ ký màu của object sống sót giữ NGUYÊN số lần.
        for sig, cnt in expected_sigs.items():
            assert after_color[sig] == cnt, (
                f"Vi phạm round-trip màu: chữ ký {sig} kỳ vọng {cnt} lần, "
                f"file sau round-trip có {after_color[sig]} lần (op={op})"
            )

        # PROPERTY (2): định nghĩa /Separation của object spot sống sót còn NGUYÊN.
        for name, expected_def in expected_seps.items():
            assert name in after_seps, (
                f"Mất định nghĩa colorspace {name} sau round-trip (op={op})"
            )
            assert after_seps[name] == expected_def, (
                f"Định nghĩa /Separation {name} bị đổi sau round-trip (op={op}):\n"
                f"  trước = {expected_def}\n  sau   = {after_seps[name]}"
            )
    finally:
        for p in (saved, orig_path):
            try:
                os.remove(p)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _painting_op_count(page) -> int:
    """Đếm số op painting `f` (vẽ/fill) trong content stream của trang."""
    return sum(1 for instr in parse_page_ops(page) if str(instr.operator) == "f")


def test_roundtrip_delete_cmyk_keeps_spot_explicit():
    """
    2 object (CMYK + spot), XÓA object CMYK, round-trip qua file → màu spot
    (cs+scn) và định nghĩa /Separation của object còn lại được giữ nguyên.

    Lưu ý: `delete_objects` cho vector chỉ loại nhóm path-construction + painting
    (`re`/`f`) — drawing của object biến mất — còn op set-màu `k` có thể còn lại
    như một no-op cô lập trong `q…Q` (không vẽ gì). Property 5 quan tâm tới object
    SỐNG SÓT, nên ta kiểm: (a) painting op của object đã xóa biến mất, (b) màu +
    /Separation của object spot còn lại được giữ nguyên qua round-trip.
    """
    specs = [
        {"i": 0, "ctype": "cmyk"},
        {"i": 1, "ctype": "spot"},
    ]
    target_flags = [True, False]  # xóa object 0 (cmyk), giữ object 1 (spot)
    saved, orig_path = _roundtrip_apply(specs, "delete", target_flags, 0.0, 0.0)
    try:
        with pikepdf.Pdf.open(orig_path) as src:
            before_seps = _separation_defs(src.pages[0])
            before_paint = _painting_op_count(src.pages[0])
        with pikepdf.Pdf.open(saved) as rt:
            page2 = rt.pages[0]
            after_color = _color_counter(page2)
            after_seps = _separation_defs(page2)
            after_paint = _painting_op_count(page2)

        # (a) Drawing của object CMYK đã xóa biến mất (giảm đúng 1 painting op).
        assert after_paint == before_paint - 1, (
            f"Object CMYK chưa bị xóa: painting op trước={before_paint}, sau={after_paint}"
        )

        # (b) Màu spot của object sống sót giữ nguyên (operator + giá trị).
        for sig in _object_color_signatures(1, "spot"):
            assert after_color[sig] == 1, f"Màu spot không được giữ: {sig}"

        # (b) Định nghĩa /Separation của object spot sống sót còn nguyên.
        assert "/Sep1" in after_seps
        assert after_seps["/Sep1"] == before_seps["/Sep1"], (
            "Định nghĩa /Separation của object spot sống sót bị đổi sau round-trip"
        )
    finally:
        for p in (saved, orig_path):
            try:
                os.remove(p)
            except OSError:
                pass


def test_roundtrip_move_preserves_cmyk_and_spot_explicit():
    """
    DI CHUYỂN 1 object CMYK; round-trip qua file → cả màu CMYK (đã move) lẫn spot
    (untouched) giữ nguyên operator + giá trị + định nghĩa colorspace.
    """
    specs = [
        {"i": 0, "ctype": "cmyk"},
        {"i": 1, "ctype": "spot"},
    ]
    target_flags = [True, False]  # move object 0
    saved, orig_path = _roundtrip_apply(specs, "move", target_flags, 20.0, -10.0)
    try:
        with pikepdf.Pdf.open(orig_path) as src:
            before_seps = _separation_defs(src.pages[0])
        with pikepdf.Pdf.open(saved) as rt:
            page2 = rt.pages[0]
            after_color = _color_counter(page2)
            after_seps = _separation_defs(page2)

        # Cả hai object còn sống → mọi chữ ký màu giữ nguyên.
        for spec in specs:
            for sig in _object_color_signatures(spec["i"], spec["ctype"]):
                assert after_color[sig] == 1, (
                    f"Round-trip move làm mất/đổi màu {sig}"
                )
        assert after_seps["/Sep1"] == before_seps["/Sep1"]
    finally:
        for p in (saved, orig_path):
            try:
                os.remove(p)
            except OSError:
                pass
