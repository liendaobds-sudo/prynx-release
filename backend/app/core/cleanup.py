import asyncio
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from app.database import SessionLocal
from app.models.job import UploadedFile, ComparisonJob
from app.config import settings

logger = logging.getLogger(__name__)

# ── Configuration ──
# Files older than this (in hours) will be deleted by filesystem cleanup,
# regardless of whether they have a DB record.
FS_CLEANUP_MAX_AGE_HOURS = 12


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
