"""
layout_cut_model.py — Dựng CutModel GẮN NHÃN D1/D2/S từ layout cells (phương án B1).

Lấy đúng cells của layout (có c,r,x,y,width,height) — KHÔNG trích từ PDF merge —
nên giữ đúng vị trí + chỉ số cột Prynx thực sự bình ra. Gắn nhãn dao theo TOÁN CỘT
(blade_routing.assign_blade) khớp script JSX.

Logic chứa ở module này; nup_engine chỉ cần hook mỏng truyền (cells, base, die) vào.

Công thức vị trí tuyệt đối (khớp nup_engine):
    abs_x = base_x + cell.x
    abs_y_bottom = base_y_bottom + (content_h - cell.y - cell.height)   # Y-up, gốc dưới-trái
"""

from __future__ import annotations

from typing import Optional

from app.workers.cut_export.cut_model import CutModel, CutPath, RegMark
from app.workers.cut_export.blade_routing import assign_blade, BLADE_SLOT


def _num_cols_from_cells(cells: list[dict]) -> int:
    """Số cột = max(c)+1 nếu cells có 'c', ngược lại suy từ số X duy nhất."""
    cs = [int(c["c"]) for c in cells if "c" in c and c.get("c") is not None]
    if cs:
        return max(cs) + 1
    xs = sorted({round(float(c["x"]), 2) for c in cells})
    return len(xs)


def _col_index(cell: dict, x_to_col: dict) -> int:
    if "c" in cell and cell.get("c") is not None:
        return int(cell["c"])
    return x_to_col[round(float(cell["x"]), 2)]


def _place_shape(shape_pts, cell, base_x, base_y_bottom, content_h):
    """Map một shape (toạ độ trong khối lưới, gốc cell) → toạ độ tuyệt đối mm (Y-up).

    shape_pts: điểm tương đối trong ô (0..width, 0..height) — vd contour die đã chuẩn hoá.
    Nếu shape_pts None → dùng hình chữ nhật ô.
    """
    cx = float(cell["x"])
    cy = float(cell["y"])
    w = float(cell["width"])
    h = float(cell["height"])
    abs_x = base_x + cx
    abs_y_bottom = base_y_bottom + (content_h - cy - h)
    if shape_pts is None:
        return [
            (abs_x, abs_y_bottom),
            (abs_x + w, abs_y_bottom),
            (abs_x + w, abs_y_bottom + h),
            (abs_x, abs_y_bottom + h),
        ]
    return [(abs_x + px, abs_y_bottom + py) for (px, py) in shape_pts]


def build_tagged_cut_model_from_cells(
    cells: list[dict],
    *,
    base_x_mm: float,
    base_y_bottom_mm: float,
    content_h_mm: float,
    sheet_w_mm: float,
    sheet_h_mm: float,
    num_cols: Optional[int] = None,
    cell_shape: Optional[list] = None,
    marks: Optional[list[tuple]] = None,
    pont_config: Optional[dict] = None,
    dual_head: bool = True,
) -> CutModel:
    """Dựng CutModel gắn nhãn D1/D2/S từ cells layout.

    cell_shape: contour tương đối trong ô (mm, gốc dưới-trái ô) cho die-cut; None → ô chữ nhật.
    num_cols: nếu None → suy từ cells.
    dual_head: True → gắn tool_tag theo cột; False → tất cả 'shared'.
    """
    if not cells:
        raise ValueError("Không có cells layout để dựng cut model.")

    n_cols = num_cols if num_cols is not None else _num_cols_from_cells(cells)
    xs = sorted({round(float(c["x"]), 2) for c in cells})
    x_to_col = {x: i for i, x in enumerate(xs)}

    paths: list[CutPath] = []
    for cell in cells:
        col = _col_index(cell, x_to_col)
        tag = assign_blade(col, n_cols) if dual_head else "shared"
        pts = _place_shape(cell_shape, cell, base_x_mm, base_y_bottom_mm, content_h_mm)
        paths.append(CutPath(points=pts, closed=True, tool_tag=tag, block_id=BLADE_SLOT.get(tag, 0)))

    mark_objs: list[RegMark] = []
    for m in (marks or []):
        mark_objs.append(RegMark(m[0], m[1], m[2]) if len(m) >= 3 else RegMark(m[0], m[1]))

    src = {}
    if pont_config:
        src = {
            "group": pont_config.get("groupName", ""),
            "item": pont_config.get("itemName", ""),
            "layer": pont_config.get("layerName", ""),
        }

    model = CutModel(
        paths=paths, marks=mark_objs,
        sheet_w_mm=sheet_w_mm, sheet_h_mm=sheet_h_mm,
        source_names=src,
    )
    model.frame = model.compute_frame_from_marks()
    if model.is_empty:
        raise ValueError("Cut model rỗng.")
    return model
