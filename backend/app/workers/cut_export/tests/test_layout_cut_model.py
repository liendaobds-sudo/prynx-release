"""Test layout-aware cut model gắn nhãn D1/D2/S (task 15.2). Req 4.6."""

import pytest

from app.workers.cut_export.layout_cut_model import build_tagged_cut_model_from_cells


def _grid_cells(cols, rows, w=40, h=30):
    """Lưới cols×rows, ô w×h, không gap, kèm chỉ số c/r."""
    cells = []
    for r in range(rows):
        for c in range(cols):
            cells.append({"c": c, "r": r, "x": c * w, "y": r * h, "width": w, "height": h})
    return cells


def test_tags_follow_column_math_4cols():
    cells = _grid_cells(4, 2)
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=0, base_y_bottom_mm=0, content_h_mm=60,
        sheet_w_mm=200, sheet_h_mm=100, num_cols=4,
    )
    # 4 cột → half=2: cột 0,1=left; 2,3=right. Mỗi cột 2 ô.
    tags_by_col = {}
    for p in cm.paths:
        # cột suy từ x: 0,40,80,120 → 0,1,2,3
        col = round(p.points[0][0] / 40)
        tags_by_col.setdefault(col, set()).add(p.tool_tag)
    assert tags_by_col[0] == {"left"}
    assert tags_by_col[1] == {"left"}
    assert tags_by_col[2] == {"right"}
    assert tags_by_col[3] == {"right"}


def test_odd_cols_has_shared_middle():
    cells = _grid_cells(3, 1)
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=0, base_y_bottom_mm=0, content_h_mm=30,
        sheet_w_mm=150, sheet_h_mm=50, num_cols=3,
    )
    tags = [p.tool_tag for p in sorted(cm.paths, key=lambda q: q.points[0][0])]
    assert tags == ["left", "shared", "right"]


def test_absolute_position_formula():
    # 1 ô tại c=0,r=0, base=(10,20), content_h=30, ô 40x30.
    cells = [{"c": 0, "r": 0, "x": 0, "y": 0, "width": 40, "height": 30}]
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=10, base_y_bottom_mm=20, content_h_mm=30,
        sheet_w_mm=100, sheet_h_mm=100, num_cols=1,
    )
    pts = cm.paths[0].points
    # abs_x=10, abs_y_bottom = 20 + (30 - 0 - 30) = 20. Ô chữ nhật 40x30.
    assert (pts[0][0], pts[0][1]) == (10.0, 20.0)
    assert (pts[2][0], pts[2][1]) == (50.0, 50.0)


def test_row_position_flips_within_content():
    # 2 hàng: hàng r=0 (y=0) phải nằm TRÊN (abs_y cao) do flip content_h.
    cells = _grid_cells(1, 2, w=40, h=30)  # content_h = 60
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=0, base_y_bottom_mm=0, content_h_mm=60,
        sheet_w_mm=50, sheet_h_mm=70, num_cols=1,
    )
    # r=0 → abs_y_bottom = 0 + (60-0-30)=30 (trên); r=1 → 0+(60-30-30)=0 (dưới)
    ybottoms = sorted(p.points[0][1] for p in cm.paths)
    assert ybottoms == [0.0, 30.0]


def test_cell_shape_die_contour_placed():
    # Die tam giác tương đối trong ô (0..40,0..30).
    tri = [(0, 0), (40, 0), (20, 30)]
    cells = [{"c": 0, "r": 0, "x": 0, "y": 0, "width": 40, "height": 30}]
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=5, base_y_bottom_mm=5, content_h_mm=30,
        sheet_w_mm=100, sheet_h_mm=100, num_cols=1, cell_shape=tri,
    )
    pts = cm.paths[0].points
    assert pts == [(5.0, 5.0), (45.0, 5.0), (25.0, 35.0)]


def test_single_head_all_shared():
    cells = _grid_cells(4, 1)
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=0, base_y_bottom_mm=0, content_h_mm=30,
        sheet_w_mm=200, sheet_h_mm=50, num_cols=4, dual_head=False,
    )
    assert all(p.tool_tag == "shared" for p in cm.paths)


def test_infers_num_cols_from_cells():
    cells = _grid_cells(2, 1)
    cm = build_tagged_cut_model_from_cells(
        cells, base_x_mm=0, base_y_bottom_mm=0, content_h_mm=30,
        sheet_w_mm=100, sheet_h_mm=50,
    )
    tags = [p.tool_tag for p in sorted(cm.paths, key=lambda q: q.points[0][0])]
    assert tags == ["left", "right"]


def test_empty_cells_raises():
    with pytest.raises(ValueError):
        build_tagged_cut_model_from_cells(
            [], base_x_mm=0, base_y_bottom_mm=0, content_h_mm=0,
            sheet_w_mm=10, sheet_h_mm=10,
        )
