import logging
from fastapi import APIRouter, HTTPException, UploadFile, File, Depends
from pydantic import BaseModel
from typing import List
from app.core.llm_checker import LLMChecker
from app.utils.file_handler import save_upload_file
from app.core.pdf_processor import PDFProcessor
from app.core.ocr_engine import OCREngine
from app.core.license_guard import require_license
import cv2

logger = logging.getLogger(__name__)
router = APIRouter()

class TextQcRequest(BaseModel):
    text: str
    llm_mode: str
    api_key: str

class TextQcResponse(BaseModel):
    errors: List[str]

@router.post("/qc/check-text", response_model=TextQcResponse)
async def check_text(request: TextQcRequest, license_info: dict = Depends(require_license)):
    """
    Standalone endpoint for AI-based Proofreading / Content Validation.
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Văn bản không được để trống")

    if request.llm_mode == "off":
        return TextQcResponse(errors=["Tính năng AI đang tắt."])

    try:
        if request.llm_mode in ["gemini", "openai", "deepseek"]:
            if not request.api_key:
                raise HTTPException(status_code=400, detail="Thiếu API Key cho dịch vụ lưu trữ đám mây.")
            
            errors = LLMChecker.check_text_cloud(
                text=text,
                api_key=request.api_key,
                provider=request.llm_mode
            )
            return TextQcResponse(errors=errors)
            
        else:
            raise HTTPException(status_code=400, detail=f"Mô hình AI: {request.llm_mode} không hợp lệ.")
            
    except Exception as e:
        logger.exception("AI Check failed")
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")

class ExtractTextResponse(BaseModel):
    text: str

@router.post("/qc/extract-text", response_model=ExtractTextResponse)
async def extract_text(file: UploadFile = File(...), license_info: dict = Depends(require_license)):
    """
    Extracts readable, structured text from an uploaded PDF or Image file.
    
    For PDFs:
      1. Try pdfplumber (vector text) on ALL pages
      2. If text is empty or contains CID font errors → fallback to Tesseract OCR on ALL pages
    
    Text is grouped into lines/paragraphs (not flat-joined) for better LLM spell-checking.
    """
    filename = file.filename.lower()
    if not (filename.endswith(".pdf") or filename.endswith(".png") or filename.endswith(".jpg") or filename.endswith(".jpeg")):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file PDF hoặc hình ảnh (PNG/JPG).")

    try:
        stored_name, file_path, _ = await save_upload_file(file)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Lỗi hệ thống ({type(e).__name__})")

    try:
        extracted_text = ""
        
        if filename.endswith(".pdf"):
            processor = PDFProcessor()
            meta = processor.get_metadata(file_path)
            num_pages = meta.get("page_count", 0)
            
            # Step 1: Try pdfplumber vector extraction on ALL pages
            all_blocks = []
            for p in range(1, num_pages + 1):
                blocks = processor.extract_text_blocks(file_path, p)
                all_blocks.extend(blocks)
                
            # Use paragraph grouping instead of flat join
            raw_text = OCREngine.group_blocks_to_text(all_blocks)
            
            # Step 2: If PDF is rasterized or has CID font errors → OCR ALL pages
            if (len(raw_text.strip()) < 20 or "(cid:" in raw_text.lower()) and num_pages > 0:
                logger.info(f"PDF {filename} is rasterized or has CID font errors. OCR fallback on ALL {num_pages} pages.")
                
                page_texts = []
                for p in range(1, num_pages + 1):
                    img = processor.convert_single_page(file_path, p, dpi=300)
                    if img is None:
                        continue
                    try:
                        # preprocess=True enables denoise + adaptive threshold + deskew
                        ocr_blocks = OCREngine.extract_text_blocks(img, dpi=300, preprocess=False)
                        page_text = OCREngine.group_blocks_to_text(ocr_blocks)
                        if page_text.strip():
                            page_texts.append(f"--- Trang {p} ---\n{page_text}")
                    except Exception as page_err:
                        logger.warning(f"OCR failed on page {p}: {page_err}")
                        continue
                
                if page_texts:
                    raw_text = "\n\n".join(page_texts)
                else:
                    raise ValueError(
                        "File này bị mã hóa Font (lỗi cid) và OCR không thể nhận diện được mặt chữ trên bất kỳ trang nào. "
                        "Vui lòng Rasterize hoặc xuất file ảnh (PNG) thay vì PDF Vector."
                    )
                    
            extracted_text = raw_text
            
        else:
            # It's an image file (PNG/JPG)
            img = cv2.imread(file_path)
            if img is None:
                 raise ValueError("Không thể đọc file hình ảnh")
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            # preprocess=True for scanned/printed document images
            ocr_blocks = OCREngine.extract_text_blocks(img, dpi=300, preprocess=False)
            extracted_text = OCREngine.group_blocks_to_text(ocr_blocks)

        return ExtractTextResponse(text=extracted_text)

    except Exception as e:
        logger.exception("Text extraction failed")
        raise HTTPException(status_code=500, detail=f"Lỗi trích xuất ({type(e).__name__})")

