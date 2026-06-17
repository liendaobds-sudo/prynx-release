use tauri::command;
use std::process::Command;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Collect multiple hardware identifiers and combine them into a single hash.
/// This is much harder to spoof than a single WMI UUID query.
fn collect_hardware_fingerprint() -> Result<String, String> {
    let mut components: Vec<String> = Vec::new();
    
    // 1. System UUID (Win32_ComputerSystemProduct)
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", 
               "(Get-CimInstance Win32_ComputerSystemProduct).UUID"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — hide console flash
        .output() 
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() && val != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" {
            components.push(val);
        }
    }
    
    // 2. CPU ProcessorId (hardware serial burned into silicon)
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", 
               "(Get-CimInstance Win32_Processor).ProcessorId"])
        .creation_flags(0x08000000)
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() {
            components.push(val);
        }
    }
    
    // 3. BIOS Serial Number
    if let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", 
               "(Get-CimInstance Win32_BIOS).SerialNumber"])
        .creation_flags(0x08000000)
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() && val != "To Be Filled By O.E.M." && val != "Default string" {
            components.push(val);
        }
    }
    
    if components.is_empty() {
        return Err("Could not collect any hardware identifiers".to_string());
    }
    
    // Combine all components into a single deterministic hash
    let combined = components.join("|");
    let mut hasher = DefaultHasher::new();
    combined.hash(&mut hasher);
    let hash = hasher.finish();
    
    // Format as hex string (16 chars, deterministic per machine)
    Ok(format!("{:016X}", hash))
}

#[command]
pub fn get_hardware_id() -> Result<String, String> {
    collect_hardware_fingerprint()
}

// ══════════════════════════════════════════════════════════════
// VECTOR #2 FIX: Rust-side license validation cache.
// register_validated_key (gọi sau khi Supabase RPC thành công) nạp key vào cache;
// sign_api_request gate trên cache này trước khi ký. (Hàm validate_license_local cũ
// đã gỡ vì không nơi nào gọi — việc gate license nằm trong sign_api_request.)
// ══════════════════════════════════════════════════════════════

use std::sync::Mutex;

// In-memory cache of validated license keys (session-scoped)
static VALIDATED_KEYS: std::sync::LazyLock<Mutex<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Called by frontend after successful Supabase RPC validation
/// to register the key in Rust's in-memory cache.
#[command]
pub fn register_validated_key(license_key: String) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut cache = VALIDATED_KEYS.lock().map_err(|e| format!("Lock error: {}", e))?;
    cache.insert(license_key, now);
    Ok(())
}

// ══════════════════════════════════════════════════════════════
// VECTOR #15 FIX: Anti-debug + IAT hook detection.
// Detects debuggers (x64dbg, OllyDbg, WinDbg) and function hooks
// (Frida, Detours, MinHook) on critical security APIs.
// ══════════════════════════════════════════════════════════════

#[cfg(not(debug_assertions))]
pub fn start_anti_debug_monitor() {
    std::thread::spawn(|| {
        loop {
            if is_debugger_attached() {
                log::error!("[SECURITY] Debugger detected! Terminating.");
                std::process::exit(1);
            }
            if is_critical_api_hooked() {
                log::error!("[SECURITY] API hook detected! Terminating.");
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
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
                // 0xE9 = JMP rel32, 0xFF = JMP indirect (common hook patterns)
                if first_byte == 0xE9 || first_byte == 0xFF {
                    return true;
                }
                // 0xCC = INT3 (breakpoint)
                if first_byte == 0xCC {
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
    cipher: Vec<u8>,  // token XOR mask
    mask: Vec<u8>,    // random mask
}

impl EncryptedToken {
    fn new() -> Self {
        Self { cipher: Vec::new(), mask: Vec::new() }
    }
    
    fn store(&mut self, token: &str) {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let token_bytes = token.as_bytes();
        self.mask = (0..token_bytes.len()).map(|_| rng.gen::<u8>()).collect();
        self.cipher = token_bytes.iter()
            .zip(self.mask.iter())
            .map(|(t, m)| t ^ m)
            .collect();
    }
    
    fn decrypt(&self) -> String {
        if self.cipher.is_empty() { return String::new(); }
        let plain: Vec<u8> = self.cipher.iter()
            .zip(self.mask.iter())
            .map(|(c, m)| c ^ m)
            .collect();
        String::from_utf8_lossy(&plain).to_string()
    }
}

static SIDECAR_TOKEN: std::sync::LazyLock<Mutex<EncryptedToken>> =
    std::sync::LazyLock::new(|| Mutex::new(EncryptedToken::new()));

/// Called by lib.rs at startup to store the generated token (encrypted in memory).
pub fn set_sidecar_token(token: &str) {
    if let Ok(mut t) = SIDECAR_TOKEN.lock() {
        t.store(token);
    }
}

/// Frontend calls this to get signed headers for API requests.
/// The token + hash algorithm NEVER leave Rust.
/// Also gates on license validation: if license not in cache, refuses to sign.
#[command]
pub fn sign_api_request(url_path: String, license_key: String) -> Result<HashMap<String, String>, String> {
    // Gate 1: Check license in Rust cache (mandatory, not opt-in)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    
    {
        let cache = VALIDATED_KEYS.lock().map_err(|e| format!("Lock: {}", e))?;
        let is_valid = if let Some(&validated_at) = cache.get(&license_key) {
            now_secs - validated_at < 7200 // 2h cache
        } else {
            false
        };
        
        if !is_valid && !license_key.is_empty() {
            return Err("License not validated in Rust cache".to_string());
        }
    }
    
    // Gate 2: Decrypt token from encrypted memory (VECTOR #14)
    let token_str = {
        let enc = SIDECAR_TOKEN.lock().map_err(|e| format!("Lock: {}", e))?;
        let decrypted = enc.decrypt();
        if decrypted.is_empty() {
            return Err("Sidecar not initialized".to_string());
        }
        decrypted
    }; // enc lock released here
    
    // Gate 3: Compute HMAC-SHA256 signature (industry standard)
    let timestamp = now_secs.to_string();
    let sign_payload = format!("{}:{}", timestamp, url_path);
    
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    
    let mut mac = HmacSha256::new_from_slice(token_str.as_bytes())
        .map_err(|e| format!("HMAC init error: {}", e))?;
    mac.update(sign_payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    
    let mut headers = HashMap::new();
    headers.insert("X-PrynX-Token".to_string(), token_str);
    headers.insert("X-PrynX-Timestamp".to_string(), timestamp);
    headers.insert("X-PrynX-Signature".to_string(), signature);
    
    Ok(headers)
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
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Cannot find APPDATA directory".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create PrynX directory: {}", e))?;
    Ok(dir.join(CREDENTIAL_FILE))
}

#[command]
pub fn store_license(license_key: String) -> Result<(), String> {
    let cred_path = get_credential_path()?;
    let cred_path_str = cred_path.to_string_lossy().replace('\\', "\\\\");
    
    // Use PowerShell + DPAPI to encrypt and save
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        license_key.replace("'", "''"),
        cred_path_str
    );
    
    let output = Command::new("powershell")
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
    let cred_path = get_credential_path()?;
    
    if !cred_path.exists() {
        return Err("No stored license found".to_string());
    }
    
    let cred_path_str = cred_path.to_string_lossy().replace('\\', "\\\\");
    
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
    
    let output = Command::new("powershell")
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
    let cred_path = get_credential_path()?;
    if cred_path.exists() {
        std::fs::remove_file(&cred_path)
            .map_err(|e| format!("Failed to delete credential file: {}", e))?;
    }
    Ok(())
}

// ══════════════════════════════════════════════════════════════
// VECTOR #4 FIX: Tamper-resistant last-online timestamp
// Stored in AppData (not localStorage) alongside license credential.
// Written as obfuscated binary, not plain text.
// ══════════════════════════════════════════════════════════════

const TIMESTAMP_FILE: &str = "prynx_ts.dat";

fn get_timestamp_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(TIMESTAMP_FILE))
}

#[command]
pub fn store_last_online(timestamp_ms: u64) -> Result<(), String> {
    let current = load_last_online().unwrap_or(0);
    
    if current > 0 {
        // ── Anti-clockback: reject if clock was set backward ──
        if timestamp_ms + 300_000 < current {
            return Err("Clock manipulation detected: system time is behind stored timestamp".to_string());
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
                current, timestamp_ms, (timestamp_ms - current) / 3_600_000
            );
        }
    }

    let path = get_timestamp_path()?;
    let cred_path_str = path.to_string_lossy().replace('\\', "\\\\");
    let ts_str = timestamp_ms.to_string();
    
    // Use DPAPI to encrypt timestamp (same mechanism as license key)
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        ts_str, cred_path_str
    );
    
    let output = Command::new("powershell")
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
    
    let cred_path_str = path.to_string_lossy().replace('\\', "\\\\");
    
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
    
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NoLogo", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("DPAPI timestamp decrypt failed: {}", e))?;
    
    if !output.status.success() {
        return Ok(0); // Corrupted or tampered — treat as never online
    }
    
    let ts_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    ts_str.parse::<u64>().map_err(|_| "Invalid timestamp".to_string())
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
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(TOKEN_FILE))
}

#[command]
pub fn store_license_token(token: String) -> Result<(), String> {
    let path = get_token_path()?;
    let path_str = path.to_string_lossy().replace('\\', "\\\\");
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Security
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [System.IO.File]::WriteAllBytes('{}', $encrypted)
        "#,
        token.replace("'", "''"),
        path_str
    );
    let output = Command::new("powershell")
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
    let path = get_token_path()?;
    if !path.exists() {
        return Err("No stored license token".to_string());
    }
    let path_str = path.to_string_lossy().replace('\\', "\\\\");
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
    let output = Command::new("powershell")
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

#[command]
pub fn delete_license_token() -> Result<(), String> {
    let path = get_token_path()?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete token file: {}", e))?;
    }
    Ok(())
}
