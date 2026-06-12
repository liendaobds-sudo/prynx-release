"""
Sticker Imposer Package — Layout solver for die-cut sticker imposition.

This package was refactored from a single 2300-line sticker_imposer.py file.
All public APIs are re-exported here for backward compatibility.

Usage:
    from app.workers.sticker_imposer_pkg import solve_optimal_sticker_layout
    # or
    from app.workers.sticker_imposer_pkg import solve_grid_layout, calculate_staggered_hex_layout
"""

# --- Utils ---
from .utils import (
    calculate_items_bounding_box,
    MY_SCRIPT_TOLERANCE,
)

# --- Grid & Stagger Layouts ---
from .grid_layouts import (
    solve_grid_layout,
    calculate_staggered_hex_layout,
    calculate_staggered_vertical_layout,
    calculate_hex_tiling_row_stagger,
    calculate_hex_tiling_col_stagger,
)

# --- Cluster & Alternating Layouts ---
from .cluster_layouts import (
    solve_cluster_grid_layout,
    solve_row_alternating_layout,
    solve_col_alternating_layout,
    _best_fill_layout,
)

# --- Shape-Specific Layouts ---
from .shape_layouts import (
    solve_pointy_top_hex_layout,
    solve_flat_top_hex_layout,
    solve_advanced_pentagon_layout,
    solve_advanced_triangle_layout,
    solve_illustrator_trapezoid_layout,
    solve_advanced_trapezoid_layout,
    solve_l_shape_layout,
)

# --- Asymmetric / Hammer / Dumbbell Layouts ---
from .asymmetric_layouts import (
    solve_dumbbell_pair_col_layout,
    solve_dumbbell_pair_row_layout,
    evaluate_unified_asymmetric,
    solve_illustrator_hammer_layout,
    solve_illustrator_dumbbell_layout,
)

# --- Main Orchestrator ---
from .orchestrator import solve_optimal_sticker_layout

# --- Collision Resolver ---
from .collision import resolve_layout_collisions
