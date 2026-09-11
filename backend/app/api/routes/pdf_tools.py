"""
API routes for high-performance PDF tools (pikepdf backend).

Provides endpoints for:
- POST /pdf-tools/merge     — Merge/interleave PDFs
- POST /pdf-tools/split     — Split PDF by range/count/extract
- POST /pdf-tools/resize    — Resize pages
- POST /pdf-tools/shuffle   — Reorder pages
"""

import asyncio
import os
import base64
import hashlib
import hmac
import math
import uuid
import shutil
import time
import logging
import threading
from contextlib import contextmanager, suppress
from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Request, Depends
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool as run_light_in_threadpool

from app.core.heavy_job_scheduler import run_heavy_in_threadpool as run_in_threadpool
from app.core.heavy_job_scheduler import run_scheduled_in_threadpool
from app.schemas.pdf_tools import (
    EncryptionStatusResponse,
    MetadataReadResponse,
    WarmupResponse,
)
from typing import List, Optional
import json
from app.api.routes.combine_jobs import (
    manifest_source_extension as _manifest_source_extension,
    router as combine_jobs_router,
    validate_manifest_source_file as _validate_manifest_source_file,
)
from app.core.license_guard import require_license, require_feature, enforce_feature
from app.core.imposition_file_access import validate_imposition_pdf_path
from app.core.source_revision import (
    SOURCE_REVISION_CHANGED_MESSAGE,
    SourceRevisionChangedError,
    assert_source_fingerprint,
    capture_source_fingerprint,
)
from app.core.sticker_cutline_policy import resolve_sticker_corner_policy
from app.core.upscale_policy import (
    icc_data_colorspace as _icc_data_colorspace,
    upscale_memory_budget_mb as _upscale_memory_budget_mb,
    upscale_output_dpi as _upscale_output_dpi,
    validate_upscale_memory as _validate_upscale_memory,
)
from app.config import settings
from app.utils.errors import raise_http
from app.utils.file_handler import ALLOWED_EXTENSIONS, save_upload_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pdf-tools", tags=["PDF Tools"], dependencies=[Depends(require_license)])
router.include_router(combine_jobs_router)
# Xếp hàng job tạo viền bế / bù xén khi in liên tục. Mỗi job peak RAM cao
# (raster 300 DPI × workers); chạy chồng chéo dễ OOM. Mặc định 1 job/lúc
# (desktop in ấn). Override: PRYNX_MAX_STICKER_JOBS.
# PERF (audit 2026-07-29 §C.3): trần = 1 là CỐ Ý — `sticker_engine` đã tự chọn số worker
# theo RAM+CPU (`_auto_sticker_hw_profile`, tới 6 process trên máy ≥64GB). Trần job >1 sẽ
# nhân đôi con số đó và phá luôn ngân sách RAM mà profile kia vừa tính.
#
# PERF (audit 2026-08-16 §BX.P03): trần này ĐÃ CHUYỂN sang `heavy_job_scheduler` dưới
# `kind="sticker"`. Semaphore cũ acquire bên trong threadpool nên job tem xếp hàng vẫn
# giữ suất heavy toàn cục (đo được 3/3 suất khi chỉ 1 job chạy) và chặn oan mọi endpoint
# pdf-tools khác. Hai biến dưới đây giữ lại CHỈ để tương thích ngược cho test/công cụ cũ
# đọc chúng; đường chạy thật không còn dùng.
_MAX_CONCURRENT_STICKER = max(
    1, int(os.environ.get("PRYNX_MAX_STICKER_JOBS", "1") or "1")
)
_STICKER_JOB_SEMAPHORE = threading.BoundedSemaphore(_MAX_CONCURRENT_STICKER)


def _plan_background_work_size(width: int, height: int) -> tuple[tuple[int, int], list[str]]:
    """Lập kế hoạch kích thước theo RAM; máy >=16 GB không bị hạ âm thầm."""
    from app.core.system_memory import read_memory_status_mb

    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Kích thước ảnh không hợp lệ")
    total_mb, available_mb = read_memory_status_mb()
    if total_mb is None or available_mb is None:
        return (width, height), []

    estimated_mb = width * height * 72 / (1024 * 1024)
    reserve_mb = 512.0 if total_mb < 8192 else 1024.0
    usable_mb = max(0.0, available_mb - reserve_mb) * (0.55 if total_mb < 8192 else 0.65)

    if total_mb >= 16384:
        if estimated_mb > usable_mb:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Ảnh {width}×{height} px cần khoảng {estimated_mb / 1024:.1f} GB RAM "
                    "để tách nền nhưng máy hiện không còn đủ bộ nhớ. Hãy đóng bớt ứng dụng rồi thử lại."
                ),
            )
        return (width, height), []

    if estimated_mb <= usable_mb:
        return (width, height), []
    target_pixels = max(1, int(usable_mb * 1024 * 1024 / 72))
    scale = min(1.0, (target_pixels / float(width * height)) ** 0.5)
    target = (max(1, int(width * scale)), max(1, int(height * scale)))
    return target, ["resolution-reduced"]


@contextmanager
def _sticker_job_slot(job_id: str = ""):
    """DEPRECATED — trần job tem nay do `heavy_job_scheduler` (`kind="sticker"`) giữ.

    Giữ lại để test/công cụ cũ import được. Vẫn lấy semaphore cũ nên nếu có đường gọi
    nào còn dùng thì hành vi không đổi; đường chạy production đã bỏ (§BX.P03).
    """
    waited = time.perf_counter()
    _STICKER_JOB_SEMAPHORE.acquire()
    wait_s = time.perf_counter() - waited
    if wait_s > 0.05:
        logger.info(
            "[STICKER] job queued job=%s wait_s=%.2f max_concurrent=%d",
            job_id, wait_s, _MAX_CONCURRENT_STICKER,
        )
    try:
        yield
    finally:
        _STICKER_JOB_SEMAPHORE.release()

def _sticker_float_param(
    form, field: str, *, default: float, low: float, high: float
) -> float:
    """Đọc tham số mm của bù xén: chặn rỗng/chữ/inf/nan rồi kẹp về khoảng cho phép.

    AUDIT (2026-08-16 §BX.F06). Sai kiểu là lỗi của client (UI đã clamp sẵn), nên
    trả 400 với thông báo người dùng làm được thay vì 500 trần hoặc âm thầm nhận
    `inf`/`nan` — hai giá trị đó đi tới `compute_cut_bleed_offsets` sẽ tạo page box
    vô nghĩa và file xuất không mở được.
    """
    raw = form.get(field)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400,
            detail=f"Giá trị '{field}' không phải là số. Hãy nhập lại thông số bù xén.",
        ) from None
    if not math.isfinite(value):
        raise HTTPException(
            status_code=400,
            detail=f"Giá trị '{field}' không hợp lệ. Hãy nhập lại thông số bù xén.",
        )
    return max(low, min(high, value))


# Header phản hồi phải nhỏ: h11/WebView2 có trần kích thước header, và một file
# nhiều trăm trang từng sinh JSON `pages` hàng chục KB (AUDIT 2026-08-16 §BX.F11).
_STICKER_HEADER_MAX_CHARS = 3000


def _set_sticker_json_header(headers: dict, name: str, payload) -> None:
    """Chỉ gắn header JSON khi còn nhỏ; quá lớn thì bỏ thay vì làm vỡ cả response."""
    import json as _header_json

    try:
        encoded = _header_json.dumps(payload)
    except (TypeError, ValueError):
        return
    if len(encoded) <= _STICKER_HEADER_MAX_CHARS:
        headers[name] = encoded
    else:
        logger.info(
            "[STICKER] bỏ header %s vì quá lớn (%d ký tự) — frontend không dùng field này",
            name, len(encoded),
        )


def _log_sticker_response_complete(started: float, job_id: str, output_path: str) -> None:
    try:
        output_mb = os.path.getsize(output_path) / (1024 * 1024)
    except OSError:
        output_mb = 0.0
    logger.info(
        "[STICKER_TIMING] response_complete job=%s total_s=%.3f output_mb=%.2f",
        job_id,
        time.perf_counter() - started,
        output_mb,
    )


def _finish_sticker_response(started: float, job_id: str, output_path: str) -> None:
    # Không xóa output ở đây: frontend dùng lại file qua đường dẫn (native render
    # path-based sau khi crop → tem bế), nên xóa ngay sau response gây 404. File nằm
    # trong results/ và được cleanup theo tuổi lo (app/core/cleanup.py) như job khác.
    _log_sticker_response_complete(started, job_id, output_path)

UPLOAD_DIR = settings.UPLOAD_DIR
RESULTS_DIR = settings.RESULTS_DIR
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)


def _cleanup_file(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# ── Scope check cho file_path do client gửi ──────────────────────────────────
# SECURITY (audit 2026-08-10 §UP.X.04): chặn đọc arbitrary local path qua biên
# WebView → sidecar. Trước đây endpoint chỉ validate extension + tồn tại → bất
# kỳ ảnh nào OS user đọc được đều bị expose cho renderer/XSS.

_IMAGE_PATH_ALLOWED_EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff')

# Chỉ giữ thư mục do PrynX sở hữu. File người dùng bên ngoài phải có capability
# native riêng; không cho phép toàn bộ %TEMP%/Desktop/ổ đĩa.
_IMAGE_PATH_ALLOWED_DIRS: list[str] = []
_UPSCALE_FILE_GRANT_PURPOSE = "prynx-upscale-file-grant:v1:"
_UPSCALE_FILE_GRANT_TTL_SECONDS = 120
_UPSCALE_FILE_GRANT_CLOCK_SKEW_SECONDS = 5
_USED_UPSCALE_FILE_GRANTS: dict[str, int] = {}
_USED_UPSCALE_FILE_GRANTS_LOCK = threading.Lock()


def _canonical_image_path(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


def _image_path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(_canonical_image_path(path)))


def _is_path_inside(path: str, directory: str) -> bool:
    try:
        return os.path.commonpath((_image_path_key(path), _image_path_key(directory))) == _image_path_key(directory)
    except (ValueError, OSError):
        return False


def _init_image_path_allowed_dirs() -> None:
    """Gọi một lần sau khi settings đã resolve."""
    dirs = [
        _canonical_image_path(settings.UPLOAD_DIR),
        _canonical_image_path(settings.RESULTS_DIR),
    ]
    _IMAGE_PATH_ALLOWED_DIRS.clear()
    _IMAGE_PATH_ALLOWED_DIRS.extend(dirs)


def _validate_image_file_path(file_path: str, *, allow_external: bool = False) -> str:
    """Validate và canonicalize path do client gửi; trả real path hoặc ném 400/403.

    Bước kiểm tra:
    1. Chặn traversal (..)
    2. Chặn UNC path (\\\\), device path (\\\\?\\, \\\\.\\)
    3. Chặn symlink/reparse TRƯỚC canonicalization
    4. Canonicalize (realpath)
    5. Validate extension
    6. Validate tồn tại
    7. Scope check: path phải nằm trong thư mục PrynX, trừ khi capability native
       đã được xác minh riêng cho đúng path.
    """
    if not file_path or '\x00' in file_path:
        raise HTTPException(status_code=400, detail="Invalid path")

    normalized = file_path.replace('/', '\\')
    if any(part == '..' for part in normalized.split('\\')):
        raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed")

    # Chặn UNC/device path trên Windows
    if normalized.startswith('\\\\'):
        raise HTTPException(status_code=403, detail="UNC and device paths are not allowed")
    if not os.path.isabs(file_path):
        raise HTTPException(status_code=400, detail="Absolute path required")

    # Chặn symlink TRƯỚC realpath — đây là lỗi cũ: kiểm sau realpath vô hiệu.
    if os.path.islink(file_path):
        raise HTTPException(status_code=403, detail="Symbolic links are not allowed")

    real = _canonical_image_path(file_path)

    if not os.path.isfile(real):
        raise HTTPException(status_code=400, detail="File not found")
    if not real.lower().endswith(_IMAGE_PATH_ALLOWED_EXTS):
        raise HTTPException(status_code=400, detail="Unsupported file type")

    if not allow_external:
        # SEC (audit 2026-08-11 §UP.R.01): candidate và roots đi cùng pipeline
        # realpath/normcase/commonpath, nên alias 8.3 và path dài không tự lệch scope.
        if not _IMAGE_PATH_ALLOWED_DIRS:
            _init_image_path_allowed_dirs()
        if not any(_is_path_inside(real, directory) for directory in _IMAGE_PATH_ALLOWED_DIRS):
            raise HTTPException(
                status_code=403,
                detail="Path is outside the allowed directories",
            )

    return real


def _consume_upscale_file_grant(nonce: str, expires_at: int, now: int) -> bool:
    with _USED_UPSCALE_FILE_GRANTS_LOCK:
        stale = [
            used_nonce for used_nonce, expiry in _USED_UPSCALE_FILE_GRANTS.items()
            if expiry + _UPSCALE_FILE_GRANT_CLOCK_SKEW_SECONDS < now
        ]
        for used_nonce in stale:
            _USED_UPSCALE_FILE_GRANTS.pop(used_nonce, None)
        if nonce in _USED_UPSCALE_FILE_GRANTS:
            return False
        _USED_UPSCALE_FILE_GRANTS[nonce] = expires_at
        return True


def _verify_upscale_file_grant(file_path: str, tab_id: str, grant: str) -> str:
    """Xác minh capability native, bind path + tab + TTL và dùng đúng một lần."""
    if not grant or len(grant) > 65_536 or not tab_id or len(tab_id) > 128:
        raise HTTPException(status_code=403, detail="Invalid file grant")

    try:
        version, payload, provided_signature = grant.split('.', 2)
        if version != 'v1' or len(provided_signature) != 64:
            raise ValueError("grant version/signature")
        from app.core import license_guard
        token = license_guard._SIDECAR_TOKEN
        if not token:
            raise ValueError("sidecar token unavailable")
        expected_signature = hmac.new(
            token.encode('utf-8'),
            f"{_UPSCALE_FILE_GRANT_PURPOSE}{payload}".encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(provided_signature, expected_signature):
            raise ValueError("grant signature")

        padded_payload = payload + ('=' * (-len(payload) % 4))
        claims = json.loads(base64.urlsafe_b64decode(padded_payload).decode('utf-8'))
        if not isinstance(claims, dict) or claims.get('v') != 1:
            raise ValueError("grant claims")
        issued_at = claims.get('iat')
        expires_at = claims.get('exp')
        nonce = claims.get('nonce')
        granted_tab = claims.get('tab')
        granted_path = claims.get('path')
        if (
            not isinstance(issued_at, int)
            or not isinstance(expires_at, int)
            or not isinstance(nonce, str)
            or len(nonce) != 32
            or any(char not in '0123456789abcdef' for char in nonce)
            or not isinstance(granted_tab, str)
            or not isinstance(granted_path, str)
        ):
            raise ValueError("grant claim types")

        now = int(time.time())
        if (
            issued_at > now + _UPSCALE_FILE_GRANT_CLOCK_SKEW_SECONDS
            or expires_at < now
            or expires_at <= issued_at
            or expires_at - issued_at > _UPSCALE_FILE_GRANT_TTL_SECONDS
            or granted_tab != tab_id
        ):
            raise ValueError("grant expired or wrong tab")

        real = _validate_image_file_path(file_path, allow_external=True)
        if _image_path_key(real) != _image_path_key(granted_path):
            raise ValueError("grant path mismatch")
        if not _consume_upscale_file_grant(nonce, expires_at, now):
            raise ValueError("grant replay")
        return real
    except HTTPException:
        raise
    except Exception as exc:
        logger.info("Từ chối capability file Upscale: %s", type(exc).__name__)
        raise HTTPException(status_code=403, detail="Invalid or expired file grant") from exc


def _create_split_zip(results: list[dict], zip_path: str, license_info: dict) -> None:
    """Watermark and archive split outputs entirely off the async event loop."""
    import zipfile

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for result in results:
            _safe_watermark(result["path"], license_info)
            archive.write(result["path"], result["filename"])


def _cleanup_split_artifacts(zip_path: str, output_dir: str) -> None:
    try:
        if zip_path and os.path.exists(zip_path):
            os.remove(zip_path)
    except OSError:
        pass
    try:
        if output_dir and os.path.isdir(output_dir):
            shutil.rmtree(output_dir, ignore_errors=True)
    except OSError:
        pass

def _safe_watermark(pdf_path: str, license_info: dict) -> None:
    """Nhúng stealth watermark (XMP + invisible text) vào PDF output.

    Non-blocking: mọi lỗi chỉ log, KHÔNG làm hỏng output. Bỏ qua ở dev mode
    (license_key == 'DEV_MODE') để output dev không bị đóng dấu rác.
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
        logger.error(f"[WATERMARK] pdf-tools failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _strip_pdf_metadata(pdf_path: str) -> None:
    """Xóa metadata thật khỏi PDF: XMP (Root/Metadata) + Document Info (tác giả,
    tiêu đề, producer, history Photoshop...).

    Cờ linearization không xóa metadata. Muốn strip thật phải hậu xử lý bằng
    pikepdf. Gọi TRƯỚC watermark để XMP watermark
    (thêm sau) không bị xóa nhầm. Non-blocking: lỗi chỉ log, giữ nguyên file."""
    import tempfile
    import pikepdf
    tmp_path = None
    try:
        with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            # XMP metadata stream
            if "/Metadata" in pdf.Root:
                del pdf.Root.Metadata
            # Document Info dictionary (tác giả/tiêu đề/producer/CreationDate...)
            try:
                for k in list(pdf.docinfo.keys()):
                    del pdf.docinfo[k]
            except Exception:
                pass
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
            os.close(fd)
            pdf.save(tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.warning(f"[OPTIMIZE] strip metadata failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _normalize_compat(pdf_path: str) -> None:
    """Chuẩn hóa cấu trúc PDF về xref cổ điển để pdf-lib (frontend) đọc lại
    được khi onFileFixed nạp blob về working file.

    Một số PDF writer ghi object stream + xref stream (Flate) mà pdf-lib/pako
    không giải nén được → 'Invalid header in flate stream'. Chạy CUỐI CÙNG (sau
    watermark) để giữ mọi nội dung. Non-blocking: lỗi chỉ log, giữ nguyên file."""
    import tempfile
    import pikepdf
    from app.workers.pdf_tools_engine import save_pdf_compat
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=os.path.dirname(pdf_path) or ".")
        os.close(fd)
        with pikepdf.open(pdf_path) as pdf:
            save_pdf_compat(pdf, tmp_path)
        os.replace(tmp_path, pdf_path)
        tmp_path = None
    except Exception as e:
        logger.warning(f"[OPTIMIZE] compat normalize failed (non-blocking): {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


async def save_upload(file: UploadFile) -> str:
    """Stream an uploaded PDF to disk and enforce the shared file-size limit."""
    filename = file.filename or "upload.pdf"
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file extension: {extension or '(none)'}")
    try:
        if not file.filename:
            file.filename = filename
        _stored_name, path, _size = await save_upload_file(file)
        return path
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


@router.post("/merge")
async def merge_pdfs_endpoint(
    files: List[UploadFile] = File(...),
    mode: str = Form("merge_files"),
    license_info: dict = Depends(require_license),
):
    """
    Merge multiple PDFs.
    
    Modes: merge_files, interleave
    """
    from app.workers.pdf_tools_engine import merge_pdfs
    
    if len(files) < 1:
        raise HTTPException(status_code=400, detail="At least 1 file required")
    
    file_paths = []
    for f in files:
        file_paths.append(await save_upload(f))
    
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"merged_{job_id}.pdf")
    
    try:
        await run_in_threadpool(merge_pdfs, file_paths, output_path, mode=mode)
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        return FileResponse(
            path=output_path,
            filename="merged_output.pdf",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except Exception as e:
        _cleanup_file(output_path)
        raise_http(e, "Gộp PDF thất bại")
    finally:
        for p in file_paths:
            try: os.remove(p)
            except OSError: pass


@router.post("/merge-manifest")
async def merge_manifest_endpoint(
    files: Optional[List[UploadFile]] = File(None),
    manifest: str = Form(...),
    file_paths: Optional[str] = Form(None),
    return_path: bool = Form(False),
    license_info: dict = Depends(require_license),
):
    """Assemble large Combine jobs from a bounded page-operation manifest."""
    from app.workers.pdf_manifest_engine import merge_manifest

    uploads = files or []
    native_paths = []
    if file_paths:
        try:
            parsed_paths = json.loads(file_paths)
            if not isinstance(parsed_paths, list) or not all(isinstance(path, str) for path in parsed_paths):
                raise ValueError("file_paths must be an array of strings")
            native_paths = parsed_paths
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid native file paths") from exc
    if bool(uploads) == bool(native_paths):
        raise HTTPException(status_code=400, detail="Provide either uploaded files or native file paths")
    source_count = len(uploads) or len(native_paths)
    if source_count < 1 or source_count > 256:
        raise HTTPException(status_code=400, detail="Invalid manifest file count")
    if len(manifest) > 4 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Manifest is too large")
    try:
        manifest_items = json.loads(manifest)
        if not isinstance(manifest_items, list):
            raise ValueError("Manifest must be an array")
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid manifest JSON") from exc

    resolved_paths = []
    owned_paths = []
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"merged_manifest_{job_id}.pdf")
    try:
        for uploaded in uploads:
            source_name = uploaded.filename or ""
            _manifest_source_extension(source_name)
            uploaded_path = await save_upload(uploaded)
            owned_paths.append(uploaded_path)
            _validate_manifest_source_file(uploaded_path, source_name)
            resolved_paths.append(uploaded_path)
        for native_path in native_paths:
            _manifest_source_extension(native_path)
            if not os.path.isabs(native_path):
                raise HTTPException(status_code=400, detail="Đường dẫn nguồn Combine phải là đường dẫn tuyệt đối.")
            resolved = os.path.realpath(native_path)
            if not os.path.isfile(resolved):
                raise HTTPException(status_code=400, detail="Không tìm thấy file nguồn Combine trên máy.")
            _validate_manifest_source_file(resolved, native_path)
            resolved_paths.append(resolved)
        await run_in_threadpool(merge_manifest, resolved_paths, manifest_items, output_path)
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        if return_path:
            return {"path": os.path.abspath(output_path), "filename": "merged_output.pdf"}
        return FileResponse(
            path=output_path,
            filename="merged_output.pdf",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except ValueError as exc:
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        _cleanup_file(output_path)
        raise_http(exc, "Gộp PDF theo manifest thất bại")
    finally:
        for path in owned_paths:
            try:
                os.remove(path)
            except OSError:
                pass

@router.post("/split")
async def split_pdf_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    mode: str = Form("by_count"),
    config: str = Form("{}"),
    license_info: dict = Depends(require_license),
):
    """
    Split a PDF into multiple files.
    Returns a ZIP of the split files, or a single PDF.
    
    Modes: by_range, by_count, extract_pages
    Config JSON: { ranges, pagesPerFile, pageList }
    """
    from app.workers.pdf_tools_engine import split_pdf
    
    path_arg = file_path.strip().strip('"') if isinstance(file_path, str) else ""
    if path_arg:
        source_path = validate_imposition_pdf_path(path_arg)
        source_name = os.path.basename(source_path)
        delete_source = False
    elif file is not None:
        source_path = await save_upload(file)
        source_name = file.filename or "split.pdf"
        delete_source = True
    else:
        raise HTTPException(status_code=400, detail="Thiếu file PDF cần tách.")
    cfg = json.loads(config)
    
    job_id = uuid.uuid4().hex[:8]
    output_dir = os.path.join(RESULTS_DIR, f"split_{job_id}")
    base_name = source_name.replace('.pdf', '')
    
    zip_path = ""
    try:
        results = await run_in_threadpool(split_pdf,
            source_path, output_dir,
            mode=mode,
            ranges=cfg.get('ranges'),
            pages_per_file=cfg.get('pagesPerFile', 1),
            page_list=cfg.get('pageList'),
            base_name=base_name,
        )
        
        if len(results) == 1:
            await run_in_threadpool(_safe_watermark, results[0]["path"], license_info)
            return FileResponse(
                path=results[0]["path"],
                filename=results[0]["filename"],
                media_type="application/pdf",
                background=BackgroundTask(_cleanup_split_artifacts, "", output_dir),
            )
        
        # Multiple files: write ZIP to disk and stream it; do not retain the
        # complete archive plus an extra getvalue() copy in process memory.
        zip_path = os.path.join(RESULTS_DIR, f"split_{job_id}.zip")
        await run_in_threadpool(_create_split_zip, results, zip_path, license_info)

        return FileResponse(
            path=zip_path,
            filename=f"split_{job_id}.zip",
            media_type="application/zip",
            background=BackgroundTask(_cleanup_split_artifacts, zip_path, output_dir),
        )
    except Exception as e:
        _cleanup_split_artifacts(zip_path, output_dir)
        raise_http(e, "Tách PDF thất bại")
    finally:
        if delete_source:
            try: os.remove(source_path)
            except OSError: pass


@router.post("/resize")
async def resize_pages_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    target_w: float = Form(210),
    target_h: float = Form(297),
    scale_mode: str = Form("fit"),
    apply_to: str = Form("all"),
    target_dpi: int = Form(0),
    mode: str = Form("auto"),
    bg_fill_mode: str = Form("white"),
    bg_fill_color: str = Form("#ffffff"),
    page_size_mode: str = Form("fixed"),
    resize_by_content: bool = Form(False),
    return_path: bool = Form(False),
    license_info: dict = Depends(require_license),
):
    """Resize PDF pages to a new format.

    target_dpi > 0 bật GIẢM DỮ LIỆU theo khổ mới (giống PDF Optimizer): file thu
    nhỏ đúng theo khổ đích thay vì giữ nguyên độ phân giải gốc. mode:
      - 'auto'    : tự chọn (raster khi thuần ảnh & an toàn, còn lại vector).
      - 'vector'  : GS downsample ảnh, giữ vector/text/CMYK (an toàn in ấn).
      - 'raster'  : render lại theo DPI (nhanh/nhỏ nhất, mất vector & CMYK).
      - 'xobject' : chỉ đổi hình học (hành vi cũ, không giảm dung lượng).
    target_dpi=0 → giữ artwork gốc; nền động vẫn dựng ở 300 DPI."""
    request_started = time.perf_counter()
    from app.workers.pdf_tools_engine import resize_pages_smart
    from app.workers.resize_background_engine import normalize_page_size_mode

    try:
        # Test/caller Python gọi trực tiếp endpoint sẽ nhận FormInfo nếu bỏ qua
        # tham số; request HTTP thật luôn đưa chuỗi. Giữ tương thích call site cũ.
        raw_page_size_mode = page_size_mode if isinstance(page_size_mode, str) else "fixed"
        page_size_mode = normalize_page_size_mode(raw_page_size_mode)
        resize_by_content = (
            resize_by_content if isinstance(resize_by_content, bool) else False
        )
        return_path = return_path if isinstance(return_path, bool) else False
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # RESIZE (audit 2026-08-06 §G.11): khóa một chiều nhận thêm 'center_no_scale'.
    if page_size_mode != "fixed" and scale_mode not in {"fit", "center_no_scale"}:
        raise HTTPException(
            status_code=422,
            detail="Giữ tỷ lệ từng trang chỉ hỗ trợ Thu vừa khít hoặc Giữ nguyên ở giữa.",
        )
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"resized_{job_id}.pdf")
    source_path: Optional[str] = None
    delete_source = False
    source_name = "document.pdf"
    source_kind = "unknown"

    try:
        path_arg = file_path.strip().strip('"') if isinstance(file_path, str) else ""
        if path_arg:
            # PERF (audit 2026-08-01 §RT.10): sidecar cùng máy đọc thẳng
            # file sạch, không materialize PDF lớn trong WebView chỉ để upload.
            real_path = os.path.realpath(path_arg)
            if (
                not os.path.isabs(path_arg)
                or not os.path.isfile(real_path)
                or not real_path.lower().endswith(".pdf")
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Không tìm thấy file PDF nguồn trên máy.",
                )
            source_path = real_path
            source_name = os.path.basename(real_path)
            source_kind = "path"
        elif file is not None:
            source_name = file.filename or source_name
            source_path = await save_upload(file)
            delete_source = True
            source_kind = "upload"
        else:
            raise HTTPException(
                status_code=400,
                detail="Thiếu file PDF cần đổi khổ.",
            )
        try:
            # PERF (audit 2026-08-22 §RESIZE.6): vector/background đã giữ một
            # pikepdf document trước save. Nhúng watermark ngay tại đó để tránh
            # mở và serialize toàn file lần hai. Raster vẫn fallback hậu xử lý.
            watermark_applied_in_engine = False
            resize_pdf_finalizer = None
            license_key = (license_info or {}).get("license_key", "") or ""
            if license_key and license_key != "DEV_MODE":
                hwid = (license_info or {}).get("hwid", "") or ""

                def finalize_resize_pdf(pdf) -> bool:
                    nonlocal watermark_applied_in_engine
                    try:
                        from app.core.watermark import embed_watermark

                        watermark_applied_in_engine = bool(
                            embed_watermark(pdf, license_key, hwid)
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.error(
                            "[WATERMARK] resize inline failed (non-blocking): %s",
                            exc,
                        )
                        watermark_applied_in_engine = False
                    return watermark_applied_in_engine

                resize_pdf_finalizer = finalize_resize_pdf

            source_ready = time.perf_counter()
            engine_started = source_ready
            quality_payload: dict[str, object] = {}
            resize_kwargs = {
                "target_dpi": target_dpi,
                "mode": mode,
                "bg_fill_mode": bg_fill_mode,
                "bg_fill_color": bg_fill_color,
                "page_size_mode": page_size_mode,
                "resize_by_content": resize_by_content,
                "quality_report": quality_payload,
            }
            if resize_pdf_finalizer is not None:
                resize_kwargs["pdf_finalizer"] = resize_pdf_finalizer
            await run_in_threadpool(
                resize_pages_smart, source_path, output_path, target_w, target_h,
                scale_mode, apply_to, **resize_kwargs,
            )
            engine_finished = time.perf_counter()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        watermark_started = time.perf_counter()
        if not watermark_applied_in_engine:
            await run_in_threadpool(_safe_watermark, output_path, license_info)
        response_ready = time.perf_counter()

        # PERF (audit 2026-08-01 §RT.12): đưa timing backend về console frontend
        # để tách engine khỏi tải response và commitWorkingFile trên đúng file thật.
        timing_payload = {
            "source": source_kind,
            "source_ms": round((source_ready - request_started) * 1000.0, 1),
            "engine_ms": round((engine_finished - engine_started) * 1000.0, 1),
            "watermark_ms": round((response_ready - watermark_started) * 1000.0, 1),
            "watermark_inline": watermark_applied_in_engine,
            "backend_ms": round((response_ready - request_started) * 1000.0, 1),
            "input_bytes": os.path.getsize(source_path),
            "output_bytes": os.path.getsize(output_path),
            "quality": quality_payload,
        }
        timing_header = json.dumps(timing_payload, separators=(",", ":"))
        logger.info("[RESIZE_TIMING] route_done %s", timing_header)
        if return_path:
            # PERF (audit 2026-08-22 §RESIZE.5): desktop và sidecar ở cùng máy.
            # Giao đường dẫn thật để WebView không tải PDF về RAM rồi upload lại
            # chỉ nhằm tạo file cho PDFium. Caller nhận ownership của artifact.
            return {
                "path": os.path.abspath(output_path),
                "filename": f"resized_{source_name}",
                "size": timing_payload["output_bytes"],
                "timing": timing_payload,
            }
        return FileResponse(
            path=output_path,
            filename=f"resized_{source_name}",
            media_type="application/pdf",
            headers={
                "X-PrynX-Resize-Timing": timing_header,
                "Access-Control-Expose-Headers": "X-PrynX-Resize-Timing",
            },
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except Exception as e:
        _cleanup_file(output_path)
        raise_http(e, "Đổi kích thước trang thất bại")
    finally:
        if delete_source and source_path:
            try:
                os.remove(source_path)
            except OSError:
                pass


@router.post("/resize/inspect-transparency")
async def inspect_resize_transparency_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    # RESIZE (audit 2026-08-06 §G.7): đối xứng guard giấy phép với các route resize.
    license_info: dict = Depends(require_license),
):
    """Nhận diện trang còn transparency để UI chỉ hiện lựa chọn phù hợp."""
    from app.core.pdf_actions_native import detect_transparent_pages

    source_path: Optional[str] = None
    delete_source = False
    try:
        path_arg = file_path.strip().strip('"') if isinstance(file_path, str) else ""
        if path_arg:
            real_path = os.path.realpath(path_arg)
            if (
                not os.path.isabs(path_arg)
                or not os.path.isfile(real_path)
                or not real_path.lower().endswith(".pdf")
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Không tìm thấy file PDF nguồn trên máy.",
                )
            source_path = real_path
        elif file is not None:
            if not (file.filename or "").lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=415,
                    detail="File cần kiểm tra phải là PDF.",
                )
            source_path = await save_upload(file)
            delete_source = True
        else:
            raise HTTPException(
                status_code=400,
                detail="Thiếu file PDF cần kiểm tra transparency.",
            )

        # RESIZE (audit 2026-08-03 §TR.5): inspection chỉ duyệt object graph,
        # không chiếm heavy-job slot vốn dành cho render/bình bản.
        transparent_pages = await run_light_in_threadpool(
            detect_transparent_pages,
            source_path,
        )
        return {
            "has_transparency": bool(transparent_pages),
            "transparent_pages": transparent_pages,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise_http(exc, "Không kiểm tra được transparency của PDF")
    finally:
        if delete_source and source_path:
            _cleanup_file(source_path)


@router.post("/trim-shift")
async def trim_shift_endpoint(
    file: UploadFile = File(...),
    apply_to: str = Form("all"),
    config: str = Form("{}"),
    license_info: dict = Depends(require_feature("pdf.trim_shift")),
):
    """Trim & Shift — chỉnh box từng cạnh + dịch nội dung (binding/creep).

    Config JSON: {
        trimTop, trimBottom, trimLeft, trimRight,   # mm, ± (dương=nở, âm=cắt)
        shiftX, shiftY,                              # mm
        bindingEnabled, bindingMm, bindingInward,
        creepEnabled, creepMm, creepAxis,            # 'x' | 'y'
        split: { enabled, axis: 'vertical'|'horizontal', count: 2|3,
                 pieces: [{top, bottom, left, right}, ...] } # mm, lề trắng từng mảnh
    }
    """
    from app.workers.trim_shift_engine import trim_shift

    source_path = await save_upload(file)
    cfg = json.loads(config)
    split_config = cfg.get("split") if isinstance(cfg, dict) else None
    if not isinstance(split_config, dict) or not bool(split_config.get("enabled", False)):
        split_config = None
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"trimshift_{job_id}.pdf")

    try:
        await run_in_threadpool(trim_shift,
            source_path, output_path,
            apply_to=apply_to,
            trim_top_mm=float(cfg.get('trimTop', 0)),
            trim_bottom_mm=float(cfg.get('trimBottom', 0)),
            trim_left_mm=float(cfg.get('trimLeft', 0)),
            trim_right_mm=float(cfg.get('trimRight', 0)),
            shift_x_mm=float(cfg.get('shiftX', 0)),
            shift_y_mm=float(cfg.get('shiftY', 0)),
            binding_enabled=bool(cfg.get('bindingEnabled', False)),
            binding_mm=float(cfg.get('bindingMm', 0)),
            binding_inward=bool(cfg.get('bindingInward', True)),
            creep_enabled=bool(cfg.get('creepEnabled', False)),
            creep_mm=float(cfg.get('creepMm', 0)),
            creep_axis=str(cfg.get('creepAxis', 'x')),
            mirror_fill=bool(cfg.get('mirrorFill', False)),
            content_mode=str(cfg.get('contentMode', 'original')),
            keep_bleed=bool(cfg.get('keepBleed', False)),
            split_config=split_config,
        )
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"trimshift_{file.filename}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except Exception as e:
        _cleanup_file(output_path)
        raise_http(e, "Trim/shift trang thất bại")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/shuffle")
async def shuffle_pages_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: str = Form(""),
    action: str = Form("reverse"),
    mapping: str = Form("[]"),
    license_info: dict = Depends(require_license),
):
    """
    Reorder pages in a PDF.
    
    Actions: reverse, odd_first, even_first, custom
    Mapping: JSON array of 1-based page numbers (for custom action)
    """
    from app.workers.pdf_tools_engine import shuffle_pages
    
    path_arg = file_path.strip().strip('"') if isinstance(file_path, str) else ""
    if path_arg:
        source_path = validate_imposition_pdf_path(path_arg)
        source_name = os.path.basename(source_path)
        delete_source = False
    elif file is not None:
        source_path = await save_upload(file)
        source_name = file.filename or "document.pdf"
        delete_source = True
    else:
        raise HTTPException(status_code=400, detail="Thiếu file PDF cần xáo trộn.")
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"shuffled_{job_id}.pdf")
    
    mapping_list = json.loads(mapping) if mapping else []
    
    try:
        await run_in_threadpool(shuffle_pages, source_path, output_path, action=action, mapping=mapping_list)
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"shuffled_{source_name}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except Exception as e:
        _cleanup_file(output_path)
        raise_http(e, "Sắp xếp lại trang thất bại")
    finally:
        if delete_source:
            try: os.remove(source_path)
            except OSError: pass


@router.post("/ocr-searchable")
async def ocr_searchable_endpoint(
    file: UploadFile = File(...),
    lang: str = Form("vie+eng"),
    dpi: int = Form(300),
    preprocess: str = Form("false"),
    license_info: dict = Depends(require_license),
):
    """
    Create a Searchable PDF by embedding an invisible OCR text layer.

    Takes a scanned/rasterized PDF and runs Tesseract OCR on each page,
    inserting invisible text at the correct coordinates so the PDF becomes
    searchable (Ctrl+F) and text-selectable.

    Args:
        file:       The source PDF file
        lang:       Tesseract language pack(s) (default: "vie+eng")
        dpi:        Render resolution for OCR (default: 300)
        preprocess: "true" to apply denoise/deskew (recommended for scans)
    """
    from app.core.ocr_engine import OCREngine

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"searchable_{job_id}.pdf")

    do_preprocess = preprocess.lower() in ("true", "1", "yes")

    try:
        result = await run_in_threadpool(OCREngine.make_searchable_pdf,
            input_path=source_path,
            output_path=output_path,
            lang=lang,
            dpi=dpi,
            preprocess=do_preprocess,
        )

        if result["total_words"] == 0:
            raise HTTPException(
                status_code=422,
                detail="OCR không nhận diện được ký tự nào. File có thể trống hoặc chứa nội dung không phải chữ."
            )

        await run_in_threadpool(_safe_watermark, output_path, license_info)
        return FileResponse(
            path=output_path,
            filename=f"searchable_{file.filename}",
            media_type="application/pdf",
            headers={
                "X-OCR-Total-Pages": str(result["total_pages"]),
                "X-OCR-Pages-With-Text": str(result["pages_with_text"]),
                "X-OCR-Total-Words": str(result["total_words"]),
            },
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except Exception as e:
        _cleanup_file(output_path)
        logger.exception("OCR thất bại")
        raise HTTPException(status_code=500, detail=f"OCR thất bại ({type(e).__name__})")
    finally:
        try: os.remove(source_path)
        except OSError: pass


@router.post("/optimize")
async def optimize_pdf_endpoint(
    file: UploadFile = File(...),
    preset: str = Form("ebook"),
    image_dpi: int = Form(300),
    strip_metadata: str = Form("true"),
    grayscale: str = Form("false"),
    license_info: dict = Depends(require_license),
):
    """
    Nén/tối ưu PDF bằng engine object-level nội bộ.

    Preset chất lượng ảnh:
      - screen:   72 DPI images, max compression, smallest file
      - ebook:    150 DPI images, good quality, small file (DEFAULT)
      - printer:  300 DPI images, high quality, larger file
      - prepress: 300 DPI images, preserve all, largest file
      - custom:   Use image_dpi parameter for manual control

    Returns the optimized PDF with compression stats in headers.
    """
    import asyncio

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"optimized_{job_id}.pdf")

    original_size = os.path.getsize(source_path)
    do_strip = strip_metadata.lower() in ("true", "1", "yes")
    do_gray = grayscale.lower() in ("true", "1", "yes")
    if preset not in {"screen", "ebook", "printer", "prepress", "custom"}:
        preset = "ebook"

    try:
        from app.core import pdf_actions_native

        # GS-SUNSET (audit 2026-08-08 §GS.1): optimize chỉ dùng engine nội bộ.
        # Kết quả unsupported là giới hạn có chủ đích, không phải lỗi server và
        # không được chuyển tiếp sang một executable ngoài sản phẩm.
        native = await asyncio.to_thread(
            pdf_actions_native.optimize_pdf,
            source_path,
            output_path,
            preset,
            float(image_dpi) if preset == "custom" else None,
            do_gray,
        )
        if not native.get("supported"):
            warnings = "; ".join(native.get("warnings", []))
            logger.info(
                "optimize: engine nội bộ không xử lý chắc chắn được (%s)",
                warnings or "không có chi tiết",
            )
            from app.core.engine_support import unsupported_message

            raise HTTPException(
                status_code=422,
                detail=unsupported_message("Tối ưu PDF"),
            )

        if do_strip:
            try:
                await run_in_threadpool(_strip_pdf_metadata, output_path)
            except Exception as se:  # noqa: BLE001
                logger.warning("strip metadata sau optimize lỗi: %s", se)

        output_size = os.path.getsize(output_path)
        ratio = (
            round((1 - output_size / original_size) * 100, 1)
            if original_size > 0
            else 0
        )
        return FileResponse(
            path=output_path,
            filename=f"optimized_{file.filename}",
            media_type="application/pdf",
            headers={
                "X-Original-Size": str(original_size),
                "X-Optimized-Size": str(output_size),
                "X-Compression-Ratio": str(ratio),
                "X-PrynX-Engine": "pikepdf",
            },
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except Exception as e:
        _cleanup_file(output_path)
        logger.exception("Tối ưu thất bại trong engine nội bộ")
        raise HTTPException(
            status_code=500,
            detail="Tối ưu thất bại do engine nội bộ không xử lý được file này.",
        ) from e
    finally:
        try: os.remove(source_path)
        except OSError: pass

@router.post("/encrypt")
async def encrypt_pdf_endpoint(
    file: UploadFile = File(...),
    user_password: str = Form(""),
    owner_password: str = Form(""),
    allow_print: str = Form("true"),
    allow_copy: str = Form("true"),
    allow_modify: str = Form("false"),
    allow_annotate: str = Form("true"),
    allow_form: str = Form("true"),
    allow_assembly: str = Form("false"),
    open_password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Lock a PDF (AES-256 via pikepdf). Does not modify other pdf-tools pipelines."""
    from app.workers.pdf_tools_engine import encrypt_pdf

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"encrypted_{job_id}.pdf")

    def _flag(v: str) -> bool:
        return (v or "").lower() in ("true", "1", "yes")

    try:
        # Không gọi _safe_watermark sau khi khóa (file đã encrypt → open fail).
        # Watermark stealth vẫn áp dụng trên /decrypt và các tool plain-PDF khác.
        await run_in_threadpool(encrypt_pdf,
            source_path,
            output_path,
            user_password=user_password or "",
            owner_password=owner_password or "",
            allow_print=_flag(allow_print),
            allow_copy=_flag(allow_copy),
            allow_modify=_flag(allow_modify),
            allow_annotate=_flag(allow_annotate),
            allow_form=_flag(allow_form),
            allow_assembly=_flag(allow_assembly),
            open_password=open_password or "",
        )
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"encrypted_{base}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except ValueError as e:
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _cleanup_file(output_path)
        logger.exception("Khóa PDF thất bại")
        raise_http(e, "Khóa PDF thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/decrypt")
async def decrypt_pdf_endpoint(
    file: UploadFile = File(...),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Unlock a PDF when the password is known. Isolated from other tools."""
    from app.workers.pdf_tools_engine import decrypt_pdf

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"decrypted_{job_id}.pdf")

    try:
        await run_in_threadpool(decrypt_pdf, source_path, output_path, password=password or "")
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"decrypted_{base}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except ValueError as e:
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _cleanup_file(output_path)
        logger.exception("Mở khóa PDF thất bại")
        raise_http(e, "Mở khóa PDF thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/encryption-status", response_model=EncryptionStatusResponse)
async def encryption_status_endpoint(
    file: UploadFile = File(...),
    license_info: dict = Depends(require_license),
):
    """Lightweight probe: is this PDF encrypted? Does not alter the file."""
    from app.workers.pdf_tools_engine import pdf_is_encrypted

    source_path = await save_upload(file)
    try:
        return {"encrypted": await run_in_threadpool(pdf_is_encrypted, source_path)}
    except Exception as e:
        logger.exception("Kiểm tra mã hóa thất bại")
        raise_http(e, "Kiểm tra mã hóa thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/metadata/read", response_model=MetadataReadResponse)
async def metadata_read_endpoint(
    file: UploadFile = File(...),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Read standard Info metadata. Isolated from optimize strip_metadata."""
    from app.workers.pdf_tools_engine import read_pdf_metadata

    source_path = await save_upload(file)
    try:
        meta = await run_in_threadpool(read_pdf_metadata, source_path, password=password or "")
        return {"metadata": meta}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Đọc metadata thất bại")
        raise_http(e, "Đọc metadata thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/metadata/write")
async def metadata_write_endpoint(
    file: UploadFile = File(...),
    title: str = Form(""),
    author: str = Form(""),
    subject: str = Form(""),
    keywords: str = Form(""),
    creator: str = Form(""),
    producer: str = Form(""),
    clear_all: str = Form("false"),
    password: str = Form(""),
    license_info: dict = Depends(require_license),
):
    """Write or clear Info metadata. Does not change page content / optimize path."""
    from app.workers.pdf_tools_engine import write_pdf_metadata

    source_path = await save_upload(file)
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"metadata_{job_id}.pdf")
    do_clear = (clear_all or "").lower() in ("true", "1", "yes")

    try:
        fields = {
            "Title": title,
            "Author": author,
            "Subject": subject,
            "Keywords": keywords,
            "Creator": creator,
            "Producer": producer,
        }
        await run_in_threadpool(write_pdf_metadata,
            source_path,
            output_path,
            fields=fields,
            clear_all=do_clear,
            password=password or "",
        )
        await run_in_threadpool(_safe_watermark, output_path, license_info)
        base = file.filename or "document.pdf"
        return FileResponse(
            path=output_path,
            filename=f"metadata_{base}",
            media_type="application/pdf",
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except ValueError as e:
        _cleanup_file(output_path)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _cleanup_file(output_path)
        logger.exception("Ghi metadata thất bại")
        raise_http(e, "Ghi metadata thất bại")
    finally:
        try:
            os.remove(source_path)
        except OSError:
            pass


@router.post("/sticker-dieline", dependencies=[Depends(require_feature("prepress.cutline"))])
async def sticker_dieline_endpoint(request: Request, license_info: dict = Depends(require_license)):
    """Generate Cut Contour and Bleed for Stickers."""
    request_started = time.perf_counter()
    from app.workers.sticker_engine import (
        ALPHA_CONTOUR_INSET_MM,
        StickerEngine,
        compute_cut_bleed_offsets,
    )
    from app.workers.sticker_page_canvas import restore_sticker_page_canvas
    form = await request.form()
    file_id = form.get("file_id")
    file_path = form.get("file_path")
    source_path = None
    delete_source = False
    source_kind = "upload"
    direct_source_fingerprint = None

    # Desktop files already have a real local path. Reading that path directly
    # avoids uploading hundreds of MB to the local sidecar before processing.
    # A baked page-order/rotation edit has no path and automatically falls back
    # to the existing upload flow below.
    if file_path:
        supplied_path = str(file_path)
        if ".." in supplied_path:
            raise HTTPException(status_code=400, detail="Invalid path: directory traversal not allowed")
        if os.path.islink(supplied_path):
            raise HTTPException(status_code=400, detail="Invalid path: symbolic links not allowed")
        real_path = os.path.realpath(supplied_path)
        if not os.path.isfile(real_path):
            raise HTTPException(status_code=404, detail="File not found on disk.")
        if not real_path.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Unsupported file type")
        source_path = real_path
        original_name = os.path.basename(real_path)
        source_kind = "local_path"
    elif file_id:
        # The upload endpoint returns a database ID; resolve its temporary copy.
        from app.database import SessionLocal
        from app.models.job import UploadedFile as UploadedFileModel

        db = SessionLocal()
        try:
            db_file = db.query(UploadedFileModel).filter(UploadedFileModel.id == file_id).first()
            if not db_file:
                raise HTTPException(status_code=404, detail="File not found in database.")
            source_path = db_file.file_path
            original_name = db_file.original_name
            delete_source = True
        finally:
            db.close()
    else:
        raise HTTPException(
            status_code=400,
            detail="Missing 'file_id' or 'file_path' field.",
        )

    if not os.path.exists(source_path):
        raise HTTPException(status_code=404, detail="File not found on disk.")
        
    # Verify file is not 0 bytes
    if os.path.getsize(source_path) == 0:
        raise HTTPException(status_code=400, detail=f"File rỗng (0 bytes). Vui lòng chọn một file PDF hợp lệ có chứa dữ liệu.")

    if source_kind == "local_path":
        try:
            # REVISION (audit 2026-08-25 §REV.13): direct-path không được đọc
            # revision khác sau khi chờ heavy slot. Chụp nhẹ trước admission.
            direct_source_fingerprint = capture_source_fingerprint(source_path)
        except OSError as error:
            raise HTTPException(
                status_code=409,
                detail=SOURCE_REVISION_CHANGED_MESSAGE,
            ) from error

    cut_mode = form.get("cut_mode", "original")
    # AUDIT (2026-08-16 §BX.F06): hai tham số hình học quan trọng nhất trước đây là
    # hai tham số DUY NHẤT không validate — `float("abc")` ném ValueError ngoài try
    # → 500 trần, còn `float("1e309")`/`"NaN"` lọt vào engine thành inf/nan và làm
    # hỏng page box. Dùng cùng khuôn với `edge_sample_inset_mm` bên dưới.
    offset_mm = _sticker_float_param(form, "offset_mm", default=0.0, low=-50.0, high=50.0)
    # AUDIT (2026-08-16 §BX.F08): default phải khớp UI + recipe (`preserve`). Default
    # `round` cũ khiến client thiếu field nhận khuôn BỊ BO GÓC thay vì giữ nguyên góc.
    corner_style = form.get("corner_style", "preserve")
    # QUALITY (feedback 2026-08-19 §CUTROUND.UI1): engine đã hỗ trợ 0–100 nhưng
    # route cũ làm rơi field nên giao diện PDF/PNG luôn xuất ở mốc mặc định 50.
    curve_tension = _sticker_float_param(
        form, "curve_tension", default=50.0, low=0.0, high=100.0
    )
    bleed_mm = _sticker_float_param(form, "bleed_mm", default=0.0, low=0.0, high=50.0)
    fill_holes = form.get("fill_holes", "true")
    remove_white_bg = form.get("remove_white_bg", "false")
    draw_cut_contour = form.get("draw_cut_contour", "true")
    bleed_color_type = form.get("bleed_color_type", "image")
    bleed_color_hex = form.get("bleed_color_hex", "#FFFFFF")
    # Cạnh nào được bù xén (chỉ Xén vuông góc). Thiếu field = nở đều 4 cạnh như
    # các build cũ, nên client cũ và recipe cũ không đổi kết quả.
    bleed_sides_raw = form.get("bleed_sides")
    rectangle_mode_raw = form.get("rectangle_mode", "false")
    do_rectangle_mode = rectangle_mode_raw.lower() in ("true", "1", "yes")
    cut_first_page_only_raw = form.get("cut_first_page_only", "false")
    do_cut_first_page_only = cut_first_page_only_raw.lower() in ("true", "1", "yes")
    # UIUX (audit 2026-08-02 §CROP-STICKER.1): client cũ mặc định giữ khổ
    # nguồn; chỉ giữ canvas tight của engine khi người dùng bật rõ ràng.
    crop_to_sticker_raw = form.get("crop_to_sticker", "false")
    do_crop_to_sticker = (
        cut_mode != "none"
        and crop_to_sticker_raw.lower() in ("true", "1", "yes")
    )
    # auto_safe | contour | force_circle | force_ellipse | force_rect | force_triangle
    shape_mode = (form.get("shape_mode") or "auto_safe").strip().lower()

    process_pages = None
    process_pages_raw = form.get("process_pages")
    if process_pages_raw:
        try:
            import json as _process_pages_json
            parsed_pages = _process_pages_json.loads(str(process_pages_raw))
            if (
                not isinstance(parsed_pages, list)
                or not parsed_pages
                or any(
                    isinstance(page, bool) or not isinstance(page, int) or page < 1
                    for page in parsed_pages
                )
            ):
                raise ValueError("pages phải là danh sách số trang 1-based không rỗng")
            process_pages = list(dict.fromkeys(parsed_pages))
        except (TypeError, ValueError, _process_pages_json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"Phạm vi trang không hợp lệ: {exc}") from exc

    selected_objects_by_page = None
    selection_json_raw = form.get("selection_json")
    if selection_json_raw:
        import json as _selection_json
        try:
            selection_payload = _selection_json.loads(str(selection_json_raw))
            pages_payload = selection_payload.get("pages")
            if not isinstance(pages_payload, list) or not pages_payload:
                raise ValueError("pages phải là danh sách không rỗng")

            parsed_selection: dict[int, list[str]] = {}
            total_selected = 0
            for page_entry in pages_payload:
                if not isinstance(page_entry, dict):
                    raise ValueError("mỗi selection page phải là object")
                page_number = page_entry.get("page")
                object_ids = page_entry.get("object_ids")
                if (
                    isinstance(page_number, bool)
                    or not isinstance(page_number, int)
                    or page_number < 0
                    or not isinstance(object_ids, list)
                    or not object_ids
                ):
                    raise ValueError("page/object_ids không hợp lệ")
                target_ids = parsed_selection.setdefault(page_number, [])
                for object_id in object_ids:
                    if not isinstance(object_id, str):
                        raise ValueError("object id phải là chuỗi")
                    kind, separator, draw_index = object_id.rpartition("-")
                    if (
                        separator != "-"
                        or kind not in {"text", "image", "vector"}
                        or not draw_index.isdigit()
                    ):
                        raise ValueError(f"object id không hợp lệ: {object_id!r}")
                    if object_id not in target_ids:
                        target_ids.append(object_id)
                        total_selected += 1
                        if total_selected > 500:
                            raise ValueError("selection vượt quá 500 object")
            selected_objects_by_page = parsed_selection
        except (TypeError, ValueError, _selection_json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Selection object không hợp lệ: {exc}",
            )

    # AUDIT (2026-08-16 §BX.F06): clamp cùng khoảng với UI (0–5 mm) + chặn inf/nan.
    # Trước đây chỉ bắt ValueError, nên `'inf'` vẫn đi tiếp và clip artwork vô hạn.
    edge_bite_mm = _sticker_float_param(form, "edge_bite_mm", default=0.0, low=0.0, high=10.0)

    # UIUX (feedback 2026-08-19 §CUTJAG.PARITY1): phải phân biệt
    # client cũ KHÔNG gửi field (giữ cổng tự động theo nguồn biên) với
    # người dùng chủ động kéo về 0 (tắt hẳn khử răng cưa).
    cutline_denoise_raw = form.get("cutline_denoise")
    cutline_denoise = _sticker_float_param(
        form, "cutline_denoise", default=0.0, low=0.0, high=100.0
    )
    legacy_cutline_denoise = (
        None
        if cutline_denoise_raw is None or str(cutline_denoise_raw).strip() == ""
        else cutline_denoise
    )
    from app.workers.cutline_cubic_simplify import CUTLINE_SIMPLIFY_MAX_MM

    # QUALITY (audit 2026-09-10 §FAIR.4): dùng cùng trần với lõi neo tự do;
    # thiếu/0 chỉ tắt bước giảm node bổ sung, không tự đổi đường đã duyệt.
    cutline_simplify_mm = _sticker_float_param(
        form, "cutline_simplify_mm", default=0.0, low=0.0, high=CUTLINE_SIMPLIFY_MAX_MM
    )
    cutline_simplify_auto = str(form.get("cutline_simplify_auto", "false")).lower() in {"true", "1", "yes"}

    # Resize chỉ dịch điểm lấy màu vào trong; không dùng tham số này để clip artwork.
    try:
        edge_sample_inset_mm = float(form.get("edge_sample_inset_mm", 0.0))
    except (ValueError, TypeError):
        edge_sample_inset_mm = 0.0
    if not math.isfinite(edge_sample_inset_mm):
        edge_sample_inset_mm = 0.0
    edge_sample_inset_mm = max(0.0, min(5.0, edge_sample_inset_mm))
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"sticker_{job_id}.pdf")
    def _cleanup_owned_sticker_source() -> None:
        if delete_source and source_path:
            try:
                os.remove(source_path)
            except OSError:
                pass
    do_fill_holes = fill_holes.lower() in ("true", "1", "yes")
    do_remove_bg = remove_white_bg.lower() in ("true", "1", "yes")
    do_draw_cut_contour = draw_cut_contour.lower() in ("true", "1", "yes")
    adaptive_corner_policy = resolve_sticker_corner_policy(
        cut_mode, do_rectangle_mode, selected_objects_by_page is not None, shape_mode, corner_style
    )
    # PERF/QUALITY (audit 2026-08-21 §CANONICAL.3): preview classic đã fit đúng
    # CutContour thật. Khi client gửi reference, snapshot nó TRƯỚC heavy job và
    # tuyệt đối không detect/fit lần hai. Selection/multi giữ pipeline riêng.
    # Chế độ Alpha cũng có artifact canonical; `remove_white_bg=false` ở mode
    # này là chủ ý nghiệp vụ, không được làm rơi reference rồi fit lại.
    use_single_canonical_contour = (
        not do_rectangle_mode
        and cut_mode != "none"
        and selected_objects_by_page is None
        and process_pages is None
        and shape_mode in {"auto_safe", "contour"}
        and (do_remove_bg or cut_mode == "alpha")
    )
    use_single_ai_contour = (
        do_remove_bg
        and not do_rectangle_mode
        and cut_mode != "none"
        and selected_objects_by_page is None
        and process_pages is None
        and shape_mode in {"auto_safe", "contour"}
    )
    preview_ref_names = (
        "cutline_preview_session_id",
        "cutline_preview_revision",
        "cutline_preview_fingerprint",
    )
    preview_ref_supplied = any(
        str(form.get(name) or "").strip() for name in preview_ref_names
    )
    canonical_preview_override = None
    canonical_preview_page = 1
    if use_single_canonical_contour and preview_ref_supplied:
        raw_session_id = str(form.get("cutline_preview_session_id") or "").strip()
        raw_revision = str(form.get("cutline_preview_revision") or "").strip()
        raw_fingerprint = str(form.get("cutline_preview_fingerprint") or "").strip()
        raw_page = str(form.get("cutline_preview_page_number") or "1").strip()
        if not all((raw_session_id, raw_revision, raw_fingerprint, raw_page)):
            _cleanup_owned_sticker_source()
            raise HTTPException(
                status_code=400,
                detail="Tham chiếu preview đường bế chưa đầy đủ.",
            )
        if (
            len(raw_session_id) != 32
            or any(ch not in "0123456789abcdef" for ch in raw_session_id)
            or len(raw_fingerprint) != 64
            or any(ch not in "0123456789abcdef" for ch in raw_fingerprint)
        ):
            _cleanup_owned_sticker_source()
            raise HTTPException(
                status_code=400,
                detail="Tham chiếu preview đường bế không hợp lệ.",
            )
        try:
            preview_revision = int(raw_revision)
            canonical_preview_page = int(raw_page)
        except (TypeError, ValueError, OverflowError) as exc:
            _cleanup_owned_sticker_source()
            raise HTTPException(
                status_code=400,
                detail="Revision/trang của preview đường bế không hợp lệ.",
            ) from exc
        if preview_revision < 1 or canonical_preview_page < 1:
            _cleanup_owned_sticker_source()
            raise HTTPException(
                status_code=400,
                detail="Revision/trang của preview đường bế không hợp lệ.",
            )

        from app.core.sticker_sheet_session import get_session
        from app.workers.sticker_sheet_export import (
            StickerCanonicalPreviewConflict,
            StickerSheetExportError,
            snapshot_classic_cutline_preview,
        )

        preview_session = get_session(raw_session_id)
        if preview_session is None:
            _cleanup_owned_sticker_source()
            raise HTTPException(
                status_code=409,
                detail="Phiên preview đường bế đã hết hạn. Hãy chờ nhận diện lại.",
            )
        try:
            # Snapshot có hash/Array copy và có thể chờ operation_lock. Chạy ở
            # threadpool nhẹ để không đóng băng event loop/WebSocket tiến độ;
            # không chiếm slot `sticker` của job PDF nặng.
            canonical_preview_override = await run_light_in_threadpool(
                snapshot_classic_cutline_preview,
                preview_session,
                source_path=source_path,
                page_number=canonical_preview_page,
                expected_revision=preview_revision,
                expected_fingerprint=raw_fingerprint,
                offset_mm=offset_mm,
                bleed_mm=bleed_mm,
                cut_mode=cut_mode,
                corner_style=corner_style,
                fill_holes=do_fill_holes,
                curve_tension=curve_tension,
                cutline_denoise=legacy_cutline_denoise,
                cutline_simplify_mm=cutline_simplify_mm,
                classic_force_contour=shape_mode == "contour",
            )
        except StickerCanonicalPreviewConflict as exc:
            _cleanup_owned_sticker_source()
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except StickerSheetExportError as exc:
            _cleanup_owned_sticker_source()
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception:
            # Block lỗi bất ngờ vẫn phải dọn upload tạm; trước đây snapshot nằm
            # trước try chính nên exception ở đây có thể làm rò file nguồn.
            _cleanup_owned_sticker_source()
            raise
    try:
        # Parse CMYK string (e.g. "100,50,0,0") or fallback to RGB HEX.
        # Bọc an toàn: chuỗi rỗng/thiếu phần tử không được làm sập request.
        solid_bleed_color = (255, 255, 255)
        try:
            if bleed_color_hex and ',' in bleed_color_hex:
                raw = [p.strip() for p in bleed_color_hex.split(',')]
                parts = [int(p) if p else 0 for p in raw]
                if len(parts) == 4:
                    # CMYK input is 0-100, OpenCV/PIL wants 0-255
                    parts = [max(0, min(100, p)) for p in parts]
                    solid_bleed_color = tuple(int(p * 2.55) for p in parts)
            elif bleed_color_hex and bleed_color_hex.startswith("#"):
                h = bleed_color_hex.lstrip('#')
                if len(h) == 6:
                    solid_bleed_color = tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
        except (ValueError, TypeError):
            logger.warning("sticker-dieline: bleed_color_hex không hợp lệ (%r), dùng mặc định trắng.", bleed_color_hex)
            solid_bleed_color = (255, 255, 255)
                
        def _run_sticker_job_canonical(job_source_path):
            """Chạy toàn bộ phần đồng bộ ngoài event loop.

            PERF (audit 2026-08-05 §PERF.1): đẩy toàn bộ job khỏi event loop.
            PERF (audit 2026-08-16 §BX.P03): trần "1 job tem" nay do admission
            ``kind="sticker"`` của `heavy_job_scheduler` giữ — nó lấy gate riêng TRƯỚC
            suất heavy toàn cục và chờ ở tầng async, nên job tem xếp hàng không còn giữ
            suất toàn cục và không còn chặn oan merge/split/resize/optimize/OCR.
            Hàm này vì thế không tự khóa gì nữa.
            """
            engine = StickerEngine(dpi=300)
            engine_started = time.perf_counter()
            approved_contour_overrides = (
                {canonical_preview_page - 1: canonical_preview_override}
                if canonical_preview_override is not None and canonical_preview_override.get("kind") != "whole-page-memo-v1"
                else None
            )
            if canonical_preview_override is not None:
                logger.info(
                    "[STICKER] page=%d tái dùng canonical preview %s; "
                    "không giải lại phần hình học đã lưu",
                    canonical_preview_page,
                    str(canonical_preview_override.get("preview_fingerprint", ""))[:12],
                )
            elif use_single_ai_contour:
                from app.workers.sticker_source_inspector import (
                    StickerSourceInspectionError,
                )
                from app.workers.sticker_source_pipeline import (
                    StickerSourcePipelineError,
                    build_legacy_single_page_approved_contour,
                )

                try:
                    approved = build_legacy_single_page_approved_contour(
                        job_source_path,
                        cut_mode=cut_mode,
                        offset_mm=offset_mm,
                        bleed_mm=bleed_mm,
                        corner_style=corner_style,
                        curve_tension=curve_tension,
                        cutline_denoise=legacy_cutline_denoise,
                        cutline_simplify_mm=cutline_simplify_mm,
                        fill_holes=do_fill_holes,
                    )
                except (
                    StickerSourceInspectionError,
                    StickerSourcePipelineError,
                ) as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from exc
                if approved is not None:
                    approved_contour_overrides = {
                        0: {
                            "alpha": approved.alpha,
                            "dpi": approved.dpi,
                            "source_pixel_mm": approved.source_pixel_mm,
                            "boundary_source": approved.boundary_source,
                            "path_groups": approved.path_groups,
                            # QUALITY (audit 2026-08-19 §STK.EDGE01): màu nền
                            # là một phần của artifact đã duyệt; làm rơi nó khiến
                            # engine lấy chính halo JPEG nhạt làm màu bù xén.
                            "edge_background_rgb": approved.edge_background_rgb,
                            "edge_background_tolerance": (
                                approved.edge_background_tolerance
                            ),
                        }
                    }
                    logger.info(
                        "[STICKER] page=1 dùng contour %s đã duyệt; "
                        "giữ nguyên PDF gốc, không tách nhiều tem",
                        approved.boundary_source,
                    )
            success, meta = engine.process_pdf(
                input_path=job_source_path,
                output_path=output_path,
                cut_mode=cut_mode,
                offset_mm=offset_mm,
                corner_style=corner_style,
                bleed_mm=bleed_mm,
                fill_holes=do_fill_holes,
                remove_white_bg=do_remove_bg,
                bleed_color_type=bleed_color_type,
                solid_bleed_color=solid_bleed_color,
                draw_cut_contour=do_draw_cut_contour,
                rectangle_mode=do_rectangle_mode,
                edge_bite_mm=edge_bite_mm,
                edge_sample_inset_mm=edge_sample_inset_mm,
                cut_first_page_only=do_cut_first_page_only,
                shape_mode=shape_mode,
                bleed_sides=bleed_sides_raw,
                selected_objects_by_page=selected_objects_by_page,
                process_pages=process_pages,
                alpha_corner_policy=adaptive_corner_policy,
                curve_tension=curve_tension,
                approved_contour_overrides=approved_contour_overrides,
                cutline_denoise=cutline_denoise,
                cutline_simplify_mm=cutline_simplify_mm,
                _simplify_memo=(canonical_preview_override.get("simplify_memo")
                    if canonical_preview_override and canonical_preview_override.get("kind") == "whole-page-memo-v1" else None),
                cutline_simplify_auto=cutline_simplify_auto,
            )
            engine_seconds = time.perf_counter() - engine_started
            if not success or not os.path.exists(output_path):
                # success=False kèm meta['error'] = lỗi nghiệp vụ (vd không dò được hình)
                biz_err = meta.get("error") if isinstance(meta, dict) else None
                if biz_err:
                    raise HTTPException(status_code=422, detail=biz_err)
                raise RuntimeError("Lỗi lưu file kết quả. (File not found)")

            # Bỏ nền trắng chỉ thay đổi silhouette/alpha, tuyệt đối không sở hữu
            # quyết định crop trang. StickerEngine dùng một canvas làm việc nới đều
            # ``max_expansion_pts`` rồi legacy-tight-crop theo contour; khôi phục
            # page box nguồn tại biên API (sàn tối thiểu = khổ nguồn). Nếu bù xén /
            # đường cắt tràn ra ngoài mép trang nguồn, canvas được NỚI ra vừa đủ để
            # chứa — không thu hẹp. Selection mode đã copy nguyên trang nên không
            # cần hậu xử lý. Xén vuông giữ contract riêng: bleed có thể chủ động
            # nới trang thành phẩm.
            # Khi bật Crop trang theo tem, giữ nguyên MediaBox/CropBox tight do engine
            # tạo: TrimBox vẫn là đường bế thật, BleedBox/MediaBox vẫn chứa đủ bù xén.
            if (
                not do_crop_to_sticker
                and selected_objects_by_page is None
                and not do_rectangle_mode
            ):
                bleed_pts = bleed_mm * 2.83465
                effective_offset_mm = offset_mm - (
                    ALPHA_CONTOUR_INSET_MM if cut_mode == "alpha" else 0.0
                )
                offset_pts = effective_offset_mm * 2.83465
                if cut_mode == "none":
                    page_expansion_pts = max(0.0, bleed_pts)
                else:
                    cut_edge_pts, outer_edge_pts = compute_cut_bleed_offsets(
                        cut_mode,
                        bleed_pts,
                        offset_pts,
                    )
                    page_expansion_pts = max(0.0, cut_edge_pts, outer_edge_pts)
                restore_sticker_page_canvas(
                    job_source_path,
                    output_path,
                    expansion_pts=page_expansion_pts,
                )
            # Giữ tạo output trong một lượt admission, không xếp hàng lại cho watermark.
            _safe_watermark(output_path, license_info)
            return meta, engine_seconds

        def _run_sticker_job():
            # ROTATE (feedback 2026-08-25 §STICKER.ROT1): detector, engine và
            # bước khôi phục canvas phải đọc cùng page-space đã bake `/Rotate`.
            # REVISION (audit 2026-08-25 §REV.13): closure chỉ chạy sau khi
            # scheduler cấp slot; kiểm ngay trước canonicalize/first-open.
            if direct_source_fingerprint is not None:
                assert_source_fingerprint(direct_source_fingerprint)
            from app.workers.page_space_canonicalization import (
                canonicalize_page_space_file,
            )

            job_source_path, job_source_is_temp = canonicalize_page_space_file(
                source_path,
                f"sticker-{job_id}",
            )
            try:
                return _run_sticker_job_canonical(job_source_path)
            finally:
                if job_source_is_temp:
                    _cleanup_file(job_source_path)

        # PERF (audit 2026-08-16 §BX.P03): dùng `kind="sticker"` để job tem chờ ở gate
        # riêng TRƯỚC khi nhận suất heavy toàn cục, thay cho semaphore chặn trong thread.
        meta, engine_seconds = await run_scheduled_in_threadpool(
            "sticker", _run_sticker_job
        )

        # Engine có thể chạy lâu; chốt lại trước khi FileResponse/path được công
        # bố để không trả output tạo từ source đã đổi giữa chừng.
        if direct_source_fingerprint is not None:
            assert_source_fingerprint(direct_source_fingerprint)

        headers = {
            "X-Sticker-Output-Path": os.path.abspath(output_path),
        }
        if isinstance(meta, dict) and meta.get("selection_count") is not None:
            headers["X-Sticker-Selection-Count"] = str(meta["selection_count"])
        if meta and "width_mm" in meta and "height_mm" in meta:
            headers["X-Sticker-Width-MM"] = str(meta["width_mm"])
            headers["X-Sticker-Height-MM"] = str(meta["height_mm"])
            if "boxes" in meta:
                _set_sticker_json_header(headers, "X-Sticker-Boxes", meta["boxes"])
            if "shape_type" in meta:
                headers["X-Sticker-Shape-Type"] = meta["shape_type"]
            if "shape_params" in meta:
                headers["X-Sticker-Shape-Params"] = meta["shape_params"]
            # Hình học đường cắt tự nhận (auto_safe) + độ tin cậy → frontend hiện tên
            # hình đã nhận làm van an toàn thay cho dropdown shape_mode đã ẩn.
            if meta.get("cut_kind"):
                headers["X-Sticker-Cut-Kind"] = str(meta["cut_kind"])
            if meta.get("cut_confidence") is not None:
                headers["X-Sticker-Cut-Confidence"] = str(meta["cut_confidence"])
            if "pages" in meta:
                _set_sticker_json_header(headers, "X-Sticker-Pages", meta["pages"])
        if isinstance(meta, dict) and meta.get("warning"):
            import urllib.parse
            # Header value phải ASCII → percent-encode để giữ được tiếng Việt.
            # Cắt trước khi encode: tiếng Việt percent-encode phình ~3× nên cảnh báo
            # liệt kê hàng trăm số trang từng đủ sức làm vỡ trần header (§BX.F11).
            warning_text = str(meta["warning"])
            if len(warning_text) > 600:
                warning_text = warning_text[:600].rstrip() + "…"
            headers["X-Sticker-Warning"] = urllib.parse.quote(warning_text)
            
        logger.info(
            "[STICKER_TIMING] output_ready job=%s engine_s=%.3f ready_s=%.3f "
            "input_mb=%.2f output_mb=%.2f pages=%d rectangle=%s crop_to_sticker=%s "
            "bleed_mode=%s source=%s",
            job_id,
            engine_seconds,
            time.perf_counter() - request_started,
            os.path.getsize(source_path) / (1024 * 1024),
            os.path.getsize(output_path) / (1024 * 1024),
            len(meta.get("pages", [])) if isinstance(meta, dict) else 0,
            do_rectangle_mode,
            do_crop_to_sticker,
            bleed_color_type,
            source_kind,
        )
        return FileResponse(
            path=output_path,
            filename=f"dieline_{original_name}",
            media_type="application/pdf",
            headers=headers,
            background=BackgroundTask(
                _finish_sticker_response, request_started, job_id, output_path
            ),
        )
    except SourceRevisionChangedError as error:
        _cleanup_file(output_path)
        raise HTTPException(status_code=409, detail=str(error)) from error
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except Exception as e:
        _cleanup_file(output_path)
        # Log đầy đủ (kèm stacktrace) ở server để chẩn đoán.
        logger.error("sticker-dieline thất bại: %s", e, exc_info=True)
        # Engine ném RuntimeError("[{debug_step}] {msg}") — tag [debug_step] là NHÃN
        # NỘI BỘ an toàn (vd "[Process Contours Page 1]"), msg là chuỗi lỗi của
        # chính engine (loại + nội dung exception), KHÔNG phải stacktrace/đường dẫn
        # hệ thống. Hiện cả tag lẫn msg ra client để chẩn đoán nhanh chết ở BƯỚC
        # nào + LOẠI lỗi gì mà không cần đọc log server.
        _msg = str(e).strip()
        detail = (
            f"Lỗi tạo viền bế: {_msg}. Vui lòng thử lại hoặc kiểm tra lại file đầu vào."
            if _msg else
            "Lỗi tạo viền bế. Vui lòng thử lại hoặc kiểm tra lại file đầu vào."
        )
        raise HTTPException(status_code=500, detail=detail)
    finally:
        if delete_source and source_path:
            try: os.remove(source_path)
            except OSError: pass

@router.post("/remove-background", dependencies=[Depends(require_feature("util.bgremover"))])
async def remove_background_endpoint(
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    engine: str = Form('general'),
    edge_shift: int = Form(0),
    bg_color: str = Form('transparent'),
    custom_hex: str = Form('#FFFFFF'),
    auto_crop: bool = Form(False)
):
    """
    Remove background from an image using AI model.
    Takes JPG/PNG, applies post-processing, returns PNG.
    """
    from app.workers.image_postprocessor import apply_edge_shift, apply_auto_crop, apply_background
    from app.core.heavy_job_scheduler import run_heavy_in_threadpool as run_in_threadpool
    from io import BytesIO
    from PIL import Image, ImageCms, ImageOps

    if file:
        source_path = await save_upload(file)
        is_temp = True
    elif file_path:
        # SECURITY (audit 2026-08-10 §UP.X.04): dùng helper chung — scope check.
        source_path = _validate_image_file_path(file_path)
        is_temp = False
    else:
        raise HTTPException(status_code=400, detail="Vui lòng cung cấp file hoặc file_path hợp lệ")

    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"bg_removed_{job_id}.png")
    output_meta: dict[str, object] = {"warnings": []}

    # Suy luận AI nặng (BiRefNet ONNX ~927MB / rembg) là tác vụ ĐỒNG BỘ, CPU/GPU-bound.
    # Phải chạy trong threadpool — KHÔNG chạy thẳng trong async endpoint, nếu không sẽ
    # KHOÁ event loop → cả server "đứng hình" suốt lúc tách nền (đó là lý do "nặng/không chạy").
    def _process_bg_removal():
        with Image.open(source_path) as img:
            source_size = (img.width, img.height)
            planned_size, memory_warnings = _plan_background_work_size(*source_size)
            source_icc = img.info.get("icc_profile")
            source_dpi = img.info.get("dpi")
            img.load()
            work = ImageOps.exif_transpose(img)
            scale = planned_size[0] / float(source_size[0])
            target_size = (
                max(1, int(work.width * scale)),
                max(1, int(work.height * scale)),
            )
            warnings: list[str] = output_meta["warnings"]  # type: ignore[assignment]
            warnings.extend(memory_warnings)
            output_icc = source_icc

            if source_icc:
                try:
                    alpha = work.getchannel("A") if "A" in work.getbands() else None
                    source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc))
                    srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
                    work = ImageCms.profileToProfile(
                        work.convert("RGB"), source_profile, srgb_profile, outputMode="RGB"
                    )
                    if alpha is not None:
                        work.putalpha(alpha)
                    output_icc = srgb_profile.tobytes()
                    warnings.append("color-converted-to-srgb")
                except Exception:
                    logger.warning("Không chuyển được ICC ảnh tách nền; dùng RGB mặc định", exc_info=True)
                    work = work.convert("RGBA" if "A" in work.getbands() else "RGB")
                    output_icc = None
                    warnings.append("icc-profile-discarded")
            elif work.mode == "CMYK":
                work = work.convert("RGB")
                output_icc = None
                warnings.append("color-converted-to-srgb")

            if work.size != target_size:
                work = work.resize(target_size, Image.Resampling.LANCZOS)

            if engine == 'fast':
                # NHANH NHẤT (hàng loạt) — ISNet (~0.1s GPU / 0.6s CPU), chất lượng khá.
                from app.workers.isnet_engine import remove_background as _remove
                result_img = _remove(work)
            elif engine in ('max', 'hair'):
                # TỐI ĐA cho tóc/lông/kính — BiRefNet full (nặng, GPU yếu sẽ rớt CPU ~14s).
                from app.workers.birefnet_engine import remove_background as _remove
                result_img = _remove(work, variant='full')
            else:
                # MẶC ĐỊNH "Chất lượng cao" — BiRefNet-lite (xịn, vừa VRAM GPU ~6s).
                from app.workers.birefnet_engine import remove_background as _remove
                result_img = _remove(work, variant='lite')

            if edge_shift != 0:
                result_img = apply_edge_shift(result_img, edge_shift)
            if auto_crop:
                result_img = apply_auto_crop(result_img)
            if bg_color != 'transparent':
                result_img = apply_background(result_img, bg_color, custom_hex)

            save_kwargs: dict[str, object] = {}
            if output_icc:
                save_kwargs["icc_profile"] = output_icc
            if source_dpi:
                save_kwargs["dpi"] = source_dpi
            # PERF (feedback 2026-08-10 §UP.SPEED.1): PNG vẫn lossless ở mọi
            # mức. Trên ảnh 2000×2000 → 8000×8000, level 3 giảm thời gian encode
            # 6,15s → 3,64s so với mặc định level 6, dung lượng chỉ tăng 2,3%.
            save_kwargs["compress_level"] = 3
            result_img.save(output_path, format="PNG", **save_kwargs)
            output_meta["size"] = result_img.size

    try:
        await run_in_threadpool(_process_bg_removal)

        return FileResponse(
            path=output_path,
            filename=f"bg_removed_{os.path.splitext(file.filename)[0]}.png" if file and file.filename else f"bg_removed_{job_id}.png",
            media_type="image/png",
            headers={
                "X-Bg-Removal-Output-Size": "x".join(str(v) for v in output_meta.get("size", ())),
                "X-Bg-Removal-Warnings": ",".join(output_meta["warnings"]),
            },
            background=BackgroundTask(_cleanup_file, output_path),
        )
    except HTTPException:
        _cleanup_file(output_path)
        raise
    except Exception as e:
        _cleanup_file(output_path)
        logger.error("remove-background thất bại: %s", e, exc_info=True)
        # Anti-recon: KHÔNG trả str(e) ra client (có thể lộ path model ~/.u2net / URL / deps).
        # Chi tiết đã ghi log nội bộ (exc_info) để chẩn đoán; client nhận generic + type name
        # (nhất quán với chuẩn xử lý lỗi toàn backend).
        raise HTTPException(status_code=500, detail=f"Tách nền thất bại ({type(e).__name__})")
    finally:
        if is_temp:
            try: os.remove(source_path)
            except OSError: pass


@router.post(
    "/remove-background/warmup",
    dependencies=[Depends(require_feature("util.bgremover"))],
    response_model=WarmupResponse,
)
async def remove_background_warmup(engine: str = Form("general")):
    """Nạp sẵn model tách nền (chạy nền) để lần bấm đầu không phải chờ cold-start.
    FE gọi khi mở công cụ; chạy trong threadpool nên không khoá event loop.

    Warm ĐÚNG engine người dùng đang chọn (trước đây chỉ warm birefnet-lite →
    chọn 'fast'/'hair' vẫn cold-start):
      - 'fast'        → ISNet (~178MB)
      - 'hair'/'max'  → BiRefNet full (927MB, chất lượng tối đa)
      - còn lại       → BiRefNet lite (mặc định 'general')
    """
    from app.core.heavy_job_scheduler import run_heavy_in_threadpool as run_in_threadpool
    e = (engine or "general").strip().lower()
    if e == "fast":
        from app.workers.isnet_engine import warmup
        ok = await run_in_threadpool(warmup)
    elif e in ("hair", "max"):
        from app.workers.birefnet_engine import warmup
        ok = await run_in_threadpool(warmup, "full")
    else:
        from app.workers.birefnet_engine import warmup
        ok = await run_in_threadpool(warmup, "lite")
    return {"ok": bool(ok)}


@router.post("/upscale", dependencies=[Depends(require_feature("util.upscale"))])
async def upscale_endpoint(
    request: Request,
    file: Optional[UploadFile] = File(None),
    file_path: Optional[str] = Form(None),
    file_grant: Optional[str] = Form(None),
    file_grant_tab_id: Optional[str] = Form(None),
    engine: str = Form('general'),
    scale_factor: int = Form(4),
    include_working_pdf: bool = Form(False),
):
    """Phóng to ảnh 2x/4x bằng AI super-resolution (ONNX), trả PNG.

    Hỗ trợ model general (nhanh) và quality (RRDBNet). Giữ alpha nếu ảnh có.
    """
    from app.core.heavy_job_scheduler import (
        HeavyJobMemoryUnavailable,
        HeavyJobQueueCancelled,
        run_scheduled_in_threadpool,
    )
    from io import BytesIO
    from PIL import Image, ImageCms, ImageOps

    if file:
        source_path = await save_upload(file)
        is_temp = True
    elif file_path:
        # SEC (audit 2026-08-11 §UP.R.01): file người dùng bên ngoài thư mục PrynX
        # chỉ đi fast-path khi native đã cấp capability bind path+tab+TTL.
        if file_grant or file_grant_tab_id:
            if not file_grant or not file_grant_tab_id:
                raise HTTPException(status_code=403, detail="Incomplete file grant")
            source_path = _verify_upscale_file_grant(
                file_path,
                file_grant_tab_id,
                file_grant,
            )
        else:
            source_path = _validate_image_file_path(file_path)
        is_temp = False
    else:
        raise HTTPException(status_code=400, detail="Vui lòng cung cấp file hoặc file_path hợp lệ")

    if scale_factor not in (2, 4):
        if is_temp:
            try: os.remove(source_path)
            except OSError: pass
        raise HTTPException(status_code=400, detail="Mức phóng to chỉ hỗ trợ ×2 hoặc ×4")

    requested_engine = (engine or '').strip().lower()
    variant = requested_engine if requested_engine in ('general', 'balanced', 'quality') else 'balanced'
    job_id = uuid.uuid4().hex[:8]
    output_path = os.path.join(RESULTS_DIR, f"upscaled_{job_id}.png")
    working_pdf_path = os.path.join(RESULTS_DIR, f"upscaled_{job_id}.pdf")
    output_meta: dict[str, object] = {
        "warnings": [],
        "working_pdf_path": "",
        "artifact_lease": "",
    }
    cancel_event = threading.Event()
    input_dimensions: tuple[int, int] | None = None

    async def _watch_disconnect() -> None:
        while not cancel_event.is_set():
            if await request.is_disconnected():
                cancel_event.set()
                return
            await asyncio.sleep(0.05)

    if await request.is_disconnected():
        cancel_event.set()
    disconnect_watcher = asyncio.create_task(_watch_disconnect())

    def _cleanup_working_pdf_artifact() -> None:
        lease = str(output_meta.get("artifact_lease") or "")
        if lease:
            from app.core.cleanup import release_upscale_artifact_lease
            release_upscale_artifact_lease(lease)
        else:
            _cleanup_file(working_pdf_path)

    def _process_upscale():
        from app.workers.realesrgan_engine import (
            UpscaleCancelled,
            guard_runtime,
            upscale as _upscale,
        )

        def _checkpoint() -> None:
            if cancel_event.is_set():
                raise UpscaleCancelled("Tác vụ Upscale đã bị hủy.")

        _checkpoint()
        with Image.open(source_path) as img:
            # STABILITY (audit 2026-08-11 §US.04): reservation đã lấy theo header
            # trước khi vào worker. File path có thể bị phần mềm khác ghi đè giữa
            # hai mốc; không decode nếu kích thước đã đổi và vượt reservation.
            if input_dimensions != (img.width, img.height):
                raise UpscaleUnavailable(
                    "File ảnh đã thay đổi trong lúc chờ xử lý. Hãy thử lại với file hiện tại."
                )
            # UPSCALE (audit 2026-07-29 §NET.04): chốt thời gian/GPU thuộc tầng
            # policy, cạnh chốt RAM. Trước đây hàm này là code chết nên máy thiếu
            # GPU vẫn nhận job Chất lượng và chạy hàng chục phút không lời giải thích.
            guard_runtime(img.width, img.height, variant)
            _checkpoint()
            img.load()
            source_mode = img.mode
            source_icc = img.info.get("icc_profile")
            source_dpi = img.info.get("dpi")
            work = ImageOps.exif_transpose(img)
            output_dpi = _upscale_output_dpi(source_dpi, scale_factor)
            if work.size == (img.height, img.width) and img.width != img.height:
                output_dpi = output_dpi[1], output_dpi[0]

            warnings: list[str] = output_meta["warnings"]  # type: ignore[assignment]
            output_icc = source_icc
            # UPSCALE (audit 2026-08-10 §UP.X.05): xác định colorspace ICC thật để
            # không gắn nhầm profile Gray/LAB/CMYK lên output RGB.
            icc_cs = _icc_data_colorspace(source_icc)
            if source_mode == "CMYK":
                # UPSCALE (audit 2026-07-28 §UP-03): model chỉ nhận RGB. Nếu có
                # profile nguồn thì chuyển sang sRGB có quản lý màu; không bao giờ
                # gắn nhầm ICC CMYK lên ảnh RGB đầu ra.
                try:
                    if source_icc:
                        source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc))
                        srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
                        work = ImageCms.profileToProfile(
                            work, source_profile, srgb_profile, outputMode="RGB"
                        )
                        output_icc = srgb_profile.tobytes()
                    else:
                        work = work.convert("RGB")
                        output_icc = None
                except Exception:
                    logger.warning("Không chuyển được ICC CMYK; dùng chuyển RGB mặc định", exc_info=True)
                    work = work.convert("RGB")
                    output_icc = None
                warnings.append("color-converted-to-srgb")
            elif source_icc and icc_cs and icc_cs not in ("RGB",):
                # UPSCALE (audit 2026-08-10 §UP.X.05): Gray/LAB/XYZ ICC trên ảnh
                # sẽ bị model ép RGB → gắn profile cũ lên output RGB là SAI.
                # Chuyển profile-to-profile sang sRGB nếu được, nếu không thì bỏ ICC.
                try:
                    source_profile = ImageCms.ImageCmsProfile(BytesIO(source_icc))
                    srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
                    work = ImageCms.profileToProfile(
                        work, source_profile, srgb_profile, outputMode="RGB"
                    )
                    output_icc = srgb_profile.tobytes()
                    warnings.append("icc-converted-to-srgb")
                except Exception:
                    logger.warning(
                        "Không chuyển được ICC %s sang sRGB; bỏ ICC",
                        icc_cs, exc_info=True,
                    )
                    output_icc = None
                    warnings.append("icc-dropped-incompatible")

            if source_mode.startswith("I;16") or source_mode in ("I", "F"):
                warnings.append("bit-depth-reduced-to-8")

            result_img = _upscale(
                work,
                variant=variant,
                cancelled=cancel_event.is_set,
            )
            _checkpoint()
            if scale_factor == 2:
                # UPSCALE (audit 2026-07-28 §UP-04): hậu xử lý xác định ở backend,
                # tránh canvas WebView và bảo đảm đúng kích thước đã cam kết.
                result_img = result_img.resize(
                    (work.width * 2, work.height * 2),
                    Image.Resampling.LANCZOS,
                )
            save_kwargs: dict[str, object] = {}
            if output_icc:
                save_kwargs["icc_profile"] = output_icc
            # UPSCALE (feedback 2026-08-10 §UP.PHYSICAL.1): tăng pixel nhưng giữ
            # nguyên kích thước vật lý của tem/trang khi mở lại hoặc tạo PDF làm việc.
            save_kwargs["dpi"] = output_dpi
            # PERF (feedback 2026-08-10 §UP.SPEED.1): PNG vẫn lossless ở mọi
            # mức. Trên ảnh 2000×2000 → 8000×8000, level 3 giảm thời gian encode
            # 6,15s → 3,64s so với mặc định level 6, dung lượng chỉ tăng 2,3%.
            save_kwargs["compress_level"] = 3
            _checkpoint()
            result_img.save(output_path, format="PNG", **save_kwargs)
            _checkpoint()
            output_meta["size"] = result_img.size
            if include_working_pdf:
                try:
                    # PERF (feedback 2026-08-10 §UP.SPEED.3): native giữ thẳng
                    # luồng IDAT của PNG RGB khi bọc thành PDF. Mẫu 8000×8000 chỉ
                    # mất 0,39s; pdf-lib trong WebView mất 7,78s và phình 38→60MB.
                    from app.workers.pdf_manifest_engine import merge_manifest
                    merge_manifest(
                        [output_path],
                        [{"file_index": 0}],
                        working_pdf_path,
                    )
                    _checkpoint()
                    from app.core.cleanup import create_upscale_artifact_lease
                    output_meta["artifact_lease"] = create_upscale_artifact_lease(
                        working_pdf_path
                    )
                    output_meta["working_pdf_path"] = working_pdf_path
                except UpscaleCancelled:
                    _cleanup_working_pdf_artifact()
                    raise
                except Exception:
                    _cleanup_working_pdf_artifact()
                    logger.warning(
                        "Không tạo được PDF làm việc nhanh cho kết quả Upscale; frontend sẽ fallback",
                        exc_info=True,
                    )

    from app.workers.realesrgan_engine import UpscaleCancelled, UpscaleUnavailable

    try:
        # Chỉ đọc header trong threadpool thường; không giữ heavy slot và không
        # giải nén raster. Peak nhận được sẽ được reservation trước worker thật.
        from starlette.concurrency import run_in_threadpool as run_standard_threadpool

        def _read_upscale_dimensions() -> tuple[int, int]:
            with Image.open(source_path) as source_image:
                return source_image.width, source_image.height

        input_dimensions = await run_standard_threadpool(_read_upscale_dimensions)
        estimated_peak_mb = _validate_upscale_memory(*input_dimensions)
        await run_scheduled_in_threadpool(
            "upscale",
            _process_upscale,
            queue_cancelled=cancel_event.is_set,
            memory_required_mb=estimated_peak_mb,
            memory_budget_provider=_upscale_memory_budget_mb,
        )
        if cancel_event.is_set():
            raise UpscaleCancelled("Tác vụ Upscale đã bị hủy.")

        # PNG response là artifact truyền tải ngắn; companion PDF được quản lý bằng
        # marker lease bền qua restart trong cleanup.py, không tạo Timer/thread riêng.
        def _cleanup_upscale_artifacts():
            _cleanup_file(output_path)

        return FileResponse(
            path=output_path,
            filename=f"upscaled_{os.path.splitext(file.filename)[0]}.png" if file and file.filename else f"upscaled_{job_id}.png",
            media_type="image/png",
            headers={
                "X-Upscale-Output-Size": "x".join(str(v) for v in output_meta.get("size", ())),
                "X-Upscale-Warnings": ",".join(output_meta["warnings"]),
                "X-Upscale-Working-Pdf-Path": str(output_meta.get("working_pdf_path", "")),
                "X-Upscale-Artifact-Lease": str(output_meta.get("artifact_lease", "")),
            },
            background=BackgroundTask(_cleanup_upscale_artifacts),
        )
    except HTTPException:
        _cleanup_file(output_path)
        _cleanup_working_pdf_artifact()
        raise
    except (UpscaleCancelled, HeavyJobQueueCancelled) as e:
        _cleanup_file(output_path)
        _cleanup_working_pdf_artifact()
        logger.info("upscale đã dừng cooperative: %s", e)
        raise HTTPException(status_code=499, detail="Tác vụ Upscale đã bị hủy") from e
    except UpscaleUnavailable as e:
        # UPSCALE (audit 2026-07-29 §NET.04): engine đã soạn sẵn thông điệp tiếng
        # Việt cho người dùng (thiếu GPU / vượt trần thời gian). Trước đây nó rơi
        # vào nhánh 500 chung nên người dùng chỉ thấy "Phóng to ảnh thất bại".
        _cleanup_file(output_path)
        _cleanup_working_pdf_artifact()
        logger.info("upscale bị chặn trước khi chạy: %s", e)
        raise HTTPException(status_code=422, detail=str(e)) from e
    except HeavyJobMemoryUnavailable as e:
        _cleanup_file(output_path)
        _cleanup_working_pdf_artifact()
        logger.info("upscale chờ RAM nhưng ngân sách đã giảm: %s", e)
        raise HTTPException(
            status_code=422,
            detail=f"{e} Hãy chờ tác vụ đang chạy xong hoặc đóng bớt ứng dụng rồi thử lại.",
        ) from e
    except Exception as e:
        _cleanup_file(output_path)
        _cleanup_working_pdf_artifact()
        logger.error("upscale thất bại: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Phóng to ảnh thất bại ({type(e).__name__})")
    finally:
        cancel_event.set()
        disconnect_watcher.cancel()
        with suppress(asyncio.CancelledError):
            await disconnect_watcher
        if is_temp:
            try: os.remove(source_path)
            except OSError: pass


@router.post(
    "/upscale/artifact/claim",
    dependencies=[Depends(require_feature("util.upscale"))],
)
async def claim_upscale_artifact(lease_token: str = Form(...)):
    """Gắn companion PDF vào vòng đời tab sau khi workspace commit thành công."""
    from app.core.cleanup import claim_upscale_artifact_lease
    from starlette.concurrency import run_in_threadpool

    claimed = await run_in_threadpool(claim_upscale_artifact_lease, lease_token)
    if not claimed:
        raise HTTPException(status_code=404, detail="Artifact lease không còn hợp lệ")
    return {"ok": True}


@router.post(
    "/upscale/artifact/release",
    dependencies=[Depends(require_feature("util.upscale"))],
)
async def release_upscale_artifact(lease_token: str = Form(...)):
    """Thu hồi idempotent companion PDF khi tab owner đóng."""
    from app.core.cleanup import release_upscale_artifact_lease
    from starlette.concurrency import run_in_threadpool

    await run_in_threadpool(release_upscale_artifact_lease, lease_token)
    return {"ok": True}


@router.post(
    "/upscale/warmup",
    dependencies=[Depends(require_feature("util.upscale"))],
    response_model=WarmupResponse,
)
async def upscale_warmup(engine: str = Form("general")):
    """Nạp model và đo sẵn ô chuẩn để lần bấm đầu không phải chờ hai lượt probe."""
    # PERF (audit 2026-08-10 §UP.X.08): warmup KHÔNG chiếm heavy slot vì probe
    # đã có _probe_lock serialize bên trong engine. Dùng threadpool Starlette thường
    # để request upscale thật không bị hàng đợi khi warmup trùng.
    from starlette.concurrency import run_in_threadpool
    from app.workers.realesrgan_engine import probe_tile_seconds
    variant = "quality" if (engine or "").strip().lower() == "quality" else "general"

    def _warm_and_probe() -> bool:
        try:
            # PERF (feedback 2026-08-10 §UP.SPEED.2): frontend gọi endpoint này
            # ngay khi mở công cụ. Probe vừa nạp/biên dịch model vừa được cache cho
            # guard_runtime, tránh trả chi phí này thêm một lần sau khi bấm chạy.
            probe_tile_seconds(variant)
            return True
        except Exception:
            logger.warning("Không warm/probe được Upscale[%s]", variant, exc_info=True)
            return False

    ok = await run_in_threadpool(_warm_and_probe)
    return {"ok": bool(ok)}
