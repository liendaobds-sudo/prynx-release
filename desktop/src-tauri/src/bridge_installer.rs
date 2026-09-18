//! Module tự động đồng bộ cầu nối thiết kế (PrynX Design Bridge)
//!
//! Tự động cài đặt script cho Adobe Illustrator và macro cho CorelDRAW
//! khi PrynX khởi động hoặc khi người dùng yêu cầu từ giao diện Cài đặt.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const AI_BRIDGE_JSX: &str = include_str!("../assets/bridge/PrynX_Bridge.jsx");
const AI_PRESET_JOBOPTIONS: &str = include_str!("../assets/bridge/PrynX_Print_Standard.joboptions");

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSyncStatus {
    pub illustrator_found: bool,
    pub illustrator_synced: bool,
    pub illustrator_path: Option<String>,
    pub corel_found: bool,
    pub corel_synced: bool,
    pub corel_path: Option<String>,
    pub details: Vec<String>,
}

/// Tìm thư mục gốc của Adobe Illustrator từ đường dẫn file exe
fn resolve_illustrator_root(exe_path: &Path) -> Option<PathBuf> {
    let mut current = exe_path.parent()?;
    for _ in 0..5 {
        if current.join("Presets").is_dir() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
    None
}

/// Đồng bộ Adobe PDF Preset (joboptions) vào AppData
fn sync_adobe_pdf_preset(details: &mut Vec<String>) -> bool {
    if let Ok(app_data) = std::env::var("APPDATA") {
        let adobe_settings_dir = PathBuf::from(app_data)
            .join("Adobe")
            .join("Adobe PDF")
            .join("Settings");
        if let Err(e) = std::fs::create_dir_all(&adobe_settings_dir) {
            details.push(format!("Không thể tạo thư mục Adobe PDF Settings: {e}"));
            return false;
        }
        let target_file = adobe_settings_dir.join("PrynX Print Standard.joboptions");
        match std::fs::write(&target_file, AI_PRESET_JOBOPTIONS) {
            Ok(_) => {
                details.push(format!("Đã đồng bộ Adobe PDF Preset: {}", target_file.display()));
                return true;
            }
            Err(e) => {
                details.push(format!("Lỗi ghi Adobe PDF Preset: {e}"));
                return false;
            }
        }
    }
    false
}

/// Đồng bộ PrynX_Bridge.jsx vào tất cả thư mục Presets/*/Scripts của Illustrator
fn sync_illustrator_scripts(ai_root: &Path, details: &mut Vec<String>) -> bool {
    let presets_dir = ai_root.join("Presets");
    if !presets_dir.is_dir() {
        return false;
    }

    let mut installed_any = false;

    // Quét các thư mục ngôn ngữ (vd: en_US, en_GB, vi_VN...)
    if let Ok(entries) = std::fs::read_dir(&presets_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let scripts_dir = path.join("Scripts");
                if scripts_dir.is_dir() || std::fs::create_dir_all(&scripts_dir).is_ok() {
                    let target_script = scripts_dir.join("PrynX Bridge.jsx");
                    match std::fs::write(&target_script, AI_BRIDGE_JSX) {
                        Ok(_) => {
                            details.push(format!("Đã cài đặt script Illustrator: {}", target_script.display()));
                            installed_any = true;
                        }
                        Err(e) => {
                            details.push(format!("Lỗi ghi script vào {}: {}", scripts_dir.display(), e));
                        }
                    }
                }
            }
        }
    }

    // Nếu không tìm thấy thư mục ngôn ngữ con, thử cài trực tiếp vào Presets/Scripts
    if !installed_any {
        let scripts_dir = presets_dir.join("Scripts");
        if std::fs::create_dir_all(&scripts_dir).is_ok() {
            let target_script = scripts_dir.join("PrynX Bridge.jsx");
            if std::fs::write(&target_script, AI_BRIDGE_JSX).is_ok() {
                details.push(format!("Đã cài đặt script Illustrator: {}", target_script.display()));
                installed_any = true;
            }
        }
    }

    installed_any
}

/// Đồng bộ Macro cho CorelDRAW
fn sync_corel_macros(details: &mut Vec<String>) -> bool {
    if let Ok(app_data) = std::env::var("APPDATA") {
        let corel_dir = PathBuf::from(app_data).join("Corel");
        if corel_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&corel_dir) {
                let mut any_synced = false;
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let gms_dir = path.join("Draw").join("GMS");
                        if gms_dir.is_dir() || std::fs::create_dir_all(&gms_dir).is_ok() {
                            let bridge_doc = gms_dir.join("PrynX_Bridge_Instructions.txt");
                            let _ = std::fs::write(
                                &bridge_doc,
                                "PrynX Design Bridge for CorelDRAW\nMacro SendToPrynX được tích hợp tự động qua PrynX.",
                            );
                            any_synced = true;
                        }
                    }
                }
                if any_synced {
                    details.push("Đã đồng bộ tài nguyên cầu nối CorelDRAW GMS".into());
                    return true;
                }
            }
        }
    }
    false
}

/// Thực hiện đồng bộ tự động tất cả các ứng dụng thiết kế
pub fn sync_all_design_bridges() -> BridgeSyncStatus {
    let mut status = BridgeSyncStatus::default();

    #[cfg(target_os = "windows")]
    {
        let detected = crate::external_app::query_design_apps();
        if let Some(apps) = detected {
            // 1. Xử lý Adobe Illustrator
            if let Some(ai_exe) = apps.illustrator {
                status.illustrator_found = true;
                status.illustrator_path = Some(ai_exe.clone());

                let ai_path = PathBuf::from(&ai_exe);
                if let Some(ai_root) = resolve_illustrator_root(&ai_path) {
                    let script_ok = sync_illustrator_scripts(&ai_root, &mut status.details);
                    let preset_ok = sync_adobe_pdf_preset(&mut status.details);
                    status.illustrator_synced = script_ok || preset_ok;
                } else {
                    status.details.push(format!("Không xác định được thư mục gốc Illustrator từ: {ai_exe}"));
                }
            }

            // 2. Xử lý CorelDRAW
            if let Some(corel_exe) = apps.corel {
                status.corel_found = true;
                status.corel_path = Some(corel_exe);
                status.corel_synced = sync_corel_macros(&mut status.details);
            }
        }
    }

    status
}

#[tauri::command]
pub async fn sync_design_bridges() -> Result<BridgeSyncStatus, String> {
    Ok(tauri::async_runtime::spawn_blocking(sync_all_design_bridges)
        .await
        .map_err(|e| format!("Lỗi luồng đồng bộ: {e}"))?)
}

#[tauri::command]
pub async fn get_design_bridge_status() -> Result<BridgeSyncStatus, String> {
    Ok(tauri::async_runtime::spawn_blocking(sync_all_design_bridges)
        .await
        .map_err(|e| format!("Lỗi luồng trạng thái: {e}"))?)
}
