"""
Shared comparison engine logic.
Extracted from compare.py (sync route) and compare_task.py (Celery worker)
to eliminate code duplication.

Chính sách so sánh PDF (in ấn): PIXEL-FIRST.
  - Nguồn sự thật = render trang → absdiff / SSIM / contour (ImageComparator).
  - Không OCR, không inject region từ text layer — tránh nhiễu / bỏ sót outline.
  - Text layer (nếu có) chỉ dùng phụ cho căn trang khi lệch số trang, không quyết
    định pass/fail. So chữ thuần: tool compare_text / QC riêng.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import settings
from app.core.pdf_processor import PDFProcessor
from app.core.image_comparator import ImageComparator
from app.core.highlight_renderer import HighlightRenderer
from app.models.job import ComparisonJob, PageResult, UploadedFile

logger = logging.getLogger(__name__)


def run_comparison_pipeline(
    job_id: str,
    db: Session,
    on_progress: callable = None,
):
    """
    Core comparison pipeline shared by both sync (DEV_MODE) and Celery (production).

    Pass/fail dựa hoàn toàn trên so pixel (ImageComparator). Không OCR / text-inject.

    Args:
        job_id: The comparison job ID.
        db: SQLAlchemy session.
        on_progress: Optional callback(job_id, progress, status, current_page, total_pages, message)
                     for real-time notifications (e.g. Redis pub/sub in production).
    """
    processor = PDFProcessor()
    comparator = ImageComparator()
    renderer = HighlightRenderer()

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
        # RAM KHÔNG tích luỹ tuyến tính theo SỐ TRANG (page A/B được giải phóng mỗi
        # vòng), NHƯNG đỉnh per-page CAO và tỉ lệ với render DPI × kích thước trang:
        # đo thực tế trang ảnh 1500px @150dpi (full RGB + CMYK + SSIM + diff) đạt đỉnh
        # ~0.5–0.7GB và ~0.5s/trang. Guard MAX_PAGES=50 (route compare) chặn bùng nổ
        # theo số trang nhưng KHÔNG giảm đỉnh per-page → máy RAM thấp cần cân nhắc DPI.
        pages_pass = pages_fail = pages_warning = 0
        total_diff_count = 0
        total_similarity = 0.0
        current_b_idx = 0
        
        total_imposition_instances = 0
        failed_imposition_instances = 0

        # ── Căn trang theo NỘI DUNG khi 2 file LỆCH SỐ TRANG (chèn/xoá) ──
        # An toàn: CHỈ bật khi pages_a != pages_b và KHÔNG phải CMYK. Số trang bằng
        # nhau → giữ nguyên ghép tuần tự + hunting imposition như cũ (không đổi hành
        # vi đường phổ biến). Lỗi bất kỳ ở bước căn → fallback ghép tuần tự.
        use_alignment = (pages_a != pages_b) and (not is_cmyk_mode) and pages_a > 0 and pages_b > 0
        align_pairs = None
        if use_alignment:
            try:
                import numpy as _np
                import cv2 as _cv2
                from app.core.page_aligner import (
                    align_pages, thumbnail_similarity, text_similarity, normalize_text,
                )

                def _fingerprints(path, n):
                    sigs = []
                    for p in range(1, n + 1):
                        im = processor.convert_single_page(path, p, dpi=36)
                        if im is None:
                            sigs.append(_np.zeros((32, 32), dtype=_np.uint8))
                            continue
                        g = _cv2.cvtColor(im, _cv2.COLOR_RGB2GRAY) if getattr(im, "ndim", 2) == 3 else im
                        sigs.append(_cv2.resize(g, (32, 32), interpolation=_cv2.INTER_AREA))
                    return sigs

                def _page_texts(path, n):
                    """Text chuẩn hoá mỗi trang (rỗng nếu trang ảnh/không có text)."""
                    out = []
                    for p in range(1, n + 1):
                        try:
                            blocks = processor.extract_text_blocks(path, p)
                            t = " ".join(b.get("text", "") for b in blocks)
                        except Exception:
                            t = ""
                        out.append(normalize_text(t))
                    return out

                _sig_a = _fingerprints(file_a.file_path, pages_a)
                _sig_b = _fingerprints(file_b.file_path, pages_b)
                _txt_a = _page_texts(file_a.file_path, pages_a)
                _txt_b = _page_texts(file_b.file_path, pages_b)

                def _sim(i, j):
                    # Hình thu nhỏ + (nếu CẢ HAI trang đủ chữ) text-hash. Tài liệu nhiều
                    # chữ trông na ná nhau → text giúp ghép đúng; trang ảnh → chỉ dùng hình.
                    vis = thumbnail_similarity(_sig_a[i], _sig_b[j])
                    ta, tb = _txt_a[i], _txt_b[j]
                    if len(ta) >= 20 and len(tb) >= 20:
                        return 0.5 * vis + 0.5 * text_similarity(ta, tb)
                    return vis

                align_pairs = align_pages(pages_a, pages_b, _sim)
                logger.info(f"Job {job_id}: căn trang BẬT ({pages_a}≠{pages_b} trang) → {len(align_pairs)} mục")
            except Exception as e:
                logger.warning(f"Job {job_id}: căn trang lỗi, fallback ghép tuần tự: {e}")
                align_pairs = None
                use_alignment = False

        if use_alignment and align_pairs is not None:
            work_seq = align_pairs
        else:
            use_alignment = False
            work_seq = [(i, None) for i in range(total_pages)]
        total_work = len(work_seq) or 1

        for out_idx, (a_idx, b_idx) in enumerate(work_seq):
            page_num = out_idx + 1
            progress = 10 + int((out_idx / total_work) * 80)

            notify(progress, current_page=page_num, total_pages=total_work,
                   message=f"Đang so sánh trang {page_num}/{total_work}...")

            # Render page A (None nếu không có A — vd trang chỉ được THÊM ở B)
            page_idx = a_idx if a_idx is not None else -1
            img_a = doc_a.render_page(a_idx) if (a_idx is not None and a_idx < pages_a) else None

            img_b = None
            found_b_idx = b_idx if b_idx is not None else current_b_idx
            result = None

            if use_alignment:
                # Cặp trang đã được căn theo nội dung → so 1:1 đúng cặp. Trang thêm/xoá
                # (a_idx hoặc b_idx = None) rơi vào nhánh "missing" với nhãn rõ ràng.
                if a_idx is not None and b_idx is not None:
                    img_b = doc_b.render_page(b_idx)
                    result = comparator.compare(img_a, img_b, tolerance=tolerance, config=config)
            elif is_cmyk_mode and img_a is not None and pages_b > 0:
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
                # CĂN TRANG 1:1: tiến con trỏ B sang trang kế (giống nhánh thường) —
                # CMYK luôn so theo cặp trang, không có chế độ imposition.
                current_b_idx = found_b_idx + 1
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
                    # CĂN TRANG 1:1 (sửa lỗi pin-về-B[0]): chế độ thường so A[i] với B[i],
                    # nên sau khi khớp phải TIẾN con trỏ sang trang B kế tiếp. Trước đây
                    # `current_b_idx = found_b_idx` (thiếu +1) khiến mọi trang A đều so với
                    # cùng một trang B (B[0]) → báo khác biệt giả ở mọi trang sau trang 1.
                    # Chế độ imposition (1 mẫu ↔ tờ N-up) GIỮ NGUYÊN: không tiến con trỏ vì
                    # nhiều mẫu có thể nằm trên cùng một tờ.
                    if getattr(result, "is_imposition_mode", False):
                        current_b_idx = found_b_idx
                    else:
                        current_b_idx = found_b_idx + 1
                    
            # PIXEL-ONLY: không OCR / không text-inject. Pass/fail = ImageComparator.

            # Handle missing pages (out-of-range positional, hoặc trang thêm/xoá khi căn trang)
            if img_a is None or img_b is None or result is None:
                if use_alignment and a_idx is None and b_idx is not None:
                    miss_desc = f"Trang được THÊM (chỉ có ở bản sửa — trang {b_idx + 1})"
                elif use_alignment and b_idx is None and a_idx is not None:
                    miss_desc = f"Trang bị XOÁ (chỉ có ở bản gốc — trang {a_idx + 1})"
                else:
                    miss_desc = "Trang bị thiếu"
                page_result = PageResult(
                    job_id=job.id, page_number=page_num, status="fail",
                    similarity_score=0.0, diff_count=1,
                    diff_regions=[{
                        "description": miss_desc, "severity": "high",
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

            # Determine page status — chuẩn IN ẤN, không chuẩn "giống % pixel".
            # SSIM/px% chỉ mô tả mức giống HÌNH toàn trang (tham khảo). Sai 1 chữ
            # trên nhãn vẫn SSIM ~99.9% nhưng là LỖI NGHIÊM TRỌNG → luôn FAIL khi
            # đã có vùng khác (sau lọc nhiễu). Không còn hạ severity xuống warning
            # chỉ vì vùng nhỏ / SSIM cao.
            if result.diff_count == 0:
                status = "pass"
                pages_pass += 1
            else:
                for region in result.diff_regions:
                    # Mọi khác biệt nội dung thật đều high cho QA in (kể cả micro-glyph).
                    if region.severity == "low":
                        region.severity = "high"
                    if region.type in ("image", "") and (
                        (region.description or "").startswith("Thay đổi nhỏ")
                        or (region.description or "").startswith("Vùng thay đổi")
                    ):
                        # Không có nhãn text: vẫn coi là lỗi in cần xử lý.
                        region.severity = "high"
                status = "fail"
                pages_fail += 1

            # Normalize diff regions for frontend
            # Dùng KÍCH THƯỚC RENDER của kết quả (có thể khác img_b gốc khi đã co giãn
            # Case A) để toạ độ chuẩn hoá luôn khớp vùng khác biệt (tránh lệch toạ độ).
            h = result.render_h or img_b.shape[0]
            w = result.render_w or img_b.shape[1]
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
    # SSIM = độ giống HÌNH (tham khảo). Verdict in ấn = có/không lỗi.
    print_ok = (pages_fail == 0 and pages_warning == 0 and total_diff_count == 0)
    if print_ok:
        verdict_detail = "Không phát hiện khác biệt pixel — ĐẠT kiểm in."
    elif total_diff_count == 1:
        verdict_detail = (
            "1 vùng pixel khác — KHÔNG ĐẠT. "
            "So sánh theo pixel (an toàn in ấn): mọi lệch hiển thị đều là lỗi."
        )
    else:
        verdict_detail = (
            f"{total_diff_count} vùng pixel khác — KHÔNG ĐẠT. "
            "So sánh theo pixel: mọi lệch hiển thị đều cần xử lý trước khi in."
        )

    job.result_summary = {
        "total_pages": total_pages,
        "pages_pass": pages_pass,
        "pages_fail": pages_fail,
        "pages_warning": pages_warning,
        "total_diff_count": total_diff_count,
        # Giữ average_similarity = SSIM visual (tương thích API/UI cũ).
        "average_similarity": round(avg_similarity, 2),
        "visual_similarity": round(avg_similarity, 2),
        "compare_method": "pixel",
        "print_verdict": "ĐẠT" if print_ok else "KHÔNG ĐẠT",
        "verdict_detail": verdict_detail,
        "total_instances": total_imposition_instances,
        "failed_instances": failed_imposition_instances,
        "overall_status": "PASS" if print_ok
                         else ("WARNING" if pages_fail == 0 and pages_warning > 0 else "FAIL"),
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
