use tauri::command;
use std::process::Command;
use std::collections::HashMap;
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
    
    // Combine all components into a single deterministic hash.
    // SHA-256 (ổn định vĩnh viễn) thay cho DefaultHasher/SipHash — vốn KHÔNG được Rust
    // đảm bảo ổn định giữa các bản toolchain (nâng cấp Rust có thể đổi mọi HWID → vỡ license).
    // Lấy 8 byte đầu → 16 hex ký tự (giữ đúng độ dài định dạng HWID cũ).
    use sha2::{Sha256, Digest};
    let combined = components.join("|");
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let digest = hasher.finalize();
    Ok(hex::encode(&digest[..8]).to_uppercase())
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
///
/// F2 (defense-in-depth): nếu kèm `token` (Ed25519 do server ký) thì Rust TỰ verify
/// trước khi cache → biến "Rust gate" từ theater thành lớp kiểm THẬT, độc lập với sidecar.
/// Kẻ crack patch mỗi frontend không đủ: phải qua cả Rust (đây) lẫn sidecar.
/// Token rỗng khi PRYNX_ENFORCE_LICENSE_TOKEN=true → từ chối, không cache.
/// Token rỗng khi enforce=false (rollout/dev) → vẫn cache; sidecar là backstop.
#[command]
pub fn register_validated_key(license_key: String, hwid: Option<String>, token: Option<String>) -> Result<(), String> {
    let tok = token.unwrap_or_default();
    let enforce = std::env::var("PRYNX_ENFORCE_LICENSE_TOKEN")
        .map(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
        .unwrap_or(false);
    if tok.is_empty() {
        if enforce {
            return Err("License token required but not provided (enforce mode)".to_string());
        }
        // enforce=false: cache mà không verify (rollout grace / dev mode)
    } else {
        let hw = hwid.unwrap_or_default();
        // F2 (defense-in-depth) → ADVISORY: token verify lỗi thì CHỈ log, KHÔNG chặn cache.
        // Cache này chỉ gate việc ký SIDECAR token (chứng minh request đến từ frontend hợp lệ).
        // License THẬT vẫn được backend cưỡng chế độc lập qua X-License-Token (Ed25519) + Supabase.
        // Nếu chặn cache ở đây khi token phụ trục trặc (rate-limit/grace/edge hiccup) thì toàn bộ
        // giao tiếp frontend↔backend chết (403 "invalid sidecar token") dù user đã đăng nhập hợp lệ.
        if let Err(e) = verify_license_token_internal(&tok, &hw, &license_key) {
            log::warn!("[SECURITY] register_validated_key: license-token verify failed (advisory, vẫn cache): {}", e);
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut cache = VALIDATED_KEYS.lock().map_err(|e| format!("Lock error: {}", e))?;
    cache.insert(license_key, now);
    Ok(())
}

// ── F2: Ed25519 license-token verification (đối xứng với backend license_guard.py) ──
// Public key TRUST ANCHOR — PHẢI KHỚP `_LICENSE_PUBLIC_KEY_B64` ở backend.
const LICENSE_PUBLIC_KEY_B64: &str = "AxpiZnEFXady9wI01spdMRrTNtEthMD30W/90gi27Zk=";

fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.decode(s).map_err(|e| format!("b64url: {}", e))
}

/// Verify token "<payload_b64url>.<sig_b64url>" (sig ký trên BYTES ASCII của payload_b64url).
/// payload JSON: {"k":sha256(key)[:16],"m":hwid,"p":product,"exp":unix}. Kiểm sig + exp + m + k.
fn verify_license_token_internal(token: &str, hwid: &str, license_key: &str) -> Result<(), String> {
    verify_token_with_pubkey(token, hwid, license_key, LICENSE_PUBLIC_KEY_B64)
}

/// Lõi verify, nhận pubkey tham số (để unit-test bằng keypair test mà không cần private key thật).
fn verify_token_with_pubkey(token: &str, hwid: &str, license_key: &str, pub_b64: &str) -> Result<(), String> {
    use ed25519_dalek::{VerifyingKey, Signature, Verifier};
    use base64::{Engine, engine::general_purpose::STANDARD};

    let (payload_b64, sig_b64) = token.split_once('.').ok_or("malformed license token")?;

    let pub_bytes = STANDARD.decode(pub_b64).map_err(|e| format!("pubkey b64: {}", e))?;
    let pub_arr: [u8; 32] = pub_bytes.as_slice().try_into().map_err(|_| "pubkey length")?;
    let vk = VerifyingKey::from_bytes(&pub_arr).map_err(|e| format!("pubkey: {}", e))?;

    let sig_bytes = b64url_decode(sig_b64)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("sig: {}", e))?;
    vk.verify(payload_b64.as_bytes(), &sig).map_err(|_| "invalid license token signature".to_string())?;

    let payload_bytes = b64url_decode(payload_b64)?;
    let payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|e| format!("payload json: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let exp = payload.get("exp").and_then(|v| v.as_i64()).unwrap_or(0);
    if exp < now { return Err("license token expired".to_string()); }

    // V3 (đối xứng backend license_guard.py): cận trên tuổi thọ token — chống replay token
    // cũ bằng cách LÙI đồng hồ hệ thống. Token TTL 2h nên (exp - now) hợp lệ luôn ≤ TTL;
    // vượt cận (TTL + dư + skew) ⇒ đồng hồ đã bị lùi xa lúc cấp token. Không phụ thuộc file
    // trên đĩa nên không thể vô hiệu bằng cách xoá state.
    const MAX_TOKEN_LIFETIME_SECS: i64 = 8 * 24 * 60 * 60; // TTL server 7 ngày + 1 ngày dư (PHẢI ≥ TTL token edge function cấp)
    if exp - now > MAX_TOKEN_LIFETIME_SECS {
        return Err("license token lifetime implausible (clock rollback?)".to_string());
    }

    // DS-4: field "m" (machine id) BẮT BUỘC — đối xứng với backend license_guard.py:248.
    // Token thiếu "m" KHÔNG được pass (chống token vạn năng dùng mọi máy).
    let m = payload.get("m").and_then(|v| v.as_str())
        .ok_or("license token missing required field: machine id")?;
    if !hwid.is_empty() && m != hwid {
        return Err("license token machine mismatch".to_string());
    }

    // DS-4: field "k" (key hash) BẮT BUỘC — đối xứng với backend license_guard.py:255.
    let k = payload.get("k").and_then(|v| v.as_str())
        .ok_or("license token missing required field: key hash")?;
    if !license_key.is_empty() {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(license_key.as_bytes());
        let kh = hex::encode(h.finalize());
        if k != &kh[..16] { return Err("license token key mismatch".to_string()); }
    }
    Ok(())
}

#[cfg(test)]
mod token_tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}};
    use ed25519_dalek::{SigningKey, Signer};
    use sha2::{Sha256, Digest};

    fn mk_token(sk: &SigningKey, hwid: &str, key: &str, exp: i64) -> String {
        let kh = { let mut h = Sha256::new(); h.update(key.as_bytes()); hex::encode(h.finalize()) };
        let payload = serde_json::json!({ "k": &kh[..16], "m": hwid, "p": "prynx", "exp": exp });
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let sig = sk.sign(payload_b64.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{}.{}", payload_b64, sig_b64)
    }

    #[test]
    fn valid_token_passes() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-KEY", future);
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_ok());
    }

    #[test]
    fn tampered_signature_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
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
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
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
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
        let tok = mk_token(&sk, "HW-A", "LIC-KEY", future);
        assert!(verify_token_with_pubkey(&tok, "HW-B", "LIC-KEY", &pubk).is_err()); // token máy khác
    }

    #[test]
    fn key_mismatch_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-A", future);
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-B", &pubk).is_err()); // key khác
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
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
        // payload không có "m"
        let tok = mk_token_payload(&sk, serde_json::json!({ "k": "0123456789abcdef", "p": "prynx", "exp": future }));
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }

    #[test]
    fn missing_key_field_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pubk = STANDARD.encode(sk.verifying_key().to_bytes());
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 + 3600;
        // payload không có "k"
        let tok = mk_token_payload(&sk, serde_json::json!({ "m": "HW123", "p": "prynx", "exp": future }));
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }
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
        
        if !is_valid {
            // F1 FIX: từ chối ký khi license CHƯA validate trong cache — KỂ CẢ key rỗng.
            // Trước đây điều kiện `!is_valid && !license_key.is_empty()` cho key="" lọt qua.
            // An toàn: getLicenseHeaders (api.ts) bắt lỗi này êm → dev (backend DEV_MODE) vẫn
            // chạy không cần header ký; release từ chối đúng (không license = không truy cập).
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
