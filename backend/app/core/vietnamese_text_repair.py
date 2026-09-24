"""
Module tự động phục hồi ký tự và từ ngữ tiếng Việt bị lỗi giải mã (CMap / ToUnicode corruption)
khi trích xuất văn bản từ file PDF (đặc biệt từ CorelDraw, Illustrator xuất subset font).
"""
import re
import unicodedata


# Các cụm từ hành chính, biểu mẫu, in ấn thông dụng thường xuyên bị lỗi CMap
PHRASE_REPLACEMENTS = [
    (re.compile(r"\b[ĐđDdLl_]ịa\s+[Ll_]i[eêếềểễệ]m\b", re.IGNORECASE), "Địa điểm"),
    (re.compile(r"\b[ĐđDdLl_]ịa\s+ch[iíìỉĩị]\b", re.IGNORECASE), "Địa chỉ"),
    (re.compile(r"\b[ĐđDdLl_]ịa\s+b[aàáảãạ]n\b", re.IGNORECASE), "Địa bàn"),
    (re.compile(r"\b[Ss]ố\s+[Ll_]i[eêếềểễệ]n\s+thoại\b", re.IGNORECASE), "Số điện thoại"),
    (re.compile(r"\b[Ll_]i[eêếềểễệ]n\s+thoại\b", re.IGNORECASE), "Điện thoại"),
    (re.compile(r"\b[Ll_]ơn\s+v[iíìỉĩị]\b", re.IGNORECASE), "Đơn vị"),
    (re.compile(r"\b[Ll_]ơn\s+gi[aàáảãạ]\b", re.IGNORECASE), "Đơn giá"),
    (re.compile(r"\b[Ll_]ại\s+di[eêếềểễệ]n\b", re.IGNORECASE), "Đại diện"),
    (re.compile(r"\b[Ll_]ại\s+h[oọ]c\b", re.IGNORECASE), "Đại học"),
    (re.compile(r"\b[Ll_]ại\s+bi[eêể]u\b", re.IGNORECASE), "Đại biểu"),
    (re.compile(r"\b[Ll_]ại\s+l[yýỳỷỹỵ]\b", re.IGNORECASE), "Đại lý"),
    (re.compile(r"\b[Hh]ợp\s+[Ll_]ồng\b", re.IGNORECASE), "Hợp đồng"),
    (re.compile(r"\b[Ll_]ồng\s+ch[ií]\b", re.IGNORECASE), "Đồng chí"),
    (re.compile(r"\b[Ll_]ồng\s+nai\b", re.IGNORECASE), "Đồng Nai"),
    (re.compile(r"\b[Hh]ải\s+[Pp]h[oòóỏõọ]ng\b", re.IGNORECASE), "Hải Phòng"),
    (re.compile(r"\b[ĐđDd]à\s+[Nn]ẵng\b", re.IGNORECASE), "Đà Nẵng"),
    (re.compile(r"\b[Hh]à\s+[Nn]ội\b", re.IGNORECASE), "Hà Nội"),
    (re.compile(r"\b[Qq]uyết\s+[Ll_]ịnh\b", re.IGNORECASE), "Quyết định"),
    (re.compile(r"\b[Qq]uy\s+[Ll_]ịnh\b", re.IGNORECASE), "Quy định"),
    (re.compile(r"\b[Xx]ác\s+[Ll_]ịnh\b", re.IGNORECASE), "Xác định"),
    (re.compile(r"\b[Hh]oạt\s+[Ll_]ộng\b", re.IGNORECASE), "Hoạt động"),
    (re.compile(r"\b[Tt]hành\s+[Ll_]ạt\b", re.IGNORECASE), "Thành đạt"),
    (re.compile(r"\b[Tt]hay\s+[Ll_]ổi\b", re.IGNORECASE), "Thay đổi"),
    (re.compile(r"\b[Bb]iến\s+[Ll_]ổi\b", re.IGNORECASE), "Biến đổi"),
    (re.compile(r"\b[Tt]hời\s+[Gg]ian\b", re.IGNORECASE), "Thời gian"),
    (re.compile(r"\b[Hh]ọ\s+v[aàá]\s+[Tt]ên\b", re.IGNORECASE), "Họ và tên"),
    (re.compile(r"\b[Nn]gày\s+sinh\b", re.IGNORECASE), "Ngày sinh"),
    (re.compile(r"\b[Nn]ơi\s+sinh\b", re.IGNORECASE), "Nơi sinh"),
    (re.compile(r"\b[Qq]uê\s+quán\b", re.IGNORECASE), "Quê quán"),
    (re.compile(r"\b[Cc]hức\s+vụ\b", re.IGNORECASE), "Chức vụ"),
    (re.compile(r"\b[Cc]hức\s+danh\b", re.IGNORECASE), "Chức danh"),
    (re.compile(r"\b[Gg]iấy\s+chứng\s+nhận\b", re.IGNORECASE), "Giấy chứng nhận"),
    (re.compile(r"\b[Gg]iấy\s+khen\b", re.IGNORECASE), "Giấy khen"),
    (re.compile(r"\b[Cc]hứng\s+chỉ\b", re.IGNORECASE), "Chứng chỉ"),
]


# Bảng toàn bộ nguyên âm tiếng Việt (kèm đầy đủ dấu thanh sắc, huyền, hỏi, ngã, nặng)
VIETNAMESE_VOWELS = "aàáảãạăằắẳẵặâầấẩẫậeèéẻẽẹêềếểễệiìíỉĩịoòóỏõọôồốổỗộơờớởỡợuùúủũụưừứửữựyỳýỷỹỵ"
VIETNAMESE_VOWELS_ALL = VIETNAMESE_VOWELS + VIETNAMESE_VOWELS.upper()


def _apply_case(matched_text: str, target: str) -> str:
    """Giữ nguyên cách viết hoa/thường của văn bản gốc."""
    if matched_text.isupper():
        return target.upper()
    if matched_text.islower():
        return target.lower()
    first_char = matched_text[0]
    if first_char == "_":
        return target
    if first_char.islower():
        return target[0].lower() + target[1:]
    return target


def repair_vietnamese_pdf_text(text: str) -> str:
    """
    Tự động chuẩn hóa và sửa chữa các lỗi giải mã ký tự tiếng Việt do CMap lỗi trong PDF.
    - Chuẩn hóa Unicode NFC.
    - Khôi phục chữ 'đ' / 'Đ' khi bị biến thành ký tự điều khiển non-printable (0x1C, 0x0E...) hoặc '_' trước nguyên âm.
    - Khôi phục chữ 'đ' / 'Đ' khi bị map nhầm thành 'L' / 'l' hoặc '_' trong từ ngữ tiếng Việt.
    """
    if not text:
        return ""

    # 1. Chuẩn hóa Unicode NFC và loại bỏ ký tự rác (null bytes, BOM)
    t = unicodedata.normalize("NFC", str(text))
    t = t.replace("\x00", "").replace("\ufeff", "")

    # 2. Khôi phục chữ 'đ' / 'Đ' từ các mã điều khiển non-printable (0x1C, 0x0E...) hoặc '_' đứng trước nguyên âm.
    # Trong tiếng Việt, 'đ' / 'Đ' là phụ âm duy nhất không thuộc bảng mã ASCII tiêu chuẩn (a-z, A-Z).
    # Mọi font subset từ Illustrator / Corel bị thiếu ToUnicode CMap đều gán chữ 'đ' vào các mã điều khiển 0x1C, 0x0E.
    def _repl_ctrl_d(m: re.Match) -> str:
        prefix = m.group(1)
        vowel = m.group(3)
        char_d = "Đ" if vowel.isupper() else "đ"
        return f"{prefix}{char_d}{vowel}"

    t = re.sub(
        r"(^|[\s\W])([\x01-\x08\x0b\x0c\x0e-\x1f_])([" + VIETNAMESE_VOWELS_ALL + r"])",
        _repl_ctrl_d,
        t,
    )

    # 3. Khớp theo danh mục cụm từ và từ ghép thông dụng (bảo toàn chữ hoa/thường)
    for pattern, replacement in PHRASE_REPLACEMENTS:
        if pattern.search(t):
            t = pattern.sub(lambda m, rep=replacement: _apply_case(m.group(0), rep), t)

    # 4. Quy tắc ngữ âm từ đơn:
    # Trong tiếng Việt, 'L' / 'l' không bao giờ đi trước vần 'iểm' (chỉ có 'điểm', không có 'liểm').
    t = re.sub(r"\bL([iíìỉĩị][eêếềểễệ]m)\b", r"Đ\1", t)
    t = re.sub(r"\bl([iíìỉĩị][eêếềểễệ]m)\b", r"đ\1", t)
    t = re.sub(r"\b_([iíìỉĩị][eêếềểễệ]m)\b", r"đ\1", t)

    # Chữ '_iểm' nằm giữa từ hoặc cụm từ
    t = re.sub(r"([ĐđDd]ịa\s+)[Ll_]i", r"\1đi", t)

    # Phục hồi dấu gạch dưới thay cho 'đ' / 'Đ' ở đầu từ
    t = re.sub(r"\b_([aăâeêioôơuưyAĂÂEÊIOÔƠUƯY])", r"đ\1", t)

    return t
