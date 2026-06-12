//! Grid solver — WRAPPER PyO3 mỏng. Toàn bộ toán nằm ở `imposition_core::grid`
//! (Task 6 / Req 1.2). File này chỉ chuyển đổi kiểu Py ↔ struct lõi.

use pyo3::prelude::*;
use pyo3::types::PyDict;
use imposition_core::grid as core;

fn cell_to_pydict(py: Python<'_>, c: &core::GridCell) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("c", c.c)?;
    d.set_item("r", c.r)?;
    d.set_item("x", c.x)?;
    d.set_item("y", c.y)?;
    d.set_item("width", c.width)?;
    d.set_item("height", c.height)?;
    d.set_item("isRotated", c.is_rotated)?;
    d.set_item("blockId", c.block_id)?;
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated=false))]
pub fn solve_grid(
    py: Python<'_>,
    usable_w: f64, usable_h: f64,
    item_w: f64, item_h: f64,
    gap_x: f64, gap_y: f64,
    is_rotated: bool,
) -> PyResult<PyObject> {
    let g = core::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated);
    let d = PyDict::new(py);
    d.set_item("cols", g.cols)?;
    d.set_item("rows", g.rows)?;
    d.set_item("width", g.width)?;
    d.set_item("height", g.height)?;
    d.set_item("isRotated", g.is_rotated)?;
    let cells: Vec<Py<PyDict>> = g.cells.iter().map(|c| cell_to_pydict(py, c)).collect::<PyResult<_>>()?;
    d.set_item("cells", cells)?;
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy="simple_auto", secondary_gap=None))]
pub fn solve_optimal_layout(
    py: Python<'_>,
    usable_w: f64, usable_h: f64,
    orig_w: f64, orig_h: f64,
    gap_x: f64, gap_y: f64,
    strategy: &str,
    secondary_gap: Option<f64>,
) -> PyResult<PyObject> {
    let r = core::solve_optimal_layout(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy, secondary_gap);
    let d = PyDict::new(py);
    d.set_item("totalItems", r.total_items)?;
    d.set_item("overallWidth", r.overall_width)?;
    d.set_item("overallHeight", r.overall_height)?;
    d.set_item("isRotated", r.is_rotated)?;
    d.set_item("cols", r.cols)?;
    d.set_item("rows", r.rows)?;
    let cells: Vec<Py<PyDict>> = r.cells.iter().map(|c| cell_to_pydict(py, c)).collect::<PyResult<_>>()?;
    d.set_item("cells", cells)?;
    Ok(d.into())
}

#[pyfunction]
pub fn solve_manual(
    py: Python<'_>,
    item_w: f64, item_h: f64,
    gap_x: f64, gap_y: f64,
    cols: usize, rows: usize,
) -> PyResult<PyObject> {
    let r = core::solve_manual(item_w, item_h, gap_x, gap_y, cols, rows);
    let d = PyDict::new(py);
    d.set_item("totalItems", r.total_items)?;
    d.set_item("overallWidth", r.overall_width)?;
    d.set_item("overallHeight", r.overall_height)?;
    d.set_item("isRotated", r.is_rotated)?;
    d.set_item("cols", r.cols)?;
    d.set_item("rows", r.rows)?;
    let cells: Vec<Py<PyDict>> = r.cells.iter().map(|c| cell_to_pydict(py, c)).collect::<PyResult<_>>()?;
    d.set_item("cells", cells)?;
    Ok(d.into())
}

#[pyfunction]
pub fn get_src_page_idx(
    sheet_idx: usize,
    cell_on_sheet_idx: usize,
    layout_type: &str,
    total_capacity: usize,
    page_count: usize,
) -> usize {
    core::get_src_page_idx(sheet_idx, cell_on_sheet_idx, layout_type, total_capacity, page_count)
}
