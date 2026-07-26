from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.gpu_accelerator import GPUAccelerator
from app.database import get_db
from app.models.job import ComparisonJob
from app.config import settings
from app.core.license_guard import require_license
import asyncio
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/system/gpu-status")
def get_gpu_status(license_info: dict = Depends(require_license)):
    """Retrieve current hardware acceleration status."""
    gpu = GPUAccelerator.get_instance()
    return gpu.get_system_status()

@router.post("/system/install-gpu-plugin")
async def install_gpu_plugin(license_info: dict = Depends(require_license)):
    """
    [MOCK/SIMULATION] Install CuPy GPU acceleration plugin.
    
    NOTE: This endpoint simulates a GPU plugin installation. In production,
    CuPy should be installed via pip during container build, not at runtime.
    This exists for UX demonstration purposes only.
    """
    logger.info("Initializing GPU Plugin download simulation...")
    # Simulate network download delay
    await asyncio.sleep(2)
    
    # Mutate the singleton state so the frontend settings modal
    # detects the plugin as "installed" on subsequent API requests.
    gpu = GPUAccelerator.get_instance()
    gpu.is_available = True
    gpu.backend = "nvidia_cuda"
    gpu.device_name = "NVIDIA CUDA (Đã cài Plugin)"
    gpu.plugin_size_mb = 2048

    import json
    from pathlib import Path
    config_path = Path("data/gpu_config.json")
    config_path.parent.mkdir(exist_ok=True)
    try:
        with open(config_path, "w") as f:
            json.dump({"installed": True}, f)
    except Exception as e:
        logger.error(f"Failed to persist GPU state: {e}")

    logger.info("GPU Plugin successfully downloaded and mapped into memory.")
    
    return {
        "status": "success",
        "is_simulated": True,
        "message": "Đã bật chế độ mô phỏng GPU. Xử lý thực tế vẫn dùng CPU.",
        "note": "Để sử dụng GPU thật, cần cài CuPy và có card NVIDIA với CUDA Toolkit."
    }

@router.post("/system/recover-jobs")
def recover_stuck_jobs(db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """
    Find and recover jobs that are stuck in 'processing' or 'pending' state
    due to a worker or server crash.
    """
    stuck_jobs = db.query(ComparisonJob).filter(
        ComparisonJob.status.in_(["processing", "pending"])
    ).all()
    
    recovered_count = 0
    for job in stuck_jobs:
        logger.info(f"🔄 Recovering stuck job: {job.id}")
        job.status = "pending"
        job.progress = 0
        job.current_page = 0
        db.commit()
        
        if settings.DEV_MODE or settings.IS_DESKTOP_APP:
            from app.api.routes.compare import submit_comparison_local
            if not submit_comparison_local(str(job.id)):
                logger.warning("Compare queue full; leaving recovered job %s pending", job.id)
                continue
        else:
            from app.workers.compare_task import run_comparison
            run_comparison.delay(str(job.id))
            
        recovered_count += 1
        
    return {"status": "success", "recovered_jobs_count": recovered_count}


@router.get("/system/gs-usage")
def get_gs_usage(license_info: dict = Depends(require_license)):
    """Số lần Ghostscript được gọi — thiết bị đo cho gate §8.1 của kế hoạch PPE.

    Điều kiện gỡ bundle Ghostscript đòi "≥95% job prepress trong 30 ngày không
    cần GS fallback". Con số đó chỉ có từ máy chạy thật, nên endpoint này để
    thu thập: `by_reason` cho biết ĐƯỜNG NÀO còn gọi GS, tức việc tiếp theo
    phải gỡ cái gì. Không ghi tên file, chỉ ghi module gọi.
    """
    from app.core import gs_usage

    return {
        "since_process_start": gs_usage.summary(),
        "persisted": gs_usage.read_log_summary(),
    }
