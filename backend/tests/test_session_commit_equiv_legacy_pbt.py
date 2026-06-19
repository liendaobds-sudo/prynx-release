"""
Property-Based Test (Task 2.2 — spec `pdf-edit-session`).

# Feature: pdf-edit-session, Property 1: Tương đương in-memory ↔ commit (Round-trip
# / Model-based) — Với mọi chuỗi Edit_Op hợp lệ, áp qua phiên (apply_op) rồi commit
# cho Working_File tương đương với áp cùng chuỗi qua Legacy_Commit_Flow (apply_and_save
# tuần tự từng op): nội dung hiển thị + tập Color_Operators + BBox object liên quan
# trong tolerance ≤ 1.0pt.

**Validates: Requirements 2.1, 6.2, 11.2**

────────────────────────────────────────────────────────────────────────────
HAI ĐƯỜNG ĐƯỢC ĐỐI CHIẾU
- (A) PHIÊN  : `open_session` (mô phỏng cô lập DB) → `apply_op(session, op)` cho
  TỪNG op trên CÙNG một `pikepdf.Pdf` SỐNG trong RAM → `commit(session)` ghi đúng
  MỘT Working_File ở cuối chuỗi.
- (B) LEGACY : `edit_io.apply_and_save` TUẦN TỰ từng op — mỗi op MỞ LẠI file kết
  quả của op trước, áp op, LƯU một Working_File mới; file cuối là kết quả.

Điểm khác biệt thực chất giữa hai đường (mục tiêu kiểm): đường (A) giữ document
SỐNG và `save()` nhiều lần trên cùng đối tượng pikepdf rồi chỉ commit 1 lần; đường
(B) mở-sửa-lưu rời rạc mỗi op. Mỗi BƯỚC mutate dùng CHUNG logic
`edit_session._apply_op_to_pdf` (đúng như route Legacy của `pdf-object-edit` cũng
dùng `stream_editor.*`), nên phép so sánh tập trung vào tương đương của LUỒNG, không
phải tái cài đặt `stream_editor`.

ĐỐI CHIẾU EQUIVALENCE (design "Đối chiếu equivalence")
Mở lại trang 0 của hai Working_File bằng pikepdf rồi so:
  1. NỘI DUNG HIỂN THỊ: multiset chữ ký (kind, bbox) của các OpSpan
     (`build_op_spans`) — đối khớp BBox trong tolerance ≤ 1.0pt.
  2. COLOR_OPERATORS: multiset (operator, operands chuẩn hóa) của
     `k/K/scn/SCN/cs/CS/rg/RG/g/G` trong content stream (`parse_page_ops`).
  3. ĐỊNH NGHĨA COLORSPACE: tập tên `/Separation` + `/ICCBased` trong
     `/Resources/ColorSpace` giữ nguyên giữa hai đường.

CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis) — TÁI DÙNG/MỞ RỘNG generator màu in của
`pdf-object-edit`
- PDF in-memory 1 trang, mỗi object ở MỘT ô lưới riêng (CELL=150 ≫ kích thước
  object kể cả sau resize ≤2× / rotate) → bbox KHÔNG chồng nhau → `Object_Mapper`
  đối khớp DUY NHẤT (tránh fallback đối khớp).
- Loại màu mỗi object ∈ {CMYK `k`, spot `/Separation … scn`, `/ICCBased … scn`,
  overprint `/GS gs` + `k`, image `Do`} — phủ CMYK/spot/overprint/ICC như yêu cầu.
- Chuỗi Edit_Op hợp lệ ∈ {move, resize, rotate, delete, add(text)}; thao tác có
  mục tiêu chọn theo chỉ số thứ-tự-vẽ trong lần liệt kê hiện tại; `add` đặt object
  mới vào MỘT ô lưới TRỐNG (không chồng) để các op sau vẫn map DUY NHẤT.
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys
import tempfile
import threading
from collections import Counter
from io import BytesIO
from string import ascii_letters, digits
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.config import settings as app_settings
from app.core import edit_io, edit_session
from app.core.edit_session import (
    EditSession,
    _apply_op_to_pdf,
    _list_objects_from_bytes,
    apply_op,
    commit,
)
from app.core.object_mapper import _as_float, _name_str, build_op_spans, parse_page_ops
from app.schemas.edit import (
    BBOX_TOLERANCE_PT,
    EditOp,
    ImagePayload,
    MoveDelta,
    ResizeScale,
    TextPayload,
    normalize_bbox,
)

# ── Hằng số layout (đồng bộ các PBT khác của hai spec) ───────────────────────
PAGE_W = 760.0
PAGE_H = 620.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0
TOL = BBOX_TOLERANCE_PT  # 1.0pt

# Loại object/màu được sinh — phủ CMYK / spot / ICCBased / overprint / image.
OBJ_TYPES = ["cmyk", "spot", "icc", "overprint", "image"]

# Color_Operators cần đối chiếu (glossary `pdf-edit-session`).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G"}

# Ràng buộc tham số op để object KHÔNG va sang ô lưới khác (giữ map DUY NHẤT).
MAX_SHIFT = 30.0          # |dx|,|dy| ≤ 30pt ≪ bước lưới 150pt.
MIN_SCALE, MAX_SCALE = 0.5, 2.0  # 40×30 × 2 = 80×60 ≪ 150pt.

# ICC profile thật (bundle) để `/ICCBased` hợp lệ tuyệt đối.
_ICC_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "assets", "icc", "sRGB.icc")


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


def _make_icc_cs(pdf: pikepdf.Pdf, icc_bytes: bytes) -> pikepdf.Object:
    """ColorSpace `/ICCBased` (N=3, alternate DeviceRGB) từ ICC profile thật."""
    icc = pikepdf.Stream(pdf, icc_bytes)
    icc[pikepdf.Name("/N")] = 3
    icc[pikepdf.Name("/Alternate")] = pikepdf.Name("/DeviceRGB")
    return pdf.make_indirect(pikepdf.Array([pikepdf.Name("/ICCBased"), icc]))


def _make_overprint_gs(pdf: pikepdf.Pdf) -> pikepdf.Object:
    """ExtGState bật overprint (OP/op/OPM)."""
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/ExtGState"), OP=True, op=True, OPM=1,
    ))


def _build_pdf_bytes(specs, icc_bytes: bytes) -> bytes:
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
            cs_dict[pikepdf.Name(f"/Icc{cell}")] = _make_icc_cs(pdf, icc_bytes)
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


# ── Trích chữ ký trạng thái để đối chiếu ─────────────────────────────────────
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
    """Danh sách (kind, bbox-đã-normalize) của các OpSpan vector/image trên trang."""
    out = []
    for span in build_op_spans(page, pdf=pdf):
        if span.kind in ("vector", "image"):
            out.append((span.kind, tuple(normalize_bbox(list(span.bbox)))))
    return out


def _colorspace_names(page) -> set:
    """Tập tên colorspace `/Separation`+`/ICCBased` trong `/Resources/ColorSpace`."""
    resources = page.obj.get("/Resources")
    if resources is None:
        return set()
    cs = resources.get("/ColorSpace")
    if cs is None:
        return set()
    return {str(k) for k in cs.keys()}


def _open_signatures(path):
    """Mở `path`, trả (spans, color_counter, colorspace_names) của trang 0."""
    with pikepdf.Pdf.open(path) as pdf:
        page = pdf.pages[0]
        return _spans(page, pdf), _color_op_counter(page), _colorspace_names(page)


def _assert_spans_equivalent(spans_a, spans_b, op_summary):
    """
    Đối khớp greedy hai danh sách (kind, bbox): mỗi span ở A phải có một span CÙNG
    kind ở B với BBox trong tolerance ≤ 1.0pt; số lượng phải bằng nhau.
    """
    assert len(spans_a) == len(spans_b), (
        f"Số OpSpan khác nhau giữa hai đường (ops={op_summary}): "
        f"phiên={len(spans_a)} legacy={len(spans_b)}"
    )
    remaining = list(spans_b)
    for kind, bbox in spans_a:
        match_idx = None
        for j, (k2, bb2) in enumerate(remaining):
            if k2 == kind and all(abs(bbox[i] - bb2[i]) <= TOL for i in range(4)):
                match_idx = j
                break
        assert match_idx is not None, (
            f"OpSpan {(kind, bbox)} của đường PHIÊN không có span tương ứng "
            f"(tolerance ≤ {TOL}pt) ở đường LEGACY (ops={op_summary}). "
            f"Còn lại legacy={remaining}"
        )
        remaining.pop(match_idx)
    assert not remaining, (
        f"Đường LEGACY còn span dư không khớp phiên (ops={op_summary}): {remaining}"
    )


# ── Driver đường PHIÊN (A) ───────────────────────────────────────────────────
def _build_edit_op(kind: str, plan_op: dict, current_bytes: bytes):
    """
    Dựng một `EditOp` HỢP LỆ từ một abstract op `plan_op` + trạng thái BYTES hiện
    tại (resolve target theo chỉ số thứ-tự-vẽ trong lần liệt kê). Trả None nếu op
    cần mục tiêu nhưng trang không còn object nào.
    """
    if kind == "add":
        cell = plan_op["cell"]
        x, y, w, h = _rect_for(cell)
        bbox = [x, y, x + w, y + h]
        return EditOp(page=0, kind="add",
                      text=TextPayload(content=plan_op["content"], bbox=bbox, sizePt=10.0))

    metas = _list_objects_from_bytes(current_bytes, 0)
    ordered = sorted(metas.values(), key=lambda m: m.drawIndex)
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


def _run_session_path(baseline_bytes, source_path, plan_ops, sid, fid):
    """
    Đường (A): tạo EditSession SỐNG (cô lập DB), `apply_op` từng op rồi `commit`.

    Trả `(committed_path, applied_ops)` — `applied_ops` là danh sách `EditOp` ĐÃ áp
    thành công (dùng lại NGUYÊN VẸN cho đường Legacy để bảo đảm cùng chuỗi thao tác).
    """
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path=source_path,
        pdf=pikepdf.Pdf.open(BytesIO(baseline_bytes)),
        baseline_bytes=baseline_bytes,
        lock=threading.Lock(),
        live_bytes=None,
        dirty=False,
    )
    edit_session.SESSIONS[sid] = session
    edit_session.by_fid[fid] = sid

    applied_ops: list[EditOp] = []
    try:
        for plan_op in plan_ops:
            current_bytes = session.live_bytes or session.baseline_bytes
            op = _build_edit_op(plan_op["kind"], plan_op, current_bytes)
            if op is None:
                continue  # trang rỗng (đã xóa hết) → bỏ qua op cần mục tiêu.
            apply_op(session, op)        # Apply_In_Memory trên Live_Document.
            applied_ops.append(op)

        # Defer_Commit: chỉ ghi đĩa MỘT lần ở cuối chuỗi (Yêu cầu 2.1, 5.1).
        with mock.patch.object(edit_session, "_resolve_original_name",
                               return_value="EquivDoc.pdf"), \
             mock.patch("app.api.routes.edit._register_working_file",
                        side_effect=lambda path, name: f"fid-{os.path.basename(path)}"):
            result = commit(session)
        return result["output_path"], applied_ops
    finally:
        edit_session.SESSIONS.pop(sid, None)
        edit_session.by_fid.pop(fid, None)
        try:
            session.pdf.close()
        except Exception:
            pass


# ── Driver đường LEGACY (B) ──────────────────────────────────────────────────
def _legacy_mutate_for(op: EditOp):
    """
    mutate_fn cho `apply_and_save`: liệt kê object TỪ BYTES hiện tại của document
    rồi áp `op` qua CÙNG logic `_apply_op_to_pdf` (như route Legacy dùng stream_editor).
    """
    def _mutate(pdf: pikepdf.Pdf):
        buf = BytesIO()
        pdf.save(buf, compress_streams=False)
        by_id = _list_objects_from_bytes(buf.getvalue(), op.page)
        return _apply_op_to_pdf(pdf, op, by_id)
    return _mutate


def _run_legacy_path(baseline_path, applied_ops, tmp_dir):
    """
    Đường (B) Legacy_Commit_Flow: áp TUẦN TỰ từng op qua `edit_io.apply_and_save`,
    mỗi op MỞ LẠI file kết quả của op trước. Trả đường dẫn file cuối.
    """
    current = baseline_path
    for k, op in enumerate(applied_ops):
        out_path = os.path.join(tmp_dir, f"legacy_{k}.pdf")
        saved, _res = edit_io.apply_and_save(
            current, _legacy_mutate_for(op), output_path=out_path
        )
        current = saved
    return current


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _equiv_plan(draw):
    """
    Sinh (specs, plan_ops):
      - specs    : object khởi tạo (cell 0..n-1) với loại màu ngẫu nhiên.
      - plan_ops : chuỗi abstract op hợp lệ; `add` cấp một ô lưới TRỐNG (không chồng).
    """
    n = draw(st.integers(min_value=2, max_value=4))
    specs = [{"cell": i, "ctype": draw(st.sampled_from(OBJ_TYPES))} for i in range(n)]
    next_cell = n

    m = draw(st.integers(min_value=1, max_value=4))
    plan_ops = []
    for _ in range(m):
        kind = draw(st.sampled_from(["move", "resize", "rotate", "delete", "add"]))
        if kind == "add":
            cell = next_cell
            next_cell += 1
            content = draw(st.text(alphabet=ascii_letters + digits + " ",
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


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 1 — Tương đương in-memory ↔ commit so với Legacy
#  (Validates: Requirements 2.1, 6.2, 11.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(plan=_equiv_plan())
def test_session_commit_equivalent_to_legacy(plan):
    """
    # Feature: pdf-edit-session, Property 1: áp chuỗi Edit_Op qua phiên (apply_op)
    # rồi commit ≡ áp cùng chuỗi qua Legacy (apply_and_save tuần tự) — nội dung
    # hiển thị + Color_Operators + BBox trong tolerance ≤ 1.0pt.

    Cùng một chuỗi Edit_Op (do đường PHIÊN dựng và áp thành công) được áp lại
    NGUYÊN VẸN qua đường LEGACY; hai Working_File kết quả phải tương đương về:
    OpSpan (kind, bbox ≤ 1.0pt) + multiset Color_Operators + tập colorspace.
    """
    specs, plan_ops = plan
    with open(_ICC_PATH, "rb") as fh:
        icc_bytes = fh.read()
    baseline_bytes = _build_pdf_bytes(specs, icc_bytes)

    with tempfile.TemporaryDirectory() as tmp:
        baseline_path = os.path.join(tmp, "baseline.pdf")
        with open(baseline_path, "wb") as fh:
            fh.write(baseline_bytes)
        baseline_snapshot = bytes(baseline_bytes)

        sid = "equiv-sid"
        fid = "equiv-fid"
        committed_path, applied_ops = _run_session_path(
            baseline_bytes, baseline_path, plan_ops, sid, fid
        )

        try:
            # Không op nào áp được (vd. xóa hết ngay từ đầu rồi chỉ còn op cần
            # mục tiêu) → commit ra bản sao baseline; legacy cũng = baseline.
            if not applied_ops:
                legacy_path = baseline_path
            else:
                legacy_path = _run_legacy_path(baseline_path, applied_ops, tmp)

            # File gốc KHÔNG bị đè bởi cả hai đường (Yêu cầu 6.2 / không ghi đè gốc).
            assert open(baseline_path, "rb").read() == baseline_snapshot, \
                "File gốc bị thay đổi — vi phạm bất biến KHÔNG ghi đè gốc."

            spans_s, colors_s, cs_s = _open_signatures(committed_path)
            spans_l, colors_l, cs_l = _open_signatures(legacy_path)

            op_summary = [o.kind for o in applied_ops]

            # (1) Nội dung hiển thị: OpSpan tương đương (BBox tolerance ≤ 1.0pt).
            _assert_spans_equivalent(spans_s, spans_l, op_summary)

            # (2) Color_Operators: multiset bằng nhau tuyệt đối.
            assert colors_s == colors_l, (
                f"Color_Operators KHÁC nhau giữa phiên và legacy (ops={op_summary}):\n"
                f"  phiên  = {dict(colors_s)}\n  legacy = {dict(colors_l)}"
            )

            # (3) Định nghĩa colorspace (/Separation, /ICCBased) giữ nguyên.
            assert cs_s == cs_l, (
                f"Tập colorspace KHÁC nhau (ops={op_summary}): "
                f"phiên={cs_s} legacy={cs_l}"
            )
        finally:
            try:
                if committed_path and os.path.exists(committed_path):
                    os.remove(committed_path)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _run_both(specs, plan_ops):
    """Chạy cả hai đường cho (specs, plan_ops) cụ thể; trả ba cặp chữ ký + ops."""
    with open(_ICC_PATH, "rb") as fh:
        icc_bytes = fh.read()
    baseline_bytes = _build_pdf_bytes(specs, icc_bytes)
    with tempfile.TemporaryDirectory() as tmp:
        baseline_path = os.path.join(tmp, "baseline.pdf")
        with open(baseline_path, "wb") as fh:
            fh.write(baseline_bytes)
        committed_path, applied_ops = _run_session_path(
            baseline_bytes, baseline_path, plan_ops, "equiv-sid-x", "equiv-fid-x"
        )
        try:
            legacy_path = (baseline_path if not applied_ops
                           else _run_legacy_path(baseline_path, applied_ops, tmp))
            sig_s = _open_signatures(committed_path)
            sig_l = _open_signatures(legacy_path)
            return sig_s, sig_l, [o.kind for o in applied_ops]
        finally:
            try:
                if committed_path and os.path.exists(committed_path):
                    os.remove(committed_path)
            except OSError:
                pass


def test_equiv_move_then_rotate_explicit():
    """Chuỗi move→rotate trên PDF CMYK+spot+ICC: hai đường cho kết quả tương đương."""
    specs = [
        {"cell": 0, "ctype": "cmyk"},
        {"cell": 1, "ctype": "spot"},
        {"cell": 2, "ctype": "icc"},
    ]
    plan_ops = [
        {"kind": "move", "target_frac": 0.0, "dx": 12.0, "dy": -8.0},
        {"kind": "rotate", "target_frac": 0.5, "theta": 30.0},
    ]
    (spans_s, colors_s, cs_s), (spans_l, colors_l, cs_l), ops = _run_both(specs, plan_ops)
    _assert_spans_equivalent(spans_s, spans_l, ops)
    assert colors_s == colors_l
    assert cs_s == cs_l


def test_equiv_delete_then_add_explicit():
    """Chuỗi delete→add(text) trên PDF có overprint+image: hai đường tương đương."""
    specs = [
        {"cell": 0, "ctype": "overprint"},
        {"cell": 1, "ctype": "image"},
        {"cell": 2, "ctype": "cmyk"},
    ]
    plan_ops = [
        {"kind": "delete", "target_frac": 0.99},
        {"kind": "add", "cell": 3, "content": "Hi"},
    ]
    (spans_s, colors_s, cs_s), (spans_l, colors_l, cs_l), ops = _run_both(specs, plan_ops)
    _assert_spans_equivalent(spans_s, spans_l, ops)
    assert colors_s == colors_l
    assert cs_s == cs_l
