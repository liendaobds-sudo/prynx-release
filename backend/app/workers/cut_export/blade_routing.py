"""
blade_routing.py — Chia dao song đạo D1/D2/S theo TOÁN CỘT (port từ script JSX).

Bám sát `dev campuchia v5.6.jsx`:
- Main block (numCols ≥ 2): halfCols = floor(numCols/2);
    colIdx < halfCols          → _DTLeft  (D1, CMD:35,1)
    colIdx ≥ numCols - halfCols → _DTRight (D2, CMD:35,2)
    còn lại (cột giữa khi lẻ)   → _SHARED  (S, CMD:35,0)
- numCols ≤ 1 → _SHARED.
Fill block dùng CÙNG công thức (numFillCols).

Quy ước nhãn nội bộ: 'left' (D1), 'right' (D2), 'shared' (S).
Map sang lệnh: shared→CMD:35,0; left→CMD:35,1; right→CMD:35,2.
"""

from __future__ import annotations

LEFT = "left"     # _DTLeft  → CMD:35,1
RIGHT = "right"   # _DTRight → CMD:35,2
SHARED = "shared"  # _SHARED → CMD:35,0

# Map nhãn nội bộ → slot CMD:35.
BLADE_SLOT = {SHARED: 0, LEFT: 1, RIGHT: 2}


def assign_blade(col_idx: int, num_cols: int) -> str:
    """Gán nhãn dao theo chỉ số cột (0-based) và tổng số cột. Khớp toán script."""
    if num_cols <= 1:
        return SHARED
    half = num_cols // 2  # floor(numCols/2)
    if col_idx < half:
        return LEFT
    if col_idx >= num_cols - half:
        return RIGHT
    return SHARED


def assign_blades_for_columns(col_indices: list[int], num_cols: int) -> list[str]:
    """Tiện ích: gán nhãn cho một dãy chỉ số cột."""
    return [assign_blade(c, num_cols) for c in col_indices]
