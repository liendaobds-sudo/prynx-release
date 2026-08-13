import re

import pikepdf

import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)


def _normalize_font_token(name: str) -> str:
    """Strip subset prefix (ABCDEF+) and style suffix (-Bold)."""
    if not name:
        return ""
    token = name.strip()
    if "+" in token:
        token = token.split("+", 1)[1]
    return token.split("-")[0].lower()


def _extract_base_font_from_ref(object_ref: str) -> str:
    """Extract BaseFont from object_ref like 'Font /F1 (Helvetica-Bold)'."""
    m = re.search(r"\(([^)]+)\)", object_ref)
    return _normalize_font_token(m.group(1) if m else object_ref)


def _font_names_match(span_font: str, object_ref: str) -> bool:
    """Match pdfplumber fontname to PreflightIssue object_ref."""
    span = _normalize_font_token(span_font)
    ref = _extract_base_font_from_ref(object_ref)
    if not span or not ref:
        return False
    return span == ref


def _font_display_name(base_font: str) -> str:
    """Bỏ ký hiệu PDF và subset prefix khỏi tên font hiển thị."""
    token = (base_font or "").strip().lstrip("/")
    if "+" in token:
        prefix, remainder = token.split("+", 1)
        if len(prefix) == 6 and prefix.isalpha():
            token = remainder
    return token


def _font_identity(base_font: str) -> str:
    """Tạo khóa ổn định để gộp cùng một font qua nhiều trang.

    Chỉ bỏ subset prefix (``ABCDEF+``). Không bỏ hậu tố style vì Regular/Bold/
    Italic là các font face khác nhau và có thể có trạng thái nhúng khác nhau.
    """
    return _font_display_name(base_font).casefold()


class FontRulesMixin:
    def _check_fonts(self, pdf: pikepdf.Pdf, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check all fonts in the PDF for embedding status.

        Quét ĐỆ QUY qua Form XObject lồng + appearance stream annotation (không chỉ
        page-level Resources) và xử lý ĐÚNG font composite Type0: FontDescriptor +
        FontFile của Type0 nằm ở ``/DescendantFonts→CIDFont``, KHÔNG ở dict Type0.
        Đọc thẳng dict Type0 (code cũ) → luôn báo sai "chưa nhúng".
        """
        from app.core.preflight_rules.resource_walker import iter_fonts

        issues = []
        total_fonts = 0
        not_embedded = 0
        seen_fonts = set()
        unique_fonts: dict[str, dict] = {}

        page_count = len(pdf.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_idx in target_pages:
            page = pdf.pages[page_idx]
            page_num = page_idx + 1

            for font_name, font_obj in iter_fonts(page, pdf):
                base_font = str(font_obj.get("/BaseFont", font_name))
                identity = _font_identity(base_font) or str(font_name).casefold()
                # Các field cũ vẫn đếm occurrence theo BaseFont thô + trang để
                # không đổi hợp đồng của Preflight tổng quát. Hai subset object
                # cùng họ trên một trang vẫn phải được xét riêng: một object có
                # thể nhúng, object kia thiếu dữ liệu glyph.
                font_key = (base_font.casefold(), page_num)
                if font_key in seen_fonts:
                    continue
                seen_fonts.add(font_key)
                total_fonts += 1

                embedded = self._font_is_embedded(font_obj, pdf)
                unique = unique_fonts.setdefault(identity, {
                    "name": _font_display_name(base_font),
                    "embedded": True,
                    "pages": [],
                    "not_embedded_pages": [],
                    "occurrences": 0,
                })
                unique["embedded"] = bool(unique["embedded"] and embedded)
                unique["pages"].append(page_num)
                unique["occurrences"] += 1

                if embedded:
                    continue

                not_embedded += 1
                unique["not_embedded_pages"].append(page_num)
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
        # UIUX (audit 2026-08-13 §FONT.UI.1): tách font duy nhất khỏi lượt font
        # theo trang để UI không gọi một font dùng 100 trang là "100 font".
        self._font_unique = sorted(
            (
                {
                    **font,
                    "pages": sorted(set(font["pages"])),
                    "not_embedded_pages": sorted(set(font["not_embedded_pages"])),
                }
                for font in unique_fonts.values()
            ),
            key=lambda font: font["name"].casefold(),
        )
        return issues

    @staticmethod
    def _font_is_embedded(font_obj: pikepdf.Object, pdf: pikepdf.Pdf) -> bool:
        """Xác định một font đã nhúng chưa — xử lý cả simple font lẫn Type0/CID.

        - Type0 (composite): FontDescriptor/FontFile nằm trong ``/DescendantFonts``
          (mảng 1 phần tử là CIDFont). Phải descend vào đó mới thấy FontFile.
        - Base-14 Type1 (Helvetica, Times…): không có FontDescriptor và KHÔNG cần
          nhúng → coi như hợp lệ.
        - Type3: glyph định nghĩa bằng content stream (CharProcs), không có
          FontFile; luôn tự-chứa → coi như "nhúng" (không cảnh báo rớt font).
        """
        def _resolve(o):
            try:
                if hasattr(o, "resolve") and callable(getattr(o, "resolve", None)):
                    return o.resolve()
            except Exception:
                pass
            return o

        def _descriptor_has_file(font_dict) -> bool:
            desc = _resolve(font_dict.get("/FontDescriptor"))
            if not isinstance(desc, pikepdf.Dictionary):
                return False
            return any(
                desc.get(k) is not None for k in ("/FontFile", "/FontFile2", "/FontFile3")
            )

        subtype = str(font_obj.get("/Subtype", ""))

        # Type3: tự-chứa glyph trong CharProcs → không phải lỗi rớt font.
        if subtype == "/Type3":
            return True

        # Type0 composite → descend DescendantFonts → CIDFont.
        if subtype == "/Type0":
            desc_fonts = _resolve(font_obj.get("/DescendantFonts"))
            cid_fonts = []
            if isinstance(desc_fonts, pikepdf.Array):
                cid_fonts = [_resolve(f) for f in desc_fonts]
            elif isinstance(desc_fonts, pikepdf.Dictionary):
                cid_fonts = [desc_fonts]
            for cf in cid_fonts:
                if isinstance(cf, pikepdf.Dictionary) and _descriptor_has_file(cf):
                    return True
            return False

        # Simple font (Type1/TrueType/MMType1).
        if _descriptor_has_file(font_obj):
            return True
        # Không FontDescriptor: base-14 Type1 chuẩn không cần nhúng.
        desc = _resolve(font_obj.get("/FontDescriptor"))
        if desc is None and subtype == "/Type1":
            return True
        return False

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
                            if fi.bbox is None and _font_names_match(char_font, fi.object_ref):
                                fi.bbox = [char.get("x0", 0), char.get("top", 0),
                                           char.get("x1", 0), char.get("bottom", 0)]
                                break
        except Exception as e:
            logger.debug(f"Font bbox enrichment failed: {e}")
