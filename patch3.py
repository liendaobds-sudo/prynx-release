import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(
    "Number of placements in phase 2:', len(placements)",
    "Number of placements in phase 2:', len(placements))\n        print('cur_cells len:', len(cur_cells))\n        print('capacity:', cur_capacity)\n        print('cx_count:', cx_count, 'cy_count:', cy_count"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
