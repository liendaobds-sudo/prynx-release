import os
import io
import re
import math
import uuid
import logging
import datetime
import tempfile
from xml.sax.saxutils import escape as xml_escape

from app.workers import pdf_wrapper as pdf_lib
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

MM_TO_PTS = 2.83465

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


def process_chunk(args) -> str:
    template_path, fields_dict, data_chunk, chunk_start_idx, progress_file = args
    
    doc_template = pdf_lib.open(template_path)
    template_page_count = len(doc_template)
    out_doc = pdf_lib.open()
    
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
            # Frontend coordinates are MediaBox-relative (viewer shows MediaBox)
            # ReportLab origin is bottom-left, frontend origin is top-left
            rl_x = f_rect['x']
            rl_y = ph - f_rect['y'] - f_rect['h']
            
            text_content = field.get('textContent')
            if text_content is None:
                text_content = f"{{{field['name']}}}"
            # Thay placeholder: tách cột {Cot[2|-]} + định dạng {Cot|func:arg}
            #   func: upper|lower|title|trim|pad:N|padr:N|number:N|money:N|date:FMT
            # Cho phép 1 cột CSV chứa nhiều nội dung và biến đổi dữ liệu ngay khi merge.
            text_content = _substitute(text_content, row)
            val = text_content

            # #3 Image: cột rỗng / placeholder chưa map → dùng ảnh tĩnh (nếu có).
            if field['type'] == 'image':
                if (not val) or (val.startswith('{') and val.endswith('}')):
                    val = field.get('imagePath') or ''

            if not val:
                if field['type'] != 'image':
                    c.setFillColorCMYK(0, 1, 1, 0)  # đỏ (CMYK)
                    c.setFont("Helvetica", 8)
                    c.drawString(rl_x, rl_y + f_rect['h'] - 10, f"MISSING: {field['name']}")
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
                    # Map ĐẦY ĐỦ 7 loại UI cung cấp → tránh preview ≠ output (#6).
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
                    
                    # Màu vạch lấy từ barColor (fallback fontColor) — không dùng nhầm fontColor.
                    bar_color = field.get('barColor') or field.get('fontColor') or '#000000'
                    c_col = CMYKColor(*hex_to_cmyk(bar_color))
                    show_text = field.get('showText', True)
                    bc_kwargs = dict(value=val_str, barFillColor=c_col, humanReadable=bool(show_text))
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

                        c.saveState()
                        # Nền phủ TOÀN BỘ khung (bao gồm vùng lề trắng)
                        if not transparent_bg:
                            c.setFillColorCMYK(*hex_to_cmyk(field.get('bgColor', '#FFFFFF')))
                            c.rect(rl_x, rl_y, f_rect['w'], f_rect['h'], stroke=0, fill=1)

                        # Mã vạch lấp đầy vùng trong (khung trừ lề), đặt lệch theo lề.
                        inner_w = max(1.0, f_rect['w'] - 2 * qz_pts)
                        inner_h = max(1.0, f_rect['h'] - 2 * qz_pts)
                        c.translate(rl_x + qz_pts, rl_y + qz_pts)
                        c.scale(inner_w / intrinsic_w, inner_h / intrinsic_h)
                        renderPDF.draw(barcode, c, -x0, -y0)
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

                    # AUTO-FIT: bóp dần cỡ chữ tới khi đoạn văn (đã xuống dòng theo bề rộng
                    # khung) vừa CHIỀU CAO khung → tránh chữ tràn xuống dưới khung.
                    auto_fit = field.get('autoFit', True)
                    if auto_fit and h > f_rect['h']:
                        fs = float(fontsize)
                        guard = 0
                        while h > f_rect['h'] and fs > 2 and guard < 200:
                            fs -= max(0.5, fs * 0.06)
                            style = ParagraphStyle(
                                name='VDP',
                                fontName=font_name,
                                fontSize=fs,
                                textColor=text_color,
                                leading=fs * line_h,
                                alignment=text_align
                            )
                            p = Paragraph(text_html, style)
                            w, h = p.wrapOn(c, f_rect['w'], f_rect['h'])
                            guard += 1

                    # Canh GIỮA theo chiều dọc trong khung: chừa đều trên/dưới.
                    # #7: dùng font Bold/Italic THẬT khi có (need_faux_* = False);
                    # chỉ faux phần thiếu (bold = double-strike, italic = nghiêng shear).
                    ty = rl_y + (f_rect['h'] - h) / 2.0
                    if need_faux_bold or need_faux_italic:
                        c.saveState()
                        c.translate(rl_x, ty)
                        if need_faux_italic:
                            c.transform(1, 0, 0.21, 1, 0, 0)  # nghiêng ~12°
                        p.drawOn(c, 0, 0)
                        if need_faux_bold:
                            # vẽ lại lệch ~3% cỡ chữ → dày nét (giả bold)
                            p.drawOn(c, max(0.3, float(style.fontSize) * 0.03), 0)
                        c.restoreState()
                    else:
                        p.drawOn(c, rl_x, ty)
            except Exception as e:
                c.setFillColorCMYK(0, 1, 1, 0)  # đỏ (CMYK)
                c.setFont("Helvetica", 7)
                c.drawString(err_x, err_y + err_h - 10, f"ERR: {str(e)[:60]}")
            finally:
                if rotated:
                    c.restoreState()
                
        c.showPage()
        c.save()
        
        # Merge overlay onto page
        overlay_pdf = pdf_lib.open(stream=buf.getvalue())
        page.show_pdf_page(page.rect, overlay_pdf, 0)
        
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
                
    tmp_path = os.path.join(tempfile.gettempdir(), f"vdp_chunk_{uuid.uuid4().hex}.pdf")
    # POST-PROCESS: Remove the cached template pages so they don't appear in the final output
    for _ in range(template_page_count):
        del out_doc._pdf.pages[0]
        
    out_doc.save(tmp_path, garbage=0, deflate=False)
    out_doc.close()
    doc_template.close()
    return tmp_path

def run_vdp_engine(template_path: str, fields: List[VdpField], data: List[Dict[str, str]], output_path: str, job_id: str = None, **kwargs):
    from concurrent.futures import ProcessPoolExecutor
    import math
    
    fields_dict = [f.model_dump() for f in fields]
    available_cores = max(1, os.cpu_count() - 1)
    optimal_chunk_size = math.ceil(len(data) / available_cores) if available_cores > 0 else 5000
    CHUNK_SIZE = max(100, optimal_chunk_size)
    
    num_chunks = math.ceil(len(data) / CHUNK_SIZE)
    num_workers = min(num_chunks, available_cores)
    
    chunks = []
    for i in range(0, len(data), CHUNK_SIZE):
        chunks.append(data[i:i+CHUNK_SIZE])
        
    args_list = []
    chunk_start_idx = 0
    for idx, chunk in enumerate(chunks):
        prog_file = os.path.join(tempfile.gettempdir(), f"vdp_prog_{job_id}_{idx}.txt") if job_id else None
        args_list.append((template_path, fields_dict, chunk, chunk_start_idx, prog_file))
        chunk_start_idx += len(chunk)
        
    chunk_paths = []
    
    if len(args_list) > 0:
        if num_workers <= 1 or len(args_list) == 1:
            for args in args_list:
                chunk_paths.append(process_chunk(args))
        else:
            with ProcessPoolExecutor(max_workers=num_workers) as pool:
                chunk_paths = list(pool.map(process_chunk, args_list))
    
    if 'on_saving' in kwargs and kwargs['on_saving']:
        kwargs['on_saving']()
    
    import pypdfium2 as pdfium
    final_doc = pdfium.PdfDocument.new()
    for chunk_pdf_path in chunk_paths:
        src_pdf = pdfium.PdfDocument(chunk_pdf_path)
        final_doc.import_pages(src_pdf)
        src_pdf.close()
        try:
            os.remove(chunk_pdf_path)
        except Exception:
            pass
            
    final_doc.save(output_path)
    final_doc.close()

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

    return output_path
