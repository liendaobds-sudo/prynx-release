import pikepdf

import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

class FontRulesMixin:
    def _check_fonts(self, pdf: pikepdf.Pdf) -> list[PreflightIssue]:
        """Check all fonts in the PDF for embedding status."""
        issues = []
        total_fonts = 0
        not_embedded = 0
        seen_fonts = set()

        for page_num, page in enumerate(pdf.pages, 1):
            fonts = page.get("/Resources", {}).get("/Font", {})
            if not fonts:
                continue

            for font_name, font_ref in fonts.items():
                try:
                    font_obj = font_ref if isinstance(font_ref, pikepdf.Dictionary) else pdf.get_object(font_ref)
                except Exception:
                    continue

                base_font = str(font_obj.get("/BaseFont", font_name))
                font_key = f"{base_font}_{page_num}"
                if font_key in seen_fonts:
                    continue
                seen_fonts.add(font_key)
                total_fonts += 1

                # Check if font file is embedded
                desc = font_obj.get("/FontDescriptor")
                if desc is None:
                    # Type1 base 14 fonts don't need embedding
                    font_type = str(font_obj.get("/Subtype", ""))
                    if font_type == "/Type1":
                        continue
                    not_embedded += 1
                    issues.append(PreflightIssue(
                        rule_id="FONT_NOT_EMBEDDED",
                        severity="error",
                        page=page_num,
                        object_ref=f"Font {font_name} ({base_font})",
                        description=f"Font '{base_font}' chưa được nhúng (embedded). Có thể bị thay thế font khi in.",
                        auto_fixable=True,
                    ))
                    continue

                try:
                    desc_obj = desc if isinstance(desc, pikepdf.Dictionary) else pdf.get_object(desc)
                except Exception:
                    continue

                has_file = any(
                    desc_obj.get(key) is not None
                    for key in ["/FontFile", "/FontFile2", "/FontFile3"]
                )
                if not has_file:
                    not_embedded += 1
                    issues.append(PreflightIssue(
                        rule_id="FONT_NOT_EMBEDDED",
                        severity="error",
                        page=page_num,
                        object_ref=f"Font {font_name} ({base_font})",
                        description=f"Font '{base_font}' chưa được nhúng (embedded). Có thể bị thay thế font khi in.",
                        auto_fixable=True,
                    ))

        # Store counts for summary
        self._font_total = total_fonts
        self._font_not_embedded = not_embedded
        return issues

    def _enrich_font_bboxes(self, doc, issues: list[PreflightIssue], page_nums: list[int] = None):
        """Match text spans via pdfplumber to find bboxes for unembedded fonts."""
        target_pages_zero_indexed = set([p - 1 for p in page_nums]) if page_nums else None
        
        font_issues = [
            i for i in issues 
            if i.rule_id == "FONT_NOT_EMBEDDED" 
            and i.bbox is None 
            and i.page is not None
            and (target_pages_zero_indexed is None or (i.page - 1) in target_pages_zero_indexed)
        ]
        if not font_issues:
            return

        # Group by page
        page_issues = {}
        for fi in font_issues:
            page_issues.setdefault(fi.page - 1, []).append(fi)

        # Use pdfplumber for text extraction with font info
        try:
            import pdfplumber
            # If doc is pikepdf, we need the file path
            pdf_path = doc._path if hasattr(doc, '_path') else None
            if pdf_path is None:
                # Save to temp and reopen
                import tempfile, os
                tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
                doc.save(tmp.name)
                pdf_path = tmp.name

            with pdfplumber.open(pdf_path) as plumber:
                for page_num, p_issues in page_issues.items():
                    if page_num >= len(plumber.pages):
                        continue
                    page = plumber.pages[page_num]
                    chars = page.chars or []
                    for char in chars:
                        char_font = char.get("fontname", "")
                        for fi in p_issues:
                            if fi.bbox is None:
                                clean_name = char_font.split('-')[0].split('+')[-1]
                                if clean_name and clean_name.lower() in fi.object_ref.lower():
                                    fi.bbox = [char.get("x0", 0), char.get("top", 0),
                                               char.get("x1", 0), char.get("bottom", 0)]
                                    break
        except Exception as e:
            logger.debug(f"Font bbox enrichment failed: {e}")
