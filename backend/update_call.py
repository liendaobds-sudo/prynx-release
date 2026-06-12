import re

with open('d:/pdfcompare/backend/app/workers/nup_engine.py', 'r', encoding='utf-8') as f:
    content = f.read()

pattern = r'''if strategy == 'head_to_tail' and overlap_pt < 0:
            gap_x \+= overlap_pt

        sticker_layout = solve_optimal_sticker_layout\(usable_w, usable_h, trim_w, trim_h, gap_x, gap_y, strategy, overlap_pt\)'''

replacement = '''if strategy == 'head_to_tail' and overlap_x_pt < 0:
            gap_x += overlap_x_pt

        sticker_layout = solve_optimal_sticker_layout(usable_w, usable_h, trim_w, trim_h, gap_x, gap_y, strategy, overlap_x_pt, overlap_y_pt)'''

content = re.sub(pattern, replacement, content)

with open('d:/pdfcompare/backend/app/workers/nup_engine.py', 'w', encoding='utf-8') as f:
    f.write(content)
