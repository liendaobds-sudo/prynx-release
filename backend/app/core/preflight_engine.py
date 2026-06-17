"""
Preflight Engine — Kiểm tra cấu trúc PDF chuẩn in ấn.

Inspired by Enfocus PitStop Preflight Profiles.
Uses pikepdf (QPDF) for structural Object Tree scanning
and pikepdf for content stream analysis.
"""
import logging
from pathlib import Path

import pikepdf

from app.core.preflight_models import PreflightIssue, PreflightReport, ALL_RULES
from app.core.preflight_rules.colors import ColorRulesMixin
from app.core.preflight_rules.fonts import FontRulesMixin
from app.core.preflight_rules.images import ImageRulesMixin
from app.core.preflight_rules.structure import StructureRulesMixin

logger = logging.getLogger(__name__)

# Re-export classes so that routes/preflight.py doesn't break
__all__ = ["PreflightEngine", "PreflightReport", "PreflightIssue"]


def _content_stream_worker(pdf_path: str, page_nums: list[int], active_rules: set):
    """Top-level worker function for ProcessPoolExecutor."""
    import pikepdf
    # Note: PreflightEngine must be imported locally to avoid circular imports if any, 
    # but here we are in the same module.
    
    issues = []
    stats = {
        "image_total": 0,
        "image_low_res": 0,
        "image_min_dpi": 9999,
        "has_rgb": False,
        "has_spot": False
    }
    
    try:
        doc = pikepdf.Pdf.open(pdf_path)
        doc._path = pdf_path  # Attach path for pdfplumber fallback
        engine = PreflightEngine()
        # Initialize stats on the engine instance
        engine._image_total = 0
        engine._image_low_res = 0
        engine._image_min_dpi = 9999
        engine._has_rgb = False
        engine._has_spot = False

        if "IMAGE_LOW_RES" in active_rules or "IMAGE_HIGH_DPI" in active_rules or "IMAGE_NOT_EMBEDDED" in active_rules or "COLOR_RGB_DETECTED" in active_rules or "COLOR_SPOT_DETECTED" in active_rules:
            issues += engine._check_image_resolution(doc, active_rules, page_nums)
            
        if "COLOR_RGB_DETECTED" in active_rules or "COLOR_SPOT_DETECTED" in active_rules:
            issues += engine._check_content_stream_colors(doc, active_rules, page_nums)

        if "OVERPRINT_DETECTED" in active_rules:
            issues += engine._check_overprint(doc, page_nums)

        if "TEXT_DETECTED" in active_rules:
            issues += engine._check_live_text(doc, page_nums)

        if "GIF_IN_PDF" in active_rules:
            issues += engine._check_gif_in_pdf(doc, page_nums)

        if "PROGRESSIVE_JPEG" in active_rules:
            issues += engine._check_progressive_jpeg(doc, page_nums)

        if "OBJECT_OFF_PAGE" in active_rules:
            issues += engine._check_objects_off_page(doc, page_nums)

        doc.close()
        
        stats["image_total"] = getattr(engine, "_image_total", 0)
        stats["image_low_res"] = getattr(engine, "_image_low_res", 0)
        stats["image_min_dpi"] = getattr(engine, "_image_min_dpi", 9999)
        stats["has_rgb"] = getattr(engine, "_has_rgb", False)
        stats["has_spot"] = getattr(engine, "_has_spot", False)
        
    except Exception as e:
        logger.error(f"Worker content-stream failed: {e}")
        issues.append(PreflightIssue(
            rule_id="INTERNAL_ERROR", severity="error", page=page_nums[0] if page_nums else None,
            object_ref="Hệ thống", description=f"Lỗi phân tích nội dung PDF ở chunk: {e}",
            auto_fixable=False,
        ))
        
    return issues, stats

class PreflightEngine(ColorRulesMixin, FontRulesMixin, ImageRulesMixin, StructureRulesMixin):
    """
    Runs preflight checks on a PDF file.
    
    Usage:
        engine = PreflightEngine()
        report = engine.run("input.pdf")
        # report.issues contains all detected issues
    """

    def run(self, pdf_path: str, rules: list[str] | None = None) -> PreflightReport:
        """
        Execute preflight checks on a PDF.
        
        Args:
            pdf_path: Path to the PDF file.
            rules: List of rule IDs to check. None = run all rules.
            
        Returns:
            PreflightReport with all detected issues.
        """
        active_rules = set(rules) if rules else set(ALL_RULES)
        issues: list[PreflightIssue] = []
        file_name = Path(pdf_path).name

        logger.info(f"Preflight: Starting inspection of '{file_name}' with rules: {active_rules}")

        # ── Phase A: pikepdf structural scan (fast, no rendering) ──
        try:
            with pikepdf.open(pdf_path) as pdf:
                total_pages = len(pdf.pages)

                if "FONT_NOT_EMBEDDED" in active_rules:
                    issues += self._check_fonts(pdf)

                if "COLOR_RGB_DETECTED" in active_rules or "COLOR_SPOT_DETECTED" in active_rules:
                    issues += self._check_page_colorspaces(pdf, active_rules)

                if "TRANSPARENCY_DETECTED" in active_rules:
                    issues += self._check_transparency(pdf)

                if "BLEED_MISSING" in active_rules:
                    issues += self._check_bleed_boxes(pdf)

                if "PAGE_SIZE_MISMATCH" in active_rules:
                    issues += self._check_page_sizes(pdf)

                if "PDF_VERSION_MISMATCH" in active_rules:
                    issues += self._check_pdf_version(pdf)

        except Exception as e:
            logger.error(f"Preflight pikepdf phase failed: {e}")
            issues.append(PreflightIssue(
                rule_id="INTERNAL_ERROR", severity="error", page=None,
                object_ref="Hệ thống", description=f"Lỗi phân tích cấu trúc PDF: {e}",
                auto_fixable=False,
            ))
            total_pages = 0

        # ── Phase B: pikepdf content stream scan (deeper) ──
        try:
            doc = pikepdf.Pdf.open(pdf_path)
            doc._path = pdf_path  # Needed by pdfplumber-based checks (live text, font bbox)

            if "IMAGE_NOT_EMBEDDED" in active_rules:
                issues += self._check_illustrator_hidden_links(doc)

            self._image_total = 0
            self._image_low_res = 0
            self._image_min_dpi = 9999
            if not hasattr(self, "_has_rgb"):
                self._has_rgb = False
                self._has_spot = False

            CHUNK_SIZE = 10
            if total_pages <= CHUNK_SIZE:
                # Sequential for small files
                if "IMAGE_LOW_RES" in active_rules or "IMAGE_HIGH_DPI" in active_rules or "IMAGE_NOT_EMBEDDED" in active_rules or "COLOR_RGB_DETECTED" in active_rules or "COLOR_SPOT_DETECTED" in active_rules:
                    issues += self._check_image_resolution(doc, active_rules)
                    
                if "COLOR_RGB_DETECTED" in active_rules or "COLOR_SPOT_DETECTED" in active_rules:
                    issues += self._check_content_stream_colors(doc, active_rules)

                if "OVERPRINT_DETECTED" in active_rules:
                    issues += self._check_overprint(doc)

                if "TEXT_DETECTED" in active_rules:
                    issues += self._check_live_text(doc)

                if "GIF_IN_PDF" in active_rules:
                    issues += self._check_gif_in_pdf(doc)

                if "PROGRESSIVE_JPEG" in active_rules:
                    issues += self._check_progressive_jpeg(doc)

                if "OBJECT_OFF_PAGE" in active_rules:
                    issues += self._check_objects_off_page(doc)
            else:
                # Multiprocessing for large files
                doc.close()
                doc = None

                from concurrent.futures import ProcessPoolExecutor
                import multiprocessing

                chunks = []
                for i in range(0, total_pages, CHUNK_SIZE):
                    chunks.append(list(range(i + 1, min(i + CHUNK_SIZE + 1, total_pages + 1))))
                
                # Leave 1 core free to keep UI responsive if possible
                max_workers = max(1, min(multiprocessing.cpu_count() - 1, len(chunks), 8))
                logger.info(f"Preflight: Using multiprocessing with {max_workers} workers for {len(chunks)} chunks.")

                with ProcessPoolExecutor(max_workers=max_workers) as executor:
                    futures = [executor.submit(_content_stream_worker, pdf_path, chunk, active_rules) for chunk in chunks]
                    
                    for future in futures:
                        chunk_issues, chunk_stats = future.result()
                        issues += chunk_issues
                        
                        self._image_total += chunk_stats.get("image_total", 0)
                        self._image_low_res += chunk_stats.get("image_low_res", 0)
                        self._image_min_dpi = min(self._image_min_dpi, chunk_stats.get("image_min_dpi", 9999))
                        if chunk_stats.get("has_rgb"):
                            self._has_rgb = True
                        if chunk_stats.get("has_spot"):
                            self._has_spot = True

            if "FONT_NOT_EMBEDDED" in active_rules:
                if doc is None:
                    doc = pikepdf.Pdf.open(pdf_path)
                    doc._path = pdf_path
                self._enrich_font_bboxes(doc, issues)

            if doc is not None:
                doc.close()
        except Exception as e:
            logger.error(f"Preflight content-stream phase failed: {e}")
            issues.append(PreflightIssue(
                rule_id="INTERNAL_ERROR", severity="error", page=None,
                object_ref="Hệ thống", description=f"Lỗi phân tích nội dung PDF: {e}",
                auto_fixable=False,
            ))

        report = self._compile_report(file_name, total_pages, issues)
        logger.info(
            f"Preflight: '{file_name}' — "
            f"{report.summary.get('errors', 0)} errors, "
            f"{report.summary.get('warnings', 0)} warnings, "
            f"{report.summary.get('info', 0)} info"
        )
        return report

    # ────────────────────────────────────────────────────────
    #  REPORT COMPILATION
    # ────────────────────────────────────────────────────────

    def _compile_report(
        self, file_name: str, total_pages: int, issues: list[PreflightIssue]
    ) -> PreflightReport:
        """Compile all issues into a structured report."""
        errors = sum(1 for i in issues if i.severity == "error")
        warnings = sum(1 for i in issues if i.severity == "warning")
        info = sum(1 for i in issues if i.severity == "info")

        return PreflightReport(
            file_name=file_name,
            total_pages=total_pages,
            issues=issues,
            summary={
                "errors": errors,
                "warnings": warnings,
                "info": info,
                "total": len(issues),
                "auto_fixable": sum(1 for i in issues if i.auto_fixable),
            },
            color_summary={
                "has_rgb": getattr(self, "_has_rgb", False),
                "has_cmyk": getattr(self, "_has_cmyk", False),
                "has_spot": getattr(self, "_has_spot", False),
            },
            font_summary={
                "total": getattr(self, "_font_total", 0),
                "embedded": getattr(self, "_font_total", 0) - getattr(self, "_font_not_embedded", 0),
                "not_embedded": getattr(self, "_font_not_embedded", 0),
            },
            image_summary={
                "total": getattr(self, "_image_total", 0),
                "low_res": getattr(self, "_image_low_res", 0),
                "min_dpi": round(getattr(self, "_image_min_dpi", 0)),
            },
        )
