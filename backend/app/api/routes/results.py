"""
Results & Job status API endpoints.
"""
import logging
import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.models.job import ComparisonJob, PageResult, UploadedFile
from app.schemas.job import (
    JobResponse, PageResultResponse, ComparisonResultResponse, DiffRegion,
    DeleteJobResponse,
)
from app.core.license_guard import require_license
from app.core.artifact_lease import (
    claim_artifact_lease,
    release_artifact_lease,
    renew_artifact_lease_with_metadata,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# LIFECYCLE (audit 2026-08-25 §REV.11): mỗi heartbeat Edit kéo hạn DB theo
# cửa sổ rolling 24 giờ. Không hard-cap tổng tuổi tab; lease owner vẫn là lớp
# bảo vệ sát unlink trong khoảng giữa hai lần cập nhật DB.
EDIT_WORKING_FILE_RENEW_HOURS = 24


class ArtifactLeaseBatchRequest(BaseModel):
    """Một heartbeat/release nhẹ cho mọi artifact cùng owner tab."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    tab_id: str = Field(alias="tabId", min_length=1, max_length=128)
    lease_tokens: list[str] = Field(alias="leaseTokens", min_length=1, max_length=256)


def _apply_artifact_lease_batch(
    request: ArtifactLeaseBatchRequest,
    operation: Callable[[str, str], bool],
) -> dict[str, list[dict[str, object]]]:
    # LIFECYCLE (audit 2026-08-25 §REV.11): dedupe giữ đúng thứ tự để heartbeat
    # nhiều Working File không tạo I/O marker lặp trong cùng một request.
    tokens = list(dict.fromkeys(request.lease_tokens))
    return {
        "results": [
            {
                "leaseToken": token,
                "ok": operation(token, request.tab_id),
            }
            for token in tokens
        ]
    }


def _renew_artifact_lease_and_edit_expiry(token: str, owner_id: str) -> bool:
    """Gia hạn marker và, nếu là Edit, kéo đồng thời hạn bản ghi UploadedFile."""
    renewed, edit_fid, artifact_path = renew_artifact_lease_with_metadata(token, owner_id)
    if not renewed:
        return False
    if edit_fid is None:
        return True

    db = SessionLocal()
    try:
        row = db.query(UploadedFile).filter(UploadedFile.id == edit_fid).first()
        if row is None:
            logger.warning(
                "Lease Edit fid=%s vẫn sống nhưng bản ghi UploadedFile không còn; "
                "giữ heartbeat để artifact không bị xóa tiếp.",
                edit_fid,
            )
            return True
        if (
            not artifact_path
            or not row.file_path
            or os.path.normcase(os.path.abspath(row.file_path))
            != os.path.normcase(os.path.abspath(artifact_path))
        ):
            logger.error(
                "Không kéo expires_at cho lease Edit fid=%s vì path DB không khớp marker.",
                edit_fid,
            )
            return True
        row.expires_at = datetime.now(timezone.utc) + timedelta(
            hours=EDIT_WORKING_FILE_RENEW_HOURS
        )
        db.commit()
        return True
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Không gia hạn được expires_at cho Working File Edit fid=%s", edit_fid)
        # `ok` của endpoint là trạng thái delete-guard marker. DB lỗi thoáng qua
        # không được khiến frontend bỏ owner/heartbeat vĩnh viễn; lượt sau sẽ thử lại.
        return True
    finally:
        db.close()


@router.post("/artifacts/claim")
def claim_artifact_leases(
    request: ArtifactLeaseBatchRequest,
    _: dict = Depends(require_license),
):
    """Claim một hay nhiều Working artifact bằng token, không nhận path từ client."""
    return _apply_artifact_lease_batch(request, claim_artifact_lease)


@router.post("/artifacts/renew")
def renew_artifact_leases(
    request: ArtifactLeaseBatchRequest,
    _: dict = Depends(require_license),
):
    """Heartbeat rolling; chỉ owner đã claim và chưa hết hạn mới được gia hạn."""
    return _apply_artifact_lease_batch(
        request,
        _renew_artifact_lease_and_edit_expiry,
    )


@router.post("/artifacts/release")
def release_artifact_leases(
    request: ArtifactLeaseBatchRequest,
    _: dict = Depends(require_license),
):
    """Release idempotent khi đóng tab hoặc thay Working revision."""
    return _apply_artifact_lease_batch(request, release_artifact_lease)


def _build_diff_regions(raw_regions: list | None) -> list[DiffRegion]:
    """Transform raw DB diff_regions into Pydantic DiffRegion models."""
    if not raw_regions:
        return []
    return [
        DiffRegion(
            x=r.get("nx", r.get("x", 0)),
            y=r.get("ny", r.get("y", 0)),
            width=r.get("nw", r.get("width", 0)),
            height=r.get("nh", r.get("height", 0)),
            type=r.get("type", "image"),
            severity=r.get("severity", "medium"),
            description=r.get("description", ""),
            b_page=r.get("b_page"),
        )
        for r in raw_regions
    ]


def _build_page_response(pr, summary: dict | None = None) -> PageResultResponse:
    """Build a response and expose source-page -> imposed-sheet mapping."""
    matched_b_page = None
    page_mapping = (summary or {}).get("page_mapping")
    if isinstance(page_mapping, list) and 0 < pr.page_number <= len(page_mapping):
        matched_b_page = page_mapping[pr.page_number - 1]
    return PageResultResponse(
        page_number=pr.page_number,
        status=pr.status or "unknown",
        similarity_score=pr.similarity_score or 0,
        diff_count=pr.diff_count or 0,
        diff_regions=_build_diff_regions(pr.diff_regions),
        highlighted_image_url=pr.highlighted_image_path,
        gif_image_url=pr.gif_image_path,
        is_imposition_mode=bool(pr.is_imposition_mode),
        matched_b_page=matched_b_page,
    )


@router.get("/jobs/{job_id}", response_model=JobResponse)
def get_job_status(job_id: str, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Get job status and progress."""
    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job")
    return job


@router.get("/jobs/{job_id}/results", response_model=ComparisonResultResponse)
def get_job_results(job_id: str, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Get full comparison results with all page details."""
    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job")

    page_results = (
        db.query(PageResult)
        .filter(PageResult.job_id == job_id)
        .order_by(PageResult.page_number)
        .all()
    )

    # Build response
    pages = [_build_page_response(pr, job.result_summary) for pr in page_results]

    # Build file URLs
    file_a_url = f"/api/files/{job.file_a_id}/serve"
    file_b_url = f"/api/files/{job.file_b_id}/serve"

    return ComparisonResultResponse(
        job=JobResponse.model_validate(job),
        summary=job.result_summary,
        pages=pages,
        file_a_url=file_a_url,
        file_b_url=file_b_url,
    )


@router.get("/jobs/{job_id}/page/{page_num}", response_model=PageResultResponse)
def get_page_result(job_id: str, page_num: int, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Get comparison result for a specific page."""
    pr = (
        db.query(PageResult)
        .filter(PageResult.job_id == job_id, PageResult.page_number == page_num)
        .first()
    )
    if not pr:
        raise HTTPException(status_code=404, detail=f"Không tìm thấy kết quả trang {page_num}")

    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    return _build_page_response(pr, job.result_summary if job else None)


@router.delete("/jobs/{job_id}", response_model=DeleteJobResponse)
def delete_job(job_id: str, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Delete a job and its results."""
    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Không tìm thấy job")

    from app.utils.file_handler import cleanup_job_files
    cleanup_job_files(str(job_id))

    db.delete(job)
    db.commit()
    return {"message": "Đã xóa job thành công"}


@router.get("/files/{file_id}/serve")
def serve_file(file_id: str, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Serve an uploaded PDF file."""
    f = db.query(UploadedFile).filter(UploadedFile.id == file_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        f.file_path,
        media_type="application/pdf",
        filename=f.original_name,
    )
