//! Mở file kết quả bằng ứng dụng thiết kế ngoài (Illustrator/CorelDRAW).
//!
//! Người dùng mở riêng trang khuôn trong ứng dụng đã cài plugin máy bế, sau đó
//! quét chọn đường cắt và xuất bằng plugin. Mô-đun này không gửi dữ liệu trực
//! tiếp đến máy bế.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::command;
use tauri_plugin_fs::FsExt;

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

    // SEC (audit 2026-09-04 §SEC.24-R1): renderer không kiểm soát PATH nhưng
    // môi trường process cha có thể. Chỉ chạy Windows PowerShell do System32 trả về.
    let powershell = crate::security::system_powershell_path().ok()?;
    let output = Command::new(powershell)
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
pub async fn detect_design_apps(app: tauri::AppHandle) -> DesignApps {
    #[cfg(target_os = "windows")]
    {
        let apps = tauri::async_runtime::spawn_blocking(query_design_apps)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        // SEC (audit 2026-08-28 §SEC.05): ghi nhận kết quả dò làm nguồn tin cậy cho
        // `launch_external_app`. Đây là path do CHÍNH Rust xác minh (registry App Paths
        // hoặc mẫu Program Files, đã `is_file()`), không phải chuỗi renderer bịa ra.
        for candidate in [apps.illustrator.as_deref(), apps.corel.as_deref()] {
            if let Some(value) = candidate {
                remember_approved_app(&app, value);
            }
        }
        apps
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &app;
        DesignApps::default()
    }
}

// ── §SEC.05: allowlist tiến trình được phép khởi chạy ────────────────────────────
//
// Vấn đề đã vá: `launch_external_app` nhận CẢ `app_path` lẫn `file_path` từ renderer và
// chỉ kiểm ".exe + tồn tại + không nhạy cảm", rồi `Command::new(app_path).spawn()`.
// Không có command-injection (argv tách rời, không qua shell) nhưng đó là
// ARBITRARY PROCESS LAUNCH: renderer bị chèn mã chạy được `.exe` bất kỳ đã có trên máy
// (vd trong Downloads) hoặc `\\attacker\share\evil.exe`. Đây là primitive mạnh nhất mà
// renderer có trong toàn bộ bề mặt IPC, nên nó phải đi qua một danh sách đã duyệt.
//
// Ba nguồn hợp lệ, đều KHÔNG do renderer tự quyết:
//   1. kết quả `detect_design_apps` (Rust đọc registry rồi `is_file()`);
//   2. path người dùng vừa chọn qua hộp thoại native — Tauri nới `fs_scope` cho đúng
//      path đó, y như cơ chế `grant_upscale_file_path` đang dùng;
//   3. path đã duyệt ở phiên trước, lưu trong `app_data_dir` (vì OpenInDesignModal nhớ
//      lựa chọn trong localStorage và gọi launch trực tiếp mà không mở lại hộp thoại —
//      nếu chỉ chấp nhận (1)+(2) thì phiên sau sẽ gãy).

const APPROVED_APPS_FILE: &str = "design-apps-approved.json";

fn approved_store_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(APPROVED_APPS_FILE))
}

/// Khoá so khớp: canonical + hạ hoa/thường. Dùng `crate::` để chia sẻ đúng một cách
/// chuẩn hoá với deny-list (§SEC.04), tránh hai định nghĩa "cùng một file" lệch nhau.
fn approval_key(path: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(std::path::Path::new(path)).ok()?;
    Some(crate::strip_path_prefix_aliases(
        &canonical.to_string_lossy(),
    ))
}

fn load_approved_apps(app: &tauri::AppHandle) -> Vec<String> {
    let Some(store) = approved_store_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&store) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

fn remember_approved_app(app: &tauri::AppHandle, path: &str) {
    let Some(key) = approval_key(path) else {
        return;
    };
    let mut approved = load_approved_apps(app);
    if approved.iter().any(|item| *item == key) {
        return;
    }
    // Trần nhỏ: danh sách này chỉ chứa vài app thiết kế. Có trần để renderer không thể
    // bơm phình file bằng cách gọi lặp với path hợp lệ khác nhau.
    if approved.len() >= 16 {
        approved.remove(0);
    }
    approved.push(key);
    let Some(store) = approved_store_path(app) else {
        return;
    };
    if let Some(parent) = store.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string(&approved) {
        let _ = std::fs::write(&store, serialized);
    }
}

/// `app_path` có được phép khởi chạy hay không. Trả `Ok(canonical_key)` khi hợp lệ.
fn authorize_app_path(app: &tauri::AppHandle, app_path: &str) -> Result<String, String> {
    if crate::is_network_or_device_path(app_path) {
        return Err("Không mở được ứng dụng từ đường dẫn mạng".to_string());
    }
    let metadata = std::fs::symlink_metadata(std::path::Path::new(app_path))
        .map_err(|_| "Application not found".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Đường dẫn ứng dụng không phải file thường".to_string());
    }
    let key = approval_key(app_path).ok_or_else(|| "Application not found".to_string())?;
    if crate::is_network_or_device_path(&key) {
        return Err("Không mở được ứng dụng từ đường dẫn mạng".to_string());
    }

    // Người dùng vừa chọn qua hộp thoại native → Tauri đã nới scope cho path này.
    let canonical = std::fs::canonicalize(std::path::Path::new(app_path))
        .map_err(|_| "Application not found".to_string())?;
    let scope_allowed = app.fs_scope().is_allowed(&canonical);

    match decide_app_authorization(&key, &load_approved_apps(app), scope_allowed) {
        AppAuthorization::AlreadyApproved => Ok(key),
        AppAuthorization::ApproveNow => {
            remember_approved_app(app, app_path);
            Ok(key)
        }
        AppAuthorization::Denied => Err(
            "Ứng dụng chưa được cấp quyền. Hãy chọn lại file .exe bằng hộp thoại của PrynX."
                .to_string(),
        ),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AppAuthorization {
    AlreadyApproved,
    ApproveNow,
    Denied,
}

/// Phần QUYẾT ĐỊNH thuần (không I/O) để unit-test được — `authorize_app_path` cần
/// `AppHandle` nên không test trực tiếp. Bất biến: renderer KHÔNG có đường nào tự đưa
/// một path vào diện được phép; phải đã duyệt trước, hoặc người dùng vừa chọn qua hộp
/// thoại native (thể hiện bằng `scope_allowed`).
fn decide_app_authorization(
    key: &str,
    approved: &[String],
    scope_allowed: bool,
) -> AppAuthorization {
    if approved.iter().any(|item| item == key) {
        return AppAuthorization::AlreadyApproved;
    }
    if scope_allowed {
        return AppAuthorization::ApproveNow;
    }
    AppAuthorization::Denied
}

/// Mở `file_path` (PDF) bằng ứng dụng `app_path` đích danh.
#[command]
pub fn launch_external_app(
    app: tauri::AppHandle,
    app_path: String,
    file_path: String,
) -> Result<(), String> {
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
    // SEC (audit 2026-08-28 §SEC.05): đuôi `.exe` + tồn tại là KHÔNG đủ — đó vẫn là
    // arbitrary process launch. Bắt buộc đi qua allowlist đã duyệt (dò được / vừa chọn
    // qua hộp thoại / đã duyệt phiên trước).
    authorize_app_path(&app, &app_path)?;

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

    /// SEC (audit 2026-08-28 §SEC.05): trước bản vá, MỌI `.exe` tồn tại đều chạy được.
    /// Nay chỉ ba nguồn hợp lệ, và renderer không nắm được nguồn nào trong đó.
    #[test]
    fn chi_app_da_duyet_hoac_vua_chon_qua_hop_thoai_moi_duoc_chay() {
        let approved = vec![
            r"c:\program files\adobe\adobe illustrator 2026\support files\contents\windows\illustrator.exe"
                .to_string(),
        ];

        // 1. Đã duyệt (dò được từ registry, hoặc duyệt ở phiên trước).
        assert_eq!(
            decide_app_authorization(&approved[0], &approved, false),
            AppAuthorization::AlreadyApproved
        );

        // 2. Chưa duyệt nhưng người dùng VỪA chọn qua hộp thoại native → Tauri nới scope.
        assert_eq!(
            decide_app_authorization(r"d:\corel\coreldrw.exe", &approved, true),
            AppAuthorization::ApproveNow
        );

        // 3. Renderer bịa path: `.exe` tải về Downloads, hoặc share mạng. Không nằm trong
        //    danh sách duyệt và không có scope ⇒ TỪ CHỐI. Đây là ca lỗ cũ để lọt.
        assert_eq!(
            decide_app_authorization(r"c:\users\bob\downloads\evil.exe", &approved, false),
            AppAuthorization::Denied
        );
        assert_eq!(
            decide_app_authorization(r"\\attacker\share\evil.exe", &approved, false),
            AppAuthorization::Denied
        );

        // Danh sách rỗng (chưa dò, chưa chọn) ⇒ không có gì chạy được.
        assert_eq!(
            decide_app_authorization(r"c:\any.exe", &[], false),
            AppAuthorization::Denied
        );
    }

    /// Đường dẫn mạng bị chặn TRƯỚC cả bước duyệt: một `.exe` trên share do kẻ tấn công
    /// kiểm soát có thể đổi nội dung sau khi được duyệt (TOCTOU trên nội dung file).
    #[test]
    fn app_tren_duong_dan_mang_bi_chan() {
        assert!(crate::is_network_or_device_path(r"\\attacker\share\a.exe"));
        assert!(crate::is_network_or_device_path(r"//attacker/share/a.exe"));
        assert!(!crate::is_network_or_device_path(r"C:\Corel\CorelDRW.exe"));
    }
}
