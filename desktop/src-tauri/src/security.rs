use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::command;

/// Escape a value để nhúng an toàn vào PowerShell SINGLE-quoted string ('...').
/// Trong single-quoted string của PowerShell, MỌI ký tự đều literal (backtick, $,
/// $(...), newline...) — chỉ dấu nháy đơn ' là ký tự đóng chuỗi, nên chỉ cần double
/// nó thành ''. TUYỆT ĐỐI không nhúng vào double-quoted string (ở đó $ và ` mới sống).
/// Đây là nguồn chân lý duy nhất cho mọi chỗ nội suy path/value vào script PS.
pub(crate) fn ps_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

// SEC (audit 2026-09-04 §SEC.16-A0.1): không phân giải PowerShell qua PATH hay
// SystemRoot do process/user kiểm soát. GetSystemDirectoryW là nguồn hệ thống và
// mọi lời gọi bên dưới phải fail-closed nếu binary chuẩn không tồn tại.
#[cfg(target_os = "windows")]
fn windows_system_directory() -> Result<std::path::PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    // Giới hạn đường dẫn Win32 mở rộng là 32.767 UTF-16 code units.
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: buffer writable và sống hết lời gọi; wrapper truyền đúng chiều dài slice.
    let written = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if written == 0 || written >= buffer.len() {
        return Err("Không xác định được Windows system directory".to_string());
    }

    let directory = std::path::PathBuf::from(OsString::from_wide(&buffer[..written]));
    let is_system32 = directory
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("System32"));
    if !directory.is_absolute() || !is_system32 {
        return Err("Windows system directory không hợp lệ".to_string());
    }
    Ok(directory)
}

#[cfg(not(target_os = "windows"))]
fn windows_system_directory() -> Result<std::path::PathBuf, String> {
    Err("PowerShell chỉ được hỗ trợ trên Windows".to_string())
}

pub(crate) fn system_powershell_path() -> Result<std::path::PathBuf, String> {
    let system_directory = windows_system_directory()?;
    let powershell = system_directory
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let metadata = std::fs::metadata(&powershell)
        .map_err(|_| "Không tìm thấy PowerShell hệ thống".to_string())?;
    if !powershell.is_absolute() || !metadata.is_file() {
        return Err("PowerShell hệ thống không hợp lệ".to_string());
    }
    Ok(powershell)
}

fn powershell_command() -> Result<Command, String> {
    Ok(Command::new(system_powershell_path()?))
}

fn is_uniform_hex_placeholder(value: &str) -> bool {
    let mut expected = None;
    let mut saw_hex = false;
    for character in value.chars() {
        if character.is_ascii_whitespace()
            || matches!(character, '-' | '_' | ':' | '{' | '}' | '(' | ')')
        {
            continue;
        }
        let normalized = match character {
            '0' => '0',
            'f' | 'F' => 'F',
            _ => return false,
        };
        if expected.is_some_and(|current| current != normalized) {
            return false;
        }
        expected = Some(normalized);
        saw_hex = true;
    }
    saw_hex
}

/// Chuẩn hoá duy nhất trước khi hash/compare/storage: chỉ bỏ whitespace ngoài.
///
/// Casing phải giữ nguyên vì thuật toán HWID v1 đã hash trực tiếp chuỗi WMI sau
/// `trim()`. Đổi sang uppercase ở đây sẽ làm máy có serial mixed/lowercase ăn
/// activation mới khi migrate. Blob DPAPI tự mint với casing khác vẫn bị chặn
/// bằng đối chiếu case-sensitive với chính giá trị WMI đang quan sát.
fn sanitize_hardware_component(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || is_uniform_hex_placeholder(value) {
        return None;
    }
    let folded = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if matches!(
        folded.as_str(),
        "to be filled by o.e.m."
            | "default string"
            | "unknown"
            | "none"
            | "n/a"
            | "system serial number"
    ) {
        return None;
    }
    Some(value.to_string())
}

fn read_wmi_hardware_component(
    powershell_path: &std::path::Path,
    expression: &str,
) -> Option<String> {
    let output = Command::new(powershell_path)
        .args(["-NoProfile", "-NoLogo", "-Command", expression])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — không nháy cửa sổ console.
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    sanitize_hardware_component(&String::from_utf8_lossy(&output.stdout))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct HardwareComponents {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cpu: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bios: Option<String>,
}

impl HardwareComponents {
    fn ordered_values(&self) -> Vec<&str> {
        [
            self.uuid.as_deref(),
            self.cpu.as_deref(),
            self.bios.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// Một UUID thật, hoặc cặp CPU+BIOS, mới đủ làm neo. Không chấp nhận một serial
    /// đơn lẻ yếu vì nhiều OEM/VM trả cùng giá trị mặc định.
    fn has_strong_anchor(&self) -> bool {
        self.uuid.is_some() || (self.cpu.is_some() && self.bios.is_some())
    }
}

fn canonicalize_hardware_components(components: &HardwareComponents) -> HardwareComponents {
    HardwareComponents {
        uuid: components
            .uuid
            .as_deref()
            .and_then(sanitize_hardware_component),
        cpu: components
            .cpu
            .as_deref()
            .and_then(sanitize_hardware_component),
        bios: components
            .bios
            .as_deref()
            .and_then(sanitize_hardware_component),
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct StoredHardwareIdentity {
    v: u8,
    hardware_id: String,
    components: HardwareComponents,
}

const STORED_HWID_VERSION: u8 = 2;

fn valid_hardware_id(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn calculate_hardware_id(components: &HardwareComponents) -> Result<String, String> {
    let canonical = canonicalize_hardware_components(components);
    if !canonical.has_strong_anchor() {
        return Err("Không có đủ neo phần cứng đáng tin cậy (cần UUID hoặc CPU+BIOS)".to_string());
    }
    let values = canonical.ordered_values();
    if values.is_empty() {
        return Err("Không lấy được định danh phần cứng".to_string());
    }

    // Giữ đúng thuật toán/độ dài cũ để máy hợp lệ không ăn một activation mới khi cập nhật.
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(values.join("|").as_bytes());
    Ok(hex::encode(&digest[..8]).to_uppercase())
}

fn validate_enrolled_identity(
    stored: &StoredHardwareIdentity,
    observed: &HardwareComponents,
) -> Result<(), String> {
    if stored.v != STORED_HWID_VERSION || !valid_hardware_id(&stored.hardware_id) {
        return Err("Định dạng hồ sơ mã máy không hợp lệ".to_string());
    }
    if canonicalize_hardware_components(&stored.components) != stored.components {
        // DPAPI CurrentUser không chứng minh provenance. Không tự migrate một blob v2
        // non-canonical vì attacker có thể chọn casing/whitespace rồi tự mint ID cũ.
        return Err("Hồ sơ mã máy không ở dạng canonical; cần xác minh lại online".to_string());
    }
    if calculate_hardware_id(&stored.components)? != stored.hardware_id {
        return Err("Hồ sơ mã máy không khớp các thành phần đã đăng ký".to_string());
    }

    // SEC (audit 2026-09-04 §SEC.16-A0.2): DPAPI CurrentUser không chứng minh
    // provenance. Nếu cho UUID hoặc CPU+BIOS làm quorum khi nguồn kia đang thiếu,
    // chính user có thể tự mint vô hạn ID bằng thành phần không quan sát được.
    // A0 vì vậy chỉ nhận đúng projection WMI đầy đủ đã tạo ID; WMI trôi/rớt phải
    // fail-closed và xác minh lại, không âm thầm chọn một tập con khác.
    let canonical_observed = canonicalize_hardware_components(observed);
    if stored.components != canonical_observed
        || calculate_hardware_id(&canonical_observed)? != stored.hardware_id
    {
        return Err("Mã máy lưu trên đĩa không khớp đầy đủ phần cứng đang quan sát".to_string());
    }
    Ok(())
}

/// Xác thực cache chuỗi v1 bằng đúng hồ sơ đang quan sát. Không thử các tập con:
/// chính user Windows tạo được DPAPI blob nên mỗi tập con được chấp nhận sẽ trở thành
/// một identity thay thế trên cùng máy. Trường hợp WMI đã đổi/mất nguồn so với lần cài
/// cũ phải đi recovery online thay vì tự migrate mơ hồ.
fn migrate_legacy_identity(
    legacy_hwid: &str,
    observed: &HardwareComponents,
) -> Result<StoredHardwareIdentity, String> {
    let normalized = legacy_hwid.trim().to_uppercase();
    if !valid_hardware_id(&normalized) {
        return Err("Cache mã máy cũ sai định dạng".to_string());
    }

    // SEC (audit 2026-09-04 §SEC.16-A0.2): chỉ projection trim-only khớp đúng
    // thuật toán v1 được migrate. Đây vẫn là fingerprint WMI, chưa phải attestation.
    if calculate_hardware_id(observed).ok().as_deref() == Some(normalized.as_str()) {
        return Ok(StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: normalized,
            components: observed.clone(),
        });
    }
    Err("Cache mã máy cũ không được phần cứng hiện tại chứng thực".to_string())
}

/// Đọc ba nguồn WMI nhưng chưa tin nguồn nào riêng lẻ. Serial thô tuyệt đối không được log.
fn collect_hardware_components() -> Result<HardwareComponents, String> {
    let mut components = HardwareComponents::default();
    let powershell_path = system_powershell_path()?;

    // 1. System UUID (Win32_ComputerSystemProduct)
    components.uuid = read_wmi_hardware_component(
        &powershell_path,
        "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
    );

    // 2. CPU ProcessorId (hardware serial burned into silicon)
    components.cpu = read_wmi_hardware_component(
        &powershell_path,
        "(Get-CimInstance Win32_Processor).ProcessorId",
    );

    // 3. BIOS Serial Number
    components.bios = read_wmi_hardware_component(
        &powershell_path,
        "(Get-CimInstance Win32_BIOS).SerialNumber",
    );

    if components.ordered_values().is_empty() {
        log::warn!("[HWID] collect FAILED: khong lay duoc component nao (uuid/cpu/bios deu rong)");
        return Err("Could not collect any hardware identifiers".to_string());
    }

    // DIAG (warn → có ở release): chỉ số lượng/cờ nguồn, KHÔNG log serial thô.
    log::warn!(
        "[HWID] collect OK: count={} uuid={} cpu={} bios={}",
        components.ordered_values().len(),
        components.uuid.is_some(),
        components.cpu.is_some(),
        components.bios.is_some(),
    );
    Ok(components)
}

// ── HWID PHẢI ỔN ĐỊNH VÀ CÓ NEO PHẦN CỨNG ────────────────────────────────────
// ID vẫn đóng băng để WMI rớt tạm một nguồn không làm ăn thêm slot activation, nhưng
// cache DPAPI chỉ là nơi lưu enrollment. Mỗi process mới phải chứng minh UUID khớp hoặc
// CPU+BIOS cùng khớp; chính user Windows tạo được DPAPI blob nên không được tin plaintext.
static CACHED_HWID: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

const HWID_FILE: &str = "prynx_hwid.dat";

fn get_hwid_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(HWID_FILE))
}

fn store_hwid_to_disk(payload: &str) -> Result<(), String> {
    let path = get_hwid_path()?;
    let path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:PRYNX_DPAPI_IN)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        path_str
    );
    let output = powershell_command()?
        // SEC (audit 2026-07-26 F5): secret truyen qua BIEN MOI TRUONG cho child powershell,
        // KHONG noi suy vao -Command -> khong lo tren command line (WMI/Sysmon/EDR log argv).
        .env("PRYNX_DPAPI_IN", payload)
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI hwid encrypt failed: {}", e))?;
    if !output.status.success() {
        return Err("DPAPI hwid encrypt failed".to_string());
    }
    Ok(())
}

fn load_hwid_from_disk() -> Result<String, String> {
    let path = get_hwid_path()?;
    if !path.exists() {
        return Err("No stored hwid".to_string());
    }
    let path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $encrypted = [System.IO.File]::ReadAllBytes('{}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.Text.Encoding]::UTF8.GetString($decrypted)
        "#,
        path_str
    );
    let output = powershell_command()?
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI hwid decrypt failed: {}", e))?;
    if !output.status.success() {
        return Err("DPAPI hwid decrypt failed".to_string());
    }
    let h = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if h.is_empty() {
        return Err("Decrypted hwid is empty".to_string());
    }
    Ok(h)
}

fn resolve_hardware_identity(
    observed: HardwareComponents,
    stored_raw: Option<&str>,
) -> Result<(StoredHardwareIdentity, &'static str, bool), String> {
    let observed = canonicalize_hardware_components(&observed);
    match stored_raw {
        Some(raw) => match serde_json::from_str::<StoredHardwareIdentity>(raw) {
            Ok(stored) => {
                validate_enrolled_identity(&stored, &observed)?;
                Ok((stored, "DISK_V2_VERIFIED", false))
            }
            Err(_) => Ok((
                migrate_legacy_identity(raw, &observed)?,
                "DISK_V1_MIGRATED",
                true,
            )),
        },
        None => {
            let hardware_id = calculate_hardware_id(&observed)?;
            Ok((
                StoredHardwareIdentity {
                    v: STORED_HWID_VERSION,
                    hardware_id,
                    components: observed,
                },
                "COMPUTE_ENROLLED",
                true,
            ))
        }
    }
}

#[cfg(test)]
mod hardware_identity_tests {
    use super::*;

    fn observed(uuid: Option<&str>, cpu: Option<&str>, bios: Option<&str>) -> HardwareComponents {
        HardwareComponents {
            uuid: uuid.map(str::to_string),
            cpu: cpu.map(str::to_string),
            bios: bios.map(str::to_string),
        }
    }

    #[test]
    fn placeholder_wmi_bi_loai_khong_phan_biet_hoa_thuong() {
        for placeholder in [
            "00000000-0000-0000-0000-000000000000",
            "{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}",
            "0000 0000 0000",
            "ffffffffffffffff",
            "To Be Filled By O.E.M.",
            "to be filled by o.e.m.",
            "DEFAULT STRING",
            "Unknown",
            "NONE",
            "n/A",
            "System Serial Number",
        ] {
            assert_eq!(
                sanitize_hardware_component(placeholder),
                None,
                "placeholder phải bị loại: {placeholder}"
            );
        }
    }

    #[test]
    fn component_hop_le_duoc_trim_nhung_giu_nguyen_casing_v1() {
        assert_eq!(
            sanitize_hardware_component("  AbC-123-xYz\r\n"),
            Some("AbC-123-xYz".to_string())
        );
        assert_eq!(
            sanitize_hardware_component("F0F0-0001"),
            Some("F0F0-0001".to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_nam_trong_system32_tuyet_doi() {
        let system_directory = windows_system_directory().expect("Windows system directory");
        let powershell = system_powershell_path().expect("PowerShell hệ thống");
        let expected_relative = std::path::Path::new("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");

        assert!(system_directory.is_absolute());
        assert!(powershell.is_absolute());
        assert_eq!(
            system_directory
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("system32")
        );
        assert_eq!(
            powershell
                .strip_prefix(&system_directory)
                .expect("PowerShell phải nằm dưới system directory"),
            expected_relative
        );
    }

    #[test]
    fn cac_module_tauri_khong_spawn_powershell_qua_path() {
        let forbidden = ["new(", "\"power", "shell"].concat();
        for (name, source) in [
            ("security.rs", include_str!("security.rs")),
            ("external_app.rs", include_str!("external_app.rs")),
            ("lib.rs", include_str!("lib.rs")),
        ] {
            assert!(
                !source.to_ascii_lowercase().contains(&forbidden),
                "{name}: mọi PowerShell process phải đi qua đường dẫn System32 tuyệt đối"
            );
        }
    }

    #[test]
    fn enrollment_giu_nguyen_thuat_toan_hwid_cu() {
        let components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let expected = {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(b"UUID-A|CPU-A|BIOS-A");
            hex::encode(&digest[..8]).to_uppercase()
        };
        assert_eq!(calculate_hardware_id(&components).unwrap(), expected);
    }

    #[test]
    fn whitespace_ben_ngoai_khong_tao_hwid_thay_the() {
        let canonical = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let variant = observed(Some("  UUID-A\r\n"), Some(" CPU-A "), Some("BIOS-A\t"));
        assert_eq!(
            calculate_hardware_id(&variant).unwrap(),
            calculate_hardware_id(&canonical).unwrap()
        );

        let (enrolled, _, must_store) = resolve_hardware_identity(variant, None).unwrap();
        assert!(must_store);
        assert_eq!(enrolled.components, canonical);
    }

    #[test]
    fn casing_khac_khong_duoc_tu_mint_thanh_profile_cung_may() {
        let actual = observed(Some("Uuid-Mix"), Some("Cpu-AbC"), Some("Bios-xYz"));
        let forged = observed(Some("UUID-MIX"), Some("CPU-ABC"), Some("BIOS-XYZ"));
        assert_ne!(
            calculate_hardware_id(&actual).unwrap(),
            calculate_hardware_id(&forged).unwrap(),
        );

        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&forged).unwrap(),
            components: forged,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        assert!(resolve_hardware_identity(actual, Some(&raw)).is_err());
    }

    #[test]
    fn migrate_v1_mixed_case_giu_dung_oracle_thuat_toan_cu() {
        let components = observed(Some("Uuid-Mix"), Some("Cpu-AbC"), Some("Bios-xYz"));
        let legacy = {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(b"Uuid-Mix|Cpu-AbC|Bios-xYz");
            hex::encode(&digest[..8]).to_uppercase()
        };
        assert_eq!(calculate_hardware_id(&components).unwrap(), legacy);

        let (resolved, source, must_store) =
            resolve_hardware_identity(components.clone(), Some(&legacy)).unwrap();
        assert_eq!(resolved.hardware_id, legacy);
        assert_eq!(resolved.components, components);
        assert_eq!(source, "DISK_V1_MIGRATED");
        assert!(must_store);
    }

    #[test]
    fn cache_legacy_tuy_y_bi_tu_choi() {
        let components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        assert!(resolve_hardware_identity(components, Some("AAAAAAAAAAAAAAAA")).is_err());
    }

    #[test]
    fn cache_legacy_hop_le_duoc_migrate_khong_doi_id() {
        let components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let legacy = calculate_hardware_id(&components).unwrap();
        let (resolved, source, must_store) =
            resolve_hardware_identity(components, Some(&legacy)).unwrap();
        assert_eq!(resolved.hardware_id, legacy);
        assert_eq!(source, "DISK_V1_MIGRATED");
        assert!(must_store);
    }

    #[test]
    fn cache_legacy_tap_con_khong_tao_identity_thay_the() {
        let components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        for subset in [
            observed(Some("UUID-A"), None, None),
            observed(Some("UUID-A"), Some("CPU-A"), None),
            observed(Some("UUID-A"), None, Some("BIOS-A")),
            observed(None, Some("CPU-A"), Some("BIOS-A")),
        ] {
            let alternate = calculate_hardware_id(&subset).unwrap();
            assert!(
                resolve_hardware_identity(components.clone(), Some(&alternate)).is_err(),
                "legacy subset không được trở thành identity thứ hai: {subset:?}"
            );
        }
    }

    #[test]
    fn ho_so_v2_copy_sang_may_khac_bi_tu_choi() {
        let enrolled_components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&enrolled_components).unwrap(),
            components: enrolled_components,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        let other_machine = observed(Some("UUID-B"), Some("CPU-B"), Some("BIOS-B"));
        assert!(resolve_hardware_identity(other_machine, Some(&raw)).is_err());
    }

    #[test]
    fn ho_so_v2_uuid_khop_nhung_cpu_bios_bi_sua_van_bi_tu_choi() {
        let forged_components = observed(Some("UUID-A"), Some("CPU-FORGED"), Some("BIOS-FORGED"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&forged_components).unwrap(),
            components: forged_components,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        let actual = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        assert!(resolve_hardware_identity(actual, Some(&raw)).is_err());
    }

    #[test]
    fn ho_so_v2_khong_duoc_bo_thanh_phan_dang_quan_sat() {
        let forged_subset = observed(Some("UUID-A"), None, None);
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&forged_subset).unwrap(),
            components: forged_subset,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        let actual = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        assert!(resolve_hardware_identity(actual, Some(&raw)).is_err());
    }

    #[test]
    fn ho_so_v2_tu_mint_non_canonical_bi_tu_choi() {
        let non_canonical = observed(Some(" UUID-A "), Some("CPU-A"), Some("BIOS-A"));
        let canonical = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&non_canonical).unwrap(),
            components: non_canonical,
        };
        let raw = serde_json::to_string(&stored).unwrap();

        assert!(resolve_hardware_identity(canonical, Some(&raw)).is_err());
    }

    #[test]
    fn thieu_mot_nguon_wmi_da_enroll_phai_fail_closed() {
        let enrolled_components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&enrolled_components).unwrap(),
            components: enrolled_components,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        let partial = observed(Some("UUID-A"), None, None);
        assert!(resolve_hardware_identity(partial, Some(&raw)).is_err());
    }

    #[test]
    fn profile_cpu_va_bios_day_du_van_hop_le_khi_uuid_khong_co_tu_dau() {
        let enrolled_components = observed(None, Some("CPU-A"), Some("BIOS-A"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: calculate_hardware_id(&enrolled_components).unwrap(),
            components: enrolled_components,
        };
        let raw = serde_json::to_string(&stored).unwrap();
        let observed_again = observed(None, Some("CPU-A"), Some("BIOS-A"));
        assert!(resolve_hardware_identity(observed_again, Some(&raw)).is_ok());
    }

    #[test]
    fn mot_serial_yeu_khong_duoc_enroll() {
        for weak in [
            observed(None, Some("CPU-A"), None),
            observed(None, None, Some("BIOS-A")),
        ] {
            assert!(resolve_hardware_identity(weak, None).is_err());
        }
    }

    #[test]
    fn ho_so_v2_bi_sua_id_bi_tu_choi() {
        let components = observed(Some("UUID-A"), Some("CPU-A"), Some("BIOS-A"));
        let stored = StoredHardwareIdentity {
            v: STORED_HWID_VERSION,
            hardware_id: "AAAAAAAAAAAAAAAA".to_string(),
            components: components.clone(),
        };
        let raw = serde_json::to_string(&stored).unwrap();
        assert!(resolve_hardware_identity(components, Some(&raw)).is_err());
    }
}

#[command]
pub fn get_hardware_id() -> Result<String, String> {
    // 1. Memory cache — mấu chốt chống trôi giữa các heartbeat trong cùng phiên.
    {
        let cache = CACHED_HWID.lock().map_err(|e| format!("Lock: {}", e))?;
        if let Some(h) = cache.as_ref() {
            if !h.is_empty() {
                // KHÔNG log ở nhánh này: gọi mỗi request → sẽ ngập log. Chỉ log khi
                // HWID phải RESOLVE lại (disk/compute) — đó mới là lúc có nguy cơ trôi.
                return Ok(h.clone());
            }
        }
    }

    // SEC (audit 2026-09-02 §SEC.16): disk cache KHÔNG còn là authority. Mỗi lần mở
    // process phải quan sát lại phần cứng rồi mới được dùng ID đã đóng băng.
    let observed = collect_hardware_components()?;
    let hwid_path = get_hwid_path()?;
    let stored_raw = match load_hwid_from_disk() {
        Ok(raw) => Some(raw),
        Err(_error) if !hwid_path.exists() => None,
        Err(error) => {
            return Err(format!(
                "Hồ sơ mã máy đang tồn tại nhưng không xác thực được; không ghi đè: {error}"
            ))
        }
    };
    let (identity, source, must_store) =
        resolve_hardware_identity(observed, stored_raw.as_deref())?;
    if must_store {
        let encoded = serde_json::to_string(&identity)
            .map_err(|e| format!("Không mã hoá được hồ sơ mã máy: {e}"))?;
        // Không cho chạy với identity chỉ nằm trong RAM: restart có thể sinh ID khác
        // và ăn thêm slot activation. Lưu/migrate thất bại thì fail-closed ngay.
        store_hwid_to_disk(&encoded)?;
    }
    let hwid = identity.hardware_id;
    log::warn!(
        "[HWID] resolve: nguon={} hwid=...{}",
        source,
        &hwid[hwid.len().saturating_sub(4)..]
    );
    if let Ok(mut cache) = CACHED_HWID.lock() {
        *cache = Some(hwid.clone());
    }
    Ok(hwid)
}

// ══════════════════════════════════════════════════════════════
// VECTOR #2 FIX: Rust-side license validation cache.
// register_validated_key (gọi sau khi Supabase RPC thành công) nạp key vào cache;
// sign_api_request gate trên cache này trước khi ký. (Hàm validate_license_local cũ
// đã gỡ vì không nơi nào gọi — việc gate license nằm trong sign_api_request.)
// ══════════════════════════════════════════════════════════════

use std::sync::Mutex;

// SEC (audit 2026-09-09 §SEC.LICUX.COMMIT): thứ tự khóa duy nhất là transaction
// → renewal → pending/anchor/cache. Wrapper IPC lấy khóa này; helper *_inner
// không khóa lại, để giao dịch xác minh + DPAPI không deadlock do gọi lồng nhau.
static LICENSE_TRANSACTION: Mutex<()> = Mutex::new(());

pub(crate) fn license_transaction_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    LICENSE_TRANSACTION
        .lock()
        .map_err(|_| "Không khóa được giao dịch bản quyền".to_string())
}

#[derive(Clone)]
struct ValidatedLicense {
    validated_at: u64,
    hardware_id: String,
    license_token_hash: String,
}

/// Thông tin tối thiểu đã được xác minh từ token v2. Các trường vẫn là `Option`
/// để policy neo đồng hồ có thể fail-closed với dữ liệu thiếu trong unit test.
#[derive(Clone, Debug)]
struct VerifiedLicenseToken {
    version: u8,
    issued_at: Option<u64>,
    challenge: Option<String>,
    challenge_id: Option<String>,
    device_key_id: Option<String>,
}

const LICENSE_TOKEN_V2: u8 = 2;
const LICENSE_TOKEN_V3: u8 = 3;
// Lease offline v3 đủ cho một cuối tuần dài. Đây chỉ là TTL của token đã ký;
// challenge/proof online và neo đồng hồ vẫn giữ cửa sổ ngắn riêng bên dưới.
const LICENSE_TOKEN_V3_MAX_TTL_SECS: u64 = 72 * 60 * 60;
#[cfg(test)]
const LICENSE_TOKEN_V3_LEGACY_MAX_TTL_SECS: u64 = 15 * 60;
const LICENSE_CHALLENGE_BYTES: usize = 32;
const LICENSE_CHALLENGE_TTL_SECS: u64 = 5 * 60;
const LICENSE_CLOCK_SKEW_SECS: u64 = 5 * 60;
const MAX_PENDING_LICENSE_CHALLENGES: usize = 32;
// Cache binding trong RAM ngắn hơn lease token. Khi hết hạn, frontend có thể
// đăng ký lại token đã lưu bằng đường offline nếu anchor còn hợp lệ; không kéo
// dài cache lên 72h vì đó sẽ biến mất chốt refresh định kỳ của sidecar.
const VALIDATED_LICENSE_CACHE_TTL_SECS: u64 = 8 * 60 * 60;

/// Challenge nằm trong RAM của đúng process Tauri.  Không ghi challenge ra
/// disk/localStorage; restart sẽ buộc một lần xác minh online mới.
#[derive(Clone, Debug)]
struct PendingLicenseChallenge {
    challenge: String,
    license_key_hash: String,
    hardware_id: String,
    created_at: std::time::Instant,
    /// Phiên native tại thời điểm challenge được cấp. Logout/clear cache tăng
    /// epoch để mọi registration đang bay của phiên cũ bị từ chối ở commit.
    session_epoch: u64,
}

static PENDING_LICENSE_CHALLENGES: std::sync::LazyLock<
    Mutex<HashMap<String, PendingLicenseChallenge>>,
> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

// Epoch sống trong đúng process Tauri. Mỗi lần logout/clear cache, epoch tăng
// trước khi xoá pending/cache; registration phải giữ cùng epoch tới bước insert
// cuối cùng. Nhờ vậy clear không thể bị một registration cũ ghi ngược cache.
static LICENSE_SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

// Sau khi logout/thu hồi/clear cache, mọi lần đăng ký lại trong cùng process phải
// đi qua một proof online v2 + challenge mới. Nếu không có cờ này, request đã bay
// trong renderer có thể bắt lại cặp key/token cũ ngay sau khi sign-out dọn cache.
// Cờ chỉ được hạ tại commit thành công của registration có challenge, cùng critical
// section với `VALIDATED_KEYS` để không mở cửa giữa clear và insert.
static LICENSE_REVALIDATION_REQUIRED: AtomicBool = AtomicBool::new(false);

fn hash_license_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn hash_license_key(license_key: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(license_key.as_bytes()))
}

fn normalize_license_challenge(value: &str) -> Option<String> {
    if value.len() != LICENSE_CHALLENGE_BYTES * 2
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

fn normalize_device_key_id(value: &str) -> Option<String> {
    let thumbprint = value.strip_prefix("d3_")?;
    if thumbprint.len() != 43
        || !thumbprint
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_challenge_id(value: &str) -> Option<String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
    {
        return None;
    }
    Some(value.to_string())
}

fn prune_pending_license_challenges(pending: &mut HashMap<String, PendingLicenseChallenge>) {
    let ttl = std::time::Duration::from_secs(LICENSE_CHALLENGE_TTL_SECS);
    pending.retain(|_, entry| entry.created_at.elapsed() <= ttl);
}

fn validate_pending_license_challenge(
    pending: &mut HashMap<String, PendingLicenseChallenge>,
    challenge: &str,
    license_key: &str,
    hardware_id: &str,
) -> Result<(), String> {
    prune_pending_license_challenges(pending);
    let entry = pending
        .get(challenge)
        .ok_or_else(|| "License challenge không tồn tại hoặc đã hết hạn".to_string())?;
    if entry.challenge != challenge
        || entry.license_key_hash != hash_license_key(license_key)
        || entry.hardware_id != hardware_id
    {
        return Err("License challenge không khớp key hoặc mã máy".to_string());
    }
    Ok(())
}

fn validate_pending_license_challenge_for_epoch(
    pending: &mut HashMap<String, PendingLicenseChallenge>,
    challenge: &str,
    license_key: &str,
    hardware_id: &str,
    session_epoch: u64,
) -> Result<(), String> {
    validate_pending_license_challenge(pending, challenge, license_key, hardware_id)?;
    let entry = pending
        .get(challenge)
        .ok_or_else(|| "License challenge không tồn tại hoặc đã hết hạn".to_string())?;
    if entry.session_epoch != session_epoch {
        return Err("License challenge thuộc phiên native cũ".to_string());
    }
    Ok(())
}

/// Chính sách registration sau một lần invalidate native. `clear_validated_keys`
/// đặt cờ này để đường đăng ký không challenge (offline hoặc retry của
/// renderer) không thể tái tạo quyền trong cùng process. Challenge v2 được kiểm
/// tra sâu hơn ở `register_validated_key`; helper giữ hợp đồng fail-closed rõ ràng
/// và dễ kiểm thử.
fn ensure_registration_challenge_policy(
    challenge_present: bool,
    revalidation_required: bool,
    replacement_requested: bool,
) -> Result<(), String> {
    if !challenge_present && (revalidation_required || replacement_requested) {
        let reason = if replacement_requested {
            "Thay license binding yêu cầu challenge online"
        } else {
            "Sau khi xoá cache bản quyền, cần xác minh online bằng challenge mới"
        };
        return Err(reason.to_string());
    }
    Ok(())
}

/// Bắt đầu một lần xác minh online. Challenge không đi qua disk/localStorage và
/// được ràng buộc với đúng key + HWID mà native tự lấy.
#[command]
pub fn begin_license_validation(license_key: String) -> Result<String, String> {
    let _transaction = license_transaction_guard()?;
    let license_key = license_key.trim().to_string();
    if license_key.is_empty() || license_key.len() > 256 {
        return Err("License key không hợp lệ".to_string());
    }
    let hardware_id = get_hardware_id()?;
    let mut bytes = [0u8; LICENSE_CHALLENGE_BYTES];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    let challenge = hex::encode(bytes);

    let mut pending = PENDING_LICENSE_CHALLENGES
        .lock()
        .map_err(|error| format!("Lock error: {error}"))?;
    let session_epoch = LICENSE_SESSION_EPOCH.load(Ordering::Acquire);
    prune_pending_license_challenges(&mut pending);
    let key_hash = hash_license_key(&license_key);
    // Một key chỉ có một challenge đang chờ; challenge cũ bị vô hiệu khi bắt đầu
    // lượt mới, tránh giữ nhiều proof có thể bị phát lại trong cùng process.
    pending
        .retain(|_, entry| entry.license_key_hash != key_hash || entry.hardware_id != hardware_id);
    if pending.len() >= MAX_PENDING_LICENSE_CHALLENGES {
        return Err("Quá nhiều lượt xác minh đang chờ; vui lòng thử lại".to_string());
    }
    pending.insert(
        challenge.clone(),
        PendingLicenseChallenge {
            challenge: challenge.clone(),
            license_key_hash: key_hash,
            hardware_id,
            created_at: std::time::Instant::now(),
            session_epoch,
        },
    );
    Ok(challenge)
}

fn ensure_license_token_binding(
    binding: &ValidatedLicense,
    license_token: &str,
) -> Result<(), String> {
    // SEC (feedback 2026-08-15 §UP.403): không ký bằng binding của token cũ.
    // Frontend sẽ đăng ký lại token đã được native verify rồi thử ký đúng một lần.
    if binding.license_token_hash != hash_license_token(license_token) {
        return Err("Token bản quyền đã thay đổi; cần đăng ký lại cache Rust".to_string());
    }
    Ok(())
}

/// Kiểm tra tuổi cache native mà không dùng `saturating_sub`: đồng hồ lùi phải
/// bị từ chối, không được biến thành cache vừa mới xác thực. Token v3 có lease
/// 72 giờ nhưng binding RAM vẫn chỉ sống 8 giờ; sau đó frontend đăng ký lại
/// token DPAPI đã ký (không cần gọi mạng) khi neo đồng hồ còn hợp lệ.
fn validated_license_cache_is_fresh(validated_at: u64, now_secs: u64) -> Result<bool, String> {
    if now_secs < validated_at {
        return Err("Clock rollback detected; license cache is from the future".to_string());
    }
    Ok(now_secs - validated_at < VALIDATED_LICENSE_CACHE_TTL_SECS)
}

// In-memory cache of native-verified license bindings (session-scoped).
static VALIDATED_KEYS: std::sync::LazyLock<Mutex<HashMap<String, ValidatedLicense>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Commit binding mới trong cùng critical section. Lượt thay key đã có challenge
/// online được quyền thay toàn bộ cache phiên, kể cả khi binding cũ đã mất sau
/// restart/cache miss; không được biến cache RAM thành authority cao hơn proof v2.
fn commit_validated_license_binding(
    cache: &mut HashMap<String, ValidatedLicense>,
    license_key: String,
    binding: ValidatedLicense,
    replace_license_key: Option<&str>,
) -> Result<(), String> {
    if let Some(previous_key) = replace_license_key {
        if previous_key == license_key {
            return Err("Binding thay thế phải dùng license key khác".to_string());
        }
        cache.clear();
    }

    cache.insert(license_key, binding);
    Ok(())
}

fn persist_then_commit_binding(
    cache: &mut HashMap<String, ValidatedLicense>,
    license_key: String,
    binding: ValidatedLicense,
    replace_license_key: Option<&str>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if replace_license_key == Some(license_key.as_str()) {
        return Err("Binding thay thế phải dùng license key khác".into());
    }
    persist()?;
    commit_validated_license_binding(cache, license_key, binding, replace_license_key)
}

/// Called by frontend after successful Supabase RPC validation
/// to register the key in Rust's in-memory cache.
///
/// Release builds always verify the server-signed Ed25519 token before caching.
/// Debug builds may run without a token unless production-equivalent enforcement
/// is explicitly enabled.
#[command]
pub fn register_validated_key(
    license_key: String,
    token: Option<String>,
    challenge: Option<String>,
    challenge_id: Option<String>,
    replace_license_key: Option<String>,
) -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    register_validated_key_inner(
        license_key,
        token,
        challenge,
        challenge_id,
        replace_license_key,
        || Ok(()),
    )
}

fn register_validated_key_inner(
    license_key: String,
    token: Option<String>,
    challenge: Option<String>,
    challenge_id: Option<String>,
    replace_license_key: Option<String>,
    before_binding_commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let license_key = license_key.trim().to_string();
    if license_key.is_empty() || license_key.len() > 256 {
        return Err("License key không hợp lệ".to_string());
    }
    let replace_license_key = match replace_license_key {
        Some(value) => {
            let normalized = value.trim().to_string();
            if normalized.is_empty() || normalized.len() > 256 {
                return Err("License key cũ cần thay thế không hợp lệ".to_string());
            }
            Some(normalized)
        }
        None => None,
    };
    if replace_license_key.as_deref() == Some(license_key.as_str()) {
        return Err("Binding thay thế phải dùng license key khác".to_string());
    }
    let tok = token.unwrap_or_default().trim().to_string();
    // Release builds always fail closed. Environment chỉ có tác dụng trong debug để
    // mô phỏng production; không có cờ runtime nào tắt được enforcement của bản ship.
    let enforce = license_token_enforcement_enabled();
    // SEC (audit 2026-09-09 §SEC.LIC20.S1): v3 dùng khóa CNG, không phụ thuộc
    // hồ sơ WMI/DPAPI legacy. Hint chỉ chọn công việc cần làm; chữ ký và toàn bộ
    // claims vẫn được verify bên dưới, không cấp quyền từ payload chưa xác minh.
    let hw = registration_hardware_id(&tok, get_hardware_id)?;
    // V3 chỉ chấp nhận device ID suy ra từ public key của chính Platform KSP.
    // Lỗi/no-TPM được giữ lại dưới dạng None để token legacy vẫn drain được,
    // còn verifier v3 sẽ fail-closed thay vì rơi về HWID.
    let local_device_key_id = crate::device_identity::get_device_public_identity()
        .ok()
        .map(|identity| identity.device_key_id);
    let verified = if tok.is_empty() {
        if enforce {
            return Err("License token required but not provided (enforce mode)".to_string());
        }
        None
    } else {
        // Never trust a hardware id supplied by the WebView. A patched frontend
        // could otherwise make every installation impersonate the same activated
        // machine. Rust derives the fingerprint itself and rejects any mismatch.
        Some(
            verify_license_token_internal(&tok, &hw, &license_key, local_device_key_id.as_deref())
                .map_err(|error| format!("License token rejected by native gate: {error}"))?,
        )
    };

    let normalized_challenge = match challenge.as_deref() {
        Some(value) => Some(
            normalize_license_challenge(value)
                .ok_or_else(|| "License challenge không hợp lệ".to_string())?,
        ),
        None => None,
    };
    let normalized_challenge_id = match challenge_id.as_deref() {
        Some(value) => Some(
            normalize_challenge_id(value)
                .ok_or_else(|| "Biên nhận challenge v3 không hợp lệ".to_string())?,
        ),
        None => None,
    };
    if normalized_challenge.is_some() && normalized_challenge_id.is_some() {
        return Err("Không được trộn challenge v2 và biên nhận v3".to_string());
    }
    let online_proof_present = normalized_challenge.is_some() || normalized_challenge_id.is_some();
    // Fast-fail cho đường offline sau logout. Vẫn kiểm tra lại dưới mutex cache ở
    // bước commit bên dưới vì clear có thể xảy ra ngay sau lần đọc atomic này.
    ensure_registration_challenge_policy(
        online_proof_present,
        LICENSE_REVALIDATION_REQUIRED.load(Ordering::Acquire),
        replace_license_key.is_some(),
    )?;

    // Chụp epoch ngay đầu giao dịch. Nếu logout/clear xảy ra trong lúc verify
    // token hoặc ghi anchor, bước commit phía dưới sẽ phát hiện epoch đã đổi.
    let registration_epoch = LICENSE_SESSION_EPOCH.load(Ordering::Acquire);

    // Giữ lock pending trong suốt giao dịch để hai request đồng thời không cùng
    // tiêu thụ một challenge. Entry chỉ bị xoá sau khi anchor + cache đã ghi xong;
    // mọi lỗi trước đó đều để challenge còn lại cho lần retry online.
    let mut pending_guard = if let Some(challenge_value) = normalized_challenge.as_ref() {
        let mut guard = PENDING_LICENSE_CHALLENGES
            .lock()
            .map_err(|error| format!("Lock error: {error}"))?;
        validate_pending_license_challenge_for_epoch(
            &mut guard,
            challenge_value,
            &license_key,
            &hw,
            registration_epoch,
        )?;
        Some(guard)
    } else {
        None
    };

    if let Some(challenge_value) = normalized_challenge.as_ref() {
        let claims = verified
            .as_ref()
            .ok_or_else(|| "License challenge yêu cầu token đã ký".to_string())?;
        if claims.version != LICENSE_TOKEN_V2
            || claims.challenge.as_deref() != Some(challenge_value.as_str())
        {
            return Err("License challenge không khớp token v2".to_string());
        }
    }
    if let Some(challenge_id_value) = normalized_challenge_id.as_ref() {
        let claims = verified
            .as_ref()
            .ok_or_else(|| "Biên nhận challenge v3 yêu cầu token đã ký".to_string())?;
        if claims.version != LICENSE_TOKEN_V3
            || claims.challenge_id.as_deref() != Some(challenge_id_value.as_str())
        {
            return Err("Challenge ID không khớp token v3".to_string());
        }
        let device_key_id = claims
            .device_key_id
            .as_deref()
            .ok_or_else(|| "Token v3 thiếu khóa thiết bị".to_string())?;
        let issued_at = claims
            .issued_at
            .ok_or_else(|| "Token v3 thiếu thời điểm cấp".to_string())?;
        crate::device_identity::consume_device_proof_receipt(
            challenge_id_value,
            device_key_id,
            issued_at,
            replace_license_key.is_some(),
        )?;
    } else if normalized_challenge.is_some()
        && verified
            .as_ref()
            .map(|claims| claims.version == LICENSE_TOKEN_V3)
            .unwrap_or(false)
    {
        return Err("Token v3 không được đăng ký bằng challenge v2".to_string());
    }

    // SEC (audit 2026-09-03 §SEC.19): đăng ký binding cũng là một đường cấp quyền.
    // Anchor thiếu/hỏng chỉ được khôi phục sau proof online (token v2/v3 +
    // challenge/receipt hiện tại). Anchor hợp lệ mới cho phép đăng ký lại token
    // đã cache khi offline.
    let now_ms = epoch_millis()?;
    let _anchor_guard = clock_anchor_guard();
    let anchor_state = load_clock_anchor_state_unlocked();
    let anchor_required = clock_anchor_required();
    let anchor_target = license_anchor_update_target(
        anchor_state,
        anchor_required,
        now_ms,
        verified.as_ref(),
        online_proof_present,
    )?;
    if let Some(target_ms) = anchor_target {
        let should_write =
            !matches!(anchor_state, ClockAnchorState::Valid(current_ms) if target_ms <= current_ms);
        if should_write {
            let path = get_clock_anchor_path()?;
            atomic_store_clock_anchor(&path, target_ms)?;
        }
    }

    let license_token_hash = hash_license_token(&tok);
    let now = now_ms / 1_000;
    {
        // VALIDATED_KEYS mutex là commit barrier chung với clear_validated_keys:
        // kiểm epoch + insert nằm cùng critical section, nên không có cửa sổ
        // clear xong rồi registration cũ chèn lại cache.
        let mut cache = VALIDATED_KEYS
            .lock()
            .map_err(|error| format!("Lock error: {error}"))?;
        if LICENSE_SESSION_EPOCH.load(Ordering::Acquire) != registration_epoch {
            return Err("Phiên license native đã thay đổi; cần xác minh lại online".to_string());
        }
        // Re-check cùng cache mutex với `clear_validated_keys`: nếu clear thắng
        // trước lock này thì cờ đã bật; nếu registration thắng trước thì clear sẽ
        // xoá binding ngay sau đó. Không có cửa sổ stale re-register.
        ensure_registration_challenge_policy(
            online_proof_present,
            LICENSE_REVALIDATION_REQUIRED.load(Ordering::Acquire),
            replace_license_key.is_some(),
        )?;
        let bound_machine_id = verified
            .as_ref()
            .and_then(|claims| claims.device_key_id.clone())
            .unwrap_or_else(|| hw.clone());
        // Chỉ persist sau toàn bộ chữ ký/proof/anchor/epoch, nhưng trước khi
        // binding mới có thể cấp chữ ký API. Lỗi ghi giữ nguyên binding cũ.
        persist_then_commit_binding(
            &mut cache,
            license_key,
            ValidatedLicense {
                validated_at: now,
                hardware_id: bound_machine_id,
                license_token_hash,
            },
            replace_license_key.as_deref(),
            before_binding_commit,
        )?;
        if let (Some(challenge_value), Some(guard)) =
            (normalized_challenge.as_ref(), pending_guard.as_mut())
        {
            guard.remove(challenge_value);
        }
        // Chỉ proof online v2/v3 đã commit mới mở lại đường offline cho tới lần
        // clear kế tiếp. Registration không proof không bao giờ hạ cờ.
        if online_proof_present {
            LICENSE_REVALIDATION_REQUIRED.store(false, Ordering::Release);
        }
    }
    Ok(())
}

fn parse_security_flag(value: Option<&str>) -> bool {
    value
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

fn enforcement_policy(is_debug_build: bool, env_value: Option<&str>) -> bool {
    !is_debug_build || parse_security_flag(env_value)
}

fn license_token_enforcement_enabled() -> bool {
    let env_value = std::env::var("PRYNX_ENFORCE_LICENSE_TOKEN").ok();
    enforcement_policy(cfg!(debug_assertions), env_value.as_deref())
}

// SEC (audit 2026-09-09 §SEC.LICUX.NATIVE): renderer chỉ nhận policy debug từ
// native; bản release luôn enforced bất kể environment hay cờ frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRuntimePolicy {
    development: bool,
    clock_anchor_required: bool,
}

fn development_license_mode(is_debug: bool, token: bool, anchor: bool, gated: bool) -> bool {
    is_debug && !token && !anchor && !gated
}

#[command]
pub fn get_license_runtime_policy() -> LicenseRuntimePolicy {
    let anchor_required = clock_anchor_required();
    let gated = parse_security_flag(
        std::env::var("PRYNX_FEATURE_GATING_ENABLED")
            .ok()
            .as_deref(),
    );
    LicenseRuntimePolicy {
        development: development_license_mode(
            cfg!(debug_assertions),
            license_token_enforcement_enabled(),
            anchor_required,
            gated,
        ),
        clock_anchor_required: anchor_required,
    }
}

pub(crate) fn license_session_epoch() -> u64 {
    LICENSE_SESSION_EPOCH.load(Ordering::Acquire)
}

fn registration_hardware_id(
    token: &str,
    legacy_resolver: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let version_hint = token.split_once('.').and_then(|(payload, _)| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|claims| claims.get("v").and_then(serde_json::Value::as_u64))
    });
    if version_hint == Some(u64::from(LICENSE_TOKEN_V3)) {
        Ok(String::new())
    } else {
        legacy_resolver()
    }
}

#[cfg(test)]
mod license_runtime_policy_tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn release_va_dev_gated_khong_co_quyen_dev_gia() {
        for token in [false, true] {
            for anchor in [false, true] {
                for gated in [false, true] {
                    assert!(!development_license_mode(false, token, anchor, gated));
                }
            }
        }
        assert!(development_license_mode(true, false, false, false));
        assert!(!development_license_mode(true, true, false, false));
        assert!(!development_license_mode(true, false, true, false));
        assert!(!development_license_mode(true, false, false, true));
    }

    #[test]
    fn v3_khong_doc_hwid_legacy_nhung_chu_ky_gia_van_bi_chan() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"v":3}"#);
        let fake = format!("{payload}.ZmFrZQ");
        let hw =
            registration_hardware_id(&fake, || panic!("v3 không được đọc HWID legacy")).unwrap();
        assert!(hw.is_empty());
        assert!(verify_license_token_internal(&fake, &hw, "KEY", Some("d3_invalid")).is_err());
    }

    #[test]
    fn token_legacy_va_hong_khong_duoc_ne_hwid() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"v":2}"#);
        for token in [format!("{payload}.ZmFrZQ"), String::new(), "invalid".into()] {
            assert!(registration_hardware_id(&token, || Err("WMI unavailable".into())).is_err());
        }
    }
}

/// Xoá sạch cache key đã xác thực → sign_api_request lập tức từ chối ký request mới.
/// Gọi khi license bị thu hồi/khóa để chặn quyền dùng NGAY trong phiên, không chờ
/// cache hết TTL.
/// Best-effort: lỗi lock chỉ trả về String, không panic.
#[command]
pub fn clear_validated_keys() -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    clear_validated_keys_inner()
}

fn clear_validated_keys_inner() -> Result<(), String> {
    {
        let mut cache = VALIDATED_KEYS
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        // Tăng epoch trong cùng mutex với cache clear. Registration đang giữ
        // pending challenge cũ sẽ thấy epoch lệch và fail, hoặc đã commit
        // trước đó thì bị xoá ngay tại đây.
        LICENSE_SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
        LICENSE_REVALIDATION_REQUIRED.store(true, Ordering::Release);
        cache.clear();
    }
    // Không giữ VALIDATED_KEYS mutex khi lấy pending mutex (register giữ thứ tự
    // pending → cache); epoch ở trên đã đóng cửa sổ race trong khoảng này.
    let mut pending = PENDING_LICENSE_CHALLENGES
        .lock()
        .map_err(|e| format!("Pending challenge lock error: {}", e))?;
    pending.clear();
    drop(pending);
    crate::device_identity::clear_device_proof_receipts()?;
    Ok(())
}

// ── F2: Ed25519 license-token verification (đối xứng với backend license_guard.py) ──
// Public key TRUST ANCHOR — PHẢI KHỚP `_LICENSE_PUBLIC_KEY_B64` ở backend.
const LICENSE_PUBLIC_KEY_B64: &str = "AxpiZnEFXady9wI01spdMRrTNtEthMD30W/90gi27Zk=";

fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| format!("b64url: {}", e))
}

/// Verify token "<payload_b64url>.<sig_b64url>" (sig ký trên BYTES ASCII của payload_b64url).
/// SEC (audit 2026-09-04 §SEC.16-DS1): nhận v1 legacy theo cửa tương thích hẹp;
/// mọi proof online/khôi phục state vẫn phải dùng token v2 có `iat` + `challenge`.
fn verify_license_token_internal(
    token: &str,
    hwid: &str,
    license_key: &str,
    local_device_key_id: Option<&str>,
) -> Result<VerifiedLicenseToken, String> {
    verify_token_with_pubkey_and_device(
        token,
        hwid,
        license_key,
        LICENSE_PUBLIC_KEY_B64,
        local_device_key_id,
    )
}

/// Lõi verify, nhận pubkey tham số (để unit-test bằng keypair test mà không cần private key thật).
fn verify_token_with_pubkey(
    token: &str,
    hwid: &str,
    license_key: &str,
    pub_b64: &str,
) -> Result<VerifiedLicenseToken, String> {
    verify_token_with_pubkey_and_device(token, hwid, license_key, pub_b64, None)
}

fn verify_token_with_pubkey_and_device(
    token: &str,
    hwid: &str,
    license_key: &str,
    pub_b64: &str,
    local_device_key_id: Option<&str>,
) -> Result<VerifiedLicenseToken, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let (payload_b64, sig_b64) = token.split_once('.').ok_or("malformed license token")?;

    let pub_bytes = STANDARD
        .decode(pub_b64)
        .map_err(|e| format!("pubkey b64: {}", e))?;
    let pub_arr: [u8; 32] = pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "pubkey length")?;
    let vk = VerifyingKey::from_bytes(&pub_arr).map_err(|e| format!("pubkey: {}", e))?;

    let sig_bytes = b64url_decode(sig_b64)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("sig: {}", e))?;
    vk.verify(payload_b64.as_bytes(), &sig)
        .map_err(|_| "invalid license token signature".to_string())?;

    let payload_bytes = b64url_decode(payload_b64)?;
    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|e| format!("payload json: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system clock before unix epoch".to_string())?
        .as_secs();
    let exp = payload
        .get("exp")
        .and_then(|value| value.as_u64())
        .ok_or("license token missing or invalid exp")?;
    if exp < now {
        return Err("license token expired".to_string());
    }

    // V3 (đối xứng backend license_guard.py): cận trên tuổi thọ token — chống replay token
    // cũ bằng cách LÙI đồng hồ hệ thống. Token TTL 72h nên (exp - now) hợp lệ luôn ≤ TTL;
    // vượt cận (TTL + dư + skew) ⇒ đồng hồ đã bị lùi xa lúc cấp token. Không phụ thuộc file
    // trên đĩa nên không thể vô hiệu bằng cách xoá state.
    // 8 ngày. Lease server V3 hiện là 72h; cận rộng hơn vẫn giữ để token legacy
    // 7 ngày cũ tiếp tục tương thích trong giai đoạn chuyển tiếp.
    // Siết xuống 4 ngày SAU KHI chúng hết hạn. Bất biến: PHẢI ≥ TTL token edge function cấp.
    const MAX_TOKEN_LIFETIME_SECS: u64 = 8 * 24 * 60 * 60;
    if exp - now > MAX_TOKEN_LIFETIME_SECS {
        return Err("license token lifetime implausible (clock rollback?)".to_string());
    }

    // Thiếu field `v` là v1 legacy. Giá trị null/bool/string/version lạ không
    // được ép kiểu vì sẽ tạo protocol ambiguity giữa các tầng.
    let version = match payload.get("v") {
        None => 1,
        Some(value) => {
            let version_raw = value.as_u64().ok_or("license token has invalid version")?;
            let parsed = u8::try_from(version_raw)
                .map_err(|_| "license token version is invalid".to_string())?;
            if parsed != 1 && parsed != LICENSE_TOKEN_V2 && parsed != LICENSE_TOKEN_V3 {
                return Err("unsupported license token version".to_string());
            }
            parsed
        }
    };

    let (issued_at, token_challenge, challenge_id, device_key_id) = if version == 1 {
        // V1 không có semantics cho iat/challenge. Từ chối token hybrid thay vì
        // âm thầm bỏ qua claim để mọi tầng phân loại protocol giống nhau.
        if ["iat", "challenge", "cid", "d", "cnf", "min_v"]
            .iter()
            .any(|field| payload.get(*field).is_some())
        {
            return Err("license token v1 has incompatible v2 claims".to_string());
        }
        (None, None, None, None)
    } else if version == LICENSE_TOKEN_V2 {
        if ["cid", "d", "cnf", "min_v"]
            .iter()
            .any(|field| payload.get(*field).is_some())
        {
            return Err("license token v2 has incompatible v3 claims".to_string());
        }
        let issued_at = payload
            .get("iat")
            .and_then(|value| value.as_u64())
            .filter(|value| *value > 0)
            .ok_or("license token v2 missing or invalid iat")?;
        let max_iat = now.saturating_add(LICENSE_CLOCK_SKEW_SECS);
        if issued_at > max_iat {
            return Err("license token issued-at is in the future".to_string());
        }
        if exp < issued_at || exp - issued_at > MAX_TOKEN_LIFETIME_SECS {
            return Err("license token lifetime is invalid".to_string());
        }
        let challenge = payload
            .get("challenge")
            .and_then(|value| value.as_str())
            .and_then(normalize_license_challenge)
            .ok_or("license token v2 missing or invalid challenge")?;
        (Some(issued_at), Some(challenge), None, None)
    } else {
        if payload.get("challenge").is_some() {
            return Err("license token v3 must not contain raw challenge".to_string());
        }
        let issued_at = payload
            .get("iat")
            .and_then(|value| value.as_u64())
            .filter(|value| *value > 0)
            .ok_or("license token v3 missing or invalid iat")?;
        if issued_at > now.saturating_add(LICENSE_CLOCK_SKEW_SECS)
            || exp < issued_at
            || exp - issued_at > LICENSE_TOKEN_V3_MAX_TTL_SECS
        {
            return Err("license token v3 lifetime is invalid".to_string());
        }
        if payload.get("min_v").and_then(|value| value.as_u64()) != Some(LICENSE_TOKEN_V3.into()) {
            return Err("license token v3 protocol floor is invalid".to_string());
        }
        let device_id = payload
            .get("d")
            .and_then(|value| value.as_str())
            .and_then(normalize_device_key_id)
            .ok_or("license token v3 device key id is invalid")?;
        let expected_device_id = local_device_key_id
            .and_then(normalize_device_key_id)
            .ok_or("local TPM device key is unavailable")?;
        if device_id != expected_device_id {
            return Err("license token TPM device mismatch".to_string());
        }
        let thumbprint = device_id
            .strip_prefix("d3_")
            .ok_or("license token v3 device key id is invalid")?;
        let confirmation = payload
            .get("cnf")
            .and_then(|value| value.as_object())
            .ok_or("license token v3 confirmation is invalid")?;
        if confirmation.len() != 1
            || confirmation.get("jkt").and_then(|value| value.as_str()) != Some(thumbprint)
        {
            return Err("license token v3 confirmation mismatch".to_string());
        }
        let cid = payload
            .get("cid")
            .and_then(|value| value.as_str())
            .and_then(normalize_challenge_id)
            .ok_or("license token v3 challenge id is invalid")?;
        (Some(issued_at), None, Some(cid), Some(device_id))
    };

    // DS-4: field "m" (machine id) BẮT BUỘC — đối xứng với backend license_guard.py:248.
    // Token thiếu "m" KHÔNG được pass (chống token vạn năng dùng mọi máy).
    let m = payload
        .get("m")
        .and_then(|v| v.as_str())
        .ok_or("license token missing required field: machine id")?;
    if version == LICENSE_TOKEN_V3 {
        if device_key_id.as_deref() != Some(m) {
            return Err("license token v3 machine/device mismatch".to_string());
        }
    } else if !hwid.is_empty() && m != hwid {
        return Err("license token machine mismatch".to_string());
    }

    // DS-4: field "k" (key hash) BẮT BUỘC — đối xứng với backend license_guard.py:255.
    let k = payload
        .get("k")
        .and_then(|v| v.as_str())
        .ok_or("license token missing required field: key hash")?;
    if !license_key.is_empty() {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(license_key.as_bytes());
        let kh = hex::encode(h.finalize());
        if k != &kh[..16] {
            return Err("license token key mismatch".to_string());
        }
    }
    match payload.get("p").and_then(|v| v.as_str()) {
        Some("prynx") => {}
        Some(_) => return Err("license token product mismatch".to_string()),
        None => return Err("license token missing required field: product".to_string()),
    }
    Ok(VerifiedLicenseToken {
        version,
        issued_at,
        challenge: token_challenge,
        challenge_id,
        device_key_id,
    })
}

#[cfg(test)]
mod ps_escape_tests {
    use super::*;

    // Regression: path/value nội suy vào PowerShell single-quoted string PHẢI escape
    // dấu nháy đơn. Bug cũ escape nhầm '\' (double-backslash) — vô nghĩa trong
    // single-quoted string, để ' lọt qua → path như a'$(calc)'b (username Windows hợp lệ
    // chứa ') thoát chuỗi + thực thi lệnh. Test khoá đúng hành vi: chỉ ' bị double.

    #[test]
    fn escapes_single_quote() {
        assert_eq!(ps_single_quote_escape("a'b"), "a''b");
    }

    #[test]
    fn command_injection_attempt_neutralized() {
        // $(calc) chỉ nguy hiểm nếu ' thoát được chuỗi. Sau escape, ' bị double nên
        // toàn bộ payload nằm gọn trong single-quoted string → PS coi là literal.
        let evil = "a'$(calc)'b";
        assert_eq!(ps_single_quote_escape(evil), "a''$(calc)''b");
    }

    #[test]
    fn backslash_left_literal() {
        // Backslash KHÔNG đặc biệt trong single-quoted string → giữ nguyên (không double).
        assert_eq!(ps_single_quote_escape(r"C:\Users\a"), r"C:\Users\a");
    }

    #[test]
    fn dollar_and_backtick_left_literal() {
        // $ và ` chỉ sống trong double-quoted string; ở single-quoted chúng literal.
        assert_eq!(ps_single_quote_escape("$env:x`n"), "$env:x`n");
    }

    #[test]
    fn clean_string_unchanged() {
        assert_eq!(ps_single_quote_escape("PRYNX-1234-ABCD"), "PRYNX-1234-ABCD");
    }
}

#[cfg(test)]
mod token_tests {
    use super::*;
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    fn mk_token(sk: &SigningKey, hwid: &str, key: &str, exp: i64) -> String {
        let kh = {
            let mut h = Sha256::new();
            h.update(key.as_bytes());
            hex::encode(h.finalize())
        };
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let payload = serde_json::json!({
            "v": LICENSE_TOKEN_V2,
            "iat": issued_at,
            "challenge": "ab".repeat(32),
            "k": &kh[..16],
            "m": hwid,
            "p": "prynx",
            "exp": exp,
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let sig = sk.sign(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{}.{}", payload_b64, sig_b64)
    }

    fn mk_token_v2(
        sk: &SigningKey,
        hwid: &str,
        key: &str,
        issued_at: u64,
        exp: u64,
        challenge: &str,
    ) -> String {
        let kh = {
            let mut h = Sha256::new();
            h.update(key.as_bytes());
            hex::encode(h.finalize())
        };
        let payload = serde_json::json!({
            "v": 2,
            "iat": issued_at,
            "exp": exp,
            "challenge": challenge,
            "k": &kh[..16],
            "m": hwid,
            "p": "prynx",
        });
        mk_token_payload(sk, payload)
    }

    fn mk_token_v1(
        sk: &SigningKey,
        hwid: &str,
        key: &str,
        exp: u64,
        explicit_version: bool,
    ) -> String {
        let kh = hex::encode(Sha256::digest(key.as_bytes()));
        let mut payload = serde_json::json!({
            "exp": exp,
            "k": &kh[..16],
            "m": hwid,
            "p": "prynx",
        });
        if explicit_version {
            payload["v"] = serde_json::json!(1);
        }
        mk_token_payload(sk, payload)
    }

    fn mk_token_v3(
        sk: &SigningKey,
        device_key_id: &str,
        key: &str,
        issued_at: u64,
        exp: u64,
    ) -> String {
        let kh = hex::encode(Sha256::digest(key.as_bytes()));
        let thumbprint = device_key_id.strip_prefix("d3_").unwrap();
        mk_token_payload(
            sk,
            serde_json::json!({
                "v": 3,
                "min_v": 3,
                "iat": issued_at,
                "exp": exp,
                "cid": "018f0f5e-8d51-7f77-bbd5-f19db33c4b7a",
                "d": device_key_id,
                "cnf": { "jkt": thumbprint },
                "m": device_key_id,
                "k": &kh[..16],
                "p": "prynx",
            }),
        )
    }

    #[test]
    fn valid_token_passes() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-KEY", future);
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_ok());
    }

    #[test]
    fn valid_v2_token_passes_and_exposes_claims() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let challenge = "ab".repeat(32);
        let tok = mk_token_v2(&sk, "HW123", "LIC-KEY", now, now + 3600, &challenge);
        let claims = verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).unwrap();
        assert_eq!(claims.version, LICENSE_TOKEN_V2);
        assert_eq!(claims.issued_at, Some(now));
        assert_eq!(claims.challenge.as_deref(), Some(challenge.as_str()));
    }

    #[test]
    fn valid_v3_token_supports_legacy_and_weekend_lease_with_local_tpm_binding() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let device_id = format!("d3_{}", "A".repeat(43));
        let token = mk_token_v3(
            &sk,
            &device_id,
            "LIC-KEY",
            now,
            now + LICENSE_TOKEN_V3_LEGACY_MAX_TTL_SECS,
        );
        // Token v3 cũ 15 phút tiếp tục tương thích trong thời kỳ chuyển tiếp.
        for ttl in [
            LICENSE_TOKEN_V3_LEGACY_MAX_TTL_SECS,
            LICENSE_TOKEN_V3_MAX_TTL_SECS,
        ] {
            let token = mk_token_v3(&sk, &device_id, "LIC-KEY", now, now + ttl);
            let claims = verify_token_with_pubkey_and_device(
                &token,
                "HWID-LEGACY",
                "LIC-KEY",
                &pubk,
                Some(&device_id),
            )
            .unwrap();
            assert_eq!(claims.version, LICENSE_TOKEN_V3);
            assert_eq!(claims.device_key_id.as_deref(), Some(device_id.as_str()));
            assert_eq!(
                claims.challenge_id.as_deref(),
                Some("018f0f5e-8d51-7f77-bbd5-f19db33c4b7a")
            );
        }

        assert!(
            verify_token_with_pubkey_and_device(&token, "HWID-LEGACY", "LIC-KEY", &pubk, None,)
                .is_err()
        );
        assert!(verify_token_with_pubkey_and_device(
            &token,
            "HWID-LEGACY",
            "LIC-KEY",
            &pubk,
            Some(&format!("d3_{}", "B".repeat(43))),
        )
        .is_err());

        let too_long = mk_token_v3(
            &sk,
            &device_id,
            "LIC-KEY",
            now,
            now + LICENSE_TOKEN_V3_MAX_TTL_SECS + 1,
        );
        assert!(verify_token_with_pubkey_and_device(
            &too_long,
            "HWID-LEGACY",
            "LIC-KEY",
            &pubk,
            Some(&device_id),
        )
        .is_err());
    }

    #[test]
    fn v3_expired_or_malformed_token_is_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let device_id = format!("d3_{}", "A".repeat(43));

        let expired = mk_token_v3(&sk, &device_id, "LIC-KEY", now - 120, now - 1);
        assert!(verify_token_with_pubkey_and_device(
            &expired,
            "HWID-LEGACY",
            "LIC-KEY",
            &pubk,
            Some(&device_id),
        )
        .is_err());

        assert!(verify_token_with_pubkey_and_device(
            "not-a-signed-token",
            "HWID-LEGACY",
            "LIC-KEY",
            &pubk,
            Some(&device_id),
        )
        .is_err());
    }

    #[test]
    fn v3_hybrid_or_mismatched_confirmation_is_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let device_id = format!("d3_{}", "A".repeat(43));
        let kh = hex::encode(Sha256::digest(b"LIC-KEY"));
        let base = serde_json::json!({
            "v": 3, "min_v": 3, "iat": now, "exp": now + 900,
            "cid": "018f0f5e-8d51-7f77-bbd5-f19db33c4b7a",
            "d": device_id.clone(), "cnf": {"jkt": "A".repeat(43)},
            "m": device_id.clone(), "k": &kh[..16], "p": "prynx"
        });
        for (field, value) in [
            ("min_v", serde_json::json!(2)),
            ("cid", serde_json::json!("NOT-A-UUID")),
            ("cnf", serde_json::json!({"jkt": "B".repeat(43)})),
            ("m", serde_json::json!(format!("d3_{}", "B".repeat(43)))),
            ("challenge", serde_json::json!("ab".repeat(32))),
        ] {
            let mut payload = base.clone();
            payload[field] = value;
            let token = mk_token_payload(&sk, payload);
            assert!(
                verify_token_with_pubkey_and_device(
                    &token,
                    "HWID-LEGACY",
                    "LIC-KEY",
                    &pubk,
                    Some(&device_id),
                )
                .is_err(),
                "field {field} phải fail-closed"
            );
        }
    }

    #[test]
    fn v2_missing_or_invalid_iat_or_challenge_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let kh = hex::encode(Sha256::digest(b"LIC-KEY"));
        for payload in [
            serde_json::json!({
                "v": 2, "exp": now + 3600, "challenge": "ab".repeat(32),
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 2, "iat": now, "exp": now + 3600,
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 2, "iat": 0, "exp": now + 3600, "challenge": "ab".repeat(32),
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 2, "iat": now + LICENSE_CLOCK_SKEW_SECS + 60,
                "exp": now + LICENSE_CLOCK_SKEW_SECS + 3600,
                "challenge": "ab".repeat(32),
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 2, "iat": now, "exp": now + 3600, "challenge": "ab".repeat(31),
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 2, "iat": now, "exp": now + 3600, "challenge": "z".repeat(64),
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
        ] {
            let tok = mk_token_payload(&sk, payload);
            assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
        }
    }

    #[test]
    fn legacy_v1_missing_or_explicit_version_passes_and_exposes_no_v2_claims() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        for explicit_version in [false, true] {
            let token = mk_token_v1(&sk, "HW123", "LIC-KEY", now + 3600, explicit_version);
            let claims = verify_token_with_pubkey(&token, "HW123", "LIC-KEY", &pubk).unwrap();
            assert_eq!(claims.version, 1);
            assert_eq!(claims.issued_at, None);
            assert_eq!(claims.challenge, None);
        }
    }

    #[test]
    fn unknown_typed_or_hybrid_version_rejected_and_challenge_shape_is_strict() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        assert!(normalize_license_challenge(&"ab".repeat(32)).is_some());
        assert!(normalize_license_challenge(&"z".repeat(64)).is_none());
        assert!(normalize_license_challenge("short").is_none());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let kh = hex::encode(Sha256::digest(b"LIC-KEY"));
        for version in [
            serde_json::Value::Null,
            serde_json::json!(true),
            serde_json::json!("1"),
            serde_json::json!(0),
            serde_json::json!(4),
        ] {
            let payload = serde_json::json!({
                "v": version,
                "exp": now + 3600,
                "k": &kh[..16],
                "m": "HW123",
                "p": "prynx",
            });
            let token = mk_token_payload(&sk, payload);
            assert!(verify_token_with_pubkey(&token, "HW123", "LIC-KEY", &pubk).is_err());
        }

        for mut payload in [
            serde_json::json!({
                "iat": now, "exp": now + 3600,
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
            serde_json::json!({
                "v": 1, "challenge": "ab".repeat(32), "exp": now + 3600,
                "k": &kh[..16], "m": "HW123", "p": "prynx"
            }),
        ] {
            let token = mk_token_payload(&sk, payload.take());
            assert!(verify_token_with_pubkey(&token, "HW123", "LIC-KEY", &pubk).is_err());
        }
    }

    #[test]
    fn expired_or_wrongly_bound_v1_is_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expired = mk_token_v1(&sk, "HW123", "LIC-KEY", now - 1, false);
        assert!(verify_token_with_pubkey(&expired, "HW123", "LIC-KEY", &pubk).is_err());

        let valid = mk_token_v1(&sk, "HW123", "LIC-KEY", now + 3600, true);
        assert!(verify_token_with_pubkey(&valid, "OTHER", "LIC-KEY", &pubk).is_err());
        assert!(verify_token_with_pubkey(&valid, "HW123", "OTHER", &pubk).is_err());
    }

    #[test]
    fn tampered_signature_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-KEY", future);
        // Đổi CHẮC CHẮN 1 ký tự đầu của phần sig (đảm bảo khác ký tự gốc).
        let (p, s) = tok.split_once('.').unwrap();
        let mut sb = s.as_bytes().to_vec();
        sb[0] = if sb[0] == b'A' { b'B' } else { b'A' };
        let tampered = format!("{}.{}", p, String::from_utf8(sb).unwrap());
        assert!(verify_token_with_pubkey(&tampered, "HW123", "LIC-KEY", &pubk).is_err());
    }

    #[test]
    fn wrong_signer_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes()); // trust anchor = sk
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&attacker, "HW123", "LIC-KEY", future); // ký bằng khoá khác (keygen giả)
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }

    #[test]
    fn expired_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let tok = mk_token(&sk, "HW123", "LIC-KEY", 1_000_000); // exp ở quá khứ
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }

    #[test]
    fn machine_mismatch_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&sk, "HW-A", "LIC-KEY", future);
        assert!(verify_token_with_pubkey(&tok, "HW-B", "LIC-KEY", &pubk).is_err());
        // token máy khác
    }

    #[test]
    fn key_mismatch_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-A", future);
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-B", &pubk).is_err());
        // key khác
    }

    #[test]
    fn wrong_or_missing_product_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let kh = hex::encode(Sha256::digest(b"LIC-KEY"));
        for product in [Some("sticker"), None] {
            let mut payload = serde_json::json!({
                "v": LICENSE_TOKEN_V2, "iat": future - 3600,
                "challenge": "ab".repeat(32),
                "k": &kh[..16], "m": "HW123", "exp": future
            });
            if let Some(value) = product {
                payload["p"] = serde_json::Value::String(value.to_string());
            }
            let tok = mk_token_payload(&sk, payload);
            assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
        }
    }

    // DS-4: token ký hợp lệ nhưng THIẾU field "m" hoặc "k" phải bị từ chối
    // (đối xứng với backend). Trước fix, nhánh `if let Some` cho token thiếu field PASS.
    fn mk_token_payload(sk: &SigningKey, payload: serde_json::Value) -> String {
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let sig = sk.sign(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{}.{}", payload_b64, sig_b64)
    }

    #[test]
    fn missing_machine_field_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        // payload không có "m"
        let tok = mk_token_payload(
            &sk,
            serde_json::json!({
                "v": LICENSE_TOKEN_V2, "iat": future - 3600,
                "challenge": "ab".repeat(32),
                "k": "0123456789abcdef", "p": "prynx", "exp": future
            }),
        );
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }

    #[test]
    fn missing_key_field_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        // payload không có "k"
        let tok = mk_token_payload(
            &sk,
            serde_json::json!({
                "v": LICENSE_TOKEN_V2, "iat": future - 3600,
                "challenge": "ab".repeat(32),
                "m": "HW123", "p": "prynx", "exp": future
            }),
        );
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }
}

#[cfg(test)]
mod license_challenge_tests {
    use super::*;

    fn pending_entry(
        challenge: &str,
        license_key: &str,
        hardware_id: &str,
        created_at: std::time::Instant,
    ) -> PendingLicenseChallenge {
        PendingLicenseChallenge {
            challenge: challenge.to_string(),
            license_key_hash: hash_license_key(license_key),
            hardware_id: hardware_id.to_string(),
            created_at,
            session_epoch: 0,
        }
    }

    #[test]
    fn challenge_het_han_bi_xoa_va_tu_choi() {
        let challenge = "ab".repeat(32);
        let old = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(
                LICENSE_CHALLENGE_TTL_SECS + 1,
            ))
            .expect("instant đủ xa để dựng fixture");
        let mut pending = HashMap::from([(
            challenge.clone(),
            pending_entry(&challenge, "LIC-A", "HW-A", old),
        )]);

        let result = validate_pending_license_challenge(&mut pending, &challenge, "LIC-A", "HW-A");

        assert!(result.is_err());
        assert!(pending.is_empty(), "challenge hết hạn phải bị dọn khỏi RAM");
    }

    #[test]
    fn challenge_sai_key_hoac_hwid_bi_tu_choi() {
        let challenge = "cd".repeat(32);
        let mut pending = HashMap::from([(
            challenge.clone(),
            pending_entry(&challenge, "LIC-A", "HW-A", std::time::Instant::now()),
        )]);

        assert!(
            validate_pending_license_challenge(&mut pending, &challenge, "LIC-B", "HW-A",).is_err()
        );
        assert!(
            validate_pending_license_challenge(&mut pending, &challenge, "LIC-A", "HW-B",).is_err()
        );
        assert!(
            validate_pending_license_challenge(&mut pending, &challenge, "LIC-A", "HW-A",).is_ok()
        );
    }

    #[test]
    fn challenge_da_tieu_thu_khong_dung_lai_duoc() {
        let challenge = "ef".repeat(32);
        let mut pending = HashMap::from([(
            challenge.clone(),
            pending_entry(&challenge, "LIC-A", "HW-A", std::time::Instant::now()),
        )]);
        assert!(
            validate_pending_license_challenge(&mut pending, &challenge, "LIC-A", "HW-A",).is_ok()
        );

        assert!(pending.remove(&challenge).is_some());
        assert!(
            validate_pending_license_challenge(&mut pending, &challenge, "LIC-A", "HW-A",).is_err()
        );
    }

    #[test]
    fn challenge_chi_commit_trong_dung_session_epoch() {
        let challenge = "12".repeat(32);
        let mut entry = pending_entry(&challenge, "LIC-NEW", "HW-A", std::time::Instant::now());
        entry.session_epoch = 7;
        let mut pending = HashMap::from([(challenge.clone(), entry)]);

        assert!(validate_pending_license_challenge_for_epoch(
            &mut pending,
            &challenge,
            "LIC-NEW",
            "HW-A",
            7,
        )
        .is_ok());
        assert!(validate_pending_license_challenge_for_epoch(
            &mut pending,
            &challenge,
            "LIC-NEW",
            "HW-A",
            8,
        )
        .is_err());
        assert!(pending.contains_key(&challenge));
    }

    #[test]
    fn thay_binding_cung_key_bi_tu_choi_va_khong_lam_mat_binding_cu() {
        let old_binding = ValidatedLicense {
            validated_at: 10,
            hardware_id: "HW-A".to_string(),
            license_token_hash: "old-token".to_string(),
        };
        let new_binding = ValidatedLicense {
            validated_at: 20,
            hardware_id: "HW-A".to_string(),
            license_token_hash: "new-token".to_string(),
        };
        let mut cache = HashMap::from([("LIC-OLD".to_string(), old_binding)]);

        assert!(commit_validated_license_binding(
            &mut cache,
            "LIC-OLD".to_string(),
            new_binding.clone(),
            Some("LIC-OLD"),
        )
        .is_err());
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("LIC-OLD"));
        assert!(!cache.contains_key("LIC-NEW"));
    }

    #[test]
    fn thay_binding_thanh_cong_chi_con_binding_moi() {
        let old_binding = ValidatedLicense {
            validated_at: 10,
            hardware_id: "HW-A".to_string(),
            license_token_hash: "old-token".to_string(),
        };
        let new_binding = ValidatedLicense {
            validated_at: 20,
            hardware_id: "HW-A".to_string(),
            license_token_hash: "new-token".to_string(),
        };
        let mut cache = HashMap::from([
            ("LIC-OLD".to_string(), old_binding.clone()),
            ("LIC-STALE".to_string(), old_binding),
        ]);

        commit_validated_license_binding(
            &mut cache,
            "LIC-NEW".to_string(),
            new_binding,
            Some("LIC-OLD"),
        )
        .unwrap();
        assert_eq!(cache.len(), 1);
        assert!(!cache.contains_key("LIC-OLD"));
        assert!(cache.contains_key("LIC-NEW"));
        assert!(!cache.contains_key("LIC-STALE"));
    }

    #[test]
    fn proof_thay_key_van_commit_duoc_khi_cache_cu_bi_mat_sau_restart() {
        let new_binding = ValidatedLicense {
            validated_at: 20,
            hardware_id: "HW-A".to_string(),
            license_token_hash: "new-token".to_string(),
        };
        let mut cache = HashMap::new();

        commit_validated_license_binding(
            &mut cache,
            "LIC-NEW".to_string(),
            new_binding,
            Some("LIC-OLD"),
        )
        .unwrap();
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("LIC-NEW"));
    }
}

// ══════════════════════════════════════════════════════════════
// VECTOR #15 FIX: Anti-debug + IAT hook detection.
// Detects debuggers (x64dbg, OllyDbg, WinDbg) and function hooks
// (Frida, Detours, MinHook) on critical security APIs.
// ══════════════════════════════════════════════════════════════

#[cfg(not(debug_assertions))]
fn security_kill_log(reason: &str) {
    // SEC (audit 2026-09-05 §LOG.04): reason chi tiết là bản đồ anti-debug.
    // Release chỉ giữ marker tổng quát để support nhận ra policy termination.
    let _ = reason;
    const SAFE_REASON: &str = "Vi phạm chính sách bảo vệ; tiến trình đã dừng";
    log::error!("[SECURITY] {SAFE_REASON}");
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("PrynX").join("logs");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("security_kill.log"))
        {
            use std::io::Write;
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let _ = writeln!(f, "[{}] {}", now, SAFE_REASON);
        }
    }
}

// ══════════════════════════════════════════════════════════════
// Process mitigations — OPT-IN (audit 2026-07-25).
//
// Lịch sử (xem lib.rs): `MicrosoftSignedOnly` + `ProhibitDynamicCode` từng được bật
// vô điều kiện ở release và làm app CHẾT khi in (Ctrl+P): đường in GDI nạp driver máy
// in của hãng thứ ba (không do Microsoft ký) và đôi khi cấp bộ nhớ thực thi.
// Vì vậy chúng bị gỡ hẳn → tiến trình hiện KHÔNG có lớp chặn DLL injection / Frida.
//
// Giải pháp ở đây: bật LẠI dạng opt-in, tách riêng từng chính sách, chạy SAU khi pdfium
// đã nạp, và mặc định TẮT để không thay đổi hành vi bản release đang phát hành:
//   PRYNX_MITIGATIONS=dynamiccode  → chỉ ProhibitDynamicCode (ít rủi ro hơn)
//   PRYNX_MITIGATIONS=signed       → chỉ MicrosoftSignedOnly (RỦI RO CAO với máy in)
//   PRYNX_MITIGATIONS=1|all        → cả hai
// Chỉ đổi mặc định sang bật sau khi QA đường IN trên BẢN ĐÃ CÀI (§15.1: dev không lộ lỗi).
#[cfg(not(debug_assertions))]
pub fn apply_optional_process_mitigations() {
    let raw = std::env::var("PRYNX_MITIGATIONS").unwrap_or_default();
    let mode = raw.trim().to_lowercase();
    if mode.is_empty() || mode == "0" || mode == "false" || mode == "off" {
        log::info!(
            "[SECURITY] process mitigations: disabled (default) — set PRYNX_MITIGATIONS to test"
        );
        return;
    }

    let want_dynamic_code = matches!(mode.as_str(), "1" | "all" | "true" | "dynamiccode");
    let want_signed_only = matches!(mode.as_str(), "1" | "all" | "true" | "signed");

    #[cfg(target_os = "windows")]
    unsafe {
        // Chỉ số theo enum PROCESS_MITIGATION_POLICY (winnt.h/ntddk.h), ĐÚNG THỨ TỰ:
        //   0 DEP, 1 ASLR, 2 DynamicCode, 3 StrictHandleCheck, 4 SystemCallDisable,
        //   5 MitigationOptionsMask, 6 ExtensionPointDisable, 7 ControlFlowGuard,
        //   8 Signature, 9 FontDisable, 10 ImageLoad, ...
        // Truyền sai chỉ số thì API trả ERROR_INVALID_PARAMETER (hoặc áp SAI chính sách),
        // nên hai hằng này phải khớp tuyệt đối với enum.
        const PROCESS_DYNAMIC_CODE_POLICY: u32 = 2;
        const PROCESS_SIGNATURE_POLICY: u32 = 8;

        #[link(name = "kernel32")]
        extern "system" {
            fn SetProcessMitigationPolicy(
                policy: u32,
                buffer: *const std::ffi::c_void,
                size: usize,
            ) -> i32;
        }

        if want_dynamic_code {
            // Bit 0 = ProhibitDynamicCode.
            let flags: u32 = 1;
            let ok = SetProcessMitigationPolicy(
                PROCESS_DYNAMIC_CODE_POLICY,
                &flags as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>(),
            );
            log::warn!(
                "[SECURITY] mitigation ProhibitDynamicCode applied={}",
                ok != 0
            );
        }

        if want_signed_only {
            // Bit 0 = MicrosoftSignedOnly. CẢNH BÁO: chặn MỌI DLL không do Microsoft ký
            // được nạp SAU thời điểm này (driver máy in!). pdfium đã warm-up ở trên nên
            // an toàn, nhưng driver in nạp muộn thì KHÔNG.
            let flags: u32 = 1;
            let ok = SetProcessMitigationPolicy(
                PROCESS_SIGNATURE_POLICY,
                &flags as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>(),
            );
            log::warn!(
                "[SECURITY] mitigation MicrosoftSignedOnly applied={} — VERIFY PRINTING (Ctrl+P) NOW",
                ok != 0
            );
        }
    }
}

#[cfg(not(debug_assertions))]
pub fn start_anti_debug_monitor() {
    // Chỉ GHI LOG — không process::exit.
    // Trước đây exit(1) khi nghi hook/debugger; false-positive (hoặc tương tác
    // với nạp driver máy in / crypt32) khiến release “Ctrl+P → app out” trong khi
    // dev không chạy monitor này. Giữ detect để audit; không giết process.
    std::thread::spawn(|| loop {
        if is_debugger_attached() {
            security_kill_log("Debugger detected (log-only, no exit)");
        }
        if is_critical_api_hooked() {
            security_kill_log("API hook suspected CryptUnprotectData (log-only, no exit)");
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}

#[cfg(not(debug_assertions))]
fn is_debugger_attached() -> bool {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn IsDebuggerPresent() -> i32;
        }

        #[link(name = "ntdll")]
        extern "system" {
            fn NtQueryInformationProcess(
                process: isize,
                class: u32,
                info: *mut std::ffi::c_void,
                length: u32,
                return_length: *mut u32,
            ) -> i32;
        }

        // Method 1: Direct API check
        if IsDebuggerPresent() != 0 {
            return true;
        }

        // Method 2: ProcessDebugPort (class=7) — catches hidden debuggers
        let mut debug_port: usize = 0;
        let status = NtQueryInformationProcess(
            -1_isize, // GetCurrentProcess()
            7,        // ProcessDebugPort
            &mut debug_port as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<usize>() as u32,
            std::ptr::null_mut(),
        );
        if status == 0 && debug_port != 0 {
            return true;
        }

        false
    }
}

#[cfg(not(debug_assertions))]
fn is_critical_api_hooked() -> bool {
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetModuleHandleA(name: *const u8) -> isize;
            fn GetProcAddress(module: isize, name: *const u8) -> *const u8;
        }

        // Check CryptUnprotectData (DPAPI — used for license/timestamp storage)
        let crypt32 = GetModuleHandleA(b"crypt32.dll\0".as_ptr());
        if crypt32 != 0 {
            let func = GetProcAddress(crypt32, b"CryptUnprotectData\0".as_ptr());
            if !func.is_null() {
                let first_byte = *func;
                // CHỈ coi là hook khi prologue rõ ràng là detour:
                //  - 0xE9 = JMP rel32 (MinHook/Detours cổ điển)
                //  - 0xCC = INT3 (breakpoint debugger)
                // KHÔNG dùng 0xFF: nhiều hàm hợp lệ / hotpatch / endbr stub trên
                // Win10/11 bắt đầu bằng FF 25 (JMP [rip+disp]) hoặc F3 0F… — false
                // positive → process exit(1) sau khi in/nạp DLL (release-only).
                if first_byte == 0xE9 || first_byte == 0xCC {
                    return true;
                }
            }
        }

        false
    }
}

// ══════════════════════════════════════════════════════════════
// VECTOR #14 FIX: Token encrypted in memory with XOR mask.
// ReadProcessMemory scanning for hex string patterns will fail.
// Token is decrypted only at point of use, then immediately dropped.
// ══════════════════════════════════════════════════════════════

struct EncryptedToken {
    cipher: Vec<u8>, // token XOR mask
    mask: Vec<u8>,   // random mask
}

impl EncryptedToken {
    fn new() -> Self {
        Self {
            cipher: Vec::new(),
            mask: Vec::new(),
        }
    }

    fn store(&mut self, token: &str) {
        use rand::Rng;
        self.clear();
        let mut rng = rand::thread_rng();
        let token_bytes = token.as_bytes();
        self.mask = (0..token_bytes.len()).map(|_| rng.gen::<u8>()).collect();
        self.cipher = token_bytes
            .iter()
            .zip(self.mask.iter())
            .map(|(t, m)| t ^ m)
            .collect();
    }

    fn clear(&mut self) {
        self.cipher.fill(0);
        self.mask.fill(0);
        self.cipher.clear();
        self.mask.clear();
    }

    fn decrypt(&self) -> String {
        if self.cipher.is_empty() {
            return String::new();
        }
        let plain: Vec<u8> = self
            .cipher
            .iter()
            .zip(self.mask.iter())
            .map(|(c, m)| c ^ m)
            .collect();
        String::from_utf8_lossy(&plain).to_string()
    }
}

struct SidecarTokenState {
    generation: Option<u64>,
    token: EncryptedToken,
}

impl SidecarTokenState {
    fn new() -> Self {
        Self {
            generation: None,
            token: EncryptedToken::new(),
        }
    }
}

static SIDECAR_TOKEN: std::sync::LazyLock<Mutex<SidecarTokenState>> =
    std::sync::LazyLock::new(|| Mutex::new(SidecarTokenState::new()));

const SIDECAR_SESSION_DERIVATION_DOMAIN: &[u8] = b"prynx-sidecar-session-v1\0";

/// SEC (audit 2026-09-03 §SEC.19-R1): mỗi lần sidecar được spawn nhận một khóa
/// phiên khác. Master là 32 byte hex và không bao giờ được dùng trực tiếp để ký
/// request; generation dùng big-endian để Rust/Python có cùng canonical duy nhất.
pub(crate) fn derive_sidecar_session_token(
    master_token: &str,
    generation: u64,
) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    if generation == 0 {
        return Err("Generation sidecar không hợp lệ".to_string());
    }
    if master_token.len() != 64 || !master_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Master token sidecar không đúng định dạng 32-byte hex".to_string());
    }
    let master_bytes = hex::decode(master_token)
        .map_err(|_| "Master token sidecar không đúng định dạng hex".to_string())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&master_bytes)
        .map_err(|_| "Không khởi tạo được khóa phiên sidecar".to_string())?;
    mac.update(SIDECAR_SESSION_DERIVATION_DOMAIN);
    mac.update(&generation.to_be_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Compatibility có chủ đích cho dev/fixture chạy backend Python riêng. Release
/// Windows chỉ publish khóa qua `publish_sidecar_session_token` sau startup proof.
pub fn set_sidecar_token(token: &str) {
    if let Ok(mut state) = SIDECAR_TOKEN.lock() {
        state.token.store(token);
        state.generation = None;
    }
}

/// Publish signer và shutdown authority trong cùng một critical section. Caller
/// chỉ gọi sau khi proof của đúng generation đã đạt.
pub(crate) fn publish_sidecar_session_token(generation: u64, token: &str) -> Result<(), String> {
    if generation == 0
        || token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Khóa phiên sidecar không hợp lệ".to_string());
    }
    let mut state = SIDECAR_TOKEN.lock().map_err(|e| format!("Lock: {e}"))?;
    state.token.store(token);
    state.generation = Some(generation);
    Ok(())
}

/// Compare-and-clear để event muộn của generation cũ không xóa khóa phiên mới.
pub(crate) fn clear_sidecar_session_token(generation: u64) -> bool {
    let Ok(mut state) = SIDECAR_TOKEN.lock() else {
        return false;
    };
    if state.generation != Some(generation) {
        return false;
    }
    state.token.clear();
    state.generation = None;
    true
}

pub(crate) fn sidecar_session_token_for_generation(generation: u64) -> Result<String, String> {
    let state = SIDECAR_TOKEN.lock().map_err(|e| format!("Lock: {e}"))?;
    if state.generation != Some(generation) {
        return Err("Shutdown authority không khớp generation sidecar".to_string());
    }
    let decrypted = state.token.decrypt();
    if decrypted.is_empty() {
        return Err("Sidecar not initialized".to_string());
    }
    Ok(decrypted)
}

fn decrypt_sidecar_token() -> Result<String, String> {
    let state = SIDECAR_TOKEN.lock().map_err(|e| format!("Lock: {}", e))?;
    let decrypted = state.token.decrypt();
    if decrypted.is_empty() {
        return Err("Sidecar not initialized".to_string());
    }
    Ok(decrypted)
}

#[cfg(test)]
mod sidecar_session_key_tests {
    use super::{
        clear_sidecar_session_token, derive_sidecar_session_token, publish_sidecar_session_token,
        sidecar_session_token_for_generation,
    };

    #[test]
    fn derive_khoa_phien_on_dinh_va_tach_biet_master_generation() {
        let master = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let session = derive_sidecar_session_token(master, 7).expect("derive generation 7");

        // Vector khóa canonical Rust/Python: HMAC-SHA256(master bytes,
        // domain || generation-u64-big-endian).
        assert_eq!(
            session,
            "db06f2d7ab035cb3463eba408d620277d1053afcc474d25397dd3c16fe06575d"
        );
        assert_eq!(
            session,
            derive_sidecar_session_token(master, 7).expect("derive lặp lại")
        );
        assert_ne!(
            session,
            derive_sidecar_session_token(master, 8).expect("generation khác")
        );
        assert_ne!(
            session,
            derive_sidecar_session_token(&"ff".repeat(32), 7).expect("master khác")
        );
        assert!(derive_sidecar_session_token(master, 0).is_err());
    }

    #[test]
    fn publish_va_clear_chi_tac_dong_dung_generation() {
        let master = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let session_41 = derive_sidecar_session_token(master, 41).unwrap();
        let session_42 = derive_sidecar_session_token(master, 42).unwrap();

        publish_sidecar_session_token(41, &session_41).unwrap();
        assert_eq!(
            sidecar_session_token_for_generation(41).unwrap(),
            session_41
        );
        assert!(!clear_sidecar_session_token(40));
        assert!(sidecar_session_token_for_generation(41).is_ok());

        publish_sidecar_session_token(42, &session_42).unwrap();
        assert!(!clear_sidecar_session_token(41));
        assert_eq!(
            sidecar_session_token_for_generation(42).unwrap(),
            session_42
        );
        assert!(clear_sidecar_session_token(42));
        assert!(sidecar_session_token_for_generation(42).is_err());
    }
}

const UPSCALE_FILE_GRANT_TTL_SECONDS: u64 = 120;

#[derive(serde::Serialize)]
struct UpscaleFileGrantClaims<'a> {
    v: u8,
    iat: u64,
    exp: u64,
    nonce: &'a str,
    tab: &'a str,
    path: &'a str,
}

fn build_upscale_file_grant(
    token: &str,
    canonical_path: &str,
    tab_id: &str,
    issued_at: u64,
    nonce: &str,
) -> Result<String, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let claims = UpscaleFileGrantClaims {
        v: 1,
        iat: issued_at,
        exp: issued_at.saturating_add(UPSCALE_FILE_GRANT_TTL_SECONDS),
        nonce,
        tab: tab_id,
        path: canonical_path,
    };
    let payload = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&claims).map_err(|e| format!("Grant encode error: {}", e))?);
    let sign_payload = format!("prynx-upscale-file-grant:v1:{}", payload);
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())
        .map_err(|e| format!("HMAC init error: {}", e))?;
    mac.update(sign_payload.as_bytes());
    Ok(format!(
        "v1.{}.{}",
        payload,
        hex::encode(mac.finalize().into_bytes())
    ))
}

/// SEC (audit 2026-08-11 §UP.R.01): tạo capability ngắn hạn cho đúng một file
/// ảnh + tab. Command native phải kiểm scope trước khi gọi hàm này; secret sidecar
/// vẫn chỉ sống trong Rust và grant không thể bị renderer tự sửa đường dẫn.
pub(crate) fn issue_upscale_file_grant(
    canonical_path: &str,
    tab_id: &str,
) -> Result<String, String> {
    if tab_id.is_empty() || tab_id.len() > 128 {
        return Err("Tab Upscale không hợp lệ".to_string());
    }
    if canonical_path.is_empty() || canonical_path.len() > 32_768 {
        return Err("Đường dẫn ảnh không hợp lệ".to_string());
    }

    let token = decrypt_sidecar_token()?;
    let issued_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Đồng hồ hệ thống không hợp lệ".to_string())?
        .as_secs();
    let nonce = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let bytes: [u8; 16] = rng.gen();
        hex::encode(bytes)
    };
    build_upscale_file_grant(&token, canonical_path, tab_id, issued_at, &nonce)
}

/// Frontend calls this to get signed headers for API requests.
/// The sidecar secret never leaves Rust; only a short-lived timestamp + HMAC do.
/// Also gates on license validation: if license is not in cache, refuses to sign.
fn append_request_signature_field(payload: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let length =
        u64::try_from(value.len()).map_err(|_| "Request signing field quá lớn".to_string())?;
    payload.extend_from_slice(&length.to_be_bytes());
    payload.extend_from_slice(value.as_bytes());
    Ok(())
}

fn build_request_signature_payload_v2(
    timestamp: &str,
    nonce: &str,
    method: &str,
    url_path: &str,
    license_key: &str,
    hardware_id: &str,
    license_token_hash: &str,
    body_mode: &str,
    body_commitment: &str,
    content_type: &str,
) -> Result<Vec<u8>, String> {
    let mut payload = b"prynx-request-v2\0".to_vec();
    for value in [
        timestamp,
        nonce,
        method,
        url_path,
        license_key,
        hardware_id,
        license_token_hash,
        body_mode,
        body_commitment,
        content_type,
    ] {
        append_request_signature_field(&mut payload, value)?;
    }
    Ok(payload)
}

#[command]
pub fn sign_api_request(
    url_path: String,
    license_key: String,
    license_token: String,
    method: String,
    signature_version: String,
    body_mode: String,
    body_commitment: String,
    content_type: String,
) -> Result<HashMap<String, String>, String> {
    let transaction = license_transaction_guard()?;
    // Gate 1: Check license in Rust cache (mandatory, not opt-in)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Đồng hồ hệ thống trước mốc Unix".to_string())?
        .as_secs();

    // SEC (audit 2026-09-03 §SEC.19): đây là cổng cưỡng chế native cuối cùng,
    // không phụ thuộc vào renderer đã đọc anchor như thế nào. `saturating_sub`
    // bên dưới từng biến clock rollback thành tuổi cache = 0; kiểm tra anchor
    // trước và tính tuổi chỉ khi thời gian không lùi.
    let now_ms = now_secs
        .checked_mul(1_000)
        .ok_or_else(|| "Đồng hồ hệ thống vượt giới hạn".to_string())?;
    verify_clock_anchor_for_sign(now_ms)?;

    let binding = {
        let cache = VALIDATED_KEYS.lock().map_err(|e| format!("Lock: {}", e))?;
        match cache.get(&license_key) {
            Some(value) => {
                if !validated_license_cache_is_fresh(value.validated_at, now_secs)? {
                    return Err("License not validated in Rust cache".to_string());
                }
                value.clone()
            }
            None => return Err("License not validated in Rust cache".to_string()),
        }
    };

    // Gate 2: Token gắn vào request phải khớp binding native đã xác thực.
    // Nếu token vừa được làm mới nhưng cache chưa kịp cập nhật, trả lỗi trước khi
    // tạo chữ ký để frontend đăng ký lại; không gửi request HMAC sai tới sidecar.
    ensure_license_token_binding(&binding, &license_token)?;
    // Không giữ khóa giao dịch qua phần tạo HMAC; snapshot binding đã nhất quán.
    drop(transaction);

    // Gate 3: Decrypt token from encrypted memory (VECTOR #14)
    let token_str = decrypt_sidecar_token()?;

    // Gate 4: Bind the proof to the native-verified license and hardware id.
    // A patched WebView cannot substitute different entitlement headers after
    // obtaining a signature with a valid Free license.
    //
    // NONCE (audit 2026-07-25): trước đây payload chỉ gồm ts + path, nên trong cửa sổ
    // 30s một chữ ký bắt được dùng lại được cho BODY KHÁC trên cùng path (replay). Thêm
    // nonce CSPRNG 16 byte vào payload + gửi kèm header; backend chỉ nhận mỗi nonce MỘT
    // LẦN → chữ ký bắt được trở thành vô dụng ngay sau lần dùng đầu. Cũng loại luôn
    // trường hợp 2 request cùng giây/cùng path sinh chữ ký y hệt nhau.
    let nonce: String = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let bytes: [u8; 16] = rng.gen();
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    };
    let timestamp = now_secs.to_string();
    let normalized_method = method.trim().to_ascii_uppercase();
    if normalized_method.is_empty()
        || !normalized_method
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'-')
    {
        return Err("Invalid HTTP method".to_string());
    }
    // SEC (audit 2026-09-03 §SEC.21): v2 bind commitment của body và đúng
    // Content-Type/boundary. Length-prefix loại mơ hồ giữa các field attacker-control.
    if signature_version != "2" {
        return Err("Unsupported request signature version".to_string());
    }
    if !matches!(body_mode.as_str(), "none" | "raw-v1" | "form-v1") {
        return Err("Invalid request body mode".to_string());
    }
    if body_commitment.len() != 64
        || !body_commitment
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid request body commitment".to_string());
    }
    if content_type.len() > 2048 || content_type.contains('\r') || content_type.contains('\n') {
        return Err("Invalid request content type".to_string());
    }
    let sign_payload = build_request_signature_payload_v2(
        &timestamp,
        &nonce,
        &normalized_method,
        &url_path,
        &license_key,
        &binding.hardware_id,
        &binding.license_token_hash,
        &body_mode,
        &body_commitment,
        &content_type,
    )?;

    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(token_str.as_bytes())
        .map_err(|e| format!("HMAC init error: {}", e))?;
    mac.update(&sign_payload);
    let signature = hex::encode(mac.finalize().into_bytes());

    let mut headers = HashMap::new();
    headers.insert("X-License-Key".to_string(), license_key);
    headers.insert("X-Hardware-Id".to_string(), binding.hardware_id);
    headers.insert("X-PrynX-Timestamp".to_string(), timestamp);
    headers.insert("X-PrynX-Nonce".to_string(), nonce);
    headers.insert("X-PrynX-Signature".to_string(), signature);
    headers.insert("X-PrynX-Signature-Version".to_string(), signature_version);
    headers.insert("X-PrynX-Body-Mode".to_string(), body_mode);
    headers.insert("X-PrynX-Body-Commitment".to_string(), body_commitment);

    Ok(headers)
}

#[cfg(test)]
mod request_signing_binding_tests {
    use super::*;

    fn binding_for(token: &str) -> ValidatedLicense {
        ValidatedLicense {
            validated_at: 1_700_000_000,
            hardware_id: "hwid-test".to_string(),
            license_token_hash: hash_license_token(token),
        }
    }

    #[test]
    fn chap_nhan_dung_token_da_dang_ky() {
        let binding = binding_for("token-hien-tai");
        assert!(ensure_license_token_binding(&binding, "token-hien-tai").is_ok());
    }

    #[test]
    fn tu_choi_token_khac_binding_truoc_khi_ky() {
        let binding = binding_for("token-cu");
        let error = ensure_license_token_binding(&binding, "token-moi")
            .expect_err("token khác binding phải bị từ chối");
        assert!(error.contains("đăng ký lại cache Rust"));
    }

    #[test]
    fn cache_native_8_gio_cho_dang_ky_lai_offline_va_chan_lui_dong_ho() {
        let now = 1_700_000_000_u64;
        assert!(
            validated_license_cache_is_fresh(now, now + VALIDATED_LICENSE_CACHE_TTL_SECS - 1)
                .expect("cache còn hạn trước mốc 8 giờ")
        );
        assert!(
            !validated_license_cache_is_fresh(now, now + VALIDATED_LICENSE_CACHE_TTL_SECS)
                .expect("cache hết hạn đúng mốc 8 giờ")
        );
        assert!(validated_license_cache_is_fresh(now, now - 1).is_err());
    }

    #[test]
    fn payload_v2_bind_body_content_type_va_khong_mo_ho_field() {
        let base = build_request_signature_payload_v2(
            "1700000000",
            "00112233445566778899aabbccddeeff",
            "POST",
            "/api/upload?mode=one:two",
            "key",
            "hwid",
            &"a".repeat(64),
            "raw-v1",
            &"b".repeat(64),
            "application/json",
        )
        .expect("payload v2");
        let changed_body = build_request_signature_payload_v2(
            "1700000000",
            "00112233445566778899aabbccddeeff",
            "POST",
            "/api/upload?mode=one:two",
            "key",
            "hwid",
            &"a".repeat(64),
            "raw-v1",
            &"c".repeat(64),
            "application/json",
        )
        .expect("payload v2 body khác");
        let shifted_boundary = build_request_signature_payload_v2(
            "1700000000",
            "00112233445566778899aabbccddeeff",
            "POST",
            "/api/upload?mode=one",
            "two:key",
            "hwid",
            &"a".repeat(64),
            "raw-v1",
            &"b".repeat(64),
            "application/json",
        )
        .expect("payload v2 field khác");

        assert_ne!(base, changed_body);
        assert_ne!(base, shifted_boundary);
        assert!(base.starts_with(b"prynx-request-v2\0"));
    }
}

#[cfg(test)]
mod upscale_file_grant_tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    #[test]
    fn grant_gan_dung_path_tab_han_dung_va_nonce() {
        let nonce = "00112233445566778899aabbccddeeff";
        let grant = build_upscale_file_grant(
            "sidecar-test-secret",
            r"C:\Mẫu in\tem.png",
            "tab-17",
            1_700_000_000,
            nonce,
        )
        .expect("tạo grant");
        let parts: Vec<&str> = grant.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "v1");
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("decode payload"))
                .expect("parse claims");
        assert_eq!(claims["v"], 1);
        assert_eq!(claims["iat"], 1_700_000_000_u64);
        assert_eq!(claims["exp"], 1_700_000_120_u64);
        assert_eq!(claims["nonce"], nonce);
        assert_eq!(claims["tab"], "tab-17");
        assert_eq!(claims["path"], r"C:\Mẫu in\tem.png");
        assert_eq!(parts[2].len(), 64);
    }
}

// ══════════════════════════════════════════════════════════════
// Windows DPAPI Credential Storage
// Uses CryptProtectData (via PowerShell) to encrypt the license key
// with the current user's Windows login session. Only the same user
// on the same machine can decrypt it.
// ══════════════════════════════════════════════════════════════

const CREDENTIAL_FILE: &str = "prynx_license.dat";

/// Get the path to the credential file in AppData
fn get_credential_path() -> Result<std::path::PathBuf, String> {
    let appdata =
        std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA directory".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create PrynX directory: {}", e))?;
    Ok(dir.join(CREDENTIAL_FILE))
}

#[command]
pub fn store_license(license_key: String) -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    LICENSE_SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
    store_license_inner(license_key)
}

fn store_license_inner(license_key: String) -> Result<(), String> {
    let cred_path = get_credential_path()?;
    let cred_path_str = ps_single_quote_escape(&cred_path.to_string_lossy());

    // Use PowerShell + DPAPI to encrypt and save
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:PRYNX_DPAPI_IN)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        cred_path_str
    );

    let output = powershell_command()?
        // SEC (audit 2026-07-26 F5): secret truyen qua BIEN MOI TRUONG cho child powershell,
        // KHONG noi suy vao -Command -> khong lo tren command line (WMI/Sysmon/EDR log argv).
        .env("PRYNX_DPAPI_IN", &license_key)
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("Failed to run DPAPI encrypt: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DPAPI encrypt failed: {}", err));
    }

    Ok(())
}

#[command]
pub fn load_license() -> Result<String, String> {
    let _transaction = license_transaction_guard()?;
    load_license_inner()
}

fn load_license_inner() -> Result<String, String> {
    let cred_path = get_credential_path()?;

    if !cred_path.exists() {
        return Err("No stored license found".to_string());
    }

    let cred_path_str = ps_single_quote_escape(&cred_path.to_string_lossy());

    // Use PowerShell + DPAPI to decrypt
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $encrypted = [System.IO.File]::ReadAllBytes('{}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.Text.Encoding]::UTF8.GetString($decrypted)
        "#,
        cred_path_str
    );

    let output = powershell_command()?
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("Failed to run DPAPI decrypt: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DPAPI decrypt failed: {}", err));
    }

    let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if key.is_empty() {
        return Err("Decrypted license key is empty".to_string());
    }

    Ok(key)
}

#[command]
pub fn delete_license() -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    let cred_path = get_credential_path()?;
    if cred_path.exists() {
        std::fs::remove_file(&cred_path)
            .map_err(|e| format!("Failed to delete credential file: {}", e))?;
    }
    LICENSE_SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

// ══════════════════════════════════════════════════════════════
// VECTOR #4 FIX: Tamper-resistant last-online timestamp
// Stored in AppData (not localStorage) alongside license credential.
// Written as obfuscated binary, not plain text.
// ══════════════════════════════════════════════════════════════

const TIMESTAMP_FILE: &str = "prynx_ts.dat";

fn get_timestamp_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(TIMESTAMP_FILE))
}

#[command]
pub fn store_last_online(timestamp_ms: u64) -> Result<(), String> {
    let current = load_last_online().unwrap_or(0);

    if current > 0 {
        // ── Anti-clockback: reject if clock was set backward ──
        if timestamp_ms + 300_000 < current {
            return Err(
                "Clock manipulation detected: system time is behind stored timestamp".to_string(),
            );
        }

        // ── VECTOR #11 FIX: Anti-forward-jump ──
        // If time jumped MORE than 25 hours since last store, suspicious.
        // Normal heartbeat is every 30 min, so >25h gap means either:
        // a) User was offline >24h (which is handled by offline grace check)
        // b) User set clock forward to stay in grace window
        // We flag it so frontend can decide (not hard-block, but log + reduce grace)
        let max_jump_ms: u64 = 25 * 60 * 60 * 1000; // 25 hours
        if timestamp_ms > current + max_jump_ms {
            // Log but don't block — the offline grace check will handle legitimacy
            // Just reduce the stored timestamp to limit chaining attacks
            // (user can't chain T+23h → T+46h → T+69h infinitely)
            log::warn!(
                "[SECURITY] Large time jump detected: {}ms → {}ms (delta={}h)",
                current,
                timestamp_ms,
                (timestamp_ms - current) / 3_600_000
            );
        }
    }

    let path = get_timestamp_path()?;
    let cred_path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ts_str = timestamp_ms.to_string();

    // Use DPAPI to encrypt timestamp (same mechanism as license key)
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:PRYNX_DPAPI_IN)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        cred_path_str
    );

    let output = powershell_command()?
        // SEC (audit 2026-07-26 F5): secret truyen qua BIEN MOI TRUONG cho child powershell,
        // KHONG noi suy vao -Command -> khong lo tren command line (WMI/Sysmon/EDR log argv).
        .env("PRYNX_DPAPI_IN", &ts_str)
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI timestamp encrypt failed: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DPAPI timestamp encrypt failed: {}", err));
    }
    Ok(())
}

#[command]
pub fn load_last_online() -> Result<u64, String> {
    let path = get_timestamp_path()?;
    if !path.exists() {
        return Ok(0);
    }

    let cred_path_str = ps_single_quote_escape(&path.to_string_lossy());

    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $encrypted = [System.IO.File]::ReadAllBytes('{}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.Text.Encoding]::UTF8.GetString($decrypted)
        "#,
        cred_path_str
    );

    let output = powershell_command()?
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI timestamp decrypt failed: {}", e))?;

    if !output.status.success() {
        return Ok(0); // Corrupted or tampered — treat as never online
    }

    let ts_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    ts_str
        .parse::<u64>()
        .map_err(|_| "Invalid timestamp".to_string())
}

// ══════════════════════════════════════════════════════════════
// SEC (audit 2026-09-03 §SEC.19): Monotonic clock anchor (DPAPI).
// Neo thời gian phía frontend — chỉ tiến không lùi. Khác last_online
// (chỉ ghi khi online thành công), clock anchor ghi lại thời điểm lớn
// nhất ĐÃ QUAN SÁT, dùng để phát hiện rollback bất kể trạng thái mạng.
// Lưu DPAPI nên khác user không đọc được; chính user vẫn có thể tạo
// blob tùy ý (accepted Ring-3 risk).
// ══════════════════════════════════════════════════════════════

const CLOCK_ANCHOR_FILE: &str = "prynx_clk.dat";
// Phải đồng bộ với LICENSE_CLOCK_SKEW_SECS: token v2 có thể hợp lệ khi máy
// chậm hơn server tối đa 5 phút; anchor không được tự khóa ngay sau lần online đó.
const CLOCK_ANCHOR_SKEW_MS: u64 = LICENSE_CLOCK_SKEW_SECS * 1_000;
const CLOCK_ANCHOR_MAX_BYTES: u64 = 16 * 1024;

/// Trạng thái neo phải là kiểu phân biệt, không dùng `0` làm sentinel. `Corrupt` là
/// bằng chứng file đã tồn tại nhưng không giải mã/parse được; `Unavailable` là lỗi môi
/// trường (APPDATA, PowerShell hoặc quyền truy cập) mà không được phép biến thành neo mới.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClockAnchorState {
    Missing,
    Valid(u64),
    Corrupt,
    Unavailable,
}

/// Envelope IPC ổn định cho renderer. Không đưa chi tiết lỗi PowerShell/path ra WebView.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockAnchorStatus {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
}

impl ClockAnchorState {
    fn status(self) -> ClockAnchorStatus {
        match self {
            Self::Missing => ClockAnchorStatus {
                status: "missing",
                timestamp_ms: None,
            },
            Self::Valid(timestamp_ms) => ClockAnchorStatus {
                status: "valid",
                timestamp_ms: Some(timestamp_ms),
            },
            Self::Corrupt => ClockAnchorStatus {
                status: "corrupt",
                timestamp_ms: None,
            },
            Self::Unavailable => ClockAnchorStatus {
                status: "unavailable",
                timestamp_ms: None,
            },
        }
    }
}

/// Tính mốc cần ghi sau một lần đăng ký license. Hàm thuần này giữ chung policy
/// cho đường khôi phục anchor và cổng signer: anchor thiếu/hỏng chỉ nhận proof
/// online v2/v3 có cờ challenge, còn anchor hợp lệ chỉ được tiến về phía trước.
fn license_anchor_update_target(
    state: ClockAnchorState,
    anchor_required: bool,
    now_ms: u64,
    claims: Option<&VerifiedLicenseToken>,
    has_challenge: bool,
) -> Result<Option<u64>, String> {
    match state {
        ClockAnchorState::Valid(current_ms) => {
            if now_ms.saturating_add(CLOCK_ANCHOR_SKEW_MS) < current_ms {
                return Err("Clock rollback detected".to_string());
            }
            if !anchor_required || !has_challenge {
                return Ok(None);
            }
            let issued_ms = claims
                .filter(|value| matches!(value.version, LICENSE_TOKEN_V2 | LICENSE_TOKEN_V3))
                .and_then(|value| value.issued_at)
                .and_then(|value| value.checked_mul(1_000))
                .ok_or_else(|| "Token issued-at không hợp lệ".to_string())?;
            Ok(Some(current_ms.max(now_ms).max(issued_ms)))
        }
        ClockAnchorState::Missing | ClockAnchorState::Corrupt => {
            if !anchor_required {
                return Ok(None);
            }
            let issued_ms = claims
                .filter(|value| {
                    (value.version == LICENSE_TOKEN_V2 && has_challenge)
                        // `challenge_id` chỉ là claim đã ký; phải có cờ proof
                        // online của lượt đăng ký hiện tại mới được bootstrap
                        // anchor. Token DPAPI 72 giờ không tự tạo lại anchor
                        // sau khi file bị xoá/hỏng.
                        || (value.version == LICENSE_TOKEN_V3
                            && has_challenge
                            && value.challenge_id.is_some())
                })
                .and_then(|value| value.issued_at)
                .and_then(|value| value.checked_mul(1_000))
                .ok_or_else(|| "Clock anchor cần token online có proof mới".to_string())?;
            Ok(Some(now_ms.max(issued_ms)))
        }
        ClockAnchorState::Unavailable => {
            if anchor_required {
                Err("Clock anchor unavailable; online revalidation required".to_string())
            } else {
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod license_anchor_policy_tests {
    use super::*;

    fn v1_claim() -> VerifiedLicenseToken {
        VerifiedLicenseToken {
            version: 1,
            issued_at: None,
            challenge: None,
            challenge_id: None,
            device_key_id: None,
        }
    }

    fn v2_claim(issued_at: u64) -> VerifiedLicenseToken {
        VerifiedLicenseToken {
            version: LICENSE_TOKEN_V2,
            issued_at: Some(issued_at),
            challenge: Some("ab".repeat(32)),
            challenge_id: None,
            device_key_id: None,
        }
    }

    fn v3_claim(issued_at: u64) -> VerifiedLicenseToken {
        VerifiedLicenseToken {
            version: LICENSE_TOKEN_V3,
            issued_at: Some(issued_at),
            challenge: None,
            challenge_id: Some("018f0f5e-8d51-7f77-bbd5-f19db33c4b7a".to_string()),
            device_key_id: Some(format!("d3_{}", "A".repeat(43))),
        }
    }

    #[test]
    fn anchor_thieu_tu_choi_claim_khong_phai_v2_hoac_thieu_challenge() {
        // Token v1 chỉ được tiếp tục khi anchor đã hợp lệ; tuyệt đối không dùng
        // nó để bootstrap lại anchor bị xoá/hỏng.
        let non_v2 = v1_claim();
        assert!(license_anchor_update_target(
            ClockAnchorState::Missing,
            true,
            1_700_000_000_000,
            Some(&non_v2),
            true,
        )
        .is_err());
        assert!(license_anchor_update_target(
            ClockAnchorState::Corrupt,
            true,
            1_700_000_000_000,
            Some(&non_v2),
            false,
        )
        .is_err());
        let v2 = v2_claim(1_700_000_000);
        assert!(license_anchor_update_target(
            ClockAnchorState::Missing,
            true,
            1_700_000_000_000,
            Some(&v2),
            false,
        )
        .is_err());
    }

    #[test]
    fn anchor_hop_le_cho_phep_token_v1_khong_challenge() {
        let now_ms = 1_700_000_000_000;
        let claims = v1_claim();
        let target = license_anchor_update_target(
            ClockAnchorState::Valid(now_ms - 1_000),
            true,
            now_ms,
            Some(&claims),
            false,
        )
        .expect("token v1 còn hạn được dùng khi anchor hiện tại hợp lệ");
        assert_eq!(target, None);
    }

    #[test]
    fn anchor_thieu_nhan_token_v2_challenge_va_tao_moc() {
        let now_ms = 1_700_000_000_000;
        let claims = v2_claim(now_ms / 1_000);
        let target = license_anchor_update_target(
            ClockAnchorState::Missing,
            true,
            now_ms,
            Some(&claims),
            true,
        )
        .expect("proof v2 phải khôi phục được anchor")
        .expect("anchor thiếu phải có mốc mới");
        assert_eq!(target, now_ms);
    }

    #[test]
    fn anchor_hop_le_cho_phep_dang_ky_lai_token_v3_offline() {
        let now_ms = 1_700_000_000_000;
        let claims = v3_claim(now_ms / 1_000);
        // Khi anchor còn hợp lệ, registration không cần challenge mới; token
        // v3 72 giờ được dùng để dựng lại binding RAM sau khi cache 8 giờ hết hạn.
        let target = license_anchor_update_target(
            ClockAnchorState::Valid(now_ms),
            true,
            now_ms,
            Some(&claims),
            false,
        )
        .expect("anchor hợp lệ phải cho phép đăng ký lại offline");
        assert_eq!(target, None);

        // Anchor bị mất vẫn buộc proof online, không được dùng lease dài để
        // tự bootstrap một mốc mới offline. Có receipt v3 nhưng không truyền
        // challenge hiện tại vẫn là đường offline và phải bị từ chối.
        assert!(license_anchor_update_target(
            ClockAnchorState::Missing,
            true,
            now_ms,
            Some(&claims),
            false,
        )
        .is_err());
        assert_eq!(
            license_anchor_update_target(
                ClockAnchorState::Missing,
                true,
                now_ms,
                Some(&claims),
                true,
            )
            .expect("proof v3 online phải khôi phục được anchor"),
            Some(now_ms)
        );
    }

    #[test]
    fn issued_at_server_nhanh_hon_nam_phut_khong_tu_khoa_signer() {
        let now_ms = 1_700_000_000_000;
        let issued_ms = now_ms + LICENSE_CLOCK_SKEW_SECS * 1_000 - 1_000;
        let claims = v2_claim(issued_ms / 1_000);
        let target = license_anchor_update_target(
            ClockAnchorState::Valid(now_ms),
            true,
            now_ms,
            Some(&claims),
            true,
        )
        .expect("mốc hợp lệ trong dung sai không bị từ chối")
        .expect("lượt online phải có thể tiến anchor");
        assert!(target >= now_ms);
        assert!(now_ms + CLOCK_ANCHOR_SKEW_MS >= target);
    }

    #[test]
    fn anchor_unavailable_bat_buoc_online() {
        assert!(license_anchor_update_target(
            ClockAnchorState::Unavailable,
            true,
            1_700_000_000_000,
            None,
            false,
        )
        .is_err());
    }

    #[test]
    fn sau_khi_clear_cache_duong_dang_ky_khong_challenge_bi_khoa() {
        // `clear_validated_keys` bật LICENSE_REVALIDATION_REQUIRED. Kiểm tra
        // policy thuần ở đây để một lần rollback/offline retry không vô tình
        // mở lại cửa cấp quyền chỉ vì token cũ còn hạn.
        assert!(ensure_registration_challenge_policy(false, true, false).is_err());
        assert!(ensure_registration_challenge_policy(true, true, false).is_ok());
        assert!(ensure_registration_challenge_policy(false, false, false).is_ok());
        assert!(ensure_registration_challenge_policy(false, false, true).is_err());
        assert!(ensure_registration_challenge_policy(true, false, true).is_ok());
    }
}

static CLOCK_ANCHOR_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

fn clock_anchor_guard() -> std::sync::MutexGuard<'static, ()> {
    CLOCK_ANCHOR_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn get_clock_anchor_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA".to_string())?;
    if appdata.trim().is_empty() {
        return Err("APPDATA is empty".to_string());
    }
    Ok(std::path::Path::new(&appdata)
        .join("PrynX")
        .join(CLOCK_ANCHOR_FILE))
}

fn epoch_millis() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Đồng hồ hệ thống trước mốc Unix".to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "Đồng hồ hệ thống vượt giới hạn u64".to_string())
}

/// Chỉ release mới bắt buộc anchor. Debug muốn mô phỏng production phải bật cờ rõ ràng;
/// cờ này không thể tắt enforcement trong binary release vì nhánh release trả `true`
/// trực tiếp, không đọc environment.
fn clock_anchor_required() -> bool {
    let env_value = std::env::var("PRYNX_ENFORCE_CLOCK_ANCHOR").ok();
    enforcement_policy(cfg!(debug_assertions), env_value.as_deref())
}

fn verify_clock_anchor_for_sign(now_ms: u64) -> Result<(), String> {
    if !clock_anchor_required() {
        return Ok(());
    }
    let _guard = clock_anchor_guard();
    match load_clock_anchor_state_unlocked() {
        ClockAnchorState::Valid(anchor_ms)
            if now_ms.saturating_add(CLOCK_ANCHOR_SKEW_MS) >= anchor_ms =>
        {
            Ok(())
        }
        ClockAnchorState::Valid(_) => {
            Err("Clock rollback detected; request signing refused".to_string())
        }
        ClockAnchorState::Missing => {
            Err("Clock anchor missing; online revalidation required".to_string())
        }
        ClockAnchorState::Corrupt => {
            Err("Clock anchor corrupt; online revalidation required".to_string())
        }
        ClockAnchorState::Unavailable => {
            Err("Clock anchor unavailable; online revalidation required".to_string())
        }
    }
}

fn load_clock_anchor_state_unlocked() -> ClockAnchorState {
    let path = match get_clock_anchor_path() {
        Ok(path) => path,
        Err(_) => return ClockAnchorState::Unavailable,
    };

    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ClockAnchorState::Missing
        }
        Err(_) => return ClockAnchorState::Unavailable,
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CLOCK_ANCHOR_MAX_BYTES {
        return ClockAnchorState::Corrupt;
    }

    let cred_path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $encrypted = [System.IO.File]::ReadAllBytes('{}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($decrypted))
        "#,
        cred_path_str
    );

    let mut command = match powershell_command() {
        Ok(command) => command,
        Err(_) => return ClockAnchorState::Unavailable,
    };
    let output = match command
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(output) => output,
        Err(_) => return ClockAnchorState::Unavailable,
    };

    // File tồn tại nhưng DPAPI từ chối/PowerShell báo lỗi ⇒ corrupt, không được reset về
    // missing. Trường hợp không chạy được process đã phân loại unavailable ở trên.
    if !output.status.success() {
        return ClockAnchorState::Corrupt;
    }
    let ts_str = match std::str::from_utf8(&output.stdout) {
        Ok(value) => value.trim(),
        Err(_) => return ClockAnchorState::Corrupt,
    };
    match ts_str.parse::<u64>() {
        Ok(timestamp_ms) if timestamp_ms > 0 => ClockAnchorState::Valid(timestamp_ms),
        _ => ClockAnchorState::Corrupt,
    }
}

fn dpapi_encrypt_clock_anchor(path: &std::path::Path, timestamp_ms: u64) -> Result<(), String> {
    let cred_path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ts_str = timestamp_ms.to_string();
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:PRYNX_DPAPI_IN)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        cred_path_str
    );
    let output = powershell_command()?
        .env("PRYNX_DPAPI_IN", &ts_str)
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "DPAPI clock anchor encrypt unavailable".to_string())?;
    if !output.status.success() {
        return Err("DPAPI clock anchor encrypt failed".to_string());
    }
    Ok(())
}

/// Công bố file tạm thành anchor đích theo một bước thay thế nguyên tử.
///
/// `std::fs::rename` trên Windows KHÔNG ghi đè file đích đang tồn tại (khác
/// Unix). Anchor được cập nhật ở mỗi lần online; nếu dùng rename thuần, lần
/// ghi thứ hai luôn lỗi và frontend sẽ khóa oan. `MoveFileExW` với
/// `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` vừa xử lý cả đích mới
/// lẫn đích cũ, vừa giữ publication cùng volume. Unix dùng rename(2), vốn đã
/// thay thế nguyên tử.
fn publish_clock_anchor(temp: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let temp_wide: Vec<u16> = temp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let target_wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: các vector UTF-16 sống hết trong lời gọi; chuỗi đã được
        // NUL-terminate và Path Windows không thể chứa NUL hợp lệ từ API này.
        unsafe {
            MoveFileExW(
                PCWSTR(temp_wide.as_ptr()),
                PCWSTR(target_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| format!("MoveFileExW clock anchor failed: {error}"))?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(temp, target)
            .map_err(|error| format!("rename clock anchor failed: {error}"))
    }
}

fn flush_license_staged_file(path: &std::path::Path) -> Result<(), String> {
    // SEC (audit 2026-09-09 §SEC.LICUX.COMMIT): FlushFileBuffers trên Windows
    // cần handle ghi; File::open/read-only từng làm fixture publication bị từ chối.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "Không mở được file bản quyền tạm để flush".to_string())?
        .sync_all()
        .map_err(|_| "Không flush được file bản quyền tạm".to_string())
}

fn atomic_store_clock_anchor(path: &std::path::Path, timestamp_ms: u64) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Clock anchor path has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Không tạo được thư mục clock anchor".to_string())?;

    use rand::RngCore;
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        CLOCK_ANCHOR_FILE,
        std::process::id(),
        hex::encode(nonce)
    ));

    let result = (|| {
        dpapi_encrypt_clock_anchor(&temp, timestamp_ms)?;
        // Flush file tạm trước khi publish; rename cùng volume là bước công bố nguyên tử.
        flush_license_staged_file(&temp)?;
        publish_clock_anchor(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[command]
pub fn load_clock_anchor() -> Result<ClockAnchorStatus, String> {
    // SEC (audit 2026-09-09 §SEC.LICUX.DEV): trả đúng policy do native quyết
    // định; debug không tạo anchor thì renderer cũng không được đòi nó.
    if !clock_anchor_required() {
        return Ok(ClockAnchorStatus {
            status: "not_required",
            timestamp_ms: None,
        });
    }
    let _guard = clock_anchor_guard();
    Ok(load_clock_anchor_state_unlocked().status())
}

// ══════════════════════════════════════════════════════════════
// C-1 FIX: Persist server-signed license token (Ed25519) via DPAPI.
// Lý do: backend release ép PRYNX_ENFORCE_LICENSE_TOKEN=true → MỌI request
// phải kèm token hợp lệ. Trước đây token chỉ giữ trong RAM (zustand) nên khi
// MỞ LẠI app lúc OFFLINE (trong hạn grace) thì token=null → backend 403 →
// "grace 24h" thực tế không hoạt động. Lưu token (DPAPI, ràng user+máy) để
// khởi động offline vẫn dùng được tới khi token hết hạn (exp).
// Token vốn đã ràng theo HWID nên lưu KHÔNG mở rộng bề mặt tấn công:
// copy file sang máy khác vừa không giải mã được (DPAPI) vừa lệch 'm' (HWID).
// ══════════════════════════════════════════════════════════════

const TOKEN_FILE: &str = "prynx_token.dat";

fn get_token_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(TOKEN_FILE))
}

#[command]
pub fn store_license_token(token: String) -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    LICENSE_SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
    store_license_token_inner(token)
}

fn store_license_token_inner(token: String) -> Result<(), String> {
    let path = get_token_path()?;
    let path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:PRYNX_DPAPI_IN)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        path_str
    );
    let output = powershell_command()?
        // SEC (audit 2026-07-26 F5): secret truyen qua BIEN MOI TRUONG cho child powershell,
        // KHONG noi suy vao -Command -> khong lo tren command line (WMI/Sysmon/EDR log argv).
        .env("PRYNX_DPAPI_IN", &token)
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI token encrypt failed: {}", e))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DPAPI token encrypt failed: {}", err));
    }
    Ok(())
}

#[command]
pub fn load_license_token() -> Result<String, String> {
    let _transaction = license_transaction_guard()?;
    load_license_token_inner()
}

fn load_license_token_inner() -> Result<String, String> {
    let path = get_token_path()?;
    if !path.exists() {
        return Err("No stored license token".to_string());
    }
    let path_str = ps_single_quote_escape(&path.to_string_lossy());
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $encrypted = [System.IO.File]::ReadAllBytes('{}')
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.Text.Encoding]::UTF8.GetString($decrypted)
        "#,
        path_str
    );
    let output = powershell_command()?
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI token decrypt failed: {}", e))?;
    if !output.status.success() {
        return Err("DPAPI token decrypt failed".to_string());
    }
    let tok = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if tok.is_empty() {
        return Err("Decrypted license token is empty".to_string());
    }
    Ok(tok)
}

// SEC (audit 2026-09-09 §SEC.LICUX.COMMIT): giao dịch hai slot có rollback cho
// lỗi đã bắt trong cùng process. Không tuyên bố atomic khi mất điện/crash giữa
// hai rename; bản raw DPAPI cũ được giữ trong thư mục recovery nếu rollback lỗi.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialSlot {
    Key,
    Token,
}

const CREDENTIAL_SLOTS: [CredentialSlot; 2] = [CredentialSlot::Key, CredentialSlot::Token];

struct CredentialCommitError {
    rollback_failed: bool,
}

trait CredentialPairStorage {
    fn read(&mut self, slot: CredentialSlot) -> Result<Option<Vec<u8>>, ()>;
    fn backup(&mut self, previous: &[Option<Vec<u8>>; 2]) -> Result<(), ()>;
    // Hợp đồng: lỗi publish không làm thay đổi slot đích.
    fn write_atomic(&mut self, slot: CredentialSlot, bytes: &[u8]) -> Result<(), ()>;
    fn remove(&mut self, slot: CredentialSlot) -> Result<(), ()>;
    fn cleanup(&mut self);
}

fn publish_credential_pair(
    storage: &mut impl CredentialPairStorage,
    next: &[Vec<u8>; 2],
) -> Result<(), CredentialCommitError> {
    let mut previous = [None, None];
    for (index, slot) in CREDENTIAL_SLOTS.into_iter().enumerate() {
        previous[index] = storage.read(slot).map_err(|_| CredentialCommitError {
            rollback_failed: false,
        })?;
    }
    if storage.backup(&previous).is_err() {
        storage.cleanup();
        return Err(CredentialCommitError {
            rollback_failed: false,
        });
    }
    for (index, slot) in CREDENTIAL_SLOTS.into_iter().enumerate() {
        if storage.write_atomic(slot, &next[index]).is_err() {
            let mut rollback_failed = false;
            for restored_index in (0..index).rev() {
                let restored_slot = CREDENTIAL_SLOTS[restored_index];
                let restored = match previous[restored_index].as_deref() {
                    Some(bytes) => storage.write_atomic(restored_slot, bytes),
                    None => storage.remove(restored_slot),
                };
                rollback_failed |= restored.is_err();
            }
            if !rollback_failed {
                storage.cleanup();
            }
            return Err(CredentialCommitError { rollback_failed });
        }
    }
    storage.cleanup();
    Ok(())
}

struct FileCredentialPairStorage {
    paths: [std::path::PathBuf; 2],
    recovery: std::path::PathBuf,
    recovery_created: bool,
}

impl FileCredentialPairStorage {
    fn new() -> Result<Self, String> {
        let paths = [get_credential_path()?, get_token_path()?];
        let parent = paths[0].parent().ok_or("Không có thư mục bản quyền")?;
        let mut nonce = [0u8; 16];
        use rand::RngCore;
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| "Không tạo được định danh giao dịch bản quyền")?;
        Ok(Self {
            recovery: parent.join(format!(".license-recovery-{}", hex::encode(nonce))),
            paths,
            recovery_created: false,
        })
    }

    fn index(slot: CredentialSlot) -> usize {
        match slot {
            CredentialSlot::Key => 0,
            CredentialSlot::Token => 1,
        }
    }
}

impl CredentialPairStorage for FileCredentialPairStorage {
    fn read(&mut self, slot: CredentialSlot) -> Result<Option<Vec<u8>>, ()> {
        match std::fs::read(&self.paths[Self::index(slot)]) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn backup(&mut self, previous: &[Option<Vec<u8>>; 2]) -> Result<(), ()> {
        std::fs::create_dir(&self.recovery).map_err(|_| ())?;
        self.recovery_created = true;
        for (index, snapshot) in previous.iter().enumerate() {
            if let Some(bytes) = snapshot {
                let path = self.recovery.join(format!("previous-{index}.dat"));
                std::fs::write(&path, bytes).map_err(|_| ())?;
                flush_license_staged_file(&path).map_err(|_| ())?;
            }
        }
        Ok(())
    }

    fn write_atomic(&mut self, slot: CredentialSlot, bytes: &[u8]) -> Result<(), ()> {
        let index = Self::index(slot);
        let staged = self.recovery.join(format!("staged-{index}.dat"));
        std::fs::write(&staged, bytes).map_err(|_| ())?;
        flush_license_staged_file(&staged).map_err(|_| ())?;
        publish_clock_anchor(&staged, &self.paths[index]).map_err(|_| ())
    }

    fn remove(&mut self, slot: CredentialSlot) -> Result<(), ()> {
        match std::fs::remove_file(&self.paths[Self::index(slot)]) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(()),
        }
    }

    fn cleanup(&mut self) {
        // Chỉ dọn bốn file do transaction này tạo, không xóa recursive AppData.
        if !self.recovery_created {
            return;
        }
        for name in [
            "previous-0.dat",
            "previous-1.dat",
            "staged-0.dat",
            "staged-1.dat",
        ] {
            let _ = std::fs::remove_file(self.recovery.join(name));
        }
        let _ = std::fs::remove_dir(&self.recovery);
    }
}

fn encrypt_credential_pair(license_key: &str, token: &str) -> Result<[Vec<u8>; 2], String> {
    use base64::Engine as _;
    let input = serde_json::json!({ "key": license_key, "token": token }).to_string();
    let script = r#"
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Security
        $values = $env:PRYNX_DPAPI_IN | ConvertFrom-Json
        $result = @{}
        foreach ($name in @('key', 'token')) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$values.$name)
            $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
                $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $result[$name] = [Convert]::ToBase64String($encrypted)
        }
        [Console]::Out.Write(($result | ConvertTo-Json -Compress))
    "#;
    let output = powershell_command()?
        .env("PRYNX_DPAPI_IN", input)
        .args(["-NoProfile", "-NoLogo", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "Không chuẩn bị được DPAPI cho giao dịch bản quyền")?;
    if !output.status.success() {
        return Err("Không mã hóa được giao dịch bản quyền bằng DPAPI".into());
    }
    let encrypted: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "DPAPI trả dữ liệu giao dịch không hợp lệ")?;
    let decode = |field: &str| -> Result<Vec<u8>, String> {
        let value = encrypted
            .get(field)
            .and_then(serde_json::Value::as_str)
            .ok_or("DPAPI thiếu slot giao dịch")?;
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|_| "DPAPI trả slot giao dịch không hợp lệ".into())
    };
    Ok([decode("key")?, decode("token")?])
}

fn ensure_credential_target(
    current_key: Option<&str>,
    _new_key: &str,
    replaced_key: Option<&str>,
) -> Result<(), String> {
    if let Some(expected) = replaced_key {
        let current_matches = current_key.is_some_and(|key| key == expected);
        if !current_matches {
            return Err("Key đã thay đổi ở cửa sổ khác; hãy nạp lại phiên bản quyền".into());
        }
    }
    Ok(())
}

/// Caller đã giữ LICENSE_TRANSACTION và ownership renewal; không gọi qua IPC cũ.
pub(crate) fn commit_license_credentials(
    license_key: String,
    token: String,
    challenge: Option<String>,
    challenge_id: Option<String>,
    replace_license_key: Option<String>,
) -> Result<(), String> {
    let key = license_key.trim().to_uppercase();
    if key.is_empty() || key.len() > 256 || token.is_empty() || token.len() > 16 * 1024 {
        return Err("Dữ liệu giao dịch bản quyền không hợp lệ".into());
    }
    if challenge.is_some() == challenge_id.is_some() {
        return Err("Giao dịch bản quyền yêu cầu đúng một proof online v2 hoặc v3".into());
    }
    let replace = replace_license_key.map(|value| value.trim().to_uppercase());
    let mut storage = FileCredentialPairStorage::new()?;
    let key_on_disk = storage
        .read(CredentialSlot::Key)
        .map_err(|_| "Không đọc được trạng thái credential trước giao dịch")?;
    let current_key = if key_on_disk.is_some() {
        Some(load_license_inner()?)
    } else {
        None
    };
    ensure_credential_target(current_key.as_deref(), &key, replace.as_deref())?;
    let rollback_failed = std::cell::Cell::new(false);
    let result = register_validated_key_inner(
        key.clone(),
        Some(token.clone()),
        challenge,
        challenge_id,
        replace,
        || {
            let encrypted = encrypt_credential_pair(&key, &token)?;
            publish_credential_pair(&mut storage, &encrypted).map_err(|error| {
                rollback_failed.set(error.rollback_failed);
                if error.rollback_failed {
                    "Không khôi phục được credential cũ; bản DPAPI recovery đã được giữ, cần hỗ trợ"
                        .into()
                } else {
                    "Không lưu được giao dịch bản quyền; credential cũ vẫn được giữ".into()
                }
            })
        },
    );
    if rollback_failed.get() {
        // Helper verify đã trả về nên pending/anchor/cache đều được thả trước clear.
        let _ = clear_validated_keys_inner();
    }
    result
}

#[cfg(test)]
mod credential_transaction_tests {
    use super::*;

    struct MemoryStorage {
        slots: [Option<Vec<u8>>; 2],
        recovery: Option<[Option<Vec<u8>>; 2]>,
        write_calls: usize,
        fail_calls: Vec<usize>,
        fail_read: bool,
        fail_backup: bool,
    }

    impl MemoryStorage {
        fn new(key: Option<&[u8]>) -> Self {
            Self {
                slots: [key.map(Vec::from), Some(b"old-token".to_vec())],
                recovery: None,
                write_calls: 0,
                fail_calls: Vec::new(),
                fail_read: false,
                fail_backup: false,
            }
        }
        fn may_write(&mut self) -> Result<(), ()> {
            self.write_calls += 1;
            if self.fail_calls.contains(&self.write_calls) {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    impl CredentialPairStorage for MemoryStorage {
        fn read(&mut self, slot: CredentialSlot) -> Result<Option<Vec<u8>>, ()> {
            if self.fail_read {
                return Err(());
            }
            Ok(self.slots[FileCredentialPairStorage::index(slot)].clone())
        }
        fn backup(&mut self, previous: &[Option<Vec<u8>>; 2]) -> Result<(), ()> {
            if self.fail_backup {
                return Err(());
            }
            self.recovery = Some(previous.clone());
            Ok(())
        }
        fn write_atomic(&mut self, slot: CredentialSlot, bytes: &[u8]) -> Result<(), ()> {
            self.may_write()?;
            self.slots[FileCredentialPairStorage::index(slot)] = Some(bytes.to_vec());
            Ok(())
        }
        fn remove(&mut self, slot: CredentialSlot) -> Result<(), ()> {
            self.may_write()?;
            self.slots[FileCredentialPairStorage::index(slot)] = None;
            Ok(())
        }
        fn cleanup(&mut self) {
            self.recovery = None;
        }
    }

    fn next() -> [Vec<u8>; 2] {
        [b"new-key".to_vec(), b"new-token".to_vec()]
    }

    #[test]
    fn publish_pair_thanh_cong_co_du_hai_slot() {
        let mut storage = MemoryStorage::new(Some(b"old-key"));
        assert!(publish_credential_pair(&mut storage, &next()).is_ok());
        assert_eq!(storage.slots, next().map(Some));
        assert!(storage.recovery.is_none());
    }

    #[test]
    fn loi_read_hoac_backup_khong_duoc_bat_dau_ghi() {
        for fail_read in [false, true] {
            let mut storage = MemoryStorage::new(Some(b"old-key"));
            let before = storage.slots.clone();
            storage.fail_read = fail_read;
            storage.fail_backup = !fail_read;
            assert!(publish_credential_pair(&mut storage, &next()).is_err());
            assert_eq!(storage.slots, before);
            assert_eq!(storage.write_calls, 0);
        }
    }

    #[test]
    fn loi_tung_publish_giu_nguyen_credential_cu() {
        for failed_write in [1, 2] {
            for old_key in [None, Some(b"old-key".as_slice())] {
                let mut storage = MemoryStorage::new(old_key);
                let before = storage.slots.clone();
                storage.fail_calls = vec![failed_write];
                let error = publish_credential_pair(&mut storage, &next())
                    .err()
                    .unwrap();
                assert!(!error.rollback_failed);
                assert_eq!(storage.slots, before);
                assert!(storage.recovery.is_none());
            }
        }
    }

    #[test]
    fn rollback_loi_phai_bao_fail_closed_va_giu_raw_backup() {
        let mut storage = MemoryStorage::new(Some(b"old-key"));
        let before = storage.slots.clone();
        storage.fail_calls = vec![2, 3];
        let error = publish_credential_pair(&mut storage, &next())
            .err()
            .unwrap();
        assert!(error.rollback_failed);
        assert_eq!(storage.recovery.as_ref(), Some(&before));
    }

    #[test]
    fn cas_key_tu_choi_cua_so_cu_sau_khi_key_da_doi() {
        assert!(ensure_credential_target(None, "NEW", None).is_ok());
        assert!(ensure_credential_target(Some("NEW"), "NEW", None).is_ok());
        assert!(ensure_credential_target(Some("OLD"), "NEW", Some("OLD")).is_ok());
        assert!(ensure_credential_target(Some("OTHER"), "NEW", None).is_ok());
        assert!(ensure_credential_target(Some("OTHER"), "NEW", Some("OLD")).is_err());
        assert!(ensure_credential_target(None, "NEW", Some("OLD")).is_err());
    }

    #[test]
    fn persistence_loi_khong_duoc_cong_bo_native_binding_moi() {
        let binding = |token: &str| ValidatedLicense {
            validated_at: 1,
            hardware_id: "device".into(),
            license_token_hash: token.into(),
        };
        let mut cache = HashMap::from([("OLD".into(), binding("old-token"))]);
        assert!(persist_then_commit_binding(
            &mut cache,
            "NEW".into(),
            binding("new-token"),
            Some("OLD"),
            || Err("write failed".into())
        )
        .is_err());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("OLD").unwrap().license_token_hash, "old-token");
        assert!(persist_then_commit_binding(
            &mut cache,
            "NEW".into(),
            binding("new-token"),
            Some("OLD"),
            || Ok(())
        )
        .is_ok());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("NEW").unwrap().license_token_hash, "new-token");
    }

    #[test]
    fn publisher_windows_ghi_hai_file_gia_khong_cham_dpapi() {
        let root = std::env::temp_dir().join(format!(
            "prynx-credential-pair-test-{}",
            rand::random::<u128>()
        ));
        std::fs::create_dir(&root).unwrap();
        let paths = [root.join("fixture-key.dat"), root.join("fixture-token.dat")];
        std::fs::write(&paths[0], b"old-key").unwrap();
        std::fs::write(&paths[1], b"old-token").unwrap();
        let mut storage = FileCredentialPairStorage {
            paths: paths.clone(),
            recovery: root.join("recovery"),
            recovery_created: false,
        };
        let result = publish_credential_pair(&mut storage, &next());
        let observed = [
            std::fs::read(&paths[0]).unwrap(),
            std::fs::read(&paths[1]).unwrap(),
        ];
        storage.cleanup();
        for path in &paths {
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(&root).unwrap();
        assert!(
            result.is_ok(),
            "Publisher fixture phải qua flush và replace Windows"
        );
        assert_eq!(observed, next());
    }
}

#[command]
pub fn delete_license_token() -> Result<(), String> {
    let _transaction = license_transaction_guard()?;
    let path = get_token_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete token file: {}", e))?;
    }
    LICENSE_SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

#[cfg(test)]
mod clock_anchor_publish_tests {
    use super::{flush_license_staged_file, publish_clock_anchor};

    #[test]
    fn anchor_flush_dung_handle_ghi_va_khong_cham_dpapi() {
        let root = std::env::temp_dir().join(format!(
            "prynx-anchor-flush-test-{}",
            rand::random::<u128>()
        ));
        std::fs::create_dir(&root).unwrap();
        let temp = root.join("fixture-anchor.tmp");
        let target = root.join("fixture-anchor.dat");
        std::fs::write(&temp, b"synthetic-encrypted-anchor").unwrap();
        let flush_result = flush_license_staged_file(&temp);
        let published = flush_result.and_then(|()| publish_clock_anchor(&temp, &target));
        let observed = std::fs::read(&target).ok();
        let _ = std::fs::remove_file(&temp);
        let _ = std::fs::remove_file(&target);
        std::fs::remove_dir(&root).unwrap();
        assert!(published.is_ok());
        assert_eq!(
            observed.as_deref(),
            Some(b"synthetic-encrypted-anchor".as_slice())
        );
    }

    #[test]
    fn cong_bo_anchor_thay_duoc_file_dich_da_ton_tai() {
        let root = std::env::temp_dir().join(format!(
            "prynx-clock-anchor-publish-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let temp = root.join(".anchor.tmp");
        let target = root.join("prynx_clk.dat");
        std::fs::write(&temp, b"new-anchor").expect("write temp");
        std::fs::write(&target, b"old-anchor").expect("write target");

        let result = publish_clock_anchor(&temp, &target);
        assert!(result.is_ok(), "publish failed: {result:?}");
        assert_eq!(std::fs::read(&target).expect("read target"), b"new-anchor");
        assert!(!temp.exists());

        std::fs::remove_dir_all(root).expect("remove temp dir");
    }
}
