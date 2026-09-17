"""
Edit_Session engine — giữ một `pikepdf.Pdf` SỐNG theo phiên trong RAM backend
(phương án "C" của spec `pdf-edit-session`).

Mục tiêu module (task 1.1): định nghĩa kiểu dữ liệu phiên + store toàn cục và
vòng đời MỞ phiên. Các bước sau (apply_op / render_clip / undo / redo / commit /
close_session / sweep_expired) được bổ sung ở các task kế tiếp.

Bất biến kiến trúc (kế thừa `pdf-object-edit`, KHÔNG được phá):
- **pikepdf = đường GHI DUY NHẤT (color-safe).** Mọi thay đổi nội dung đi qua
  `Stream_Editor`; PDFium chỉ ĐỌC/RENDER. Module này chỉ MỞ document từ bytes
  (read-only intent) và giữ nó sống — chưa ghi gì.
- **KHÔNG ghi đè file gốc.** `baseline_bytes` là ảnh chụp BYTES của file gốc;
  Live_Document mở TỪ bytes đó nên thao tác in-memory không bao giờ đụng file gốc
  trên đĩa.

Thread-safety (Yêu cầu 2.5):
- `_STORE_LOCK` chỉ bảo vệ map phiên (`SESSIONS` / `by_fid`) — giữ NGẮN.
- Mỗi `EditSession.lock` tuần tự hóa thao tác đụng `pdf` của riêng phiên đó
  (dùng ở các task sau).

_Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
"""
from __future__ import annotations

import dataclasses
import hashlib
import logging
import math
import os
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

import pikepdf
from pydantic import BaseModel

from app.core import edit_io, geometry_reader
from app.core.edit_debug_log import edit_bug_log_enabled, edit_bug_log_path, log_edit_bug
from app.core.license_guard import result_access_url
from app.core.object_mapper import contents_coalesce, map_object_spans, map_text_show_op, parse_page_ops
from app.core.stream_editor import (
    _has_overlapping_object_sibling,
    GlyphCoverageError,
    ObjectMapError,
    add_image,
    add_text,
    affine_transform_objects,
    clip_image,
    delete_objects,
    edit_text,
    move_objects,
    paste_objects,
    replace_image,
    resize_objects,
    rotate_objects,
)
from app.database import SessionLocal
from app.models.job import UploadedFile
from app.schemas.edit import EditOp, ObjMeta, normalize_bbox

logger = logging.getLogger(__name__)


# ── Lỗi domain (độc lập FastAPI) ─────────────────────────────────────────────
class SessionNotFoundError(Exception):
    """
    Session_Id không ứng với một Edit_Session đang SỐNG (chưa mở / đã đóng / đã
    dọn theo TTL). Lớp endpoint map lỗi này → HTTP 410 Gone để frontend fallback
    Legacy_Commit_Flow (Yêu cầu 2.4, 9.5, 11.1).
    """


# ── Data model ───────────────────────────────────────────────────────────────
@dataclass
class EditSession:
    """
    Một phiên chỉnh sửa sống trong bộ nhớ backend (Glossary: Edit_Session).

    Mọi thao tác in-memory áp lên `pdf` (Live_Document); `baseline_bytes` giữ
    nguyên BYTES file gốc để Undo = replay từ baseline (task 4.1). Mỗi phiên có
    `lock` riêng để tuần tự hóa thao tác đụng `pdf` (Yêu cầu 2.5).
    """

    session_id: str
    source_fid: str                 # fid gốc (UploadedFile.id) — định danh/fallback
    source_path: str                # đường dẫn file gốc trên đĩa (CHỈ ĐỌC)
    pdf: pikepdf.Pdf                 # Live_Document — SỐNG trong RAM
    baseline_bytes: bytes           # bytes file gốc (undo = replay từ baseline)
    op_log: list[EditOp] = field(default_factory=list)      # op đã áp (undo/redo + commit)
    redo_stack: list[EditOp] = field(default_factory=list)  # op đã undo, chờ redo
    # LIFECYCLE (audit 2026-08-25 §REV.11): route giữ khóa xuyên suốt
    # commit/flatten + publication lease; core tái nhập cùng khóa khi vật chất hóa.
    lock: threading.RLock = field(default_factory=threading.RLock)
    last_access: float = field(default_factory=time.monotonic)    # mốc TTL (monotonic)
    dirty: bool = False             # có thay đổi chưa commit?
    last_commit_path: str | None = None  # Working_File commit gần nhất (đồng bộ tile)
    live_bytes: bytes | None = None  # BYTES post-op gần nhất của Live_Document — cache
                                     # để `render_clip` (task 3.2) TÁI DÙNG, tránh
                                     # save lại lần nữa (design: "save 1 lần/op").
    page_objects_cache: dict[int, dict[str, ObjMeta]] = field(default_factory=dict)  # PERF: cache objects theo trang


# ── Store toàn cục ───────────────────────────────────────────────────────────
# Map Session_Id → EditSession (trạng thái sống trong tiến trình backend).
SESSIONS: dict[str, EditSession] = {}
# Phụ trợ: fid gốc → Session_Id, bảo đảm ≤1 phiên sống mỗi fid (Yêu cầu 1.5).
by_fid: dict[str, str] = {}
# Bảo vệ thao tác tra/tạo/xóa trên SESSIONS & by_fid (giữ NGẮN).
_STORE_LOCK = threading.Lock()

# Session_TTL: thời gian sống tối đa của một Edit_Session kể từ `last_access`
# (Glossary Session_TTL, Yêu cầu 9.2). 30 phút = 1800s; quá hạn → dọn để chống
# rò RAM khi làm việc với file lớn.
SESSION_TTL: float = 30 * 60.0  # 1800 giây


# ── Helpers ──────────────────────────────────────────────────────────────────
def _resolve_source_path(fid: str) -> str:
    """
    Resolve `fid` → đường dẫn file gốc trên đĩa (bảng `UploadedFile` hoặc native disk path),
    TÁI DÙNG đúng cơ chế của `edit` route nhưng raise lỗi DOMAIN (không phải HTTP).
    """
    import urllib.parse
    unquoted = urllib.parse.unquote(fid)
    if os.path.isfile(unquoted):
        return os.path.abspath(unquoted)
    if os.path.isfile(fid):
        return os.path.abspath(fid)
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if uploaded is None:
            raise FileNotFoundError(f"File ID '{fid}' không tìm thấy.")
        if not uploaded.file_path or not os.path.exists(uploaded.file_path):
            raise FileNotFoundError(
                f"File gốc của '{fid}' đã bị xóa khỏi đĩa: {uploaded.file_path!r}"
            )
        return uploaded.file_path
    finally:
        db.close()


def _discard_session_locked(session: EditSession) -> None:
    """
    Đóng một phiên và gỡ khỏi store. PHẢI gọi khi đang giữ `_STORE_LOCK`.

    Giải phóng Live_Document khỏi RAM (`pdf.close()`) và xóa khỏi `SESSIONS`/
    `by_fid`; giữ nguyên file gốc + mọi Working_File đã commit (Yêu cầu 9.3).
    (Vòng đời đóng phiên đầy đủ — `close_session`/`sweep_expired` — ở task 6.1.)
    """
    try:
        session.pdf.close()
    except Exception:  # noqa: BLE001 - đóng best-effort, không chặn dọn map
        logger.debug("Đóng Live_Document phiên %s gặp lỗi (bỏ qua).", session.session_id)
    # Quan sát được việc MẤT sửa đổi CHƯA commit (TTL evict / mở lại cùng fid /
    # đóng phiên khi dirty): trước đây mất âm thầm. Log WARNING để chẩn đoán
    # (không chặn; frontend nên commit trước khi đóng).
    if getattr(session, "dirty", False):
        logger.warning(
            "Discard Edit_Session %s khi đang DIRTY (có sửa đổi CHƯA commit) — "
            "%d op trong op_log sẽ MẤT.", session.session_id, len(session.op_log),
        )
    SESSIONS.pop(session.session_id, None)
    if by_fid.get(session.source_fid) == session.session_id:
        by_fid.pop(session.source_fid, None)


def _sweep_expired_locked(now: float | None = None) -> int:
    """
    Dọn mọi Edit_Session quá `SESSION_TTL` kể từ `last_access`. PHẢI gọi khi đang
    giữ `_STORE_LOCK` (Yêu cầu 9.2).

    So sánh bằng `time.monotonic()` (cùng đồng hồ với `last_access`) để miễn nhiễm
    với chỉnh giờ hệ thống. Materialize danh sách phiên hết hạn TRƯỚC khi dọn để
    tránh sửa `SESSIONS` trong lúc duyệt.

    Returns:
        Số phiên đã dọn.
    """
    if now is None:
        now = time.monotonic()
    expired = [s for s in SESSIONS.values() if (now - s.last_access) > SESSION_TTL]
    for session in expired:
        logger.info(
            "Dọn Edit_Session %s quá hạn TTL (%.0fs không truy cập ≥ %.0fs).",
            session.session_id, now - session.last_access, SESSION_TTL,
        )
        _discard_session_locked(session)
    return len(expired)


# ── Vòng đời: ĐÓNG phiên & dọn RAM theo TTL ─────────────────────────────────
def close_session(session_id: str) -> bool:
    """
    Đóng một Edit_Session theo `session_id` (vd. khi người dùng thoát edit mode —
    Yêu cầu 9.1): giải phóng Live_Document khỏi RAM (`pdf.close()`) và gỡ khỏi
    `SESSIONS`/`by_fid`. GIỮ NGUYÊN file gốc cùng mọi Working_File đã Commit
    (Yêu cầu 9.3).

    Tái dùng `_discard_session_locked` dưới `_STORE_LOCK` để dùng chung đúng một
    đường giải phóng tài nguyên (giống `open_session` và `sweep_expired`).

    Args:
        session_id: Session_Id cần đóng.

    Returns:
        True nếu có phiên để đóng; False nếu Session_Id không còn trong store
        (đã đóng/dọn trước đó) — idempotent, KHÔNG raise.
    """
    with _STORE_LOCK:
        session = SESSIONS.get(session_id)
        if session is None:
            return False
        _discard_session_locked(session)
    logger.info("Đã đóng Edit_Session %s (giải phóng RAM).", session_id)
    return True


def sweep_expired() -> int:
    """
    Dọn tất cả Edit_Session quá `SESSION_TTL` kể từ `last_access` và giải phóng RAM
    (Yêu cầu 9.2). Dùng cho cả lazy sweep (mỗi lần tra phiên) lẫn background sweep
    định kỳ (task 6.2 wiring vào `main.py`).

    Returns:
        Số phiên đã dọn trong lần quét này.
    """
    with _STORE_LOCK:
        return _sweep_expired_locked()


def get_active_session(fid: str) -> EditSession | None:
    """Trả về EditSession đang sống cho fid (nếu có). Dùng để listing object nhanh từ live pdf."""
    with _STORE_LOCK:
        _sweep_expired_locked()
        sid = by_fid.get(fid)
        return SESSIONS.get(sid) if sid else None


def list_objects_from_session(session: EditSession, page: int, include_text_props: bool = False) -> list[ObjMeta]:
    """
    Liệt kê object từ Live_Document trong RAM (nhanh, phản ánh thay đổi chưa commit).
    Dùng chung geometry_reader để nhất quán.
    """
    buf = BytesIO()
    session.pdf.save(buf, compress_streams=False)
    return geometry_reader.list_objects(buf.getvalue(), page, include_text_props=include_text_props)


# ── Vòng đời: MỞ phiên ───────────────────────────────────────────────────────
def open_session(fid: str) -> EditSession:
    """
    Mở một Edit_Session mới từ `fid`: đọc file gốc, giữ `baseline_bytes`, mở
    `pikepdf` TỪ bytes đó (Live_Document sống trong RAM) và đăng ký vào store.

    Bảo đảm ≤1 phiên sống mỗi `fid` (Yêu cầu 1.5): nếu đã có phiên cho cùng `fid`,
    ĐÓNG phiên cũ trước khi mở phiên mới. Phiên mới khởi tạo `op_log`/`redo_stack`
    rỗng (Yêu cầu 1.4), `dirty=False`, cập nhật `last_access`.

    Args:
        fid: ID file đã upload (UploadedFile.id) để mở phiên.

    Returns:
        EditSession vừa tạo với `session_id` duy nhất.

    Raises:
        FileNotFoundError: nếu `fid` không tồn tại / file mất → KHÔNG tạo phiên
            (Yêu cầu 1.3).
    """
    # Resolve + đọc bytes file gốc TRƯỚC khi đụng store. Nếu lỗi → không tạo phiên.
    source_path = _resolve_source_path(fid)
    try:
        with open(source_path, "rb") as fh:
            baseline_bytes = fh.read()
    except OSError as exc:
        # File biến mất giữa chừng (race) → coi như không tìm thấy (Yêu cầu 1.3).
        raise FileNotFoundError(
            f"Không đọc được file gốc của '{fid}': {source_path!r} ({exc})"
        ) from exc

    # Mở Live_Document TỪ bytes (không giữ handle file gốc trên đĩa) — bất biến
    # KHÔNG ghi đè file gốc được bảo đảm ngay ở khâu mở.
    pdf = pikepdf.Pdf.open(BytesIO(baseline_bytes))

    session_id = uuid.uuid4().hex
    session = EditSession(
        session_id=session_id,
        source_fid=fid,
        source_path=source_path,
        pdf=pdf,
        baseline_bytes=baseline_bytes,
        last_access=time.monotonic(),
        dirty=False,
        live_bytes=baseline_bytes,
    )

    with _STORE_LOCK:
        # ≤1 phiên/fid: đóng phiên cũ (nếu còn sống) trước khi đăng ký phiên mới.
        existing_sid = by_fid.get(fid)
        if existing_sid is not None:
            existing = SESSIONS.get(existing_sid)
            if existing is not None:
                logger.info(
                    "fid '%s' đã có phiên %s — đóng phiên cũ trước khi mở phiên mới.",
                    fid, existing_sid,
                )
                _discard_session_locked(existing)
            else:
                by_fid.pop(fid, None)

        SESSIONS[session_id] = session
        by_fid[fid] = session_id

    logger.info("Đã mở Edit_Session %s cho fid '%s' (%d trang).",
                session_id, fid, len(pdf.pages))
    return session


# ── Helpers cho apply_op ─────────────────────────────────────────────────────
def get_session(session_id: str) -> EditSession:
    """
    Tra một Edit_Session đang SỐNG theo `session_id`.

    Raises:
        SessionNotFoundError: nếu Session_Id không còn trong store (chưa mở / đã
            đóng / đã dọn TTL) — lớp endpoint map → 410 (Yêu cầu 2.4, 9.5).
    """
    with _STORE_LOCK:
        # Lazy sweep: mỗi lần tra phiên, dọn các phiên quá TTL trước (Yêu cầu 9.2).
        # Nếu chính `session_id` đã hết hạn, nó sẽ bị dọn ở đây → `.get` trả None
        # → SessionNotFoundError, đúng tín hiệu "phiên không tồn tại" (Yêu cầu 9.5).
        _sweep_expired_locked()
        session = SESSIONS.get(session_id)
    if session is None:
        raise SessionNotFoundError(f"Phiên '{session_id}' không tồn tại hoặc đã hết hạn.")
    return session


def _page_or_raise(pdf: pikepdf.Pdf, page_index: int):
    """Lấy `pikepdf.Page` theo chỉ số 0-based; IndexError nếu ngoài phạm vi."""
    n = len(pdf.pages)
    if page_index < 0 or page_index >= n:
        raise IndexError(f"Trang {page_index} ngoài phạm vi (0..{n - 1}).")
    return pdf.pages[page_index]


def _list_objects_from_bytes(pdf_bytes: bytes, page: int) -> dict[str, ObjMeta]:
    """
    Liệt kê object của một trang TỪ BYTES in-memory (PDFium read-only) → map
    id → ObjMeta. `geometry_reader.list_objects` nhận cả bytes (pypdfium2
    `PdfDocument` chấp nhận path lẫn bytes) nên không cần file tạm.

    Dùng để resolve target nhất quán với TRẠNG THÁI HIỆN TẠI của Live_Document
    (design: "map object nhất quán với trạng thái phiên").
    """
    metas = geometry_reader.list_objects(pdf_bytes, page, include_text_props=False)
    return {m.id: m for m in metas}


def _resolve_targets(by_id: dict[str, ObjMeta], page: int, target_ids: list[str]) -> list[ObjMeta]:
    """
    Lọc ObjMeta theo `target_ids`, GIỮ thứ tự đầu vào.

    Raises:
        ObjectMapError: nếu có targetIds không map được trên trang hiện tại — HỦY
            thao tác để giữ Live_Document nguyên trạng (Yêu cầu 6.5, 10.2).
    """
    selected: list[ObjMeta] = []
    missing: list[str] = []
    for tid in target_ids:
        meta = by_id.get(tid)
        if meta is None:
            missing.append(tid)
        else:
            selected.append(meta)
    if missing:
        raise ObjectMapError(
            f"Không map được object mục tiêu trên trang {page}: {missing}"
        )
    return selected


def _decode_image_source(data_ref: str):
    """Diễn giải `ImagePayload.dataRef`: data-URI base64 → bytes; ngược lại → path str."""
    if data_ref.startswith("data:") and "base64," in data_ref:
        import base64
        return base64.b64decode(data_ref.split("base64,", 1)[1])
    return data_ref


def _jsonable(val):
    """Chuyển giá trị (gồm pydantic models lồng nhau như OpSpan) về dạng JSON-able."""
    if isinstance(val, BaseModel):
        return val.model_dump()
    if isinstance(val, (list, tuple)):
        return [_jsonable(v) for v in val]
    if isinstance(val, dict):
        return {k: _jsonable(v) for k, v in val.items()}
    return val


def _serialize_result(result) -> dict | list:
    """Serialize op_result (dataclass / list dataclass) thành dict/list JSON-able."""
    if result is None:
        return {}
    if isinstance(result, (list, tuple)):
        return [_serialize_result(r) for r in result]
    if dataclasses.is_dataclass(result):
        return {f.name: _jsonable(getattr(result, f.name)) for f in dataclasses.fields(result)}
    return _jsonable(result)


def _apply_op_to_pdf(pdf: pikepdf.Pdf, op: EditOp, by_id: dict[str, ObjMeta],
                     layer_view_bytes: bytes | None = None):
    """
    Áp một `EditOp` lên `pdf` (pikepdf ĐANG MỞ) IN-PLACE qua `stream_editor.*` —
    TÁI DÙNG đúng logic phân nhánh của các endpoint Legacy (delete/transform/text/add),
    nhưng resolve target từ `by_id` (đã liệt kê từ BYTES hiện tại của Live_Document)
    thay vì từ path file gốc.

    pikepdf là ĐƯỜNG GHI DUY NHẤT (color-safe); TUYỆT ĐỐI KHÔNG dùng PDFium
    GenerateContent (Yêu cầu 6.1).

    Returns:
        Kết quả op (Delete/Move/.../AddResult) do `stream_editor.*` trả về.
    """
    kind = op.kind
    if kind in LAYER_EDIT_KINDS:
        normalized_op = _normalize_layer_op_ids(pdf, op, layer_view_bytes)
        return _apply_layer_edit_op(pdf, normalized_op)

    pg = _page_or_raise(pdf, op.page)

    if kind == OBJECT_VISIBILITY_KIND:
        return _apply_object_visibility(pdf, op, by_id)

    if kind == "delete":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        return delete_objects(pg, metas, pdf, all_obj_metas=list(by_id.values()))

    if kind == "move":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        return move_objects(pg, metas, op.delta.dx, op.delta.dy, pdf)

    if kind == "affine":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        return affine_transform_objects(pg, metas, op.affine or [], pdf)
    if kind == "replaceImage":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        if len(metas) != 1:
            raise ValueError("replaceImage chỉ hỗ trợ đúng một ảnh mỗi thao tác.")
        if op.image is None:
            raise ValueError("replaceImage yêu cầu dữ liệu ảnh.")
        image_source = _decode_image_source(op.image.dataRef)
        return replace_image(pg, metas[0], image_source, pdf)
    if kind == "clipImage":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        if len(metas) != 1 or op.clip is None:
            raise ValueError("clipImage yêu cầu đúng một ảnh và cấu hình khung.")
        return clip_image(pg, metas[0], op.clip.shape, op.clip.radius, pdf)
    if kind == "resize":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        return resize_objects(pg, metas, op.scale.sx, op.scale.sy, op.scale.anchor, pdf)

    if kind == "rotate":
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        return rotate_objects(pg, metas, op.rotateDeg, pdf)

    if kind == "editText":
        if op.text is None:
            raise ValueError("Thao tác editText yêu cầu trường 'text'.")
        metas = _resolve_targets(by_id, op.page, op.targetIds)
        if not metas:
            raise ValueError("Không tìm thấy đối tượng text mục tiêu.")
        new_text = op.text.content
        chosen = op.text.font or None
        primary_meta = metas[0]
        remove_metas = metas[1:] if len(metas) > 1 else None
        return edit_text(
            pg, primary_meta, new_text, pdf,
            chosen_font_path=chosen,
            remove_metas=remove_metas,
            new_size_pt=op.text.sizePt,
            new_color=op.text.color,
            bold=op.text.bold,
            italic=op.text.italic,
        )

    if kind == "paste":
        if op.delta is None:
            raise ValueError("Thao tác paste yêu cầu 'delta'.")
        source_page = op.sourcePage if op.sourcePage is not None else op.page
        if source_page == op.page:
            src_by_id = by_id
        elif layer_view_bytes is not None:
            src_by_id = _list_objects_from_bytes(layer_view_bytes, source_page)
        else:
            raise ValueError("paste cross-page yêu cầu bytes để resolve trang nguồn.")
        metas = _resolve_targets(src_by_id, source_page, op.targetIds)
        src_pg = _page_or_raise(pdf, source_page)
        return paste_objects(src_pg, pg, metas, op.delta.dx, op.delta.dy, pdf)

    if kind == "add":
        if op.text is None and op.image is None:
            raise ValueError("Thao tác add yêu cầu 'text' hoặc 'image'.")
        if op.text is not None:
            if op.text.bbox is None:
                raise ValueError("Thêm text yêu cầu 'text.bbox' để định vị.")
            font_size = op.text.sizePt if op.text.sizePt else 12.0
            return add_text(pg, op.text.content, op.text.bbox, pdf, font_size=font_size,
                            chosen_font_path=op.text.font or None)
        image_source = _decode_image_source(op.image.dataRef)
        if op.image.bbox is None:
            raise ValueError("Thêm ảnh yêu cầu image.bbox.")
        return add_image(pg, image_source, op.image.bbox, pdf)

    raise ValueError(f"op.kind không hỗ trợ: {kind!r}")



def _bbox_after_matrix(bbox: list[float], matrix: list[float]) -> list[float]:
    x0, y0, x1, y1 = normalize_bbox(list(bbox))
    a, b, c, d, e, f = [float(v) for v in matrix]
    points = [
        (x0 * a + y0 * c + e, x0 * b + y0 * d + f),
        (x1 * a + y0 * c + e, x1 * b + y0 * d + f),
        (x1 * a + y1 * c + e, x1 * b + y1 * d + f),
        (x0 * a + y1 * c + e, x0 * b + y1 * d + f),
    ]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def _resize_bbox_fast(bbox: list[float], sx: float, sy: float, anchor: str) -> list[float]:
    x0, y0, x1, y1 = normalize_bbox(list(bbox))
    anchors = {
        "nw": (x0, y1), "ne": (x1, y1),
        "sw": (x0, y0), "se": (x1, y0),
    }
    ax, ay = anchors[anchor]
    matrix = [sx, 0.0, 0.0, sy, ax * (1.0 - sx), ay * (1.0 - sy)]
    return _bbox_after_matrix([x0, y0, x1, y1], matrix)


def _rotate_bbox_fast(bbox: list[float], degrees: float) -> list[float]:
    x0, y0, x1, y1 = normalize_bbox(list(bbox))
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    angle = math.radians(float(degrees))
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    matrix = [
        cos_a, sin_a, -sin_a, cos_a,
        cx - cx * cos_a + cy * sin_a,
        cy - cx * sin_a - cy * cos_a,
    ]
    return _bbox_after_matrix([x0, y0, x1, y1], matrix)

def _compute_new_bbox(op: EditOp, op_result, post_bytes: bytes,
                      old_metas: list[ObjMeta]) -> tuple[list[float] | None, list[list[float]]]:
    """
    Tính BBox MỚI của (các) đối tượng bị tác động SAU op, để Canvas_UI cập nhật
    overlay tại chỗ (Yêu cầu 2 / design "opResult gồm bbox MỚI").

    - `add`           : lấy thẳng từ `AddResult.bbox`.
    - `delete`        : không còn đối tượng → trả None / [].
    - move/resize/rotate/editText: các op này bọc `q/cm/Q` (hoặc thay show-op)
      mà KHÔNG đổi số/đối thứ tự object trên trang → drawIndex ổn định, nên
      RE-RESOLVE theo cùng `targetIds` trên BYTES post-op cho BBox chính xác
      của PDFium. Nếu re-resolve hụt (hiếm) → fallback BBox cũ.

    Returns:
        (bbox_chính | None, danh_sách_bbox_mới_theo_target)
    """
    kind = op.kind

    if kind in LAYER_EDIT_KINDS:
        return None, []

    if kind == "add":
        bbox = list(getattr(op_result, "bbox", []) or []) or None
        return bbox, ([bbox] if bbox else [])

    if kind == "delete":
        return None, []

    if kind == "paste":
        # Object dán là bản MỚI (old_metas rỗng): bbox = bbox nguồn của từng span
        # đã dán + offset (dx, dy). Lấy từ pasted_spans của PasteResult.
        dx = float(getattr(op_result, "dx", 0.0))
        dy = float(getattr(op_result, "dy", 0.0))
        spans = list(getattr(op_result, "pasted_spans", []) or [])
        new_bboxes = [
            [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2] + dx, s.bbox[3] + dy]
            for s in spans
        ]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    # Transform hình học có kết quả xác định từ bbox cũ; tính trực tiếp để không chạy
    # PDFium lần hai trong backend. Frontend vẫn refetch đúng một lần sau op.
    if kind == "move":
        delta = op.delta
        new_bboxes = [
            [m.bbox[0] + delta.dx, m.bbox[1] + delta.dy,
             m.bbox[2] + delta.dx, m.bbox[3] + delta.dy]
            for m in old_metas
        ]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    if kind == "affine":
        new_bboxes = [_bbox_after_matrix(meta.bbox, op.affine or []) for meta in old_metas]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes
    if kind in {"replaceImage", "clipImage"}:
        new_bboxes = [normalize_bbox(list(meta.bbox)) for meta in old_metas]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    if kind == "resize":
        new_bboxes = [
            _resize_bbox_fast(meta.bbox, op.scale.sx, op.scale.sy, op.scale.anchor)
            for meta in old_metas
        ]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    if kind == "rotate":
        new_bboxes = [_rotate_bbox_fast(meta.bbox, op.rotateDeg or 0.0) for meta in old_metas]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    if kind == OBJECT_VISIBILITY_KIND:
        new_bboxes = [normalize_bbox(list(meta.bbox)) for meta in old_metas]
        return (new_bboxes[0] if new_bboxes else None), new_bboxes

    if kind == "editText":
        # PERF: Triệt tiêu quét PDFium toàn trang lặp lại (tiết kiệm 200-500ms).
        # Bbox mới được tính toán tức thì từ old_metas, cỡ chữ và độ dài text mới.
        old_union = _union_bbox([list(m.bbox) for m in old_metas])
        if old_union:
            x0, y0, x1, y1 = old_union
            old_w = max(1.0, x1 - x0)
            orig_h = max(8.0, y1 - y0)
            target_h = float(op.text.sizePt) if (op.text and op.text.sizePt and op.text.sizePt > 0) else orig_h
            font_h = max(orig_h, target_h)
            new_text_content = op.text.content if (op.text and op.text.content) else ""
            new_len = len(new_text_content)
            est_w = max(old_w, new_len * font_h * 0.65)
            new_y1 = max(y1, y0 + target_h * 1.2)
            new_bbox = [x0, y0, x0 + est_w, new_y1]
            return new_bbox, [new_bbox]
        return None, []

    # move / resize / rotate / fallback → re-resolve target trên post-op bytes.
    try:
        post_by_id = _list_objects_from_bytes(post_bytes, op.page)
    except Exception:  # noqa: BLE001 - re-resolve best-effort, fallback bbox cũ
        post_by_id = {}

    new_bboxes: list[list[float]] = []
    for meta in old_metas:
        new_meta = post_by_id.get(meta.id)
        if new_meta is not None:
            new_bboxes.append(normalize_bbox(list(new_meta.bbox)))
        else:
            new_bboxes.append(normalize_bbox(list(meta.bbox)))

    primary = new_bboxes[0] if new_bboxes else None
    return primary, new_bboxes


_EDIT_DEBUG_TRANSFORM_KINDS = frozenset({"move", "affine", "resize", "rotate"})


def _debug_pdf_value(value):
    if value is None:
        return None
    if isinstance(value, (list, tuple, pikepdf.Array)):
        return [_debug_pdf_value(item) for item in list(value)]
    if isinstance(value, (bool, int, float, str)):
        return value
    try:
        return float(value)
    except Exception:
        return str(value)


def _debug_instruction(instruction, index: int, inside: bool = False) -> dict:
    return {
        "index": index,
        "insideTargetSpan": inside,
        "operator": str(instruction.operator),
        "operands": [str(value)[:240] for value in list(instruction.operands)[:32]],
    }


def _debug_active_clips(instructions: list, stop_index: int) -> list[dict]:
    depth = 0
    active: list[dict] = []
    for index, instruction in enumerate(instructions[:max(0, stop_index)]):
        operator = str(instruction.operator)
        if operator == "q":
            depth += 1
        elif operator in {"W", "W*"}:
            active.append({"index": index, "operator": operator, "qDepth": depth})
        elif operator == "Q":
            active = [entry for entry in active if entry["qDepth"] < depth]
            depth = max(0, depth - 1)
    return active


def _debug_form_resource(page, resource_name: str | None) -> dict | None:
    if not resource_name:
        return None
    try:
        resources = page.obj.get("/Resources") or {}
        xobjects = resources.get("/XObject") or {}
        form = xobjects.get(pikepdf.Name("/" + resource_name.lstrip("/")))
        if form is None:
            return {"name": resource_name, "missing": True}
        decoded = form.read_bytes()
        group = form.get("/Group") or {}
        form_resources = form.get("/Resources") or {}
        return {
            "name": resource_name,
            "objgen": list(form.objgen) if hasattr(form, "objgen") else None,
            "subtype": str(form.get("/Subtype", "")),
            "bbox": _debug_pdf_value(form.get("/BBox")),
            "matrix": _debug_pdf_value(form.get("/Matrix")),
            "group": {
                "S": str(group.get("/S", "")),
                "CS": str(group.get("/CS", "")),
                "I": _debug_pdf_value(group.get("/I")),
                "K": _debug_pdf_value(group.get("/K")),
            } if group else None,
            "resourceKeys": sorted(str(key) for key in form_resources.keys()),
            "streamLength": len(decoded),
            "streamSha256": hashlib.sha256(decoded).hexdigest(),
        }
    except Exception as exc:
        return {"name": resource_name, "error": f"{type(exc).__name__}: {exc}"}


def _debug_transform_snapshot(
    pdf: pikepdf.Pdf,
    op: EditOp,
    metas: list[ObjMeta],
    all_metas: list[ObjMeta],
) -> dict:
    try:
        page = _page_or_raise(pdf, op.page)
        instructions = parse_page_ops(page)
        target_rows = []
        for meta in metas:
            try:
                if meta.type == "text":
                    span = map_text_show_op(page, meta, pdf=pdf)
                    spans = [span] if span is not None else []
                else:
                    spans = map_object_spans(
                        page,
                        meta,
                        pdf=pdf,
                        separate_same_bbox=_has_overlapping_object_sibling(meta, all_metas),
                    )
                span_rows = []
                for span in spans:
                    context_start = max(0, span.start - 12)
                    context_end = min(len(instructions), span.end + 12)
                    span_rows.append({
                        "start": span.start,
                        "end": span.end,
                        "kind": span.kind,
                        "bbox": list(span.bbox),
                        "ctm": list(span.ctm),
                        "resourceName": span.resource_name,
                        "ocgIds": list(span.ocgIds),
                        "activeClipOpsBeforeSpan": _debug_active_clips(instructions, span.start),
                        "operatorContext": [
                            _debug_instruction(
                                instructions[index],
                                index,
                                span.start <= index < span.end,
                            )
                            for index in range(context_start, context_end)
                        ],
                        "form": _debug_form_resource(page, span.resource_name),
                    })
                target_rows.append({
                    "id": meta.id,
                    "drawIndex": meta.drawIndex,
                    "type": meta.type,
                    "bbox": list(meta.bbox),
                    "matrix": list(meta.matrix) if meta.matrix else None,
                    "ocgIds": list(meta.ocgIds),
                    "mappedSpans": span_rows,
                })
            except Exception as exc:
                target_rows.append({
                    "id": meta.id,
                    "drawIndex": meta.drawIndex,
                    "type": meta.type,
                    "bbox": list(meta.bbox),
                    "mappingError": f"{type(exc).__name__}: {exc}",
                })
        page_box = _read_page_box(pdf, op.page) if "_read_page_box" in globals() else None
        return {
            "pageBox": page_box,
            "instructionCount": len(instructions),
            "pageClipOps": [
                {"index": index, "operator": str(instruction.operator)}
                for index, instruction in enumerate(instructions)
                if str(instruction.operator) in {"W", "W*"}
            ][:200],
            "targets": target_rows,
        }
    except Exception as exc:
        return {"snapshotError": f"{type(exc).__name__}: {exc}"}


# ── Áp Edit_Op in-memory ─────────────────────────────────────────────────────
def apply_op(session: EditSession, op: EditOp) -> dict:
    """
    Apply_In_Memory một `EditOp` lên Live_Document của `session` qua `Stream_Editor`
    (pikepdf) mà KHÔNG ghi Working_File ra đĩa (Yêu cầu 2.1).

    Luồng (giữ `session.lock` để tuần tự hóa thao tác trong cùng phiên — Yêu cầu 2.5):
      1. Xác nhận phiên còn SỐNG (Session_Id trong store) — nếu không raise
         `SessionNotFoundError` (Yêu cầu 2.4).
      2. Save BYTES hiện tại (pre-op) → resolve target qua PDFium (read-only) trên
         bytes đó để map object nhất quán trạng thái phiên; bytes này cũng là điểm
         khôi phục nếu op lỗi.
      3. Áp op IN-PLACE qua `stream_editor.*`. Nếu lỗi (map/glyph/tham số) → KHÔI
         PHỤC `pdf` từ bytes pre-op, KHÔNG đụng op_log, re-raise (Yêu cầu 6.5, 10.2, 10.3).
      4. Thành công: save BYTES post-op (cache `session.live_bytes` cho render_clip),
         tính BBox MỚI, append `op_log`, `redo_stack.clear()`, `dirty=True`, cập nhật
         `last_access` (Yêu cầu 2.2, 2.3, 7.4).

    Returns:
        opResult (dict): `{kind, page, changed, bbox, bboxes, oldBboxes, detail,
        canUndo, canRedo}` — `bbox` là BBox MỚI của đối tượng chính (None với delete).

    Raises:
        SessionNotFoundError: Session_Id không còn sống (Yêu cầu 2.4).
        ObjectMapError / GlyphCoverageError / ValueError / IndexError: op không áp
            được — Live_Document GIỮ NGUYÊN, op KHÔNG vào op_log (Yêu cầu 10.2, 10.3).
    """
    # Xác nhận phiên còn sống TRƯỚC khi đụng pdf (Yêu cầu 2.4).
    if session.session_id not in SESSIONS:
        raise SessionNotFoundError(
            f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
        )

    with session.lock:
        # Kiểm tra lại trong lock: phiên có thể bị dọn ngay trước khi giành được lock.
        if session.session_id not in SESSIONS:
            raise SessionNotFoundError(
                f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
            )

        # 1) Snapshot BYTES pre-op: vừa để resolve target nhất quán trạng thái phiên,
        #    vừa là điểm KHÔI PHỤC nếu op lỗi (đảm bảo giữ nguyên Live_Document).
        # live_bytes là snapshot thành công gần nhất. Tái dùng nó làm rollback và
        # nguồn PDFium, tránh serialize toàn bộ PDF thêm một lần ở đầu mỗi thao tác.
        pre_bytes = session.live_bytes
        if pre_bytes is None:
            pre_buf = BytesIO()
            session.pdf.save(pre_buf, compress_streams=False)
            pre_bytes = pre_buf.getvalue()
            session.live_bytes = pre_bytes
        debug_before = None
        old_metas: list[ObjMeta] = []
        by_id: dict[str, ObjMeta] = {}
        try:
            if op.kind in LAYER_EDIT_KINDS:
                by_id = {}
            else:
                if op.page in session.page_objects_cache:
                    by_id = session.page_objects_cache[op.page]
                else:
                    by_id = _list_objects_from_bytes(pre_bytes, op.page)
                    session.page_objects_cache[op.page] = by_id
                if op.kind not in ("add", "paste"):
                    try:
                        old_metas = _resolve_targets(by_id, op.page, op.targetIds)
                    except ObjectMapError:
                        # Cache stale: nạp lại từ bytes hiện tại
                        by_id = _list_objects_from_bytes(pre_bytes, op.page)
                        session.page_objects_cache[op.page] = by_id
                        old_metas = _resolve_targets(by_id, op.page, op.targetIds)

            if op.kind in _EDIT_DEBUG_TRANSFORM_KINDS and edit_bug_log_enabled():
                debug_before = _debug_transform_snapshot(
                    session.pdf, op, old_metas, list(by_id.values())
                )
                log_edit_bug(
                    "transform.before",
                    logPath=str(edit_bug_log_path()),
                    sessionId=session.session_id,
                    sourceFid=session.source_fid,
                    sourcePath=session.source_path,
                    page=op.page,
                    op=op.model_dump(mode="json"),
                    livePdfSha256=hashlib.sha256(pre_bytes).hexdigest(),
                    snapshot=debug_before,
                )

            # 2) Áp op IN-PLACE qua stream_editor/OCG editor.
            op_result = _apply_op_to_pdf(session.pdf, op, by_id, pre_bytes)
        except Exception as exc:
            if op.kind in _EDIT_DEBUG_TRANSFORM_KINDS and edit_bug_log_enabled():
                log_edit_bug(
                    "transform.error",
                    logPath=str(edit_bug_log_path()),
                    sessionId=session.session_id,
                    sourceFid=session.source_fid,
                    sourcePath=session.source_path,
                    page=op.page,
                    op=op.model_dump(mode="json"),
                    errorType=type(exc).__name__,
                    error=str(exc),
                    snapshot=debug_before,
                )
            # 3) Lỗi map/glyph/tham số (hoặc bất kỳ) → KHÔI PHỤC Live_Document từ
            #    bytes pre-op để giữ nguyên trạng thái; KHÔNG ghi op_log (Yêu cầu 10.2, 10.3).
            try:
                restored = pikepdf.Pdf.open(BytesIO(pre_bytes))
                old_pdf = session.pdf
                session.pdf = restored
                try:
                    old_pdf.close()
                except Exception:  # noqa: BLE001 - đóng best-effort
                    pass
            except Exception:  # noqa: BLE001 - khôi phục thất bại: log, vẫn re-raise lỗi gốc
                logger.exception(
                    "Khôi phục Live_Document phiên %s sau lỗi op thất bại.",
                    session.session_id,
                )
            raise

        # 4) Thành công → save BYTES post-op (cache cho render_clip) + tính bbox MỚI.
        post_buf = BytesIO()
        session.pdf.save(post_buf, compress_streams=False)
        post_bytes = post_buf.getvalue()
        session.live_bytes = post_bytes
        session.page_objects_cache.pop(op.page, None)

        primary_bbox, new_bboxes = _compute_new_bbox(op, op_result, post_bytes, old_metas)
        old_bboxes = [normalize_bbox(list(m.bbox)) for m in old_metas]
        changed = bool(getattr(op_result, "changed", True))

        if op.kind in _EDIT_DEBUG_TRANSFORM_KINDS and edit_bug_log_enabled():
            try:
                post_by_id = _list_objects_from_bytes(post_bytes, op.page)
                post_metas = [
                    post_by_id[target_id]
                    for target_id in op.targetIds
                    if target_id in post_by_id
                ]
                debug_after = _debug_transform_snapshot(
                    session.pdf, op, post_metas, list(post_by_id.values())
                )
            except Exception as exc:
                debug_after = {"snapshotError": f"{type(exc).__name__}: {exc}"}
            log_edit_bug(
                "transform.after",
                logPath=str(edit_bug_log_path()),
                sessionId=session.session_id,
                sourceFid=session.source_fid,
                sourcePath=session.source_path,
                page=op.page,
                op=op.model_dump(mode="json"),
                changed=changed,
                oldBboxes=old_bboxes,
                newBboxes=new_bboxes,
                result=_serialize_result(op_result),
                livePdfSha256=hashlib.sha256(post_bytes).hexdigest(),
                snapshot=debug_after,
            )

        # Ghi nhận op vào Op_Log theo đúng thứ tự; op mới → nhánh redo bị loại bỏ
        # (Yêu cầu 2.2, 7.4). Cập nhật trạng thái phiên (Yêu cầu 2.3).
        session.op_log.append(op)
        session.redo_stack.clear()
        session.dirty = True
        session.last_access = time.monotonic()

        return {
            "kind": op.kind,
            "page": op.page,
            "changed": changed,
            "bbox": primary_bbox,          # BBox MỚI của đối tượng chính (None nếu delete)
            "bboxes": new_bboxes,          # BBox MỚI theo từng target
            "oldBboxes": old_bboxes,       # BBox CŨ (clip vùng cũ cho move/add)
            "detail": _serialize_result(op_result),
            "canUndo": len(session.op_log) > 0,
            "canRedo": len(session.redo_stack) > 0,
        }


# ── OCG / Layer visibility (Edit PDF upgrade: real byte-level hide in live session) ─
def set_ocg_visibility(session: EditSession, layer_id: int, visible: bool) -> dict:
    """
    Thay đổi trạng thái hiển thị OCG layer TRỰC TIẾP trên Live_Document (pikepdf) trong RAM.
    Tương đương LayerEngine.set_visibility nhưng KHÔNG ghi file, chỉ mutate in-place.
    Sau khi gọi, mọi render sau (tile / clip) sẽ phản ánh visibility thật.
    """
    with session.lock:
        pdf = session.pdf
        oc_props = pdf.Root.get("/OCProperties")
        if not oc_props:
            raise ValueError("PDF has no OCG layers")

        d_dict = oc_props.get("/D")
        if not d_dict:
            d_dict = pikepdf.Dictionary()
            oc_props["/D"] = d_dict

        off_arr = list(d_dict.get("/OFF", []))

        ocgs = oc_props.get("/OCGs", [])
        target_ref = None
        for ocg_ref in ocgs:
            try:
                obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else -1
                if obj_num == layer_id:
                    target_ref = ocg_ref
                    break
            except Exception:
                pass

        if target_ref is None:
            raise ValueError(f"Layer ID {layer_id} not found")

        if not visible:
            already = any(
                (hasattr(r, 'objgen') and r.objgen[0] == layer_id) for r in off_arr
            )
            if not already:
                off_arr.append(target_ref)
        else:
            off_arr = [
                r for r in off_arr
                if not (hasattr(r, 'objgen') and r.objgen[0] == layer_id)
            ]

        d_dict["/OFF"] = pikepdf.Array(off_arr)

        session.dirty = True
        session.last_access = time.monotonic()
        session.live_bytes = None  # force re-save on next render

        return {"layer_id": layer_id, "visible": visible, "success": True}


OBJECT_VISIBILITY_KIND = "objectVisibility"
_INTERNAL_OBJECT_KEY = "/PrynXObjectKey"
_INTERNAL_FLAG = "/PrynXInternal"


def _object_visibility_key(page: int, object_id: str) -> str:
    return f"{page}:{object_id}"


def _find_internal_object_ocg(pdf: pikepdf.Pdf, key: str):
    oc_props = pdf.Root.get("/OCProperties") or {}
    for ref in list(oc_props.get("/OCGs", [])):
        try:
            if bool(ref.get(_INTERNAL_FLAG, False)) and str(ref.get(_INTERNAL_OBJECT_KEY, "")) == key:
                return ref
        except Exception:
            continue
    return None


def _set_internal_ocg_state(pdf: pikepdf.Pdf, target, visible: bool) -> None:
    _, d_dict = _ensure_ocg_config(pdf)
    target_id = _ocg_obj_id(target)
    off_refs = [ref for ref in list(d_dict.get("/OFF", [])) if _ocg_obj_id(ref) != target_id]
    on_refs = [ref for ref in list(d_dict.get("/ON", [])) if _ocg_obj_id(ref) != target_id]
    (on_refs if visible else off_refs).append(target)
    d_dict["/OFF"] = pikepdf.Array(off_refs)
    d_dict["/ON"] = pikepdf.Array(on_refs)


def _is_nonpainting_point_text_meta(meta: ObjMeta) -> bool:
    """True for PDFium whitespace/control text that paints no visible area."""
    if meta.type != "text" or len(meta.bbox) != 4:
        return False
    return (
        abs(meta.bbox[2] - meta.bbox[0]) <= 0.01
        and abs(meta.bbox[3] - meta.bbox[1]) <= 0.01
    )

def _apply_object_visibility(
    pdf: pikepdf.Pdf,
    op: EditOp,
    by_id: dict[str, ObjMeta],
) -> dict:
    """Persist object visibility with internal OCGs that are omitted from the layer UI."""
    page = _page_or_raise(pdf, op.page)
    visible = bool(op.visible)
    oc_props, _ = _ensure_ocg_config(pdf)

    # Existing wrappers only need an ON/OFF state change. New hidden targets are
    # mapped before any insertion so every OpSpan index uses one content snapshot.
    to_wrap: list[tuple[str, ObjMeta, pikepdf.Name, object]] = []
    for object_id in op.targetIds:
        key = _object_visibility_key(op.page, object_id)
        target = _find_internal_object_ocg(pdf, key)
        if target is not None:
            _set_internal_ocg_state(pdf, target, visible)
            continue
        if visible:
            continue
        meta = by_id.get(object_id)
        if meta is None:
            raise ObjectMapError(f"Không tìm thấy thành phần '{object_id}' để ẩn.")
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
        prop_name = pikepdf.Name(f"/PrynXObj{digest}")
        target = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/OCG"),
            Name=pikepdf.String(f"PrynX hidden object {object_id}"),
        ))
        target[_INTERNAL_FLAG] = True
        target[_INTERNAL_OBJECT_KEY] = pikepdf.String(key)
        oc_props["/OCGs"] = pikepdf.Array([*list(oc_props.get("/OCGs", [])), target])
        if _is_nonpainting_point_text_meta(meta):
            # Whitespace/control text has no pixels and usually shares a TJ operator
            # with neighbouring glyphs. Record the eye state without wrapping that TJ,
            # which would otherwise hide visible text beside it.
            _set_internal_ocg_state(pdf, target, False)
            continue
        to_wrap.append((object_id, meta, prop_name, target))

    if to_wrap:
        contents_coalesce(pdf, page)
        instructions = parse_page_ops(page)
        all_metas = list(by_id.values())
        prefixes: dict[int, list] = {}
        suffixes: dict[int, list] = {}

        resources = page.obj.get("/Resources")
        if not resources:
            resources = pikepdf.Dictionary()
            page.obj["/Resources"] = resources
        properties = resources.get("/Properties")
        if not properties:
            properties = pikepdf.Dictionary()
            resources["/Properties"] = properties

        for object_id, meta, prop_name, target in to_wrap:
            if meta.type == "text":
                span = map_text_show_op(page, meta, pdf=pdf)
                spans = [span] if span is not None else []
            else:
                spans = map_object_spans(
                    page,
                    meta,
                    pdf=pdf,
                    separate_same_bbox=_has_overlapping_object_sibling(meta, all_metas),
                )
            if not spans:
                raise ObjectMapError(f"Không thể ánh xạ thành phần '{object_id}' để đổi hiển thị.")
            properties[prop_name] = target
            _set_internal_ocg_state(pdf, target, False)
            for span in spans:
                prefixes.setdefault(span.start, []).append(
                    pikepdf.ContentStreamInstruction(
                        [pikepdf.Name("/OC"), prop_name], pikepdf.Operator("BDC")
                    )
                )
                suffixes.setdefault(span.end - 1, []).append(
                    pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC"))
                )

        rewritten = []
        for index, instruction in enumerate(instructions):
            rewritten.extend(prefixes.get(index, []))
            rewritten.append(instruction)
            rewritten.extend(suffixes.get(index, []))
        page.obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(rewritten))

    return {
        "changed": True,
        "visible": visible,
        "target_ids": list(op.targetIds),
    }


def hidden_object_ids(pdf: pikepdf.Pdf, page: int) -> list[str]:
    """Return persisted hidden object IDs for one page."""
    oc_props = pdf.Root.get("/OCProperties") or {}
    d_dict = oc_props.get("/D") or {}
    off_ids = {_ocg_obj_id(ref) for ref in list(d_dict.get("/OFF", []))}
    prefix = f"{page}:"
    result: list[str] = []
    for ref in list(oc_props.get("/OCGs", [])):
        try:
            key = str(ref.get(_INTERNAL_OBJECT_KEY, ""))
            if bool(ref.get(_INTERNAL_FLAG, False)) and _ocg_obj_id(ref) in off_ids and key.startswith(prefix):
                result.append(key[len(prefix):])
        except Exception:
            continue
    return result

LAYER_EDIT_KINDS = {
    "layerVisibility", "layerLock", "layerRename", "layerReorder", "layerDelete",
}


def _ocg_obj_id(ref) -> int:
    return ref.objgen[0] if hasattr(ref, "objgen") else -1


def _ensure_ocg_config(pdf: pikepdf.Pdf) -> tuple[pikepdf.Dictionary, pikepdf.Dictionary]:
    oc_props = pdf.Root.get("/OCProperties")
    if not oc_props:
        oc_props = pikepdf.Dictionary(
            OCGs=pikepdf.Array(),
            D=pikepdf.Dictionary(
                BaseState=pikepdf.Name("/ON"),
                Order=pikepdf.Array(),
            ),
        )
        pdf.Root["/OCProperties"] = oc_props
    d_dict = oc_props.get("/D")
    if not d_dict:
        d_dict = pikepdf.Dictionary(BaseState=pikepdf.Name("/ON"), Order=pikepdf.Array())
        oc_props["/D"] = d_dict
    if not d_dict.get("/BaseState"):
        d_dict["/BaseState"] = pikepdf.Name("/ON")
    return oc_props, d_dict


def _materialize_virtual_page_layer(pdf: pikepdf.Pdf, virtual_id: int):
    """Chuyển layer ảo id=-page thành OCG thật và bọc toàn bộ content của trang."""
    page_num = -int(virtual_id)
    if page_num < 1 or page_num > len(pdf.pages):
        raise ValueError(f"Virtual layer {virtual_id} does not map to a valid page")

    oc_props, d_dict = _ensure_ocg_config(pdf)
    page = pdf.pages[page_num - 1]
    prop_key = pikepdf.Name(f"/PrynXPage{page_num}")

    resources = page.obj.get("/Resources")
    if not resources:
        resources = pikepdf.Dictionary()
        page.obj["/Resources"] = resources
    properties = resources.get("/Properties")
    if not properties:
        properties = pikepdf.Dictionary()
        resources["/Properties"] = properties

    existing = properties.get(prop_key)
    if existing is not None and _ocg_obj_id(existing) > 0:
        return existing

    ocg = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/OCG"),
        Name=pikepdf.String(f"print_page_{page_num}"),
    ))
    ocgs = list(oc_props.get("/OCGs", []))
    ocgs.append(ocg)
    oc_props["/OCGs"] = pikepdf.Array(ocgs)

    order = list(d_dict.get("/Order", []))
    order.append(ocg)
    d_dict["/Order"] = pikepdf.Array(order)
    properties[prop_key] = ocg

    contents = page.obj.get("/Contents")
    if contents is not None:
        prefix = pdf.make_stream(f"/OC {prop_key} BDC\n".encode("ascii"))
        suffix = pdf.make_stream(b"\nEMC\n")
        if isinstance(contents, pikepdf.Array):
            page.obj["/Contents"] = pikepdf.Array([prefix, *list(contents), suffix])
        else:
            page.obj["/Contents"] = pikepdf.Array([prefix, contents, suffix])
    return ocg


def _property_targets_ocg(value, layer_id: int) -> bool:
    if _ocg_obj_id(value) == layer_id:
        return True
    try:
        resolved = value.resolve() if hasattr(value, "resolve") else value
        ocgs = resolved.get("/OCGs") if hasattr(resolved, "get") else None
        if isinstance(ocgs, pikepdf.Array):
            return any(_ocg_obj_id(ref) == layer_id for ref in ocgs)
        return _ocg_obj_id(ocgs) == layer_id
    except Exception:
        return False


def _remove_ocg_content(pdf: pikepdf.Pdf, layer_id: int) -> int:
    """Xóa marked-content/XObject thuộc OCG khỏi mọi trang; trả số instruction đã xóa."""
    removed_total = 0
    for page in pdf.pages:
        resources = page.obj.get("/Resources") or pikepdf.Dictionary()
        properties = resources.get("/Properties") or pikepdf.Dictionary()
        target_props = {
            str(name) for name, value in properties.items()
            if _property_targets_ocg(value, layer_id)
        }
        xobjects = resources.get("/XObject") or pikepdf.Dictionary()

        def xobject_oc(value):
            try:
                resolved = value.resolve() if hasattr(value, "resolve") else value
                return resolved.get("/OC") if hasattr(resolved, "get") else None
            except Exception:
                return None

        target_xobjects = {
            str(name) for name, value in xobjects.items()
            if _property_targets_ocg(xobject_oc(value), layer_id)
        }
        if not target_props and not target_xobjects:
            continue

        instructions = list(pikepdf.parse_content_stream(page))
        kept = []
        skip_depth = 0
        for instruction in instructions:
            op_name = str(instruction.operator)
            operands = list(getattr(instruction, "operands", []))

            if skip_depth:
                removed_total += 1
                if op_name in ("BDC", "BMC"):
                    skip_depth += 1
                elif op_name == "EMC":
                    skip_depth -= 1
                continue

            starts_target = (
                op_name == "BDC"
                and len(operands) >= 2
                and str(operands[-2]) == "/OC"
                and (
                    str(operands[-1]) in target_props
                    or _property_targets_ocg(operands[-1], layer_id)
                )
            )
            removes_target_xobject = (
                op_name == "Do"
                and operands
                and str(operands[-1]) in target_xobjects
            )
            if starts_target:
                skip_depth = 1
                removed_total += 1
                continue
            if removes_target_xobject:
                removed_total += 1
                continue
            kept.append(instruction)

        page.obj["/Contents"] = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        for name in target_props:
            key = pikepdf.Name(name)
            if key in properties:
                del properties[key]
        for name in target_xobjects:
            key = pikepdf.Name(name)
            if key in xobjects:
                del xobjects[key]
    return removed_total


def _apply_ocg_action_to_pdf(pdf: pikepdf.Pdf, action: str, **payload) -> dict:
    """Áp OCG/layer lên PDF đang mở; hỗ trợ cả layer thật và layer ảo id=-page."""
    raw_layer_id = payload.get("layer_id")
    layer_id = int(raw_layer_id) if raw_layer_id is not None else None

    # Xóa layer ảo nghĩa là xóa toàn bộ artwork của trang đó. Undo/Redo vẫn replay từ baseline.
    if action == "delete" and layer_id is not None and layer_id < 0:
        page_num = -layer_id
        if page_num < 1 or page_num > len(pdf.pages):
            raise ValueError(f"Virtual layer {layer_id} does not map to a valid page")
        pdf.pages[page_num - 1].obj["/Contents"] = pdf.make_stream(b"")
        return {
            "success": True, "action": action, "layer_id": layer_id,
            "changed": True, "removed_instructions": -1,
        }

    mapped_order = None
    if action == "reorder":
        mapped_order = []
        for item in (payload.get("new_order") or []):
            item_id = int(item)
            if item_id < 0:
                item_id = _ocg_obj_id(_materialize_virtual_page_layer(pdf, item_id))
            mapped_order.append(item_id)
    elif layer_id is not None and layer_id < 0:
        layer_id = _ocg_obj_id(_materialize_virtual_page_layer(pdf, layer_id))

    oc_props, d_dict = _ensure_ocg_config(pdf)
    ocgs = list(oc_props.get("/OCGs", []))
    target = next((ref for ref in ocgs if _ocg_obj_id(ref) == layer_id), None)

    if action == "visibility":
        if target is None:
            raise ValueError(f"Layer ID {layer_id} not found")
        off_refs = [r for r in list(d_dict.get("/OFF", [])) if _ocg_obj_id(r) != layer_id]
        on_refs = [r for r in list(d_dict.get("/ON", [])) if _ocg_obj_id(r) != layer_id]
        if bool(payload.get("visible")):
            on_refs.append(target)
        else:
            off_refs.append(target)
        d_dict["/OFF"] = pikepdf.Array(off_refs)
        d_dict["/ON"] = pikepdf.Array(on_refs)
    elif action == "lock":
        if target is None:
            raise ValueError(f"Layer ID {layer_id} not found")
        refs = [r for r in list(d_dict.get("/Locked", [])) if _ocg_obj_id(r) != layer_id]
        if bool(payload.get("locked")):
            refs.append(target)
        d_dict["/Locked"] = pikepdf.Array(refs)
    elif action == "rename":
        if target is None:
            raise ValueError(f"Layer ID {layer_id} not found")
        name = str(payload.get("name") or "").strip()
        if not name:
            raise ValueError("Layer name cannot be empty")
        target["/Name"] = pikepdf.String(name)
    elif action == "reorder":
        by_id = {_ocg_obj_id(ref): ref for ref in ocgs}
        order = mapped_order or []
        internal_refs = [ref for ref in ocgs if bool(ref.get(_INTERNAL_FLAG, False))]
        public_refs = [ref for ref in ocgs if not bool(ref.get(_INTERNAL_FLAG, False))]
        reordered_public = [
            by_id[x] for x in order if x in by_id and by_id[x] in public_refs
        ]
        reordered_public.extend(ref for ref in public_refs if _ocg_obj_id(ref) not in order)
        # Internal per-object OCGs persist but never enter the user-facing layer order.
        oc_props["/OCGs"] = pikepdf.Array([*reordered_public, *internal_refs])
        d_dict["/Order"] = pikepdf.Array(reordered_public)
    elif action == "delete":
        if target is None:
            raise ValueError(f"Layer ID {layer_id} not found")
        removed_instructions = _remove_ocg_content(pdf, layer_id)
        oc_props["/OCGs"] = pikepdf.Array(
            [r for r in ocgs if _ocg_obj_id(r) != layer_id]
        )
        for key in ("/OFF", "/ON", "/Locked"):
            d_dict[key] = pikepdf.Array(
                [r for r in list(d_dict.get(key, [])) if _ocg_obj_id(r) != layer_id]
            )

        def clean_order(items):
            cleaned = []
            for item in items:
                if _ocg_obj_id(item) == layer_id:
                    continue
                if isinstance(item, (list, pikepdf.Array)):
                    child = clean_order(item)
                    if child:
                        cleaned.append(pikepdf.Array(child))
                else:
                    cleaned.append(item)
            return cleaned

        if d_dict.get("/Order"):
            d_dict["/Order"] = pikepdf.Array(clean_order(d_dict["/Order"]))
        return {
            "success": True, "action": action, "layer_id": layer_id,
            "changed": True, "removed_instructions": removed_instructions,
        }
    else:
        raise ValueError(f"Unsupported OCG action: {action}")

    return {"success": True, "action": action, "layer_id": layer_id, "changed": True}

def _normalize_layer_op_ids(
    pdf: pikepdf.Pdf,
    op: EditOp,
    view_bytes: bytes | None,
) -> EditOp:
    """
    Map ID OCG mà UI đọc từ bytes đã serialize về objgen của pikepdf.Pdf đang sống.
    pikepdf có thể đánh lại số object mới tạo khi save (đặc biệt layer ảo vừa materialize).
    """
    positive_layer = op.layerId is not None and op.layerId > 0
    positive_order = any(item > 0 for item in (op.layerOrder or []))
    if not positive_layer and not positive_order:
        return op

    if view_bytes is None:
        buf = BytesIO()
        pdf.save(buf, compress_streams=False)
        view_bytes = buf.getvalue()

    live_props = pdf.Root.get("/OCProperties") or {}
    live_ocgs = list(live_props.get("/OCGs", []))
    view_pdf = pikepdf.Pdf.open(BytesIO(view_bytes))
    try:
        view_props = view_pdf.Root.get("/OCProperties") or {}
        view_ocgs = list(view_props.get("/OCGs", []))
        mapping: dict[int, int] = {}
        # Thứ tự /OCGs được bảo toàn khi save; tên được kiểm tra để tránh map nhầm.
        for view_ref, live_ref in zip(view_ocgs, live_ocgs):
            try:
                view_name = str(view_ref.get("/Name", ""))
                live_name = str(live_ref.get("/Name", ""))
                if view_name == live_name:
                    mapping[_ocg_obj_id(view_ref)] = _ocg_obj_id(live_ref)
            except Exception:
                continue
    finally:
        view_pdf.close()

    updates = {}
    if positive_layer:
        updates["layerId"] = mapping.get(op.layerId, op.layerId)
    if op.layerOrder is not None:
        updates["layerOrder"] = [
            mapping.get(item, item) if item > 0 else item
            for item in op.layerOrder
        ]
    return op.model_copy(update=updates) if updates else op

def _apply_layer_edit_op(pdf: pikepdf.Pdf, op: EditOp) -> dict:
    action = {
        "layerVisibility": "visibility",
        "layerLock": "lock",
        "layerRename": "rename",
        "layerReorder": "reorder",
        "layerDelete": "delete",
    }[op.kind]
    return _apply_ocg_action_to_pdf(
        pdf, action, layer_id=op.layerId, visible=op.visible, locked=op.locked,
        name=op.layerName, new_order=op.layerOrder,
    )


def apply_ocg_action(session: EditSession, action: str, **payload) -> dict:
    """Compatibility path; new UI sends layer actions through apply_op for Undo/Redo."""
    with session.lock:
        result = _apply_ocg_action_to_pdf(session.pdf, action, **payload)
        session.dirty = True
        session.last_access = time.monotonic()
        session.live_bytes = None
        return result

# ── Render tăng tiến theo vùng clip ──────────────────────────────────────────
def _read_page_box(pdf: pikepdf.Pdf, page_index: int) -> list[float] | None:
    """
    Đọc Page_Box của trang `page_index`: CropBox, fallback MediaBox (Yêu cầu 4.2).

    Trả `[bx0, by0, bx1, by1]` (PDF user-space, gốc DƯỚI-TRÁI) — chính là gốc mà
    PDFium dùng khi render (PDFium render theo CropBox). Trả None nếu không đọc được
    (caller coi như không xác định được vùng → render toàn trang).
    """
    try:
        pg = _page_or_raise(pdf, page_index)
        try:
            box = pg.cropbox  # pikepdf: tự fallback MediaBox nếu trang không có CropBox
        except Exception:  # noqa: BLE001
            box = pg.mediabox
        return [float(box[0]), float(box[1]), float(box[2]), float(box[3])]
    except Exception:  # noqa: BLE001 - đọc box best-effort
        return None


def _union_bbox(bboxes: list[list[float]]) -> list[float] | None:
    """Hợp nhất danh sách bbox [x0,y0,x1,y1] (đã normalize) thành bbox bao; None nếu rỗng."""
    valid = [b for b in bboxes if b and len(b) == 4]
    if not valid:
        return None
    x0 = min(b[0] for b in valid)
    y0 = min(b[1] for b in valid)
    x1 = max(b[2] for b in valid)
    y1 = max(b[3] for b in valid)
    return [x0, y0, x1, y1]


def _result_touches_atomic_form(op_result_dict: dict) -> bool:
    """Return True when an edit result contains a page-level Form XObject span."""
    detail = op_result_dict.get("detail") or {}
    if not isinstance(detail, dict):
        return False
    for key in (
        "moved_spans",
        "transformed_spans",
        "resized_spans",
        "rotated_spans",
        "removed_spans",
    ):
        spans = detail.get(key) or []
        if not isinstance(spans, list):
            continue
        for span in spans:
            if (
                isinstance(span, dict)
                and span.get("kind") == "vector"
                and bool(span.get("resource_name"))
            ):
                return True
    return False


def _compute_clip_region(op: EditOp, op_result_dict: dict,
                         page_box: list[float] | None,
                         clip_pad: float) -> list[float] | None:
    """
    Tính Clip_Region (PDF point, user-space tuyệt đối, gốc DƯỚI-TRÁI) bao đối tượng
    bị tác động SAU op + lề an toàn `clip_pad`, kẹp trong Page_Box (Yêu cầu 3.2, 4.1).

    Quy tắc gộp vùng:
      - `delete`: vùng không xác định giới hạn (đối tượng biến mất, có thể lộ nền
        rộng) → trả None để render TOÀN TRANG (Yêu cầu 3.6).
      - `move` / `resize` / `rotate` / `editText`: gộp vùng CŨ + MỚI để xóa "bóng ma"
        ở vị trí cũ và vẽ ở vị trí mới.
      - `add`: chỉ có vùng MỚI (không có vùng cũ).

    Trả None khi: op `delete`, thiếu Page_Box, hoặc không có bbox hợp lệ nào (vùng
    không xác định) → caller render toàn trang.
    """
    if op.kind == "delete":
        return None
    if page_box is None:
        return None
    # Form XObjects are atomic groups whose transparency group, soft masks,
    # overprint and Form /BBox all render in the surrounding page context.
    # A cropped incremental bitmap can therefore show a truncated/stale group
    # even though the edited PDF stream is correct. Use one full-page preview
    # for these relatively rare operations; the PDF itself remains vector.
    if _result_touches_atomic_form(op_result_dict):
        return None

    new_bboxes = op_result_dict.get("bboxes") or []
    old_bboxes = op_result_dict.get("oldBboxes") or []

    # move/resize/rotate/editText: gộp CŨ + MỚI. add: chỉ MỚI (oldBboxes rỗng).
    candidate = list(new_bboxes)
    if op.kind != "add":
        candidate += list(old_bboxes)

    region = _union_bbox(candidate)
    if region is None:
        return None

    # Nới lề an toàn quanh vùng (point).
    rx0 = region[0] - clip_pad
    ry0 = region[1] - clip_pad
    rx1 = region[2] + clip_pad
    ry1 = region[3] + clip_pad

    # Kẹp trong Page_Box (CropBox/MediaBox).
    bx0, by0, bx1, by1 = page_box
    rx0 = max(bx0, min(rx0, bx1))
    ry0 = max(by0, min(ry0, by1))
    rx1 = max(bx0, min(rx1, bx1))
    ry1 = max(by0, min(ry1, by1))

    # Vùng suy biến sau khi kẹp → coi như không xác định.
    if rx1 <= rx0 or ry1 <= ry0:
        return None
    return [rx0, ry0, rx1, ry1]


def render_clip(session: EditSession, op: EditOp, op_result: dict,
                scale: float = 2.0, clip_pad: float = 8.0) -> tuple[str, list[float] | None, bool]:
    """
    Render tăng tiến (Incremental_Render) Preview_Image cho `op` vừa Apply_In_Memory.

    Quy trình (giữ `session.lock` để tuần tự hóa thao tác đụng `pdf` — Yêu cầu 2.5):
      1. Tái dùng `session.live_bytes` (BYTES post-op đã được `apply_op` save SẴN —
         design "save 1 lần/op"); nếu thiếu (hiếm) thì save lại từ Live_Document.
      2. Đọc Page_Box (CropBox/MediaBox) → tính Clip_Region tuyệt đối từ bbox MỚI
         (gộp CŨ+MỚI cho move/add) + `clip_pad`, kẹp trong Page_Box.
      3. Quy đổi Clip_Region về gốc Page_Box-relative (trừ `[bx0, by0]`) để khớp ảnh
         PDFium (render theo CropBox) rồi gọi `_render_clip_blocking`.
      4. Vùng không xác định giới hạn (delete / op toàn trang / không có bbox) →
         `clipRect=None, full=True`: render TOÀN TRANG (Yêu cầu 3.6).

    Bất biến: PDFium chỉ ĐỌC/RENDER `pdf_bytes` (do pikepdf ghi) — KHÔNG GenerateContent
    (Yêu cầu 3.4, 6.1).

    Args:
        session: Edit_Session đang sống (Live_Document + cache `live_bytes`).
        op: Edit_Op vừa áp (để biết `page`, `kind`).
        op_result: dict do `apply_op` trả (chứa `bboxes` MỚI, `oldBboxes` CŨ).
        scale: px/point để render (≈ zoom×dpr).
        clip_pad: lề an toàn quanh Clip_Region (point).

    Returns:
        `(preview, clipRect, full)`:
          - `preview`: data-URI PNG (`data:image/png;base64,...`).
          - `clipRect`: `[x0, y0, x1, y1]` POINT gốc Page_Box-relative (DƯỚI-TRÁI),
            hoặc None khi render toàn trang.
          - `full`: True nếu render toàn trang (fallback), False nếu render theo clip.
    """
    # Lazy import để tránh phụ thuộc vòng (edit.py route ↔ edit_session core).
    from app.api.routes.edit import _render_clip_blocking

    with session.lock:
        # 1) Tái dùng bytes post-op đã save ở apply_op; fallback save lại nếu thiếu.
        pdf_bytes = session.live_bytes
        if pdf_bytes is None:
            buf = BytesIO()
            session.pdf.save(buf, compress_streams=False)
            pdf_bytes = buf.getvalue()
            session.live_bytes = pdf_bytes

        # 2) Page_Box + Clip_Region (tuyệt đối) → quy về Page_Box-relative.
        page_box = _read_page_box(session.pdf, op.page)
        region = _compute_clip_region(op, op_result, page_box, clip_pad)

        clip_rect: list[float] | None = None
        if region is not None and page_box is not None:
            bx0, by0 = page_box[0], page_box[1]
            clip_rect = [
                region[0] - bx0,
                region[1] - by0,
                region[2] - bx0,
                region[3] - by0,
            ]

        # 3+4) Render: clip nếu xác định được vùng, ngược lại toàn trang.
        b64, _w, _h = _render_clip_blocking(pdf_bytes, op.page, scale, clip_rect)
        if op.kind in _EDIT_DEBUG_TRANSFORM_KINDS and edit_bug_log_enabled():
            log_edit_bug(
                "preview.render",
                logPath=str(edit_bug_log_path()),
                sessionId=session.session_id,
                sourceFid=session.source_fid,
                sourcePath=session.source_path,
                page=op.page,
                op=op.model_dump(mode="json"),
                pageBox=page_box,
                absoluteRegion=region,
                clipRect=clip_rect,
                full=clip_rect is None,
                scale=scale,
                clipPad=clip_pad,
                previewWidth=_w,
                previewHeight=_h,
                livePdfSha256=hashlib.sha256(pdf_bytes).hexdigest(),
            )

    full = clip_rect is None
    preview = f"data:image/png;base64,{b64}"
    return preview, clip_rect, full


# ── Undo / Redo theo phiên (baseline + replay) ───────────────────────────────
def _replay_ops(baseline_bytes: bytes, ops: list[EditOp]) -> pikepdf.Pdf:
    """
    Tái dựng một Live_Document MỚI bằng cách MỞ từ `baseline_bytes` rồi áp tuần tự
    `ops` qua `stream_editor.*` (design Undo/Redo: "baseline + replay").

    Mỗi bước save BYTES hiện tại → resolve target qua PDFium (read-only) để map
    object nhất quán trạng thái tái dựng (giống `apply_op`), bảo đảm thứ tự object
    khớp với lúc op được áp ban đầu. pikepdf là đường GHI DUY NHẤT (color-safe);
    KHÔNG dùng PDFium GenerateContent (Yêu cầu 6.1).

    Args:
        baseline_bytes: BYTES file gốc (điểm xuất phát cố định cho replay).
        ops: danh sách Edit_Op áp tuần tự (vd. `op_log[:-1]` khi undo).

    Returns:
        `pikepdf.Pdf` đã tái dựng (caller chịu trách nhiệm đóng/đặt làm Live_Document).
    """
    pdf = pikepdf.Pdf.open(BytesIO(baseline_bytes))
    try:
        for op in ops:
            buf = BytesIO()
            pdf.save(buf, compress_streams=False)
            view_bytes = buf.getvalue()
            if op.kind in LAYER_EDIT_KINDS:
                by_id = {}
            else:
                by_id = _list_objects_from_bytes(view_bytes, op.page)
            _apply_op_to_pdf(
                pdf, op, by_id,
                view_bytes if op.kind in LAYER_EDIT_KINDS else None,
            )
    except Exception:
        # Replay thất bại → đóng pdf dở dang, re-raise để caller GIỮ NGUYÊN phiên.
        try:
            pdf.close()
        except Exception:  # noqa: BLE001 - đóng best-effort
            pass
        raise
    return pdf


def _bboxes_for_targets(pdf_bytes: bytes, page: int, target_ids: list[str]) -> list[list[float]]:
    """
    Resolve BBox (đã normalize) của `target_ids` TỪ BYTES in-memory (PDFium read-only).
    Bỏ qua id không map được (best-effort) — dùng để tính vùng clip cho undo/redo.
    """
    try:
        by_id = _list_objects_from_bytes(pdf_bytes, page)
    except Exception:  # noqa: BLE001 - resolve best-effort, trả rỗng nếu lỗi
        return []
    out: list[list[float]] = []
    for tid in target_ids:
        meta = by_id.get(tid)
        if meta is not None:
            out.append(normalize_bbox(list(meta.bbox)))
    return out


def _noop_result(reason: str, session: EditSession) -> dict:
    """
    Kết quả "không có gì để hoàn tác/làm lại" (Yêu cầu 7.6): giữ nguyên Live_Document,
    KHÔNG render, KHÔNG đụng op_log/redo_stack. Cùng dạng dict như undo/redo thành công.
    """
    return {
        "noop": True,
        "reason": reason,
        "kind": None,
        "page": None,
        "changed": False,
        "bbox": None,
        "bboxes": [],
        "oldBboxes": [],
        "detail": {},
        "preview": None,
        "clipRect": None,
        "full": False,
        "canUndo": len(session.op_log) > 0,
        "canRedo": len(session.redo_stack) > 0,
    }


def undo(session: EditSession, scale: float = 2.0, clip_pad: float = 8.0) -> dict:
    """
    Hoàn tác Edit_Op gần nhất (Yêu cầu 7.2): tái dựng Live_Document từ `baseline_bytes`
    rồi replay `op_log[:-1]`, thay `pdf`; op bị bỏ đẩy vào `redo_stack`.

    Luồng (giữ `session.lock` để tuần tự hóa thao tác đụng `pdf` — Yêu cầu 2.5):
      1. Xác nhận phiên còn SỐNG (Yêu cầu 2.4); nếu `op_log` rỗng → trả trạng thái
         không-có-gì-để-hoàn-tác, GIỮ NGUYÊN Live_Document (Yêu cầu 7.6).
      2. `_replay_ops(baseline_bytes, op_log[:-1])` → Live_Document MỚI; nếu replay
         lỗi → GIỮ NGUYÊN phiên, re-raise.
      3. Thay `pdf` (đóng cái cũ), pop op khỏi `op_log` → push `redo_stack`, cập nhật
         `live_bytes`/`dirty`/`last_access`.
      4. Tính BBox: vùng MỚI = vị trí khôi phục (sau undo); vùng CŨ = vị trí trước undo
         (xóa "bóng ma"). Render clip (ngoài lock) như `apply_op` + `render_clip`.

    Returns:
        dict cùng dạng `apply_op` (kind/page/changed/bbox/bboxes/oldBboxes/detail +
        canUndo/canRedo) KÈM `preview`/`clipRect`/`full` của render clip.

    Raises:
        SessionNotFoundError: Session_Id không còn sống (Yêu cầu 2.4, 9.5).
    """
    if session.session_id not in SESSIONS:
        raise SessionNotFoundError(
            f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
        )

    with session.lock:
        if session.session_id not in SESSIONS:
            raise SessionNotFoundError(
                f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
            )

        # Yêu cầu 7.6: không còn op để hoàn tác → giữ nguyên, báo trạng thái.
        if not session.op_log:
            return _noop_result("nothing-to-undo", session)

        undone_op = session.op_log[-1]

        # BYTES trạng thái TRƯỚC undo (= sau undone_op): vùng "bóng ma" cần xóa.
        pre_undo_bytes = session.live_bytes
        if pre_undo_bytes is None:
            buf = BytesIO()
            session.pdf.save(buf, compress_streams=False)
            pre_undo_bytes = buf.getvalue()

        # Tái dựng từ baseline + replay op_log[:-1]. Lỗi → giữ nguyên phiên.
        new_pdf = _replay_ops(session.baseline_bytes, session.op_log[:-1])

        post_buf = BytesIO()
        new_pdf.save(post_buf, compress_streams=False)
        post_bytes = post_buf.getvalue()

        # Thay Live_Document (đóng cái cũ → giải phóng RAM).
        old_pdf = session.pdf
        session.pdf = new_pdf
        try:
            old_pdf.close()
        except Exception:  # noqa: BLE001 - đóng best-effort
            pass

        # Chuyển op từ op_log → redo_stack.
        session.op_log.pop()
        session.redo_stack.append(undone_op)
        session.live_bytes = post_bytes
        session.page_objects_cache.clear()
        session.dirty = True
        session.last_access = time.monotonic()

        # BBox cho clip: MỚI = vị trí khôi phục; CŨ = vị trí trước undo (ghost).
        target_ids = [] if undone_op.kind == "add" or undone_op.kind in LAYER_EDIT_KINDS else list(undone_op.targetIds)
        new_bboxes = _bboxes_for_targets(post_bytes, undone_op.page, target_ids)
        old_bboxes = _bboxes_for_targets(pre_undo_bytes, undone_op.page, target_ids)
        primary_bbox = new_bboxes[0] if new_bboxes else None

        result = {
            "noop": False,
            "reason": None,
            "kind": undone_op.kind,
            "page": undone_op.page,
            "changed": True,
            "bbox": primary_bbox,
            "bboxes": new_bboxes,
            "oldBboxes": old_bboxes,
            "detail": (
                {"visible": not bool(undone_op.visible), "target_ids": list(undone_op.targetIds)}
                if undone_op.kind == OBJECT_VISIBILITY_KIND else {}
            ),
            "canUndo": len(session.op_log) > 0,
            "canRedo": len(session.redo_stack) > 0,
        }

    # Render clip NGOÀI lock (render_clip tự giành lock — tránh deadlock).
    preview, clip_rect, full = render_clip(session, undone_op, result, scale, clip_pad)
    result["preview"] = preview
    result["clipRect"] = clip_rect
    result["full"] = full
    return result


def redo(session: EditSession, scale: float = 2.0, clip_pad: float = 8.0) -> dict:
    """
    Làm lại Edit_Op vừa bị hoàn tác (Yêu cầu 7.3): pop `redo_stack` → áp lên `pdf`
    hiện tại qua `stream_editor.*` → push `op_log`.

    Luồng (giữ `session.lock` — Yêu cầu 2.5):
      1. Xác nhận phiên còn SỐNG (Yêu cầu 2.4); nếu `redo_stack` rỗng → trả trạng
         thái không-có-gì-để-làm-lại, GIỮ NGUYÊN Live_Document.
      2. Peek op ở đỉnh `redo_stack`; resolve target trên BYTES hiện tại; áp op
         IN-PLACE. Lỗi → KHÔI PHỤC `pdf` từ bytes pre-op, op VẪN nằm trong
         `redo_stack`, re-raise (Yêu cầu 10.2, 10.3).
      3. Thành công: pop khỏi `redo_stack`, append `op_log`, cập nhật
         `live_bytes`/`dirty`/`last_access`, tính BBox MỚI như `apply_op`.
      4. Render clip (ngoài lock).

    Returns:
        dict cùng dạng `undo` (apply_op shape + preview/clipRect/full).

    Raises:
        SessionNotFoundError: Session_Id không còn sống (Yêu cầu 2.4, 9.5).
        ObjectMapError / GlyphCoverageError / ValueError / IndexError: op không áp
            lại được — Live_Document GIỮ NGUYÊN, op vẫn trong `redo_stack`.
    """
    if session.session_id not in SESSIONS:
        raise SessionNotFoundError(
            f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
        )

    with session.lock:
        if session.session_id not in SESSIONS:
            raise SessionNotFoundError(
                f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
            )

        # Không còn op để làm lại → giữ nguyên, báo trạng thái.
        if not session.redo_stack:
            return _noop_result("nothing-to-redo", session)

        op = session.redo_stack[-1]  # peek; chỉ pop khi áp thành công.

        # Snapshot BYTES pre-op: resolve target + điểm khôi phục nếu lỗi.
        pre_buf = BytesIO()
        session.pdf.save(pre_buf, compress_streams=False)
        pre_bytes = pre_buf.getvalue()

        try:
            old_metas: list[ObjMeta] = []
            if op.kind in LAYER_EDIT_KINDS:
                by_id = {}
            else:
                by_id = _list_objects_from_bytes(pre_bytes, op.page)
                if op.kind not in ("add", "paste"):
                    old_metas = _resolve_targets(by_id, op.page, op.targetIds)
            op_result = _apply_op_to_pdf(session.pdf, op, by_id, pre_bytes)
        except Exception:
            # Khôi phục Live_Document; op VẪN trong redo_stack để thử lại.
            try:
                restored = pikepdf.Pdf.open(BytesIO(pre_bytes))
                old_pdf = session.pdf
                session.pdf = restored
                try:
                    old_pdf.close()
                except Exception:  # noqa: BLE001 - đóng best-effort
                    pass
            except Exception:  # noqa: BLE001 - khôi phục thất bại: log, vẫn re-raise
                logger.exception(
                    "Khôi phục Live_Document phiên %s sau lỗi redo thất bại.",
                    session.session_id,
                )
            raise

        # Thành công → save post-op + tính bbox MỚI (tái dùng _compute_new_bbox).
        post_buf = BytesIO()
        session.pdf.save(post_buf, compress_streams=False)
        post_bytes = post_buf.getvalue()
        session.live_bytes = post_bytes

        primary_bbox, new_bboxes = _compute_new_bbox(op, op_result, post_bytes, old_metas)
        old_bboxes = [normalize_bbox(list(m.bbox)) for m in old_metas]
        changed = bool(getattr(op_result, "changed", True))

        # Chuyển op từ redo_stack → op_log.
        session.redo_stack.pop()
        session.op_log.append(op)
        session.page_objects_cache.clear()
        session.dirty = True
        session.last_access = time.monotonic()

        result = {
            "noop": False,
            "reason": None,
            "kind": op.kind,
            "page": op.page,
            "changed": changed,
            "bbox": primary_bbox,
            "bboxes": new_bboxes,
            "oldBboxes": old_bboxes,
            "detail": _serialize_result(op_result),
            "canUndo": len(session.op_log) > 0,
            "canRedo": len(session.redo_stack) > 0,
        }

    # Render clip NGOÀI lock (render_clip tự giành lock — tránh deadlock).
    preview, clip_rect, full = render_clip(session, op, result, scale, clip_pad)
    result["preview"] = preview
    result["clipRect"] = clip_rect
    result["full"] = full
    return result


# ── Commit (Defer_Commit) ────────────────────────────────────────────────────
def _resolve_original_name(fid: str) -> str | None:
    """
    Tra `original_name` (tên người dùng tải lên) của `fid` từ bảng `UploadedFile`
    để đặt tên Working_File đẹp/nhất quán với Legacy. Best-effort — trả None nếu
    không tìm thấy (build_working_file_path sẽ fallback stem từ source_path).
    """
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if uploaded is None:
            return None
        return uploaded.original_name or uploaded.filename
    finally:
        db.close()


def _remove_unpublished_working_file(
    session: EditSession,
    output_path: str | os.PathLike[str] | None,
    *,
    operation: str,
) -> None:
    """Dọn output chưa đăng ký, nhưng không bao giờ xóa nguồn/bản commit hợp lệ."""
    if output_path is None:
        return

    protected_paths = [session.source_path]
    if session.last_commit_path:
        protected_paths.append(session.last_commit_path)
    if any(edit_io._same_path(output_path, protected) for protected in protected_paths):
        logger.error(
            "%s không dọn output chưa publication vì path đang được bảo vệ: %s",
            operation,
            output_path,
        )
        return

    try:
        Path(output_path).unlink(missing_ok=True)
    except OSError as exc:
        # Không che lỗi gốc của save/DB registration; cleanup sẽ được log riêng.
        logger.warning(
            "%s không dọn được Working File chưa publication '%s': %s",
            operation,
            output_path,
            exc,
        )


def commit(session: EditSession) -> dict:
    """
    Commit (vật chất hóa) trạng thái HIỆN TẠI của Live_Document ra một Working_File
    MỚI trên đĩa và đăng ký nó vào DB để có `fid` mới (Defer_Commit — Yêu cầu 5.2).

    Luồng (giữ `session.lock` để tuần tự hóa thao tác đụng `pdf` — Yêu cầu 2.5):
      1. Xác nhận phiên còn SỐNG (Yêu cầu 2.4, 9.5).
      2. Dựng đường dẫn Working_File MỚI (`edit_io.build_working_file_path`) dưới
         `edit_output`, rồi `edit_io.save_working_file(..., compress_streams=False)`
         với guard chống GHI ĐÈ file gốc (`original_path=source_path` — Yêu cầu 6.2).
         pikepdf là đường GHI DUY NHẤT (color-safe, giữ CMYK/spot/ICC — Yêu cầu 6.3, 6.4).
      3. Đăng ký Working_File vào DB qua `_register_working_file` (TÁI DÙNG của route
         Legacy) → `fid` mới (Yêu cầu 11.4).
      4. Thành công → `dirty=False`, cập nhật `last_commit_path` (đồng bộ tile — Yêu
         cầu 8.3) + `last_access`. Trả dict y `EditResponse`
         (`output_filename`/`output_url`/`output_path`/`output_fid`).

    Commit lỗi (Yêu cầu 5.5, 10.5): GIỮ NGUYÊN `pdf` trong RAM (KHÔNG đụng `dirty`/
    `last_commit_path`/`op_log`) và re-raise để caller thử lại — phiên vẫn dùng được.

    Returns:
        dict: `{success, output_filename, output_url, output_path, output_fid}`.

    Raises:
        SessionNotFoundError: Session_Id không còn sống (Yêu cầu 2.4, 9.5).
        Exception: bất kỳ lỗi save/đăng ký nào — Live_Document GIỮ NGUYÊN trong RAM.
    """
    # Lazy import tránh phụ thuộc vòng (edit.py route ↔ edit_session core), giống render_clip.
    from app.api.routes.edit import EDIT_OUTPUT_SUBDIR, _register_working_file

    if session.session_id not in SESSIONS:
        raise SessionNotFoundError(
            f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
        )

    with session.lock:
        # Kiểm tra lại trong lock: phiên có thể bị dọn ngay trước khi giành được lock.
        if session.session_id not in SESSIONS:
            raise SessionNotFoundError(
                f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
            )

        output_path: str | os.PathLike[str] | None = None
        saved_path: str | None = None
        try:
            # 1) Đường dẫn Working_File MỚI (random suffix → KHÔNG đè bản trước/gốc).
            original_name = _resolve_original_name(session.source_fid)
            output_path = edit_io.build_working_file_path(
                session.source_path,
                original_name,
                suffix="edited",
                output_subdir=EDIT_OUTPUT_SUBDIR,
            )

            # 2) Ghi ra đĩa (color-safe, compress_streams=False) — guard chống ghi đè gốc.
            saved_path = edit_io.save_working_file(
                session.pdf, output_path, original_path=session.source_path
            )

            # 3) Đăng ký vào DB → fid mới (tái dùng logic Legacy).
            filename = Path(saved_path).name
            output_fid = _register_working_file(saved_path, filename)
        except Exception:
            # LIFECYCLE (audit 2026-08-25 §REV.11): DB register lỗi xảy ra sau
            # khi save thành công không được để lại artifact mồ côi trên đĩa.
            _remove_unpublished_working_file(
                session,
                saved_path or output_path,
                operation="Commit",
            )
            # 4-lỗi) GIỮ NGUYÊN Live_Document trong RAM; KHÔNG đụng dirty/last_commit_path.
            logger.exception(
                "Commit phiên %s thất bại — giữ nguyên Live_Document để thử lại.",
                session.session_id,
            )
            raise

        # 4) Thành công → cập nhật trạng thái phiên (Yêu cầu 5.2, 8.3).
        abs_output_path = os.path.abspath(saved_path)
        session.last_commit_path = abs_output_path
        session.dirty = False
        session.last_access = time.monotonic()

        if (
            edit_bug_log_enabled()
            and any(item.kind in _EDIT_DEBUG_TRANSFORM_KINDS for item in session.op_log)
        ):
            log_edit_bug(
                "session.commit",
                logPath=str(edit_bug_log_path()),
                sessionId=session.session_id,
                sourceFid=session.source_fid,
                sourcePath=session.source_path,
                outputFid=output_fid,
                outputPath=abs_output_path,
                opCount=len(session.op_log),
                transformOps=[
                    item.model_dump(mode="json")
                    for item in session.op_log
                    if item.kind in _EDIT_DEBUG_TRANSFORM_KINDS
                ],
            )

        logger.info(
            "Commit phiên %s → Working_File mới fid=%s (%s).",
            session.session_id, output_fid, filename,
        )

        return {
            "success": True,
            "output_filename": filename,
            "output_url": result_access_url(f"/results/{EDIT_OUTPUT_SUBDIR}/{filename}"),
            "output_path": abs_output_path,
            "output_fid": output_fid,
        }


def flatten(session: EditSession) -> dict:
    """Flatten trạng thái layer hiện tại ra một Working File mới, không ghi đè file nguồn."""
    from app.api.routes.edit import EDIT_OUTPUT_SUBDIR, _register_working_file
    from app.core.layer_engine import LayerEngine

    if session.session_id not in SESSIONS:
        raise SessionNotFoundError(
            f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
        )

    temp_input: str | None = None
    engine_output: str | None = None
    final_path: str | None = None
    with session.lock:
        if session.session_id not in SESSIONS:
            raise SessionNotFoundError(
                f"Phiên '{session.session_id}' không tồn tại hoặc đã hết hạn."
            )
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                temp_input = tmp.name
            session.pdf.save(temp_input, compress_streams=False)

            # Giữ engine lại để đọc `last_flatten_warning`: đường raster fallback tạo
            # Working File mất vector/CMYK/màu pha mà vẫn trả success (GS-SUNSET).
            layer_engine = LayerEngine()
            engine_output = layer_engine.flatten_visible(temp_input)
            flatten_warning = layer_engine.last_flatten_warning
            original_name = _resolve_original_name(session.source_fid)
            final_path = edit_io.build_working_file_path(
                session.source_path,
                original_name,
                suffix="flattened",
                output_subdir=EDIT_OUTPUT_SUBDIR,
            )
            Path(final_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.move(engine_output, final_path)
            engine_output = None

            filename = Path(final_path).name
            output_fid = _register_working_file(final_path, filename)
        except Exception:
            _remove_unpublished_working_file(
                session,
                final_path,
                operation="Flatten",
            )
            logger.exception("Flatten phiên %s thất bại.", session.session_id)
            raise
        finally:
            for disposable in (temp_input, engine_output):
                if disposable:
                    try:
                        Path(disposable).unlink(missing_ok=True)
                    except Exception:
                        logger.warning("Không thể dọn file tạm flatten: %s", disposable)

        abs_output_path = os.path.abspath(final_path)
        session.last_commit_path = abs_output_path
        session.dirty = False
        session.last_access = time.monotonic()
        return {
            "success": True,
            "output_filename": filename,
            "output_url": result_access_url(f"/results/{EDIT_OUTPUT_SUBDIR}/{filename}"),
            "output_path": abs_output_path,
            "output_fid": output_fid,
            "warning": flatten_warning,
        }

__all__ = [
    "EditSession",
    "SessionNotFoundError",
    "SESSION_TTL",
    "SESSIONS",
    "by_fid",
    "open_session",
    "get_session",
    "get_active_session",
    "list_objects_from_session",
    "hidden_object_ids",
    "apply_op",
    "render_clip",
    "undo",
    "redo",
    "commit",
    "flatten",
    "close_session",
    "sweep_expired",
]
