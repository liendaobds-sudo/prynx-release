//! external_app.rs — Mở file kết quả bằng ứng dụng thiết kế ngoài (Illustrator/CorelDRAW).
//!
//! Thay cho tính năng "gửi máy bế" (kênh TCP/serial chưa kiểm chứng end-to-end): user
//! mở trang khuôn trong AI/Corel nơi PLUGIN MÁY BẾ đã cài sẵn để quét chọn + xuất file cắt.
//!
//! - detect_design_apps: dò đường dẫn .exe qua registry "App Paths" (mirror
//!   collect_hardware_fingerprint trong security.rs — PowerShell + creation_flags ẩn cửa sổ).
//! - launch_external_app: mở file bằng .exe đích danh qua std::process::Command (idiom
//!   đã dùng khắp security.rs). Validate path (dùng chung is_sensitive_path của lib.rs).

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000; // ẩn console flash khi chạy powershell

#[derive(serde::Serialize)]
pub struct DesignApps {
    pub illustrator: Option<String>,
    pub corel: Option<String>,
}

/// Truy vấn 1 key "App Paths\<exe>" ở HKLM rồi HKCU, trả (Default) nếu file tồn tại.
#[cfg(target_os = "windows")]
fn query_app_path(exe_name: &str) -> Option<String> {
    let esc = crate::security::ps_single_quote_escape(exe_name);
    // Nội suy tên exe vào PS SINGLE-quoted string (đã escape) — không nối vào double-quote.
    let script = format!(
        "$n='{}'; $roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'); foreach($r in $roots){{ try {{ $v=(Get-ItemProperty -Path ($r+$n) -ErrorAction Stop).'(default)'; if($v){{ Write-Output $v; exit }} }} catch {{}} }}",
        esc
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let val = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if val.is_empty() {
        return None;
    }
    if std::path::Path::new(&val).is_file() {
        Some(val)
    } else {
        None
    }
}

/// Dò Illustrator + CorelDRAW đã cài (Windows). Không tìm thấy → None (UI cho tự trỏ .exe).
#[command]
pub fn detect_design_apps() -> DesignApps {
    #[cfg(target_os = "windows")]
    {
        let illustrator = query_app_path("Illustrator.exe");
        // Corel đổi tên exe theo dòng/phiên bản → thử vài biến thể phổ biến.
        let corel = ["CorelDRW.exe", "CorelDraw.exe", "coreldrw.exe"]
            .iter()
            .find_map(|n| query_app_path(n));
        DesignApps { illustrator, corel }
    }
    #[cfg(not(target_os = "windows"))]
    {
        DesignApps {
            illustrator: None,
            corel: None,
        }
    }
}

/// Mở `file_path` (PDF) bằng ứng dụng `app_path` đích danh (File>Open, không phải link).
#[command]
pub fn launch_external_app(app_path: String, file_path: String) -> Result<(), String> {
    // Chỉ cho mở PDF (khuôn / khuôn+in) — không mở file tùy loại.
    let ext = std::path::Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "pdf" {
        return Err(format!("File type .{} not allowed", ext));
    }
    if crate::is_sensitive_path(&file_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    if !std::path::Path::new(&file_path).is_file() {
        return Err("File not found".to_string());
    }
    if !std::path::Path::new(&app_path).is_file() {
        return Err("Application not found".to_string());
    }

    let mut cmd = Command::new(&app_path);
    cmd.arg(&file_path);
    cmd.spawn()
        .map_err(|e| format!("Loi mo ung dung: {}", e))?;
    Ok(())
}
