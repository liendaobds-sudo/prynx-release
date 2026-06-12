use pdfium_render::prelude::*;
use std::path::Path;

/// XÃ³a cÃ¡c Ä‘Æ°á»ng vector dao báº¿ (mÃ u Magenta/Cyan 100%) khá»i file PDF.
/// Tráº£ vá» Ä‘Æ°á»ng dáº«n cá»§a file PDF Ä‘Ã£ lÃ m sáº¡ch.
#[tauri::command]
pub fn strip_diecut_lines(input_path: String, output_path: String) -> Result<String, String> {
    // Khá»Ÿi táº¡o Pdfium engine
    println!("DEBUG: Start bind"); let bindings = Pdfium::bind_to_system_library()
        .or_else(|_| Pdfium::bind_to_library("pdfium.dll"))
        .map_err(|e| format!("Lá»—i táº£i thÆ° viá»‡n PDFium: {:?}", e))?;
        
    let pdfium = Pdfium::new(bindings);

    if !Path::new(&input_path).exists() {
        return Err(format!("File khÃ´ng tá»“n táº¡i: {}", input_path));
    }

    let bytes = std::fs::read(&input_path).map_err(|e| format!("FS read error: {}", e))?;
    let mut document = pdfium.load_pdf_from_byte_vec(bytes, None)
        .map_err(|e| format!("Lá»—i Ä‘á» c file PDF: {:?}", e))?;

    let mut removed_count = 0;

    // Duyá»‡t qua tá»«ng trang
    for mut page in document.pages_mut().iter() {
        let mut objects_to_remove = Vec::new();
        
        // Duyá»‡t qua cÃ¡c object trÃªn trang
        for (index, object) in page.objects().iter().enumerate() {
            if let Some(path_obj) = object.as_path_object() {
                // Kiá»ƒm tra mÃ u viá»n (stroke color)
                if let Ok(color) = path_obj.stroke_color() {
                    let r = color.red();
                    let b = color.blue();
                    let g = color.green();
                    
                    if r > 200 && g < 50 && b > 100 {
                        objects_to_remove.push(index as u32);
                    }
                }
            }
        }

        objects_to_remove.reverse();
        for idx in objects_to_remove {
            if page.objects_mut().remove_object_at_index(idx as usize).is_ok() {
                removed_count += 1;
            }
        }
    }

    // LÆ°u láº¡i file
    if let Err(e) = document.save_to_file(&output_path) {
        return Err(format!("Lá»—i lÆ°u file PDF: {:?}", e));
    }

    Ok(format!("ÄÃ£ xÃ³a {} nÃ©t khuÃ´n báº¿, lÆ°u táº¡i: {}", removed_count, output_path))
}

