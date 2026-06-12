import io
p = r'd:\pdfcompare\backend\app\api\routes\pdf_tools.py'
s = io.open(p, encoding='utf-8').read()
anchor = '    bleed_color_hex = form.get("bleed_color_hex", "#FFFFFF")\n'
add = (
    '\n    # Validate enum-like params -> avoid bad values reaching the engine.\n'
    '    if cut_mode not in ("original", "bleed", "none"):\n'
    '        cut_mode = "original"\n'
    '    if corner_style not in ("round", "square", "bevel", "mitre"):\n'
    '        corner_style = "round"\n'
    '    if bleed_color_type not in ("image", "inpaint", "solid"):\n'
    '        bleed_color_type = "image"\n'
)
assert s.count(anchor) == 1, s.count(anchor)
if 'Validate enum-like params' not in s:
    s = s.replace(anchor, anchor + add)
    io.open(p, 'w', encoding='utf-8').write(s)
    print("patched")
else:
    print("already patched")
