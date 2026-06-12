//! Sticker layouts — WRAPPER PyO3 mỏng quanh `imposition_core::sticker`
//! (Task 6 / Req 1.2). Chỉ chuyển đổi kiểu; toán nằm ở lõi.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use imposition_core::sticker as core;

pub(crate) fn opt_f64(d: Option<&Bound<'_, PyDict>>, key: &str) -> Option<f64> {
    d.and_then(|p| p.get_item(key).ok().flatten())
        .and_then(|v| v.extract::<f64>().ok())
}

fn item_to_pydict(py: Python<'_>, it: &core::StickerItem) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("c", it.c)?;
    d.set_item("r", it.r)?;
    d.set_item("x", it.x)?;
    d.set_item("y", it.y)?;
    d.set_item("width", it.width)?;
    d.set_item("height", it.height)?;
    d.set_item("isRotated", it.is_rotated)?;
    d.set_item("isRotated180", it.is_rotated_180)?;
    d.set_item("blockId", it.block_id)?;
    Ok(d.into())
}

/// Chuyển StickerResult → PyDict giữ nguyên shape gốc (items/totalItems/...).
pub(crate) fn result_to_pydict(
    py: Python<'_>,
    r: &core::StickerResult,
    item_actual_w: f64,
    item_actual_h: f64,
) -> PyResult<PyObject> {
    let d = PyDict::new(py);
    let items: Vec<Py<PyDict>> = r.items.iter().map(|it| item_to_pydict(py, it)).collect::<PyResult<_>>()?;
    d.set_item("totalItems", r.total_items)?;
    d.set_item("items", items)?;
    d.set_item("widthUsed", r.width_used)?;
    d.set_item("heightUsed", r.height_used)?;
    d.set_item("itemActualW", item_actual_w)?;
    d.set_item("itemActualH", item_actual_h)?;
    if let Some(c) = r.cols { d.set_item("cols", c)?; }
    if let Some(rr) = r.rows { d.set_item("rows", rr)?; }
    Ok(d.into())
}

#[pyfunction]
pub fn sticker_solve_grid(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<PyObject> {
    let r = core::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    result_to_pydict(py, &r, item_w, item_h)
}

#[pyfunction]
pub fn sticker_staggered_hex(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<PyObject> {
    let r = core::staggered_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    result_to_pydict(py, &r, item_w, item_h)
}

#[pyfunction]
pub fn sticker_staggered_vertical(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<PyObject> {
    let r = core::staggered_vertical(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    result_to_pydict(py, &r, item_w, item_h)
}

#[pyfunction]
pub fn sticker_hex_tiling_row(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<PyObject> {
    let r = core::hex_tiling_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    result_to_pydict(py, &r, item_w, item_h)
}

#[pyfunction]
pub fn sticker_hex_tiling_col(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<PyObject> {
    let r = core::hex_tiling_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    result_to_pydict(py, &r, item_w, item_h)
}

fn cluster_params(p: Option<&Bound<'_, PyDict>>) -> Option<core::ClusterParams> {
    p.map(|_| core::ClusterParams {
        dx: opt_f64(p, "dx"),
        dy: opt_f64(p, "dy"),
        dx_outer: opt_f64(p, "dx_outer"),
        dy_outer: opt_f64(p, "dy_outer"),
    })
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, params, rotated))]
pub fn sticker_cluster_grid(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, params: Option<&Bound<'_, PyDict>>, rotated: bool) -> PyResult<PyObject> {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };
    let r = core::cluster_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, cluster_params(params), rotated);
    result_to_pydict(py, &r, w, h)
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, params, rotated))]
pub fn sticker_row_alternating(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, params: Option<&Bound<'_, PyDict>>, rotated: bool) -> PyResult<PyObject> {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };
    let rp = params.map(|_| core::RowAltParams {
        offset_x: opt_f64(params, "offset_x"),
        row_h: opt_f64(params, "row_h"),
        step_x: opt_f64(params, "step_x"),
    });
    let r = core::row_alternating(usable_w, usable_h, item_w, item_h, gap_x, gap_y, rp, rotated);
    result_to_pydict(py, &r, w, h)
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, params, rotated))]
pub fn sticker_col_alternating(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, params: Option<&Bound<'_, PyDict>>, rotated: bool) -> PyResult<PyObject> {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };
    let cp = params.map(|_| core::ColAltParams {
        offset_y: opt_f64(params, "offset_y"),
        col_w: opt_f64(params, "col_w"),
        step_y: opt_f64(params, "step_y"),
    });
    let r = core::col_alternating(usable_w, usable_h, item_w, item_h, gap_x, gap_y, cp, rotated);
    result_to_pydict(py, &r, w, h)
}
