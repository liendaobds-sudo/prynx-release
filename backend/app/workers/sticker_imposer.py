"""
sticker_imposer.py — BACKWARD-COMPATIBLE THIN WRAPPER.

This module was refactored into the `sticker_imposer_pkg` package.
All imports from `app.workers.sticker_imposer` continue to work unchanged.

Package structure:
  sticker_imposer_pkg/
  ├── __init__.py          — Re-exports all public APIs
  ├── utils.py             — Shared constants & bounding box
  ├── grid_layouts.py      — Grid, stagger, hex tiling (~310 lines)
  ├── cluster_layouts.py   — Cluster, row/col alternating (~375 lines)
  ├── shape_layouts.py     — Pentagon, triangle, trapezoid, L-shape (~594 lines)
  ├── asymmetric_layouts.py — Hammer, dumbbell, dumbbell pair (~625 lines)
  └── orchestrator.py      — solve_optimal_sticker_layout (~291 lines)
"""

# Re-export everything from the package for backward compatibility
from app.workers.sticker_imposer_pkg import *  # noqa: F401,F403
from app.workers.sticker_imposer_pkg import (
    # Explicit re-exports for IDE autocompletion
    solve_optimal_sticker_layout,
    solve_grid_layout,
    calculate_staggered_hex_layout,
    calculate_staggered_vertical_layout,
    calculate_hex_tiling_row_stagger,
    calculate_hex_tiling_col_stagger,
    solve_cluster_grid_layout,
    solve_row_alternating_layout,
    solve_col_alternating_layout,
    _best_fill_layout,
    solve_pointy_top_hex_layout,
    solve_flat_top_hex_layout,
    solve_advanced_pentagon_layout,
    solve_advanced_triangle_layout,
    solve_illustrator_trapezoid_layout,
    solve_advanced_trapezoid_layout,
    solve_l_shape_layout,
    solve_dumbbell_pair_col_layout,
    solve_dumbbell_pair_row_layout,
    evaluate_unified_asymmetric,
    solve_illustrator_hammer_layout,
    solve_illustrator_dumbbell_layout,
    calculate_items_bounding_box,
)
