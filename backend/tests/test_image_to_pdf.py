"""Test cho endpoint POST /pdf-tools/image-to-pdf (Fast-Path PDFium)."""
import os
import tempfile
import pytest
from PIL import Image
import pypdfium2 as pdfium
from fastapi import HTTPException
from app.api.routes.pdf_tools import image_to_pdf


@pytest.mark.asyncio
async def test_image_to_pdf_rgba_with_dpi():
    """Ảnh PNG RGBA với 300 DPI -> PDF 1 trang 72x72 pt (1x1 inch)."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # Tạo ảnh PNG RGBA 300x300 với DPI = 300
        img = Image.new("RGBA", (300, 300), (255, 0, 0, 128))
        img.save(tmp_path, "PNG", dpi=(300, 300))

        data = await image_to_pdf(source_path=tmp_path)
        assert data["success"] is True
        assert os.path.exists(data["pdf_path"])
        assert abs(data["width_pt"] - 72.0) < 0.5
        assert abs(data["height_pt"] - 72.0) < 0.5
        assert data["dpi"] == [300.0, 300.0]

        # Mở lại PDF bằng pypdfium2 để kiểm tra nội dung
        pdf = pdfium.PdfDocument(data["pdf_path"])
        assert len(pdf) == 1
        page = pdf[0]
        assert abs(page.get_width() - 72.0) < 0.5
        pdf.close()

        # Dọn dẹp output PDF
        if os.path.exists(data["pdf_path"]):
            os.remove(data["pdf_path"])
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@pytest.mark.asyncio
async def test_image_to_pdf_jpg_no_dpi_fallback_72():
    """Ảnh JPG không có DPI -> fallback mặc định 72 DPI (1 px = 1 pt)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        img = Image.new("RGB", (200, 150), (0, 255, 0))
        img.save(tmp_path, "JPEG")

        data = await image_to_pdf(source_path=tmp_path)
        assert data["success"] is True
        assert os.path.exists(data["pdf_path"])
        assert abs(data["width_pt"] - 200.0) < 0.5
        assert abs(data["height_pt"] - 150.0) < 0.5
        assert data["dpi"] == [72.0, 72.0]

        if os.path.exists(data["pdf_path"]):
            os.remove(data["pdf_path"])
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@pytest.mark.asyncio
async def test_image_to_pdf_missing_file():
    """Không truyền path hoặc file -> 400 Bad Request."""
    with pytest.raises(HTTPException) as exc_info:
        await image_to_pdf(source_path=None, file=None)
    assert exc_info.value.status_code == 400

