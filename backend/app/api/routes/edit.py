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
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.core import geometry_reader
from app.core.edit_io import apply_and_save
from app.core.license_guard import require_license
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
from app.schemas.edit import EditOp, ObjMeta

logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_license)])

# ── Cấu hình ────────────────────────────────────────────────────────────────
# Trần thời gian xử lý an toàn cho một thao tác edit (Yêu cầu 13.4). Vượt ngưỡng
# → trả 504 rõ ràng; vì apply_and_save chỉ ghi ra Working_File MỚI nên file gốc
# KHÔNG bao giờ bị đè dù thao tác bị bỏ dở.
EDIT_TIMEOUT_SECONDS: float = 120.0

# Thư mục con (dưới RESULTS_DIR) chứa Working_File của tính năng edit. Đồng bộ với
# DEFAULT_EDIT_OUTPUT_SUBDIR ở edit_io; được mount tĩnh qua "/results".
EDIT_OUTPUT_SUBDIR = "edit_output"

# DPI render preview (read-only). 150 DPI cân bằng giữa độ nét và chi phí; PDFium
# render theo scale = DPI/72 so với hệ point của PDF.
PREVIEW_DPI: float = 150.0


# ── Request schemas ──────────────────────────────────────────────────────────
class EditRequest(BaseModel):
    """
    Bọc một `EditOp` cùng `fid` (id file đã upload) để định tuyến thao tác sửa.

    Cùng một schema dùng cho mọi endpoint POST (/delete, /transform, /text, /add);
    mỗi endpoint kiểm tra `op.kind` có thuộc tập hợp lệ của nó hay không.
    """

    fid: str = Field(description="ID file PDF đã upload (UploadedFile.id)")
    op: EditOp


# ── Response schema ──────────────────────────────────────────────────────────
class EditResponse(BaseModel):
    """Kết quả một thao tác edit + tham chiếu Working_File mới."""

    success: bool
    output_filename: str
    output_url: str = Field(description="URL tĩnh tương đối phục vụ qua /results")
    output_path: str = Field(description="Đường dẫn tuyệt đối Working_File mới")
    output_fid: str = Field(
        description=(
            "ID bản ghi UploadedFile trỏ tới Working_File mới — dùng làm fid cho "
            "thao tác edit kế tiếp (thao tác trực tiếp trên kết quả mới, KHÔNG cần "
            "tải-về-rồi-upload-lại trên desktop)."
        )
    )
    result: dict | list = Field(default_factory=dict, description="Tóm tắt op_result")


class PreviewResponse(BaseModel):
    """
    Ảnh preview (PNG base64) của một trang SAU khi áp thao tác EditOp.

    Ảnh được render READ-ONLY bằng PDFium từ BYTES mà pikepdf vừa ghi in-memory
    (KHÔNG lưu file vĩnh viễn, KHÔNG dùng PDFium để ghi — Yêu cầu 12.2). Hình học
    của ảnh khớp với kết quả lưu pikepdf (Yêu cầu 12.1, 12.3).
    """

    success: bool
    image: str = Field(description="Data URI 'data:image/png;base64,...'")
    width: int = Field(description="Chiều rộng ảnh render (px)")
    height: int = Field(description="Chiều cao ảnh render (px)")
    page: int = Field(description="Chỉ số trang 0-based đã render")


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
    try:
        file_size = os.path.getsize(output_path)
    except OSError:
        file_size = None

    db = SessionLocal()
    try:
        row = UploadedFile(
            filename=Path(output_path).name,
            original_name=original_name,
            file_path=output_path,
            file_size=file_size,
            page_count=None,
            pdf_metadata=None,
            expires_at=datetime.now(timezone.utc)
            + timedelta(hours=WORKING_FILE_EXPIRY_HOURS),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row.id
    finally:
        db.close()


def _safe_watermark(pdf_path: str, license_info: dict | None) -> None:
    """Nhúng stealth watermark vào Working_File xuất ra (non-blocking).

    Bỏ qua ở dev mode (license_key == 'DEV_MODE') hoặc khi thiếu license_key.
    """
    try:
        lk = (license_info or {}).get("license_key", "") or ""
        if not lk or lk == "DEV_MODE":
            return
        hwid = (license_info or {}).get("hwid", "") or ""
        import pikepdf
        from app.core.watermark import embed_watermark
        with pikepdf.Pdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            embed_watermark(pdf, lk, hwid)
            pdf.save(pdf_path)
    except Exception as e:
        logger.error(f"[WATERMARK] edit output failed (non-blocking): {e}")


def _build_output_response(output_path: str, op_result, license_info: dict | None = None) -> EditResponse:
    """Dựng EditResponse từ Working_File mới + op_result."""
    # Đóng dấu bản quyền TRƯỚC khi đăng ký (để file_size lưu trong DB khớp file đã watermark).
    _safe_watermark(output_path, license_info)
    filename = Path(output_path).name
    output_fid = _register_working_file(output_path, filename)
    # output_path PHẢI tuyệt đối: client desktop (Tauri) có cwd KHÁC backend, nên
    # path tương đối (vd. RESULTS_DIR=./results) sẽ không phân giải được khi
    # native tile renderer / convertFileSrc mở file → trang kẹt "RENDERING" vô hạn.
    abs_output_path = os.path.abspath(output_path)
    return EditResponse(
        success=True,
        output_filename=filename,
        output_url=f"/results/{EDIT_OUTPUT_SUBDIR}/{filename}",
        output_path=abs_output_path,
        output_fid=output_fid,
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
        raise HTTPException(status_code=404, detail=str(exc))
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        # resize ≤ 0 / bbox suy biến / tham số sai (Yêu cầu 6.5).
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Thao tác edit thất bại")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(exc).__name__})")

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
    import pypdfium2 as pdfium

    # 1) Áp thao tác bằng pikepdf (đường GHI color-safe) → lấy bytes in-memory.
    with pikepdf.Pdf.open(pdf_path) as pdf:
        _apply_edit_op(pdf, op, pdf_path)
        buf = BytesIO()
        # compress_streams=False: KHÔNG nén lại stream ảnh đã nén → nhanh ~10× trên
        # file ảnh nặng (xem ghi chú edit_io.save_working_file). Chỉ để render preview.
        pdf.save(buf, compress_streams=False)
    pdf_bytes = buf.getvalue()

    # 2) Render READ-ONLY bằng PDFium từ chính bytes pikepdf vừa ghi.
    render_doc = pdfium.PdfDocument(pdf_bytes)
    try:
        n_pages = len(render_doc)
        if op.page < 0 or op.page >= n_pages:
            raise IndexError(f"Trang {op.page} ngoài phạm vi (0..{n_pages - 1}).")
        render_page = render_doc[op.page]
        bitmap = render_page.render(scale=PREVIEW_DPI / 72.0)
        img = bitmap.to_pil()
        width, height = img.size

        out = BytesIO()
        img.save(out, format="PNG")
        b64 = base64.b64encode(out.getvalue()).decode("ascii")
    finally:
        render_doc.close()

    return PreviewResponse(
        success=True,
        image=f"data:image/png;base64,{b64}",
        width=int(width),
        height=int(height),
        page=op.page,
    )


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
        raise HTTPException(status_code=404, detail=str(exc))
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Tạo preview thất bại")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(exc).__name__})")


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.get("/edit/objects/{fid}/{page}")
async def list_page_objects(fid: str, page: int):
    """
    Liệt kê object (text/image/vector) của một trang qua Geometry_Reader (PDFium,
    read-only). `page` là chỉ số 0-based.
    """
    pdf_path, _ = _get_file_info(fid)
    try:
        # include_text_props=False: KHÔNG trích nội dung/màu/font cho MỌI object
        # (nhanh trên trang cực nhiều object). Props lấy LAZY qua /edit/text-props
        # khi mở editor sửa text.
        objects = geometry_reader.list_objects(pdf_path, page, include_text_props=False)
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Liệt kê object thất bại")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(exc).__name__})")

    # CropBox của trang (PDF user-space): client trừ gốc CropBox để overlay khớp ảnh
    # render (PDFium render theo CropBox). File có CropBox/MediaBox lệch gốc (vd. xuất
    # từ Illustrator) sẽ không bị lệch tọa độ. None nếu không đọc được (client coi gốc 0).
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

    return {"objects": objects, "count": len(objects), "pageBox": page_box}


@router.get("/edit/text-props/{fid}/{page}/{index}")
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
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(exc).__name__})")
    return props


@router.delete("/edit/working/{fid}")
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
        norm = os.path.normpath(row.file_path).replace("\\", "/")
        # Chỉ xóa khi path thuộc thư mục edit_output (Working_File của edit).
        if f"/{EDIT_OUTPUT_SUBDIR}/" not in norm and not norm.endswith(f"/{EDIT_OUTPUT_SUBDIR}"):
            return {"deleted": False, "reason": "not_working_file"}
        try:
            if os.path.exists(row.file_path):
                os.remove(row.file_path)
        except OSError as exc:
            logger.warning("Không xóa được Working_File '%s': %s", row.file_path, exc)
        db.delete(row)
        db.commit()
        return {"deleted": True}
    except Exception as exc:  # noqa: BLE001
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
