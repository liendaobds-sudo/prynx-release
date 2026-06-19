"""
Property-Based Test (Task 4.2 — spec `pdf-edit-session`).

# Feature: pdf-edit-session, Property 4: Undo/Redo idempotent theo cặp (Round-trip):
# Với mọi Edit_Op áp trong phiên, thực hiện Undo rồi Redo đưa Live_Document về
# trạng thái TƯƠNG ĐƯƠNG ngay sau Edit_Op ban đầu — Color_Operators và BBox của
# object liên quan được giữ trong tolerance ≤ 1.0pt.

**Validates: Requirements 7.5**

────────────────────────────────────────────────────────────────────────────
PHẠM VI & Ý TƯỞNG KIỂM CHỨNG (qua engine phiên `app/core/edit_session.py` THẬT)
- Dựng một phiên SỐNG (EditSession trong SESSIONS) với PDF in-memory MÀU IN
  (CMYK `k` / spot `scn` / ICCBased `scn` / overprint `gs` / image `Do`), mỗi
  object ở MỘT ô lưới riêng (CELL=150) → bbox KHÔNG chồng → PDFium map DUY NHẤT.
- Áp một CHUỖI Edit_Op (move/resize/rotate/delete/add) qua `apply_op`
  (Apply_In_Memory trên Live_Document). GHI NHẬN trạng thái NGAY SAU op cuối từ
  `session.live_bytes`:
    • tập (kind, bbox) các OpSpan (`build_op_spans`) — đối khớp BBox tol ≤ 1.0pt,
    • multiset Color_Operators (`k/K/scn/SCN/cs/CS/rg/RG/g/G`) (`parse_page_ops`).
- Gọi `undo(session)` (hoàn tác op cuối) rồi `redo(session)` (áp lại op cuối).
  KHẲNG ĐỊNH trạng thái SAU REDO (đọc lại `session.live_bytes`) TƯƠNG ĐƯƠNG
  trạng thái đã ghi nhận ngay sau op ban đầu:
    1. multiset (kind, bbox) OpSpan khớp greedy trong tolerance ≤ 1.0pt,
    2. multiset Color_Operators BẰNG NHAU tuyệt đối.

  → Undo (baseline + replay `op_log[:-1]`) rồi Redo (áp lại op từ `redo_stack`)
    là idempotent theo cặp: không làm xê dịch hình học hay đổi màu in.

CÔ LẬP DB: phiên được đăng ký trực tiếp vào `SESSIONS`/`by_fid` (không cần DB) như
`test_session_color_preservation_pbt.py`; `undo`/`redo` chỉ thao tác RAM + render
PDFium read-only (KHÔNG commit ra đĩa) nên không đụng tầng đăng ký Working_File.
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys
import threading
import uuid
from collections import Counter
from io import BytesIO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core import edit_session
from app.core.edit_session import (
    EditSession,
    _list_objects_from_bytes,
    apply_op,
    redo,
    undo,
)
from app.core.object_mapper import _as_float, _name_str, build_op_spans, parse_page_ops
from app.schemas.edit import (
    BBOX_TOLERANCE_PT,
    EditOp,
    MoveDelta,
    ResizeScale,
    TextPayload,
    normalize_bbox,
)

# ── Hằng số layout (đồng bộ các PBT khác của hệ) ─────────────────────────────
PAGE_W = 760.0
PAGE_H = 620.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0
TOL = BBOX_TOLERANCE_PT  # 1.0pt

# Loại object/màu — phủ CMYK / spot / ICCBased / overprint / image.
OBJ_TYPES = ["cmyk", "spot", "icc", "overprint", "image"]

# Color_Operators cần đối chiếu (glossary `pdf-edit-session`).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G"}

# Ràng buộc tham số op để object KHÔNG va sang ô lưới khác (giữ map DUY NHẤT).
MAX_SHIFT = 30.0          # |dx|,|dy| ≤ 30pt ≪ bước lưới 150pt.
MIN_SCALE, MAX_SCALE = 0.5, 2.0  # 40×30 × 2 = 80×60 ≪ 150pt.

# ICC profile thật (bundle) để `/ICCBased` hợp lệ tuyệt đối.
_ICC_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "assets", "icc", "sRGB.icc")
with open(_ICC_PATH, "rb") as _fh:
    _ICC_BYTES = _fh.read()


def _rect_for(cell: int):
    """(x, y, w, h) cho object đặt tại ô lưới `cell` (không chồng nhau)."""
    x = 25.0 + (cell % COLS) * CELL
    y = 25.0 + (cell // COLS) * CELL
    return x, y, RECT_W, RECT_H


# ── Dựng fragment content theo loại màu ──────────────────────────────────────
def _fragment(cell: int, ctype: str) -> str:
    """Đoạn `q … Q` cô lập cho object tại `cell` theo loại màu `ctype`."""
    x, y, w, h = _rect_for(cell)
    rect = f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re\nf\n"
    if ctype == "cmyk":
        c = round(0.05 + 0.013 * cell, 4)
        return f"q\n{c:.4f} 0.2000 0.3000 0.4000 k\n{rect}Q\n"
    if ctype == "spot":
        tint = round(0.10 + 0.02 * cell, 4)
        return f"q\n/Sep{cell} cs\n{tint:.4f} scn\n{rect}Q\n"
    if ctype == "icc":
        r = round(0.10 + 0.01 * cell, 4)
        return f"q\n/Icc{cell} cs\n{r:.4f} 0.4000 0.6000 scn\n{rect}Q\n"
    if ctype == "overprint":
        c = round(0.07 + 0.01 * cell, 4)
        return f"q\n/GSop{cell} gs\n{c:.4f} 0.5000 0.2000 0.1000 k\n{rect}Q\n"
    # image
    return f"q\n{w:.4f} 0 0 {h:.4f} {x:.4f} {y:.4f} cm\n/Img{cell} Do\nQ\n"


def _make_image_xobject(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """XObject ảnh 2×2 RGB tối thiểu (uncompressed)."""
    stream = pikepdf.Stream(pdf, bytes([200, 30, 30] * 4))
    stream[pikepdf.Name("/Type")] = pikepdf.Name("/XObject")
    stream[pikepdf.Name("/Subtype")] = pikepdf.Name("/Image")
    stream[pikepdf.Name("/Width")] = 2
    stream[pikepdf.Name("/Height")] = 2
    stream[pikepdf.Name("/ColorSpace")] = pikepdf.Name("/DeviceRGB")
    stream[pikepdf.Name("/BitsPerComponent")] = 8
    return pdf.make_indirect(stream)


def _make_separation_cs(pdf: pikepdf.Pdf, cell: int) -> pikepdf.Object:
    """ColorSpace `/Separation` với tint transform RIÊNG theo `cell`."""
    func = pdf.make_indirect(pikepdf.Dictionary(
        FunctionType=2,
        Domain=pikepdf.Array([0, 1]),
        C0=pikepdf.Array([0, 0, 0, 0]),
        C1=pikepdf.Array([0, 0, 0, round(0.5 + 0.01 * cell, 4)]),
        N=1,
    ))
    return pdf.make_indirect(pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name(f"/Spot{cell}"),
        pikepdf.Name("/DeviceCMYK"),
        func,
    ]))


def _make_icc_cs(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """ColorSpace `/ICCBased` (N=3, alternate DeviceRGB) từ ICC profile thật."""
    icc = pikepdf.Stream(pdf, _ICC_BYTES)
    icc[pikepdf.Name("/N")] = 3
    icc[pikepdf.Name("/Alternate")] = pikepdf.Name("/DeviceRGB")
    return pdf.make_indirect(pikepdf.Array([pikepdf.Name("/ICCBased"), icc]))


def _make_overprint_gs(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """ExtGState bật overprint (OP/op/OPM)."""
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/ExtGState"), OP=True, op=True, OPM=1,
    ))


def _build_pdf_bytes(specs) -> bytes:
    """
    Dựng bytes một PDF 1 trang chứa object theo `specs`
    (`[{"cell": int, "ctype": str}, ...]`) với đủ resource cho từng loại màu.
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    cs_dict = pikepdf.Dictionary()
    gs_dict = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    has_cs = has_gs = has_xobj = False
    fragments = []

    for spec in specs:
        cell, ctype = spec["cell"], spec["ctype"]
        fragments.append(_fragment(cell, ctype))
        if ctype == "spot":
            cs_dict[pikepdf.Name(f"/Sep{cell}")] = _make_separation_cs(pdf, cell)
            has_cs = True
        elif ctype == "icc":
            cs_dict[pikepdf.Name(f"/Icc{cell}")] = _make_icc_cs(pdf)
            has_cs = True
        elif ctype == "overprint":
            gs_dict[pikepdf.Name(f"/GSop{cell}")] = _make_overprint_gs(pdf)
            has_gs = True
        elif ctype == "image":
            xobjects[pikepdf.Name(f"/Img{cell}")] = _make_image_xobject(pdf)
            has_xobj = True

    resources = pikepdf.Dictionary()
    if has_cs:
        resources[pikepdf.Name("/ColorSpace")] = cs_dict
    if has_gs:
        resources[pikepdf.Name("/ExtGState")] = gs_dict
    if has_xobj:
        resources[pikepdf.Name("/XObject")] = xobjects
    page.obj[pikepdf.Name("/Resources")] = resources

    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(
        "".join(fragments).encode("latin-1")
    )
    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


# ── Trích chữ ký trạng thái để đối chiếu (OpSpan + Color_Operators) ──────────
def _operand_key(operand):
    """Khóa so khớp operand màu: số → làm tròn 4 chữ số; tên → chuỗi."""
    f = _as_float(operand)
    if f is not None:
        return ("num", round(f, 4))
    name = _name_str(operand)
    if name is not None:
        return ("name", name)
    return ("raw", str(operand))


def _color_op_counter(page) -> Counter:
    """Đếm multiset Color_Operators (operator + operands chuẩn hóa) của trang."""
    counter: Counter = Counter()
    for instr in parse_page_ops(page):
        op = str(instr.operator)
        if op in COLOR_OPS:
            counter[(op, tuple(_operand_key(o) for o in instr.operands))] += 1
    return counter


def _spans(page, pdf) -> list[tuple]:
    """Danh sách (kind, bbox-đã-normalize) của MỌI OpSpan trên trang."""
    return [(span.kind, tuple(normalize_bbox(list(span.bbox))))
            for span in build_op_spans(page, pdf=pdf)]


def _signatures_from_bytes(pdf_bytes: bytes):
    """Mở BYTES, trả (spans, color_counter) của trang 0."""
    with pikepdf.Pdf.open(BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[0]
        return _spans(page, pdf), _color_op_counter(page)


def _assert_spans_equivalent(spans_a, spans_b, op_summary):
    """
    Đối khớp greedy hai danh sách (kind, bbox): mỗi span ở A phải có một span CÙNG
    kind ở B với BBox trong tolerance ≤ 1.0pt; số lượng phải bằng nhau.
    """
    assert len(spans_a) == len(spans_b), (
        f"Số OpSpan khác nhau sau-op vs sau-undo/redo (ops={op_summary}): "
        f"after_op={len(spans_a)} after_redo={len(spans_b)}"
    )
    remaining = list(spans_b)
    for kind, bbox in spans_a:
        match_idx = None
        for j, (k2, bb2) in enumerate(remaining):
            if k2 == kind and all(abs(bbox[i] - bb2[i]) <= TOL for i in range(4)):
                match_idx = j
                break
        assert match_idx is not None, (
            f"OpSpan {(kind, bbox)} sau-op không có span tương ứng (tol ≤ {TOL}pt) "
            f"sau undo→redo (ops={op_summary}). Còn lại={remaining}"
        )
        remaining.pop(match_idx)
    assert not remaining, (
        f"Sau undo→redo còn span dư không khớp trạng-thái-sau-op (ops={op_summary}): "
        f"{remaining}"
    )


# ── Session helpers (cô lập DB) ──────────────────────────────────────────────
def _make_live_session(pdf_bytes: bytes) -> EditSession:
    """Tạo EditSession sống (đăng ký vào SESSIONS) — không cần file gốc trên đĩa."""
    sid = "undo-redo-" + uuid.uuid4().hex
    fid = "fid-ur-" + uuid.uuid4().hex
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path="<in-memory>",
        pdf=pikepdf.Pdf.open(BytesIO(pdf_bytes)),
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        live_bytes=None,
        dirty=False,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[fid] = sid
    return session


def _cleanup_session(session: EditSession):
    edit_session.SESSIONS.pop(session.session_id, None)
    edit_session.by_fid.pop(session.source_fid, None)
    try:
        session.pdf.close()
    except Exception:  # noqa: BLE001
        pass


def _build_edit_op(kind: str, plan_op: dict, current_bytes: bytes):
    """
    Dựng một `EditOp` HỢP LỆ từ abstract op `plan_op` + trạng thái BYTES hiện tại
    (resolve target theo chỉ số thứ-tự-vẽ). Trả None nếu op cần mục tiêu nhưng
    trang không còn object nào.
    """
    if kind == "add":
        cell = plan_op["cell"]
        x, y, w, h = _rect_for(cell)
        bbox = [x, y, x + w, y + h]
        return EditOp(page=0, kind="add",
                      text=TextPayload(content=plan_op["content"], bbox=bbox, sizePt=10.0))

    by_id = _list_objects_from_bytes(current_bytes, 0)
    ordered = sorted(by_id.values(), key=lambda m: m.drawIndex)
    if not ordered:
        return None
    idx = min(int(plan_op["target_frac"] * len(ordered)), len(ordered) - 1)
    target_id = ordered[idx].id

    if kind == "move":
        return EditOp(page=0, kind="move", targetIds=[target_id],
                      delta=MoveDelta(dx=plan_op["dx"], dy=plan_op["dy"]))
    if kind == "resize":
        return EditOp(page=0, kind="resize", targetIds=[target_id],
                      scale=ResizeScale(sx=plan_op["sx"], sy=plan_op["sy"],
                                        anchor=plan_op["anchor"]))
    if kind == "rotate":
        return EditOp(page=0, kind="rotate", targetIds=[target_id],
                      rotateDeg=plan_op["theta"])
    if kind == "delete":
        return EditOp(page=0, kind="delete", targetIds=[target_id])
    raise AssertionError(f"kind không hỗ trợ: {kind}")


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _undo_redo_plan(draw):
    """
    Sinh (specs, plan_ops):
      - specs    : object khởi tạo (cell 0..n-1) với loại màu ngẫu nhiên.
      - plan_ops : chuỗi 1..3 abstract op hợp lệ; `add` cấp một ô lưới TRỐNG.
    """
    n = draw(st.integers(min_value=2, max_value=4))
    specs = [{"cell": i, "ctype": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    next_cell = n

    m = draw(st.integers(min_value=1, max_value=3))
    plan_ops = []
    for _ in range(m):
        kind = draw(st.sampled_from(["move", "resize", "rotate", "delete", "add"]))
        if kind == "add":
            cell = next_cell
            next_cell += 1
            content = draw(st.text(alphabet="ABCDEFGabcdefg0123456789 ",
                                   min_size=1, max_size=6))
            plan_ops.append({"kind": "add", "cell": cell, "content": content})
            continue
        po = {"kind": kind, "target_frac": draw(st.floats(min_value=0.0, max_value=0.999,
                                                          allow_nan=False, allow_infinity=False))}
        if kind == "move":
            po["dx"] = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                                      allow_nan=False, allow_infinity=False))
            po["dy"] = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                                      allow_nan=False, allow_infinity=False))
        elif kind == "resize":
            po["sx"] = draw(st.floats(min_value=MIN_SCALE, max_value=MAX_SCALE,
                                      allow_nan=False, allow_infinity=False))
            po["sy"] = draw(st.floats(min_value=MIN_SCALE, max_value=MAX_SCALE,
                                      allow_nan=False, allow_infinity=False))
            po["anchor"] = draw(st.sampled_from(["nw", "ne", "sw", "se"]))
        elif kind == "rotate":
            po["theta"] = draw(st.floats(min_value=-180.0, max_value=180.0,
                                         allow_nan=False, allow_infinity=False))
        plan_ops.append(po)
    return specs, plan_ops


def _apply_sequence(session: EditSession, plan_ops):
    """Áp tuần tự chuỗi abstract op qua `apply_op`; trả danh sách kind ĐÃ áp."""
    applied: list[str] = []
    for plan_op in plan_ops:
        current_bytes = session.live_bytes or session.baseline_bytes
        op = _build_edit_op(plan_op["kind"], plan_op, current_bytes)
        if op is None:
            continue  # trang rỗng (đã xóa hết) → bỏ op cần mục tiêu.
        apply_op(session, op)
        applied.append(op.kind)
    return applied


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 4 — Undo/Redo idempotent theo cặp (Validates: Requirements 7.5)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(plan=_undo_redo_plan())
def test_undo_then_redo_round_trips_state(plan):
    """
    # Feature: pdf-edit-session, Property 4: Undo/Redo idempotent theo cặp — áp một
    # chuỗi Edit_Op qua phiên, ghi trạng thái ngay sau op cuối; Undo rồi Redo phải
    # đưa Live_Document về trạng thái TƯƠNG ĐƯƠNG: (kind, bbox) OpSpan trong
    # tolerance ≤ 1.0pt + multiset Color_Operators bằng nhau.
    """
    specs, plan_ops = plan
    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_live_session(pdf_bytes)
    try:
        applied = _apply_sequence(session, plan_ops)
        if not applied or not session.op_log:
            return  # không op nào áp được → không có gì để Undo/Redo.

        # Trạng thái NGAY SAU op cuối (Live_Document in-memory).
        after_op_bytes = session.live_bytes
        assert after_op_bytes is not None, "apply_op phải cache live_bytes sau khi áp."
        spans_after_op, colors_after_op = _signatures_from_bytes(after_op_bytes)

        # ── Undo op cuối rồi Redo lại op đó ──
        undo_res = undo(session)
        assert undo_res.get("noop") is not True, "Undo không được noop khi op_log có op."
        redo_res = redo(session)
        assert redo_res.get("noop") is not True, "Redo không được noop sau một Undo."

        # Trạng thái SAU undo→redo.
        after_redo_bytes = session.live_bytes
        assert after_redo_bytes is not None
        spans_after_redo, colors_after_redo = _signatures_from_bytes(after_redo_bytes)

        # (1) Nội dung hiển thị: OpSpan tương đương (BBox tolerance ≤ 1.0pt).
        _assert_spans_equivalent(spans_after_op, spans_after_redo, applied)

        # (2) Color_Operators: multiset bằng nhau tuyệt đối.
        assert colors_after_redo == colors_after_op, (
            f"Color_Operators KHÁC nhau sau undo→redo (ops={applied}):\n"
            f"  sau-op   = {dict(colors_after_op)}\n"
            f"  sau-redo = {dict(colors_after_redo)}"
        )
    finally:
        _cleanup_session(session)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _run_round_trip(specs, plan_ops):
    """Chạy chuỗi op + undo→redo cho (specs, plan_ops) cụ thể; trả các chữ ký."""
    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_live_session(pdf_bytes)
    try:
        applied = _apply_sequence(session, plan_ops)
        assert applied and session.op_log
        spans_after_op, colors_after_op = _signatures_from_bytes(session.live_bytes)
        undo(session)
        redo(session)
        spans_after_redo, colors_after_redo = _signatures_from_bytes(session.live_bytes)
        return (spans_after_op, colors_after_op, spans_after_redo,
                colors_after_redo, applied)
    finally:
        _cleanup_session(session)


def test_undo_redo_move_then_rotate_explicit():
    """move→rotate trên PDF CMYK+spot+ICC: undo→redo round-trips trạng thái."""
    specs = [
        {"cell": 0, "ctype": "cmyk"},
        {"cell": 1, "ctype": "spot"},
        {"cell": 2, "ctype": "icc"},
    ]
    plan_ops = [
        {"kind": "move", "target_frac": 0.0, "dx": 12.0, "dy": -8.0},
        {"kind": "rotate", "target_frac": 0.5, "theta": 30.0},
    ]
    s_op, c_op, s_re, c_re, applied = _run_round_trip(specs, plan_ops)
    _assert_spans_equivalent(s_op, s_re, applied)
    assert c_re == c_op


def test_undo_redo_delete_explicit():
    """delete 1 object có overprint+image: undo phục hồi, redo xóa lại — tương đương."""
    specs = [
        {"cell": 0, "ctype": "overprint"},
        {"cell": 1, "ctype": "image"},
        {"cell": 2, "ctype": "cmyk"},
    ]
    plan_ops = [{"kind": "delete", "target_frac": 0.99}]
    s_op, c_op, s_re, c_re, applied = _run_round_trip(specs, plan_ops)
    _assert_spans_equivalent(s_op, s_re, applied)
    assert c_re == c_op


def test_undo_redo_add_text_explicit():
    """add(text) vào ô trống: undo gỡ, redo thêm lại — OpSpan + màu tương đương."""
    specs = [
        {"cell": 0, "ctype": "cmyk"},
        {"cell": 1, "ctype": "spot"},
    ]
    plan_ops = [{"kind": "add", "cell": 2, "content": "Hi"}]
    s_op, c_op, s_re, c_re, applied = _run_round_trip(specs, plan_ops)
    _assert_spans_equivalent(s_op, s_re, applied)
    assert c_re == c_op
