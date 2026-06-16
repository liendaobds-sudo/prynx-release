import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace(
    "placements = _native.compute_placements(",
    "placements = _native.compute_placements(\n                    "
)

text = text.replace(
    "total_capacity=total_capacity,\n                    page_count=page_count,\n                    sheet_mapping=sheet_mapping,\n                )",
    "total_capacity=total_capacity,\n                    page_count=page_count,\n                    sheet_mapping=sheet_mapping,\n                )\n                with open('placements_debug.json', 'w') as f_dbg:\n                    import json; json.dump(placements, f_dbg)"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
