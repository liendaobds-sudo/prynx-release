"""
Comparison job API endpoints.
Supports both Celery (production) and synchronous (DEV_MODE) processing.
"""
import logging
import math
import os
import tempfile
import threading
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.job import ComparisonJob, UploadedFile
from app.schemas.job import CompareRequest, JobCancelResponse, JobCreateResponse
from app.core.disk_space_guard import (
    InsufficientDiskSpaceError,
    ensure_job_disk_space,
    estimate_compare_disk,
)
from app.core.license_guard import enforce_feature, require_feature, require_license
from app.core.job_access import is_job_access_for, issue_job_access
from app.core.heavy_job_scheduler import scheduled_job
from app.core.system_memory import plan_worker_count

logger = logging.getLogger(__name__)
router = APIRouter()

# Giới hạn job SO SÁNH ở DEV/Desktop. Fixed executor giữ số OS thread ổn định;
# submission slots chặn cả số job chạy và số job chờ để tránh tăng RAM vô hạn.
# Cấu hình qua PRYNX_MAX_COMPARE_JOBS và PRYNX_MAX_COMPARE_QUEUE.
# PERF (audit 2026-07-29 §C.3): trần = 1 là CỐ Ý. So sánh PDF là việc render + so ảnh
# rất tốn RAM theo kích thước trang (xem `_MAX_COMPARE_PAGE_PIXELS` bên dưới) và đi qua
# PDFium — nay đã serialize bằng `pdfium_guard`, nên job thứ hai chạy song song chỉ thêm
# tranh chấp chứ không thêm thông lượng. Nới trần phải đo trước, không nới theo cảm giác.
_MAX_CONCURRENT_COMPARES = max(1, int(os.environ.get("PRYNX_MAX_COMPARE_JOBS", "1") or "1"))
_MAX_QUEUED_COMPARES = max(0, int(os.environ.get("PRYNX_MAX_COMPARE_QUEUE", "8") or "8"))
_COMPARE_EXECUTOR = ThreadPoolExecutor(
    max_workers=_MAX_CONCURRENT_COMPARES,
    thread_name_prefix="prynx-compare",
)
_COMPARE_SUBMISSION_SLOTS = threading.BoundedSemaphore(
    _MAX_CONCURRENT_COMPARES + _MAX_QUEUED_COMPARES
)

# PERF (audit 2026-08-13 §PA.R3): registry chỉ giữ control-plane nhẹ. Future callback
# là nơi DUY NHẤT trả submission slot, kể cả cancel job còn queued hoặc job kết thúc lỗi.
_COMPARE_JOBS_LOCK = threading.Lock()
_COMPARE_CONTROLS: dict[str, tuple[threading.Event, Future | None]] = {}

# Bound the largest rendered page, not just the PDF page count. A single A1/A0
# page at 300-600 DPI can exhaust memory even when the document has one page.
_MAX_COMPARE_PAGE_PIXELS = max(
    1,
    int(os.environ.get("PRYNX_MAX_COMPARE_PAGE_PIXELS", "40000000") or "40000000"),
)

# PERF (audit 2026-08-13 §PB-1): trần trang mặc định nâng 50 → 250 theo benchmark
# P-B (RAM đỉnh PHẲNG theo số trang nhờ cửa sổ PA-1; artifact tuyến tính đã có
# admission đĩa; 250 trang @300 DPI ≤ ~2 phút máy mạnh). Đây là trần sản phẩm,
# KHÔNG gate theo phần cứng — không được hạ riêng cho máy mạnh.
# PERF (audit 2026-08-13 §PB-3): nâng tiếp 250 → 1.000 sau khi đủ gate (đã duyệt):
# benchmark 1.000 trang @150/300 DPI + all-diff không OOM (đỉnh RAM phẳng theo số
# trang), speedup không còn suy giảm theo chiều dài (PB-2b), admission đĩa chặn
# ca all-diff ~1,35 GiB/job từ lúc nhận job, watchdog UI theo tiến độ thay
# timeout cứng, và bước dò map bình bài có trần lượt dò riêng (engine §PB-3).
_DEFAULT_MAX_COMPARE_PAGES = 1000


def _max_compare_pages() -> int:
    """Trần trang một lượt so sánh; PRYNX_MAX_COMPARE_PAGES cho người vận hành
    tự nới/thu (đọc mỗi request để test/override không cần reload module)."""
    raw = os.environ.get("PRYNX_MAX_COMPARE_PAGES", "")
    try:
        value = int(raw) if raw else _DEFAULT_MAX_COMPARE_PAGES
    except (TypeError, ValueError):
        logger.warning(
            "PRYNX_MAX_COMPARE_PAGES không hợp lệ (%r); dùng mặc định %d.",
            raw,
            _DEFAULT_MAX_COMPARE_PAGES,
        )
        return _DEFAULT_MAX_COMPARE_PAGES
    return max(1, value)


def _estimate_max_render_pixels(uploaded_file, dpi: int) -> int | None:
    '''Estimate the largest page raster from upload metadata.'''
    metadata = getattr(uploaded_file, "pdf_metadata", None) or {}
    pages = metadata.get("pages") if isinstance(metadata, dict) else None
    if not isinstance(pages, list):
        return None

    largest = 0
    for page in pages:
        if not isinstance(page, dict):
            continue
        try:
            width_pt = float(page.get("width_pt") or 0)
            height_pt = float(page.get("height_pt") or 0)
        except (TypeError, ValueError):
            continue
        if width_pt <= 0 or height_pt <= 0:
            continue
        width_px = math.ceil(width_pt * dpi / 72.0)
        height_px = math.ceil(height_pt * dpi / 72.0)
        largest = max(largest, width_px * height_px)
    return largest or None


def _large_page_tile_compatible(file_a, file_b, request: CompareRequest) -> bool:
    """Admission sớm cho hợp đồng tile hiện tại; thiếu metadata để engine quyết định."""
    if request.comparison_mode not in {"full", "cmyk"}:
        return False

    def _sizes(uploaded_file) -> list[tuple[int, int]] | None:
        metadata = getattr(uploaded_file, "pdf_metadata", None) or {}
        pages = metadata.get("pages") if isinstance(metadata, dict) else None
        if not isinstance(pages, list) or not pages:
            return None
        sizes = []
        for page in pages:
            if not isinstance(page, dict):
                return None
            try:
                width_pt = float(page.get("width_pt") or 0)
                height_pt = float(page.get("height_pt") or 0)
            except (TypeError, ValueError):
                return None
            if width_pt <= 0 or height_pt <= 0:
                return None
            sizes.append((
                math.ceil(width_pt * request.dpi / 72.0),
                math.ceil(height_pt * request.dpi / 72.0),
            ))
        return sizes

    sizes_a = _sizes(file_a)
    sizes_b = _sizes(file_b)
    if sizes_a is None or sizes_b is None:
        return True
    if request.page_matching_mode == "imposition":
        return request.comparison_mode == "full"
    if len(sizes_a) == len(sizes_b):
        from app.core.comparison_engine import _comparison_size_strategy

        return all(
            (
                _comparison_size_strategy(size_a, size_b) != "unsupported"
                and not (
                    request.comparison_mode == "cmyk"
                    and _comparison_size_strategy(size_a, size_b) == "imposition"
                )
            )
            for size_a, size_b in zip(sizes_a, sizes_b)
        )
    # Khi lệch số trang, căn nội dung quyết định cặp thật ở engine. Chỉ admission
    # nếu hai tài liệu dùng cùng tập khổ; từng cặp vẫn được guard trước full-render.
    return set(sizes_a) == set(sizes_b)


def _large_page_staging_multiplier(file_a, file_b) -> int:
    """Khác khổ có thể cần source+destination RGB memmap ngoài mask uint8."""
    metadata_a = getattr(file_a, "pdf_metadata", None) or {}
    metadata_b = getattr(file_b, "pdf_metadata", None) or {}
    pages_a = metadata_a.get("pages") if isinstance(metadata_a, dict) else None
    pages_b = metadata_b.get("pages") if isinstance(metadata_b, dict) else None
    if not isinstance(pages_a, list) or not isinstance(pages_b, list):
        return 7
    if len(pages_a) != len(pages_b):
        return 7
    for page_a, page_b in zip(pages_a, pages_b):
        if not isinstance(page_a, dict) or not isinstance(page_b, dict):
            return 7
        if (
            page_a.get("width_pt") != page_b.get("width_pt")
            or page_a.get("height_pt") != page_b.get("height_pt")
        ):
            # 1 byte mask + tối đa 3 byte source RGB + 3 byte destination RGB.
            return 7
    return 1


def _estimate_tile_staging_pixels(max_page_pixels: int, page_count: int) -> int:
    """Đỉnh mask disk-backed, gồm các process có thể chạy đồng thời."""
    pixels = max(0, int(max_page_pixels or 0))
    pages = max(0, int(page_count or 0))
    if pixels <= _MAX_COMPARE_PAGE_PIXELS:
        return 0
    try:
        min_pages = max(
            2,
            int(os.environ.get("PRYNX_COMPARE_PROCESS_MIN_PAGES", "16") or "16"),
        )
        min_pixels = max(
            1,
            int(os.environ.get("PRYNX_COMPARE_PROCESS_MIN_PIXELS", "8000000") or "8000000"),
        )
    except (TypeError, ValueError):
        min_pages, min_pixels = 16, 8_000_000
    workers = 1
    if pages >= min_pages and pixels >= min_pixels:
        process_worker_env = (
            "PRYNX_COMPARE_PROCESS_WORKERS"
            if os.environ.get("PRYNX_COMPARE_PROCESS_WORKERS", "")
            else "PRYNX_COMPARE_WORKERS"
        )
        workers, _reason = plan_worker_count(
            kind="compare-tile-staging",
            per_worker_mb=640.0,
            env_override=process_worker_env,
        )
        workers = min(workers, pages)
    return pixels * max(1, workers)


def _estimate_total_render_pixels(uploaded_file, dpi: int) -> int:
    """Tổng pixel render của cả tài liệu — đầu vào cho ước lượng đĩa artifact.

    PERF (audit 2026-08-13 §PB-1): thiếu metadata trang thì giả định khổ A4 cho
    mỗi trang thay vì bỏ qua admission — ước lượng dư an toàn hơn ước lượng 0.
    """
    metadata = getattr(uploaded_file, "pdf_metadata", None) or {}
    pages = metadata.get("pages") if isinstance(metadata, dict) else None
    total = 0
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            try:
                width_pt = float(page.get("width_pt") or 0)
                height_pt = float(page.get("height_pt") or 0)
            except (TypeError, ValueError):
                continue
            if width_pt <= 0 or height_pt <= 0:
                continue
            total += math.ceil(width_pt * dpi / 72.0) * math.ceil(height_pt * dpi / 72.0)
    if total > 0:
        return total
    a4_pixels = math.ceil(595 * dpi / 72.0) * math.ceil(842 * dpi / 72.0)
    return max(1, int(uploaded_file.page_count or 1)) * a4_pixels


def _get_cancel_event(job_id: str) -> threading.Event | None:
    with _COMPARE_JOBS_LOCK:
        control = _COMPARE_CONTROLS.get(str(job_id))
        return control[0] if control else None


def _register_reserved_job(job_id: str) -> threading.Event:
    event = threading.Event()
    with _COMPARE_JOBS_LOCK:
        _COMPARE_CONTROLS[str(job_id)] = (event, None)
    return event


def _release_completed_job(job_id: str, _future: Future) -> None:
    with _COMPARE_JOBS_LOCK:
        _COMPARE_CONTROLS.pop(str(job_id), None)
    _COMPARE_SUBMISSION_SLOTS.release()


@scheduled_job("compare")
def run_comparison_sync(job_id: str, cancel_event: threading.Event | None = None):
    """Chạy một job local; slot được callback của future trả đúng một lần."""
    db = None
    try:
        from app.database import SessionLocal
        from app.core.comparison_engine import run_comparison_pipeline

        db = SessionLocal()
        try:
            event = cancel_event or _get_cancel_event(job_id)
            run_comparison_pipeline(
                job_id,
                db,
                cancel_check=event.is_set if event is not None else None,
                raise_on_cancel=True,
            )
        except InterruptedError:
            logger.info("Job %s đã hủy", job_id)
        except Exception as exc:
            logger.exception("Job %s failed: %s", job_id, exc)
            job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
            # Engine đã dọn output và ghi failed. Guard này chỉ là fallback cho lỗi
            # xảy ra trước khi engine lấy được job/session.
            if job and job.status not in {"failed", "cancelled"}:
                job.status = "failed"
                job.error_message = str(exc)
                db.commit()
    except Exception as exc:
        # Initialization/import failures happen before the inner pipeline guard.
        # They still must release the bounded submission slot.
        logger.exception("Comparison job %s could not initialize: %s", job_id, exc)
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                logger.exception("Comparison job %s database close failed", job_id)

def _submit_reserved_comparison(job_id: str) -> None:
    """Submit after the caller has reserved one bounded queue slot."""
    with _COMPARE_JOBS_LOCK:
        control = _COMPARE_CONTROLS.get(str(job_id))
    cancel_event = control[0] if control else _register_reserved_job(job_id)
    future = _COMPARE_EXECUTOR.submit(run_comparison_sync, job_id, cancel_event)
    with _COMPARE_JOBS_LOCK:
        current = _COMPARE_CONTROLS.get(str(job_id))
        if current and current[0] is cancel_event:
            _COMPARE_CONTROLS[str(job_id)] = (cancel_event, future)
    future.add_done_callback(lambda done: _release_completed_job(str(job_id), done))


def submit_comparison_local(job_id: str) -> bool:
    """Reserve a local Compare slot and submit, returning False when full."""
    if not _COMPARE_SUBMISSION_SLOTS.acquire(blocking=False):
        return False
    _register_reserved_job(job_id)
    try:
        _submit_reserved_comparison(job_id)
    except Exception:
        with _COMPARE_JOBS_LOCK:
            _COMPARE_CONTROLS.pop(str(job_id), None)
        _COMPARE_SUBMISSION_SLOTS.release()
        raise
    return True


@router.post("/jobs/compare", response_model=JobCreateResponse)
def create_comparison_job(
    request: CompareRequest,
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_feature("qc.compare_pdf")),
):
    """Create a new PDF comparison job."""
    # Validate files exist
    file_a = db.query(UploadedFile).filter(UploadedFile.id == str(request.file_a_id)).first()
    file_b = db.query(UploadedFile).filter(UploadedFile.id == str(request.file_b_id)).first()

    if not file_a:
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF gốc")
    if not file_b:
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF đã sửa")

    # PERF (audit 2026-08-13 §PB-1): trần trang là trần SẢN PHẨM (đã benchmark),
    # không phải cap theo phần cứng — wording cũ "nâng cấp phần cứng" gây hiểu sai.
    max_pages = _max_compare_pages()
    biggest_page_count = max(int(file_a.page_count or 0), int(file_b.page_count or 0))
    if biggest_page_count > max_pages:
        raise HTTPException(
            status_code=413,
            detail=(
                f"File có {biggest_page_count} trang, vượt trần {max_pages} trang "
                "cho một lượt so sánh. Hãy chia nhỏ file PDF rồi so sánh từng phần."
            ),
        )

    max_render_pixels = max(
        _estimate_max_render_pixels(file_a, request.dpi) or 0,
        _estimate_max_render_pixels(file_b, request.dpi) or 0,
    )
    if max_render_pixels > _MAX_COMPARE_PAGE_PIXELS:
        # PERF (audit 2026-08-19 §CL.3): 40 MP là ngưỡng chọn full-frame/tile,
        # không còn là hard cap từ chối. Engine sẽ admission theo cặp 1:1 RGB/CMYK
        # và render vùng; các ca bình bài/co giãn chưa đủ hợp đồng báo rõ ở engine.
        logger.info(
            "Compare page estimate %.1f MP vượt ngưỡng full-frame %.1f MP; "
            "chuyển chiến lược tile khi cặp trang đủ điều kiện.",
            max_render_pixels / 1_000_000,
            _MAX_COMPARE_PAGE_PIXELS / 1_000_000,
        )
        if not _large_page_tile_compatible(file_a, file_b, request):
            raise HTTPException(
                status_code=413,
                detail=(
                    "Trang lớn vượt ngưỡng full-frame. Đối chiếu theo tile hiện hỗ trợ "
                    "chế độ 1:1 RGB/CMYK với các trang cùng kích thước; bình bài hoặc "
                    "tài liệu trộn khổ cần giảm DPI."
                ),
            )

    # PERF (audit 2026-08-13 §PB-1): artifact PNG/GIF ghi thẳng RESULTS_DIR và nhánh
    # xả áp lực đĩa cố ý bỏ qua Compare — phải từ chối sớm khi volume chắc chắn
    # thiếu, không để job dài ăn đĩa tới sát 0 rồi mới hỏng giữa chừng.
    estimate = estimate_compare_disk(
        total_render_pixels=max(
            _estimate_total_render_pixels(file_a, request.dpi),
            _estimate_total_render_pixels(file_b, request.dpi),
        ),
        page_count=max(1, biggest_page_count),
        max_page_pixels=_estimate_tile_staging_pixels(
            max_render_pixels,
            biggest_page_count,
        ) * _large_page_staging_multiplier(file_a, file_b),
    )
    try:
        ensure_job_disk_space(
            "so sánh PDF",
            output_path=settings.RESULTS_DIR,
            temp_path=tempfile.gettempdir(),
            estimate=estimate,
        )
    except InsufficientDiskSpaceError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from None

    # Create job
    job = ComparisonJob(
        job_type="version_compare",
        file_a_id=str(request.file_a_id),
        file_b_id=str(request.file_b_id),
        config={
            "comparison_mode": request.comparison_mode,
            "page_matching_mode": request.page_matching_mode,
            "tolerance": request.tolerance,
            "dpi": request.dpi,
            "highlight_color": request.highlight_color,
            "is_packaging_mode": request.is_packaging_mode,
        },
    )
    # PERF (audit 2026-08-13 §RV.1): dòng gán local_mode từng bị xóa nhầm trong lô
    # PA-1 khiến mọi request tạo job Compare chết NameError trước khi vào try.
    local_mode = settings.DEV_MODE or settings.IS_DESKTOP_APP
    if local_mode and not _COMPARE_SUBMISSION_SLOTS.acquire(blocking=False):
        raise HTTPException(
            status_code=429,
            detail="Hàng đợi Compare đang đầy. Vui lòng chờ job hiện tại hoàn tất.",
        )

    try:
        db.add(job)
        db.commit()
        db.refresh(job)

        if local_mode:
            # Fixed workers: queued jobs no longer allocate one waiting OS thread each.
            _register_reserved_job(str(job.id))
            _submit_reserved_comparison(str(job.id))
        else:
            # Production continues to use Celery.
            from app.workers.compare_task import run_comparison
            run_comparison.delay(str(job.id))
    except Exception:
        if local_mode:
            with _COMPARE_JOBS_LOCK:
                if 'job' in locals() and getattr(job, "id", None):
                    _COMPARE_CONTROLS.pop(str(job.id), None)
            _COMPARE_SUBMISSION_SLOTS.release()
        raise
    logger.info(f"Created job: {job.id} (sync_mode={local_mode})")
    # SEC (audit 2026-09-09 §LICUX.JOB): chỉ enqueue thành công mới có quyền
    # tiếp tục đọc/hủy đúng job khi license hết hạn; không nhận scope từ client.
    from app.core import license_guard
    access = issue_job_access(
        family="compare", job_id=str(job.id), license_info=license_info,
        session_token=license_guard._SIDECAR_TOKEN,
        source_ids=(str(job.file_a_id), str(job.file_b_id)),
    )
    return JobCreateResponse(
        job_id=job.id,
        job_access_token=access.token if access else None,
        job_access_expires_at=access.expires_at if access else None,
        job_access_paths=list(access.paths) if access else None,
    )


async def require_comparison_cancel_access(
    job_id: str,
    license_info: dict = Depends(require_license),
) -> dict:
    if is_job_access_for(license_info, "compare", job_id):
        return license_info
    return enforce_feature("qc.compare_pdf", license_info)


@router.post("/jobs/{job_id}/cancel", response_model=JobCancelResponse)
def cancel_comparison_job(
    job_id: str,
    db: Session = Depends(get_db),
    license_info: dict = Depends(require_comparison_cancel_access),
):
    """Hủy job Compare queued/running; endpoint idempotent."""
    local_mode = settings.DEV_MODE or settings.IS_DESKTOP_APP
    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job so sánh")

    if job.status in {"completed", "failed"}:
        return JobCancelResponse(
            job_id=job_id,
            status=job.status,
            cancelled=False,
            message="Job đã kết thúc nên không thể hủy.",
        )
    if job.status == "cancelled":
        return JobCancelResponse(
            job_id=job_id,
            status="cancelled",
            cancelled=True,
            message="Job đã được hủy trước đó.",
        )

    with _COMPARE_JOBS_LOCK:
        control = _COMPARE_CONTROLS.get(str(job_id))
    if control:
        event, future = control
        event.set()
        future_can_cancel = bool(future and not future.running() and not future.done())
    else:
        future_can_cancel = False

    status_message = "Đã hủy." if future_can_cancel else "Đang dừng và dọn kết quả dở dang..."
    transitioned = (
        db.query(ComparisonJob)
        .filter(
            ComparisonJob.id == job_id,
            ComparisonJob.status.in_(["pending", "processing"]),
        )
        .update(
            {
                ComparisonJob.status: "cancelled",
                ComparisonJob.status_message: status_message,
                ComparisonJob.error_message: None,
                ComparisonJob.completed_at: datetime.now(timezone.utc),
            },
            synchronize_session=False,
        )
    )
    db.commit()

    # SQLite trong desktop không bảo đảm nhìn thấy UPDATE từ session route khi
    # worker đang giữ transaction đọc. Event local là nguồn cancel tức thời; ghi
    # terminal/cleanup bằng đúng session worker để tránh lock chéo. Route chỉ trả
    # sau khi future kết thúc để UI không tưởng cleanup đã xong quá sớm.
    if control and future and not future_can_cancel:
        try:
            future.result()
        except (CancelledError, Exception):
            # Worker tự ghi trạng thái failed/cancelled; endpoint đọc lại bên dưới.
            # PERF (audit 2026-08-13 §RV.2): CancelledError kế thừa BaseException —
            # hai yêu cầu hủy chạy đua có thể thấy future đã bị cancel; không nêu
            # riêng thì endpoint hủy thứ hai chết 500 dù job đã dừng đúng.
            pass
        db.expire_all()
        current = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        if current and current.status == "cancelled":
            # Worker có thể đã rơi khỏi checkpoint cuối đúng lúc route chuyển DB
            # sang cancelled. Dọn idempotent lần cuối trước khi xác nhận cho UI.
            from app.core.comparison_engine import _finalize_interrupted_job

            _finalize_interrupted_job(
                job_id,
                db,
                status="cancelled",
                message="Đã hủy so sánh theo yêu cầu của người dùng.",
            )
            return JobCancelResponse(
                job_id=job_id,
                status="cancelled",
                cancelled=True,
                message="Đã hủy job so sánh.",
            )
        return JobCancelResponse(
            job_id=job_id,
            status=current.status if current else "not_found",
            cancelled=False,
            message="Job đã kết thúc trước khi yêu cầu hủy hoàn tất.",
        )

    if not transitioned:
        db.expire_all()
        current = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
        if current and current.status == "cancelled":
            return JobCancelResponse(
                job_id=job_id,
                status="cancelled",
                cancelled=True,
                message="Job đã được hủy trước đó.",
            )
        terminal_status = current.status if current else "not_found"
        return JobCancelResponse(
            job_id=job_id,
            status=terminal_status,
            cancelled=False,
            message="Job đã kết thúc nên không thể hủy.",
        )

    if control is None and local_mode:
        # PERF (audit 2026-08-13 §RV.3): job mồ côi — backend đã khởi động lại nên
        # registry RAM trống và không worker nào còn dọn row/artifact dở dang của
        # job này nữa. Route dọn idempotent ngay để hủy không giữ kết quả nửa chừng.
        from app.core.comparison_engine import _finalize_interrupted_job

        _finalize_interrupted_job(
            job_id,
            db,
            status="cancelled",
            message="Đã hủy so sánh theo yêu cầu của người dùng.",
        )
        return JobCancelResponse(
            job_id=job_id,
            status="cancelled",
            cancelled=True,
            message="Đã hủy job so sánh.",
        )

    # Chỉ cancel Future SAU KHI trạng thái DB đã chuyển thành công. Nếu engine vừa
    # hoàn tất và thắng race, endpoint không được giết nhầm future terminal.
    cancelled_before_start = bool(future_can_cancel and future and future.cancel())

    if cancelled_before_start:
        # Worker sẽ không chạy nên engine không có cơ hội dọn retry artifact/row cũ.
        from app.core.comparison_engine import _finalize_interrupted_job

        _finalize_interrupted_job(
            job_id,
            db,
            status="cancelled",
            message="Đã hủy so sánh theo yêu cầu của người dùng.",
        )

    return JobCancelResponse(
        job_id=job_id,
        status="cancelled",
        cancelled=True,
        message="Đã gửi yêu cầu hủy job so sánh.",
    )
