"""
Test parity between TS hex approach (transpose) and Python hex approach (direct vertical).
"""
import math
import sys
sys.path.insert(0, r'd:\pdfcompare\backend')

from app.workers.sticker_imposer import (
    calculate_staggered_hex_layout,
    calculate_staggered_vertical_layout,
    solve_optimal_sticker_layout,
)

# Simulate TS "transpose" approach:
# TS column layout = row_stagger(usableH, usableW, origH, origW, gapY, gapX) then transpose
def ts_transpose_column_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y):
    """Simulate TS's colOrigRaw → transpose approach"""
    # TS: calculateStaggeredHexLayoutCore(usableH, usableW, origH, origW, gapY, gapX)
    raw = calculate_staggered_hex_layout(usable_h, usable_w, item_h, item_w, gap_y, gap_x)
    
    # Transpose: swap x↔y, width↔height  
    transposed_items = []
    for it in raw['items']:
        transposed_items.append({
            'c': it['c'], 'r': it['r'],
            'x': it['y'],
            'y': it['x'],
            'width': it['height'],
            'height': it['width'],
            'isRotated': it.get('isRotated', False),
        })
    return {
        'totalItems': raw['totalItems'],
        'items': transposed_items,
        'widthUsed': raw['heightUsed'],  # swap
        'heightUsed': raw['widthUsed'],  # swap
    }


test_cases = [
    # (usableW, usableH, itemW, itemH, gapX, gapY)
    (320, 450, 50, 50, 2, 2),
    (300, 300, 30, 30, 0, 0),
    (500, 700, 40, 60, 3, 3),
    (700, 500, 60, 40, 3, 3),
    (1000, 700, 80, 50, 5, 5),
    (400, 400, 35, 55, 2, 2),
    (600, 800, 45, 45, 4, 4),
    (350, 500, 25, 40, 1, 1),
    (800, 600, 70, 30, 2, 2),
    (250, 250, 20, 20, 0, 0),
]

print("=" * 120)
print(f"{'Test Case':<50} {'Py Vertical':>12} {'TS Transpose':>13} {'Match':>6}")
print("=" * 120)

all_pass = True
for tc in test_cases:
    usableW, usableH, itemW, itemH, gapX, gapY = tc
    
    # Python direct vertical stagger
    py_v = calculate_staggered_vertical_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    
    # TS transpose approach
    ts_v = ts_transpose_column_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    
    py_count = py_v['totalItems']
    ts_count = ts_v['totalItems']
    match = py_count == ts_count
    if not match:
        all_pass = False
    
    label = f"({usableW}x{usableH}, item={itemW}x{itemH}, gap={gapX},{gapY})"
    print(f"{label:<50} {py_count:>12} {ts_count:>13} {'✅' if match else '❌':>6}")

print("=" * 120)

# Now test the full 4-way evaluation
print("\n\n")
print("=" * 120)
print("FULL 4-WAY EVALUATION: Python vs TS (simulated)")
print("=" * 120)

for tc in test_cases:
    usableW, usableH, itemW, itemH, gapX, gapY = tc
    
    # Python 4-way (as in solve_optimal_sticker_layout HEXAGON path)
    p3 = calculate_staggered_hex_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    p4 = calculate_staggered_hex_layout(usableW, usableH, itemH, itemW, gapY, gapX)
    p3v = calculate_staggered_vertical_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    p4v = calculate_staggered_vertical_layout(usableW, usableH, itemH, itemW, gapY, gapX)
    
    py_candidates = sorted(
        [('p3_hRow', p3), ('p4_hRot', p4), ('p3v_vOrig', p3v), ('p4v_vRot', p4v)],
        key=lambda x: (x[1]['totalItems'], -x[1]['widthUsed']*x[1]['heightUsed']),
        reverse=True
    )
    
    # TS 4-way (simulated via transpose)
    rowOrig = calculate_staggered_hex_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    rowRot = calculate_staggered_hex_layout(usableW, usableH, itemH, itemW, gapY, gapX)
    colOrig = ts_transpose_column_layout(usableW, usableH, itemW, itemH, gapX, gapY)
    colRot = ts_transpose_column_layout(usableW, usableH, itemH, itemW, gapX, gapY)
    
    ts_candidates = sorted(
        [('rowOrig', rowOrig), ('rowRot', rowRot), ('colOrig', colOrig), ('colRot', colRot)],
        key=lambda x: (x[1]['totalItems'], -x[1]['widthUsed']*x[1]['heightUsed']),
        reverse=True
    )
    
    py_best_name, py_best = py_candidates[0]
    ts_best_name, ts_best = ts_candidates[0]
    
    py_best_count = py_best['totalItems']
    ts_best_count = ts_best['totalItems']
    match = py_best_count == ts_best_count
    
    label = f"({usableW}x{usableH}, item={itemW}x{itemH}, gap={gapX},{gapY})"
    if not match:
        all_pass = False
        print(f"❌ {label}")
        print(f"   PY winner: {py_best_name}={py_best_count}  | TS winner: {ts_best_name}={ts_best_count}")
        for name, cand in py_candidates:
            print(f"   PY  {name}: {cand['totalItems']}")
        for name, cand in ts_candidates:
            print(f"   TS  {name}: {cand['totalItems']}")
    else:
        print(f"✅ {label}  winner={py_best_name}({py_best_count}) vs {ts_best_name}({ts_best_count})")

print("=" * 120)
if all_pass:
    print("ALL TESTS PASSED ✅")
else:
    print("SOME TESTS FAILED ❌")
