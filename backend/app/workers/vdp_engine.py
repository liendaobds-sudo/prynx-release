import os
import glob
import io
import re
import math
import uuid
import logging
import datetime
import tempfile
from xml.sax.saxutils import escape as xml_escape

from app.workers import pdf_wrapper as pdf_lib
from app.workers.vdp_gs1 import (
    parse_gs1, build_gs1_payload, human_readable, GS1Error, FNC1,
)
from app.workers.vdp_conditions import resolve_field_content, ConditionError
from app.core.pdfium_lock import pdfium_guard
from app.core.disk_space_guard import ensure_job_disk_space, estimate_vdp_disk
from app.core.system_memory import plan_worker_count
from app.schemas.vdp import VdpField
from typing import List, Dict

from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color, CMYKColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

logger = logging.getLogger(__name__)


class VdpCancelledError(RuntimeError):
    """Raised when a VDP job observes its cooperative cancellation signal."""


def _vdp_cancel_file_exists(cancel_file: str | None) -> bool:
    return bool(cancel_file and os.path.exists(cancel_file))


MM_TO_PTS = 2.83465
# Hằng số quy đổi toạ độ frontend (CSS px @96dpi) → point backend, dùng CHUNG cho
# mọi loại field (text/image/QR/barcode 1D/2D) để bảo toàn parity preview ↔ output.
CSS_TO_PT_FACTOR = 72.0 / 96.0  # = 0.75

def hex_to_rgb(hex_str: str) -> tuple:
    hex_str = (hex_str or '#000000').lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join(c + c for c in hex_str)
    return tuple(int(hex_str[i:i+2], 16)/255.0 for i in (0, 2, 4))


def hex_to_cmyk(hex_str: str) -> tuple:
    """HEX → (c, m, y, k) 0..1. Khớp công thức frontend hexToCmyk để round-trip:
    đen K100 người dùng chọn (#000000) → (0,0,0,1) pure-K, KHÔNG thành rich black."""
    r, g, b = hex_to_rgb(hex_str)
    k = 1 - max(r, g, b)
    if k >= 1.0 - 1e-9:
        return (0.0, 0.0, 0.0, 1.0)
    c = (1 - r - k) / (1 - k)
    m = (1 - g - k) / (1 - k)
    y = (1 - b - k) / (1 - k)
    return (c, m, y, k)


def cmyk_color(hex_str: str) -> CMYKColor:
    return CMYKColor(*hex_to_cmyk(hex_str))


# ─── #7 Font thật (Bold/Italic) thay vì faux ────────────────────────────────
# Tìm file font anh em (Bold/Italic/BoldItalic) cùng thư mục với font Regular,
# theo các quy ước đặt tên phổ biến. Trả dict {variant: registered_font_name}.
_FONT_VARIANT_RULES = {
    'bold':       [('regular', 'bold'), ('-regular', '-bold'), ('', 'bd'), ('', '-bold'), ('', 'b')],
    'italic':     [('regular', 'italic'), ('-regular', '-italic'), ('', 'i'), ('', '-italic'), ('', 'it')],
    'bolditalic': [('regular', 'bolditalic'), ('-regular', '-bolditalic'), ('', 'bi'),
                   ('', '-bolditalic'), ('regular', 'boldoblique'), ('', 'z')],
}


def _find_variant_file(regular_path: str, variant: str):
    """Suy ra đường dẫn file font biến thể từ file Regular. Trả path nếu tồn tại."""
    d = os.path.dirname(regular_path)
    fn = os.path.basename(regular_path)
    stem, ext = os.path.splitext(fn)
    low = stem.lower()
    for old, new in _FONT_VARIANT_RULES.get(variant, []):
        if old and old in low:
            cand_stem = low.replace(old, new)
        elif not old:
            cand_stem = low + new
        else:
            continue
        # thử giữ nguyên ext, duyệt không phân biệt hoa thường trong thư mục
        try:
            for f in os.listdir(d):
                fs, fe = os.path.splitext(f)
                if fs.lower() == cand_stem and fe.lower() in ('.ttf', '.otf'):
                    return os.path.join(d, f)
        except Exception:
            pass
    return None


def _register_font_family(regular_path: str, base_name: str) -> dict:
    """Đăng ký Regular + mọi biến thể tìm được. Trả {variant: font_name}."""
    variants = {}
    try:
        pdfmetrics.registerFont(TTFont(base_name, regular_path))
        variants['regular'] = base_name
    except Exception:
        return variants
    for variant in ('bold', 'italic', 'bolditalic'):
        vp = _find_variant_file(regular_path, variant)
        if vp:
            vname = f"{base_name}_{variant}"
            try:
                pdfmetrics.registerFont(TTFont(vname, vp))
                variants[variant] = vname
            except Exception:
                pass
    return variants


# ─── #8 Định dạng dữ liệu trong placeholder: {Cot|upper}, {Gia|number:0}, ... ──
_DATE_IN_FORMATS = ['%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%Y/%m/%d',
                    '%d-%m-%Y', '%Y-%m-%d %H:%M:%S', '%d/%m/%Y %H:%M']


def _apply_format(raw: str, func: str, arg: str) -> str:
    if not func:
        return raw
    f = func.lower()
    try:
        if f == 'upper':
            return raw.upper()
        if f == 'lower':
            return raw.lower()
        if f in ('title', 'cap'):
            return raw.title()
        if f == 'trim':
            return raw.strip()
        if f in ('pad', 'padl'):      # đệm 0 bên trái cho đủ width
            return raw.strip().rjust(int(arg or 0), '0')
        if f == 'padr':
            return raw.strip().ljust(int(arg or 0), '0')
        if f in ('number', 'num', 'money'):
            dec = int(arg) if (arg not in (None, '')) else 0
            num = float(raw.replace(',', '').strip())
            return f"{num:,.{dec}f}"
        if f == 'date':
            s = raw.strip()
            dt = None
            for infmt in _DATE_IN_FORMATS:
                try:
                    dt = datetime.datetime.strptime(s, infmt)
                    break
                except Exception:
                    continue
            if dt is None:
                return raw
            return dt.strftime(arg or '%d/%m/%Y')
    except Exception:
        return raw
    return raw


# Token tổng quát: {NAME ([idx|delim])? (|func:arg)? }
_TOKEN_RE = re.compile(r'\{([^{}|\[\]]+)(?:\[(\d+)(?:\|([^\]]*))?\])?(?:\|([a-zA-Z]+)(?::([^}]*))?)?\}')


def _substitute(text_content: str, row: dict) -> str:
    """Thay placeholder: hỗ trợ tách cột {Cot[2|-]} và định dạng {Cot|func:arg}."""
    def repl(m):
        col, idx, delim, func, arg = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if col not in row:
            return m.group(0)  # giữ nguyên nếu không phải cột (tránh nuốt text thường)
        raw = str(row.get(col, ''))
        if idx is not None:
            parts = [p.strip() for p in raw.split(delim)] if delim else raw.split()
            i = int(idx)
            raw = parts[i - 1] if 1 <= i <= len(parts) else ''
        return _apply_format(raw, func, arg)
    return _TOKEN_RE.sub(repl, text_content)


# ─── #3 Hình ảnh biến đổi: resolve đường dẫn + vẽ theo fit/shape ──────────────
def _resolve_image_path(raw: str, base_dir: str, static_path: str):
    raw = (raw or '').strip()
    if raw.startswith('{') and raw.endswith('}'):
        raw = ''  # placeholder chưa map
    if not raw:
        return static_path or None
    if os.path.isabs(raw) and os.path.exists(raw):
        return raw
    if base_dir:
        cand = os.path.join(base_dir, raw)
        if os.path.exists(cand):
            return cand
    if os.path.exists(raw):
        return raw
    return None


_KAPPA = 0.5522847498307936


def _ellipse_path(p, cx, cy, rx, ry):
    p.moveTo(cx + rx, cy)
    p.curveTo(cx + rx, cy + ry * _KAPPA, cx + rx * _KAPPA, cy + ry, cx, cy + ry)
    p.curveTo(cx - rx * _KAPPA, cy + ry, cx - rx, cy + ry * _KAPPA, cx - rx, cy)
    p.curveTo(cx - rx, cy - ry * _KAPPA, cx - rx * _KAPPA, cy - ry, cx, cy - ry)
    p.curveTo(cx + rx * _KAPPA, cy - ry, cx + rx, cy - ry * _KAPPA, cx + rx, cy)
    p.close()


def _build_shape_clip(c, shape, x, y, w, h):
    """Đặt clip path theo hình dáng khung. Trả True nếu đã clip."""
    p = c.beginPath()
    cx, cy = x + w / 2.0, y + h / 2.0
    if shape == 'circle':
        _ellipse_path(p, cx, cy, w / 2.0, h / 2.0)
    elif shape == 'rounded':
        r = min(w, h) * 0.15
        p.moveTo(x + r, y)
        p.lineTo(x + w - r, y)
        p.curveTo(x + w - r * (1 - _KAPPA), y, x + w, y + r * (1 - _KAPPA), x + w, y + r)
        p.lineTo(x + w, y + h - r)
        p.curveTo(x + w, y + h - r * (1 - _KAPPA), x + w - r * (1 - _KAPPA), y + h, x + w - r, y + h)
        p.lineTo(x + r, y + h)
        p.curveTo(x + r * (1 - _KAPPA), y + h, x, y + h - r * (1 - _KAPPA), x, y + h - r)
        p.lineTo(x, y + r)
        p.curveTo(x, y + r * (1 - _KAPPA), x + r * (1 - _KAPPA), y, x + r, y)
        p.close()
    elif shape in ('polygon', 'star'):
        n = 6 if shape == 'polygon' else 5
        rx, ry = w / 2.0, h / 2.0
        pts = []
        if shape == 'polygon':
            for i in range(n):
                a = math.pi / 2 + i * 2 * math.pi / n
                pts.append((cx + rx * math.cos(a), cy + ry * math.sin(a)))
        else:
            for i in range(n * 2):
                a = math.pi / 2 + i * math.pi / n
                rr = 1.0 if i % 2 == 0 else 0.45
                pts.append((cx + rx * rr * math.cos(a), cy + ry * rr * math.sin(a)))
        p.moveTo(*pts[0])
        for pt in pts[1:]:
            p.lineTo(*pt)
        p.close()
    else:
        return False  # rectangle → không cần clip
    c.clipPath(p, stroke=0, fill=0)
    return True


def _draw_image_field(c, field, val, rl_x, rl_y, w, h):
    """Vẽ ảnh biến đổi vào khung (rl_x, rl_y, w, h) theo fit + shape."""
    from reportlab.lib.utils import ImageReader
    img_path = _resolve_image_path(str(val) if val else '', field.get('imageBaseDir'), field.get('imagePath'))
    if not img_path or not os.path.exists(img_path):
        return False
    try:
        ir = ImageReader(img_path)
        iw, ih = ir.getSize()
    except Exception:
        return False
    if iw <= 0 or ih <= 0:
        return False

    fit = (field.get('imageFit') or 'cover').lower()
    shape = (field.get('imageShape') or 'rectangle').lower()

    c.saveState()
    _build_shape_clip(c, shape, rl_x, rl_y, w, h)
    if fit == 'fill':
        c.drawImage(ir, rl_x, rl_y, w, h, preserveAspectRatio=False, mask='auto')
    elif fit == 'contain':
        scale = min(w / iw, h / ih)
        dw, dh = iw * scale, ih * scale
        c.drawImage(ir, rl_x + (w - dw) / 2.0, rl_y + (h - dh) / 2.0, dw, dh,
                    preserveAspectRatio=False, mask='auto')
    else:  # cover (mặc định) — lấp đầy, cắt phần thừa (đã clip)
        scale = max(w / iw, h / ih)
        dw, dh = iw * scale, ih * scale
        c.drawImage(ir, rl_x + (w - dw) / 2.0, rl_y + (h - dh) / 2.0, dw, dh,
                    preserveAspectRatio=False, mask='auto')
    c.restoreState()
    return True


# ─── Barcode 2D công nghiệp: DataMatrix ECC200 / GS1 DataMatrix ─────────────
# Widget ECC200 của ReportLab là loại Type-12 cố định 44×44 module (barWidth =
# cỡ một module = X-dimension). Ta dùng nó cho cả DataMatrix thường và GS1
# DataMatrix (chèn FNC1 qua build_gs1_payload). Phần GS1-128 dùng Code128 + FNC1.
DATAMATRIX_MODULES = 44       # số module mỗi cạnh của ECC200 Type-12
MIN_X_DIMENSION_MM = 0.254    # X-dimension tối thiểu để máy quét đọc được (Req 3.11)


def datamatrix_fit(frame_w_pt, frame_h_pt, quiet_zone_pt, n_modules=DATAMATRIX_MODULES):
    """Tính cỡ module và kiểm fit cho barcode 2D (Req 3.11).

    Trả tuple ``(ok, module_pt, x_dim_mm, reason)``. Theo Property 20, ``ok`` là
    False KHI VÀ CHỈ KHI X-dimension < 0.254 mm HOẶC quiet zone < 1 module.

    Đơn vị point dùng chung với 1D/QR; quy đổi point→mm bằng ``/ MM_TO_PTS`` (point
    là đơn vị vật lý 1/72 inch nên đây là kích thước in thật, không phụ thuộc CSS).
    """
    inner_w = frame_w_pt - 2 * quiet_zone_pt
    inner_h = frame_h_pt - 2 * quiet_zone_pt
    module_pt = min(inner_w, inner_h) / n_modules
    x_dim_mm = module_pt / MM_TO_PTS
    if x_dim_mm < MIN_X_DIMENSION_MM:
        return (False, module_pt, x_dim_mm,
                f"X-dimension {x_dim_mm:.3f}mm < {MIN_X_DIMENSION_MM}mm")
    if quiet_zone_pt < module_pt:
        return (False, module_pt, x_dim_mm,
                f"quiet zone {quiet_zone_pt:.2f}pt < 1 module ({module_pt:.2f}pt)")
    return (True, module_pt, x_dim_mm, "")


def render_2d(c, field, value, rect):
    """Vẽ barcode 2D (DataMatrix / GS1 DataMatrix) vào canvas ReportLab.

    - DataMatrix      : mã ECC200 biểu diễn ``value`` (Req 3.1).
    - GS1 DataMatrix  : parse AI → chèn FNC1 → ECC200 tuân thủ GS1 (Req 3.3).
    - Quiet zone + màu CMYK theo CÙNG hệ quy đổi ``CSS_TO_PT_FACTOR`` như QR/1D (Req 3.7).
    - Kiểm fit X-dimension ≥ 0.254 mm và quiet zone ≥ 1 module; nếu khung quá nhỏ
      hoặc AI sai → raise ValueError để caller gắn nhãn ERR + ghi báo cáo, KHÔNG
      sinh mã sai chuẩn (Req 3.5, 3.11).

    ``rect`` = ``{'x','y','w','h'}`` theo toạ độ ReportLab (gốc dưới-trái), đã clamp.
    """
    from reportlab.graphics.barcode.ecc200datamatrix import ECC200DataMatrix

    btype = (field.get('barcodeType') or field.get('barType') or '').lower()
    raw = str(value)

    # GS1 DataMatrix: parse + validate AI rồi dựng payload có FNC1 (\x1d).
    # parse_gs1 raise GS1Error (lớp con của ValueError) khi AI/định dạng sai (Req 3.5).
    is_gs1_dm = btype in ('gs1-datamatrix', 'gs1datamatrix', 'gs1_datamatrix', 'gs1-dm')
    if is_gs1_dm:
        elems = parse_gs1(raw)
        data = build_gs1_payload(elems)
    else:
        data = raw
    # Human-readable GS1 '(AI)dữ_liệu' (Req 3.10): chỉ khi gs1HumanReadable bật.
    # Mặc định tắt ⇒ hr_text='' ⇒ ma trận chiếm trọn khung như cũ (parity).
    want_hr = is_gs1_dm and bool(field.get('gs1HumanReadable'))
    hr_text = human_readable(elems) if want_hr else ''

    rl_x, rl_y = rect['x'], rect['y']
    w, h = rect['w'], rect['h']

    # Quiet zone mm → point — CÙNG công thức với QR/1D (Req 3.7, Property 18).
    qz_pts = max(0.0, float(field.get('quietZone', 2) or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
    qz_pts = max(0.0, min(qz_pts, w / 2.0 - 0.5, h / 2.0 - 0.5))

    # Dải HR (nếu bật) chiếm phần đáy khung; ma trận fit vào phần CÒN LẠI.
    # hr_h=0 ⇒ fit_h=h ⇒ datamatrix_fit/đặt ma trận y hệt trước (parity).
    hr_h = min(h * 0.18, 9.0) if hr_text else 0.0
    fit_h = max(1.0, h - hr_h)
    ok, module_pt, x_dim_mm, reason = datamatrix_fit(w, fit_h, qz_pts)
    if not ok:
        raise ValueError(f"DataMatrix khong dat chuan: {reason}")

    dm = ECC200DataMatrix(value=data, barWidth=module_pt)
    dm.validate()
    if not getattr(dm, 'valid', 1):
        raise ValueError("DataMatrix: gia tri co ky tu khong ma hoa duoc (ord>255)")
    dm.encode()
    dm.computeSize()

    bar_color = field.get('barColor') or field.get('fontColor') or '#000000'
    transparent_bg = field.get('transparentBg', False)

    c.saveState()
    # Nền phủ TOÀN BỘ khung (gồm vùng quiet zone) như QR/1D.
    if not transparent_bg:
        c.setFillColorCMYK(*hex_to_cmyk(field.get('bgColor', '#FFFFFF')))
        c.rect(rl_x, rl_y, w, h, stroke=0, fill=1)
    # Ma trận vuông (DATAMATRIX_MODULES × module_pt), canh giữa trong vùng FIT
    # (khung TRỪ dải HR ở đáy). hr_h=0 ⇒ offy = canh giữa cả khung như cũ.
    draw_sz = module_pt * DATAMATRIX_MODULES
    offx = rl_x + (w - draw_sz) / 2.0
    offy = rl_y + hr_h + (fit_h - draw_sz) / 2.0
    c.setFillColorCMYK(*hex_to_cmyk(bar_color))
    dm.x = 0
    dm.y = 0
    # drawOn lưu trạng thái rồi gọi draw(); rect() của widget dùng màu fill hiện tại.
    dm.drawOn(c, offx, offy)
    if hr_h > 0:
        hr_fs = max(3.0, min(hr_h * 0.8, w * 1.7 / max(1, len(hr_text))))
        c.setFillColorCMYK(*hex_to_cmyk(bar_color))
        c.setFont('Helvetica', hr_fs)
        tw = c.stringWidth(hr_text, 'Helvetica', hr_fs)
        tx = rl_x + (w - tw) / 2.0
        ty = rl_y + (hr_h - hr_fs) / 2.0 + hr_fs * 0.18
        c.drawString(tx, ty, hr_text)
    c.restoreState()


def _draw_curved_text(c, field, text, rl_x, rl_y, w, h, font_name, fontsize, text_color, need_faux_bold=False, need_faux_italic=False):
    """Vẽ text chạy theo quỹ đạo cung tròn hoặc lượn sóng (Type on a Path) — giữ nguyên hình dạng từng ký tự."""
    curve_mode = (field.get('curveMode') or 'none').lower()
    if curve_mode not in ('arc_top', 'arc_bottom', 'wave'):
        return False
    val_str = str(text or '')
    if not val_str:
        return True

    tracking = float(field.get('curveTracking') or field.get('characterSpacing') or 0.0)
    orientation = (field.get('curveOrientation') or 'outward').lower()
    auto_fit = field.get('autoFit', True)

    c.saveState()
    c.setFillColor(text_color)
    c.setFont(font_name, fontsize)

    if curve_mode == 'wave':
        raw_amp_mm = field.get('curveRadius')
        if raw_amp_mm is not None and float(raw_amp_mm) > 0:
            amp = float(raw_amp_mm) * MM_TO_PTS
        else:
            amp = h * 0.25
        amp = min(amp, h * 0.35)
        # ReportLab trục Y hướng lên: orientation outward = lượn lên trước rồi xuống
        sign = -1.0 if orientation == 'inward' else 1.0
        amp *= sign

        char_widths = [c.stringWidth(ch, font_name, fontsize) + tracking for ch in val_str]
        total_length = sum(char_widths)

        # Tự co cỡ chữ nếu chữ quá dài so với khung (chỉ co, không phóng to)
        if auto_fit and total_length > w * 0.9 and total_length > 0:
            scale_factor = min(1.0, (w * 0.9) / total_length)
            fontsize = max(5.0, min(fontsize, fontsize * scale_factor))
            c.setFont(font_name, fontsize)
            char_widths = [c.stringWidth(ch, font_name, fontsize) + tracking for ch in val_str]
            total_length = sum(char_widths)

        if total_length <= 0 or w <= 0:
            c.restoreState()
            return True

        # Bước sóng thích ứng theo độ dài chuỗi chữ để chữ luôn uốn đủ đỉnh và đáy chữ S
        span_w = min(w - 4.0, max(total_length * 1.35, w * 0.6))
        x_start = rl_x + (w - span_w) / 2.0

        # Đặt chữ cân đối ở giữa dải sóng span_w
        start_ratio = max(0.04, (1.0 - (total_length / span_w)) / 2.0)
        current_u = start_ratio
        delta_u_per_pt = 1.0 / max(span_w, 1.0)

        for i, ch in enumerate(val_str):
            cw = char_widths[i]
            mid_u = current_u + (cw * delta_u_per_pt) / 2.0
            mid_u = min(0.98, max(0.02, mid_u))

            x = x_start + mid_u * span_w
            y = rl_y + h / 2.0 + amp * math.sin(2.0 * math.pi * mid_u)

            dx = span_w
            dy = amp * 2.0 * math.pi * math.cos(2.0 * math.pi * mid_u)
            alpha_deg = math.degrees(math.atan2(dy, dx))

            c.saveState()
            c.translate(x, y)
            c.rotate(alpha_deg)
            if need_faux_italic:
                c.transform(1, 0, 0.21, 1, 0, 0)
            actual_w = c.stringWidth(ch, font_name, fontsize)
            c.drawString(-actual_w / 2.0, -fontsize * 0.35, ch)
            if need_faux_bold:
                c.drawString(-actual_w / 2.0 + 0.35, -fontsize * 0.35, ch)
            c.restoreState()

            current_u += cw * delta_u_per_pt

        c.restoreState()
        return True

    raw_radius_mm = field.get('curveRadius')
    if raw_radius_mm is not None and float(raw_radius_mm) > 0:
        radius = float(raw_radius_mm) * MM_TO_PTS
    else:
        radius = max(w, h) * 0.75

    char_widths = [c.stringWidth(ch, font_name, fontsize) + tracking for ch in val_str]
    total_length = sum(char_widths)
    if total_length <= 0 or radius <= 0:
        c.restoreState()
        return True

    total_angle = total_length / radius  # radians

    # Đồng bộ với frontend preview: tự co cỡ chữ khi bật autoFit nếu góc vượt quá cung vòm tự nhiên (~190 độ)
    auto_fit = field.get('autoFit', True)
    # Giữ nguyên cỡ chữ gốc nếu là nội dung mẫu; chỉ co khi dữ liệu gộp VDP dài hơn mẫu
    base_len = len(str(field.get('textContent') or '').strip()) or 1
    current_len = len(val_str.strip()) or 1
    max_safe_angle = math.pi * 1.05
    if auto_fit and current_len > base_len and total_angle > max_safe_angle:
        scale_factor = min(1.0, base_len / current_len)
        fontsize = max(5.0, min(fontsize, fontsize * scale_factor))
        c.setFont(font_name, fontsize)
        char_widths = [c.stringWidth(ch, font_name, fontsize) + tracking for ch in val_str]
        total_length = sum(char_widths)
        total_angle = total_length / radius

    cx = rl_x + w / 2.0
    half_text_angle = min(math.pi / 2.0, total_angle / 2.0)
    text_sagitta = radius * (1.0 - math.cos(half_text_angle))

    if curve_mode == 'arc_top':
        # Căn giữa toàn bộ độ cao thực tế của chữ (text_sagitta + fontsize) vào chính giữa khung h
        if orientation == 'inward':
            cy = rl_y + h / 2.0 + (text_sagitta + fontsize) / 2.0 - radius
        else:
            cy = rl_y + h / 2.0 + (text_sagitta - fontsize) / 2.0 - radius
        theta_start = math.pi / 2.0 + total_angle / 2.0
        current_theta = theta_start
        for i, ch in enumerate(val_str):
            cw = char_widths[i]
            d_theta = cw / radius
            char_theta = current_theta - d_theta / 2.0

            x = cx + radius * math.cos(char_theta)
            y = cy + radius * math.sin(char_theta)
            alpha_deg = math.degrees(char_theta) - 90.0
            if orientation == 'inward':
                alpha_deg += 180.0

            c.saveState()
            c.translate(x, y)
            c.rotate(alpha_deg)
            if need_faux_italic:
                c.transform(1, 0, 0.21, 1, 0, 0)
            actual_w = c.stringWidth(ch, font_name, fontsize)
            c.drawString(-actual_w / 2.0, 0, ch)
            if need_faux_bold:
                c.drawString(-actual_w / 2.0 + 0.35, 0, ch)
            c.restoreState()

            current_theta -= d_theta
    else:  # arc_bottom
        # Căn giữa toàn bộ độ cao thực tế của chữ (text_sagitta + fontsize) vào chính giữa khung h
        if orientation == 'inward':
            cy = rl_y + h / 2.0 - (text_sagitta - fontsize) / 2.0 + radius
        else:
            cy = rl_y + h / 2.0 - (text_sagitta + fontsize) / 2.0 + radius
        theta_start = 1.5 * math.pi - total_angle / 2.0
        current_theta = theta_start
        for i, ch in enumerate(val_str):
            cw = char_widths[i]
            d_theta = cw / radius
            char_theta = current_theta + d_theta / 2.0

            x = cx + radius * math.cos(char_theta)
            y = cy + radius * math.sin(char_theta)
            alpha_deg = math.degrees(char_theta) - 270.0
            if orientation == 'inward':
                alpha_deg += 180.0

            c.saveState()
            c.translate(x, y)
            c.rotate(alpha_deg)
            if need_faux_italic:
                c.transform(1, 0, 0.21, 1, 0, 0)
            actual_w = c.stringWidth(ch, font_name, fontsize)
            c.drawString(-actual_w / 2.0, 0, ch)
            if need_faux_bold:
                c.drawString(-actual_w / 2.0 + 0.35, 0, ch)
            c.restoreState()

            current_theta += d_theta

    c.restoreState()
    return True


def render_one_record(c, fields, row, field_rects, pw, ph, field_font_variants, error_sink=None):
    """Vẽ TẤT CẢ field của một record lên canvas ReportLab ``c``.

    Tách dùng chung giữa ``process_chunk`` (sinh lô) và Preview_Service để bảo
    toàn parity preview ↔ output: cùng quy đổi toạ độ ``CSS_TO_PT_FACTOR = 0.75``,
    cùng ``hex_to_cmyk`` (đen #000000 → (0,0,0,1) pure-K), cùng phép xoay
    0/90/180/270 và cùng cách clamp khung vào trang. ``field_rects`` đã được
    tính sẵn theo point; ``pw``/``ph`` là kích thước trang; ``field_font_variants``
    là map biến thể font đã đăng ký. Hành vi giữ NGUYÊN so với vòng lặp gốc.

    ``error_sink`` (tuỳ chọn): nếu truyền một list, mỗi field bị MISSING/ERR sẽ
    được thêm một dict ``{'field','kind','reason','rect'}`` vào list — ``rect`` là
    khung field ĐÃ clamp theo toạ độ point gốc-trên-trái (x từ trái, y từ trên,
    w, h). Preview_Service dùng cơ chế này để báo lỗi đúng các field mà engine
    gắn nhãn (một nguồn sự thật duy nhất, bảo toàn parity preview ↔ output). Mặc
    định None ⇒ hành vi sinh lô giữ NGUYÊN.
    """
    from reportlab.graphics.barcode import createBarcodeDrawing
    from reportlab.graphics import renderPDF
    fields_dict = fields
    for fi, field in enumerate(fields_dict):
        f_rect = field_rects[fi]
        # Clamp khung field vào trong trang (MediaBox) để nội dung (QR / mã vạch /
        # text / ảnh) KHÔNG tràn ra ngoài trang rồi bị cắt mất — ví dụ người dùng
        # kéo khung lớn hơn trang hoặc đặt lệch ra mép. Clone (không sửa field_rects
        # gốc vì dùng lại cho mọi bản ghi).
        _fx = min(max(0.0, f_rect['x']), max(0.0, pw - 1.0))
        _fy = min(max(0.0, f_rect['y']), max(0.0, ph - 1.0))
        _fw = max(1.0, min(f_rect['w'], pw - _fx))
        _fh = max(1.0, min(f_rect['h'], ph - _fy))
        f_rect = {'x': _fx, 'y': _fy, 'w': _fw, 'h': _fh}
        # Khung field đã clamp theo toạ độ point gốc-trên-trái (x từ trái, y từ
        # trên) — dùng để báo lỗi field cho Preview_Service. KHÔNG bị ảnh hưởng
        # bởi phép xoay bên dưới (f_rect bị gán lại khi xoay, report_rect thì không).
        report_rect = {'x': _fx, 'y': _fy, 'w': _fw, 'h': _fh}
        # Toạ độ field từ frontend theo VÙNG HIỂN THỊ của viewer, gốc trên-trái.
        # Viewer render theo CropBox; template đã được _canonicalize_template_to_cropbox
        # đưa CropBox về MediaBox gốc (0,0) TRƯỚC khi tới đây, nên pw/ph (=MediaBox)
        # chính là vùng hiển thị và field khớp vị trí. ReportLab gốc dưới-trái nên lật y.
        rl_x = f_rect['x']
        rl_y = ph - f_rect['y'] - f_rect['h']

        # Phân giải nội dung field theo pipeline THỨ TỰ CỐ ĐỊNH (Req 2.11):
        #   (1) điều kiện ẩn/hiện → (2) bảng rule first-match → (3) token nội tuyến
        #   {Cot?A:B} → (4) placeholder cũ ({Cot}, {Cot[2|-]}, {Cot|func:arg}).
        # Field KHÔNG dùng tính năng mới: bước 1–3 là no-op, bước 4 chính là
        # _substitute hiện tại ⇒ kết quả không đổi (Req 2.8, 7.3).
        try:
            resolved = resolve_field_content(field, row)
        except ConditionError as ce:
            # Điều kiện/rule/token tham chiếu cột không tồn tại → gắn nhãn MISSING
            # cho field của record này + ghi báo cáo lỗi, rồi tiếp tục field kế
            # (KHÔNG làm hỏng các field/record khác) (Req 2.7, 8.4, 8.6).
            c.setFillColorCMYK(0, 1, 1, 0)  # đỏ (CMYK)
            c.setFont("Helvetica", 8)
            c.drawString(rl_x, rl_y + f_rect['h'] - 10, f"MISSING: {field.get('name', '')}")
            if error_sink is not None:
                error_sink.append({
                    'field': field.get('name', ''),
                    'kind': 'MISSING',
                    'reason': ce.reason,
                    'rect': dict(report_rect),
                })
            continue

        # (1) Field bị ẩn theo điều kiện ẩn/hiện → bỏ qua việc vẽ (Req 2.1).
        if not resolved.visible:
            continue

        val = resolved.content

        # #3 Image: cột rỗng / placeholder chưa map → dùng ảnh tĩnh (nếu có).
        if field['type'] == 'image':
            if (not val) or (val.startswith('{') and val.endswith('}')):
                val = field.get('imagePath') or ''

        if not val:
            if field['type'] != 'image':
                c.setFillColorCMYK(0, 1, 1, 0)  # đỏ (CMYK)
                c.setFont("Helvetica", 8)
                c.drawString(rl_x, rl_y + f_rect['h'] - 10, f"MISSING: {field['name']}")
                if error_sink is not None:
                    error_sink.append({
                        'field': field.get('name', ''),
                        'kind': 'MISSING',
                        'reason': f"Thiếu giá trị cột cho field {field.get('name', '')}",
                        'rect': dict(report_rect),
                    })
            continue

        # Toạ độ gốc (chưa xoay) để vẽ nhãn lỗi nếu cần
        err_x, err_y, err_h = rl_x, rl_y, f_rect['h']
        rotated = False
        try:
            font_color_hex = (field.get('fontColor') or '#000000')
            text_color = cmyk_color(font_color_hex)  # CMYK → đen pure-K (#4)

            # ── Rotation: xoay nội dung quanh tâm box. Frontend đã hoán đổi w/h
            #    cho field dọc (90/270), nên footprint vẽ = hoán đổi ngược lại. ──
            rot = int(field.get('rotation') or 0) % 360
            if rot in (90, 180, 270):
                cx = f_rect['x'] + f_rect['w'] / 2.0
                cy = ph - f_rect['y'] - f_rect['h'] / 2.0
                ew, eh = (f_rect['h'], f_rect['w']) if rot in (90, 270) else (f_rect['w'], f_rect['h'])
                c.saveState()
                c.translate(cx, cy)
                c.rotate(rot)
                rotated = True
                f_rect = {'x': -ew / 2.0, 'y': f_rect['y'], 'w': ew, 'h': eh}
                rl_x = -ew / 2.0
                rl_y = -eh / 2.0

            if field['type'] == 'qrcode':
                val_str = str(val)
                if not val_str:
                    continue

                qr_style = field.get('qrStyle') or {}
                transparent_bg = qr_style.get('transparentBg', False)
                bg_color_hex = qr_style.get('bgColor', '#FFFFFF')
                # Màu chấm QR lấy từ qrStyle.dotColor (fallback fontColor).
                qr_fg_hex = qr_style.get('dotColor') or field.get('fontColor') or '#000000'

                import segno
                # Mức sửa lỗi lấy từ UI (L/M/Q/H), fallback 'M' nếu không hợp lệ.
                ec_raw = str(field.get('errorCorrection') or 'M').lower()
                ec_level = ec_raw if ec_raw in ('l', 'm', 'q', 'h') else 'm'
                qr = segno.make(val_str, error=ec_level)
                matrix = qr.matrix
                n = len(matrix)  # số module mỗi cạnh (chưa gồm lề trắng)

                # Strip compression — KHÔNG cộng quiet zone vào ma trận;
                # lề trắng được vẽ bằng inset vật lý (mm) bên dưới để khớp preview.
                strips = []
                for r, row_data in enumerate(matrix):
                    col = 0
                    while col < len(row_data):
                        if row_data[col]:
                            start_c = col
                            while col < len(row_data) and row_data[col]:
                                col += 1
                            strips.append((start_c, r, col - start_c, 1))
                        else:
                            col += 1

                if n > 0:
                    # Lề trắng (quiet zone) theo "Lề trắng (mm)" người dùng đặt.
                    # LƯU Ý: để QR quét được, vùng trắng quanh QR nên ≥ ~4 module —
                    # có thể đến từ ô "Lề trắng (mm)" này HOẶC từ vùng trắng của trang
                    # quanh khung. Không ép cứng nữa để QR lấp đầy khung theo ý người dùng.
                    qz_pts = max(0.0, float(field.get('quietZone', 2) or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
                    qz_pts = max(0.0, min(qz_pts, f_rect['w'] / 2.0 - 0.5, f_rect['h'] / 2.0 - 0.5))

                    c.saveState()
                    # Nền phủ TOÀN BỘ khung (gồm vùng lề trắng).
                    if not transparent_bg:
                        c.setFillColorCMYK(*hex_to_cmyk(bg_color_hex))
                        c.rect(rl_x, rl_y, f_rect['w'], f_rect['h'], stroke=0, fill=1)

                    # Vùng vẽ QR = khung trừ lề mm; QR giữ vuông, canh giữa.
                    inner_w = max(1.0, f_rect['w'] - 2 * qz_pts)
                    inner_h = max(1.0, f_rect['h'] - 2 * qz_pts)
                    module = min(inner_w / n, inner_h / n)
                    draw = module * n
                    offx = rl_x + (f_rect['w'] - draw) / 2.0
                    offy = rl_y + (f_rect['h'] - draw) / 2.0

                    c.setFillColorCMYK(*hex_to_cmyk(qr_fg_hex))
                    c.translate(offx, offy)
                    c.scale(module, module)
                    for x, y, w, h in strips:
                        c.rect(x, n - y - h, w, h, stroke=0, fill=1)
                    c.restoreState()

            elif field['type'] == 'barcode':
                val_str = str(val)
                if not val_str:
                    continue

                btype = (field.get('barcodeType') or field.get('barType') or 'code128').lower()

                # ── Nhánh barcode 2D mới (DataMatrix / GS1 DataMatrix) ──
                # Vẽ độc lập qua render_2d rồi kết thúc field; KHÔNG đụng path
                # 1D/QR hiện có để bảo toàn hành vi (Req 3.8, 7.3). AI sai / khung
                # quá nhỏ → render_2d raise → except phía dưới gắn nhãn ERR (Req 3.5, 3.11).
                if btype in ('datamatrix', 'gs1-datamatrix', 'gs1datamatrix',
                             'gs1_datamatrix', 'gs1-dm'):
                    render_2d(c, field, val_str,
                              {'x': rl_x, 'y': rl_y, 'w': f_rect['w'], 'h': f_rect['h']})
                else:
                    # ── GS1-128: Code128 trên payload có FNC1 ──
                    is_gs1_128 = btype in ('gs1-128', 'gs1128', 'gs1_128')
                    if is_gs1_128:
                        # parse + validate AI; sai định dạng → ERR (Req 3.5).
                        elems = parse_gs1(val_str)
                        payload = build_gs1_payload(elems)
                        # FNC1 placeholder (\x1d) → ký tự FNC1 của Code128 (\xf1).
                        bc_value = payload.replace(FNC1, '\xf1')
                        rl_btype = 'Code128'
                    else:
                        # Map ĐẦY ĐỦ 7 loại 1D UI cung cấp → tránh preview ≠ output (#6).
                        # Trước đây chỉ map 4 loại, còn lại âm thầm thành Code128.
                        bt_map = {
                            'code128': 'Code128',
                            'ean13': 'EAN13',
                            'ean8': 'EAN8',
                            'upca': 'UPCA',
                            'code39': 'Standard39',
                            'itf14': 'I2of5',       # ITF = Interleaved 2 of 5
                            'codabar': 'Codabar',
                        }
                        if btype not in bt_map:
                            # Loại chưa hỗ trợ render → báo lỗi rõ thay vì in sai symbology.
                            raise ValueError(f"barcode '{btype}' chua ho tro")
                        rl_btype = bt_map[btype]
                        bc_value = val_str

                    # Màu vạch lấy từ barColor (fallback fontColor) — không dùng nhầm fontColor.
                    bar_color = field.get('barColor') or field.get('fontColor') or '#000000'
                    c_col = CMYKColor(*hex_to_cmyk(bar_color))
                    # GS1-128: payload chứa ký tự điều khiển FNC1 nên KHÔNG in HR
                    # mặc định (tránh hiển thị rác); 1D giữ nguyên hành vi showText.
                    show_text = False if is_gs1_128 else field.get('showText', True)
                    bc_kwargs = dict(value=bc_value, barFillColor=c_col, humanReadable=bool(show_text))
                    if rl_btype == 'I2of5':
                        bc_kwargs['bearers'] = 3.0  # ITF-14 có thanh bao quanh
                    barcode = createBarcodeDrawing(rl_btype, **bc_kwargs)
                    x0, y0, x1, y1 = barcode.getBounds()
                    intrinsic_w = x1 - x0
                    intrinsic_h = y1 - y0

                    if intrinsic_w > 0 and intrinsic_h > 0:
                        # Lề trắng (quiet zone) mm → points, cùng hệ quy đổi với khung.
                        qz_pts = max(0.0, float(field.get('quietZone', 2) or 0)) * MM_TO_PTS * CSS_TO_PT_FACTOR
                        qz_pts = max(0.0, min(qz_pts, f_rect['w'] / 2.0 - 0.5, f_rect['h'] / 2.0 - 0.5))

                        transparent_bg = field.get('transparentBg', False)

                        # GS1-128 human-readable: in chuỗi '(AI)dữ_liệu' SẠCH (không
                        # chứa FNC1) ở dải đáy khung khi người dùng bật gs1HumanReadable
                        # (Req 3.10). Mặc định tắt ⇒ hr_h = 0 ⇒ layout GIỮ NGUYÊN như cũ
                        # (parity preview↔output không đổi với mọi field hiện có).
                        want_gs1_hr = is_gs1_128 and bool(field.get('gs1HumanReadable'))
                        hr_text = human_readable(elems) if want_gs1_hr else ''

                        c.saveState()
                        # Nền phủ TOÀN BỘ khung (bao gồm vùng lề trắng)
                        if not transparent_bg:
                            c.setFillColorCMYK(*hex_to_cmyk(field.get('bgColor', '#FFFFFF')))
                            c.rect(rl_x, rl_y, f_rect['w'], f_rect['h'], stroke=0, fill=1)

                        # Mã vạch lấp đầy vùng trong (khung trừ lề), đặt lệch theo lề.
                        inner_w = max(1.0, f_rect['w'] - 2 * qz_pts)
                        inner_h = max(1.0, f_rect['h'] - 2 * qz_pts)
                        # Dải chữ HR (nếu bật): tối đa 22% chiều cao vùng trong, trần 9pt.
                        hr_h = min(inner_h * 0.22, 9.0) if hr_text else 0.0
                        bar_h = max(1.0, inner_h - hr_h)
                        c.saveState()
                        c.translate(rl_x + qz_pts, rl_y + qz_pts + hr_h)
                        c.scale(inner_w / intrinsic_w, bar_h / intrinsic_h)
                        renderPDF.draw(barcode, c, -x0, -y0)
                        c.restoreState()

                        if hr_h > 0:
                            # Cỡ chữ vừa dải HR và vừa bề ngang vùng trong.
                            hr_fs = max(3.0, min(hr_h * 0.8,
                                                 inner_w * 1.7 / max(1, len(hr_text))))
                            c.setFillColorCMYK(*hex_to_cmyk(bar_color))
                            c.setFont('Helvetica', hr_fs)
                            tw = c.stringWidth(hr_text, 'Helvetica', hr_fs)
                            tx = rl_x + qz_pts + (inner_w - tw) / 2.0
                            ty = rl_y + qz_pts + (hr_h - hr_fs) / 2.0 + hr_fs * 0.18
                            c.drawString(tx, ty, hr_text)

                        c.restoreState()
            elif field['type'] == 'image':
                # #3 Ảnh biến đổi: vẽ ảnh từ cột (hoặc ảnh tĩnh) theo fit + shape.
                _drawn = _draw_image_field(c, field, val, rl_x, rl_y, f_rect['w'], f_rect['h'])
                if not _drawn:
                    # Không tìm thấy ảnh → khung mảnh để biết vị trí (không phá output).
                    c.saveState()
                    c.setStrokeColorCMYK(0, 0, 0, 0.35)
                    c.setLineWidth(0.4)
                    c.rect(rl_x, rl_y, f_rect['w'], f_rect['h'], stroke=1, fill=0)
                    c.restoreState()
            elif field['type'] == 'text':
                fontsize = field.get('fontSize', 10)
                line_h = float(field.get('lineHeight') or 1.0)
                font_file = field.get('fontFile')

                # #7 Chọn font THẬT theo fontStyle nếu có biến thể Bold/Italic;
                # chỉ dùng faux cho phần KHÔNG có file font tương ứng.
                fs_style = str(field.get('fontStyle') or 'regular').lower()
                want_bold = 'bold' in fs_style
                want_italic = 'italic' in fs_style
                variants = field_font_variants.get(field.get('id'), {}) if font_file else {}
                font_name = variants.get('regular') or "Helvetica"
                need_faux_bold = want_bold
                need_faux_italic = want_italic
                if want_bold and want_italic and variants.get('bolditalic'):
                    font_name = variants['bolditalic']; need_faux_bold = need_faux_italic = False
                elif want_bold and want_italic and variants.get('bold'):
                    font_name = variants['bold']; need_faux_bold = False
                elif want_bold and variants.get('bold'):
                    font_name = variants['bold']; need_faux_bold = False
                elif want_italic and variants.get('italic'):
                    font_name = variants['italic']; need_faux_italic = False
                # Quỹ đạo vòm (Type on a Path): nếu bật curveMode ('arc_top' / 'arc_bottom') thì vẽ theo cung tròn
                if not _draw_curved_text(c, field, val, rl_x, rl_y, f_rect['w'], f_rect['h'], font_name, fontsize, text_color, need_faux_bold, need_faux_italic):
                    # Map frontend alignment to ReportLab alignment
                    align_map = {'left': TA_LEFT, 'center': TA_CENTER, 'right': TA_RIGHT}
                    raw_align = field.get('alignment', 'left')
                    text_align = align_map.get(raw_align, TA_LEFT)

                    style = ParagraphStyle(
                        name='VDP',
                        fontName=font_name,
                        fontSize=fontsize,
                        textColor=text_color,
                        leading=fontsize * line_h,
                        alignment=text_align
                    )

                    # Escape XML đặc biệt (& < >) TRƯỚC khi chèn <br/>, nếu không
                    # dữ liệu chứa các ký tự này sẽ làm vỡ parser của ReportLab Paragraph.
                    text_html = xml_escape(str(val)).replace('\n', '<br/>')
                    p = Paragraph(text_html, style)
                    w, h = p.wrapOn(c, f_rect['w'], f_rect['h'])

                    # AUTO-FIT = NÉN BỀ RỘNG (horizontal scale), GIỮ NGUYÊN cỡ chữ/chiều
                    # cao. KHÔNG cho tự xuống dòng — chỉ ngắt ở '\n' người dùng gõ. Tính
                    # sx = bề ngang khung / bề rộng dòng DÀI NHẤT (đo bằng stringWidth); nếu
                    # chữ tràn ngang thì nén ngang cho vừa. Vẽ bằng canvas scale(sx, 1) để
                    # chỉ co chiều rộng. Parity với preview (whitespace:pre + scaleX).
                    auto_fit = field.get('autoFit', True)
                    sx = 1.0
                    if auto_fit:
                        raw_lines = str(val).split('\n') or ['']
                        maxw = max(
                            (c.stringWidth(ln, font_name, fontsize) for ln in raw_lines if ln),
                            default=0.0,
                        )
                        if maxw > f_rect['w'] and maxw > 0:
                            sx = max(0.05, min(1.0, f_rect['w'] / maxw))

                    # Wrap với bề rộng khả dụng = f_rect['w']/sx (không gian TRƯỚC khi nén)
                    # để Paragraph không tự xuống dòng — sau khi scale(sx,1) chiều rộng thật
                    # đúng bằng f_rect['w'].
                    avail_w = f_rect['w'] / sx if sx > 0 else f_rect['w']
                    w, h = p.wrapOn(c, avail_w, f_rect['h'])

                    # Canh GIỮA theo chiều dọc trong khung: chừa đều trên/dưới.
                    # #7: dùng font Bold/Italic THẬT khi có (need_faux_* = False);
                    # chỉ faux phần thiếu (bold = double-strike, italic = nghiêng shear).
                    ty = rl_y + (f_rect['h'] - h) / 2.0
                    c.saveState()
                    c.translate(rl_x, ty)
                    if sx != 1.0:
                        c.scale(sx, 1)  # nén ngang, giữ nguyên chiều cao
                    if need_faux_italic:
                        c.transform(1, 0, 0.21, 1, 0, 0)  # nghiêng ~12°
                    p.drawOn(c, 0, 0)
                    if need_faux_bold:
                        # vẽ lại lệch ~3% cỡ chữ → dày nét (giả bold)
                        p.drawOn(c, max(0.3, float(style.fontSize) * 0.03), 0)
                    c.restoreState()
        except Exception as e:
            c.setFillColorCMYK(0, 1, 1, 0)  # đỏ (CMYK)
            c.setFont("Helvetica", 7)
            c.drawString(err_x, err_y + err_h - 10, f"ERR: {str(e)[:60]}")
            if error_sink is not None:
                error_sink.append({
                    'field': field.get('name', ''),
                    'kind': 'ERR',
                    'reason': str(e),
                    'rect': dict(report_rect),
                })
        finally:
            if rotated:
                c.restoreState()



def process_chunk(args) -> str:
    template_path, fields_dict, data_chunk, chunk_start_idx, progress_file = args[:5]
    cancel_file = args[5] if len(args) > 5 else None
    job_id = args[6] if len(args) > 6 else None
    if _vdp_cancel_file_exists(cancel_file):
        return ""
    
    doc_template = pdf_lib.open(template_path)
    template_page_count = len(doc_template)
    out_doc = pdf_lib.open()

    def cancel_chunk_if_requested() -> bool:
        if not _vdp_cancel_file_exists(cancel_file):
            return False
        try:
            out_doc.close()
        finally:
            doc_template.close()
        return True
    
    # Pre-compute field rects in PDF points for ReportLab
    # IMPORTANT: Frontend calculates "mm" using CSS pixels / 72 * 25.4
    # But CSS pixels = pt * (96/72), so the "mm" values are actually inflated by 96/72.
    # We must correct: real_pts = frontend_mm * MM_TO_PTS * (72/96)
    CSS_TO_PT_FACTOR = 72.0 / 96.0  # = 0.75
    field_rects = []
    for field in fields_dict:
        x_pts = field['x'] * MM_TO_PTS * CSS_TO_PT_FACTOR
        y_pts = field['y'] * MM_TO_PTS * CSS_TO_PT_FACTOR
        w_pts = field['width'] * MM_TO_PTS * CSS_TO_PT_FACTOR
        h_pts = field['height'] * MM_TO_PTS * CSS_TO_PT_FACTOR
        field_rects.append({'x': x_pts, 'y': y_pts, 'w': w_pts, 'h': h_pts})
    
    qr_cache = {}
    
    # Register fonts once per chunk — đăng ký CẢ biến thể Bold/Italic thật nếu có
    # file font anh em cùng thư mục (#7). field_font_variants[id] = {variant: name}.
    field_font_variants = {}
    for field in fields_dict:
        if field.get('type') == 'text':
            font_file = field.get('fontFile')
            if font_file and os.path.exists(font_file):
                base_name = "f_" + field.get('id', 'default').replace('-', '')
                field_font_variants[field.get('id')] = _register_font_family(font_file, base_name)
    
    # Pre-compute MediaBox dims per template page (cache once, use for all records)
    template_dims = []
    for t_idx in range(template_page_count):
        tp = doc_template[t_idx]
        mb = tp._page.mediabox
        template_dims.append({
            'pw': float(mb[2] - mb[0]),
            'ph': float(mb[3] - mb[1]),
        })
    
    import pikepdf
    
    # PRE-PROCESS: Cache the template pages into out_doc to bring resources over ONCE.
    # This prevents file bloat (resources are natively deduplicated) and preserves all annotations/layers natively.
    cached_pages = []
    for t_idx in range(template_page_count):
        out_doc._pdf.pages.append(doc_template._pdf.pages[t_idx])
        cached_pages.append(out_doc._pdf.pages[-1])
        
    count = 0
    from reportlab.graphics.barcode import createBarcodeDrawing
    from reportlab.graphics import renderPDF
    from reportlab.lib.colors import Color
    
    for idx, row in enumerate(data_chunk):
        if cancel_chunk_if_requested():
            return ""
        global_idx = chunk_start_idx + idx
        t_idx = global_idx % template_page_count
        
        td = template_dims[t_idx]
        pw = td['pw']
        ph = td['ph']
        
        # We use base_page as our blueprint (it already lives inside out_doc)
        base_page = cached_pages[t_idx]
        
        # Create an independent blank page to prevent overlay bleeding
        page = out_doc.new_page(width=pw, height=ph)
        
        # Copy boxes, resources, and annotations natively from the cached blueprint
        for box in ["/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"]:
            if box in base_page.obj:
                page._page.obj[box] = base_page.obj[box]
                
        if "/Resources" in base_page.obj:
            new_res = pikepdf.Dictionary()
            for k, v in base_page.obj["/Resources"].items():
                if isinstance(v, pikepdf.Dictionary):
                    new_res[k] = pikepdf.Dictionary(v)
                else:
                    new_res[k] = v
            page._page.obj["/Resources"] = new_res
            
        if "/Annots" in base_page.obj:
            page._page.obj["/Annots"] = base_page.obj["/Annots"]
            
        # VERY IMPORTANT: Isolate the Contents array so appending the VDP overlay doesn't bleed to other pages
        new_contents = pikepdf.Array()
        old_contents = base_page.obj.get("/Contents")
        if old_contents is not None:
            if isinstance(old_contents, pikepdf.Array):
                new_contents.extend(old_contents)
            else:
                new_contents.append(old_contents)
        page._page.obj["/Contents"] = new_contents
        
        # NO need to call show_pdf_page for the template! The native contents are already copied.
        
        # Create ReportLab canvas covering the entire MediaBox
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(pw, ph))
        
        render_one_record(c, fields_dict, row, field_rects, pw, ph, field_font_variants)
                
        c.showPage()
        c.save()
        
        # Merge overlay onto page
        overlay_pdf = pdf_lib.open(stream=buf.getvalue())
        page.show_pdf_page(page.rect, overlay_pdf, 0)

        # Giải phóng tài nguyên overlay của record này. XObject đã được copy_foreign
        # vào out_doc và add_resource lên trang nên VẪN nằm trong output → an toàn để
        # đóng handle nguồn. Đồng thời xoá entry vừa thêm khỏi _nup_xobj_cache: mỗi
        # overlay VDP có UID riêng ⇒ cache LUÔN miss (không tái dùng được), nếu giữ
        # lại chỉ làm phình RAM tuyến tính theo số record trong vòng nóng. Phần copy
        # nặng vẫn chạy y như cũ nên tốc độ/record KHÔNG đổi (audit vdp-upgrade).
        try:
            overlay_pdf.close()
        except Exception:
            pass
        _xobj_cache = getattr(out_doc._pdf, "_nup_xobj_cache", None)
        if _xobj_cache:
            _xobj_cache.clear()

        count += 1
        if progress_file and count % 50 == 0:
            try:
                with open(progress_file, 'w') as f:
                    f.write(str(count))
            except Exception:
                pass
                
    if progress_file:
        try:
            with open(progress_file, 'w') as f:
                f.write(str(count))
        except Exception:
            pass
                
    if cancel_chunk_if_requested():
        return ""

    chunk_owner = f"{job_id}_" if job_id else ""
    tmp_path = os.path.join(tempfile.gettempdir(), f"vdp_chunk_{chunk_owner}{uuid.uuid4().hex}.pdf")
    # POST-PROCESS: Remove the cached template pages so they don't appear in the final output
    for _ in range(template_page_count):
        del out_doc._pdf.pages[0]
        
    out_doc.save(tmp_path, garbage=0, deflate=False)
    out_doc.close()
    doc_template.close()
    return tmp_path

def _canonicalize_template_to_cropbox(template_path: str) -> tuple:
    """Chuẩn hoá template về hệ toạ độ mà VDP giả định: vùng hiển thị bắt đầu ở
    gốc (0,0), MediaBox = khổ hiển thị THẬT, và /Rotate = 0. Trả (path, is_temp);
    không cần đổi → (template_path, False).

    Vì sao cần: cả preview lẫn run đặt field theo gốc (0,0) + kích thước theo
    MediaBox (render_one_record dùng pw/ph = MediaBox; show_pdf_page đặt overlay
    tại rect gốc 0,0 — xem pdf_ops.page_rect luôn trả Rect(0,0,mb_w,mb_h)). Giả
    định ngầm: "MediaBox LÀ vùng hiển thị, bắt đầu ở (0,0), không xoay". Hai thứ
    phá giả định này:

    1. CropBox lệch MediaBox (sau khi Crop chỉ set CropBox) → viewer render theo
       CropBox có gốc lệch → field lệch cả VỊ TRÍ lẫn KHỔ.
    2. /Rotate ≠ 0 → viewer (pdfium) hiển thị trang ĐÃ XOAY và báo khổ đã hoán w/h
       (xem get_pdf_metadata bên Rust), nên field đặt theo khổ đã xoay; nhưng nếu
       backend render theo MediaBox CHƯA xoay thì lệch cả vị trí lẫn trục.

    Cả hai được canonical hoá 1 LẦN bằng cách bọc nội dung trong ``q <cm> ... Q``:
    dịch gốc vùng crop về (0,0) RỒI xoay theo /Rotate (clockwise, hệ PDF y-up), đặt
    MediaBox/CropBox = khổ hiển thị (hoán w/h khi 90/270) và /Rotate = 0. Sau đó cả
    preview lẫn output tự khớp với view chính mà không phải sửa từng chỗ đặt toạ độ.
    """
    import pikepdf
    pdf = pikepdf.Pdf.open(template_path)
    changed = False
    try:
        for page in pdf.pages:
            rotate = int(page.get("/Rotate", 0) or 0) % 360
            mb = [float(x) for x in page.MediaBox]
            if "/CropBox" in page:
                cb = [float(x) for x in page.CropBox]
            else:
                cb = mb
            cx0, cy0, cx1, cy1 = cb
            crop_matches_media = (
                abs(cx0 - mb[0]) < 0.01 and abs(cy0 - mb[1]) < 0.01
                and abs(cx1 - mb[2]) < 0.01 and abs(cy1 - mb[3]) < 0.01
            )
            # Gốc vùng hiển thị đã ở (0,0)? pdfium (view chính) LUÔN chuẩn hoá gốc
            # vùng hiển thị về (0,0); nếu gốc box ≠ (0,0) — dù MediaBox = CropBox (chỉ
            # là MediaBox có offset, ví dụ [10,20,610,812]) — backend đặt overlay tại
            # (0,0) sẽ lệch đúng offset đó. Phải canonical hoá cả case này.
            display_at_origin = abs(cx0) < 0.01 and abs(cy0) < 0.01
            # Đã canonical (vùng hiển thị = MediaBox, gốc (0,0), không xoay) → bỏ qua.
            if crop_matches_media and display_at_origin and rotate == 0:
                continue

            cw = cx1 - cx0
            ch = cy1 - cy0

            # Ma trận cm: crop-về-gốc RỒI xoay clockwise theo /Rotate, đưa nội dung
            # vào góc phần tư dương. Điểm nội dung gốc (X,Y) → toạ độ canonical.
            # new_w/new_h là khổ hiển thị (hoán w/h cho 90/270).
            if rotate == 90:
                mtx = (0.0, -1.0, 1.0, 0.0, -cy0, cx0 + cw)
                new_w, new_h = ch, cw
            elif rotate == 180:
                mtx = (-1.0, 0.0, 0.0, -1.0, cx0 + cw, cy0 + ch)
                new_w, new_h = cw, ch
            elif rotate == 270:
                mtx = (0.0, 1.0, -1.0, 0.0, cy0 + ch, -cx0)
                new_w, new_h = ch, cw
            else:  # rotate == 0, chỉ crop lệch
                mtx = (1.0, 0.0, 0.0, 1.0, -cx0, -cy0)
                new_w, new_h = cw, ch

            ma, mb_, mc, md, me, mf = mtx
            # Bọc nội dung trong q..Q + cm. q/Q bảo toàn cân bằng graphics-state dù
            # stream gốc có để lại trạng thái.
            page.contents_coalesce()
            stream = page.obj["/Contents"]
            old = stream.read_bytes()
            prefix = (
                f"q {ma:.6g} {mb_:.6g} {mc:.6g} {md:.6g} {me:.4f} {mf:.4f} cm\n"
            ).encode("ascii")
            stream.write(prefix + old + b"\nQ")

            page.MediaBox = pikepdf.Array([0, 0, new_w, new_h])
            page.CropBox = pikepdf.Array([0, 0, new_w, new_h])
            if rotate != 0:
                page.Rotate = 0  # đã bake vào content → không để viewer xoay lần nữa
            # Các box khác (nếu có): biến đổi 4 góc qua CÙNG ma trận rồi lấy bao lồi.
            for box in ("/TrimBox", "/ArtBox", "/BleedBox"):
                if box in page:
                    b4 = [float(x) for x in page[box]]
                    corners = [
                        (b4[0], b4[1]), (b4[2], b4[1]),
                        (b4[2], b4[3]), (b4[0], b4[3]),
                    ]
                    xs = [ma * px + mc * py + me for px, py in corners]
                    ys = [mb_ * px + md * py + mf for px, py in corners]
                    page[box] = pikepdf.Array([min(xs), min(ys), max(xs), max(ys)])
            changed = True
        if not changed:
            pdf.close()
            return template_path, False
        out = os.path.join(tempfile.gettempdir(), f"vdp_canon_{uuid.uuid4().hex}.pdf")
        pdf.save(out)
        pdf.close()
        return out, True
    except Exception as e:
        logger.warning(f"VDP canonicalize CropBox/Rotate skipped ({e}); dùng template gốc.")
        try:
            pdf.close()
        except Exception:
            pass
        return template_path, False


def _plan_vdp_parallelism(record_count: int) -> tuple[int, int, str]:
    """Trả số worker thực chạy, kích thước chunk và lý do chọn tài nguyên."""
    # PERF (audit 2026-08-05 §PERF.2): VDP từng luôn lấy CPU-1, khiến máy ít RAM
    # nhưng nhiều lõi có thể mở 15 process. Policy chung chỉ giảm máy <16 GB;
    # máy >=16 GB vẫn chạy full và env cho phép người vận hành ghi đè.
    worker_budget, reason = plan_worker_count(
        kind="vdp",
        per_worker_mb=1024.0,
        env_override="PRYNX_VDP_WORKERS",
    )
    if record_count <= 0:
        return 0, 100, reason
    optimal_chunk_size = math.ceil(record_count / worker_budget)
    chunk_size = max(100, optimal_chunk_size)
    num_chunks = math.ceil(record_count / chunk_size)
    return min(num_chunks, worker_budget), chunk_size, reason


def _estimate_vdp_variable_image_bytes(
    fields_dict: List[Dict],
    data: List[Dict[str, str]],
    cancel_check=None,
) -> int:
    """Cộng byte ảnh sẽ được nhúng theo từng record, có cache stat theo path."""
    image_fields = [field for field in fields_dict if field.get("type") == "image"]
    if not image_fields or not data:
        return 0
    path_cache = {}
    size_cache = {}
    total_bytes = 0
    for record_index, row in enumerate(data):
        if record_index % 256 == 0 and cancel_check and cancel_check():
            return total_bytes
        for field in image_fields:
            try:
                resolved = resolve_field_content(field, row)
            except ConditionError:
                continue
            if not resolved.visible:
                continue
            value = resolved.content
            if (not value) or (value.startswith("{") and value.endswith("}")):
                value = field.get("imagePath") or ""
            key = (
                str(value or ""),
                str(field.get("imageBaseDir") or ""),
                str(field.get("imagePath") or ""),
            )
            if key not in path_cache:
                path_cache[key] = _resolve_image_path(*key)
            image_path = path_cache[key]
            if not image_path:
                continue
            if image_path not in size_cache:
                try:
                    size_cache[image_path] = max(0, os.path.getsize(image_path))
                except OSError:
                    size_cache[image_path] = 0
            total_bytes += size_cache[image_path]
    return total_bytes


def run_vdp_engine(template_path: str, fields: List[VdpField], data: List[Dict[str, str]], output_path: str, job_id: str = None, **kwargs):
    from concurrent.futures import ProcessPoolExecutor

    cancel_file = kwargs.pop("cancel_file", None)
    cancel_check = kwargs.pop("cancel_check", None)
    chunk_paths = []
    canonical_temp_path = None

    def cancellation_requested() -> bool:
        try:
            callback_cancelled = bool(cancel_check and cancel_check())
        except Exception:
            callback_cancelled = False
        return callback_cancelled or _vdp_cancel_file_exists(cancel_file)

    def abort_if_requested() -> None:
        if not cancellation_requested():
            return
        paths = list(chunk_paths)
        if job_id:
            paths.extend(glob.glob(os.path.join(tempfile.gettempdir(), f"vdp_chunk_{job_id}_*.pdf")))
        paths.append(output_path)
        if canonical_temp_path:
            paths.append(canonical_temp_path)
        for path in paths:
            try:
                if path and os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
        raise VdpCancelledError("VDP job cancelled")

    abort_if_requested()
    fields_dict = [f.model_dump() for f in fields]
    num_workers, CHUNK_SIZE, worker_reason = _plan_vdp_parallelism(len(data))
    num_chunks = math.ceil(len(data) / CHUNK_SIZE)
    variable_image_bytes = _estimate_vdp_variable_image_bytes(
        fields_dict, data, cancel_check=cancellation_requested,
    )
    abort_if_requested()
    try:
        template_bytes = os.path.getsize(template_path)
    except OSError:
        template_bytes = 0
    # PERF (audit 2026-08-05 §PERF.7): kiểm trước khi canonicalize/fan-out;
    # ảnh VDP được tính theo số lần nhúng thật, không chỉ theo số record.
    ensure_job_disk_space(
        "tạo file dữ liệu biến đổi VDP",
        output_path,
        tempfile.gettempdir(),
        estimate_vdp_disk(
            template_bytes=template_bytes,
            record_count=len(data),
            chunk_count=num_chunks,
            variable_image_bytes=variable_image_bytes,
        ),
    )
    # Chuẩn hoá CropBox→MediaBox (sau Crop) MỘT LẦN trước khi fan-out chunk.
    template_path, _canon_tmp = _canonicalize_template_to_cropbox(template_path)
    canonical_temp_path = template_path if _canon_tmp else None
    abort_if_requested()
    logger.info(
        "[VDP] %s records=%d chunks=%d active_workers=%d chunk_size=%d",
        worker_reason,
        len(data),
        num_chunks,
        num_workers,
        CHUNK_SIZE,
    )
    
    chunks = []
    for i in range(0, len(data), CHUNK_SIZE):
        chunks.append(data[i:i+CHUNK_SIZE])
        
    args_list = []
    chunk_start_idx = 0
    for idx, chunk in enumerate(chunks):
        prog_file = os.path.join(tempfile.gettempdir(), f"vdp_prog_{job_id}_{idx}.txt") if job_id else None
        args_list.append((template_path, fields_dict, chunk, chunk_start_idx, prog_file, cancel_file, job_id))
        chunk_start_idx += len(chunk)
        
    if len(args_list) > 0:
        if num_workers <= 1 or len(args_list) == 1:
            for args in args_list:
                chunk_paths.append(process_chunk(args))
        else:
            with ProcessPoolExecutor(max_workers=num_workers) as pool:
                chunk_paths = list(pool.map(process_chunk, args_list))
    
    # Chunk đã đọc xong template → xoá bản canonical tạm (nếu có).
    abort_if_requested()
    if any(not path for path in chunk_paths):
        raise VdpCancelledError("VDP job cancelled")
    if _canon_tmp:
        try:
            os.remove(template_path)
        except Exception:
            pass
        canonical_temp_path = None

    abort_if_requested()
    if 'on_saving' in kwargs and kwargs['on_saving']:
        kwargs['on_saving']()
    abort_if_requested()

    import pypdfium2 as pdfium
    # PERF (audit 2026-08-05 §PERF.2): VDP chạy trong executor thread; chỉ khóa
    # quanh lời gọi PDFium, không giữ khóa lúc xóa chunk hay tối ưu bằng pikepdf.
    with pdfium_guard():
        final_doc = pdfium.PdfDocument.new()
    try:
        for chunk_pdf_path in chunk_paths:
            abort_if_requested()
            with pdfium_guard():
                src_pdf = pdfium.PdfDocument(chunk_pdf_path)
                try:
                    final_doc.import_pages(src_pdf)
                finally:
                    src_pdf.close()
            try:
                os.remove(chunk_pdf_path)
            except Exception:
                pass

        with pdfium_guard():
            final_doc.save(output_path)
    finally:
        with pdfium_guard():
            final_doc.close()
    abort_if_requested()

    # #5 Tối ưu output: nén stream + object streams (gom object) trong CÙNG một
    # pass pikepdf với watermark → giảm đáng kể dung lượng (trước đây deflate=False,
    # pdfium lưu không nén). Lưu ý: đây là tối ưu thực dụng, KHÔNG phải PDF/VT đầy đủ.
    _wm_license = kwargs.get('_license_key', '')
    _wm_hwid = kwargs.get('_hwid', '')
    try:
        import pikepdf
        import os as _os, tempfile as _tempfile
        with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
            if _wm_license:
                try:
                    from app.core.watermark import embed_watermark
                    embed_watermark(pdf, _wm_license, _wm_hwid)
                except Exception as e:
                    logger.error(f"VDP watermark failed: {e}")
            # Ghi atomic: temp cùng thư mục rồi os.replace (tránh hỏng output nếu chết giữa chừng).
            _fd, _tmp = _tempfile.mkstemp(suffix=".pdf", dir=_os.path.dirname(output_path) or ".")
            _os.close(_fd)
            pdf.save(
                _tmp,
                compress_streams=True,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
            )
        _os.replace(_tmp, output_path)
    except Exception as e:
        logger.error(f"VDP optimize/watermark pass failed: {e}")

    abort_if_requested()
    return output_path
