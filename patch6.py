import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(
    "if src_page_idx >= page_count:",
    "print('cell_on_sheet_idx', cell_on_sheet_idx, 'src_page_idx', src_page_idx, 'page_count', total_page_count)\n                            if src_page_idx >= total_page_count:"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
