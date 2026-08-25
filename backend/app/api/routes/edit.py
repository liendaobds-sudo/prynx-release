"""
Edit API Routes — REST endpoints cho tính năng Edit PDF Object (`pdf-object-edit`).

Kiến trúc (chốt qua spike):
- **PDFium (read-only)** liệt kê hình học object (`geometry_reader.list_objects`).
- **pikepdf** là đường GHI DUY NHẤT (color-safe) qua `stream_editor.*` +
  `edit_io.apply_and_save` → luôn lưu ra Working_File MỚI, KHÔNG đè file gốc
  (Yêu cầu 10.4).

Endpoints (namespace `/edit`, mount dưới prefix `/api` ở `main.py`):
  GET  /edit/objects/{fid}/{page}  — liệt kê ObjMeta của một trang (0-based).
  POST /edit/delete                — xóa tập object mục tiêu.
  POST /edit/transform             — move / resize / rotate (phân nhánh EditOp.kind).
  POST /edit/text                  — sửa nội dung text (edit_text).
  POST /edit/add                   — thêm object mới (text / image).

Quy ước trang: TẤT CẢ chỉ số trang trong namespace `/edit` đều **0-based**, đồng bộ
với `EditOp.page` (validator `ge=0`) và `geometry_reader.list_objects(page_index)`.

Map lỗi rõ ràng (Yêu cầu 4.7, 8.4, 6.5, 13.4):
  - `ObjectMapError`     → HTTP 409 (HỦY để bảo toàn màu — không map được duy nhất).
  - `GlyphCoverageError` → HTTP 422 (thiếu glyph, không có font dự phòng đủ).
  - `ValueError`         → HTTP 422 (resize ≤ 0 / bbox suy biến / tham số sai).
  - `FileNotFoundError`  → HTTP 404 (file gốc biến mất).
  - `IndexError`         → HTTP 400 (trang ngoài phạm vi).
  - Timeout an toàn      → HTTP 504 (vượt thời gian xử lý; KHÔNG đè gốc — 13.4).

_Requirements: 3.6, 5.1, 6.1, 7.1, 8.1, 9.1, 9.2, 4.7, 13.4_
"""
from __future__ import annotations

import asyncio
import base64
import dataclasses
import logging
import os
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.core import edit_session, geometry_reader, object_mapper
from app.core.artifact_lease import artifact_delete_guard, create_artifact_lease
from app.core.edit_io import apply_and_save
from app.core.edit_session import SessionNotFoundError, get_active_session, list_objects_from_session
from app.core.license_guard import require_license, result_access_url
from app.core.stream_editor import (
    GlyphCoverageError,
    ObjectMapError,
    add_image,
    add_text,
    delete_objects,
    edit_text,
    move_objects,
    resize_objects,
    rotate_objects,
)
from app.database import SessionLocal
from app.models.job import UploadedFile
from app.schemas.edit import (
    DiscardWorkingFileResponse,
    EditOp,
    ObjMeta,
    OcgActionResponse,
    OcgVisibilityResponse,
    PageObjectsPayload,
    SessionCloseResponse,
    TextObjectPropsResponse,
)

logger = logging.getLogger(__name__)

# KIENTRUC (audit 2026-07-29 §A.2 lô 13): model đã gom về app/schemas/edit.py;
# import lại ở đây để mọi đường import cũ (kể cả test) vẫn dùng được.
from app.schemas.edit import (  # noqa: F401
    EditRequest,
    EditResponse,
    OcgVisibilityRequest,
    PreviewHideReq,
    PreviewResponse,
    SessionCommitReq,
    SessionOcgActionReq,
    SessionOcgVisibilityReq,
    SessionOpReq,
    SessionOpResp,
    SessionOpenReq,
    SessionOpenResp,
    SessionRefReq,
)

router = APIRouter(dependencies=[Depends(require_license)])

# ── Cấu hình ────────────────────────────────────────────────────────────────
# Trần thời gian xử lý an toàn cho một thao tác edit (Yêu cầu 13.4). Vượt ngưỡng
# → trả 504 rõ ràng; vì apply_and_save chỉ ghi ra Working_File MỚI nên file gốc
# KHÔNG bao giờ bị đè dù thao tác bị bỏ dở.
EDIT_TIMEOUT_SECONDS: float = 120.0
FLATTEN_TIMEOUT_SECONDS: float = 300.0

# Thư mục con (dưới RESULTS_DIR) chứa Working_File của tính năng edit. Đồng bộ với
# DEFAULT_EDIT_OUTPUT_SUBDIR ở edit_io; được mount tĩnh qua "/results".
EDIT_OUTPUT_SUBDIR = "edit_output"

# DPI render preview (read-only). 150 DPI cân bằng giữa độ nét và chi phí; PDFium
# render theo scale = DPI/72 so với hệ point của PDF.
PREVIEW_DPI: float = 150.0

# ── Object list cache (in-memory, per (fid, page), TTL + LRU cap) ────────────
# Giúp load edit tool nhanh hơn rất nhiều trên trang phức tạp.
# Invalidate khi có edit thành công trên trang đó (hoặc khi fid mới từ commit).
#
# Trước đây dict thuần KHÔNG cap/TTL → mỗi (fid,page) đã xem nằm mãi; mỗi commit tạo
# fid mới → rò rỉ RAM chậm (audit RAM 2026-07-06). Nay: OrderedDict lưu (monotonic_ts,
# payload) + TTL + cap LRU, style theo edit_session.py (monotonic + lock GIỮ NGẮN).
# Cache chỉ là tối ưu tốc độ — miss thì rebuild từ pikepdf (đường đã có), không mất dữ liệu.
_object_list_cache: "OrderedDict[tuple[str, int], tuple[float, dict]]" = OrderedDict()
_OBJ_CACHE_LOCK = threading.Lock()
OBJ_CACHE_TTL: float = 600.0  # 10 phút — hết hạn thì rebuild
OBJ_CACHE_MAXSIZE: int = 64   # trần số entry; vượt → bỏ cũ nhất (LRU)


def _get_cached_objects(fid: str, page: int):
    key = (fid, page)
    with _OBJ_CACHE_LOCK:
        entry = _object_list_cache.get(key)
        if entry is None:
            return None
        ts, payload = entry
        if (time.monotonic() - ts) > OBJ_CACHE_TTL:
            _object_list_cache.pop(key, None)  # hết hạn → coi như miss
            return None
        _object_list_cache.move_to_end(key)  # LRU: đánh dấu vừa dùng
        return payload


def _set_cached_objects(fid: str, page: int, payload: dict):
    key = (fid, page)
    with _OBJ_CACHE_LOCK:
        _object_list_cache[key] = (time.monotonic(), payload)
        _object_list_cache.move_to_end(key)
        while len(_object_list_cache) > OBJ_CACHE_MAXSIZE:
            _object_list_cache.popitem(last=False)  # bỏ entry cũ nhất


def _invalidate_object_cache(fid: str, page: int | None = None):
    with _OBJ_CACHE_LOCK:
        if page is not None:
            _object_list_cache.pop((fid, page), None)
        else:
            # clear all pages for this fid
            keys = [k for k in _object_list_cache if k[0] == fid]
            for k in keys:
                _object_list_cache.pop(k, None)


# ── Request schemas ──────────────────────────────────────────────────────────




# ── Response schema ──────────────────────────────────────────────────────────




# ── Session schemas (`pdf-edit-session`) ─────────────────────────────────────














# ── Helpers ──────────────────────────────────────────────────────────────────
def _get_file_info(file_id: str) -> tuple[str, str]:
    """
    Resolve `file_id` → (file_path, original_name) từ DB — TÁI DÙNG đúng cơ chế
    của `preflight` route (bảng `UploadedFile`).

    Raises:
        HTTPException 404: nếu file_id không tồn tại hoặc file đã bị xóa khỏi đĩa.
    """
    db = SessionLocal()
    try:
        uploaded = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
        if not uploaded:
            raise HTTPException(status_code=404, detail=f"File ID '{file_id}' không tìm thấy.")
        if not os.path.exists(uploaded.file_path):
            raise HTTPException(status_code=404, detail="File đã bị xóa khỏi server.")
        return uploaded.file_path, uploaded.original_name or uploaded.filename
    finally:
        db.close()


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


def _resolve_targets(pdf_path: str, page: int, target_ids: list[str]) -> list[ObjMeta]:
    """
    Liệt kê object của trang (PDFium read-only) rồi lọc theo `target_ids`.

    Trả về danh sách `ObjMeta` đầy đủ (bbox/type/matrix) — cần thiết để
    `stream_editor.*` map về OpSpan. Bảo toàn THỨ TỰ theo `target_ids` đầu vào.

    Raises:
        HTTPException 404: nếu có targetIds không tồn tại trên trang.
    """
    metas = geometry_reader.list_objects(pdf_path, page)
    by_id = {m.id: m for m in metas}
    selected: list[ObjMeta] = []
    missing: list[str] = []
    for tid in target_ids:
        meta = by_id.get(tid)
        if meta is None:
            missing.append(tid)
        else:
            selected.append(meta)
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Không tìm thấy object mục tiêu trên trang {page}: {missing}",
        )
    return selected


def _decode_image_source(data_ref: str):
    """
    Diễn giải `ImagePayload.dataRef`:
      - Data URI base64 ("data:image/...;base64,XXXX") → trả về `bytes`.
      - Ngược lại coi là đường dẫn file ảnh trên đĩa (str) → trả nguyên chuỗi.

    `add_image` chấp nhận cả `str` (path) lẫn `bytes`.
    """
    if data_ref.startswith("data:") and "base64," in data_ref:
        b64 = data_ref.split("base64,", 1)[1]
        return base64.b64decode(b64)
    return data_ref


# Working_File của edit cũng auto-expire như upload (cleanup task dọn theo expires_at).
WORKING_FILE_EXPIRY_HOURS = 24


def _register_working_file(output_path: str, original_name: str) -> str:
    """
    Đăng ký một Working_File (đã được apply_and_save ghi ra đĩa) vào DB và trả về
    `fid` mới (UploadedFile.id).

    Bản ghi trỏ TRỰC TIẾP tới `output_path` — KHÔNG copy, KHÔNG đọc lại nội dung
    PDF (rẻ, tránh I/O thừa mỗi op). `page_count` để None (không mở PDF). `file_size`
    lấy nhanh qua os.path.getsize (rẻ). Nhờ đó thao tác edit kế tiếp chỉ cần truyền
    fid này (op thao tác trực tiếp trên kết quả mới — không tải-về/upload-lại).

    Returns:
        fid (str): id bản ghi UploadedFile mới.
    """
    abs_output_path = os.path.abspath(output_path)
    if not os.path.isfile(abs_output_path):
        raise FileNotFoundError("Working File Edit chưa tồn tại trên đĩa.")
    file_size = os.path.getsize(abs_output_path)

    db = SessionLocal()
    try:
        row = UploadedFile(
            filename=Path(abs_output_path).name,
            original_name=original_name,
            file_path=abs_output_path,
            file_size=file_size,
            page_count=None,
            pdf_metadata=None,
            expires_at=datetime.now(timezone.utc)
            + timedelta(hours=WORKING_FILE_EXPIRY_HOURS),
        )
        db.add(row)
        db.flush()
        output_fid = str(row.id)
        db.commit()
        return output_fid
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _is_edit_working_file_path(file_path: str) -> bool:
    """Chỉ chấp nhận path thật nằm dưới RESULTS_DIR/edit_output."""
    try:
        root = os.path.realpath(
            os.path.abspath(os.path.join(settings.RESULTS_DIR, EDIT_OUTPUT_SUBDIR))
        )
        candidate = os.path.realpath(os.path.abspath(file_path))
        root_key = os.path.normcase(root)
        candidate_key = os.path.normcase(candidate)
        return (
            os.path.normcase(os.path.commonpath((root, candidate))) == root_key
            and candidate_key != root_key
        )
    except (OSError, ValueError, TypeError):
        return False


def _cleanup_failed_working_file_publication(
    output_path: str,
    output_fid: str | None,
) -> None:
    """Rollback DB + artifact khi chưa tạo được lease; ưu tiên không xóa nhầm."""
    db_cleanup_ok = True
    if output_fid:
        db = SessionLocal()
        try:
            row = db.query(UploadedFile).filter(UploadedFile.id == output_fid).first()
            if row is not None:
                if os.path.normcase(os.path.abspath(row.file_path)) != os.path.normcase(
                    os.path.abspath(output_path)
                ):
                    db_cleanup_ok = False
                    logger.error(
                        "Không rollback fid=%s vì path DB không khớp artifact Edit.",
                        output_fid,
                    )
                else:
                    db.delete(row)
                    db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            db_cleanup_ok = False
            logger.exception("Không rollback được bản ghi Working File fid=%s", output_fid)
        finally:
            db.close()

    # Nếu DB rollback lỗi, giữ file để không tạo bản ghi mồ côi trỏ vào file mất.
    if not db_cleanup_ok:
        return
    try:
        with artifact_delete_guard(output_path) as may_delete:
            if may_delete:
                Path(output_path).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Không dọn được Working File chưa publication '%s': %s", output_path, exc)


def _register_and_lease_working_file(
    output_path: str,
    original_name: str,
) -> tuple[str, str]:
    """Đăng ký DB rồi tạo lease; chỉ caller nhận kết quả khi cả hai đã thành công."""
    abs_output_path = os.path.abspath(output_path)
    output_fid: str | None = None
    try:
        output_fid = _register_working_file(abs_output_path, original_name)
        lease_token = create_artifact_lease(
            "edit",
            abs_output_path,
            fid=output_fid,
        )
        return output_fid, lease_token
    except Exception:
        _cleanup_failed_working_file_publication(abs_output_path, output_fid)
        raise


def _lease_registered_working_file(output_path: str, output_fid: str) -> str:
    """Tạo lease cho output phiên đã đăng ký; lỗi thì rollback cả DB lẫn file."""
    abs_output_path = os.path.abspath(output_path)
    try:
        return create_artifact_lease("edit", abs_output_path, fid=output_fid)
    except Exception:
        _cleanup_failed_working_file_publication(abs_output_path, output_fid)
        raise


def _safe_watermark(pdf_path: str, license_info: dict | None) -> None:
    """Nhúng stealth watermark vào Working_File xuất ra (non-blocking).

    Bỏ qua ở dev mode (license_key == 'DEV_MODE') hoặc khi thiếu license_key.
    """
    lk = (license_info or {}).get("license_key", "") or ""
    if not lk or lk == "DEV_MODE":
        return
    hwid = (license_info or {}).get("hwid", "") or ""
    tmp_path = None
    try:
        import tempfile
        import pikepdf
        from app.core.watermark import embed_watermark
        with pikepdf.Pdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            embed_watermark(pdf, lk, hwid)
            # Ghi atomic: save ra temp cùng thư mục rồi os.replace, tránh hỏng
            # output nếu process chết giữa chừng khi ghi đè in-place.
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
            os.close(fd)
            pdf.save(tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.error(f"[WATERMARK] edit output failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _build_output_response(output_path: str, op_result, license_info: dict | None = None) -> EditResponse:
    """Dựng EditResponse từ Working_File mới + op_result."""
    # Đóng dấu bản quyền TRƯỚC khi đăng ký (để file_size lưu trong DB khớp file đã watermark).
    _safe_watermark(output_path, license_info)
    filename = Path(output_path).name
    output_fid, artifact_lease = _register_and_lease_working_file(output_path, filename)
    # output_path PHẢI tuyệt đối: client desktop (Tauri) có cwd KHÁC backend, nên
    # path tương đối (vd. RESULTS_DIR=./results) sẽ không phân giải được khi
    # native tile renderer / convertFileSrc mở file → trang kẹt "RENDERING" vô hạn.
    abs_output_path = os.path.abspath(output_path)
    return EditResponse(
        success=True,
        output_filename=filename,
        output_url=result_access_url(f"/results/{EDIT_OUTPUT_SUBDIR}/{filename}"),
        output_path=abs_output_path,
        output_fid=output_fid,
        artifact_lease=artifact_lease,
        result=_serialize_result(op_result),
    )


async def _execute(blocking_fn, license_info: dict | None = None) -> EditResponse:
    """
    Chạy thao tác edit (đồng bộ, nặng) trong threadpool với TRẦN THỜI GIAN an toàn
    (Yêu cầu 13.4) và map lỗi domain → HTTP status rõ ràng.

    Mọi đường ghi đi qua `apply_and_save` (lưu ra path MỚI) nên dù timeout/lỗi,
    file gốc KHÔNG bị đè.
    """
    loop = asyncio.get_event_loop()
    try:
        output_path, op_result = await asyncio.wait_for(
            loop.run_in_executor(None, blocking_fn), timeout=EDIT_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                "Thao tác chỉnh sửa vượt thời gian xử lý an toàn "
                f"({EDIT_TIMEOUT_SECONDS:.0f}s). Đã HỦY — KHÔNG ghi đè file gốc "
                "(Yêu cầu 13.4). Vui lòng thử lại với phạm vi nhỏ hơn."
            ),
        )
    except HTTPException:
        raise
    except ObjectMapError as exc:
        # Không map được object duy nhất → HỦY để bảo toàn màu (Yêu cầu 4.7).
        raise HTTPException(status_code=409, detail=str(exc))
    except GlyphCoverageError as exc:
        # Thiếu glyph và không có font dự phòng đủ (Yêu cầu 8.4).
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        # Không trả str(exc) ra client: nó chứa đường dẫn nội bộ. Log nội bộ,
        # client nhận message generic.
        logger.warning("Tài nguyên không tìm thấy: %s", exc)
        raise HTTPException(status_code=404, detail="Không tìm thấy tài nguyên yêu cầu.")
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        # resize ≤ 0 / bbox suy biến / tham số sai (Yêu cầu 6.5).
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Thao tác edit thất bại")
        raise HTTPException(status_code=500, detail=f"Thao tác chỉnh sửa thất bại: {exc}")

    return _build_output_response(output_path, op_result, license_info)


def _page_or_raise(pdf, page_index: int):
    """Lấy `pikepdf.Page` theo chỉ số 0-based; IndexError nếu ngoài phạm vi."""
    n = len(pdf.pages)
    if page_index < 0 or page_index >= n:
        raise IndexError(f"Trang {page_index} ngoài phạm vi (0..{n - 1}).")
    return pdf.pages[page_index]


def _apply_edit_op(pdf, op: EditOp, pdf_path: str):
    """
    Áp một `EditOp` lên `pdf` (pikepdf ĐANG MỞ) IN-PLACE qua các hàm
    `stream_editor.*` — TÁI DÙNG đúng logic phân nhánh của các endpoint
    /delete, /transform, /text, /add (task 9.1).

    Dùng chung cho cả đường GHI (apply_and_save) lẫn đường PREVIEW (render bytes).
    Object mục tiêu được resolve qua Geometry_Reader (PDFium read-only) từ
    `pdf_path` — nhất quán với `pdf` vì cùng mở từ một file gốc.

    Returns:
        Kết quả op (Delete/Move/... Result) do `stream_editor.*` trả về.
    """
    pg = _page_or_raise(pdf, op.page)
    kind = op.kind

    if kind == "delete":
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)
        return delete_objects(pg, metas, pdf)

    if kind == "move":
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)
        return move_objects(pg, metas, op.delta.dx, op.delta.dy, pdf)

    if kind == "resize":
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)
        return resize_objects(pg, metas, op.scale.sx, op.scale.sy, op.scale.anchor, pdf)

    if kind == "rotate":
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)
        return rotate_objects(pg, metas, op.rotateDeg, pdf)

    if kind == "editText":
        if op.text is None:
            raise ValueError("Thao tác editText yêu cầu trường 'text'.")
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)
        new_text = op.text.content
        # `op.text.font` = ĐƯỜNG DẪN file font người dùng chọn (nếu có) → nhúng font đó.
        chosen = op.text.font or None
        results = [edit_text(pg, meta, new_text, pdf, chosen_font_path=chosen) for meta in metas]
        return results[0] if len(results) == 1 else results

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
        return add_image(pg, image_source, op.image.bbox, pdf)

    raise ValueError(f"op.kind không hỗ trợ: {kind!r}")


def _render_clip_blocking(
    pdf_bytes: bytes,
    page: int,
    scale: float,
    clip_rect: list[float] | None = None,
) -> tuple[str, int, int]:
    """Bọc `_render_clip_blocking_locked` trong `pdfium_guard` (audit 2026-07-29 §C.1).

    Hàm này được `core/edit_session.render_clip` gọi qua threadpool cho từng thao tác
    sửa, nên hai tab/hai thao tác liên tiếp là hai thread cùng chạm PDFium. Dùng wrapper
    thay vì thụt lề lại thân hàm dài để diff dễ soi và thân hàm không đổi một dòng.
    Tên hàm giữ NGUYÊN vì `edit_session` import đúng tên này.
    """
    from app.core.pdfium_lock import pdfium_guard

    with pdfium_guard("edit_render_clip"):
        return _render_clip_blocking_locked(pdf_bytes, page, scale, clip_rect)


def _render_clip_blocking_locked(
    pdf_bytes: bytes,
    page: int,
    scale: float,
    clip_rect: list[float] | None = None,
) -> tuple[str, int, int]:
    """
    Render READ-ONLY trang `page` của `pdf_bytes` bằng PDFium ở `scale` (px/point)
    rồi (tùy chọn) CROP ảnh theo `clip_rect` bằng PIL.

    - `clip_rect=None` → trả ảnh TOÀN TRANG (hành vi cũ của `/edit/preview`).
    - `clip_rect=[x0, y0, x1, y1]` (PDF point, gốc Page_Box-relative, gốc DƯỚI-TRÁI)
      → crop ảnh toàn trang về đúng vùng đó. Việc quy đổi qua Page_Box (CropBox lệch
      gốc) được thực hiện ở TẦNG TRÊN (`render_clip` trong `edit_session.py`); ở đây
      chỉ nhân `scale` và lật trục y để khớp ảnh PDFium (gốc TRÊN-TRÁI).

    CẤM TUYỆT ĐỐI dùng PDFium để GHI: PDFium ở đây CHỈ mở `pdf_bytes` (do pikepdf
    ghi) ở chế độ đọc và render ra ảnh (Yêu cầu 3.4, 6.1). Không tạo file tạm — toàn
    bộ nằm trong bộ nhớ.

    Trả về `(b64_png, width, height)`: chuỗi base64 ASCII của PNG (KHÔNG kèm tiền tố
    `data:`) cùng kích thước pixel của ảnh kết quả (đã crop nếu có `clip_rect`).
    """
    import pypdfium2 as pdfium

    # Trần cạnh dài bitmap (px) — chặn OOM + tránh render/encode khổng lồ. Đường tile
    # có cap tương tự; đường session TRƯỚC ĐÂY thiếu → scale cao render CẢ trang thành
    # bitmap ~14000×20000px (~12s/op). Cap này áp cho CẢ nhánh clip lẫn full-page.
    _MAX_EDGE_PX = 4000

    render_doc = pdfium.PdfDocument(pdf_bytes)
    try:
        n_pages = len(render_doc)
        if page < 0 or page >= n_pages:
            raise IndexError(f"Trang {page} ngoài phạm vi (0..{n_pages - 1}).")
        render_page = render_doc[page]
        page_w_pt, page_h_pt = render_page.get_size()

        if clip_rect is not None:
            x0, y0, x1, y1 = clip_rect
            # Chuẩn hóa thứ tự cạnh (phòng x1<x0 / y1<y0).
            if x1 < x0:
                x0, x1 = x1, x0
            if y1 < y0:
                y0, y1 = y1, y0
            # Kẹp vùng trong khổ trang (point) trước khi render.
            x0 = max(0.0, min(x0, page_w_pt))
            x1 = max(0.0, min(x1, page_w_pt))
            y0 = max(0.0, min(y0, page_h_pt))
            y1 = max(0.0, min(y1, page_h_pt))
            region_w_pt = x1 - x0
            region_h_pt = y1 - y0
            # Vùng suy biến → fallback render toàn trang (an toàn, hiếm).
            if region_w_pt <= 0 or region_h_pt <= 0:
                clip_rect = None

        if clip_rect is not None:
            # Cap scale theo cạnh dài VÙNG CLIP (không phải cả trang).
            longest_pt = max(region_w_pt, region_h_pt)
            eff_scale = min(scale, _MAX_EDGE_PX / longest_pt) if longest_pt > 0 else scale
            # Align crop edges to the same pixel grid used by a full-page render.
            # Without this, fractional scales can shift PDFium antialiasing by a
            # sub-pixel and the incremental preview visibly flickers at its seam.
            x0 = round(x0 * eff_scale) / eff_scale
            x1 = round(x1 * eff_scale) / eff_scale
            y0 = round(y0 * eff_scale) / eff_scale
            y1 = round(y1 * eff_scale) / eff_scale

            # Render CHỈ vùng clip: `crop=(left, bottom, right, top)` theo point tính từ
            # mép trang (đã kiểm thực nghiệm khớp full-render + PIL-crop, diff ~0.0002).
            # clip_rect là Page_Box-relative, gốc DƯỚI-TRÁI → left=x0, bottom=y0,
            # right=page_w-x1, top=page_h-y1. Vùng NGOÀI clip KHÔNG bị rasterize.
            crop = (x0, y0, page_w_pt - x1, page_h_pt - y1)
            bitmap = render_page.render(scale=eff_scale, crop=crop)
            img = bitmap.to_pil()
        else:
            # Toàn trang (delete / vùng không xác định): cap scale theo cạnh dài TRANG.
            longest_pt = max(page_w_pt, page_h_pt)
            eff_scale = min(scale, _MAX_EDGE_PX / longest_pt) if longest_pt > 0 else scale
            bitmap = render_page.render(scale=eff_scale)
            img = bitmap.to_pil()

        width, height = img.size
        out = BytesIO()
        img.save(out, format="PNG")
        b64 = base64.b64encode(out.getvalue()).decode("ascii")
    finally:
        render_doc.close()

    return b64, int(width), int(height)


def _render_preview_blocking(pdf_path: str, op: EditOp) -> PreviewResponse:
    """
    Áp `op` lên bản sao in-memory của `pdf_path` (pikepdf) → lấy BYTES qua
    `pdf.save(BytesIO)` → render trang `op.page` bằng PDFium (read-only) → PNG base64.

    CẤM TUYỆT ĐỐI dùng PDFium để GHI kết quả: PDFium ở đây CHỈ mở bytes (do pikepdf
    ghi) ở chế độ đọc và render ra ảnh; mọi thay đổi nội dung đều do pikepdf thực
    hiện trên đường ghi (Yêu cầu 12.2). Không tạo file tạm trên đĩa — bytes nằm
    hoàn toàn trong bộ nhớ.
    """
    import pikepdf

    # 1) Áp thao tác bằng pikepdf (đường GHI color-safe) → lấy bytes in-memory.
    with pikepdf.Pdf.open(pdf_path) as pdf:
        _apply_edit_op(pdf, op, pdf_path)
        buf = BytesIO()
        # compress_streams=False: KHÔNG nén lại stream ảnh đã nén → nhanh ~10× trên
        # file ảnh nặng (xem ghi chú edit_io.save_working_file). Chỉ để render preview.
        pdf.save(buf, compress_streams=False)
    pdf_bytes = buf.getvalue()

    # 2) Render READ-ONLY TOÀN TRANG (clip_rect=None) — giữ nguyên hành vi cũ.
    b64, width, height = _render_clip_blocking(
        pdf_bytes, op.page, PREVIEW_DPI / 72.0, None
    )

    return PreviewResponse(
        success=True,
        image=f"data:image/png;base64,{b64}",
        width=int(width),
        height=int(height),
        page=op.page,
    )


def _render_hide_preview_blocking(
    pdf_bytes: bytes,
    page: int,
    target_ids: list[str],
) -> PreviewResponse:
    """Hide selected live objects in-memory and render the resulting full page."""
    import pikepdf

    all_metas = geometry_reader.list_objects(pdf_bytes, page)
    wanted = set(target_ids)
    targets = [meta for meta in all_metas if meta.id in wanted]
    if targets:
        with pikepdf.Pdf.open(BytesIO(pdf_bytes)) as pdf:
            if page < 0 or page >= len(pdf.pages):
                raise IndexError(f"Trang {page} ngoài phạm vi (0..{len(pdf.pages) - 1}).")
            delete_objects(
                pdf.pages[page], targets, pdf, all_obj_metas=all_metas
            )
            out = BytesIO()
            pdf.save(out, compress_streams=False)
            pdf_bytes = out.getvalue()

    b64, width, height = _render_clip_blocking(
        pdf_bytes, page, PREVIEW_DPI / 72.0, None
    )
    return PreviewResponse(
        success=True,
        image=f"data:image/png;base64,{b64}",
        width=int(width),
        height=int(height),
        page=page,
    )


async def _execute_hide_preview(
    pdf_bytes: bytes,
    page: int,
    target_ids: list[str],
) -> PreviewResponse:
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(
                None, _render_hide_preview_blocking, pdf_bytes, page, target_ids
            ),
            timeout=EDIT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Tạo preview vượt thời gian xử lý an toàn.")
    except ObjectMapError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tạo preview ẩn thành phần thất bại")
        raise HTTPException(status_code=500, detail=f"Tạo preview ẩn thành phần thất bại: {exc}")

def _render_full_page_blocking(pdf_path: str, page: int) -> PreviewResponse:
    """
    Render READ-ONLY TOÀN TRANG `page` của file gốc (KHÔNG áp op nào) → PNG base64.

    Dùng cho nhánh `preview-hide` khi danh sách targetIds rỗng (sau khi lọc id còn
    tồn tại): vẫn trả về ảnh trang bình thường để FE đắp overlay khớp khung trang.
    Đọc bytes vào RAM rồi render bằng PDFium (read-only) — KHÔNG ghi file, KHÔNG
    tạo file tạm.
    """
    with open(pdf_path, "rb") as fh:
        pdf_bytes = fh.read()
    b64, width, height = _render_clip_blocking(
        pdf_bytes, page, PREVIEW_DPI / 72.0, None
    )
    return PreviewResponse(
        success=True,
        image=f"data:image/png;base64,{b64}",
        width=int(width),
        height=int(height),
        page=page,
    )


async def _execute_full_page_preview(pdf_path: str, page: int) -> PreviewResponse:
    """Render full-page preview trong threadpool + map lỗi (đồng bộ `_execute_preview`)."""
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, _render_full_page_blocking, pdf_path, page),
            timeout=EDIT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                "Tạo preview vượt thời gian xử lý an toàn "
                f"({EDIT_TIMEOUT_SECONDS:.0f}s). Đã HỦY (Yêu cầu 13.4)."
            ),
        )
    except HTTPException:
        raise
    except FileNotFoundError as exc:
        # Không trả str(exc) ra client: nó chứa đường dẫn nội bộ. Log nội bộ,
        # client nhận message generic.
        logger.warning("Tài nguyên không tìm thấy: %s", exc)
        raise HTTPException(status_code=404, detail="Không tìm thấy tài nguyên yêu cầu.")
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tạo preview full-page thất bại")
        raise HTTPException(status_code=500, detail=f"Tạo preview full-page thất bại: {exc}")


async def _execute_preview(pdf_path: str, op: EditOp) -> PreviewResponse:
    """
    Chạy render preview trong threadpool với TRẦN THỜI GIAN an toàn (Yêu cầu 13.4)
    và map lỗi domain → HTTP status RÕ RÀNG, đồng bộ với `_execute` (đường ghi).
    """
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, _render_preview_blocking, pdf_path, op),
            timeout=EDIT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                "Tạo preview vượt thời gian xử lý an toàn "
                f"({EDIT_TIMEOUT_SECONDS:.0f}s). Đã HỦY (Yêu cầu 13.4)."
            ),
        )
    except HTTPException:
        raise
    except ObjectMapError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except GlyphCoverageError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        # Không trả str(exc) ra client: nó chứa đường dẫn nội bộ. Log nội bộ,
        # client nhận message generic.
        logger.warning("Tài nguyên không tìm thấy: %s", exc)
        raise HTTPException(status_code=404, detail="Không tìm thấy tài nguyên yêu cầu.")
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tạo preview thất bại")
        raise HTTPException(status_code=500, detail=f"Tạo preview thất bại: {exc}")


async def _execute_session(blocking_fn, timeout_seconds: float = EDIT_TIMEOUT_SECONDS):
    """
    Chạy một thao tác PHIÊN (đồng bộ, đụng `pikepdf`/PDFium) trong threadpool với
    TRẦN THỜI GIAN an toàn (Yêu cầu 10.1) và map lỗi domain → HTTP status RÕ RÀNG
    cho namespace `/edit/session/*`.

    Map lỗi (design "Map lỗi → HTTP"):
      - timeout                → 504 (giữ nguyên `pdf`; op CHƯA append op_log).
      - SessionNotFoundError   → 410 Gone (FE bắt → fallback Legacy_Commit_Flow).
      - ObjectMapError         → 409 (không map được object duy nhất — bảo toàn màu).
      - GlyphCoverageError     → 422 (thiếu glyph).
      - ValueError             → 422 (tham số sai / bbox suy biến).
      - FileNotFoundError      → 404 (file gốc biến mất).
      - IndexError             → 400 (trang ngoài phạm vi).
    """
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, blocking_fn), timeout=timeout_seconds
        )
    except asyncio.TimeoutError:
        # Timeout: thao tác bị HỦY. apply_op/undo/redo chỉ append op_log SAU khi áp
        # thành công nên op CHƯA vào log; Live_Document giữ nguyên (Yêu cầu 10.1, 10.3).
        raise HTTPException(
            status_code=504,
            detail=(
                "Thao tác phiên vượt thời gian xử lý an toàn "
                f"({timeout_seconds:.0f}s). Đã HỦY — giữ nguyên trạng thái phiên "
                "(Yêu cầu 10.1)."
            ),
        )
    except HTTPException:
        raise
    except SessionNotFoundError as exc:
        # Phiên không tồn tại/đã dọn TTL → 410 để FE khởi tạo lại / fallback Legacy
        # (Yêu cầu 9.5, 11.1).
        raise HTTPException(status_code=410, detail=str(exc))
    except ObjectMapError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except GlyphCoverageError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except FileNotFoundError as exc:
        # Không trả str(exc) ra client: nó chứa đường dẫn nội bộ. Log nội bộ,
        # client nhận message generic.
        logger.warning("Tài nguyên không tìm thấy: %s", exc)
        raise HTTPException(status_code=404, detail="Không tìm thấy tài nguyên yêu cầu.")
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Thao tác phiên thất bại")
        raise HTTPException(status_code=500, detail=f"Thao tác phiên chỉnh sửa thất bại: {exc}")


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/edit/objects/{fid}/{page}", response_model=PageObjectsPayload)
async def list_page_objects(fid: str, page: int):
    """
    Liệt kê object (text/image/vector) của một trang (PDFium read-only).
    Ưu tiên dùng Live EditSession (nếu đang mở) để:
      - Nhanh (không mở file từ đĩa)
      - Phản ánh thay đổi chưa commit (sau move/edit text...)
    Dùng cache đơn giản để load công cụ edit gần như tức thì.

    `page` là chỉ số 0-based.
    """
    # 1. Cache hit nhanh
    cached = _get_cached_objects(fid, page)
    if cached:
        return cached

    pdf_path, _ = _get_file_info(fid)

    # 2. Thử lấy từ session đang sống (nhanh + state mới nhất)
    try:
        session = edit_session.get_active_session(fid)
        if session:
            with session.lock:
                objects_list = edit_session.list_objects_from_session(
                    session, page, include_text_props=False
                )
                object_mapper.enrich_object_ocg_memberships(
                    session.pdf.pages[page], objects_list, session.pdf
                )
        else:
            objects_list = geometry_reader.list_objects(
                pdf_path, page, include_text_props=False
            )
            import pikepdf
            with pikepdf.Pdf.open(pdf_path) as source_pdf:
                object_mapper.enrich_object_ocg_memberships(
                    source_pdf.pages[page], objects_list, source_pdf
                )
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Liệt kê object thất bại")
        raise HTTPException(status_code=500, detail=f"Liệt kê object thất bại: {exc}")

    # 3. Lấy pageBox (CropBox) từ đĩa (nhẹ, chỉ cần metadata)
    page_box: list[float] | None = None
    try:
        import pikepdf
        with pikepdf.open(pdf_path) as _pdf:
            if 0 <= page < len(_pdf.pages):
                _pg = _pdf.pages[page]
                try:
                    _b = _pg.cropbox  # pikepdf: fallback MediaBox nếu không có CropBox
                except Exception:  # noqa: BLE001
                    _b = _pg.mediabox
                page_box = [float(_b[0]), float(_b[1]), float(_b[2]), float(_b[3])]
    except Exception:  # noqa: BLE001 - đọc box best-effort
        page_box = None

    hidden_ids: list[str] = []
    try:
        if session:
            with session.lock:
                hidden_ids = edit_session.hidden_object_ids(session.pdf, page)
        else:
            import pikepdf
            with pikepdf.Pdf.open(pdf_path) as source_pdf:
                hidden_ids = edit_session.hidden_object_ids(source_pdf, page)
    except Exception:  # visibility metadata is best-effort; object listing still succeeds
        hidden_ids = []

    payload = {
        "objects": [o.model_dump() for o in objects_list],
        "pageBox": page_box,
        "hiddenObjectIds": hidden_ids,
    }
    _set_cached_objects(fid, page, payload)
    return payload


@router.get("/edit/text-props/{fid}/{page}/{index}", response_model=TextObjectPropsResponse)
async def get_text_props(fid: str, page: int, index: int):
    """
    LAZY: nội dung/màu/font của MỘT text-object (theo drawIndex) — gọi khi mở
    editor sửa text. Tách khỏi /edit/objects để liệt kê trang nhanh.
    """
    pdf_path, _ = _get_file_info(fid)
    try:
        props = geometry_reader.get_text_object_props(pdf_path, page, index)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Lấy text-props thất bại")
        raise HTTPException(status_code=500, detail=f"Lấy thuộc tính text thất bại: {exc}")
    return props


# ── OCG visibility for Edit PDF (live session) ────────────────────────────────


@router.post("/edit/ocg/visibility", response_model=OcgVisibilityResponse)
async def set_edit_ocg_visibility(req: OcgVisibilityRequest, license_info: dict = Depends(require_license)):
    """
    Áp dụng ẨN/HIỆN OCG layer TRỰC TIẾP lên EditSession sống (pikepdf in-RAM).
    Khi thành công, mọi tile render sau sẽ phản ánh trạng thái visibility thật (không chỉ overlay preview).
    Dùng trong chế độ Edit PDF cho panel "Lớp & Thành phần".
    """
    try:
        session = edit_session.get_active_session(req.fid)
        if not session:
            raise HTTPException(status_code=410, detail="No active edit session for OCG toggle (open edit session first).")
        result = edit_session.set_ocg_visibility(session, req.layer_id, req.visible)
        return {"success": True, **result}
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("set ocg visibility failed")
        raise HTTPException(status_code=500, detail=f"Đổi hiển thị layer thất bại: {exc}")


@router.delete("/edit/working/{fid}", response_model=DiscardWorkingFileResponse)
async def discard_working_file(fid: str):
    """
    Dọn một Working_File TRUNG GIAN không còn cần (bị loại khỏi undo/redo của
    client). AN TOÀN: CHỈ xóa file nằm trong thư mục `edit_output` (Working_File
    do edit tạo) — KHÔNG bao giờ xóa file gốc người dùng tải lên.

    Idempotent: fid không tồn tại / không phải working-file → trả deleted=False.
    """
    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == fid).first()
        if row is None or not row.file_path:
            return {"deleted": False, "reason": "not_found"}
        # Chỉ xóa khi path thật thuộc edit_output; không dựa substring dễ nhầm.
        if not _is_edit_working_file_path(row.file_path):
            return {"deleted": False, "reason": "not_working_file"}
        # LIFECYCLE (audit 2026-08-25 §REV.11): recheck lease sát unlink và giữ
        # cùng lock qua cả thao tác xóa, nên claim không thể chen vào giữa.
        with artifact_delete_guard(row.file_path) as may_delete:
            if not may_delete:
                return {"deleted": False, "reason": "leased"}
            try:
                if os.path.exists(row.file_path):
                    os.remove(row.file_path)
            except OSError as exc:
                logger.warning("Không xóa được Working_File '%s': %s", row.file_path, exc)
                return {"deleted": False, "reason": "error"}
            db.delete(row)
            db.commit()
            return {"deleted": True}
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("discard_working_file lỗi: %s", exc)
        return {"deleted": False, "reason": "error"}
    finally:
        db.close()


@router.post("/edit/delete", response_model=EditResponse)
async def edit_delete(req: EditRequest, license_info: dict = Depends(require_license)):
    """Xóa tập object mục tiêu + lưu Working_File mới (color-safe)."""
    if req.op.kind != "delete":
        raise HTTPException(status_code=422, detail="Endpoint /edit/delete yêu cầu op.kind='delete'.")

    pdf_path, original_name = _get_file_info(req.fid)
    op = req.op

    def _do() -> tuple[str, object]:
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)

        def _mutate(pdf):
            pg = _page_or_raise(pdf, op.page)
            return delete_objects(pg, metas, pdf)

        return apply_and_save(
            pdf_path, _mutate, original_name=original_name, suffix="deleted",
            output_subdir=EDIT_OUTPUT_SUBDIR,
        )

    return await _execute(_do, license_info)


@router.post("/edit/transform", response_model=EditResponse)
async def edit_transform(req: EditRequest, license_info: dict = Depends(require_license)):
    """Move / resize / rotate tập object mục tiêu (phân nhánh theo op.kind)."""
    op = req.op
    if op.kind not in ("move", "resize", "rotate"):
        raise HTTPException(
            status_code=422,
            detail="Endpoint /edit/transform yêu cầu op.kind ∈ {move, resize, rotate}.",
        )

    pdf_path, original_name = _get_file_info(req.fid)
    suffix = {"move": "moved", "resize": "resized", "rotate": "rotated"}[op.kind]

    def _do() -> tuple[str, object]:
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)

        def _mutate(pdf):
            pg = _page_or_raise(pdf, op.page)
            if op.kind == "move":
                return move_objects(pg, metas, op.delta.dx, op.delta.dy, pdf)
            if op.kind == "resize":
                return resize_objects(
                    pg, metas, op.scale.sx, op.scale.sy, op.scale.anchor, pdf
                )
            # rotate
            return rotate_objects(pg, metas, op.rotateDeg, pdf)

        return apply_and_save(
            pdf_path, _mutate, original_name=original_name, suffix=suffix,
            output_subdir=EDIT_OUTPUT_SUBDIR,
        )

    return await _execute(_do, license_info)


@router.post("/edit/text", response_model=EditResponse)
async def edit_text_endpoint(req: EditRequest, license_info: dict = Depends(require_license)):
    """Sửa nội dung text của (các) cụm text mục tiêu, giữ font/cỡ/vị trí."""
    op = req.op
    if op.kind != "editText":
        raise HTTPException(status_code=422, detail="Endpoint /edit/text yêu cầu op.kind='editText'.")
    if op.text is None:
        raise HTTPException(status_code=422, detail="Thao tác editText yêu cầu trường 'text'.")

    pdf_path, original_name = _get_file_info(req.fid)
    new_text = op.text.content

    def _do() -> tuple[str, object]:
        metas = _resolve_targets(pdf_path, op.page, op.targetIds)

        def _mutate(pdf):
            pg = _page_or_raise(pdf, op.page)
            results = [edit_text(pg, meta, new_text, pdf) for meta in metas]
            # Trả 1 phần tử nếu chỉ sửa 1 cụm để gọn payload; ngược lại trả list.
            return results[0] if len(results) == 1 else results

        return apply_and_save(
            pdf_path, _mutate, original_name=original_name, suffix="text",
            output_subdir=EDIT_OUTPUT_SUBDIR,
        )

    return await _execute(_do, license_info)


@router.post("/edit/add", response_model=EditResponse)
async def edit_add(req: EditRequest, license_info: dict = Depends(require_license)):
    """Thêm object mới (text hoặc image) — chỉ bổ sung, không sửa object cũ."""
    op = req.op
    if op.kind != "add":
        raise HTTPException(status_code=422, detail="Endpoint /edit/add yêu cầu op.kind='add'.")
    if op.text is None and op.image is None:
        raise HTTPException(status_code=422, detail="Thao tác add yêu cầu 'text' hoặc 'image'.")

    pdf_path, original_name = _get_file_info(req.fid)

    def _do() -> tuple[str, object]:
        def _mutate(pdf):
            pg = _page_or_raise(pdf, op.page)
            if op.text is not None:
                if op.text.bbox is None:
                    raise ValueError("Thêm text yêu cầu 'text.bbox' để định vị.")
                font_size = op.text.sizePt if op.text.sizePt else 12.0
                return add_text(pg, op.text.content, op.text.bbox, pdf, font_size=font_size)
            # image
            image_source = _decode_image_source(op.image.dataRef)
            return add_image(pg, image_source, op.image.bbox, pdf)

        return apply_and_save(
            pdf_path, _mutate, original_name=original_name, suffix="added",
            output_subdir=EDIT_OUTPUT_SUBDIR,
        )

    return await _execute(_do, license_info)


@router.post("/edit/preview", response_model=PreviewResponse)
async def edit_preview(req: EditRequest):
    """
    Render ảnh preview (PNG base64) của trang SAU khi áp `op`, để Canvas_UI hiển
    thị kết quả khớp hình học với bản lưu (Yêu cầu 12.1, 12.3).

    Đường đi: pikepdf áp thao tác → `pdf.save(BytesIO)` lấy bytes in-memory →
    PDFium render READ-ONLY bytes đó → PNG base64. PDFium KHÔNG bao giờ ghi file
    kết quả (Yêu cầu 12.2); mọi thay đổi nội dung đi qua pikepdf (color-safe).

    Hỗ trợ mọi `op.kind` ∈ {delete, move, resize, rotate, editText, add}.
    """
    pdf_path, _ = _get_file_info(req.fid)
    return await _execute_preview(pdf_path, req.op)


@router.post("/edit/preview-hide", response_model=PreviewResponse)
async def edit_preview_hide(req: PreviewHideReq):
    """Render the current live page with only the requested components hidden."""
    pdf_path, _ = _get_file_info(req.fid)
    session = edit_session.get_active_session(req.fid)
    if session is not None:
        with session.lock:
            pdf_bytes = session.live_bytes
            if pdf_bytes is None:
                out = BytesIO()
                session.pdf.save(out, compress_streams=False)
                pdf_bytes = out.getvalue()
                session.live_bytes = pdf_bytes
    else:
        with open(pdf_path, "rb") as source:
            pdf_bytes = source.read()

    return await _execute_hide_preview(pdf_bytes, req.page, req.targetIds)


# Session endpoints `/edit/session/*` (`pdf-edit-session`)
@router.post("/edit/session/open", response_model=SessionOpenResp)
async def session_open(req: SessionOpenReq, license_info: dict = Depends(require_license)):
    """
    Mở một Edit_Session từ `fid`: nạp Live_Document (pikepdf từ bytes file gốc) vào
    RAM và cấp Session_Id duy nhất (Yêu cầu 1.1). `fid` không tồn tại / file mất →
    404, KHÔNG tạo phiên (Yêu cầu 1.3).
    """
    def _do() -> SessionOpenResp:
        session = edit_session.open_session(req.fid)
        return SessionOpenResp(
            session_id=session.session_id,
            page_count=len(session.pdf.pages),
        )

    return await _execute_session(_do)


@router.post("/edit/session/op", response_model=SessionOpResp)
async def session_op(req: SessionOpReq, license_info: dict = Depends(require_license)):
    """
    Áp một `EditOp` IN-MEMORY lên Live_Document của phiên rồi render Incremental_Render
    (vùng clip) — KHÔNG ghi Working_File (Yêu cầu 2.1, 3.1). Phiên không tồn tại → 410
    (Yêu cầu 9.5); op lỗi → giữ nguyên `pdf`, KHÔNG vào op_log (Yêu cầu 10.2, 10.3).
    """
    def _do() -> SessionOpResp:
        session = edit_session.get_session(req.session_id)
        op_result = edit_session.apply_op(session, req.op)
        _invalidate_object_cache(session.source_fid, req.op.page)
        preview, clip_rect, full = edit_session.render_clip(
            session, req.op, op_result,
            scale=req.render_scale, clip_pad=req.clip_pad_pt,
        )
        return SessionOpResp(
            success=True,
            preview=preview,
            clipRect=clip_rect,
            full=full,
            page=req.op.page,
            opResult=op_result,
            canUndo=bool(op_result.get("canUndo", False)),
            canRedo=bool(op_result.get("canRedo", False)),
        )

    return await _execute_session(_do)


@router.post("/edit/session/ocg-action", response_model=OcgActionResponse)
async def session_ocg_action(
    req: SessionOcgActionReq,
    license_info: dict = Depends(require_license),
):
    def _do() -> dict:
        session = edit_session.get_session(req.session_id)
        return edit_session.apply_ocg_action(
            session, req.action, layer_id=req.layer_id, name=req.name,
            locked=req.locked, new_order=req.new_order,
        )

    return await _execute_session(_do)

@router.post("/edit/session/ocg-visibility", response_model=OcgActionResponse)
async def session_ocg_visibility(
    req: SessionOcgVisibilityReq,
    license_info: dict = Depends(require_license),
):
    """Đổi visibility OCG trong live session; thay đổi sẽ được commit cùng phiên."""
    def _do() -> dict:
        session = edit_session.get_session(req.session_id)
        return edit_session.set_ocg_visibility(session, req.layer_id, req.visible)

    return await _execute_session(_do)

@router.post("/edit/session/undo", response_model=SessionOpResp)
async def session_undo(req: SessionRefReq, license_info: dict = Depends(require_license)):
    """
    Hoàn tác Edit_Op gần nhất của phiên (baseline + replay) và render clip vùng khôi
    phục (Yêu cầu 7.2). Op_Log rỗng → trả no-op, giữ nguyên Live_Document (Yêu cầu 7.6).
    Phiên không tồn tại → 410.
    """
    def _do() -> SessionOpResp:
        session = edit_session.get_session(req.session_id)
        result = edit_session.undo(
            session, scale=req.render_scale, clip_pad=req.clip_pad_pt
        )
        if result and result.get("page") is not None:
            _invalidate_object_cache(session.source_fid, result.get("page"))
        return SessionOpResp(
            success=True,
            preview=result.get("preview"),
            clipRect=result.get("clipRect"),
            full=bool(result.get("full", False)),
            page=result.get("page"),
            opResult=result,
            canUndo=bool(result.get("canUndo", False)),
            canRedo=bool(result.get("canRedo", False)),
        )

    return await _execute_session(_do)


@router.post("/edit/session/redo", response_model=SessionOpResp)
async def session_redo(req: SessionRefReq, license_info: dict = Depends(require_license)):
    """
    Làm lại Edit_Op vừa bị hoàn tác và render clip (Yêu cầu 7.3). Redo_stack rỗng →
    trả no-op, giữ nguyên Live_Document. Op áp lại lỗi → giữ nguyên `pdf`, op vẫn
    trong redo_stack (Yêu cầu 10.2). Phiên không tồn tại → 410.
    """
    def _do() -> SessionOpResp:
        session = edit_session.get_session(req.session_id)
        result = edit_session.redo(
            session, scale=req.render_scale, clip_pad=req.clip_pad_pt
        )
        if result and result.get("page") is not None:
            _invalidate_object_cache(session.source_fid, result.get("page"))
        return SessionOpResp(
            success=True,
            preview=result.get("preview"),
            clipRect=result.get("clipRect"),
            full=bool(result.get("full", False)),
            page=result.get("page"),
            opResult=result,
            canUndo=bool(result.get("canUndo", False)),
            canRedo=bool(result.get("canRedo", False)),
        )

    return await _execute_session(_do)


@router.post("/edit/session/commit", response_model=EditResponse)
async def session_commit(req: SessionCommitReq, license_info: dict = Depends(require_license)):
    """
    Commit (Defer_Commit) trạng thái HIỆN TẠI của Live_Document ra một Working_File
    MỚI color-safe (KHÔNG đè file gốc) và đăng ký `fid` mới (Yêu cầu 5.2, 6.2, 11.4).
    Commit lỗi → giữ nguyên `pdf` trong RAM để thử lại (Yêu cầu 10.5). Phiên không
    tồn tại → 410.
    """
    def _do() -> EditResponse:
        session = edit_session.get_session(req.session_id)
        # LIFECYCLE (audit 2026-08-25 §REV.11): state snapshot, materialize,
        # publication lease và rollback là MỘT giao dịch của cùng EditSession.
        # `EditSession.lock` là RLock vì core.commit() tái nhập đúng khóa này.
        with session.lock:
            previous_dirty = session.dirty
            previous_last_commit_path = session.last_commit_path
            try:
                result = edit_session.commit(session)
                artifact_lease = _lease_registered_working_file(
                    result["output_path"],
                    result["output_fid"],
                )
            except Exception:
                session.dirty = previous_dirty
                session.last_commit_path = previous_last_commit_path
                raise
        # Invalidate source fid caches (new fid will be used by client)
        _invalidate_object_cache(session.source_fid)
        return EditResponse(
            success=bool(result.get("success", True)),
            output_filename=result["output_filename"],
            output_url=result["output_url"],
            output_path=result["output_path"],
            output_fid=result["output_fid"],
            artifact_lease=artifact_lease,
        )

    return await _execute_session(_do)


@router.post("/edit/session/flatten", response_model=EditResponse)
async def session_flatten(req: SessionCommitReq, license_info: dict = Depends(require_license)):
    """Flatten layer hiện tại ra Working File mới; file nguồn và phiên gốc không bị ghi đè."""
    def _do() -> EditResponse:
        session = edit_session.get_session(req.session_id)
        with session.lock:
            previous_dirty = session.dirty
            previous_last_commit_path = session.last_commit_path
            try:
                result = edit_session.flatten(session)
                artifact_lease = _lease_registered_working_file(
                    result["output_path"],
                    result["output_fid"],
                )
            except Exception:
                session.dirty = previous_dirty
                session.last_commit_path = previous_last_commit_path
                raise
        _invalidate_object_cache(session.source_fid)
        # GS-SUNSET (audit 2026-07-28 §FL.2): giữ cảnh báo raster hóa xuyên qua API;
        # không để response_model âm thầm loại bỏ thông tin mà thợ in cần biết.
        return EditResponse(
            success=bool(result.get("success", True)),
            output_filename=result["output_filename"],
            output_url=result["output_url"],
            output_path=result["output_path"],
            output_fid=result["output_fid"],
            artifact_lease=artifact_lease,
            warning=result.get("warning"),
        )

    return await _execute_session(_do, timeout_seconds=FLATTEN_TIMEOUT_SECONDS)

@router.delete("/edit/session/{sid}", response_model=SessionCloseResponse)
async def session_close(sid: str, license_info: dict = Depends(require_license)):
    """
    Đóng một Edit_Session: giải phóng Live_Document khỏi RAM, GIỮ NGUYÊN file gốc +
    mọi Working_File đã Commit (Yêu cầu 9.1, 9.3). Idempotent: phiên đã đóng/dọn →
    `closed=False` (không lỗi).
    """
    def _do() -> dict:
        closed = edit_session.close_session(sid)
        return {"closed": closed}

    return await _execute_session(_do)
