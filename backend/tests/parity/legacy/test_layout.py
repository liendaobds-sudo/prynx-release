import sys
import logging
from app.workers.sticker_imposer_pkg.shape_layouts import _py_solve_advanced_trapezoid_layout
import app.workers.sticker_imposer_pkg._native as _native

usable_w = 847.56
usable_h = 1145.20
item_w = 145.39
item_h = 305.88
gap_x = 5.67
gap_y = 5.67
shape_props = {'leftOH': 9.35, 'rightOH': 9.35, 'isHorizontal': True, 'bbW': 145.19, 'bbH': 305.88}

res1 = _py_solve_advanced_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False)
res2 = _py_solve_advanced_trapezoid_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, True)
print(f"Python rot=False: {len(res1['items'])} items")
print(f"Python rot=True: {len(res2['items'])} items")

try:
    res3 = _native.shape_trapezoid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False)
    res4 = _native.shape_trapezoid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, True)
    print(f"Rust rot=False: {len(res3['items'])} items")
    print(f"Rust rot=True: {len(res4['items'])} items")
except Exception as e:
    print(f"Rust failed: {e}")

print("=============================")
usable_w2 = 878.74
res5 = _native.shape_trapezoid(usable_w2, usable_h, item_w, item_h, gap_x, gap_y, shape_props, False)
print(f"Rust rot=False (w={usable_w2}): {len(res5['items'])} items")
