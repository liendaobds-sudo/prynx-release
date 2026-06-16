import json
with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'r', encoding='utf-8') as f:
    text = f.read()

# Restore original
text = text.replace(
    "placements = _native.compute_placements(\n                    total_capacity=total_capacity,\n                    page_count=page_count,\n                    sheet_mapping=sheet_mapping,\n                )\n                with open('placements_debug.json', 'w') as f_dbg:\n                    import json; json.dump(placements, f_dbg)",
    "placements = _native.compute_placements(total_capacity=total_capacity, page_count=page_count, sheet_mapping=sheet_mapping)"
)

# Now add a print statement to see the size of placements
text = text.replace(
    "for p in placements:",
    "print('Number of placements in phase 2:', len(placements))\n        for p in placements:"
)

with open(r'd:\pdfcompare\backend\app\workers\nup_process_chunk.py', 'w', encoding='utf-8') as f:
    f.write(text)
