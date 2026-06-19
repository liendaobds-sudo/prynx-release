"""
Property-Based Test (Task 4.3 — spec `pdf-object-edit`).

**Property 1: Bảo toàn màu của Untouched_Object (Invariant).**
Với MỌI thao tác sửa (ở đây là XÓA) một tập object mục tiêu, tập Color_Operators
(`k`/`K`, `scn`/`SCN`, `cs`/`CS`, `rg`/`RG`, `g`/`G`, overprint áp qua `gs`) của
các Untouched_Object TRƯỚC và SAU khi lưu là BẰNG NHAU (cùng operator, cùng giá
trị, cùng số lần xuất hiện).

**Validates: Requirements 4.2, 3.4**

────────────────────────────────────────────────────────────────────────────
CHIẾN LƯỢC SINH DỮ LIỆU
- Dùng pikepdf dựng content stream THỦ CÔNG để KIỂM SOÁT chính xác Color_Operators
  (reportlab khó tạo spot/overprint). Mỗi object là một nhóm cô lập:

      q
        <color operators>     ← k / rg / g / (cs + scn) / (gs overprint)
        x y w h re
        f
      Q

- Mỗi object đặt ở một ô lưới RIÊNG (bbox KHÔNG chồng nhau, khoảng cách ≫ 1.0pt)
  để `Object_Mapper.map_object` đối khớp DUY NHẤT (không kích hoạt fallback 4.7).
- Mỗi object nhận GIÁ TRỊ MÀU duy nhất theo chỉ số i → chữ ký màu của từng object
  là toàn cục duy nhất, cho phép truy vết object nào sở hữu color op nào.
- Hypothesis chọn ngẫu nhiên loại màu mỗi object, có/không overprint, và tập con
  object để XÓA.

KIỂM CHỨNG
- Trích chữ ký Color_Operators của các Untouched_Object TRƯỚC khi xóa, rồi parse
  lại stream SAU khi `delete_objects` ghi qua pikepdf, và yêu cầu mỗi chữ ký màu
  untouched xuất hiện ĐÚNG bằng số lần như cũ (operator + giá trị + định nghĩa
  colorspace tham chiếu không đổi).
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

from app.core.object_mapper import parse_page_ops
from app.core.stream_editor import delete_objects
from app.schemas.edit import ObjMeta

# ── Hằng số layout ──────────────────────────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

COLOR_TYPES = ["cmyk", "rgb", "gray", "spot"]

# Operator được coi là Color_Operators (gồm `gs` áp overprint/ICC ExtGState).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G", "gs"}


def _rect_for(i: int):
    """BBox không-chồng cho object thứ i (hệ PDF, gốc dưới-trái)."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _color_values(i: int, ctype: str):
    """
    Sinh giá trị màu DUY NHẤT theo chỉ số i để chữ ký màu của object là toàn cục
    duy nhất (giúp truy vết quyền sở hữu color op).

    Trả về (operands_raw, op, extra_setup) với:
      - operands_raw, op : color op chính (k/rg/g/scn).
      - extra_setup      : danh sách (op, raw_operands) đặt TRƯỚC color op chính
                           (vd. `/SepN cs` cho spot).
    """
    if ctype == "cmyk":
        vals = [round(0.05 + 0.01 * i, 4), round(0.10 + 0.011 * i, 4),
                round(0.15 + 0.012 * i, 4), round(0.20 + 0.013 * i, 4)]
        return vals, "k", []
    if ctype == "rgb":
        vals = [round(0.02 + 0.01 * i, 4), round(0.07 + 0.011 * i, 4),
                round(0.12 + 0.012 * i, 4)]
        return vals, "rg", []
    if ctype == "gray":
        return [round(0.03 + 0.015 * i, 4)], "g", []
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


def _object_color_signatures(i: int, ctype: str, overprint: bool):
    """Danh sách chữ ký Color_Operators mà object thứ i phát ra."""
    sigs = []
    if overprint:
        sigs.append(_make_sig_from_raw("gs", [f"/GS{i}"]))
    operands, op, extra = _color_values(i, ctype)
    for ex_op, ex_raw in extra:
        sigs.append(_make_sig_from_raw(ex_op, ex_raw))
    sigs.append(_make_sig_from_raw(op, operands))
    return sigs


def _object_stream_fragment(i: int, ctype: str, overprint: bool) -> str:
    """Đoạn content stream cô lập `q … Q` cho object thứ i."""
    x, y, w, h = _rect_for(i)
    lines = ["q"]
    if overprint:
        lines.append(f"/GS{i} gs")
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
    Dựng pikepdf.Pdf 1 trang chứa các object vector theo `specs`
    (mỗi spec = dict {i, ctype, overprint}). Trả về (pdf, page).
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    cs_dict = pikepdf.Dictionary()
    gs_dict = pikepdf.Dictionary()
    has_cs = False
    has_gs = False

    fragments = []
    for spec in specs:
        i, ctype, overprint = spec["i"], spec["ctype"], spec["overprint"]
        fragments.append(_object_stream_fragment(i, ctype, overprint))

        if ctype == "spot":
            func = pdf.make_indirect(pikepdf.Dictionary(
                FunctionType=2,
                Domain=pikepdf.Array([0, 1]),
                C0=pikepdf.Array([0, 0, 0, 0]),
                C1=pikepdf.Array([0, 0, 0, 1]),
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

        if overprint:
            gs_dict[pikepdf.Name(f"/GS{i}")] = pdf.make_indirect(
                pikepdf.Dictionary(OP=True, op=True, OPM=1)
            )
            has_gs = True

    resources = pikepdf.Dictionary()
    if has_cs:
        resources[pikepdf.Name("/ColorSpace")] = cs_dict
    if has_gs:
        resources[pikepdf.Name("/ExtGState")] = gs_dict
    page.obj[pikepdf.Name("/Resources")] = resources

    stream = "".join(fragments).encode("latin-1")
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)
    return pdf, page


def _color_counter(page) -> Counter:
    """Đếm chữ ký Color_Operators hiện diện trong content stream của trang."""
    counter: Counter = Counter()
    for instr in parse_page_ops(page):
        if str(instr.operator) in COLOR_OPS:
            counter[_make_sig_from_instr(instr)] += 1
    return counter


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _page_plan(draw):
    """Sinh (specs, target_flags): danh sách object + cờ xóa mỗi object."""
    n = draw(st.integers(min_value=2, max_value=6))
    specs = []
    for i in range(n):
        specs.append({
            "i": i,
            "ctype": draw(st.sampled_from(COLOR_TYPES)),
            "overprint": draw(st.booleans()),
        })
    target_flags = [draw(st.booleans()) for _ in range(n)]
    return specs, target_flags


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 1 — Bảo toàn màu Untouched_Object khi xóa (Validates: 4.2, 3.4)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_page_plan())
def test_delete_preserves_untouched_color_operators(plan):
    """
    Với mọi tập object mục tiêu được chọn để xóa, tập Color_Operators của các
    Untouched_Object trước và sau `delete_objects` là BẰNG NHAU.
    """
    specs, target_flags = plan
    pdf, page = _build_pdf(specs)

    try:
        # Color_Operators hiện diện TRƯỚC khi xóa.
        before = _color_counter(page)

        # Chữ ký màu kỳ vọng của các Untouched_Object (toàn cục duy nhất theo i).
        untouched_specs = [s for s, flag in zip(specs, target_flags) if not flag]
        untouched_sigs: Counter = Counter()
        for s in untouched_specs:
            for sig in _object_color_signatures(s["i"], s["ctype"], s["overprint"]):
                untouched_sigs[sig] += 1

        # Tiền đề: mỗi chữ ký untouched thực sự có mặt đúng số lần trong stream gốc
        # (xác nhận generator + bộ trích khớp nhau).
        for sig, cnt in untouched_sigs.items():
            assert before[sig] == cnt, (
                f"Tiền đề sai: chữ ký untouched {sig} kỳ vọng {cnt} lần, "
                f"stream gốc có {before[sig]} lần"
            )

        # Xóa tập mục tiêu qua Stream_Editor (đường ghi pikepdf duy nhất).
        target_metas = [
            ObjMeta(
                id=f"obj-{s['i']}",
                drawIndex=s["i"],
                type="vector",
                bbox=list(_rect_for(s["i"])[:2])
                + [_rect_for(s["i"])[0] + RECT_W, _rect_for(s["i"])[1] + RECT_H],
            )
            for s, flag in zip(specs, target_flags) if flag
        ]
        delete_objects(page, target_metas, pdf)

        # Color_Operators hiện diện SAU khi xóa.
        after = _color_counter(page)

        # PROPERTY: mỗi Color_Operator của Untouched_Object được giữ NGUYÊN —
        # cùng operator, cùng giá trị, cùng số lần xuất hiện.
        for sig, _cnt in untouched_sigs.items():
            assert after[sig] == before[sig], (
                f"Vi phạm bảo toàn màu Untouched_Object: chữ ký {sig} "
                f"trước={before[sig]} ≠ sau={after[sig]}"
            )
    finally:
        pdf.close()


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_delete_one_keeps_other_colors_explicit():
    """
    Ví dụ cụ thể: 2 object (CMYK + spot), xóa object CMYK → màu spot (cs+scn)
    của object còn lại được giữ nguyên.
    """
    specs = [
        {"i": 0, "ctype": "cmyk", "overprint": False},
        {"i": 1, "ctype": "spot", "overprint": True},
    ]
    pdf, page = _build_pdf(specs)
    try:
        before = _color_counter(page)
        x, y, w, h = _rect_for(0)
        target = ObjMeta(id="obj-0", drawIndex=0, type="vector",
                         bbox=[x, y, x + w, y + h])
        result = delete_objects(page, [target], pdf)
        assert result.changed is True

        after = _color_counter(page)
        for sig in _object_color_signatures(1, "spot", True):
            assert after[sig] == before[sig] == 1, (
                f"Màu Untouched_Object (spot) không được bảo toàn: {sig}"
            )
    finally:
        pdf.close()


def test_delete_empty_target_is_noop_explicit():
    """Tập mục tiêu rỗng → no-op, toàn bộ Color_Operators giữ nguyên."""
    specs = [{"i": 0, "ctype": "rgb", "overprint": False}]
    pdf, page = _build_pdf(specs)
    try:
        before = _color_counter(page)
        result = delete_objects(page, [], pdf)
        assert result.changed is False
        after = _color_counter(page)
        assert after == before
    finally:
        pdf.close()
