"""
Module tự động quản lý và tải font chữ thiếu cho PrynX:
- Quản lý thư mục cache font cục bộ ~/.prynx/fonts
- Tự động tải font mở (Google Fonts) khi máy tính chưa cài đặt
- Cung cấp gợi ý font thay thế tương đồng tỉ lệ hình học (Smart Geometric Fallback)
"""
import os
import re
import logging
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

# Thư mục font người dùng của PrynX
def get_prynx_fonts_dir() -> str:
    base = os.path.expanduser("~")
    font_dir = os.path.join(base, ".prynx", "fonts")
    try:
        os.makedirs(font_dir, exist_ok=True)
    except Exception:
        pass
    return font_dir


# URL tải trực tiếp từ kho chính thức của Google Fonts (GitHub raw, sử dụng định dạng Variable Font hỗ trợ đầy đủ 100-900)
GOOGLE_FONTS_MAP = {
    # Montserrat (họ font geometric sans thông dụng nhất trong in ấn hiện đại, weight 100-900)
    "montserrat": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "montserratregular": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "montserratbold": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "montserratblack": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "montserratsemibold": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    "montserratmedium": "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
    

    # Be Vietnam Pro (Font chữ chuẩn tiếng Việt tối ưu in ấn)
    "bevietnampro": "https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-Regular.ttf",
    "bevietnamproregular": "https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-Regular.ttf",
    "bevietnamprobold": "https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-Bold.ttf",
    "bevietnamprosemibold": "https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-SemiBold.ttf",

    # Roboto (Variable width + weight)
    "roboto": "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",
    "robotoregular": "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",
    "robotobold": "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",
    "robotomedium": "https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf",

    # Inter (Variable opsz + weight)
    "inter": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    "interregular": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    "interbold": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",

    # Oswald (Font dạng cô đọng / Condensed thường dùng tiêu đề poster, vé)
    "oswald": "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf",
    "oswaldbold": "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/Oswald%5Bwght%5D.ttf",

    # Playfair Display (Serif sang trọng làm thiệp cưới, bằng khen - Variable weight)
    "playfairdisplay": "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf",
    "playfairdisplaybold": "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf",
}


def _is_font_family_matching(file_path: str, clean_name: str) -> bool:
    """Xác thực xem họ font bên trong file TTF/OTF có thật sự khớp với tên yêu cầu hay không."""
    try:
        from fontTools.ttLib import TTFont
        with TTFont(file_path, fontNumber=0, lazy=True) as tt:
            names = [
                rec.toUnicode().lower().replace("-", "").replace("_", "").replace(" ", "")
                for rec in tt.get('name', {}).names
                if rec.nameID in (1, 4, 6)
            ]
            for n in names:
                if clean_name in n or n in clean_name:
                    return True
            return False
    except Exception:
        return True


def download_google_font_if_available(font_name: str) -> Optional[str]:
    """
    Tự động tải font từ Google Fonts nếu chưa có trên máy.
    Trả về đường dẫn tuyệt đối file .ttf trong cache ~/.prynx/fonts/ hoặc None nếu không có / lỗi mạng.
    Có timeout 3.0s để không bao giờ làm treo máy khi offline.
    """
    if not font_name:
        return None

    clean = re.sub(r"^[A-Z]{6}\+", "", font_name).lower().replace("-", "").replace("_", "").replace(" ", "")
    font_dir = get_prynx_fonts_dir()

    # 1. Kiểm tra xem file đã được tải về trong ~/.prynx/fonts/ trước đó chưa
    for fname in os.listdir(font_dir):
        stem, ext = os.path.splitext(fname)
        if ext.lower() in (".ttf", ".otf"):
            if stem.lower().replace("-", "").replace("_", "") == clean:
                target_path = os.path.join(font_dir, fname)
                if os.path.getsize(target_path) > 1024:
                    if _is_font_family_matching(target_path, clean):
                        return target_path
                    else:
                        # File cache giả mạo / sai họ font (ví dụ montserrat trá hình gilroy) -> dọn dẹp
                        try:
                            os.remove(target_path)
                            logger.info("Đã xóa file font cache sai lệch họ font: %s", target_path)
                        except Exception:
                            pass

    # 2. Tìm URL trong bảng Google Fonts
    url = GOOGLE_FONTS_MAP.get(clean)
    if not url:
        # Thử tìm theo họ font (family)
        for k, u in GOOGLE_FONTS_MAP.items():
            if clean.startswith(k) or k.startswith(clean):
                url = u
                break

    if not url:
        return None

    safe_name = re.sub(r'[^\w-]', '_', font_name)
    filename = f"{safe_name}.ttf"
    dest_path = os.path.join(font_dir, filename)

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "PrynX-FontDownloader/2.0"}
        )
        with urllib.request.urlopen(req, timeout=3.5) as response:
            data = response.read()
            if len(data) > 1024:
                with open(dest_path, "wb") as f:
                    f.write(data)
                logger.info("Đã tải thành công font '%s' về '%s'", font_name, dest_path)
                return dest_path
    except Exception as exc:
        logger.debug("Không thể tự động tải font '%s': %s", font_name, exc)

    return None
