import asyncio
import logging
import os
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from app.database import SessionLocal
from app.models.job import UploadedFile, ComparisonJob
from app.config import settings
from app.core.disk_space_guard import minimum_free_disk_bytes

logger = logging.getLogger(__name__)

# ── Configuration ──
# Files older than this (in hours) will be deleted by filesystem cleanup,
# regardless of whether they have a DB record.
# PHẢI >= hạn sống dài nhất do route đặt (Working_File phiên edit đặt expires_at=24h
# tại routes/edit.py). Trước đây 12h < 24h → quét sweep có thể XÓA Working_File đang
# trong phiên chỉnh sửa dài trước hạn (audit an toàn dữ liệu). Đặt 26h (24h + biên).
FS_CLEANUP_MAX_AGE_HOURS = 26

# ── Dọn OS temp theo whitelist prefix (audit RAM 2026-07-06) ──
# Worker VDP/NUP ghi file trung gian vào tempfile.gettempdir() (OS temp) — cleanup ở
# uploads/results/temp KHÔNG chạm tới. Đặc biệt vdp_prog_*.txt KHÔNG được worker tự
# xóa; vdp_chunk_/vdp_canon_/mkstemp có tự xóa nhưng LEAK nếu process crash giữa chừng.
# CHỈ xóa file khớp prefix RIÊNG của app (uuid/job_id hậu tố) — TUYỆT ĐỐI không đụng
# file prefix "tmp*" mặc định của Python (không phân biệt được của app hay tiến trình khác).
APP_TEMP_PREFIXES = (
    "vdp_preview_",
    "vdp_preview_tpl_",
    "vdp_chunk_",
    "vdp_canon_",
    "vdp_prog_",
    "nup_prog_",
    "nup_canon_",
    "nup_perf_",
    "nup_state_",
)
# Ngưỡng tuổi riêng cho OS temp: đủ dài hơn job VDP/NUP dài nhất, đủ ngắn để không
# tích lũy nhiều ngày. KHÔNG dùng chung 26h (temp là file đời ngắn).
OS_TEMP_MAX_AGE_HOURS = 12

# PERF (audit 2026-08-05 §PERF.7): high-watermark chỉ xét artifact có vòng đời
# rõ ràng. N-Up/VDP đã tự công bố TTL 1 giờ; dùng 2 giờ làm biên chống race.
# Input rơi lại sau crash giữ 12 giờ, cùng ngưỡng dài hơn job tối đa của OS temp.
PRESSURE_RESULT_MIN_AGE_HOURS = 2
PRESSURE_UPLOAD_MIN_AGE_HOURS = 12
_PRESSURE_RESULT_PATTERNS = (
    re.compile(r"^nup_[0-9a-f]{8}\.pdf$", re.IGNORECASE),
    re.compile(r"^vdp_[0-9a-f]{32}\.pdf$", re.IGNORECASE),
)
_PRESSURE_UPLOAD_PATTERNS = (
    re.compile(r"^vdp_data_[0-9a-f]{32}\.dat$", re.IGNORECASE),
    re.compile(r"^vdp_template_[0-9a-f]{32}\.pdf$", re.IGNORECASE),
    re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-"
        r"[0-9a-f]{12}_plan_input\.pdf$",
        re.IGNORECASE,
    ),
)
_PRESSURE_RECOVERY_MIN_BYTES = 512 * 1024 * 1024
_PRESSURE_RECOVERY_MAX_BYTES = 2 * 1024 * 1024 * 1024
_CLEANUP_PROCESS_STARTED_AT = time.time()


async def cleanup_expired_files_loop():
    """Background task to periodically clean up expired files and jobs."""
    while True:
        try:
            # 1. DB-aware cleanup (files with expires_at in the database)
            await asyncio.to_thread(cleanup_expired)
            # 2. Filesystem-level cleanup (catches orphan files from ALL routes)
            await asyncio.to_thread(cleanup_orphan_files)
        except asyncio.CancelledError:
            logger.info("Cleanup task cancelled.")
            break
        except Exception as e:
            logger.error(f"Error in cleanup task: {e}")
            
        # Run every 30 minutes
        await asyncio.sleep(1800)


def cleanup_expired():
    """Delete files and DB records that have passed their expires_at date."""
    now = datetime.now(timezone.utc)
    db = SessionLocal()
    
    try:
        # Find expired files
        expired_files = db.query(UploadedFile).filter(
            UploadedFile.expires_at <= now,
            UploadedFile.expires_at.isnot(None),
        ).all()
        
        if not expired_files:
            return
            
        logger.info(f"🧹 Found {len(expired_files)} expired files to clean up...")
        
        deleted_count = 0
        for f in expired_files:
            try:
                # 1. Delete physical PDF file
                if f.file_path and os.path.exists(f.file_path):
                    os.remove(f.file_path)
                
                # 2. Find jobs using this file
                jobs = db.query(ComparisonJob).filter(
                    (ComparisonJob.file_a_id == f.id) | (ComparisonJob.file_b_id == f.id)
                ).all()
                
                # 3. Delete job artifacts (entire results directory per job)
                for job in jobs:
                    job_results_dir = Path(settings.RESULTS_DIR) / str(job.id)
                    if job_results_dir.exists():
                        shutil.rmtree(job_results_dir)
                        
                    # Report PDF at top-level results dir
                    report_path = Path(settings.RESULTS_DIR) / f"{job.id}_report.pdf"
                    if report_path.exists():
                        report_path.unlink()
                        
                    # Remove the job (cascades page_results)
                    db.delete(job)
                
                # 4. Remove the file record
                db.delete(f)
                deleted_count += 1
                
            except Exception as item_err:
                logger.error(f"Failed to clean up file {f.id}: {item_err}")
                
        db.commit()
        if deleted_count > 0:
            logger.info(f"✨ Successfully cleaned up {deleted_count} expired files and jobs.")
            
    finally:
        db.close()


def cleanup_orphan_files():
    """Delete old files from uploads/, results/, and temp/ based on filesystem age.
    
    This is the safety net that catches ALL orphan files regardless of which API
    route created them. Many routes (imposition, pdf_tools, vdp, preflight, qc)
    save files to uploads/ without creating a DB record, so the DB-based cleanup
    never knows about them.
    
    Rules:
    - Files older than FS_CLEANUP_MAX_AGE_HOURS are deleted.
    - Empty subdirectories are removed after file cleanup.
    - The directories themselves (uploads/, results/, temp/) are preserved.
    """
    max_age_seconds = FS_CLEANUP_MAX_AGE_HOURS * 3600
    now = time.time()
    
    dirs_to_clean = [
        Path(settings.UPLOAD_DIR),
        Path(settings.RESULTS_DIR),
        Path(settings.UPLOAD_DIR).parent / "temp",  # backend/temp/
    ]
    
    total_deleted = 0
    total_freed_bytes = 0
    
    for target_dir in dirs_to_clean:
        if not target_dir.is_dir():
            continue

        deleted, freed = _cleanup_directory(target_dir, now, max_age_seconds)
        total_deleted += deleted
        total_freed_bytes += freed

    # OS temp: chỉ file khớp whitelist prefix của app + tuổi riêng (không đệ quy).
    os_deleted, os_freed = _cleanup_os_temp_by_prefix(now, OS_TEMP_MAX_AGE_HOURS * 3600)
    total_deleted += os_deleted
    total_freed_bytes += os_freed

    # Chỉ chạy thêm khi volume xuống dưới reserve; danh sách ứng viên bị giới hạn
    # nghiêm ngặt trong `_cleanup_storage_pressure`, không quét/xóa file khách hàng.
    pressure_deleted, pressure_freed = _cleanup_storage_pressure(now)
    total_deleted += pressure_deleted
    total_freed_bytes += pressure_freed

    if total_deleted > 0:
        freed_mb = round(total_freed_bytes / (1024 * 1024), 1)
        logger.info(
            f"🗑️ Filesystem cleanup: deleted {total_deleted} orphan files, "
            f"freed {freed_mb} MB"
        )


def _cleanup_directory(
    directory: Path, now: float, max_age_seconds: float
) -> tuple[int, int]:
    """Delete old files in a directory tree. Returns (deleted_count, freed_bytes)."""
    deleted = 0
    freed = 0
    
    # Pass 1: Delete old files
    for item in directory.rglob("*"):
        if not item.is_file():
            continue
        try:
            file_age = now - item.stat().st_mtime
            if file_age > max_age_seconds:
                file_size = item.stat().st_size
                item.unlink()
                deleted += 1
                freed += file_size
        except OSError as e:
            # File may be locked by another process (e.g. active job)
            logger.debug(f"Cannot delete {item.name}: {e}")
    
    # Pass 2: Remove empty subdirectories (bottom-up)
    for item in sorted(directory.rglob("*"), reverse=True):
        if item.is_dir():
            try:
                item.rmdir()  # Only removes if empty
            except OSError:
                pass  # Directory not empty, skip

    return deleted, freed


def _cleanup_os_temp_by_prefix(now: float, max_age_seconds: float) -> tuple[int, int]:
    """Dọn file trung gian của app ở OS temp (tempfile.gettempdir()) theo whitelist prefix.

    AN TOÀN với tiến trình khác:
    - CHỈ liệt kê file ở TẦNG GỐC của OS temp (KHÔNG rglob đệ quy → không đụng thư
      mục con của tiến trình/ứng dụng khác).
    - CHỈ xóa file có tên khớp một prefix trong APP_TEMP_PREFIXES (riêng của app).
    - CHỈ xóa khi tuổi file > max_age_seconds.
    Trả về (deleted_count, freed_bytes). Best-effort — bỏ qua lỗi khóa file.
    """
    deleted = 0
    freed = 0
    tmp_root = Path(tempfile.gettempdir())
    if not tmp_root.is_dir():
        return deleted, freed

    try:
        entries = list(tmp_root.iterdir())  # KHÔNG đệ quy — chỉ tầng gốc
    except OSError as e:
        logger.debug(f"Cannot list OS temp dir: {e}")
        return deleted, freed

    for item in entries:
        try:
            if not item.is_file():
                continue
            if not item.name.startswith(APP_TEMP_PREFIXES):
                continue
            if (now - item.stat().st_mtime) <= max_age_seconds:
                continue
            file_size = item.stat().st_size
            item.unlink()
            deleted += 1
            freed += file_size
        except OSError as e:
            # File có thể đang bị process khác giữ (job đang chạy) — bỏ qua.
            logger.debug(f"Cannot delete OS temp {item.name}: {e}")

    return deleted, freed


def _recovery_margin_bytes(total_bytes: int) -> int:
    """Khoảng đệm sau cleanup để vòng 30 phút không lặp xóa từng file nhỏ."""
    proportional = int(max(0, total_bytes) * 0.005)
    return min(
        _PRESSURE_RECOVERY_MAX_BYTES,
        max(_PRESSURE_RECOVERY_MIN_BYTES, proportional),
    )


def _pressure_volume_key(directory: Path) -> object:
    """Gộp uploads/results cùng volume để không tính dung lượng trống hai lần."""
    try:
        return ("device", os.stat(directory).st_dev)
    except OSError:
        normalized = os.path.normcase(os.path.abspath(directory))
        drive = os.path.splitdrive(normalized)[0]
        return ("drive", drive or normalized)


def _collect_pressure_candidates(
    directory: Path,
    patterns: tuple[re.Pattern, ...],
    now: float,
    min_age_seconds: float,
    created_before: float | None = None,
) -> list[tuple[float, int, int, Path]]:
    """Lấy file managed tầng gốc; bỏ symlink, thư mục job và file còn mới."""
    if not directory.is_dir():
        return []
    try:
        entries = list(directory.iterdir())
    except OSError as error:
        logger.debug("Không liệt kê được thư mục cleanup %s: %s", directory, error)
        return []

    candidates = []
    for item in entries:
        try:
            if item.is_symlink() or not item.is_file():
                continue
            if not any(pattern.fullmatch(item.name) for pattern in patterns):
                continue
            stat = item.stat()
            if now - stat.st_mtime < min_age_seconds:
                continue
            if created_before is not None and stat.st_mtime >= created_before:
                # Input sinh trong sidecar hiện tại có thể vẫn đang xếp hàng/chạy.
                continue
            candidates.append((stat.st_mtime, stat.st_mtime_ns, stat.st_size, item))
        except OSError as error:
            logger.debug("Không đọc được ứng viên cleanup %s: %s", item, error)
    return candidates


def _cleanup_storage_pressure(now: float) -> tuple[int, int]:
    """Thu hồi artifact managed cũ khi volume xuống dưới free-disk reserve.

    Không đệ quy và không nhận pattern rộng: `sticker_*`, file khách hàng, Working_File,
    kết quả compare/preflight và thư mục con đều nằm ngoài phạm vi xóa sớm.
    """
    roots = (
        (
            Path(settings.RESULTS_DIR),
            _PRESSURE_RESULT_PATTERNS,
            PRESSURE_RESULT_MIN_AGE_HOURS * 3600,
            None,
        ),
        (
            Path(settings.UPLOAD_DIR),
            _PRESSURE_UPLOAD_PATTERNS,
            PRESSURE_UPLOAD_MIN_AGE_HOURS * 3600,
            _CLEANUP_PROCESS_STARTED_AT,
        ),
    )
    volumes: dict[object, dict[str, object]] = {}
    for directory, patterns, min_age_seconds, created_before in roots:
        if not directory.is_dir():
            continue
        key = _pressure_volume_key(directory)
        volume = volumes.setdefault(
            key,
            {"directory": directory, "candidates": []},
        )
        volume["candidates"].extend(
            _collect_pressure_candidates(
                directory,
                patterns,
                now,
                min_age_seconds,
                created_before,
            )
        )

    deleted = 0
    freed = 0
    for volume in volumes.values():
        directory = Path(volume["directory"])
        try:
            usage = shutil.disk_usage(directory)
        except OSError as error:
            logger.warning(
                "[STORAGE-PRESSURE] không đọc được dung lượng tại %s: %s; bỏ qua.",
                directory,
                error,
            )
            continue
        reserve = minimum_free_disk_bytes(usage.total)
        if reserve <= 0 or usage.free >= reserve:
            continue
        target_free = min(
            usage.total,
            reserve + _recovery_margin_bytes(usage.total),
        )
        projected_free = usage.free
        candidates = sorted(
            volume["candidates"],
            key=lambda candidate: (candidate[0], str(candidate[3]).lower()),
        )
        for _mtime, expected_mtime_ns, expected_size, item in candidates:
            if projected_free >= target_free:
                break
            try:
                if item.is_symlink():
                    continue
                current = item.stat()
                # File vừa được job khác sửa/ghi lại sau lúc quét không còn là ứng viên.
                if (
                    current.st_mtime_ns != expected_mtime_ns
                    or current.st_size != expected_size
                ):
                    continue
                item.unlink()
                deleted += 1
                freed += expected_size
                projected_free += expected_size
            except OSError as error:
                logger.debug("Không xóa được artifact managed %s: %s", item, error)

        logger.info(
            "[STORAGE-PRESSURE] volume=%s free_before_mb=%.1f "
            "free_after_est_mb=%.1f reserve_mb=%.1f target_mb=%.1f",
            directory,
            usage.free / (1024 * 1024),
            projected_free / (1024 * 1024),
            reserve / (1024 * 1024),
            target_free / (1024 * 1024),
        )
        if projected_free < reserve:
            logger.warning(
                "[STORAGE-PRESSURE] volume vẫn dưới reserve; không còn artifact "
                "managed đủ tuổi để xóa an toàn."
            )
    return deleted, freed
