"""
Results & Job status API endpoints.
"""
import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.job import ComparisonJob, PageResult, UploadedFile
from app.schemas.job import (
    JobResponse, PageResultResponse, ComparisonResultResponse, DiffRegion
)
from app.core.license_guard import require_license

logger = logging.getLogger(__name__)
router = APIRouter()


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


def _build_page_response(pr) -> PageResultResponse:
    """Build a PageResultResponse from a PageResult ORM object."""
    return PageResultResponse(
        page_number=pr.page_number,
        status=pr.status or "unknown",
        similarity_score=pr.similarity_score or 0,
        diff_count=pr.diff_count or 0,
        diff_regions=_build_diff_regions(pr.diff_regions),
        highlighted_image_url=pr.highlighted_image_path,
        gif_image_url=pr.gif_image_path,
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
    pages = [_build_page_response(pr) for pr in page_results]

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

    return _build_page_response(pr)


@router.delete("/jobs/{job_id}")
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
