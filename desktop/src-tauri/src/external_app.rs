//! Mở file kết quả bằng ứng dụng thiết kế ngoài (Illustrator/CorelDRAW).
//!
//! Người dùng mở riêng trang khuôn trong ứng dụng đã cài plugin máy bế, sau đó
//! quét chọn đường cắt và xuất bằng plugin. Mô-đun này không gửi dữ liệu trực
//! tiếp đến máy bế.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct DesignApps {
    pub illustrator: Option<String>,
    pub corel: Option<String>,
}

/// Dò cả Illustrator và CorelDRAW trong một process PowerShell.
///
/// App Paths là nguồn chính; các mẫu Program Files là fallback cho bản cài
/// không đăng ký App Paths. Không quét đệ quy toàn ổ đĩa vì sẽ làm hộp thoại
/// Bế chậm trên máy có nhiều dữ liệu.
#[cfg(target_os = "windows")]
fn query_design_apps() -> Option<DesignApps> {
    // PERF (audit 2026-08-05 §OPEN-DESIGN): trước đây tạo tối đa bốn process
    // PowerShell nối tiếp nên UI có thể báo nhầm “chưa dò được” trong lúc còn dò.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
    'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
    'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
)

function Find-DesignApp([string[]]$names, [string[]]$patterns) {
    foreach ($root in $roots) {
        foreach ($name in $names) {
            $key = Join-Path $root $name
            try {
                $value = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
                if ($value) {
                    $candidate = [Environment]::ExpandEnvironmentVariables([string]$value).Trim().Trim('"')
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                        return [System.IO.Path]::GetFullPath($candidate)
                    }
                }
            } catch {}
        }
    }

    foreach ($pattern in $patterns) {
        if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
        $candidate = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

$pf = $env:ProgramFiles
$pf86 = ${env:ProgramFiles(x86)}
$illustratorPatterns = @()
$corelPatterns = @()
if ($pf) {
    $illustratorPatterns += (Join-Path $pf 'Adobe\Adobe Illustrator *\Support Files\Contents\Windows\Illustrator.exe')
    $corelPatterns += (Join-Path $pf 'Corel\CorelDRAW Graphics Suite *\Programs64\CorelDRW.exe')
    $corelPatterns += (Join-Path $pf 'Corel\CorelDRAW Graphics Suite *\Programs\CorelDRW.exe')
}
if ($pf86) {
    $illustratorPatterns += (Join-Path $pf86 'Adobe\Adobe Illustrator *\Support Files\Contents\Windows\Illustrator.exe')
    $corelPatterns += (Join-Path $pf86 'Corel\CorelDRAW Graphics Suite *\Programs64\CorelDRW.exe')
    $corelPatterns += (Join-Path $pf86 'Corel\CorelDRAW Graphics Suite *\Programs\CorelDRW.exe')
}

[ordered]@{
    illustrator = Find-DesignApp @('Illustrator.exe') $illustratorPatterns
    corel = Find-DesignApp @('CorelDRW.exe', 'CorelDraw.exe') $corelPatterns
} | ConvertTo-Json -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let mut apps = parse_design_apps_output(&output.stdout)?;
    apps.illustrator = validate_detected_path(apps.illustrator);
    apps.corel = validate_detected_path(apps.corel);
    Some(apps)
}

fn parse_design_apps_output(stdout: &[u8]) -> Option<DesignApps> {
    let text = String::from_utf8_lossy(stdout);
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

#[cfg(target_os = "windows")]
fn validate_detected_path(path: Option<String>) -> Option<String> {
    path.map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| std::path::Path::new(value).is_file())
}

/// Dò Illustrator và CorelDRAW đã cài. Không tìm thấy thì UI cho chọn thủ công.
#[command]
pub async fn detect_design_apps() -> DesignApps {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(query_design_apps)
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        DesignApps::default()
    }
}

/// Mở `file_path` (PDF) bằng ứng dụng `app_path` đích danh.
#[command]
pub fn launch_external_app(app_path: String, file_path: String) -> Result<(), String> {
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

    // app_path đến từ bộ dò hoặc hộp thoại native. Không whitelist thư mục cứng
    // vì Corel/Illustrator có thể được cài ở ổ khác, nhưng bắt buộc là .exe tồn tại.
    let app_ext = std::path::Path::new(&app_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if app_ext != "exe" {
        return Err("Application must be an .exe".to_string());
    }
    if crate::is_sensitive_path(&app_path) {
        return Err("Access to this location is not allowed".to_string());
    }
    if !std::path::Path::new(&app_path).is_file() {
        return Err("Application not found".to_string());
    }

    let mut cmd = Command::new(&app_path);
    cmd.arg(&file_path);
    cmd.spawn().map_err(|e| format!("Lỗi mở ứng dụng: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_design_apps_json_ignores_surrounding_powershell_noise() {
        let output = br#"warning
{"illustrator":"C:\\Program Files\\Adobe\\Illustrator.exe","corel":null}
"#;
        let apps = parse_design_apps_output(output).expect("parse detection result");
        assert_eq!(
            apps,
            DesignApps {
                illustrator: Some(r"C:\Program Files\Adobe\Illustrator.exe".to_string()),
                corel: None,
            }
        );
    }

    #[test]
    fn parse_design_apps_rejects_non_json_output() {
        assert_eq!(parse_design_apps_output(b""), None);
        assert_eq!(parse_design_apps_output(b"powershell error"), None);
    }
}
