//! Orchestrator — WRAPPER PyO3 mỏng quanh `imposition_core::orchestrator`
//! (Task 6 / Req 1.2). Chỉ chuyển đổi kiểu.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use imposition_core::orchestrator as core;
use imposition_core::sticker::{ClusterParams, ColAltParams, RowAltParams};

use super::sticker_layouts::opt_f64;
use super::shape_solvers::{item_to_pydict, props_from_pydict};

fn cluster(p: Option<&Bound<'_, PyDict>>) -> Option<ClusterParams> {
    p.map(|_| ClusterParams {
        dx: opt_f64(p, "dx"),
        dy: opt_f64(p, "dy"),
        dx_outer: opt_f64(p, "dx_outer"),
        dy_outer: opt_f64(p, "dy_outer"),
    })
}
fn row_alt(p: Option<&Bound<'_, PyDict>>) -> Option<RowAltParams> {
    p.map(|_| RowAltParams { offset_x: opt_f64(p, "offset_x"), row_h: opt_f64(p, "row_h"), step_x: opt_f64(p, "step_x") })
}
fn col_alt(p: Option<&Bound<'_, PyDict>>) -> Option<ColAltParams> {
    p.map(|_| ColAltParams { offset_y: opt_f64(p, "offset_y"), col_w: opt_f64(p, "col_w"), step_y: opt_f64(p, "step_y") })
}

fn candidate_to_pydict(py: Python<'_>, c: &core::LayoutCandidate) -> PyResult<PyObject> {
    let d = PyDict::new(py);
    let items: Vec<Py<PyDict>> = c.items.iter().map(|it| item_to_pydict(py, it)).collect::<PyResult<_>>()?;
    d.set_item("totalItems", c.total_items)?;
    d.set_item("items", items)?;
    d.set_item("widthUsed", c.width_used)?;
    d.set_item("heightUsed", c.height_used)?;
    d.set_item("strategyUsed", &c.strategy)?;
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, strategy="grid", p5_params=None, p6_params=None, p5_row_params=None, p6_row_params=None, p5_col_params=None, p6_col_params=None, shape_type="CUSTOM", shape_props=None))]
#[allow(clippy::too_many_arguments)]
pub fn generate_layout_candidates(
    py: Python<'_>,
    usable_w: f64, usable_h: f64,
    item_w: f64, item_h: f64,
    gap_x: f64, gap_y: f64,
    strategy: &str,
    p5_params: Option<&Bound<'_, PyDict>>,
    p6_params: Option<&Bound<'_, PyDict>>,
    p5_row_params: Option<&Bound<'_, PyDict>>,
    p6_row_params: Option<&Bound<'_, PyDict>>,
    p5_col_params: Option<&Bound<'_, PyDict>>,
    p6_col_params: Option<&Bound<'_, PyDict>>,
    shape_type: &str,
    shape_props: Option<&Bound<'_, PyDict>>,
) -> PyResult<PyObject> {
    let params = core::OrchestratorParams {
        p5: cluster(p5_params),
        p6: cluster(p6_params),
        p5_row: row_alt(p5_row_params),
        p6_row: row_alt(p6_row_params),
        p5_col: col_alt(p5_col_params),
        p6_col: col_alt(p6_col_params),
    };
    let sp = match shape_props {
        Some(d) => props_from_pydict(d),
        None => Default::default(),
    };

    let candidates = core::generate_layout_candidates(
        usable_w, usable_h, item_w, item_h, gap_x, gap_y, strategy, &params, shape_type, &sp,
    );

    let out = PyList::empty(py);
    for c in &candidates {
        let d = candidate_to_pydict(py, c)?;
        let t = (d, c.rotated, c.strategy.clone()).into_pyobject(py)?;
        out.append(t)?;
    }
    Ok(out.into())
}
