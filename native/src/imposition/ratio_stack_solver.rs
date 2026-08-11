//! ratio_stack solver — WRAPPER PyO3 mỏng. Toàn bộ toán nằm ở
//! `imposition_core::ratio_stack`. File này chỉ chuyển đổi kiểu Py ↔ struct lõi.

use imposition_core::ratio_stack as core;
use pyo3::prelude::*;
use pyo3::types::PyDict;

/// Phân bổ `capacity` ô của 1 tờ cho các mẫu theo tỷ lệ `qtys`.
///
/// Trả dict: { cellsPerPage: list[int], nSheets: int, unplaced: list[int] }.
#[pyfunction]
#[pyo3(signature = (capacity, qtys))]
pub fn solve_ratio_stack(py: Python<'_>, capacity: usize, qtys: Vec<i64>) -> PyResult<Py<PyAny>> {
    let r = core::solve_ratio_stack(capacity, &qtys);
    let d = PyDict::new(py);
    d.set_item("cellsPerPage", r.cells_per_page)?;
    d.set_item("nSheets", r.n_sheets)?;
    d.set_item("unplaced", r.unplaced)?;
    Ok(d.into())
}
