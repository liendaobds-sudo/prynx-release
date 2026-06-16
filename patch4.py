import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(
    "cx_count: 1 cy_count: 1",
    "cx_count: 1 cy_count: 1')\n        print('total_capacity:', total_capacity, 'page_count:', page_count, 'sheet_idx:', sheet_idx"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
