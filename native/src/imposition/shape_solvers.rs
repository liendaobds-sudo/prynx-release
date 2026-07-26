//! Shape solvers — WRAPPER PyO3 mỏng quanh `imposition_core::shape`
//! (Task 6 / Req 1.2). Chỉ chuyển đổi kiểu.

use pyo3::prelude::*;
use pyo3::types::PyDict;
use imposition_core::shape as core;
use imposition_core::sticker::StickerItem;

fn opt_f64(d: &Bound<'_, PyDict>, key: &str) -> Option<f64> {
    d.get_item(key).ok().flatten().and_then(|v| v.extract::<f64>().ok())
}
fn opt_str(d: &Bound<'_, PyDict>, key: &str) -> Option<String> {
    d.get_item(key).ok().flatten().and_then(|v| v.extract::<String>().ok())
}

pub(crate) fn props_from_pydict(sp: &Bound<'_, PyDict>) -> core::ShapeProps {
    core::ShapeProps {
        is_horizontal: opt_f64(sp, "isHorizontal"),
        left_oh: opt_f64(sp, "leftOH"),
        right_oh: opt_f64(sp, "rightOH"),
        triangle_apex: opt_str(sp, "triangleApex"),
        delta_w: opt_f64(sp, "deltaW"),
        gap_multiplier_h: opt_f64(sp, "gapMultiplierH"),
        peak_height_ratio: opt_f64(sp, "peakHeightRatio"),
        pentagon_orientation: opt_str(sp, "pentagonOrientation"),
        overhang_x: opt_f64(sp, "overhangX"),
        overhang_y: opt_f64(sp, "overhangY"),
        big_end_first: opt_f64(sp, "bigEndFirst"),
        body_w: opt_f64(sp, "bodyW"),
        small_d: opt_f64(sp, "smallD"),
        small_asymm_offset: opt_f64(sp, "smallAsymmOffset"),
        asymm_offset: opt_f64(sp, "asymmOffset"),
        safe_interlock_pitch: opt_f64(sp, "safeInterlockPitch"),
        hex_orientation: opt_str(sp, "hexOrientation"),
    }
}

pub(crate) fn item_to_pydict(py: Python<'_>, it: &StickerItem) -> PyResult<Py<PyDict>> {
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

fn shape_to_pydict(py: Python<'_>, r: &core::ShapeResult) -> PyResult<Py<PyAny>> {
    let d = PyDict::new(py);
    let items: Vec<Py<PyDict>> = r.items.iter().map(|it| item_to_pydict(py, it)).collect::<PyResult<_>>()?;
    d.set_item("totalItems", r.total_items)?;
    d.set_item("items", items)?;
    d.set_item("widthUsed", r.width_used)?;
    d.set_item("heightUsed", r.height_used)?;
    d.set_item("strategyUsed", &r.strategy_used)?;
    if let Some(mr) = r.main_rotated {
        d.set_item("_main_rotated", mr)?;
    }
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated=false))]
pub fn shape_pointy_hex(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, is_rotated: bool) -> PyResult<Py<PyAny>> {
    shape_to_pydict(py, &core::pointy_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated=false))]
pub fn shape_flat_hex(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, is_rotated: bool) -> PyResult<Py<PyAny>> {
    shape_to_pydict(py, &core::flat_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y, is_rotated))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90=false))]
pub fn shape_trapezoid(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, shape_props: &Bound<'_, PyDict>, is_rotated_90: bool) -> PyResult<Py<PyAny>> {
    let sp = props_from_pydict(shape_props);
    shape_to_pydict(py, &core::trapezoid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, &sp, is_rotated_90))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90=false))]
pub fn shape_triangle(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, shape_props: &Bound<'_, PyDict>, is_rotated_90: bool) -> PyResult<Py<PyAny>> {
    let sp = props_from_pydict(shape_props);
    shape_to_pydict(py, &core::triangle(usable_w, usable_h, item_w, item_h, gap_x, gap_y, &sp, is_rotated_90))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props, is_rotated_90=false, start_with_down=false))]
pub fn shape_pentagon(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, shape_props: &Bound<'_, PyDict>, is_rotated_90: bool, start_with_down: bool) -> PyResult<Py<PyAny>> {
    let sp = props_from_pydict(shape_props);
    shape_to_pydict(py, &core::pentagon(usable_w, usable_h, item_w, item_h, gap_x, gap_y, &sp, is_rotated_90, start_with_down))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, shape_props))]
pub fn shape_parallelogram(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, shape_props: &Bound<'_, PyDict>) -> PyResult<Py<PyAny>> {
    let sp = props_from_pydict(shape_props);
    shape_to_pydict(py, &core::parallelogram(usable_w, usable_h, item_w, item_h, gap_x, gap_y, &sp))
}

#[pyfunction]
pub fn shape_l_layout(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> PyResult<Py<PyAny>> {
    let r = core::l_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
    // l_shape gốc có thêm itemActualW/itemActualH
    let d = PyDict::new(py);
    let items: Vec<Py<PyDict>> = r.items.iter().map(|it| item_to_pydict(py, it)).collect::<PyResult<_>>()?;
    d.set_item("totalItems", r.total_items)?;
    d.set_item("items", items)?;
    d.set_item("widthUsed", r.width_used)?;
    d.set_item("heightUsed", r.height_used)?;
    d.set_item("itemActualW", item_w)?;
    d.set_item("itemActualH", item_h)?;
    d.set_item("strategyUsed", &r.strategy_used)?;
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, bb_w, bb_h, gap_h, gap_v, shape_props, disable_l_shape=false))]
pub fn shape_hammer(py: Python<'_>, usable_w: f64, usable_h: f64, bb_w: f64, bb_h: f64, gap_h: f64, gap_v: f64, shape_props: &Bound<'_, PyDict>, disable_l_shape: bool) -> PyResult<Py<PyAny>> {
    let sp = props_from_pydict(shape_props);
    shape_to_pydict(py, &core::hammer(usable_w, usable_h, bb_w, bb_h, gap_h, gap_v, &sp, disable_l_shape))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac=0.65, is_rotated_90=false))]
pub fn shape_dumbbell_pair_col(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, big_end_axis_frac: f64, is_rotated_90: bool) -> PyResult<Py<PyAny>> {
    shape_to_pydict(py, &core::dumbbell_pair_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90))
}

#[pyfunction]
#[pyo3(signature = (usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac=0.65, is_rotated_90=false))]
pub fn shape_dumbbell_pair_row(py: Python<'_>, usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64, big_end_axis_frac: f64, is_rotated_90: bool) -> PyResult<Py<PyAny>> {
    shape_to_pydict(py, &core::dumbbell_pair_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y, big_end_axis_frac, is_rotated_90))
}
