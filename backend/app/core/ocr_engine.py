import logging
import os
import cv2
import numpy as np
import pytesseract
from pytesseract import Output

# Auto-detect Tesseract on Windows
if os.name == 'nt':
    import sys
    from pathlib import Path
    # Check bundled tesseract first
    bundled_tess = Path(sys.executable).parent / "tesseract" / "tesseract.exe"
    if bundled_tess.is_file():
        pytesseract.pytesseract.tesseract_cmd = str(bundled_tess)
    else:
        tess_path = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
        if os.path.exists(tess_path):
            pytesseract.pytesseract.tesseract_cmd = tess_path

logger = logging.getLogger(__name__)


class OCREngine:
    """
    Wrapper for Tesseract OCR to extract text from rasterized/flattened PDF images.
    Serves as a fallback when pdfplumber fails to extract vector text blocks.
    """

    # ------------------------------------------------------------------ #
    #  Image preprocessing (denoise → adaptive threshold → deskew)
    # ------------------------------------------------------------------ #

    @staticmethod
    def _preprocess_for_ocr(gray: np.ndarray) -> np.ndarray:
        """
        Chuẩn hóa ảnh trước khi đưa vào Tesseract.

        Pipeline:
          1. fastNlMeansDenoising  — xóa nhiễu hạt mịn (offset / flexo print)
          2. adaptiveThreshold     — tách chữ khỏi nền gradient / màu
          3. deskew                — nắn thẳng nếu scan bị xoay nhẹ (> 0.5°)
        """
        # 1. Denoise
        denoised = cv2.fastNlMeansDenoising(
            gray, None, h=10, templateWindowSize=7, searchWindowSize=21
        )

        # 2. Adaptive threshold — xử lý tốt chữ trên nền không đều
        binary = cv2.adaptiveThreshold(
            denoised, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 31, 10,
        )

        # 3. Deskew — chỉ xoay nếu lệch > 0.5° để tránh nội suy thừa
        coords = np.column_stack(np.where(binary < 128))
        if len(coords) > 100:
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            if abs(angle) > 0.5:
                h, w = binary.shape
                M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
                binary = cv2.warpAffine(
                    binary, M, (w, h),
                    flags=cv2.INTER_CUBIC,
                    borderMode=cv2.BORDER_REPLICATE,
                )

        return binary

    # ------------------------------------------------------------------ #
    #  Core extraction — returns word-level blocks (backward compatible)
    # ------------------------------------------------------------------ #

    @staticmethod
    def extract_text_blocks(
        image: np.ndarray,
        dpi: int = 300,
        lang: str = "vie+eng",
        preprocess: bool = False,
    ) -> list[dict]:
        """
        Runs Tesseract OCR on a numpy image array and formats the output
        to match pdfplumber's block dictionary structure.

        Args:
            image: RGB numpy array
            dpi: Dots per inch the image was rendered at (defines coordinate scaling)
            lang: Tesseract language packs to use
            preprocess: If True, apply denoise + adaptive threshold + deskew
                        before OCR. Recommended for scanned/printed documents.
        """
        # Convert to grayscale for better contrast
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) if len(image.shape) == 3 else image

        if preprocess:
            gray = OCREngine._preprocess_for_ocr(gray)

        try:
            # Output.DICT gives us bounding boxes for every recognized word
            ocr_data = pytesseract.image_to_data(gray, lang=lang, output_type=Output.DICT)
        except Exception as e:
            logger.error(f"Tesseract OCR failed. Is tesseract installed in PATH? Error: {e}")
            return []

        blocks = []
        n_boxes = len(ocr_data['level'])

        # Scale factor from Pixels to PDF Points (pt)
        # 1 inch = 72 pt. Therefore: pt = px * (72.0 / DPI)
        scale = 72.0 / dpi

        for i in range(n_boxes):
            text = ocr_data['text'][i].strip()
            # Ignore empty strings or very low confidence predictions (< 40%)
            if text and int(ocr_data['conf'][i]) > 40:
                x = ocr_data['left'][i]
                y = ocr_data['top'][i]
                w = ocr_data['width'][i]
                h = ocr_data['height'][i]

                blocks.append({
                    "text": text,
                    "x0": x * scale,
                    "y0": y * scale,
                    "x1": (x + w) * scale,
                    "y1": (y + h) * scale,
                    "fontname": "OCR_Guessed_Font",
                    "size": h * scale,
                })

        logger.info(f"OCR extracted {len(blocks)} words.")
        return blocks

    # ------------------------------------------------------------------ #
    #  Make Searchable PDF — embed invisible text layer into scanned PDF
    # ------------------------------------------------------------------ #

    @staticmethod
    def make_searchable_pdf(
        input_path: str,
        output_path: str,
        lang: str = "vie+eng",
        dpi: int = 300,
        preprocess: bool = False,
        progress_callback=None,
    ) -> dict:
        """
        Converts a scanned/rasterized PDF into a searchable PDF by embedding
        an invisible text layer behind each page's visual content.

        Flow per page:
          1. Render page to image via pikepdf/pdfium at specified DPI
          2. Run Tesseract OCR to get word-level bounding boxes
          3. Insert each word as invisible text (render_mode=3) at the
             correct position on the original page

        Args:
            input_path:  Path to the source PDF
            output_path: Path to write the searchable PDF
            lang:        Tesseract language pack(s), e.g. "vie+eng"
            dpi:         Render resolution (higher = more accurate but slower)
            preprocess:  Apply denoise + threshold + deskew before OCR
            progress_callback: Optional fn(current_page, total_pages) for progress

        Returns:
            dict with keys: total_pages, pages_with_text, total_words
        """
        import pikepdf
        from app.workers.pdf_types import Point
        from app.workers.pdf_ops import get_pixmap, insert_text, page_height, page_width

        pdf = pikepdf.Pdf.open(input_path)
        total_pages = len(pdf.pages)
        total_words = 0
        pages_with_text = 0

        scale = dpi / 72.0  # px per pt

        for page_idx in range(total_pages):
            pike_page = pdf.pages[page_idx]

            # 1. Render page to image
            pix = get_pixmap(pike_page, input_path, page_idx, scale)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, 3
            )

            # 2. Run Tesseract OCR
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            if preprocess:
                gray = OCREngine._preprocess_for_ocr(gray)

            try:
                ocr_data = pytesseract.image_to_data(
                    gray, lang=lang, output_type=Output.DICT
                )
            except Exception as e:
                logger.warning(f"OCR failed on page {page_idx + 1}: {e}")
                if progress_callback:
                    progress_callback(page_idx + 1, total_pages)
                continue

            # 3. Insert invisible text at correct positions
            n_boxes = len(ocr_data["level"])
            page_word_count = 0

            for i in range(n_boxes):
                text = ocr_data["text"][i].strip()
                conf = int(ocr_data["conf"][i])

                if not text or conf < 30:
                    continue

                # Convert pixel coords → PDF points
                x_px = ocr_data["left"][i]
                y_px = ocr_data["top"][i]
                w_px = ocr_data["width"][i]
                h_px = ocr_data["height"][i]

                x0_pt = x_px / scale
                y0_pt = y_px / scale
                w_pt = w_px / scale
                h_pt = h_px / scale

                # Font size ≈ word height in points (capped to reasonable range)
                fontsize = max(4, min(h_pt * 0.85, 72))

                # Insert invisible text (render_mode=3 = invisible)
                try:
                    rc = insert_text(
                        pdf, pike_page,
                        point=Point(x0_pt, y0_pt + h_pt * 0.85),
                        text=text,
                        fontsize=fontsize,
                        fontname="helv",
                        render_mode=3,  # invisible
                    )
                    if rc >= 0:
                        page_word_count += 1
                except Exception:
                    pass  # skip words that fail (special chars, etc.)

            if page_word_count > 0:
                pages_with_text += 1
            total_words += page_word_count

            if progress_callback:
                progress_callback(page_idx + 1, total_pages)

            logger.info(
                f"Page {page_idx + 1}/{total_pages}: "
                f"inserted {page_word_count} invisible words"
            )

        pdf.save(output_path)
        pdf.close()

        return {
            "total_pages": total_pages,
            "pages_with_text": pages_with_text,
            "total_words": total_words,
        }

    # ------------------------------------------------------------------ #
    #  Paragraph grouping — reconstructs readable text from word blocks
    # ------------------------------------------------------------------ #

    @staticmethod
    def group_blocks_to_text(blocks: list[dict], line_tolerance_pt: float = 3.0) -> str:
        """
        Gộp word-level blocks thành văn bản có cấu trúc dòng/đoạn.

        Thay vì ' '.join() nối tất cả từ thành cháo, hàm này:
          1. Sort theo tọa độ Y (dòng) rồi X (vị trí trong dòng)
          2. Gộp các từ cùng dòng (y0 chênh lệch < tolerance)
          3. Tách đoạn khi khoảng cách Y giữa 2 dòng > 1.5x chiều cao dòng

        Args:
            blocks: List of word dicts with x0, y0, x1, y1, text keys
            line_tolerance_pt: Max Y-distance (in PDF points) to consider same line

        Returns:
            Structured text with newlines between lines and blank lines between paragraphs
        """
        if not blocks:
            return ""

        # Sort by Y (top-to-bottom) then X (left-to-right)
        sorted_blocks = sorted(blocks, key=lambda b: (round(b["y0"] / line_tolerance_pt), b["x0"]))

        # --- Pass 1: Group words into lines ---
        lines: list[dict] = []   # Each: {"y0": float, "y1": float, "text": str}
        current_words = [sorted_blocks[0]]
        current_y = sorted_blocks[0]["y0"]

        for b in sorted_blocks[1:]:
            if abs(b["y0"] - current_y) <= line_tolerance_pt:
                # Same line
                current_words.append(b)
            else:
                # Flush current line
                line_text = " ".join(w["text"] for w in current_words)
                line_y0 = min(w["y0"] for w in current_words)
                line_y1 = max(w["y1"] for w in current_words)
                lines.append({"y0": line_y0, "y1": line_y1, "text": line_text})
                # Start new line
                current_words = [b]
                current_y = b["y0"]

        # Flush last line
        if current_words:
            line_text = " ".join(w["text"] for w in current_words)
            line_y0 = min(w["y0"] for w in current_words)
            line_y1 = max(w["y1"] for w in current_words)
            lines.append({"y0": line_y0, "y1": line_y1, "text": line_text})

        if not lines:
            return ""

        # --- Pass 2: Group lines into paragraphs ---
        # Estimate average line height for paragraph gap detection
        line_heights = [ln["y1"] - ln["y0"] for ln in lines if ln["y1"] > ln["y0"]]
        avg_line_h = sum(line_heights) / len(line_heights) if line_heights else 12.0
        para_gap = avg_line_h * 1.5  # Gap > 1.5x line height = new paragraph

        result_parts = [lines[0]["text"]]
        for i in range(1, len(lines)):
            gap = lines[i]["y0"] - lines[i - 1]["y1"]
            if gap > para_gap:
                result_parts.append("")  # Blank line = paragraph break
            result_parts.append(lines[i]["text"])

        return "\n".join(result_parts)
