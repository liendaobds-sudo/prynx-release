import logging
import os
from pathlib import Path
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image as RLImage
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics

from app.database import get_db
from app.models.job import ComparisonJob, UploadedFile
from app.config import settings
from app.core.license_guard import require_license

logger = logging.getLogger(__name__)
router = APIRouter()


def _safe_watermark(pdf_path: str, license_info: dict | None) -> None:
    """Nhúng stealth watermark (XMP + invisible text) vào PDF report xuất ra.

    Non-blocking: mọi lỗi đều nuốt (report vẫn tải được). Bỏ qua khi không có
    thông tin license (dev mode / thiếu credential). Đồng nhất với _safe_watermark
    ở pdf_tools.py / edit.py để forensics phủ CẢ report phát hành ra ngoài.
    """
    try:
        if not license_info:
            return
        lk = license_info.get("license_key", "")
        hwid = license_info.get("hwid", "")
        if not lk or lk == "DEV_MODE":
            return
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
    except Exception as e:  # noqa: BLE001 - watermark không bao giờ chặn luồng report
        logger.error(f"Report watermark failed: {e}")

# Try to register a Unicode font for Vietnamese text in PDF reports.
# Priority: Bundled DejaVuSans (cross-platform) → Windows Arial → Helvetica (no Vietnamese)
_FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "fonts")
try:
    _bundled_regular = os.path.join(_FONT_DIR, "DejaVuSans.ttf")
    _bundled_bold = os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf")

    if os.path.exists(_bundled_regular) and os.path.exists(_bundled_bold):
        pdfmetrics.registerFont(TTFont('DejaVuSans', _bundled_regular))
        pdfmetrics.registerFont(TTFont('DejaVuSans-Bold', _bundled_bold))
        DEFAULT_FONT = 'DejaVuSans'
        BOLD_FONT = 'DejaVuSans-Bold'
    elif os.path.exists("C:/Windows/Fonts/arial.ttf"):
        pdfmetrics.registerFont(TTFont('Arial', 'C:/Windows/Fonts/arial.ttf'))
        pdfmetrics.registerFont(TTFont('Arial-Bold', 'C:/Windows/Fonts/arialbd.ttf'))
        DEFAULT_FONT = 'Arial'
        BOLD_FONT = 'Arial-Bold'
    else:
        DEFAULT_FONT = 'Helvetica'
        BOLD_FONT = 'Helvetica-Bold'
        logger.warning("No Unicode font found. Vietnamese characters will be stripped in PDF reports.")
except Exception as e:
    logger.warning(f"Failed to load fonts, using Helvetica fallback: {e}")
    DEFAULT_FONT = 'Helvetica'
    BOLD_FONT = 'Helvetica-Bold'

# Create a custom style sheet with the Unicode font
def get_custom_styles():
    styles = getSampleStyleSheet()
    
    styles.add(ParagraphStyle(
        name='CustomTitle',
        parent=styles['Heading1'],
        fontName=BOLD_FONT,
        fontSize=18,
        spaceAfter=12,
        textColor=colors.HexColor('#1e40af')
    ))
    
    styles.add(ParagraphStyle(
        name='CustomNormal',
        parent=styles['Normal'],
        fontName=DEFAULT_FONT,
        fontSize=11,
        spaceBefore=6,
        spaceAfter=6
    ))
    
    styles.add(ParagraphStyle(
        name='CustomBold',
        parent=styles['Normal'],
        fontName=BOLD_FONT,
        fontSize=11,
        spaceBefore=6,
        spaceAfter=6
    ))
    return styles

def safe_text(text: str) -> str:
    """Ensure text renders even if font lacks unicode by stripping or replacing if necessary, though Arial handles it."""
    if not text:
        return ""
    if DEFAULT_FONT == 'Helvetica':
        import unicodedata
        # Strip accents for Helvetica
        return ''.join(c for c in unicodedata.normalize('NFD', text) if unicodedata.category(c) != 'Mn')
    return text

@router.get("/jobs/{job_id}/report")
def download_pdf_report(job_id: str, db: Session = Depends(get_db), license_info: dict = Depends(require_license)):
    """Generate and download a PDF report for a completed comparison job."""
    job = db.query(ComparisonJob).filter(ComparisonJob.id == job_id).first()
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Report not ready (job not completed)")
        
    results_dir = Path(settings.RESULTS_DIR)
    results_dir.mkdir(parents=True, exist_ok=True)
    report_path = results_dir / f"{job_id}_report.pdf"
    
    if not report_path.exists():
        _generate_pdf_report(job, str(report_path))
        # Đóng dấu bản quyền (stealth) lên report MỚI sinh — report là PDF có thể
        # phát hành ra ngoài nên cần forensics như các output khác. Chỉ watermark
        # khi tạo mới (bản cache đã được đóng dấu từ lần tạo đầu).
        _safe_watermark(str(report_path), license_info)
        
    return FileResponse(
        path=report_path,
        media_type="application/pdf",
        filename=f"PDF_Compare_Report_{job_id[:8]}.pdf"
    )

def _generate_pdf_report(job: ComparisonJob, output_path: str):
    """Internal function to build the PDF document using ReportLab Platypus."""
    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        rightMargin=40,
        leftMargin=40,
        topMargin=40,
        bottomMargin=40
    )
    
    styles = get_custom_styles()
    story = []
    
    # ── 1. HEADER ──
    story.append(Paragraph(safe_text("BÁO CÁO KIỂM TRA BẢN IN (PDF COMPARE)"), styles['CustomTitle']))
    
    report_date = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    story.append(Paragraph(safe_text(f"Ngày tạo: {report_date}"), styles['CustomNormal']))
    story.append(Paragraph(safe_text(f"Mã kiểm tra (Job ID): {job.id}"), styles['CustomNormal']))
    story.append(Spacer(1, 0.2 * inch))
    
    # ── 2. METADATA TABLE ──
    file_a = job.file_a
    file_b = job.file_b
    
    metadata_data = [
        [Paragraph(safe_text("Tệp Gốc (File A):"), styles['CustomBold']), Paragraph(safe_text(file_a.original_name if file_a else "N/A"), styles['CustomNormal'])],
        [Paragraph(safe_text("Tệp Đã Sửa (File B):"), styles['CustomBold']), Paragraph(safe_text(file_b.original_name if file_b else "N/A"), styles['CustomNormal'])],
        [Paragraph(safe_text("Số trang (A / B):"), styles['CustomBold']), Paragraph(safe_text(f"{file_a.page_count if file_a else 0} / {file_b.page_count if file_b else 0}"), styles['CustomNormal'])],
        [Paragraph(safe_text("Chế độ Config:"), styles['CustomBold']), Paragraph(safe_text(str(job.config.get('comparison_mode', 'Auto'))), styles['CustomNormal'])],
    ]
    
    metadata_table = Table(metadata_data, colWidths=[2 * inch, 4 * inch])
    metadata_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f3f4f6')),
        ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#1f2937')),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('INNERGRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#e5e7eb')),
        ('BOX', (0, 0), (-1, -1), 0.25, colors.HexColor('#d1d5db')),
    ]))
    
    story.append(metadata_table)
    story.append(Spacer(1, 0.3 * inch))
    
    # ── 3. RESULTS SUMMARY ──
    story.append(Paragraph(safe_text("TỔNG QUAN KẾT QUẢ"), styles['CustomTitle']))
    
    summary = job.result_summary or {}
    total_diff_count = summary.get("total_diff_count", 0)
    avg_similarity = summary.get("visual_similarity", summary.get("average_similarity", 100.0))
    print_verdict = summary.get("print_verdict") or ("ĐẠT" if total_diff_count == 0 else "KHÔNG ĐẠT")
    verdict_detail = summary.get("verdict_detail") or (
        "Không phát hiện khác biệt — ĐẠT kiểm in."
        if total_diff_count == 0
        else f"{total_diff_count} điểm khác biệt — KHÔNG ĐẠT (in ấn: sai 1 chữ cũng là lỗi)."
    )
    total_instances = summary.get("total_instances", 0)
    failed_instances = summary.get("failed_instances", 0)
    
    is_imposition = summary.get("is_imposition_mode", False) or total_instances > 0
    
    # In ấn: chấm theo SỐ LỖI + ĐẠT/KHÔNG ĐẠT. SSIM chỉ tham khảo (không xanh vì 99%).
    results_data = [
        [Paragraph(safe_text("Kết luận in ấn:"), styles['CustomBold']), Paragraph(safe_text(print_verdict), styles['CustomNormal'])],
        [Paragraph(safe_text("Số lỗi / điểm khác biệt:"), styles['CustomBold']), Paragraph(safe_text(f"{total_diff_count}"), styles['CustomNormal'])],
        [Paragraph(safe_text("Chi tiết:"), styles['CustomBold']), Paragraph(safe_text(verdict_detail), styles['CustomNormal'])],
        [Paragraph(safe_text("Độ giống hình — tham khảo (SSIM):"), styles['CustomBold']), Paragraph(safe_text(f"{avg_similarity:.2f}%"), styles['CustomNormal'])],
    ]
    
    if is_imposition:
        results_data.append([Paragraph(safe_text("Phân tích Bình bài (Imposition):"), styles['CustomBold']), Paragraph(safe_text(f"Tổng số bản sao: {total_instances}"), styles['CustomNormal'])])
        results_data.append([Paragraph(safe_text("Số bản sao bị lỗi:"), styles['CustomBold']), Paragraph(safe_text(f"{failed_instances} nhãn"), styles['CustomNormal'])])
        
    results_table = Table(results_data, colWidths=[3 * inch, 3 * inch])
    results_table.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 0.5, colors.HexColor('#9ca3af')),
        ('INNERGRID', (0,0), (-1,-1), 0.25, colors.lightgrey),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BACKGROUND', (1, 0), (1, 0), colors.HexColor('#dcfce7') if total_diff_count == 0 else colors.HexColor('#fee2e2')),
        ('BACKGROUND', (1, 1), (1, 1), colors.HexColor('#dcfce7') if total_diff_count == 0 else colors.HexColor('#fee2e2')),
    ]))
    
    story.append(results_table)
    story.append(Spacer(1, 0.4 * inch))
    
    # ── 4. THÔNG TIN CHI TIẾT TỪNG TRANG ──
    story.append(Paragraph(safe_text("CHI TIẾT LỖI TỪNG TRANG"), styles['CustomTitle']))
    
    page_results = job.page_results
    if not page_results:
        story.append(Paragraph(safe_text("Không có dữ liệu chi tiết trang."), styles['CustomNormal']))
    else:
        for pr in page_results:
            status_text = "ĐẠT" if pr.diff_count == 0 else "KHÔNG ĐẠT"
            
            p_header = (
                f"Trang {pr.page_number} — {status_text} — Số lỗi: {pr.diff_count}"
                f" — Giống hình (tham khảo): {pr.similarity_score:.2f}%"
            )
            story.append(Paragraph(safe_text(p_header), styles['CustomBold']))
            
            # Print regions if any
            if pr.diff_regions:
                # Top 5 biggest diffs
                regions = pr.diff_regions[:5]
                region_text = "Các lỗi lớn nhất (Top 5):<br/>"
                for i, r in enumerate(regions):
                    desc = r.get('description', '')
                    region_text += f"- [{r.get('x')}, {r.get('y')} | {r.get('width')}x{r.get('height')}] {desc}<br/>"
                
                story.append(Paragraph(safe_text(region_text), styles['CustomNormal']))
            
            story.append(Spacer(1, 0.1 * inch))
            
            # Embed Highlight Image
            if pr.highlighted_image_path:
                # highlighted_image_path is a relative URL like "/results/jobid/page_1_diff.png"
                # Convert to actual filesystem path
                img_filename = os.path.basename(pr.highlighted_image_path)
                actual_path = os.path.join(settings.RESULTS_DIR, str(job.id), img_filename)
                if os.path.exists(actual_path):
                    try:
                        img = RLImage(actual_path, width=4*inch, height=4*inch, kind='proportional')
                        story.append(img)
                    except Exception as e:
                        logger.warning(f"Could not load image for report: {e}")
                    
            story.append(Spacer(1, 0.3 * inch))

    # Build PDF Document
    doc.build(story)
