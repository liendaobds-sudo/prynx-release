"""
Property-Based Test (Task 2.4 — spec `pdf-edit-session`).

# Feature: pdf-edit-session, Property 3: Round-trip màu CMYK/spot (Round-trip):
# Object dùng màu CMYK (k) hoặc spot (scn) qua Apply_In_Memory → Commit hệ thống
# giữ nguyên operator màu, giá trị thành phần và định nghĩa colorspace (kể cả
# /ICCBased và overprint).

**Validates: Requirements 6.3**

────────────────────────────────────────────────────────────────────────────
PHẠM VI & KHÁC BIỆT
- Property này kiểm CHU TRÌNH PHIÊN THẬT của engine `edit_session`:
  `open` (dựng EditSession sống) → `apply_op` (Apply_In_Memory qua pikepdf) →
  `commit` (ghi Working_File ra ĐĨA). Sau đó MỞ LẠI Working_File bằng pikepdf và
  kiểm các object dùng `k` (CMYK) / `scn` (spot, ICC) GIỮ NGUYÊN:
    1. operator màu (`k`, `cs`+`scn`, và `gs` cho overprint),
    2. giá trị thành phần màu (CMYK / tint / ICC components),
    3. định nghĩa colorspace trong `/Resources/ColorSpace`:
       - `/Separation` (tint transform + alternate space) còn nguyên,
       - `/ICCBased` (stream /N + DỮ LIỆU ICC profile) còn nguyên,
    4. thiết lập overprint trong `/Resources/ExtGState` (`OP`/`op`/`OPM`) còn nguyên.

- Phân biệt với Task 2.3 (bảo toàn màu Untouched_Object, IN-MEMORY) và Task 2.2
  (tương đương in-memory↔commit so Legacy): Task 2.4 này tập trung Round-trip
  QUA ĐĨA của chính các object MÀU IN (CMYK/spot/ICC/overprint) — bắt lỗi
  serialize/deserialize pikepdf làm hỏng colorspace/ICC/overprint.

CHIẾN LƯỢC SINH DỮ LIỆU (Hypothesis) — tái dùng ý tưởng grid cô lập của
`test_roundtrip_cmyk_spot_pbt.py` (spec `pdf-object-edit`):
- Mỗi object là một nhóm cô lập `q … <set màu> … re f Q` ở MỘT ô lưới riêng
  (bbox KHÔNG chồng) để PDFium liệt kê & map DUY NHẤT.
- ctype mỗi object ∈ {cmyk, spot, icc, overprint}; mọi giá trị màu DUY NHẤT theo
  chỉ số i → chữ ký màu toàn cục duy nhất.
- Hypothesis chọn: ctype mỗi object, thao tác áp (move/resize/rotate/delete) và
  tập con object bị thao tác (bảo đảm còn ≥ 1 object SỐNG SÓT để kiểm round-trip).

CÔ LẬP DB: tầng đăng ký UploadedFile của `commit` (`_resolve_original_name`,
`_register_working_file`) được patch (như `test_session_commit.py`); GHI FILE
THẬT qua pikepdf để round-trip màu là thật.
────────────────────────────────────────────────────────────────────────────
"""
import hashlib
import os
import sys
import threading
from collections import Counter
from io import BytesIO
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pikepdf
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.core import edit_session
from app.core.edit_session import EditSession, apply_op, commit
from app.core.object_mapper import parse_page_ops
from app.core import geometry_reader
from app.schemas.edit import (
    EditOp,
    MoveDelta,
    ResizeScale,
    bbox_within_tolerance,
)

# ── Hằng số layout ──────────────────────────────────────────────────────────
PAGE_W = 700.0
PAGE_H = 400.0
COLS = 4
CELL = 150.0
RECT_W = 40.0
RECT_H = 30.0
MAX_SHIFT = 25.0  # |dx|,|dy| ≤ 25pt ≪ bước lưới 150pt → không va ô khác.
MATCH_TOL = 2.0   # tolerance map bbox PDFium → chỉ số ô lưới.

COLOR_TYPES = ["cmyk", "spot", "icc", "overprint"]

# Color_Operators liên quan (Yêu cầu 6.3/6.4): k (CMYK), cs+scn (spot/ICC),
# gs (tham chiếu ExtGState overprint).
COLOR_OPS = {"k", "scn", "cs", "gs"}

# ICC profile thật (sRGB, N=3) để dựng colorspace /ICCBased.
_ICC_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "assets", "icc", "sRGB.icc")
with open(_ICC_PATH, "rb") as _fh:
    ICC_BYTES = _fh.read()
ICC_N = 3


# ── Layout helpers ───────────────────────────────────────────────────────────
def _rect_for(i: int):
    """BBox không-chồng (x, y, w, h) cho object thứ i (hệ PDF, gốc dưới-trái)."""
    x = 30.0 + (i % COLS) * CELL
    y = 30.0 + (i // COLS) * CELL
    return x, y, RECT_W, RECT_H


def _bbox_for(i: int):
    x, y, w, h = _rect_for(i)
    return [x, y, x + w, y + h]


# ── Giá trị màu / chữ ký theo object ─────────────────────────────────────────
def _cmyk_vals(i: int, base: float):
    return [round(base + 0.01 * i, 4), round(base + 0.011 * i, 4),
            round(base + 0.012 * i, 4), round(base + 0.013 * i, 4)]


def _icc_vals(i: int):
    return [round(0.10 + 0.01 * i, 4), round(0.20 + 0.011 * i, 4),
            round(0.30 + 0.012 * i, 4)]


def _make_sig_from_raw(op: str, raw_operands: list):
    """Chuẩn hóa (op, operands thô) → chữ ký so khớp được."""
    canon = []
    for o in raw_operands:
        if isinstance(o, str):
            canon.append(("name", o))
        else:
            canon.append(("num", round(float(o), 4)))
    return (op, tuple(canon))


def _make_sig_from_instr(instr):
    """Chuẩn hóa ContentStreamInstruction đã parse → chữ ký so khớp được."""
    canon = []
    for o in instr.operands:
        try:
            canon.append(("num", round(float(o), 4)))
        except (TypeError, ValueError):
            canon.append(("name", str(o)))
    return (str(instr.operator), tuple(canon))


def _object_color_signatures(i: int, ctype: str):
    """Danh sách chữ ký Color_Operators mà object thứ i phát ra."""
    if ctype == "cmyk":
        return [_make_sig_from_raw("k", _cmyk_vals(i, 0.05))]
    if ctype == "spot":
        tint = round(0.10 + 0.02 * i, 4)
        return [_make_sig_from_raw("cs", [f"/Sep{i}"]),
                _make_sig_from_raw("scn", [tint])]
    if ctype == "icc":
        return [_make_sig_from_raw("cs", [f"/CSicc{i}"]),
                _make_sig_from_raw("scn", _icc_vals(i))]
    # overprint: `/GS{i} gs` + CMYK `k` (base khác cmyk để không trùng giá trị).
    return [_make_sig_from_raw("gs", [f"/GS{i}"]),
            _make_sig_from_raw("k", _cmyk_vals(i, 0.40))]


def _object_stream_fragment(i: int, ctype: str) -> str:
    """Đoạn content stream cô lập `q … Q` cho object thứ i."""
    x, y, w, h = _rect_for(i)
    lines = ["q"]
    if ctype == "cmyk":
        lines.append(" ".join(f"{v:.4f}" for v in _cmyk_vals(i, 0.05)) + " k")
    elif ctype == "spot":
        tint = round(0.10 + 0.02 * i, 4)
        lines.append(f"/Sep{i} cs")
        lines.append(f"{tint:.4f} scn")
    elif ctype == "icc":
        lines.append(f"/CSicc{i} cs")
        lines.append(" ".join(f"{v:.4f}" for v in _icc_vals(i)) + " scn")
    else:  # overprint
        lines.append(f"/GS{i} gs")
        lines.append(" ".join(f"{v:.4f}" for v in _cmyk_vals(i, 0.40)) + " k")
    lines.append(f"{x:.4f} {y:.4f} {w:.4f} {h:.4f} re")
    lines.append("f")
    lines.append("Q")
    return "\n".join(lines) + "\n"


def _build_pdf_bytes(specs) -> bytes:
    """
    Dựng bytes PDF 1 trang chứa object CMYK/spot/ICC/overprint theo `specs`
    (mỗi spec = {"i": int, "ctype": ...}).
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
        i, ctype = spec["i"], spec["ctype"]
        fragments.append(_object_stream_fragment(i, ctype))

        if ctype == "spot":
            # tint transform RIÊNG theo i → định nghĩa /Separation duy nhất.
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
        elif ctype == "icc":
            icc_stream = pikepdf.Stream(pdf, ICC_BYTES)
            icc_stream[pikepdf.Name("/N")] = ICC_N
            icc = pikepdf.Array([pikepdf.Name("/ICCBased"), pdf.make_indirect(icc_stream)])
            cs_dict[pikepdf.Name(f"/CSicc{i}")] = pdf.make_indirect(icc)
            has_cs = True
        elif ctype == "overprint":
            ext = pikepdf.Dictionary(
                Type=pikepdf.Name("/ExtGState"),
                OP=True,
                op=True,
                OPM=1,
            )
            gs_dict[pikepdf.Name(f"/GS{i}")] = pdf.make_indirect(ext)
            has_gs = True

    resources = pikepdf.Dictionary()
    if has_cs:
        resources[pikepdf.Name("/ColorSpace")] = cs_dict
    if has_gs:
        resources[pikepdf.Name("/ExtGState")] = gs_dict
    page.obj[pikepdf.Name("/Resources")] = resources

    stream = "".join(fragments).encode("latin-1")
    page.obj[pikepdf.Name("/Contents")] = pdf.make_stream(stream)

    out = BytesIO()
    pdf.save(out, compress_streams=False)
    pdf.close()
    return out.getvalue()


# ── Trích chữ ký màu / định nghĩa colorspace / overprint ─────────────────────
def _color_counter(page) -> Counter:
    """Đếm chữ ký Color_Operators (k/cs/scn/gs) trong content stream của trang."""
    counter: Counter = Counter()
    for instr in parse_page_ops(page):
        if str(instr.operator) in COLOR_OPS:
            counter[_make_sig_from_instr(instr)] += 1
    return counter


def _serialize(obj):
    """
    Serialize đệ quy một pikepdf object → cấu trúc Python so khớp được. Với
    Stream, gồm CẢ stream_dict lẫn HASH dữ liệu (để bắt thay đổi ICC profile).
    """
    if isinstance(obj, pikepdf.Array):
        return ["array"] + [_serialize(x) for x in obj]
    if isinstance(obj, pikepdf.Dictionary):
        return {"dict": {str(k): _serialize(v) for k, v in obj.items()}}
    if isinstance(obj, pikepdf.Stream):
        try:
            data_hash = hashlib.sha256(obj.read_bytes()).hexdigest()
        except Exception:  # noqa: BLE001
            data_hash = "<unreadable>"
        return {"stream": {str(k): _serialize(v) for k, v in obj.stream_dict.items()},
                "data": data_hash}
    if isinstance(obj, pikepdf.Name):
        return ("name", str(obj))
    try:
        return ("num", round(float(obj), 6))
    except (TypeError, ValueError):
        return ("raw", str(obj))


def _resource_defs(page, key: str) -> dict:
    """Trích {name: serialized} của `/Resources/{key}` (ColorSpace / ExtGState)."""
    out: dict = {}
    resources = page.obj.get("/Resources")
    if resources is None:
        return out
    sub = resources.get(key)
    if sub is None:
        return out
    for name, val in sub.items():
        out[str(name)] = _serialize(val)
    return out


# ── Session helpers (cô lập DB) ──────────────────────────────────────────────
def _make_live_session(tmp_path, specs, sid="cmyk-rt-sid", fid="fid-cmyk-rt"):
    """
    Dựng file gốc thật + EditSession SỐNG (đăng ký vào store) cho `specs`.
    Trả về (session, source_path, pdf_bytes).
    """
    pdf_bytes = _build_pdf_bytes(specs)
    source_path = os.path.join(str(tmp_path), "source.pdf")
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
    return session, source_path, pdf_bytes


def _cleanup_session(session: EditSession):
    edit_session.SESSIONS.pop(session.session_id, None)
    edit_session.by_fid.pop(session.source_fid, None)
    try:
        session.pdf.close()
    except Exception:  # noqa: BLE001
        pass


def _map_ids_to_index(source_path: str, specs) -> dict[int, str]:
    """
    Liệt kê object (PDFium read-only) từ file gốc và map chỉ số ô lưới i → id
    THẬT do `geometry_reader` cấp (đối khớp bbox trong tolerance).
    """
    objs = geometry_reader.list_objects(source_path, 0)
    mapping: dict[int, str] = {}
    for spec in specs:
        i = spec["i"]
        want = _bbox_for(i)
        match = next((o for o in objs if bbox_within_tolerance(list(o.bbox), want, MATCH_TOL)), None)
        assert match is not None, (
            f"Không map được object ô lưới i={i} (bbox={want}) trong listing "
            f"{[list(o.bbox) for o in objs]}"
        )
        mapping[i] = match.id
    return mapping


def _build_op(kind, target_ids, dx, dy, sx, sy, anchor, deg) -> EditOp:
    if kind == "delete":
        return EditOp(page=0, kind="delete", targetIds=target_ids)
    if kind == "move":
        return EditOp(page=0, kind="move", targetIds=target_ids, delta=MoveDelta(dx=dx, dy=dy))
    if kind == "resize":
        return EditOp(page=0, kind="resize", targetIds=target_ids,
                      scale=ResizeScale(sx=sx, sy=sy, anchor=anchor))
    return EditOp(page=0, kind="rotate", targetIds=target_ids, rotateDeg=deg)


def _run_apply_commit(session: EditSession, op: EditOp) -> str:
    """apply_op → commit với tầng DB cô lập; trả output_path của Working_File."""
    apply_op(session, op)
    with mock.patch.object(edit_session, "_resolve_original_name", lambda fid: "Doc.pdf"), \
            mock.patch("app.api.routes.edit._register_working_file",
                       lambda path, name: "fid-out-rt"):
        result = commit(session)
    return result["output_path"]


def _assert_survivors_preserved(saved_path, source_path, survivors):
    """
    Khẳng định các object SỐNG SÓT giữ nguyên operator + giá trị màu + định nghĩa
    colorspace (/Separation, /ICCBased) + overprint (/ExtGState) sau Apply+Commit.
    """
    # Kỳ vọng: chữ ký màu của object sống sót (toàn cục duy nhất theo i).
    expected_sigs: Counter = Counter()
    for s in survivors:
        for sig in _object_color_signatures(s["i"], s["ctype"]):
            expected_sigs[sig] += 1

    # Định nghĩa colorspace + overprint TRƯỚC (đọc từ file gốc).
    with pikepdf.Pdf.open(source_path) as src:
        before_cs = _resource_defs(src.pages[0], "/ColorSpace")
        before_gs = _resource_defs(src.pages[0], "/ExtGState")

    with pikepdf.Pdf.open(saved_path) as out:
        page2 = out.pages[0]
        after_color = _color_counter(page2)
        after_cs = _resource_defs(page2, "/ColorSpace")
        after_gs = _resource_defs(page2, "/ExtGState")

    # (1) operator + giá trị màu của object sống sót giữ nguyên số lần xuất hiện.
    for sig, cnt in expected_sigs.items():
        assert after_color[sig] == cnt, (
            f"Vi phạm round-trip màu: chữ ký {sig} kỳ vọng {cnt} lần, "
            f"file sau commit có {after_color[sig]} lần"
        )

    # (2) định nghĩa colorspace (/Separation, /ICCBased) của object sống sót còn nguyên.
    for s in survivors:
        if s["ctype"] == "spot":
            name = f"/Sep{s['i']}"
        elif s["ctype"] == "icc":
            name = f"/CSicc{s['i']}"
        else:
            continue
        assert name in after_cs, f"Mất định nghĩa colorspace {name} sau commit"
        assert after_cs[name] == before_cs[name], (
            f"Định nghĩa colorspace {name} bị đổi sau commit:\n"
            f"  trước = {before_cs[name]}\n  sau   = {after_cs[name]}"
        )

    # (3) thiết lập overprint (/ExtGState) của object overprint sống sót còn nguyên.
    for s in survivors:
        if s["ctype"] != "overprint":
            continue
        name = f"/GS{s['i']}"
        assert name in after_gs, f"Mất ExtGState overprint {name} sau commit"
        assert after_gs[name] == before_gs[name], (
            f"Thiết lập overprint {name} bị đổi sau commit:\n"
            f"  trước = {before_gs[name]}\n  sau   = {after_gs[name]}"
        )


# ── Strategy ─────────────────────────────────────────────────────────────────
@st.composite
def _roundtrip_plan(draw):
    n = draw(st.integers(min_value=2, max_value=5))
    specs = [{"i": i, "ctype": draw(st.sampled_from(COLOR_TYPES))} for i in range(n)]
    kind = draw(st.sampled_from(["delete", "move", "resize", "rotate"]))
    target_flags = [draw(st.booleans()) for _ in range(n)]
    # Ít nhất 1 object BỊ thao tác (object "đi qua" Apply_In_Memory).
    if not any(target_flags):
        target_flags[draw(st.integers(min_value=0, max_value=n - 1))] = True
    # Delete: bảo đảm còn ≥ 1 object SỐNG SÓT để kiểm round-trip.
    if kind == "delete" and all(target_flags):
        target_flags[draw(st.integers(min_value=0, max_value=n - 1))] = False
    dx = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                        allow_nan=False, allow_infinity=False))
    dy = draw(st.floats(min_value=-MAX_SHIFT, max_value=MAX_SHIFT,
                        allow_nan=False, allow_infinity=False))
    sx = draw(st.floats(min_value=0.5, max_value=1.8, allow_nan=False, allow_infinity=False))
    sy = draw(st.floats(min_value=0.5, max_value=1.8, allow_nan=False, allow_infinity=False))
    anchor = draw(st.sampled_from(["nw", "ne", "sw", "se"]))
    deg = draw(st.sampled_from([90.0, 180.0, 270.0, 45.0, -30.0]))
    return specs, kind, target_flags, dx, dy, sx, sy, anchor, deg


# ═══════════════════════════════════════════════════════════════════════════
#  PROPERTY 3 — Round-trip màu CMYK/spot qua Apply_In_Memory → Commit
#  (Validates: Requirements 6.3)
# ═══════════════════════════════════════════════════════════════════════════
@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(plan=_roundtrip_plan())
def test_apply_commit_preserves_cmyk_spot_icc_overprint(tmp_path, plan):
    """
    Với mọi thao tác (delete/move/resize/rotate) áp lên tập con object màu in qua
    chu trình PHIÊN (open → apply_op → commit), các object SỐNG SÓT dùng `k`/`scn`
    GIỮ NGUYÊN operator màu, giá trị thành phần và định nghĩa colorspace (gồm
    /ICCBased + overprint) sau khi MỞ LẠI Working_File trên đĩa.
    """
    specs, kind, target_flags, dx, dy, sx, sy, anchor, deg = plan

    # Object SỐNG SÓT = không bị xóa (move/resize/rotate giữ lại tất cả).
    if kind == "delete":
        survivors = [s for s, flag in zip(specs, target_flags) if not flag]
    else:
        survivors = list(specs)

    session, source_path, _ = _make_live_session(tmp_path, specs)
    saved_path = None
    try:
        id_by_index = _map_ids_to_index(source_path, specs)
        target_ids = [id_by_index[s["i"]] for s, flag in zip(specs, target_flags) if flag]
        op = _build_op(kind, target_ids, dx, dy, sx, sy, anchor, deg)

        saved_path = _run_apply_commit(session, op)
        _assert_survivors_preserved(saved_path, source_path, survivors)
    finally:
        _cleanup_session(session)
        if saved_path:
            try:
                os.remove(saved_path)
            except OSError:
                pass


# ═══════════════════════════════════════════════════════════════════════════
#  Ví dụ xác định kèm theo (sanity) — không phải PBT
# ═══════════════════════════════════════════════════════════════════════════
def test_move_preserves_all_color_kinds_explicit(tmp_path):
    """
    DI CHUYỂN object CMYK; round-trip phiên (apply_op→commit) giữ nguyên màu của
    cả 4 loại (CMYK / spot / ICC / overprint) + định nghĩa colorspace + overprint.
    """
    specs = [
        {"i": 0, "ctype": "cmyk"},
        {"i": 1, "ctype": "spot"},
        {"i": 2, "ctype": "icc"},
        {"i": 3, "ctype": "overprint"},
    ]
    session, source_path, _ = _make_live_session(tmp_path, specs, sid="ex-move", fid="fid-ex-move")
    saved_path = None
    try:
        id_by_index = _map_ids_to_index(source_path, specs)
        op = EditOp(page=0, kind="move", targetIds=[id_by_index[0]], delta=MoveDelta(dx=15.0, dy=-10.0))
        saved_path = _run_apply_commit(session, op)
        _assert_survivors_preserved(saved_path, source_path, specs)
    finally:
        _cleanup_session(session)
        if saved_path:
            try:
                os.remove(saved_path)
            except OSError:
                pass


def test_delete_one_keeps_other_color_kinds_explicit(tmp_path):
    """
    XÓA object spot; round-trip phiên giữ nguyên màu + colorspace + overprint của
    các object còn lại (CMYK / ICC / overprint).
    """
    specs = [
        {"i": 0, "ctype": "cmyk"},
        {"i": 1, "ctype": "spot"},
        {"i": 2, "ctype": "icc"},
        {"i": 3, "ctype": "overprint"},
    ]
    session, source_path, _ = _make_live_session(tmp_path, specs, sid="ex-del", fid="fid-ex-del")
    saved_path = None
    try:
        id_by_index = _map_ids_to_index(source_path, specs)
        op = EditOp(page=0, kind="delete", targetIds=[id_by_index[1]])
        saved_path = _run_apply_commit(session, op)
        survivors = [s for s in specs if s["i"] != 1]
        _assert_survivors_preserved(saved_path, source_path, survivors)
    finally:
        _cleanup_session(session)
        if saved_path:
            try:
                os.remove(saved_path)
            except OSError:
                pass
