//! Page rendering — SVG vector export + raster image rendering

use pdfium_render::prelude::*;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// Render page as SVG string.
pub fn render_svg(pdf_path: &str, page_num: usize, dpi: u32) -> PyResult<String> {
    let pdfium = crate::pdfium_init::load_pdfium();
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| pyo3::exceptions::PyIOError::new_err(format!("Cannot open PDF: {}", e)))?;

    let page_idx: u16 = (page_num.saturating_sub(1)).try_into().unwrap_or(0);
    let page = doc
        .pages()
        .get(page_idx)
        .map_err(|e| pyo3::exceptions::PyValueError::new_err(format!("Page error: {}", e)))?;

    let page_w = page.width().value;
    let page_h = page.height().value;

    let scale = dpi as f32 / 72.0;
    let pixel_w = (page_w * scale) as u32;
    let pixel_h = (page_h * scale) as u32;

    let config = PdfRenderConfig::new()
        .set_target_width(pixel_w as i32)
        .set_target_height(pixel_h as i32);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("Render failed: {}", e)))?;

    let img = bitmap.as_image();
    let mut png_buf: Vec<u8> = Vec::new();
    {
        use std::io::Cursor;
        let mut cursor = Cursor::new(&mut png_buf);
        img.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("PNG encode failed: {}", e))
            })?;
    }

    let png_b64 = base64_encode(&png_buf);

    // Build SVG with raster background + vector overlays
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {:.2} {:.2}" width="{}" height="{}">"#,
        page_w, page_h, pixel_w, pixel_h
    );
    svg += "\n";
    svg += &format!(
        r#"<image href="data:image/png;base64,{}" width="{:.2}" height="{:.2}"/>"#,
        png_b64, page_w, page_h
    );
    svg += "\n";

    // Walk path objects → SVG paths
    for obj in page.objects().iter() {
        if obj.object_type() != PdfPageObjectType::Path {
            continue;
        }
        let Some(path_obj) = obj.as_path_object() else {
            continue;
        };
        let segs = path_obj.segments();
        if segs.len() == 0 {
            continue;
        }

        let mut d = String::new();
        for i in 0..segs.len() {
            let Ok(seg) = segs.get(i as u32) else {
                continue;
            };
            let x = seg.x().value;
            let y = page_h - seg.y().value;

            match seg.segment_type() {
                PdfPathSegmentType::MoveTo => d += &format!("M{:.2},{:.2} ", x, y),
                PdfPathSegmentType::LineTo => d += &format!("L{:.2},{:.2} ", x, y),
                PdfPathSegmentType::BezierTo => d += &format!("L{:.2},{:.2} ", x, y),
                _ => {}
            }
            if seg.is_close() {
                d += "Z ";
            }
        }

        if d.is_empty() {
            continue;
        }

        let fill = path_obj.fill_color().ok().map(|c: PdfColor| {
            format!(
                "rgba({},{},{},{:.2})",
                c.red(),
                c.green(),
                c.blue(),
                c.alpha() as f32 / 255.0
            )
        });
        let stroke = path_obj.stroke_color().ok().map(|c: PdfColor| {
            format!(
                "rgba({},{},{},{:.2})",
                c.red(),
                c.green(),
                c.blue(),
                c.alpha() as f32 / 255.0
            )
        });
        let stroke_width = path_obj.stroke_width().ok().map(|w| w.value).unwrap_or(0.0);

        let fill_attr = fill.as_deref().unwrap_or("none");
        let stroke_attr = stroke.as_deref().unwrap_or("none");

        svg += &format!(
            r#"<path d="{}" fill="{}" stroke="{}" stroke-width="{:.2}"/>"#,
            d, fill_attr, stroke_attr, stroke_width
        );
        svg += "\n";
    }

    svg += "</svg>";
    Ok(svg)
}

/// Render page to JPEG image bytes.
pub fn render_image(
    py: Python<'_>,
    pdf_path: &str,
    page_num: usize,
    dpi: u32,
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

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len() * 4 / 3 + 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}
