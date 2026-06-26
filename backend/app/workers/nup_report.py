"""
nup_report.py — Report sản phẩm cho Bình Tem Bế (Product_Info).

Tách riêng phần LOGIC THUẦN (không phụ thuộc pikepdf/reportlab) để unit-test nhanh:
  - sanitize_filename : làm sạch tên file
  - remove_diacritics : bỏ dấu tiếng Việt
  - compute_report_data : tính sheetCount/actualQty + format các field text
  - build_report_string : nối các field thành chuỗi report

Phần VẼ report lên trang PDF (draw_report_on_page, cần reportlab + pikepdf) được
thêm ở Task 3 — đặt cuối file và import deps cục bộ để phần thuần vẫn test được.

Port mô hình từ script Illustrator: scripts/illustrator/1. dev - Nô lệ bình bài.jsx
(buildReportString / sanitizeFilename / removeDiacritics).
"""
import math
import re
import unicodedata
from typing import Any, Dict, List, Optional

# ── Hằng số dùng chung (đồng bộ với frontend types.ts) ──
DEFAULT_MATERIALS: List[str] = [
    "Decal PP",
    "Decal Đế vàng",
    "Decal Nhựa mờ",
    "Decal Nhựa trong",
    "Decal Bể (Tem vỡ)",
]

LAMINATION_OPTIONS: List[str] = ["Không cán", "Cán bóng", "Cán mờ"]

DEFAULT_FIELD_ORDER: List[str] = [
    "orderCode", "identifier", "gangCount", "labelName", "material", "lamination",
    "labelsPerSheet", "actualQty", "sheetCount", "dimensions", "paperSize",
    "cutFileRef", "modeLabel",
]

# Bảng dấu tiếng Việt → không dấu.
# Dùng unicodedata (NFD) cho phần lớn ký tự; riêng đ/Đ không phân rã được nên map tay.
_SPECIAL_MAP = {"đ": "d", "Đ": "D"}

# Ký tự không hợp lệ cho tên file Windows.
_ILLEGAL_FILENAME_RE = re.compile(r'[\\/:*?"<>|]')


def remove_diacritics(s: Optional[str]) -> str:
    """Bỏ dấu tiếng Việt; ký tự khác giữ nguyên.

    Dùng chuẩn hoá NFD rồi loại bỏ dấu kết hợp (combining marks); xử lý riêng đ/Đ.
    """
    if not s:
        return s or ""
    out = []
    for ch in s:
        if ch in _SPECIAL_MAP:
            out.append(_SPECIAL_MAP[ch])
            continue
        decomposed = unicodedata.normalize("NFD", ch)
        base = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
        out.append(base)
    return "".join(out)


def sanitize_filename(name: Optional[str]) -> str:
    """Thay các ký tự cấm trong tên file Windows bằng '-' và gộp khoảng trắng dư."""
    if not name:
        return ""
    cleaned = _ILLEGAL_FILENAME_RE.sub("-", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # Gộp '- -' hoặc '--' thành 1 dấu '-'
    cleaned = re.sub(r"\s*-\s*-\s*", " - ", cleaned)
    return cleaned.strip(" -")


def _format_lamination(lam_type: int, sides: int = 1) -> str:
    """0=Không cán → '' ; 1/2 → 'Cán bóng' / 'Cán mờ'.

    Số mặt CHỈ ghi khi cán 2 mặt ('Cán mờ 2 mặt'); 1 mặt là mặc định ngầm nên
    giữ gọn 'Cán mờ' (đúng thói quen bế tem + giữ tương thích test cũ).
    """
    try:
        lam_type = int(lam_type)
    except (TypeError, ValueError):
        return ""
    if lam_type <= 0 or lam_type >= len(LAMINATION_OPTIONS):
        return ""
    base = LAMINATION_OPTIONS[lam_type]
    try:
        sides = int(sides)
    except (TypeError, ValueError):
        sides = 1
    if sides >= 2:
        return f"{base} {sides} mặt"
    return base


def compute_report_data(
    *,
    label_name: str = "",
    width_mm: float = 0.0,
    height_mm: float = 0.0,
    paper_size: str = "",
    items_per_sheet: int = 0,
    requested_qty: int = 0,
    material: str = "",
    lamination_type: int = 0,
    lamination_sides: int = 1,
    cut_file_ref: str = "",
    mode_label: str = "",
    order_code: str = "",
    identifier: str = "",
    gang_count: int = 0,
    sheet_count_override: Optional[int] = None,
) -> Dict[str, Any]:
    """Tính số tờ + số lượng thực và format sẵn text từng field cho build_report_string.

    sheet_count = ceil(requested_qty / items_per_sheet) ; tối thiểu 1 nếu qty<=0.
    actual_qty  = sheet_count * items_per_sheet.
    sheet_count_override: dùng số tờ do engine tính sẵn (CNC tự tính), bỏ qua công thức.
    gang_count: số mẫu ghép chung 1 tờ (CNC dàn nhiều mẫu); 0 = không hiển thị.
    """
    ips = int(items_per_sheet or 0)
    qty = int(requested_qty or 0)

    if sheet_count_override is not None:
        sheet_count = max(0, int(sheet_count_override))
        actual_qty = sheet_count * ips
    elif ips <= 0:
        sheet_count = 0
        actual_qty = 0
    elif qty <= 0:
        sheet_count = 1            # để trống số lượng = in 1 tờ
        actual_qty = ips
    else:
        sheet_count = math.ceil(qty / ips)
        actual_qty = sheet_count * ips

    dims = ""
    if width_mm and height_mm:
        dims = f"{round(width_mm)} x {round(height_mm)} mm"

    return {
        "raw": {
            "items_per_sheet": ips,
            "sheet_count": sheet_count,
            "actual_qty": actual_qty,
            "requested_qty": qty,
        },
        # Các field đã format text (rỗng = sẽ bị build_report_string bỏ qua)
        "orderCode": order_code or "",
        "identifier": identifier or "",
        "gangCount": f"{int(gang_count)} mẫu" if gang_count and int(gang_count) > 0 else "",
        "labelName": label_name or "",
        "dimensions": dims,
        "paperSize": paper_size or "",
        "labelsPerSheet": f"SL/tờ: {ips}" if ips > 0 else "",
        "sheetCount": f"Số tờ: {sheet_count}" if sheet_count > 0 else "",
        "actualQty": f"SL thực: {actual_qty}" if actual_qty > 0 else "",
        "material": material or "",
        "lamination": _format_lamination(lamination_type, lamination_sides),
        "cutFileRef": cut_file_ref or "",
        "modeLabel": mode_label or "",
    }


def build_report_string(rd: Optional[Dict[str, Any]], data: Dict[str, Any]) -> str:
    """Nối các field được bật thành chuỗi report, ngăn bằng ' - '.

    rd (report display config): { fieldOrder: [...], show<Field>: bool,
                                  removeDiacritics: bool, customText: str }
    data: dict field text (từ compute_report_data).
    Quy tắc: orderCode luôn đứng đầu (nếu có); bỏ field rỗng; dọn '- -'.
    """
    rd = rd or {}
    field_order: List[str] = rd.get("fieldOrder") or DEFAULT_FIELD_ORDER

    # map key field → cờ hiển thị (mặc định True nếu thiếu cờ)
    show_flags = {
        "identifier": rd.get("showIdentifier", True),
        "gangCount": rd.get("showGangCount", True),
        "labelName": rd.get("showLabelName", True),
        "dimensions": rd.get("showDimensions", True),
        "paperSize": rd.get("showPaperSize", True),
        "labelsPerSheet": rd.get("showLabelsPerSheet", True),
        "sheetCount": rd.get("showSheetCount", True),
        "actualQty": rd.get("showActualQty", True),
        "material": rd.get("showMaterial", True),
        "lamination": rd.get("showLamination", True),
        "cutFileRef": rd.get("showCutFileRef", True),
        "modeLabel": rd.get("showModeLabel", True),
    }

    parts: List[str] = []

    # orderCode luôn ở đầu nếu có nội dung
    order_code = (data.get("orderCode") or "").strip()
    if order_code:
        parts.append(order_code)

    used = {"orderCode"}
    for key in field_order:
        if key in used:
            continue
        used.add(key)
        if not show_flags.get(key, True):
            continue
        content = (data.get(key) or "").strip()
        if content:
            parts.append(content)

    result = " - ".join(parts)

    custom = (rd.get("customText") or "").strip()
    if custom:
        result = f"{result} - {custom}" if result else custom

    # Dọn '- -' và dấu '-' thừa đầu/cuối
    result = re.sub(r"\s*-\s*-\s*", " - ", result).strip(" -")

    if rd.get("removeDiacritics"):
        result = remove_diacritics(result)
    return result


# ════════════════════════════════════════════════════════════════════════
#  Phần VẼ report lên PDF (cần reportlab + pikepdf) — import cục bộ để phần
#  thuần ở trên vẫn test được khi thiếu deps.
# ════════════════════════════════════════════════════════════════════════

import os
import logging

_logger = logging.getLogger(__name__)

MM_TO_PT = 2.83465
_FONT_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "fonts", "DejaVuSans.ttf")
_FONT_NAME = "ReportDejaVu"
_font_registered = False


def _ensure_font() -> str:
    """Đăng ký font Unicode (tiếng Việt) cho reportlab; fallback Helvetica nếu thiếu."""
    global _font_registered
    if _font_registered:
        return _FONT_NAME
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        if os.path.exists(_FONT_PATH):
            pdfmetrics.registerFont(TTFont(_FONT_NAME, _FONT_PATH))
            _font_registered = True
            return _FONT_NAME
    except Exception as e:
        _logger.warning("[REPORT] Không đăng ký được font DejaVu: %s — dùng Helvetica.", e)
    return "Helvetica"


def _build_overlay_pdf_bytes(report_str: str, page_w_pt: float, page_h_pt: float,
                             position: str, offset_x_mm: float, offset_y_mm: float,
                             font_size: float, centered: bool = True) -> bytes:
    """Tạo 1 trang PDF (cùng khổ) chứa text report ở vị trí yêu cầu, trả về bytes.

    centered=True: canh GIỮA theo trục của mép (trên/dưới → giữa ngang;
    trái/phải → giữa dọc). offset = khoảng cách từ mép đã chọn.
    """
    import io
    from reportlab.pdfgen import canvas

    font = _ensure_font()
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_w_pt, page_h_pt))
    c.setFont(font, font_size)
    c.setFillColorCMYK(0, 0, 0, 1)  # pure-K cho chữ báo cáo (không dùng RGB)

    off_x = offset_x_mm * MM_TO_PT
    off_y = offset_y_mm * MM_TO_PT

    if position == "bottom":
        if centered:
            c.drawCentredString(page_w_pt / 2.0, off_y, report_str)
        else:
            c.drawString(off_x, off_y, report_str)
    elif position == "left":
        c.saveState()
        if centered:
            c.translate(off_x, page_h_pt / 2.0); c.rotate(90); c.drawCentredString(0, 0, report_str)
        else:
            c.translate(off_x, off_y); c.rotate(90); c.drawString(0, 0, report_str)
        c.restoreState()
    elif position == "right":
        c.saveState()
        if centered:
            c.translate(page_w_pt - off_x, page_h_pt / 2.0); c.rotate(90); c.drawCentredString(0, 0, report_str)
        else:
            c.translate(page_w_pt - off_x, off_y); c.rotate(90); c.drawString(0, 0, report_str)
        c.restoreState()
    else:  # top (mặc định)
        if centered:
            c.drawCentredString(page_w_pt / 2.0, page_h_pt - off_y - font_size, report_str)
        else:
            c.drawString(off_x, page_h_pt - off_y - font_size, report_str)

    c.showPage()
    c.save()
    return buf.getvalue()


def stamp_reports_on_pdf(input_pdf: str, output_pdf: str, reports_by_page: Dict[int, str],
                         *, position: str = "top", offset_x_mm: float = 5.0,
                         offset_y_mm: float = 5.0, font_size: float = 8.0,
                         centered: bool = True) -> bool:
    """Stamp chuỗi report lên từng trang theo `reports_by_page` (page_index → str).

    Trả về True nếu thành công. Lỗi → log cảnh báo, copy nguyên file (không sập job).
    """
    try:
        import pikepdf
    except Exception as e:
        _logger.warning("[REPORT] pikepdf không khả dụng: %s", e)
        return False

    try:
        pdf = pikepdf.open(input_pdf, allow_overwriting_input=(os.path.abspath(input_pdf) == os.path.abspath(output_pdf)))
        for idx, page in enumerate(pdf.pages):
            report_str = reports_by_page.get(idx)
            if not report_str:
                continue
            try:
                mb = page.mediabox
                pw = float(mb[2]) - float(mb[0])
                ph = float(mb[3]) - float(mb[1])
                overlay_bytes = _build_overlay_pdf_bytes(
                    report_str, pw, ph, position, offset_x_mm, offset_y_mm, font_size, centered
                )
                overlay = pikepdf.open(io_bytes(overlay_bytes))
                page.add_overlay(overlay.pages[0])
            except Exception as e:
                _logger.warning("[REPORT] Vẽ report trang %d lỗi: %s", idx, e)
        pdf.save(output_pdf)
        pdf.close()
        return True
    except Exception as e:
        _logger.warning("[REPORT] stamp_reports_on_pdf lỗi: %s", e)
        return False


def io_bytes(data: bytes):
    """Helper nhỏ: bọc bytes thành BytesIO (tránh import io ở nhiều chỗ)."""
    import io
    return io.BytesIO(data)
