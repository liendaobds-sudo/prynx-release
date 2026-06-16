import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(
    "print('cur_cells len:', len(cur_cells))",
    "print('cur_cells len:', len(cur_cells))\n        print('placements:', placements)"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
