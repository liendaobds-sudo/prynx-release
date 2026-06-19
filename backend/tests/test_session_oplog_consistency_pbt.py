"""
Property-Based Test (Task 6.3 — spec `pdf-edit-session`).

# Feature: pdf-edit-session, Property 5: Op_Log nhất quán khi lỗi/timeout (Invariant) —
# Với mọi Edit_Op bị hủy do lỗi hoặc timeout, Live_Document giữ nguyên trạng thái
# NGAY TRƯỚC thao tác và Op_Log KHÔNG ghi nhận thao tác bị hủy như đã áp; một
# Edit_Op hợp lệ kế tiếp vẫn cho kết quả đúng.

**Validates: Requirements 10.1, 10.2, 10.3**

────────────────────────────────────────────────────────────────────────────
Ý TƯỞNG KIỂM CHỨNG (qua engine phiên `app/core/edit_session.py` THẬT)
- Sinh PDF in-memory nhiều object màu in CÔ LẬP trong các ô lưới (bbox KHÔNG
  chồng) để PDFium liệt kê/ map DUY NHẤT — tái dùng pattern grid của
  `test_session_color_preservation_pbt.py` / `test_session_cmyk_roundtrip_pbt.py`.
- Mở phiên (EditSession sống trong SESSIONS). Sinh MỘT Edit_Op SẼ LỖI theo 1 trong
  2 chế độ:
    (A) "missing_target": targetIds trỏ tới object KHÔNG TỒN TẠI → `_resolve_targets`
        raise `ObjectMapError` (Yêu cầu 10.2). Bao trùm các op map-target
        (move/resize/rotate/delete).
    (B) "engine_error" (mô phỏng TIMEOUT ở mức engine): op HỢP LỆ nhưng monkeypatch
        `_apply_op_to_pdf` để RAISE (ví dụ `TimeoutError`), buộc nhánh KHÔI PHỤC
        của `apply_op` chạy đúng như khi một thao tác bị hủy giữa chừng.
  Lưu ý: TIMEOUT THẬT do `asyncio.wait_for(EDIT_TIMEOUT_SECONDS)` ở tầng route
  (`edit.py`, task 7.1) — NẰM NGOÀI phạm vi engine. Ở mức engine, hệ quả của một
  thao tác bị hủy (dù do lỗi map/glyph/tham số hay do bị cắt vì timeout) là GIỐNG
  NHAU: `apply_op` raise và phải KHÔI PHỤC Live_Document + KHÔNG đụng Op_Log. Test
  này kiểm đúng bất biến đó ở mức engine; chế độ (B) mô phỏng "bị cắt giữa chừng".

- PROPERTY (sau khi op lỗi raise):
    1. Op_Log KHÔNG dài thêm (không ghi nhận op bị hủy) — và redo_stack giữ nguyên.
    2. Live_Document TƯƠNG ĐƯƠNG trạng thái ngay trước thao tác: so chữ ký object
       (nội dung content stream theo từng nhóm `q … Q` = OpSpan từng object) +
       multiset Color_Operators (k/K, scn/SCN, cs/CS, rg/RG, g/G).
    3. Một Edit_Op HỢP LỆ kế tiếp (move object mục tiêu) vẫn áp ĐÚNG: Op_Log tăng
       ĐÚNG 1, kết quả `changed=True`, BBox mới ≈ BBox cũ dịch (dx, dy) trong
       tolerance ≤ 1.0pt.

CÔ LẬP DB: không gọi `commit` ở đây nên không cần patch tầng DB; chỉ tương tác với
engine in-memory (apply_op) + Geometry_Reader (PDFium read-only).
────────────────────────────────────────────────────────────────────────────
"""
import os
import sys
import threading
import uuid
from collections import Counter
from io import BytesIO
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pikepdf import Array, Dictionary, Name

from app.core import edit_session, geometry_reader
from app.core.edit_session import EditSession, apply_op
from app.schemas.edit import EditOp, MoveDelta, ResizeScale, normalize_bbox
from app.core.stream_editor import ObjectMapError

# ── Hằng số layout (đồng bộ các PBT khác của hệ) ─────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0

# Tập operator màu cần bảo toàn (Color_Operators — glossary / Yêu cầu 6).
COLOR_OPS = {"k", "K", "scn", "SCN", "cs", "CS", "rg", "RG", "g", "G"}

# Object màu in đa dạng (đủ để có Color_Operators để so chữ ký).
SUBTYPES = ["cmyk", "rgb", "gray", "spot"]

# Dịch chuyển nhỏ cho op hợp lệ kế tiếp (≪ bước lưới 150pt → không va ô khác).
MAX_SHIFT = 25.0
MATCH_TOL = 1.0  # tolerance map bbox (Yêu cầu 1.7 / 7.2: ≤ 1.0pt)


# ── Hình học ô lưới ──────────────────────────────────────────────────────────
def _rect_for(cell: int):
    x = 30.0 + (cell % COLS) * CELL
    y = 30.0 + (cell // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(cell: int):
    x, y, w, h = _rect_for(cell)
    return [x, y, x + w, y + h]


def _tint(cell: int) -> float:
    """Thành phần màu DUY NHẤT theo ô."""
    return round(0.05 + 0.03 * cell, 4)


# ── Dựng fragment + tài nguyên ───────────────────────────────────────────────
def _color_fragment(cell: int, subtype: str) -> str:
    x, y, w, h = _rect_for(cell)
    rect = f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re\nf\n"
    v = _tint(cell)
    if subtype == "cmyk":
        return f"q\n{v:.4f} 0.2000 0.3000 0.4000 k\n{rect}Q\n"
    if subtype == "rgb":
        return f"q\n{v:.4f} 0.3000 0.4000 rg\n{rect}Q\n"
    if subtype == "gray":
        return f"q\n{v:.4f} g\n{rect}Q\n"
    if subtype == "spot":
        return f"q\n/Sep{cell} cs\n{v:.4f} scn\n{rect}Q\n"
    raise AssertionError(f"subtype không hỗ trợ: {subtype}")


def _make_separation(pdf: pikepdf.Pdf, cell: int):
    """Colorspace Separation /Sep{cell} (DeviceCMYK alternate, tint type-2)."""
    func = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=[0, 1],
        C0=[0, 0, 0, 0], C1=[0.1, 0.9, 0.8, 0.0], N=1,
    ))
    return Array([Name("/Separation"), Name(f"/Spot{cell}"), Name("/DeviceCMYK"), func])


def _build_pdf_bytes(specs) -> bytes:
    """Dựng PDF 1 trang theo `specs` (list {cell, subtype}); trả BYTES."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]

    cs_dict = Dictionary()
    fragments = []
    for spec in specs:
        cell, subtype = spec["cell"], spec["subtype"]
        fragments.append(_color_fragment(cell, subtype))
        if subtype == "spot":
            cs_dict[Name(f"/Sep{cell}")] = pdf.make_indirect(_make_separation(pdf, cell))

    resources = Dictionary()
    if len(cs_dict.keys()):
        resources[Name("/ColorSpace")] = cs_dict
    page.obj[Name("/Resources")] = resources
    page.obj[Name("/Contents")] = pdf.make_stream("".join(fragments).encode("latin-1"))

    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


# ── Chữ ký Live_Document (OpSpan từng object + Color_Operators) ───────────────
def _norm_operand(o):
    try:
        return round(float(o), 4)
    except (TypeError, ValueError):
        return str(o)


def _object_blocks(pdf_bytes: bytes) -> list[tuple]:
    """
    Tách content stream trang 0 thành danh sách "object block" — mỗi nhóm `q … Q`
    cấp ngoài cùng là một object (≈ OpSpan của object đó). Mỗi block = tuple các
    (operator, operands-chuẩn-hóa).
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


def _doc_signature(pdf_bytes: bytes) -> tuple[Counter, Counter]:
    """
    Chữ ký Live_Document: (multiset object-block, multiset Color_Operators) của
    TOÀN BỘ trang 0. So hai chữ ký bằng nhau ⇔ trạng thái tương đương (OpSpan từng
    object + màu in đều khớp).
    """
    block_sig: Counter = Counter()
    color_sig: Counter = Counter()
    for block in _object_blocks(pdf_bytes):
        block_sig[block] += 1
        for op, operands in block:
            if op in COLOR_OPS:
                color_sig[(op, operands)] += 1
    return block_sig, color_sig


# ── Session helpers (cô lập, đăng ký vào store như các PBT khác) ─────────────
def _make_session(tmp_path, pdf_bytes: bytes) -> EditSession:
    sid = "oplog-pbt-" + uuid.uuid4().hex
    fid = "fid-oplog-" + uuid.uuid4().hex
    source_path = os.path.join(str(tmp_path), f"src_{sid}.pdf")
    with open(source_path, "wb") as fh:
        fh.write(pdf_bytes)
    session = EditSession(
        session_id=sid,
        source_fid=fid,
        source_path=source_path,
        pdf=pikepdf.Pdf.open(BytesIO(pdf_bytes)),
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
    except Exception:  # noqa: BLE001
        pass
    try:
        os.remove(session.source_path)
    except OSError:
        pass


def _save_bytes(pdf: pikepdf.Pdf) -> bytes:
    buf = BytesIO()
    pdf.save(buf, compress_streams=False)
    return buf.getvalue()


def _match_target_id(metas, cell: int) -> str | None:
    """Tìm id object Geometry_Reader khớp ô `cell` (theo tâm bbox, gần nhất < 50pt)."""
    bb = _bbox_for(cell)
    cx = (bb[0] + bb[2]) / 2.0
    cy = (bb[1] + bb[3]) / 2.0
    best, best_d = None, 1e9
    for m in metas:
        mx = (m.bbox[0] + m.bbox[2]) / 2.0
        my = (m.bbox[1] + m.bbox[3]) / 2.0
        d = abs(mx - cx) + abs(my - cy)
        if d < best_d:
            best, best_d = m, d
    if best is not None and best_d < 50.0:
        return best
    return None


# ── Dựng Edit_Op ─────────────────────────────────────────────────────────────
def _build_op(kind: str, target_ids: list[str], op: dict) -> EditOp:
    if kind == "move":
        return EditOp(page=0, kind="move", targetIds=target_ids,
                      delta=MoveDelta(dx=op["dx"], dy=op["dy"]))
    if kind == "resize":
        return EditOp(page=0, kind="resize", targetIds=target_ids,
                      scale=ResizeScale(sx=op["sx"], sy=op["sy"], anchor=op["anchor"]))
    if kind == "rotate":
        return EditOp(page=0, kind="rotate", targetIds=target_ids, rotateDeg=op["theta"])
    if kind == "delete":
        return EditOp(page=0, kind="delete", targetIds=target_ids)
    raise AssertionError(kind)


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _failure_plan(draw):
    """
    Sinh (specs, target_cell, mode, fail_kind, fail_params): tập object màu + một
    thao tác SẼ LỖI ở `target_cell` theo `mode` ∈ {missing_target, engine_error}.
    """
    n = draw(st.integers(min_value=2, max_value=5))
    specs = [{"cell": j, "subtype": draw(st.sampled_from(SUBTYPES))} for j in range(n)]
    target_cell = draw(st.integers(min_value=0, max_value=n - 1))

    mode = draw(st.sampled_from(["missing_target", "engine_error"]))
    fail_kind = draw(st.sampled_from(["move", "resize", "rotate", "delete"]))
    params = {
        "dx": draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                             allow_nan=False, allow_infinity=False)),
        "dy": draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                             allow_nan=False, allow_infinity=False)),
        "sx": draw(st.floats(min_value=0.5, max_value=1.8, allow_nan=False, allow_infinity=False)),
        "sy": draw(st.floats(min_value=0.5, max_value=1.8, allow_nan=False, allow_infinity=False)),
        "anchor": draw(st.sampled_from(["nw", "ne", "sw", "se"])),
        "theta": draw(st.sampled_from([90.0, 180.0, 270.0, 45.0, -30.0])),
    }
    return specs, target_cell, mode, fail_kind, params


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 5 — Op_Log nhất quán khi lỗi/timeout
#  (Validates: Requirements 10.1, 10.2, 10.3)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(plan=_failure_plan())
def test_oplog_consistent_on_error_or_timeout(plan, tmp_path):
    """
    # Feature: pdf-edit-session, Property 5: Op_Log nhất quán khi lỗi/timeout —
    # op bị hủy KHÔNG vào Op_Log, Live_Document giữ nguyên trạng thái trước thao
    # tác, và op hợp lệ kế tiếp vẫn áp đúng.
    """
    specs, target_cell, mode, fail_kind, params = plan

    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_session(tmp_path, pdf_bytes)
    try:
        # BYTES đúng như engine dùng để resolve target (PDFium read-only).
        live0 = _save_bytes(session.pdf)
        metas = geometry_reader.list_objects(live0, 0, include_text_props=False)
        target = _match_target_id(metas, target_cell)
        if target is None:
            return  # PDFium không tách được object ở ô này (hiếm) → bỏ qua ví dụ.
        target_id = target.id
        old_bbox = normalize_bbox(list(target.bbox))

        # Chữ ký + chiều dài Op_Log NGAY TRƯỚC thao tác lỗi.
        before_sig = _doc_signature(live0)
        oplog_len_before = len(session.op_log)
        redo_len_before = len(session.redo_stack)

        # ── Dựng + áp Edit_Op SẼ LỖI ──
        if mode == "missing_target":
            # Target không tồn tại → ObjectMapError (Yêu cầu 10.2).
            bad_id = "khong-ton-tai-" + uuid.uuid4().hex
            failing_op = _build_op(fail_kind, [bad_id], params)
            with pytest.raises(ObjectMapError):
                apply_op(session, failing_op)
        else:
            # engine_error: op HỢP LỆ nhưng `_apply_op_to_pdf` bị buộc raise — mô
            # phỏng thao tác bị cắt giữa chừng (vd. timeout ở tầng trên). Nhánh
            # KHÔI PHỤC của apply_op phải giữ nguyên Live_Document (Yêu cầu 10.1).
            failing_op = _build_op(fail_kind, [target_id], params)
            with mock.patch.object(
                edit_session, "_apply_op_to_pdf",
                side_effect=TimeoutError("mô phỏng timeout/hủy giữa chừng"),
            ):
                with pytest.raises(TimeoutError):
                    apply_op(session, failing_op)

        # (1) Op_Log KHÔNG ghi nhận op bị hủy; redo_stack giữ nguyên (Yêu cầu 10.3).
        assert len(session.op_log) == oplog_len_before, (
            f"Op_Log thay đổi sau op lỗi (mode={mode}, kind={fail_kind}): "
            f"{oplog_len_before} → {len(session.op_log)}"
        )
        assert len(session.redo_stack) == redo_len_before

        # (2) Live_Document tương đương trạng thái NGAY TRƯỚC thao tác
        #     (OpSpan từng object + Color_Operators) (Yêu cầu 10.1, 10.2).
        after_fail_sig = _doc_signature(_save_bytes(session.pdf))
        assert after_fail_sig == before_sig, (
            f"Live_Document đổi trạng thái sau op lỗi (mode={mode}, kind={fail_kind}):\n"
            f"  blocks trước={dict(before_sig[0])}\n  blocks sau ={dict(after_fail_sig[0])}\n"
            f"  màu trước={dict(before_sig[1])}\n  màu sau ={dict(after_fail_sig[1])}"
        )

        # (3) Một Edit_Op HỢP LỆ kế tiếp vẫn áp ĐÚNG (Yêu cầu 10.3 — Op_Log nhất quán).
        dx, dy = 11.0, -7.0
        good_op = EditOp(page=0, kind="move", targetIds=[target_id],
                         delta=MoveDelta(dx=dx, dy=dy))
        result = apply_op(session, good_op)

        assert len(session.op_log) == oplog_len_before + 1, (
            "Op hợp lệ kế tiếp phải ghi ĐÚNG 1 mục vào Op_Log"
        )
        assert result["changed"] is True
        new_bbox = result["bbox"]
        assert new_bbox is not None, "Move phải trả BBox mới của đối tượng"
        expected = [old_bbox[0] + dx, old_bbox[1] + dy, old_bbox[2] + dx, old_bbox[3] + dy]
        for i in range(4):
            assert abs(new_bbox[i] - expected[i]) <= MATCH_TOL, (
                f"BBox sau move lệch quá tolerance: cạnh {i} "
                f"new={new_bbox[i]:.3f} expected={expected[i]:.3f}"
            )
    finally:
        _cleanup_session(session)


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def _setup_session(tmp_path, specs):
    pdf_bytes = _build_pdf_bytes(specs)
    session = _make_session(tmp_path, pdf_bytes)
    live0 = _save_bytes(session.pdf)
    metas = geometry_reader.list_objects(live0, 0, include_text_props=False)
    return session, live0, metas


def test_missing_target_keeps_oplog_and_state(tmp_path):
    """Op trỏ target không tồn tại → ObjectMapError; Op_Log rỗng, state giữ nguyên,
    op hợp lệ kế tiếp áp được."""
    specs = [
        {"cell": 0, "subtype": "cmyk"},
        {"cell": 1, "subtype": "spot"},
        {"cell": 2, "subtype": "rgb"},
    ]
    session, live0, metas = _setup_session(tmp_path, specs)
    try:
        before_sig = _doc_signature(live0)
        with pytest.raises(ObjectMapError):
            apply_op(session, EditOp(page=0, kind="move", targetIds=["khong-co"],
                                     delta=MoveDelta(dx=10.0, dy=5.0)))
        assert len(session.op_log) == 0
        assert _doc_signature(_save_bytes(session.pdf)) == before_sig

        target = _match_target_id(metas, 0)
        assert target is not None
        result = apply_op(session, EditOp(page=0, kind="move", targetIds=[target.id],
                                          delta=MoveDelta(dx=10.0, dy=5.0)))
        assert len(session.op_log) == 1
        assert result["changed"] is True
    finally:
        _cleanup_session(session)


def test_engine_error_restores_live_document(tmp_path):
    """Mô phỏng timeout/hủy giữa chừng (`_apply_op_to_pdf` raise) → Live_Document
    được khôi phục, Op_Log không ghi op bị hủy, op hợp lệ kế tiếp áp được."""
    specs = [
        {"cell": 0, "subtype": "gray"},
        {"cell": 1, "subtype": "cmyk"},
        {"cell": 2, "subtype": "spot"},
    ]
    session, live0, metas = _setup_session(tmp_path, specs)
    try:
        before_sig = _doc_signature(live0)
        target = _match_target_id(metas, 1)
        assert target is not None

        with mock.patch.object(edit_session, "_apply_op_to_pdf",
                               side_effect=TimeoutError("timeout giả lập")):
            with pytest.raises(TimeoutError):
                apply_op(session, EditOp(page=0, kind="rotate", targetIds=[target.id],
                                         rotateDeg=90.0))
        assert len(session.op_log) == 0
        assert _doc_signature(_save_bytes(session.pdf)) == before_sig

        result = apply_op(session, EditOp(page=0, kind="move", targetIds=[target.id],
                                          delta=MoveDelta(dx=8.0, dy=-3.0)))
        assert len(session.op_log) == 1
        assert result["changed"] is True
    finally:
        _cleanup_session(session)
