//! Object deletion/redaction

use pdfium_render::prelude::*;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

pub fn delete_objects(py: Python<'_>, pdf_path: &str, page_num: usize, indices: Vec<usize>) -> PyResult<PyObject> {
    let pdfium = crate::pdfium_init::load_pdfium();
    let mut doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Cannot open PDF: {}", e)))?;

    let page_idx: u16 = (page_num.saturating_sub(1)).try_into().unwrap_or(0);

    {
        let mut page = doc
            .pages_mut()
            .get(page_idx)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Page error: {}", e)))?;

        // Sort in reverse to keep indices valid during removal
        let mut sorted = indices.clone();
        sorted.sort_unstable();
        sorted.reverse();
        sorted.dedup();

        {
            let objects = page.objects_mut();
            for idx in sorted {
                if idx < objects.len() {
                    let _ = objects.remove_object_at_index(idx);
                }
            }
        }

        // Regenerate content after modifications
        let _ = page.regenerate_content();
    }

    let output = doc.save_to_bytes()
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Save failed: {}", e)))?;

    Ok(PyBytes::new(py, &output).into())
}
