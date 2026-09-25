"""Kiểm chứng cờ PDFium bằng fixture tự tạo; không sửa mã hoặc phiên app.

Chạy từ thư mục gốc: backend/venv/Scripts/python.exe
docs/audit/RENDER_LOAD_2026-09-24/native_render_audit_probe.py
"""
import ctypes as C
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parents[2]
DLL = ROOT / 'desktop/src-tauri/bin/pdfium.dll'
lib = C.CDLL(str(DLL))

def bind(name, args, result):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, result
    return fn

init = bind('FPDF_InitLibrary', [], None)
destroy = bind('FPDF_DestroyLibrary', [], None)
load = bind('FPDF_LoadMemDocument64', [C.c_void_p, C.c_size_t, C.c_char_p], C.c_void_p)
close = bind('FPDF_CloseDocument', [C.c_void_p], None)
page_load = bind('FPDF_LoadPage', [C.c_void_p, C.c_int], C.c_void_p)
page_close = bind('FPDF_ClosePage', [C.c_void_p], None)
bitmap_new = bind('FPDFBitmap_CreateEx', [C.c_int,C.c_int,C.c_int,C.c_void_p,C.c_int], C.c_void_p)
bitmap_close = bind('FPDFBitmap_Destroy', [C.c_void_p], None)
fill = bind('FPDFBitmap_FillRect', [C.c_void_p,C.c_int,C.c_int,C.c_int,C.c_int,C.c_ulong], None)
render = bind('FPDF_RenderPageBitmap', [C.c_void_p,C.c_void_p,C.c_int,C.c_int,C.c_int,C.c_int,C.c_int,C.c_int], None)

def pdf(objects):
    data = bytearray(b'%PDF-1.7\n')
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    start = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode())
    return bytes(data)

def stream(data, attrs=b''):
    return b'<< /Length ' + str(len(data)).encode() + b' ' + attrs + b' >>\nstream\n' + data + b'\nendstream'

def render_bytes(data, flags, alpha=255, format=4):
    memory = C.create_string_buffer(data)
    doc = load(memory, len(data), None)
    assert doc
    page = page_load(doc, 0)
    assert page
    pixels = (C.c_ubyte * (400 * 200 * 4))()
    bitmap = bitmap_new(400, 200, format, pixels, 1600)
    fill(bitmap, 0, 0, 400, 200, (alpha << 24) | 0xffffff)
    render(bitmap, page, 0, 0, 400, 200, 0, flags)
    result = np.frombuffer(pixels, np.uint8).reshape(200,400,4).copy()
    bitmap_close(bitmap)
    page_close(page)
    close(doc)
    return result

objects = [
    b'<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /ON [5 0 R 6 0 R] /AS [<< /Event /View /Category [/View] /OCGs [5 0 R 6 0 R] >> << /Event /Print /Category [/Print] /OCGs [5 0 R 6 0 R] >>] >> >> >>',
    b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Properties << /ViewOnly 5 0 R /PrintOnly 6 0 R >> /Font << /F1 9 0 R >> >> /Contents 4 0 R /Annots [7 0 R] >>',
    stream(b'/OC /ViewOnly BDC 1 0 0 rg 10 80 100 100 re f EMC /OC /PrintOnly BDC 0 1 0 rg 140 80 100 100 re f EMC BT /F1 12 Tf 10 30 Td (Text abc 123 0.1 0.5) Tj ET'),
    b'<< /Type /OCG /Name (ViewOnly) /Usage << /View << /ViewState /ON >> /Print << /PrintState /OFF >> >> >>',
    b'<< /Type /OCG /Name (PrintOnly) /Usage << /View << /ViewState /OFF >> /Print << /PrintState /ON >> >> >>',
    b'<< /Type /Annot /Subtype /Square /Rect [270 80 370 180] /F 0 /AP << /N 8 0 R >> >>',
    stream(b'0 0 1 rg 0 0 100 100 re f', b'/Type /XObject /Subtype /Form /BBox [0 0 100 100]'),
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]
fixture = pdf(objects)
text_fixture = pdf([
    b'<< /Type /Catalog /Pages 2 0 R >>',
    objects[1],
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream(b'BT /F1 11 Tf 10 130 Td (Small text ABC abc 123 0.1 0.5) Tj ET 0 0 0 RG 0.3 w 10 80 m 350 81 l S 10 50 m 50 15 200 100 350 20 c S'),
    objects[8],
])
(OUTPUT/'native_render_flags_fixture.pdf').write_bytes(fixture)
(OUTPUT/'native_render_text_fixture.pdf').write_bytes(text_fixture)
init()
try:
    view = render_bytes(fixture, 0x1 | 0x2)
    printing = render_bytes(fixture, 0x1 | 0x2 | 0x800)
    report = {'dll_sha256': hashlib.sha256(DLL.read_bytes()).hexdigest(), 'flags_probe': {}}
    for name, x in [('view_only_red', 60), ('print_only_green', 190), ('screen_annotation_blue',320)]:
        report['flags_probe'][name] = {'view_bgra': view[70,x].tolist(), 'printing_bgra': printing[70,x].tolist()}
    report['flags_probe']['changed_pixels'] = int(np.any(view != printing,axis=2).sum())
    variants = {}
    for name, flags, alpha, fmt in [('opaque_lcd', 2,255,4), ('transparent_lcd',2,0,4),('opaque_gray',0,255,4),('opaque_lcd_printing',2|0x800,255,4),('bgrx_lcd',2,255,3)]:
        a = render_bytes(text_fixture, flags, alpha, fmt)
        chromatic = np.max(a[:,:,:3],axis=2) != np.min(a[:,:,:3],axis=2)
        variants[name] = a
        report[name] = {'chromatic_pixels': int(chromatic.sum()), 'partial_alpha':int(((a[:,:,3]>0)&(a[:,:,3]<255)).sum())}
    report['opaque_lcd_vs_opaque_gray_changed'] = int(np.any(variants['opaque_lcd'] != variants['opaque_gray'],axis=2).sum())
    report['opaque_lcd_vs_printing_changed'] = int(np.any(variants['opaque_lcd'] != variants['opaque_lcd_printing'],axis=2).sum())
    # Ảnh trên dùng cờ màn hình, ảnh dưới thêm cờ in; đổi BGRA sang RGBA khi lưu.
    visual = np.vstack([view,printing])[:,:,[2,1,0,3]]
    Image.fromarray(visual).save(OUTPUT/'native_render_flags_probe.png')
    (OUTPUT/'native_render_flags_probe.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
finally:
    destroy()
