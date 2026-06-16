//! Assembler — WRAPPER PyO3 mỏng quanh `imposition_core::assembler`
//! (Task 6 / Req 1.2). Chỉ chuyển đổi kiểu.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use std::collections::HashMap;
use imposition_core::assembler as core;

fn cell_from_pydict(d: &Bound<'_, PyDict>) -> PyResult<core::AssemblyCell> {
    let g = |k: &str, def: f64| -> f64 { d.get_item(k).ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(def) };
    let gb = |k: &str| -> bool { d.get_item(k).ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(false) };
    let gi = |k: &str| -> i64 { d.get_item(k).ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(0) };
    Ok(core::AssemblyCell {
        x: g("x", 0.0), y: g("y", 0.0), width: g("width", 0.0), height: g("height", 0.0),
        is_rotated: gb("isRotated"), is_rotated_180: gb("isRotated180"), block_id: gi("blockId"),
    })
}

fn placement_to_pydict(py: Python<'_>, p: &core::AbsPlacement) -> PyResult<Py<PyDict>> {
    let d = PyDict::new(py);
    d.set_item("cluster_idx", p.cluster_idx)?;
    d.set_item("src_page_idx", p.src_page_idx)?;
    d.set_item("abs_x", p.abs_x)?;
    d.set_item("abs_y", p.abs_y)?;
    d.set_item("original_cell_y", p.original_cell_y)?;
    d.set_item("width", p.width)?;
    d.set_item("height", p.height)?;
    let cd = PyDict::new(py);
    cd.set_item("x", p.cell.x)?;
    cd.set_item("y", p.cell.y)?;
    cd.set_item("width", p.cell.width)?;
    cd.set_item("height", p.cell.height)?;
    cd.set_item("isRotated", p.cell.is_rotated)?;
    cd.set_item("isRotated180", p.cell.is_rotated_180)?;
    cd.set_item("blockId", p.cell.block_id)?;
    d.set_item("cell", cd)?;
    Ok(d.into())
}

#[pyfunction]
#[pyo3(signature = (sheet_idx, cells, capacity, cx_count, cy_count, cluster_gap, active_grid_w, active_grid_h, super_base_x, super_base_y, sheet_w, sheet_h, layout_type, total_capacity, page_count, sheet_mapping=None))]
#[allow(clippy::too_many_arguments)]
pub fn compute_placements(
    py: Python<'_>,
    sheet_idx: usize,
    cells: &Bound<'_, PyList>,
    capacity: usize,
    cx_count: usize,
    cy_count: usize,
    cluster_gap: f64,
    active_grid_w: f64,
    active_grid_h: f64,
    super_base_x: f64,
    super_base_y: f64,
    sheet_w: f64, // giữ chữ ký; lõi không dùng
    sheet_h: f64,
    layout_type: &str,
    total_capacity: usize,
    page_count: usize,
    sheet_mapping: Option<&Bound<'_, PyDict>>,
) -> PyResult<PyObject> {
    let _ = sheet_w; // lõi không dùng; giữ để khớp chữ ký Python
    let parsed: Vec<core::AssemblyCell> = cells
        .iter()
        .map(|item| {
            let d = item.downcast::<PyDict>()?;
            cell_from_pydict(d)
        })
        .collect::<PyResult<_>>()?;

    // Build HashMap từ sheet_mapping (hỗ trợ key int hoặc str).
    let mapping: Option<HashMap<usize, usize>> = sheet_mapping.map(|m| {
        let mut hm = HashMap::new();
        for (k, v) in m.iter() {
            let key = k.extract::<usize>().ok().or_else(|| k.extract::<String>().ok().and_then(|s| s.parse().ok()));
            let val = v.extract::<usize>().ok();
            if let (Some(k), Some(v)) = (key, val) { hm.insert(k, v); }
        }
        hm
    });

    let placements = core::compute_placements(
        sheet_idx, &parsed, capacity, cx_count, cy_count, cluster_gap,
        active_grid_w, active_grid_h, super_base_x, super_base_y, sheet_h,
        layout_type, total_capacity, page_count, mapping.as_ref(),
    );

    let out = PyList::empty(py);
    for p in &placements {
        out.append(placement_to_pydict(py, p)?)?;
    }
    Ok(out.into())
}

#[pyfunction]
#[allow(clippy::too_many_arguments)]
pub fn compute_alignment(
    sheet_w: f64, sheet_h: f64,
    sheet_usable_w: f64, sheet_usable_h: f64,
    margin_left: f64, margin_bottom: f64,
    super_grid_w: f64, super_grid_h: f64,
    align: &str,
) -> (f64, f64) {
    core::compute_alignment(sheet_w, sheet_h, sheet_usable_w, sheet_usable_h, margin_left, margin_bottom, super_grid_w, super_grid_h, align)
}

#[pyfunction]
#[pyo3(signature = (placements, mark_type, mark_off, mark_len, bleed_offset=0.0))]
pub fn compute_mark_coords(
    py: Python<'_>,
    placements: &Bound<'_, PyList>,
    mark_type: &str,
    mark_off: f64,
    mark_len: f64,
    bleed_offset: f64,
) -> PyResult<PyObject> {
    // Parse placement dicts → AbsPlacement (chỉ cần các field mark dùng tới).
    let mut parsed: Vec<core::AbsPlacement> = Vec::new();
    for item in placements.iter() {
        let d = item.downcast::<PyDict>()?;
        let g = |k: &str| -> f64 { d.get_item(k).ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(0.0) };
        let cluster_idx: usize = d.get_item("cluster_idx").ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(0);
        let block_id: i64 = d.get_item("cell").ok().flatten()
            .and_then(|c| c.downcast_into::<PyDict>().ok())
            .and_then(|c| c.get_item("blockId").ok().flatten())
            .and_then(|v| v.extract().ok())
            .unwrap_or(0);
        parsed.push(core::AbsPlacement {
            cluster_idx,
            src_page_idx: 0,
            abs_x: g("abs_x"),
            abs_y: g("abs_y"),
            original_cell_y: g("original_cell_y"),
            width: g("width"),
            height: g("height"),
            cell: core::AssemblyCell { x: 0.0, y: 0.0, width: g("width"), height: g("height"), is_rotated: false, is_rotated_180: false, block_id },
        });
    }

    let marks = core::compute_mark_coords(&parsed, mark_type, mark_off, mark_len, bleed_offset);
    let out = PyList::empty(py);
    for m in &marks {
        let d = PyDict::new(py);
        d.set_item("x1", m.x1)?;
        d.set_item("y1", m.y1)?;
        d.set_item("x2", m.x2)?;
        d.set_item("y2", m.y2)?;
        out.append(d)?;
    }
    Ok(out.into())
}
