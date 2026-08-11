//! OCG Layer management — hybrid pikepdf + PDFium approach.

use pdfium_render::prelude::*;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// Placeholder — OCG listing is done in Python via pikepdf.
pub fn get_layers(_py: Python<'_>, pdf_path: &str) -> PyResult<Vec<Py<PyAny>>> {
    let _pdfium = crate::pdfium_init::load_pdfium();
    let _doc = _pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Cannot open PDF: {}", e)))?;
    Ok(Vec::new())
}

/// Render a pre-modified PDF (with OCG /OFF arrays changed by pikepdf).
pub fn render_with_visibility(
    py: Python<'_>,
    pdf_path: &str,
    page_num: usize,
    dpi: u32,
    _hidden_indices: Vec<usize>,
) -> PyResult<Py<PyAny>> {
    let pdfium = crate::pdfium_init::load_pdfium();
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Cannot open PDF: {}", e)))?;

    let page_idx: u16 = (page_num.saturating_sub(1)).try_into().unwrap_or(0);
    let page = doc
        .pages()
        .get(page_idx)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Page error: {}", e)))?;

    let scale = dpi as f32 / 72.0;
    let pixel_w = (page.width().value * scale) as u32;
    let pixel_h = (page.height().value * scale) as u32;

    let config = PdfRenderConfig::new()
        .set_target_width(pixel_w as i32)
        .set_target_height(pixel_h as i32);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Render failed: {}", e)))?;

    let img = bitmap.as_image();
    let mut jpeg_buf: Vec<u8> = Vec::new();
    {
        use std::io::Cursor;
        let mut cursor = Cursor::new(&mut jpeg_buf);
        img.write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("JPEG encode failed: {}", e))
            })?;
    }

    Ok(PyBytes::new(py, &jpeg_buf).into())
}
