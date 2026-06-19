import os
import io
import re
import uuid
import tempfile
from xml.sax.saxutils import escape as xml_escape

from app.workers import pdf_wrapper as pdf_lib
from app.schemas.vdp import VdpField
from typing import List, Dict

from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

MM_TO_PTS = 2.83465

def hex_to_rgb(hex_str: str) -> tuple:
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join(c + c for c in hex_str)
    return tuple(int(hex_str[i:i+2], 16)/255.0 for i in (0, 2, 4))


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
    
    # Register fonts once per chunk
    for field in fields_dict:
        if field.get('type') == 'text':
            font_file = field.get('fontFile')
            if font_file and os.path.exists(font_file):
                font_name = "f_" + field.get('id', 'default').replace('-', '')
                try:
                    pdfmetrics.registerFont(TTFont(font_name, font_file))
                except Exception:
                    pass
    
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
            # Frontend coordinates are MediaBox-relative (viewer shows MediaBox)
            # ReportLab origin is bottom-left, frontend origin is top-left
            rl_x = f_rect['x']
            rl_y = ph - f_rect['y'] - f_rect['h']
            
            text_content = field.get('textContent')
            if text_content is None:
                text_content = f"{{{field['name']}}}"
            # Tách phần theo chỉ số: {Cot[1]}, {Cot[2]} = token thứ n của cột.
            #   - Mặc định tách theo khoảng trắng.
            #   - Tuỳ chọn dấu phân cách: {Cot[1|-]}, {Cot[2|;]}, {Cot[1|, ]} ...
            # Cho phép 1 cột CSV chứa nhiều nội dung (vd "MAHANG 000001" hoặc "MAHANG-000001")
            # tách ra nhiều trường mà không cần sửa file CSV.
            def _part_repl(m):
                col = m.group(1)
                idx = int(m.group(2))
                delim = m.group(3)
                raw = str(row.get(col, ''))
                if delim:
                    parts = [p.strip() for p in raw.split(delim)]
                else:
                    parts = raw.split()
                return parts[idx - 1] if 1 <= idx <= len(parts) else ''
            text_content = re.sub(r'\{([^{}\[\]]+)\[(\d+)(?:\|([^\]]*))?\]\}', _part_repl, text_content)
            for key, value in row.items():
                text_content = text_content.replace(f"{{{key}}}", str(value))
            val = text_content

            if not val:
                c.setFillColorRGB(1, 0, 0)
                c.setFont("Helvetica", 8)
                c.drawString(rl_x, rl_y + f_rect['h'] - 10, f"MISSING: {field['name']}")
                continue
                
            # Toạ độ gốc (chưa xoay) để vẽ nhãn lỗi nếu cần
            err_x, err_y, err_h = rl_x, rl_y, f_rect['h']
            rotated = False
            try:
                color_t = hex_to_rgb(field.get('fontColor', '#000000')) if 'fontColor' in field else (0,0,0)

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
                    bg_color_t = hex_to_rgb(bg_color_hex)
                    # Màu chấm QR lấy từ qrStyle.dotColor (fallback fontColor).
                    qr_fg_hex = qr_style.get('dotColor') or field.get('fontColor') or '#000000'
                    qr_fg_t = hex_to_rgb(qr_fg_hex)
                    
                    import segno
                    qr = segno.make(val_str, error='L')
                    matrix = qr.matrix
                    
                    quiet_zone = 2 # 2 modules quiet zone is usually enough and looks better
                    
                    # Strip compression
                    strips = []
                    for r, row_data in enumerate(matrix):
                        col = 0
                        while col < len(row_data):
                            if row_data[col]:
                                start_c = col
                                while col < len(row_data) and row_data[col]:
                                    col += 1
                                # Add quiet zone offset
                                strips.append((start_c + quiet_zone, r + quiet_zone, col - start_c, 1))
                            else:
                                col += 1
                                
                    intrinsic_w = len(matrix) + quiet_zone * 2
                    intrinsic_h = len(matrix) + quiet_zone * 2
                    
                    if intrinsic_w > 0 and intrinsic_h > 0:
                        c.saveState()
                        scale = min(f_rect['w'] / intrinsic_w, f_rect['h'] / intrinsic_h)
                        draw_w = intrinsic_w * scale
                        draw_h = intrinsic_h * scale
                        
                        c.translate(rl_x + (f_rect['w'] - draw_w)/2, rl_y + (f_rect['h'] - draw_h)/2)
                        c.scale(scale, scale)
                        
                        if not transparent_bg:
                            c.setFillColorRGB(bg_color_t[0], bg_color_t[1], bg_color_t[2])
                            c.rect(0, 0, intrinsic_w, intrinsic_h, stroke=0, fill=1)
                            
                        c.setFillColorRGB(qr_fg_t[0], qr_fg_t[1], qr_fg_t[2])
                        
                        for x, y, w, h in strips:
                            c.rect(x, intrinsic_h - y - h, w, h, stroke=0, fill=1)
                            
                        c.restoreState()
                        
                elif field['type'] == 'barcode':
                    val_str = str(val)
                    if not val_str:
                        continue
                        
                    btype = (field.get('barcodeType') or field.get('barType') or 'code128').lower()
                    rl_btype = 'Code128'
                    if btype == 'ean13': rl_btype = 'EAN13'
                    elif btype == 'upca': rl_btype = 'UPCA'
                    elif btype == 'code39': rl_btype = 'Standard39'
                    
                    # Màu vạch lấy từ barColor (fallback fontColor) — không dùng nhầm fontColor.
                    bar_color = field.get('barColor') or field.get('fontColor') or '#000000'
                    c_col = Color(*hex_to_rgb(bar_color))
                    show_text = field.get('showText', True)
                    barcode = createBarcodeDrawing(rl_btype, value=val_str, barFillColor=c_col,
                                                   humanReadable=bool(show_text))
                    x0, y0, x1, y1 = barcode.getBounds()
                    intrinsic_w = x1 - x0
                    intrinsic_h = y1 - y0
                    
                    if intrinsic_w > 0 and intrinsic_h > 0:
                        c.saveState()
                        c.translate(rl_x, rl_y)
                        c.scale(f_rect['w'] / intrinsic_w, f_rect['h'] / intrinsic_h)
                        renderPDF.draw(barcode, c, -x0, -y0)
                        c.restoreState()
                elif field['type'] == 'text':
                    fontsize = field.get('fontSize', 10)
                    line_h = float(field.get('lineHeight') or 1.0)
                    font_file = field.get('fontFile')
                    font_name = "Helvetica"
                    if font_file and os.path.exists(font_file):
                        font_name = "f_" + field.get('id', 'default').replace('-', '')
                        
                    # Map frontend alignment to ReportLab alignment
                    align_map = {'left': TA_LEFT, 'center': TA_CENTER, 'right': TA_RIGHT}
                    raw_align = field.get('alignment', 'left')
                    text_align = align_map.get(raw_align, TA_LEFT)
                    
                    style = ParagraphStyle(
                        name='VDP',
                        fontName=font_name,
                        fontSize=fontsize,
                        textColor=Color(*color_t),
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
                                textColor=Color(*color_t),
                                leading=fs * line_h,
                                alignment=text_align
                            )
                            p = Paragraph(text_html, style)
                            w, h = p.wrapOn(c, f_rect['w'], f_rect['h'])
                            guard += 1

                    # Canh GIỮA theo chiều dọc trong khung: chừa đều trên/dưới.
                    p.drawOn(c, rl_x, rl_y + (f_rect['h'] - h) / 2.0)
            except Exception as e:
                c.setFillColorRGB(1, 0, 0)
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

    # Stealth watermark
    _wm_license = kwargs.get('_license_key', '')
    _wm_hwid = kwargs.get('_hwid', '')
    if _wm_license:
        try:
            import pikepdf
            from app.core.watermark import embed_watermark
            with pikepdf.Pdf.open(output_path, allow_overwriting_input=True) as pdf:
                embed_watermark(pdf, _wm_license, _wm_hwid)
                pdf.save(output_path)
        except Exception as e:
            logger.error(f"VDP watermark failed: {e}")

    return output_path
