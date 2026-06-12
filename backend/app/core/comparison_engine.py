"""
Shared comparison engine logic.
Extracted from compare.py (sync route) and compare_task.py (Celery worker)
to eliminate code duplication.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import settings
from app.core.pdf_processor import PDFProcessor
from app.core.image_comparator import ImageComparator
from app.core.highlight_renderer import HighlightRenderer
from app.core.text_comparator import TextComparator
from app.core.ocr_engine import OCREngine
from app.models.job import ComparisonJob, PageResult, UploadedFile

logger = logging.getLogger(__name__)


def run_comparison_pipeline(
    job_id: str,
    db: Session,
    on_progress: callable = None,
):
    """
    Core comparison pipeline shared by both sync (DEV_MODE) and Celery (production).

    Args:
        job_id: The comparison job ID.
        db: SQLAlchemy session.
        on_progress: Optional callback(job_id, progress, status, current_page, total_pages, message)
                     for real-time notifications (e.g. Redis pub/sub in production).
    """
    processor = PDFProcessor()
    comparator = ImageComparator()
    renderer = HighlightRenderer()
    text_comparator = TextComparator()

    def notify(progress: int, message: str = "", status: str = "processing",
               current_page: int = 0, total_pages: int = 0):
        if on_progress:
            on_progress(job_id, progress, status, current_page, total_pages, message)

    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    if not job:
        logger.error(f"Job not found: {job_id}")
        return

    job.status = "processing"
    job.started_at = datetime.now(timezone.utc)
    db.commit()

    notify(0, message="Bắt đầu xử lý...")

    file_a = db.query(UploadedFile).filter(UploadedFile.id == job.file_a_id).first()
    file_b = db.query(UploadedFile).filter(UploadedFile.id == job.file_b_id).first()

    if not file_a or not file_b:
        raise ValueError("Không tìm thấy file PDF. Vui lòng upload lại.")

    config = job.config or {}
    dpi = config.get("dpi", settings.DEFAULT_DPI)
    tolerance = config.get("tolerance", "NORMAL")
    comparison_mode = config.get("comparison_mode", "full")
    is_cmyk_mode = comparison_mode == "cmyk"

    # ── Open PDF documents (no bulk conversion — memory efficient) ──
    job.progress = 5
    job.status_message = "Đang mở file PDF..."
    db.commit()
    notify(5, message="Đang mở file PDF...")

    with processor.open_document(file_a.file_path, dpi=dpi) as doc_a, \
         processor.open_document(file_b.file_path, dpi=dpi) as doc_b:

        pages_a = doc_a.page_count
        pages_b = doc_b.page_count
        total_pages = max(pages_a, pages_b)

        job.total_pages = total_pages
        job.progress = 10
        job.status_message = None
        db.commit()

        notify(10, message=f"Đang so sánh {total_pages} trang...", total_pages=total_pages)
        logger.info(f"Job {job_id}: PDF A={pages_a} pages, PDF B={pages_b} pages, comparing page-by-page...")

        # ── Compare page by page (10-90%) ──
        # Each iteration: render 1 page from A + 1 page from B → compare → save → discard
        # RAM usage: ~52MB constant (2 pages × ~26MB) instead of N×26MB
        pages_pass = pages_fail = pages_warning = 0
        total_diff_count = 0
        total_similarity = 0.0
        current_b_idx = 0
        
        total_imposition_instances = 0
        failed_imposition_instances = 0

        for page_idx in range(total_pages):
            page_num = page_idx + 1
            progress = 10 + int((page_idx / total_pages) * 80)

            notify(progress, current_page=page_num, total_pages=total_pages,
                   message=f"Đang so sánh trang {page_num}/{total_pages}...")

            # Render page A on demand (or None if out of range)
            img_a = doc_a.render_page(page_idx) if page_idx < pages_a else None

            # Smart Imposition Hunting Logic — render B pages on demand
            img_b = None
            found_b_idx = current_b_idx
            result = None

            if is_cmyk_mode and img_a is not None and pages_b > 0:
                # ── CMYK Channel-by-Channel Comparison ──
                cmyk_a = doc_a.render_page_cmyk(page_idx)
                b_idx = min(current_b_idx, pages_b - 1)
                cmyk_b = doc_b.render_page_cmyk(b_idx)
                img_b = doc_b.render_page(b_idx)
                found_b_idx = b_idx
                result = comparator.compare_cmyk(
                    cmyk_a, cmyk_b, tolerance=tolerance,
                    rgb_a=img_a, rgb_b=img_b, config=config,
                )
            elif img_a is not None and pages_b > 0:
                for b_idx in range(current_b_idx, pages_b):
                    test_b = doc_b.render_page(b_idx)
                    temp_result = comparator.compare(img_a, test_b, tolerance=tolerance, config=config)

                    if getattr(temp_result, "is_imposition_mode", False):
                        if temp_result.similarity_score > 0.0:
                            img_b = test_b
                            found_b_idx = b_idx
                            result = temp_result
                            break
                    else:
                        img_b = test_b
                        found_b_idx = b_idx
                        result = temp_result
                        break

                if img_b is None:
                    img_b = doc_b.render_page(current_b_idx)
                    result = comparator.compare(img_a, img_b, tolerance=tolerance, config=config)
                else:
                    current_b_idx = found_b_idx
                    
            # ── Augment with Text Semantic Diffs (Standard Mode only) ──
            if img_a is not None and img_b is not None and result is not None:
                is_imposition = getattr(result, "is_imposition_mode", False)
                if not is_imposition and len(result.diff_regions) > 0:
                    try:
                        # Extract text blocks
                        blocks_a = processor.extract_text_blocks(file_a.file_path, page_num)
                        blocks_b = processor.extract_text_blocks(file_b.file_path, current_b_idx + 1)
                        
                        # OCR Fallback for Flattened/Rasterized PDFs
                        if len(blocks_a) == 0 and img_a is not None:
                            logger.info(f"Page {page_num} of A has no text. Activating OCR Fallback...")
                            blocks_a = OCREngine.extract_text_blocks(img_a, dpi=dpi)
                            
                        if len(blocks_b) == 0 and img_b is not None:
                            logger.info(f"Page {current_b_idx + 1} of B has no text. Activating OCR Fallback...")
                            blocks_b = OCREngine.extract_text_blocks(img_b, dpi=dpi)
                        
                        text_diff = text_comparator.compare_blocks(blocks_a, blocks_b)
                        
                        if not text_diff.is_identical:
                            scale = dpi / 72.0
                            for region in result.diff_regions:
                                # Convert visual region to PDF Space (72 DPI)
                                rx = region.x / scale
                                ry = region.y / scale
                                rw = region.width / scale
                                rh = region.height / scale
                                
                                # Find intersecting text diffs
                                matched_texts = []
                                for chg in text_diff.changed_blocks:
                                    # Very loose intersection
                                    ix = max(rx, chg["x"])
                                    iy = max(ry, chg["y"])
                                    iw = min(rx + rw, chg["x"] + chg["width"]) - ix
                                    ih = min(ry + rh, chg["y"] + chg["height"]) - iy
                                    if iw > -10 and ih > -10:  # Allow 10pt wiggle room
                                        matched_texts.append(f"Chữ thay đổi: '{chg['original'].strip()}' → '{chg['new'].strip()}'")
                                        
                                for rem in text_diff.removed_blocks:
                                    ix = max(rx, rem["x"])
                                    iy = max(ry, rem["y"])
                                    iw = min(rx + rw, rem["x"] + rem["width"]) - ix
                                    ih = min(ry + rh, rem["y"] + rem["height"]) - iy
                                    if iw > -10 and ih > -10:
                                        matched_texts.append(f"Xóa chữ: '{rem['text'].strip()}'")
                                        
                                for add in text_diff.added_blocks:
                                    ix = max(rx, add["x"])
                                    iy = max(ry, add["y"])
                                    iw = min(rx + rw, add["x"] + add["width"]) - ix
                                    ih = min(ry + rh, add["y"] + add["height"]) - iy
                                    if iw > -10 and ih > -10:
                                        matched_texts.append(f"Thêm chữ: '{add['text'].strip()}'")
                                        
                                if matched_texts:
                                    region.type = "text"
                                    # Preserve OpenCV severity if it exists, otherwise Default 'medium'
                                    prev_desc = region.description if region.description != "Phát hiện khác biệt" else ""
                                    region.description = " | ".join(matched_texts) + (f" | {prev_desc}" if prev_desc else "")
                    except Exception as e:
                        logger.warning(f"Text comparison failed on page {page_num}: {e}")

            # Handle missing pages
            if img_a is None or img_b is None or result is None:
                page_result = PageResult(
                    job_id=job.id, page_number=page_num, status="fail",
                    similarity_score=0.0, diff_count=1,
                    diff_regions=[{
                        "description": "Trang bị thiếu", "severity": "high",
                        "type": "layout", "x": 0, "y": 0,
                        "width": 1, "height": 1, "b_page": found_b_idx + 1,
                        "nx": 0, "ny": 0, "nw": 1, "nh": 1,
                    }],
                    highlighted_image_path=None,
                    gif_image_path=None,
                )
                db.add(page_result)
                pages_fail += 1
                total_diff_count += 1
                job.current_page = page_num
                job.progress = progress
                db.commit()
                continue

            # Save highlighted image and GIF
            highlighted_url = None
            gif_url = None

            if result.highlighted_image is not None:
                highlighted_url = renderer.save_highlighted_image(
                    result.highlighted_image, str(job_id), page_num
                )
            if result.gif_image is not None:
                gif_url = renderer.save_gif_image(
                    result.gif_image, str(job_id), page_num
                )

            # Determine page status
            if result.diff_count == 0 or result.similarity_score >= 99.9:
                status = "pass"
                pages_pass += 1
            else:
                has_high = any(r.severity == "high" for r in result.diff_regions)
                if has_high or result.similarity_score < 95.0:
                    status = "fail"
                    pages_fail += 1
                else:
                    status = "warning"
                    pages_warning += 1

            # Normalize diff regions for frontend
            h, w = img_b.shape[:2]
            diff_regions_normalized = renderer.generate_diff_overlay_data(
                result.diff_regions, w, h
            )
            diff_regions_data = []
            for i, region in enumerate(result.diff_regions):
                nx = diff_regions_normalized[i]["x"]
                ny = diff_regions_normalized[i]["y"]

                vertical = "Góc trên" if ny < 0.33 else "Góc dưới" if ny > 0.67 else "Giữa"
                horizontal = "bên trái" if nx < 0.33 else "bên phải" if nx > 0.67 else "trung tâm"
                spatial_desc = f"{vertical} {horizontal}"

                # Use the region's existing description if it's meaningful (Text/CMYK), 
                # otherwise fall back to the spatial heuristic.
                has_custom_desc = region.description and not region.description.startswith("Lỗi kênh màu CMYK") and region.description != "Phát hiện khác biệt"
                final_desc = region.description if has_custom_desc else spatial_desc

                diff_regions_data.append({
                    "x": region.x, "y": region.y,
                    "width": region.width, "height": region.height,
                    "type": region.type, "severity": region.severity,
                    "description": final_desc,
                    "nx": nx, "ny": ny,
                    "nw": diff_regions_normalized[i]["width"],
                    "nh": diff_regions_normalized[i]["height"],
                    "b_page": found_b_idx + 1,
                })

            total_diff_count += result.diff_count
            total_similarity += result.similarity_score
            total_imposition_instances += getattr(result, "total_instances", 0)
            failed_imposition_instances += getattr(result, "failed_instances", 0)

            # Save page result
            page_result = PageResult(
                job_id=job.id, page_number=page_num, status=status,
                similarity_score=result.similarity_score,
                diff_count=result.diff_count,
                diff_regions=diff_regions_data,
                highlighted_image_path=highlighted_url,
                gif_image_path=gif_url,
                is_imposition_mode=getattr(result, "is_imposition_mode", False),
            )
            db.add(page_result)

            job.current_page = page_num
            job.progress = progress
            db.commit()

            # img_a, img_b, result are overwritten next iteration → RAM freed by GC

    # ── Generate summary (90-100%) ──
    notify(92, message="Đang tạo báo cáo tổng hợp...")

    llm_warnings = []
    # Legacy LLM integration removed. QC is now handled by the standalone /qc/check-text endpoint.

    avg_similarity = total_similarity / total_pages if total_pages > 0 else 100.0

    job.result_summary = {
        "total_pages": total_pages,
        "pages_pass": pages_pass,
        "pages_fail": pages_fail,
        "pages_warning": pages_warning,
        "total_diff_count": total_diff_count,
        "average_similarity": round(avg_similarity, 2),
        "total_instances": total_imposition_instances,
        "failed_instances": failed_imposition_instances,
        "overall_status": "PASS" if pages_fail == 0 and pages_warning == 0
                         else ("WARNING" if pages_fail == 0 else "FAIL"),
        "llm_warnings": llm_warnings,
    }
    job.status = "completed"
    job.progress = 100
    job.completed_at = datetime.now(timezone.utc)
    db.commit()

    notify(100, status="completed",
           message=f"Hoàn thành! {pages_pass} trang OK, "
                   f"{pages_fail} trang lỗi, {pages_warning} cảnh báo.")

    logger.info(f"Job {job_id} completed: {job.result_summary}")
