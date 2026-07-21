import pikepdf

import logging
from app.core.preflight_models import PreflightIssue

logger = logging.getLogger(__name__)

class StructureRulesMixin:
    def _check_live_text(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check if any page contains live text that hasn't been outlined."""
        issues = []
        try:
            import pdfplumber
            pdf_path = doc._path if hasattr(doc, '_path') else None
            if pdf_path is None:
                return issues
            target_page_set = set([p - 1 for p in page_nums]) if page_nums else None
            with pdfplumber.open(pdf_path) as plumber:
                for page_idx, page in enumerate(plumber.pages):
                    if target_page_set and page_idx not in target_page_set:
                        continue
                    chars = page.chars or []
                    if chars:
                        # Group into bboxes
                        page_bboxes = []
                        for c in chars[:50]:  # Sample first 50 chars for bbox
                            page_bboxes.append([c.get('x0',0), c.get('top',0), c.get('x1',0), c.get('bottom',0)])
                        issues.append(PreflightIssue(
                            rule_id="TEXT_DETECTED",
                            severity="warning",
                            page=page_idx + 1,
                            object_ref=f"Live Text ({len(chars)} chars)",
                            description="Phát hiện trang có chứa Text sống (Chưa Outline). Dù đã nhúng font nhưng nên Khóa Font để an toàn 100%.",
                            auto_fixable=True,
                            bbox=page_bboxes[0] if page_bboxes else None,
                            bboxes=page_bboxes[:20]
                        ))
        except Exception as e:
            logger.debug(f"Live text check failed: {e}")
        return issues

    def _check_transparency(self, pdf: pikepdf.Pdf, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Phát hiện MỌI dạng trong suốt cần flatten trước khi xuất kẽm CTP.

        Code cũ chỉ kiểm ``page/Group`` (transparency group mức trang) → bỏ sót dạng
        phổ biến nhất: SMask (soft-mask) và blend-mode/alpha (``/CA``,``/ca`` < 1)
        trong ExtGState, cùng transparency group lồng trong Form XObject. Nay:
          - Quét ExtGState ở MỌI resource (đệ quy Form XObject + annotation AP).
          - Bắt ``/SMask`` ≠ /None, ``/BM`` ≠ /Normal|/Compatible, ``/CA``/``/ca`` < 1.
          - Bắt Form XObject có ``/Group /S /Transparency`` (group lồng).
          - Vẫn bắt page-level Group như cũ.
        Mỗi trang chỉ báo MỘT issue (gộp lý do) để tránh spam.
        """
        from app.core.preflight_rules.resource_walker import iter_resource_dicts

        def _resolve(o):
            try:
                if hasattr(o, "resolve") and callable(getattr(o, "resolve", None)):
                    return o.resolve()
            except Exception:
                pass
            return o

        def _is_transparency_group(obj) -> bool:
            grp = _resolve(obj.get("/Group")) if hasattr(obj, "get") else None
            if isinstance(grp, pikepdf.Dictionary):
                return str(grp.get("/S", "")) == "/Transparency"
            return False

        issues = []
        page_count = len(pdf.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_idx in target_pages:
            page = pdf.pages[page_idx]
            page_num = page_idx + 1
            reasons: set[str] = set()

            # 1) Page-level transparency group (hành vi cũ).
            try:
                if _is_transparency_group(page):
                    reasons.add("transparency group (trang)")
            except Exception:
                pass

            # 2) ExtGState + Form XObject group ở MỌI resource (đệ quy).
            try:
                for res in iter_resource_dicts(page, pdf):
                    # 2a) ExtGState: SMask / blend mode / alpha < 1.
                    egs = _resolve(res.get("/ExtGState"))
                    if isinstance(egs, pikepdf.Dictionary):
                        for _n, gs_ref in egs.items():
                            gs = _resolve(gs_ref)
                            if not isinstance(gs, pikepdf.Dictionary):
                                continue
                            smask = gs.get("/SMask")
                            if smask is not None and str(smask) != "/None":
                                reasons.add("soft mask (SMask)")
                            bm = gs.get("/BM")
                            if bm is not None:
                                bm_s = str(bm)
                                if bm_s not in ("/Normal", "/Compatible", ""):
                                    reasons.add(f"blend mode {bm_s}")
                            for alpha_key, label in (("/CA", "alpha nét"), ("/ca", "alpha tô")):
                                av = gs.get(alpha_key)
                                if av is not None:
                                    try:
                                        if float(av) < 1.0:
                                            reasons.add(f"{label} < 100%")
                                    except (TypeError, ValueError):
                                        pass
                    # 2b) Form XObject có transparency group riêng.
                    xobjs = _resolve(res.get("/XObject"))
                    if isinstance(xobjs, pikepdf.Dictionary):
                        for _n, xref in xobjs.items():
                            xo = _resolve(xref)
                            if isinstance(xo, (pikepdf.Stream, pikepdf.Dictionary)):
                                try:
                                    if str(xo.get("/Subtype", "")) == "/Form" and _is_transparency_group(xo):
                                        reasons.add("transparency group (XObject)")
                                except Exception:
                                    pass
            except Exception:
                pass

            if reasons:
                detail = ", ".join(sorted(reasons))
                issues.append(PreflightIssue(
                    rule_id="TRANSPARENCY_DETECTED",
                    severity="warning",
                    page=page_num,
                    object_ref="Transparency",
                    description=(
                        f"Trang {page_num} chứa trong suốt ({detail}). "
                        "Cần Flatten trước khi xuất kẽm CTP."
                    ),
                    auto_fixable=True,
                ))
        return issues

    def _check_bleed_boxes(self, pdf: pikepdf.Pdf, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check if TrimBox and BleedBox are properly set."""
        issues = []
        page_count = len(pdf.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_idx in target_pages:
            page = pdf.pages[page_idx]
            page_num = page_idx + 1
            media_box = page.get("/MediaBox")
            trim_box = page.get("/TrimBox")
            bleed_box = page.get("/BleedBox")

            if trim_box is None:
                issues.append(PreflightIssue(
                    rule_id="BLEED_MISSING",
                    severity="warning",
                    page=page_num,
                    object_ref="Page Boxes",
                    description=f"Trang {page_num} thiếu TrimBox. Máy CTP không biết đường cắt xén.",
                    auto_fixable=False,
                ))
            elif bleed_box is None and media_box is not None and trim_box is not None:
                try:
                    media = [float(x) for x in media_box]
                    trim = [float(x) for x in trim_box]
                    # So khớp float chính xác (media == trim) BỎ SÓT trường hợp lệch
                    # <1pt — vẫn là "không có bleed thật" (bleed in ấn thường ≥3mm ≈
                    # 8.5pt mỗi cạnh). Coi là thiếu bleed nếu mọi cạnh lệch ≤ dung sai.
                    EPS = 1.0  # pt
                    if all(abs(media[i] - trim[i]) <= EPS for i in range(4)):
                        issues.append(PreflightIssue(
                            rule_id="BLEED_MISSING",
                            severity="info",
                            page=page_num,
                            object_ref="Page Boxes",
                            description=f"Trang {page_num}: MediaBox ≈ TrimBox, không có vùng tràn lề (bleed).",
                            auto_fixable=False,
                        ))
                except Exception:
                    pass
        return issues

    def _check_page_sizes(self, pdf: pikepdf.Pdf, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check if all pages have consistent dimensions."""
        issues = []
        sizes = []

        page_count = len(pdf.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_idx in target_pages:
            page = pdf.pages[page_idx]
            page_num = page_idx + 1
            # page.mediabox: pikepdf tự phân giải MediaBox KẾ THỪA từ /Pages cha
            # (page.get("/MediaBox") trả None nếu box chỉ khai ở cây cha → bỏ sót).
            try:
                media_box = page.mediabox
            except Exception:
                media_box = page.get("/MediaBox")
            if media_box:
                try:
                    w = round(float(media_box[2]) - float(media_box[0]), 1)
                    h = round(float(media_box[3]) - float(media_box[1]), 1)
                    # /Rotate 90/270 hoán đổi chiều hiển thị → so W/H theo khổ ĐÃ xoay,
                    # nếu không trang xoay 90° báo lệch khổ sai (false positive).
                    try:
                        rot = int(page.get("/Rotate", 0) or 0) % 360
                    except Exception:
                        rot = 0
                    if rot in (90, 270):
                        w, h = h, w
                    sizes.append((page_num, w, h))
                except Exception:
                    pass

        if len(sizes) < 2:
            return issues

        ref_w, ref_h = sizes[0][1], sizes[0][2]
        for page_num, w, h in sizes[1:]:
            if abs(w - ref_w) > 1 or abs(h - ref_h) > 1:
                w_mm = round(w * 25.4 / 72, 1)
                h_mm = round(h * 25.4 / 72, 1)
                ref_w_mm = round(ref_w * 25.4 / 72, 1)
                ref_h_mm = round(ref_h * 25.4 / 72, 1)
                issues.append(PreflightIssue(
                    rule_id="PAGE_SIZE_MISMATCH",
                    severity="warning",
                    page=page_num,
                    object_ref="MediaBox",
                    description=(
                        f"Trang {page_num} có kích thước {w_mm}×{h_mm}mm, "
                        f"khác với trang 1 ({ref_w_mm}×{ref_h_mm}mm)."
                    ),
                    auto_fixable=False,
                ))

        return issues

    def _check_overprint(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Check for Overprint settings in page ExtGState resources.

        Reads the resolved /ExtGState dictionaries and inspects the /OP (fill)
        and /op (stroke) overprint flags. Avoids matching against the pikepdf
        repr string, which uses Python syntax and hides indirect objects.
        """
        issues = []
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            try:
                resources = page.get("/Resources")
                if not resources:
                    continue
                extgstates = resources.get("/ExtGState")
                if not extgstates:
                    continue

                overprint_on = False
                for _name, gs_ref in extgstates.items():
                    try:
                        gs = gs_ref
                        if hasattr(gs_ref, "resolve") and callable(getattr(gs_ref, "resolve", None)):
                            gs = gs_ref.resolve()
                        for key in ("/OP", "/op"):
                            val = gs.get(key)
                            if val is not None and bool(val):
                                overprint_on = True
                                break
                        if overprint_on:
                            break
                    except Exception:
                        continue

                if overprint_on:
                    issues.append(PreflightIssue(
                        rule_id="OVERPRINT_DETECTED",
                        severity="info",
                        page=page_num + 1,
                        object_ref="ExtGState",
                        description=f"Trang {page_num + 1} có Overprint bật. Kiểm tra xem có đúng ý đồ thiết kế không.",
                        auto_fixable=False,
                    ))
            except Exception:
                pass
        return issues

    def _check_objects_off_page(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Detect objects (text, image, vector) lying completely outside the page area.

        Uses pdfplumber (consistent coordinate system between page.bbox and object
        bboxes: top-left origin, x in [x0,x1], top in [top,bottom]). An object is
        flagged only if it is ENTIRELY outside the page rectangle by more than EPS,
        so normal bleed objects that overlap the edge are not reported.
        """
        issues = []
        EPS = 0.5  # pt tolerance to ignore objects merely touching the edge

        pdf_path = getattr(doc, "_path", None)
        if pdf_path is None:
            # Fallback: validate page-box dimensions only (cannot enumerate objects)
            return self._check_page_box_validity(doc, page_nums)

        target_page_set = set([p - 1 for p in page_nums]) if page_nums else None
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as plumber:
                for page_idx, page in enumerate(plumber.pages):
                    if target_page_set is not None and page_idx not in target_page_set:
                        continue

                    px0, ptop, px1, pbottom = page.bbox  # page rect in pdfplumber coords

                    # Invalid page box → report and skip object scan for this page
                    if (px1 - px0) <= 0 or (pbottom - ptop) <= 0:
                        issues.append(PreflightIssue(
                            rule_id="OBJECT_OFF_PAGE",
                            severity="warning",
                            page=page_idx + 1,
                            object_ref="Page Box",
                            description=f"Trang {page_idx + 1} có kích thước hộp trang không hợp lệ.",
                            auto_fixable=False,
                        ))
                        continue

                    off_bboxes = []
                    object_groups = (
                        (page.chars or []),
                        (page.images or []),
                        (page.rects or []),
                        (page.lines or []),
                        (page.curves or []),
                    )
                    for group in object_groups:
                        for o in group:
                            try:
                                ox0 = float(o.get("x0", 0))
                                ox1 = float(o.get("x1", 0))
                                otop = float(o.get("top", 0))
                                obottom = float(o.get("bottom", 0))
                            except (TypeError, ValueError):
                                continue
                            # Completely outside on any side
                            if (ox1 <= px0 + EPS or ox0 >= px1 - EPS
                                    or obottom <= ptop + EPS or otop >= pbottom - EPS):
                                off_bboxes.append([ox0, otop, ox1, obottom])

                    if off_bboxes:
                        issues.append(PreflightIssue(
                            rule_id="OBJECT_OFF_PAGE",
                            severity="warning",
                            page=page_idx + 1,
                            object_ref=f"{len(off_bboxes)} đối tượng ngoài trang",
                            description=(
                                f"Trang {page_idx + 1} có {len(off_bboxes)} đối tượng nằm hoàn toàn "
                                f"ngoài vùng in. Nên xóa để tránh lỗi RIP và giảm dung lượng."
                            ),
                            auto_fixable=False,
                            bbox=off_bboxes[0],
                            bboxes=off_bboxes[:50],
                        ))
        except Exception as e:
            logger.debug(f"Off-page object check failed: {e}")
        return issues

    def _check_page_box_validity(self, doc, page_nums: list[int] = None) -> list[PreflightIssue]:
        """Fallback check: verify page boxes have valid (positive) dimensions."""
        issues = []
        page_count = len(doc.pages)
        target_pages = [p - 1 for p in page_nums] if page_nums else range(page_count)
        for page_num in target_pages:
            page = doc.pages[page_num]
            try:
                mb = page.get("/MediaBox") or page.get("/CropBox")
                tb = page.get("/TrimBox")
                if tb:
                    page_rect = [float(x) for x in tb]
                elif mb:
                    page_rect = [float(x) for x in mb]
                else:
                    continue
                pw = page_rect[2] - page_rect[0]
                ph = page_rect[3] - page_rect[1]
                if pw <= 0 or ph <= 0:
                    issues.append(PreflightIssue(
                        rule_id="OBJECT_OFF_PAGE",
                        severity="warning",
                        page=page_num + 1,
                        object_ref="Page Box",
                        description=f"Trang {page_num + 1} có kích thước không hợp lệ ({pw:.1f} x {ph:.1f} pt).",
                        auto_fixable=False,
                    ))
            except Exception:
                pass
        return issues

    def _check_pdf_version(self, pdf: pikepdf.Pdf) -> list[PreflightIssue]:
        """Check PDF version compatibility with prepress standards."""
        issues = []
        try:
            version_str = pdf.pdf_version
            major, minor = version_str.split('.')
            version_num = float(version_str)

            # PDF/X-1a requires PDF 1.3 or 1.4
            # PDF/X-4 requires PDF 1.4 - 1.6
            # PDF 2.0 may not be supported by older RIPs
            if version_num > 1.7:
                issues.append(PreflightIssue(
                    rule_id="PDF_VERSION_MISMATCH",
                    severity="warning",
                    page=None,
                    object_ref=f"PDF {version_str}",
                    description=(
                        f"File sử dụng PDF {version_str}. Phiên bản này có thể không tương thích "
                        f"với một số hệ thống RIP cũ. Khuyên dùng PDF 1.4 - 1.7 cho in ấn."
                    ),
                    auto_fixable=False,
                ))
            elif version_num < 1.3:
                issues.append(PreflightIssue(
                    rule_id="PDF_VERSION_MISMATCH",
                    severity="info",
                    page=None,
                    object_ref=f"PDF {version_str}",
                    description=(
                        f"File sử dụng PDF {version_str} (quá cũ). "
                        f"Có thể thiếu hỗ trợ transparency, ICC profile. Nên nâng lên PDF 1.4+."
                    ),
                    auto_fixable=False,
                ))
        except Exception:
            pass
        return issues
