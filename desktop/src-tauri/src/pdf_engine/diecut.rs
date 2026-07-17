use pdfium_render::prelude::*;
use std::path::Path;

/// Xóa các đường vector dao bế (màu Magenta/Cyan 100%) khỏi file PDF.
/// Trả về đường dẫn của file PDF đã làm sạch.
#[tauri::command]
pub fn strip_diecut_lines(input_path: String, output_path: String) -> Result<String, String> {
    // Khởi tạo Pdfium engine
    println!("DEBUG: Start bind");
    let bindings = Pdfium::bind_to_system_library()
        .or_else(|_| Pdfium::bind_to_library("pdfium.dll"))
        .map_err(|e| format!("Lỗi tải thư viện PDFium: {:?}", e))?;

    let pdfium = Pdfium::new(bindings);

    if !Path::new(&input_path).exists() {
        return Err(format!("File không tồn tại: {}", input_path));
    }

    let bytes = std::fs::read(&input_path).map_err(|e| format!("FS read error: {}", e))?;
    let mut document = pdfium
        .load_pdf_from_byte_vec(bytes, None)
        .map_err(|e| format!("Lỗi đọc file PDF: {:?}", e))?;

    let mut removed_count = 0;

    // Duyệt qua từng trang
    for mut page in document.pages_mut().iter() {
        let mut objects_to_remove = Vec::new();

        // Duyệt qua các object trên trang
        for (index, object) in page.objects().iter().enumerate() {
            if let Some(path_obj) = object.as_path_object() {
                // Kiểm tra màu viền (stroke color)
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
            if page
                .objects_mut()
                .remove_object_at_index(idx as usize)
                .is_ok()
            {
                removed_count += 1;
            }
        }
    }

    // Lưu lại file
    if let Err(e) = document.save_to_file(&output_path) {
        return Err(format!("Lỗi lưu file PDF: {:?}", e));
    }

    Ok(format!(
        "Đã xóa {} nét khuôn bế, lưu tại: {}",
        removed_count, output_path
    ))
}
