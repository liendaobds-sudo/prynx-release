mod pdfium_init;
mod objects;
mod render;
mod redact;
mod layers;
mod imposition;
mod image_compare;
mod nfp_solver;
mod dieline_engine;
mod dieline_license;
mod dieline_request;
mod print_engine_py;

use pyo3::prelude::*;

/// Rust native module for PDF operations via PDFium.
/// Provides high-performance capabilities that pikepdf/pypdfium2 Python wrappers lack.
#[pymodule]
fn pdfcompare_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Existing PDFium operations
    m.add_function(wrap_pyfunction!(enumerate_page_objects, m)?)?;
    m.add_function(wrap_pyfunction!(render_page_svg, m)?)?;
    m.add_function(wrap_pyfunction!(delete_page_objects, m)?)?;
    m.add_function(wrap_pyfunction!(render_page_image, m)?)?;
    m.add_function(wrap_pyfunction!(get_ocg_layers, m)?)?;
    m.add_function(wrap_pyfunction!(set_ocg_visibility, m)?)?;

    // PrynX Print Engine (PPE) — tách kẽm / TAC trong không gian mực, không GS.
    m.add_function(wrap_pyfunction!(print_engine_py::ppe_separations, m)?)?;
    m.add_function(wrap_pyfunction!(print_engine_py::ppe_capabilities, m)?)?;

    // Imposition grid solver
    m.add_function(wrap_pyfunction!(imposition::grid_solver::solve_grid, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::grid_solver::solve_optimal_layout, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::grid_solver::solve_manual, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::grid_solver::get_src_page_idx, m)?)?;

    // Imposition assembler
    m.add_function(wrap_pyfunction!(imposition::assembler::compute_placements, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::assembler::compute_alignment, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::assembler::compute_mark_coords, m)?)?;

    // Sticker layout solvers
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_solve_grid, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_staggered_hex, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_staggered_vertical, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_hex_tiling_row, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_hex_tiling_col, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_cluster_grid, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_row_alternating, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::sticker_layouts::sticker_col_alternating, m)?)?;

    // Shape-specific solvers
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_pointy_hex, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_flat_hex, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_trapezoid, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_triangle, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_pentagon, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_parallelogram, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_l_layout, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_hammer, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_dumbbell_pair_col, m)?)?;
    m.add_function(wrap_pyfunction!(imposition::shape_solvers::shape_dumbbell_pair_row, m)?)?;

    // Orchestrator
    m.add_function(wrap_pyfunction!(imposition::orchestrator::generate_layout_candidates, m)?)?;

    // N-Up cắt xén chia tỷ lệ (ratio_stack) — Phase 1
    m.add_function(wrap_pyfunction!(imposition::ratio_stack_solver::solve_ratio_stack, m)?)?;

    // Image Compare
    image_compare::register_module(m)?;
    nfp_solver::register_module(m)?;

    // Packaging engine runs outside the WebView and is exposed only through
    // the feature-gated sidecar route.
    m.add_function(wrap_pyfunction!(dieline_engine::warm_dieline_engine, m)?)?;
    m.add_function(wrap_pyfunction!(dieline_engine::generate_dieline_json, m)?)?;
    
    Ok(())
}

/// Enumerate all objects (text, image, path) on a page with precise bounding boxes.
/// Returns list of dicts: [{type, bbox, content?, index}]
#[pyfunction]
fn enumerate_page_objects(py: Python<'_>, pdf_path: &str, page_num: usize) -> PyResult<Vec<PyObject>> {
    objects::enumerate_objects(py, pdf_path, page_num)
}

/// Render page path objects as SVG string with embedded raster background.
#[pyfunction]
fn render_page_svg(pdf_path: &str, page_num: usize, dpi: u32) -> PyResult<String> {
    render::render_svg(pdf_path, page_num, dpi)
}

/// Delete specific objects from a page by their indices.
/// Returns the modified PDF as bytes.
#[pyfunction]
fn delete_page_objects(py: Python<'_>, pdf_path: &str, page_num: usize, indices: Vec<usize>) -> PyResult<PyObject> {
    redact::delete_objects(py, pdf_path, page_num, indices)
}

/// Render a page to JPEG bytes at given DPI.
#[pyfunction]
fn render_page_image(py: Python<'_>, pdf_path: &str, page_num: usize, dpi: u32) -> PyResult<PyObject> {
    render::render_image(py, pdf_path, page_num, dpi)
}

/// Get OCG (Optional Content Group) layers from a PDF.
/// Returns list of dicts: [{name, index, visible}]
#[pyfunction]
fn get_ocg_layers(py: Python<'_>, pdf_path: &str) -> PyResult<Vec<PyObject>> {
    layers::get_layers(py, pdf_path)
}

/// Render page with specific OCG layers toggled off.
/// Returns JPEG image bytes.
#[pyfunction]
fn set_ocg_visibility(py: Python<'_>, pdf_path: &str, page_num: usize, dpi: u32, hidden_indices: Vec<usize>) -> PyResult<PyObject> {
    layers::render_with_visibility(py, pdf_path, page_num, dpi, hidden_indices)
}
