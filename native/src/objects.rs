//! Page object enumeration — text extraction, image info, and drawing/path analysis via pdfium-render

use pdfium_render::prelude::*;
use pyo3::prelude::*;
use pyo3::types::PyDict;

pub fn enumerate_objects(py: Python<'_>, pdf_path: &str, page_num: usize) -> PyResult<Vec<PyObject>> {
    let pdfium = crate::pdfium_init::load_pdfium();
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Cannot open PDF: {}", e)))?;

    let page_idx: u16 = (page_num.saturating_sub(1)).try_into().unwrap_or(0);
    let page = doc
        .pages()
        .get(page_idx)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Page error: {}", e)))?;

    let page_height = page.height().value;
    let mut results: Vec<PyObject> = Vec::new();

    for (idx, obj) in page.objects().iter().enumerate() {
        let dict = PyDict::new(py);
        dict.set_item("index", idx)?;

        let Ok(bounds) = obj.bounds() else { continue };
        let bbox: [f32; 4] = [
            bounds.left().value,
            page_height - bounds.top().value,
            bounds.right().value,
            page_height - bounds.bottom().value,
        ];
        dict.set_item("bbox", bbox.to_vec())?;

        match obj.object_type() {
            PdfPageObjectType::Text => {
                dict.set_item("type", "text")?;
                if let Some(text_obj) = obj.as_text_object() {
                    dict.set_item("content", text_obj.text())?;
                    let font = text_obj.font();
                    dict.set_item("font_name", font.name())?;
                    dict.set_item("font_size", text_obj.unscaled_font_size().value)?;
                }
            }
            PdfPageObjectType::Image => {
                dict.set_item("type", "image")?;
                if let Some(_img_obj) = obj.as_image_object() {
                    let w = (bounds.right().value - bounds.left().value).abs();
                    let h = (bounds.top().value - bounds.bottom().value).abs();
                    dict.set_item("display_width", w)?;
                    dict.set_item("display_height", h)?;
                }
            }
            PdfPageObjectType::Path => {
                dict.set_item("type", "drawing")?;
                if let Some(path_obj) = obj.as_path_object() {
                    let segs = path_obj.segments();
                    dict.set_item("segment_count", segs.len())?;
                    if let Ok(color) = path_obj.fill_color() {
                        let c: PdfColor = color;
                        dict.set_item("fill_color", format!("#{:02x}{:02x}{:02x}{:02x}",
                            c.red(), c.green(), c.blue(), c.alpha()))?;
                    }
                    if let Ok(color) = path_obj.stroke_color() {
                        let c: PdfColor = color;
                        dict.set_item("stroke_color", format!("#{:02x}{:02x}{:02x}{:02x}",
                            c.red(), c.green(), c.blue(), c.alpha()))?;
                    }
                    if let Ok(w) = path_obj.stroke_width() {
                        dict.set_item("stroke_width", w.value)?;
                    }
                }
            }
            PdfPageObjectType::Shading => {
                dict.set_item("type", "shading")?;
            }
            _ => {
                dict.set_item("type", "unknown")?;
            }
        }

        results.push(dict.into());
    }

    Ok(results)
}
