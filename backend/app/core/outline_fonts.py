"""
Outline-fonts hardening helpers.

Ghostscript ``-dNoOutputFonts`` chỉ outline text nằm trong content stream của
trang. Nó BỎ SÓT:
  - Text trong Annotation / AcroForm field (appearance stream riêng, không nằm
    trong luồng vẽ trang) → phải FLATTEN vào content trước khi outline.
  - Font KHÔNG nhúng → GS mượn font hệ thống thay thế, dễ SAI mặt chữ / RƠI ký
    tự (đặc biệt tiếng Việt có dấu). Cần cảnh báo hoặc embed trước.

Module này cung cấp:
  - ``flatten_annotations_and_forms`` : bake annotation + form field vào content
    stream trang (pypdfium2 ``FPDFPage_Flatten`` sau ``init_forms``).
  - ``count_live_text``               : đếm ký tự text sống còn sót (content
    stream + annotation) để VERIFY sau khi outline.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Annotation subtype KHÔNG mang chữ, GS hay giữ lại → BỎ QUA khi verify. Dùng
# blacklist (Link/Popup) thay vì whitelist Widget/FreeText/Text: pdfium đọc
# subtype của một số widget ra UNKNOWN(0), whitelist sẽ BỎ SÓT widget thật (false
# negative — tệ hơn false positive vì user tưởng đã outline sạch). Định nghĩa lười
# (module-load) qua pypdfium2.raw để tránh import vòng.
_NON_TEXT_ANNOT_SUBTYPES: frozenset[int] = frozenset()


def _init_non_text_annot_subtypes() -> frozenset[int]:
    global _NON_TEXT_ANNOT_SUBTYPES
    if _NON_TEXT_ANNOT_SUBTYPES:
        return _NON_TEXT_ANNOT_SUBTYPES
    import pypdfium2.raw as pdfium_c

    _NON_TEXT_ANNOT_SUBTYPES = frozenset({
        pdfium_c.FPDF_ANNOT_LINK,
        pdfium_c.FPDF_ANNOT_POPUP,
    })
    return _NON_TEXT_ANNOT_SUBTYPES


def flatten_annotations_and_forms(input_path: str, output_path: str) -> int:
    """Bake mọi annotation + AcroForm field vào content stream của từng trang.

    Trả về số trang được flatten thành công (rc == FLATTEN_SUCCESS). Text nằm
    trong appearance stream của annotation/form (mà GS ``-dNoOutputFonts`` không
    đụng tới) sau bước này sẽ nằm trong content stream trang → outline được.

    ``init_forms`` được gọi trước để form field có appearance stream chuẩn (giá
    trị người dùng nhập) trước khi flatten; nếu file không có form thì bỏ qua.
    """
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    from app.core.pdfium_lock import pdfium_guard

    # KIENTRUC (audit 2026-07-29 §C.1): flatten + GenerateContent + save là PDFium GHI dữ
    # liệu, chạy trong threadpool qua action_engine → phải serialize. Bao cả hàm vì mọi
    # bước đều là lời gọi PDFium (không có phần tính toán nào để tách ra ngoài khóa).
    with pdfium_guard("outline_flatten_annots"):
        return _flatten_annotations_and_forms_locked(input_path, output_path, pdfium, pdfium_c)


def _flatten_annotations_and_forms_locked(input_path, output_path, pdfium, pdfium_c) -> int:
    pdf = pdfium.PdfDocument(input_path)
    flattened = 0
    try:
        # init_forms: nạp form-fill environment để form field render đúng giá trị
        # trước khi flatten. Bọc try vì file không-form vẫn phải flatten annotation.
        try:
            if pdf.get_formtype() != pdfium_c.FORMTYPE_NONE:
                pdf.init_forms()
        except Exception as e:
            logger.debug("init_forms skipped: %s", e)

        for i in range(len(pdf)):
            page = pdf[i]
            try:
                # FLAT_PRINT: flatten theo ngữ cảnh IN (lấy appearance dành cho in,
                # gồm cả annotation chỉ-in). rc: 0=fail 1=success 2=nothing-to-do.
                rc = pdfium_c.FPDFPage_Flatten(page.raw, pdfium_c.FLAT_PRINT)
                if rc == pdfium_c.FLATTEN_SUCCESS:
                    flattened += 1
                    pdfium_c.FPDFPage_GenerateContent(page.raw)
            except Exception as e:
                logger.debug("Flatten page %d failed: %s", i, e)
            finally:
                page.close()

        pdf.save(output_path)
    finally:
        pdf.close()

    logger.info("flatten_annotations_and_forms: %d trang flatten -> %s", flattened, output_path)
    return flattened


def count_live_text(pdf_path: str) -> dict:
    """Đếm text sống còn sót sau outline: content stream + annotation.

    Trả về ``{"content_chars": int, "annot_text_pages": list[int], "total": int}``.
    ``content_chars`` đọc qua pdfium ``get_textpage`` (chính xác luồng vẽ trang,
    KHÔNG lệ thuộc pdfplumber). ``annot_text_pages`` liệt kê trang còn annotation
    mang text (widget/freetext…) — dùng để cảnh báo phần GS không outline được.
    """
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    from app.core.pdfium_lock import pdfium_guard

    # KIENTRUC (audit 2026-07-29 §C.1): hậu kiểm outline chạy qua `asyncio.to_thread`
    # trong action_engine. Toàn thân là đọc textpage/annotation bằng PDFium nên bao cả
    # hàm; dùng wrapper để không phải thụt lề lại thân hàm dài.
    with pdfium_guard("outline_count_live_text"):
        return _count_live_text_locked(pdf_path, pdfium, pdfium_c)


def _count_live_text_locked(pdf_path: str, pdfium, pdfium_c) -> dict:
    non_text_subtypes = _init_non_text_annot_subtypes()
    content_chars = 0
    annot_text_pages: list[int] = []

    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            try:
                textpage = page.get_textpage()
                try:
                    content_chars += textpage.count_chars()
                finally:
                    textpage.close()

                # Annotation còn sót có thể mang chữ (form field / chú thích) mà
                # GS không outline. Tính MỌI annotation TRỪ Link/Popup (không mang
                # chữ). Dùng blacklist vì pdfium đọc subtype vài widget ra UNKNOWN
                # → whitelist sẽ bỏ sót widget thật (false negative nguy hiểm hơn).
                try:
                    n_annots = pdfium_c.FPDFPage_GetAnnotCount(page.raw)
                    for a_idx in range(n_annots or 0):
                        annot = pdfium_c.FPDFPage_GetAnnot(page.raw, a_idx)
                        if not annot:
                            continue
                        try:
                            subtype = pdfium_c.FPDFAnnot_GetSubtype(annot)
                            if subtype not in non_text_subtypes:
                                annot_text_pages.append(i + 1)
                                break
                        finally:
                            pdfium_c.FPDFPage_CloseAnnot(annot)
                except Exception:
                    pass
            finally:
                page.close()
    finally:
        pdf.close()

    return {
        "content_chars": content_chars,
        "annot_text_pages": annot_text_pages,
        "total": content_chars + len(annot_text_pages),
    }


def detect_unembedded_fonts(pdf_path: str) -> list[str]:
    """Liệt kê BaseFont của các font CHƯA nhúng (không có FontFile/2/3).

    Font chưa nhúng là rủi ro lớn nhất khi outline: GS ``-dNoOutputFonts`` phải
    mượn font hệ thống thay thế → dễ SAI mặt chữ hoặc RƠI ký tự (đặc biệt tiếng
    Việt có dấu / CJK). Dùng kết quả này để CẢNH BÁO người dùng trước khi outline.

    Base-14 Type1 (Helvetica, Times…) không cần nhúng nên bỏ qua.
    """
    import pikepdf

    from app.core.preflight_rules.resource_walker import iter_fonts

    base14 = {
        "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
        "Helvetica", "Helvetica-Bold", "Helvetica-Oblique",
        "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic",
        "Times-BoldItalic", "Symbol", "ZapfDingbats",
    }
    unembedded: set[str] = set()
    try:
        pdf = pikepdf.Pdf.open(pdf_path)
    except Exception as e:
        logger.debug("detect_unembedded_fonts open failed: %s", e)
        raise RuntimeError(f"không mở được PDF để kiểm tra font: {e}") from e

    try:
        # OUT-FONT (audit 2026-07-27 §4.3): font thường nằm trong Form XObject
        # hoặc appearance stream của annotation, không chỉ /Resources trang.
        for page in pdf.pages:
            for font_name, font_obj in iter_fonts(page, pdf):
                base_font = str(font_obj.get("/BaseFont", font_name))
                subtype = str(font_obj.get("/Subtype", ""))

                # Type3 tự chứa glyph trong CharProcs; không mượn font hệ thống.
                if subtype == "/Type3":
                    continue

                # Type0 (composite): font THẬT nằm trong /DescendantFonts.
                descendants = font_obj.get("/DescendantFonts")
                targets: list = []
                if descendants is not None:
                    try:
                        for d in descendants:
                            targets.append(d if isinstance(d, pikepdf.Dictionary) else pdf.get_object(d))
                    except Exception:
                        targets = [font_obj]
                else:
                    targets = [font_obj]

                embedded = False
                saw_descriptor = False
                for tgt in targets:
                    desc = tgt.get("/FontDescriptor")
                    if desc is None:
                        continue
                    saw_descriptor = True
                    try:
                        desc_obj = desc if isinstance(desc, pikepdf.Dictionary) else pdf.get_object(desc)
                    except Exception:
                        continue
                    if any(desc_obj.get(k) is not None for k in ("/FontFile", "/FontFile2", "/FontFile3")):
                        embedded = True
                        break

                if not saw_descriptor:
                    # Chỉ đúng 14 font chuẩn mới được miễn nhúng. Type1 tuỳ ý
                    # không FontDescriptor vẫn có thể bị RIP thay thế.
                    normalized = base_font.lstrip("/")
                    if "+" in normalized:
                        normalized = normalized.split("+", 1)[1]
                    if subtype == "/Type1" and normalized in base14:
                        continue
                    unembedded.add(base_font)
                elif not embedded:
                    unembedded.add(base_font)
    finally:
        pdf.close()

    return sorted(unembedded)
