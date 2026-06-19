"""
Property-Based Test (Task 2.3 — spec `pdf-edit-session`).

# Feature: pdf-edit-session, Property 2: Bảo toàn màu Untouched_Object (Invariant) —
# Với mọi Edit_Op Apply_In_Memory, tập Color_Operators (k/K, scn/SCN, cs/CS,
# rg/RG, g/G, overprint OP/op/OPM) và nội dung của mọi Untouched_Object bằng nhau
# trước/sau thao tác — cả ở trạng thái in-memory lẫn sau Commit.

**Validates: Requirements 2.6, 6.2**

────────────────────────────────────────────────────────────────────────────
Ý TƯỞNG KIỂM CHỨNG (qua engine phiên `app/core/edit_session.py` THẬT)
- Sinh PDF in-memory có MÀU IN đa dạng: CMYK `k`, spot `scn` (Separation),
  gray `g`, RGB `rg`, ICCBased `scn` (/ICCBased) và overprint (`gs` → ExtGState
  /OP /op /OPM). Mỗi object là một nhóm cô lập `q … Q` trong MỘT ô lưới riêng
  (CELL=150) → bbox KHÔNG chồng nhau và MÀU mỗi object DUY NHẤT (toán tử màu mang
  operand khác nhau theo ô) → dễ tách "object mục tiêu" khỏi Untouched_Object.
- Mở phiên (EditSession sống trong SESSIONS), resolve target THẬT qua
  Geometry_Reader (PDFium read-only) rồi `apply_op` MỘT Edit_Op
  (move/resize/rotate/delete) tác động ĐÚNG MỘT object.
- PROPERTY: tập (chữ ký nội dung) + multiset Color_Operators của các
  Untouched_Object (mọi object KHÁC target) BẰNG NHAU giữa:
      (a) trước thao tác,
      (b) sau `apply_op` (in-memory, đọc `session.live_bytes`),
      (c) sau `commit` (đọc Working_File ghi ra đĩa).
- Trích Color_Operators + nội dung TỪNG object bằng `pikepdf.parse_content_stream`,
  tách theo từng nhóm `q … Q` (mỗi nhóm = một object). Object mục tiêu bị loại
  khỏi phép so sánh nhờ MÀU duy nhất của nó (operand màu không trùng object khác).

CÔ LẬP DB: tầng đăng ký Working_File (DB) bị monkeypatch như `test_session_commit.py`;
file vẫn được GHI THẬT qua pikepdf nên bất biến "không đổi màu sau Commit" là thật.
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
from pikepdf import Array, Dictionary, Name

from app.core import edit_session, geometry_reader
from app.core.edit_session import EditSession, apply_op, commit
from app.schemas.edit import EditOp, MoveDelta, ResizeScale

# ── Hằng số layout (đồng bộ các PBT khác của hệ) ─────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

# Tập operator màu cần bảo toàn (Color_Operators — glossary / Yêu cầu 6).
# (overprint OP/op/OPM nằm trong ExtGState áp qua `gs`; tính nhất quán của chúng
#  được bảo đảm qua việc giữ nguyên toán tử `gs` của Untouched_Object + tài nguyên
#  ExtGState — kiểm ở `_assert_referenced_resources_present`.)
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G"}

# Ràng buộc tham số thao tác để object KHÔNG va sang ô lưới khác (giữ map DUY NHẤT).
MAX_SHIFT = 30.0
MIN_SCALE = 0.5
MAX_SCALE = 2.0

# Các loại object mang màu in (đa dạng colorspace + overprint).
SUBTYPES = ["cmyk", "cmyk_op", "rgb", "gray", "spot", "icc"]

# ICC profile thật (sRGB, N=3) để dựng /ICCBased colorspace hợp lệ.
_ICC_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "assets", "icc", "sRGB.icc")
with open(_ICC_PATH, "rb") as _fh:
    _ICC_BYTES = _fh.read()


# ── Hình học ô lưới ──────────────────────────────────────────────────────────
def _rect_for(cell: int):
    """(x, y, w, h) cho object ở ô lưới `cell` (KHÔNG chồng nhau)."""
    x = 30.0 + (cell % COLS) * CELL
    y = 30.0 + (cell // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(cell: int):
    x, y, w, h = _rect_for(cell)
    return [x, y, x + w, y + h]


def _tint(cell: int) -> float:
    """Thành phần màu DUY NHẤT theo ô (≤ ~0.2 với ô < 6 → hợp lệ 0..1)."""
    return round(0.05 + 0.03 * cell, 4)


# ── Dựng fragment + tài nguyên ───────────────────────────────────────────────
def _color_fragment(cell: int, subtype: str) -> str:
    """Đoạn `q … Q` cho object ô `cell` theo `subtype` (màu DUY NHẤT theo ô)."""
    x, y, w, h = _rect_for(cell)
    rect = f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re\nf\n"
    v = _tint(cell)
    if subtype == "cmyk":
        return f"q\n{v:.4f} 0.2000 0.3000 0.4000 k\n{rect}Q\n"
    if subtype == "cmyk_op":
        # overprint qua ExtGState /GSop + fill CMYK.
        return f"q\n/GSop gs\n{v:.4f} 0.2000 0.3000 0.4000 k\n{rect}Q\n"
    if subtype == "rgb":
        return f"q\n{v:.4f} 0.3000 0.4000 rg\n{rect}Q\n"
    if subtype == "gray":
        return f"q\n{v:.4f} g\n{rect}Q\n"
    if subtype == "spot":
        return f"q\n/Sep{cell} cs\n{v:.4f} scn\n{rect}Q\n"
    if subtype == "icc":
        return f"q\n/CsIcc{cell} cs\n{v:.4f} 0.4000 0.5000 scn\n{rect}Q\n"
    raise AssertionError(f"subtype không hỗ trợ: {subtype}")


def _make_separation(pdf: pikepdf.Pdf, cell: int):
    """Colorspace Separation /Sep{cell} (DeviceCMYK alternate, tint type-2)."""
    func = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=[0, 1],
        C0=[0, 0, 0, 0], C1=[0.1, 0.9, 0.8, 0.0], N=1,
    ))
    return Array([Name("/Separation"), Name(f"/Spot{cell}"), Name("/DeviceCMYK"), func])


def _make_iccbased(pdf: pikepdf.Pdf):
    """Colorspace /ICCBased (N=3, sRGB thật)."""
    st = pikepdf.Stream(pdf, _ICC_BYTES)
    st[Name("/N")] = 3
    st[Name("/Alternate")] = Name("/DeviceRGB")
    return Array([Name("/ICCBased"), pdf.make_indirect(st)])


def _build_pdf_bytes(specs) -> bytes:
    """Dựng PDF 1 trang theo `specs` (list {cell, subtype}); trả BYTES."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    cs_dict = Dictionary()
    egs_dict = Dictionary()
    fragments = []
    need_overprint = False

    for spec in specs:
        cell, subtype = spec["cell"], spec["subtype"]
        fragments.append(_color_fragment(cell, subtype))
        if subtype == "spot":
            cs_dict[Name(f"/Sep{cell}")] = pdf.make_indirect(_make_separation(pdf, cell))
        elif subtype == "icc":
            cs_dict[Name(f"/CsIcc{cell}")] = pdf.make_indirect(_make_iccbased(pdf))
        elif subtype == "cmyk_op":
            need_overprint = True

    if need_overprint:
        egs_dict[Name("/GSop")] = pdf.make_indirect(Dictionary(
            Type=Name("/ExtGState"), OP=True, op=True, OPM=1,
        ))

    resources = Dictionary()
    if len(cs_dict.keys()):
        resources[Name("/ColorSpace")] = cs_dict
    if len(egs_dict.keys()):
        resources[Name("/ExtGState")] = egs_dict
    page.obj[Name("/Resources")] = resources
    page.obj[Name("/Contents")] = pdf.make_stream("".join(fragments).encode("latin-1"))

    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


# ── Trích nội dung + màu TỪNG object (nhóm `q … Q`) ─────────────────────────
def _norm_operand(o):
    """Khóa operand: số → làm tròn 4 chữ số; tên → chuỗi (vd '/Sep0')."""
    try:
        return round(float(o), 4)
    except (TypeError, ValueError):
        return str(o)


def _object_blocks(pdf_bytes: bytes) -> list[tuple]:
    """
    Tách content stream trang 0 thành danh sách "object block" — mỗi nhóm `q … Q`
    cấp ngoài cùng là một object. Mỗi block = tuple các (operator, operands-chuẩn-hóa).
    """
    blocks: list[tuple] = []
    with pikepdf.Pdf.open(BytesIO(pdf_bytes)) as pdf:
        page = pdf.pages[0]
        cur: list | None = None
        depth = 0
        for operands, operator in pikepdf.parse_content_stream(page):
            ops = str(operator)
            if ops == "q":
                depth += 1
                if depth == 1:
                    cur = []
                    continue
            if ops == "Q":
                depth -= 1
                if depth == 0 and cur is not None:
                    blocks.append(tuple(cur))
                    cur = None
                    continue
            if cur is not None:
                cur.append((ops, tuple(_norm_operand(o) for o in operands)))
    return blocks


def _block_color_counter(block: tuple) -> Counter:
    """Multiset Color_Operators trong một object block."""
    c: Counter = Counter()
    for op, operands in block:
        if op in COLOR_OPS:
            c[(op, operands)] += 1
    return c


def _untouched_signature(pdf_bytes: bytes, target_colors: Counter):
    """
    Trả (Counter chữ-ký-nội-dung, Counter Color_Operators) của các Untouched_Object
    = mọi object block KHÔNG chia sẻ toán tử màu DUY NHẤT nào với object mục tiêu.

    Object mục tiêu được nhận diện qua màu duy nhất của nó (`target_colors`); mọi
    block khác là Untouched_Object. Dùng cho cả ba trạng thái: trước / in-memory / commit.
    """
    block_sig: Counter = Counter()
    color_sig: Counter = Counter()
    for block in _object_blocks(pdf_bytes):
        bc = _block_color_counter(block)
        # Chia sẻ bất kỳ toán tử màu duy nhất nào với target → đây là object mục tiêu.
        if any(bc.get(k, 0) > 0 for k in target_colors):
            continue
        block_sig[block] += 1
        for k, n in bc.items():
            color_sig[k] += n
    return block_sig, color_sig


def _referenced_resource_names(pdf_bytes: bytes, target_colors: Counter) -> set[str]:
    """Tên tài nguyên (vd /Sep1, /CsIcc2, /GSop) được Untouched_Object tham chiếu."""
    names: set[str] = set()
    for block in _object_blocks(pdf_bytes):
        bc = _block_color_counter(block)
        if any(bc.get(k, 0) > 0 for k in target_colors):
            continue  # bỏ qua object mục tiêu
        for op, operands in block:
            if op in ("cs", "CS", "gs"):
                for o in operands:
                    if isinstance(o, str) and o.startswith("/"):
                        names.add(o)
    return names


def _all_resource_names(pdf_bytes: bytes) -> set[str]:
    """Tập tên trong /Resources/ColorSpace ∪ /ExtGState của trang 0."""
    names: set[str] = set()
    with pikepdf.Pdf.open(BytesIO(pdf_bytes)) as pdf:
        res = pdf.pages[0].obj.get("/Resources", Dictionary())
        for sub in ("/ColorSpace", "/ExtGState"):
            d = res.get(sub, None)
            if d is not None:
                names.update(str(k) for k in d.keys())
    return names


# ── Session helpers (cô lập DB như test_session_commit.py) ──────────────────
def _make_session(tmp_path, pdf_bytes: bytes) -> EditSession:
    """Tạo EditSession sống (đăng ký vào SESSIONS) + file gốc thật trên đĩa."""
    sid = "color-pbt-" + uuid.uuid4().hex
    fid = "fid-color-" + uuid.uuid4().hex
    source_path = os.path.join(str(tmp_path), f"src_{sid}.pdf")
    with open(source_path, "wb") as fh:
        fh.write(pdf_bytes)
    pdf = pikepdf.Pdf.open(BytesIO(pdf_bytes))
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path=source_path,
        pdf=pdf,
        baseline_bytes=pdf_bytes,
        lock=threading.Lock(),
        live_bytes=pdf_bytes,
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
    except Exception:
        pass
    try:
        os.remove(session.source_path)
    except OSError:
        pass


def _patch_registration(monkeypatch):
    """Cô lập tầng DB (đặt tên + đăng ký Working_File) — KHÔNG cần DB thật."""
    monkeypatch.setattr(edit_session, "_resolve_original_name", lambda fid: "ColorDoc.pdf")
    import app.api.routes.edit as edit_route
    monkeypatch.setattr(edit_route, "_register_working_file",
                        lambda path, name: "fid-out-" + uuid.uuid4().hex)


def _save_bytes(pdf: pikepdf.Pdf) -> bytes:
    buf = BytesIO()
    pdf.save(buf, compress_streams=False)
    return buf.getvalue()


def _match_target_id(metas, cell: int) -> str | None:
    """Tìm id object Geometry_Reader khớp ô `cell` (theo tâm bbox, gần nhất < 50pt)."""
    cx = (_bbox_for(cell)[0] + _bbox_for(cell)[2]) / 2.0
    cy = (_bbox_for(cell)[1] + _bbox_for(cell)[3]) / 2.0
    best, best_d = None, 1e9
    for m in metas:
        mx = (m.bbox[0] + m.bbox[2]) / 2.0
        my = (m.bbox[1] + m.bbox[3]) / 2.0
        d = abs(mx - cx) + abs(my - cy)
        if d < best_d:
            best, best_d = m, d
    if best is not None and best_d < 50.0:
        return best.id
    return None


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _color_plan(draw):
    """
    Sinh (specs, target_cell, op_params): danh sách object màu + MỘT thao tác trên
    object ở `target_cell`.
    """
    n = draw(st.integers(min_value=2, max_value=6))
    specs = [{"cell": j, "subtype": draw(st.sampled_from(SUBTYPES))} for j in range(n)]
    target_cell = draw(st.integers(min_value=0, max_value=n - 1))

    kind = draw(st.sampled_from(["move", "resize", "rotate", "delete"]))
    op = {"kind": kind}
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
    return specs, target_cell, op


def _build_edit_op(kind: str, target_id: str, op: dict) -> EditOp:
    if kind == "move":
        return EditOp(page=0, kind="move", targetIds=[target_id],
                      delta=MoveDelta(dx=op["dx"], dy=op["dy"]))
    if kind == "resize":
        return EditOp(page=0, kind="resize", targetIds=[target_id],
                      scale=ResizeScale(sx=op["sx"], sy=op["sy"], anchor=op["anchor"]))
    if kind == "rotate":
        return EditOp(page=0, kind="rotate", targetIds=[target_id], rotateDeg=op["theta"])
    if kind == "delete":
        return EditOp(page=0, kind="delete", targetIds=[target_id])
    raise AssertionError(kind)


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 2 — Bảo toàn màu Untouched_Object (Validates: Requirements 2.6, 6.2)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(plan=_color_plan())
def test_untouched_object_color_preserved(plan, tmp_path, monkeypatch):
    """
    # Feature: pdf-edit-session, Property 2: Bảo toàn màu Untouched_Object — tập
    # Color_Operators + nội dung của mọi Untouched_Object bằng nhau trước/sau
    # apply_op (in-memory) và sau commit.
    """
    specs, target_cell, op = plan
    _patch_registration(monkeypatch)

    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_session(tmp_path, pdf_bytes)
    committed_path = None
    try:
        # BYTES đúng như engine sẽ dùng để resolve target (PDFium read-only).
        live0 = _save_bytes(session.pdf)
        metas = geometry_reader.list_objects(live0, 0, include_text_props=False)
        target_id = _match_target_id(metas, target_cell)
        if target_id is None:
            return  # PDFium không tách được object ở ô này (hiếm) → bỏ qua ví dụ.

        # Màu DUY NHẤT của object mục tiêu (để loại nó khỏi tập Untouched_Object).
        before_blocks = _object_blocks(live0)
        if target_cell >= len(before_blocks):
            return
        target_colors = _block_color_counter(before_blocks[target_cell])
        assert target_colors, "Object mục tiêu phải mang ít nhất một Color_Operator"

        # Chữ ký Untouched_Object TRƯỚC thao tác.
        before_bs, before_cs = _untouched_signature(live0, target_colors)
        before_refs = _referenced_resource_names(live0, target_colors)

        # ── Apply_In_Memory MỘT Edit_Op tác động đúng object mục tiêu ──
        edit_op = _build_edit_op(op["kind"], target_id, op)
        apply_op(session, edit_op)

        # (b) Untouched_Object SAU apply_op (in-memory).
        mem_bs, mem_cs = _untouched_signature(session.live_bytes, target_colors)
        assert mem_bs == before_bs, (
            f"[in-memory] nội dung Untouched_Object đổi sau op={op['kind']}: "
            f"before={dict(before_bs)} after={dict(mem_bs)}"
        )
        assert mem_cs == before_cs, (
            f"[in-memory] Color_Operators của Untouched_Object đổi sau op={op['kind']}: "
            f"before={dict(before_cs)} after={dict(mem_cs)}"
        )

        # (c) Untouched_Object SAU commit (đọc Working_File ghi ra đĩa).
        result = commit(session)
        committed_path = result["output_path"]
        commit_bytes = open(committed_path, "rb").read()

        commit_bs, commit_cs = _untouched_signature(commit_bytes, target_colors)
        assert commit_bs == before_bs, (
            f"[commit] nội dung Untouched_Object đổi sau op={op['kind']}: "
            f"before={dict(before_bs)} after={dict(commit_bs)}"
        )
        assert commit_cs == before_cs, (
            f"[commit] Color_Operators của Untouched_Object đổi sau op={op['kind']}: "
            f"before={dict(before_cs)} after={dict(commit_cs)}"
        )

        # Tài nguyên colorspace/overprint mà Untouched_Object tham chiếu vẫn còn
        # sau commit (định nghĩa màu không bị strip → màu in được bảo toàn thật).
        commit_res = _all_resource_names(commit_bytes)
        missing = before_refs - commit_res
        assert not missing, (
            f"[commit] mất tài nguyên màu của Untouched_Object: {missing}"
        )
    finally:
        _cleanup_session(session)
        if committed_path:
            try:
                os.remove(committed_path)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _run_once(tmp_path, monkeypatch, specs, target_cell, op):
    _patch_registration(monkeypatch)
    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_session(tmp_path, pdf_bytes)
    committed_path = None
    try:
        live0 = _save_bytes(session.pdf)
        metas = geometry_reader.list_objects(live0, 0, include_text_props=False)
        target_id = _match_target_id(metas, target_cell)
        assert target_id is not None
        before_blocks = _object_blocks(live0)
        target_colors = _block_color_counter(before_blocks[target_cell])
        before_bs, before_cs = _untouched_signature(live0, target_colors)

        apply_op(session, _build_edit_op(op["kind"], target_id, op))
        mem_bs, mem_cs = _untouched_signature(session.live_bytes, target_colors)
        assert mem_bs == before_bs and mem_cs == before_cs

        result = commit(session)
        committed_path = result["output_path"]
        commit_bytes = open(committed_path, "rb").read()
        commit_bs, commit_cs = _untouched_signature(commit_bytes, target_colors)
        assert commit_bs == before_bs and commit_cs == before_cs
        return before_cs
    finally:
        _cleanup_session(session)
        if committed_path:
            try:
                os.remove(committed_path)
            except OSError:
                pass


def test_move_preserves_untouched_cmyk_and_spot(tmp_path, monkeypatch):
    """Move 1 object CMYK: các object spot/icc/rgb còn lại giữ nguyên màu + nội dung."""
    specs = [
        {"cell": 0, "subtype": "cmyk"},
        {"cell": 1, "subtype": "spot"},
        {"cell": 2, "subtype": "icc"},
        {"cell": 3, "subtype": "rgb"},
    ]
    op = {"kind": "move", "dx": 12.0, "dy": -9.0}
    before_cs = _run_once(tmp_path, monkeypatch, specs, target_cell=0, op=op)
    # Còn lại spot (cs+scn), icc (cs+scn), rgb (rg) — đều phải có mặt trong tập màu.
    assert any(k[0] == "scn" for k in before_cs)
    assert any(k[0] == "rg" for k in before_cs)


def test_delete_preserves_untouched_overprint(tmp_path, monkeypatch):
    """Delete 1 object: object overprint (gs) + spot còn lại giữ nguyên màu + nội dung."""
    specs = [
        {"cell": 0, "subtype": "spot"},
        {"cell": 1, "subtype": "cmyk_op"},
        {"cell": 2, "subtype": "gray"},
    ]
    op = {"kind": "delete"}
    before_cs = _run_once(tmp_path, monkeypatch, specs, target_cell=2, op=op)
    assert any(k[0] == "scn" for k in before_cs)  # spot còn nguyên


def test_rotate_preserves_untouched_icc(tmp_path, monkeypatch):
    """Rotate 1 object: object ICCBased còn lại giữ nguyên cs/scn + định nghĩa ICC."""
    specs = [
        {"cell": 0, "subtype": "icc"},
        {"cell": 1, "subtype": "cmyk"},
    ]
    op = {"kind": "rotate", "theta": 33.0}
    _run_once(tmp_path, monkeypatch, specs, target_cell=1, op=op)
