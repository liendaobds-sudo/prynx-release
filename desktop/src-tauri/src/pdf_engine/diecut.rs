use pdfium_render::prelude::*;
use std::path::Path;

/// Xóa các đường vector dao bế (màu Magenta/Cyan 100%) khỏi file PDF.
/// Trả về đường dẫn của file PDF đã làm sạch.
#[tauri::command]
pub fn strip_diecut_lines(input_path: String, output_path: String) -> Result<String, String> {
    // Guard path (đối xứng launch_external_app / render lệnh): renderer nếu bị chèn mã
    // KHÔNG được đọc file nhạy cảm làm nguồn, cũng KHÔNG được GHI PDF (do pdfium dựng ra,
    // nội dung do attacker định hình) đè lên vị trí hệ thống / thư mục bí mật. Chỉ nhận .pdf hai đầu.
    let in_ext = Path::new(&input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let out_ext = Path::new(&output_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if in_ext != "pdf" || out_ext != "pdf" {
        return Err("Chỉ hỗ trợ file .pdf".to_string());
    }
    if crate::is_sensitive_path(&input_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    if crate::is_sensitive_write_path(&output_path) {
        return Err("Access to this location is not allowed".to_string());
    }

    // Dùng ensure_pdfium() dùng chung (đường dẫn release cạnh exe / bin/) — KHÔNG
    // bind_to_system_library riêng: release có thể không thấy pdfium trên PATH,
    // còn dev may mắn tìm thấy → lỗi "chỉ bản cài".
    let pdfium = crate::ensure_pdfium()?;

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
