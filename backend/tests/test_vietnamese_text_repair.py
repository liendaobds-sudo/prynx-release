import pytest
from app.core.vietnamese_text_repair import repair_vietnamese_pdf_text
from app.core.font_downloader import get_prynx_fonts_dir, download_google_font_if_available


def test_repair_vietnamese_pdf_text_common_cmap_glitches():
    # 1. Glitch 'Địa Liểm' -> 'Địa điểm'
    assert repair_vietnamese_pdf_text("Địa Liểm") == "Địa điểm"
    assert repair_vietnamese_pdf_text("địa liểm") == "địa điểm"
    assert repair_vietnamese_pdf_text("Địa _iểm") == "Địa điểm"

    # 2. Glitch 'Liện thoại' -> 'Điện thoại'
    assert repair_vietnamese_pdf_text("Liện thoại") == "Điện thoại"
    assert repair_vietnamese_pdf_text("liện thoại") == "điện thoại"
    assert repair_vietnamese_pdf_text("_iện thoại") == "điện thoại"

    # 3. Glitch 'Liểm' -> 'Điểm'
    assert repair_vietnamese_pdf_text("Liểm danh") == "Điểm danh"
    assert repair_vietnamese_pdf_text("Địa Liểm Tổ Chức") == "Địa điểm Tổ Chức"

    # 4. Glitch 'Lại biểu' -> 'Đại biểu'
    assert repair_vietnamese_pdf_text("Lại biểu") == "Đại biểu"
    assert repair_vietnamese_pdf_text("Quý Lại biểu") == "Quý Đại biểu"

    # 5. Glitch 'Lồng chí' -> 'Đồng chí'
    assert repair_vietnamese_pdf_text("Lồng chí") == "Đồng chí"

    # 6. Glitch 'Lịa chỉ' -> 'Địa chỉ'
    assert repair_vietnamese_pdf_text("Lịa chỉ: Hà Nội") == "Địa chỉ: Hà Nội"

    # 7. Glitch 'Lơn vị' -> 'Đơn vị'
    assert repair_vietnamese_pdf_text("Lơn vị công tác") == "Đơn vị công tác"

    # 8. Glitch mã điều khiển Illustrator / Corel CMap subset font: \x1c, \x0e
    assert repair_vietnamese_pdf_text("Địa \x1ciểm") == "Địa điểm"
    assert repair_vietnamese_pdf_text("Giám \x1cốc") == "Giám đốc"
    assert repair_vietnamese_pdf_text("Số 20A \x0eường") == "Số 20A đường"
    assert repair_vietnamese_pdf_text("\x1cơn vị") == "đơn vị"
    assert repair_vietnamese_pdf_text("\x1cIỂM") == "ĐIỂM"
    assert repair_vietnamese_pdf_text("Hợp \x1cồng kinh tế") == "Hợp đồng kinh tế"


def test_repair_vietnamese_pdf_text_preserves_valid_words():
    # Các từ tiếng Việt / tiếng Anh hợp lệ bắt đầu bằng L KHÔNG được đổi thành Đ
    assert repair_vietnamese_pdf_text("Lãnh đạo") == "Lãnh đạo"
    assert repair_vietnamese_pdf_text("Liên hoan") == "Liên hoan"
    assert repair_vietnamese_pdf_text("Lịch trình") == "Lịch trình"
    assert repair_vietnamese_pdf_text("Location") == "Location"
    assert repair_vietnamese_pdf_text("Logo PrynX") == "Logo PrynX"
    assert repair_vietnamese_pdf_text("Lưu ý") == "Lưu ý"


def test_repair_vietnamese_pdf_text_null_and_empty():
    assert repair_vietnamese_pdf_text("") == ""
    assert repair_vietnamese_pdf_text(None) == ""


def test_font_downloader_cache_dir():
    d = get_prynx_fonts_dir()
    assert d is not None
    assert "fonts" in d


def test_font_downloader_offline_safe():
    # Khi tải font không có hoặc offline, hàm trả None một cách an toàn mà không throw exception
    res = download_google_font_if_available("NonExistentFont_12345")
    assert res is None
