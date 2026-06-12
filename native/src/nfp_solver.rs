//! NFP solver — WRAPPER PyO3 mỏng quanh `imposition_core::nfp` (Task 6 / Req 1.2).

use pyo3::prelude::*;
use imposition_core::nfp::NfpSolver as CoreNfp;

#[pyclass]
pub struct NfpSolver {
    inner: CoreNfp,
}

#[pymethods]
impl NfpSolver {
    #[new]
    pub fn new(base_coords: Vec<(f64, f64)>, rot_coords: Vec<(f64, f64)>) -> Self {
        Self { inner: CoreNfp::new(base_coords, rot_coords) }
    }

    pub fn solve_candidates(&self, bh: f64, bw: f64, rw: f64, gap_px: f64, step: f64) -> Vec<(f64, f64)> {
        self.inner.solve_candidates(bh, bw, rw, gap_px, step)
    }

    pub fn solve_outer_step(&self, dx: f64, dy: f64, c_w: f64, c_h: f64, gap_px: f64) -> (f64, f64) {
        self.inner.solve_outer_step(dx, dy, c_w, c_h, gap_px)
    }
}

pub fn register_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<NfpSolver>()?;
    Ok(())
}
