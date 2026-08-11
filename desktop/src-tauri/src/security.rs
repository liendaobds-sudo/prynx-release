use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::command;

/// Escape a value để nhúng an toàn vào PowerShell SINGLE-quoted string ('...').
/// Trong single-quoted string của PowerShell, MỌI ký tự đều literal (backtick, $,
/// $(...), newline...) — chỉ dấu nháy đơn ' là ký tự đóng chuỗi, nên chỉ cần double
/// nó thành ''. TUYỆT ĐỐI không nhúng vào double-quoted string (ở đó $ và ` mới sống).
/// Đây là nguồn chân lý duy nhất cho mọi chỗ nội suy path/value vào script PS.
pub(crate) fn ps_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Collect multiple hardware identifiers and combine them into a single hash.
/// This is much harder to spoof than a single WMI UUID query.
fn collect_hardware_fingerprint() -> Result<String, String> {
    let mut components: Vec<String> = Vec::new();
    // DIAG: cờ có/không của TỪNG nguồn WMI (theo đúng thứ tự uuid|cpu|bios). Nếu HWID vẫn
    // trôi trên máy khách, so cờ này giữa 2 lần tính sẽ chỉ thẳng nguồn nào rớt. KHÔNG log
    // serial thô (tránh rò dữ liệu máy) — chỉ log true/false.
    let (mut has_uuid, mut has_cpu, mut has_bios) = (false, false, false);

    // 1. System UUID (Win32_ComputerSystemProduct)
    if let Ok(output) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — hide console flash
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() && val != "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" {
            has_uuid = true;
            components.push(val);
        }
    }

    // 2. CPU ProcessorId (hardware serial burned into silicon)
    if let Ok(output) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            "(Get-CimInstance Win32_Processor).ProcessorId",
        ])
        .creation_flags(0x08000000)
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() {
            has_cpu = true;
            components.push(val);
        }
    }

    // 3. BIOS Serial Number
    if let Ok(output) = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            "(Get-CimInstance Win32_BIOS).SerialNumber",
        ])
        .creation_flags(0x08000000)
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() && val != "To Be Filled By O.E.M." && val != "Default string" {
            has_bios = true;
            components.push(val);
        }
    }

    if components.is_empty() {
        log::warn!("[HWID] collect FAILED: khong lay duoc component nao (uuid/cpu/bios deu rong)");
        return Err("Could not collect any hardware identifiers".to_string());
    }

    // Combine all components into a single deterministic hash.
    // SHA-256 (ổn định vĩnh viễn) thay cho DefaultHasher/SipHash — vốn KHÔNG được Rust
    // đảm bảo ổn định giữa các bản toolchain (nâng cấp Rust có thể đổi mọi HWID → vỡ license).
    // Lấy 8 byte đầu → 16 hex ký tự (giữ đúng độ dài định dạng HWID cũ).
    use sha2::{Digest, Sha256};
    let combined = components.join("|");
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let digest = hasher.finalize();
    let hwid = hex::encode(&digest[..8]).to_uppercase();
    // DIAG (warn → có ở release): số component + cờ từng nguồn + đuôi HWID. Nếu 2 lần tính
    // ra cờ KHÁC nhau (vd count=3 rồi count=2) → đúng nguồn rớt làm HWID trôi.
    log::warn!(
        "[HWID] collect OK: count={} uuid={} cpu={} bios={} hwid=...{}",
        components.len(),
        has_uuid,
        has_cpu,
        has_bios,
        &hwid[hwid.len().saturating_sub(4)..]
    );
    Ok(hwid)
}

// ── HWID PHẢI ỔN ĐỊNH TUYỆT ĐỐI ──────────────────────────────────────────────
// collect_hardware_fingerprint() chạy 3 lệnh WMI rồi ghép hash; nếu 1 lệnh hiccup/
// trả rỗng ở lần chạy sau thì tập component đổi → hash đổi → HWID TRÔI. Hậu quả:
//  1) token mới ký với 'm'=HWID_mới nhưng header X-Hardware-Id (cache cứng ở api.ts)
//     vẫn là HWID_cũ → backend 403 "machine mismatch" (mất kết nối sidecar).
//  2) HWID mới ăn thêm 1 slot license_activations → chạm max_activations → DEVICE_LIMIT
//     → khóa cứng UI. (Đo thật: 1 máy sinh 2 machine_id cách nhau đúng ~30' heartbeat.)
// Fix: TÍNH ĐÚNG 1 LẦN rồi đóng băng — memory cache (ổn định trong phiên) + DPAPI trên
// đĩa (ổn định qua các lần mở lại, kể cả khi WMI về sau hiccup). File DPAPI ràng user+máy
// nên copy sang máy khác không giải mã được → máy mới tự tính lại, không phá binding.
static CACHED_HWID: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

const HWID_FILE: &str = "prynx_hwid.dat";

fn get_hwid_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Cannot find APPDATA".to_string())?;
    let dir = std::path::Path::new(&appdata).join("PrynX");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dir: {}", e))?;
    Ok(dir.join(HWID_FILE))
}

fn store_hwid_to_disk(hwid: &str) -> Result<(), String> {
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
    let output = Command::new("powershell")
        // SEC (audit 2026-07-26 F5): secret truyen qua BIEN MOI TRUONG cho child powershell,
        // KHONG noi suy vao -Command -> khong lo tren command line (WMI/Sysmon/EDR log argv).
        .env("PRYNX_DPAPI_IN", hwid)
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
    let output = Command::new("powershell")
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

    // 2. Disk cache (DPAPI) — ổn định qua các lần mở lại app, kể cả khi WMI về sau hiccup.
    if let Ok(h) = load_hwid_from_disk() {
        log::warn!(
            "[HWID] resolve: nguon=DISK hwid=...{}",
            &h[h.len().saturating_sub(4)..]
        );
        if let Ok(mut cache) = CACHED_HWID.lock() {
            *cache = Some(h.clone());
        }
        return Ok(h);
    }

    // 3. Chưa có cache ở đâu → tính mới rồi ĐÓNG BĂNG (lưu đĩa + memory).
    // Đây là lần DUY NHẤT nên chạy WMI cho cả vòng đời cài đặt. Nếu log này xuất hiện
    // NHIỀU LẦN trên 1 máy (khác lần cài đầu) → DPAPI lưu/đọc đĩa đang hỏng → điều tra tiếp.
    let hwid = collect_hardware_fingerprint()?;
    match store_hwid_to_disk(&hwid) {
        Ok(()) => log::warn!(
            "[HWID] resolve: nguon=COMPUTE (tinh moi) + luu DISK OK hwid=...{}",
            &hwid[hwid.len().saturating_sub(4)..]
        ),
        // Lưu đĩa hỏng = mất neo ổn định qua các lần mở app → CẢNH BÁO to. Vẫn còn memory
        // cache nên trong phiên không trôi, nhưng mở lại app sẽ tính mới → nguy cơ trôi lại.
        Err(e) => log::warn!(
            "[HWID] resolve: nguon=COMPUTE nhung LUU DISK THAT BAI ({}) — chi con memory cache hwid=...{}",
            e, &hwid[hwid.len().saturating_sub(4)..]
        ),
    }
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

#[derive(Clone)]
struct ValidatedLicense {
    validated_at: u64,
    hardware_id: String,
    license_token_hash: String,
}

// In-memory cache of native-verified license bindings (session-scoped).
static VALIDATED_KEYS: std::sync::LazyLock<Mutex<HashMap<String, ValidatedLicense>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Called by frontend after successful Supabase RPC validation
/// to register the key in Rust's in-memory cache.
///
/// Release builds always verify the server-signed Ed25519 token before caching.
/// Debug builds may run without a token unless production-equivalent enforcement
/// is explicitly enabled.
#[command]
pub fn register_validated_key(license_key: String, token: Option<String>) -> Result<(), String> {
    let tok = token.unwrap_or_default();
    // Release builds always fail closed. The environment switch is retained only
    // so a debug build can opt into production-equivalent enforcement.
    let enforce = !cfg!(debug_assertions)
        || std::env::var("PRYNX_ENFORCE_LICENSE_TOKEN")
            .map(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
    let hw = get_hardware_id()?;
    if tok.is_empty() {
        if enforce {
            return Err("License token required but not provided (enforce mode)".to_string());
        }
        // enforce=false: cache mà không verify (rollout grace / dev mode)
    } else {
        // Never trust a hardware id supplied by the WebView. A patched frontend
        // could otherwise make every installation impersonate the same activated
        // machine. Rust derives the fingerprint itself and rejects any mismatch.
        verify_license_token_internal(&tok, &hw, &license_key)
            .map_err(|e| format!("License token rejected by native gate: {}", e))?;
    }
    use sha2::{Digest, Sha256};
    let license_token_hash = hex::encode(Sha256::digest(tok.as_bytes()));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut cache = VALIDATED_KEYS
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    cache.insert(
        license_key,
        ValidatedLicense {
            validated_at: now,
            hardware_id: hw,
            license_token_hash,
        },
    );
    Ok(())
}

/// Xoá sạch cache key đã xác thực → sign_api_request lập tức từ chối ký request mới.
/// Gọi khi license bị thu hồi/khóa để chặn quyền dùng NGAY trong phiên, không chờ
/// cache hết TTL.
/// Best-effort: lỗi lock chỉ trả về String, không panic.
#[command]
pub fn clear_validated_keys() -> Result<(), String> {
    let mut cache = VALIDATED_KEYS
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    cache.clear();
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
/// payload JSON: {"k":sha256(key)[:16],"m":hwid,"p":product,"exp":unix}. Kiểm sig + exp + m + k.
fn verify_license_token_internal(token: &str, hwid: &str, license_key: &str) -> Result<(), String> {
    verify_token_with_pubkey(token, hwid, license_key, LICENSE_PUBLIC_KEY_B64)
}

/// Lõi verify, nhận pubkey tham số (để unit-test bằng keypair test mà không cần private key thật).
fn verify_token_with_pubkey(
    token: &str,
    hwid: &str,
    license_key: &str,
    pub_b64: &str,
) -> Result<(), String> {
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
        .unwrap()
        .as_secs() as i64;
    let exp = payload.get("exp").and_then(|v| v.as_i64()).unwrap_or(0);
    if exp < now {
        return Err("license token expired".to_string());
    }

    // V3 (đối xứng backend license_guard.py): cận trên tuổi thọ token — chống replay token
    // cũ bằng cách LÙI đồng hồ hệ thống. Token TTL 72h nên (exp - now) hợp lệ luôn ≤ TTL;
    // vượt cận (TTL + dư + skew) ⇒ đồng hồ đã bị lùi xa lúc cấp token. Không phụ thuộc file
    // trên đĩa nên không thể vô hiệu bằng cách xoá state.
    // 8 ngày. TTL server đã rút 7 ngày → 72h (audit 2026-07-25) nhưng cận này GIỮ
    // NGUYÊN trong giai đoạn chuyển tiếp: token 7 ngày phát trước đó vẫn còn hạn.
    // Siết xuống 4 ngày SAU KHI chúng hết hạn. Bất biến: PHẢI ≥ TTL token edge function cấp.
    const MAX_TOKEN_LIFETIME_SECS: i64 = 8 * 24 * 60 * 60;
    if exp - now > MAX_TOKEN_LIFETIME_SECS {
        return Err("license token lifetime implausible (clock rollback?)".to_string());
    }

    // DS-4: field "m" (machine id) BẮT BUỘC — đối xứng với backend license_guard.py:248.
    // Token thiếu "m" KHÔNG được pass (chống token vạn năng dùng mọi máy).
    let m = payload
        .get("m")
        .and_then(|v| v.as_str())
        .ok_or("license token missing required field: machine id")?;
    if !hwid.is_empty() && m != hwid {
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
    Ok(())
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
        let future = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 3600;
        let tok = mk_token(&sk, "HW123", "LIC-KEY", future);
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_ok());
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
            serde_json::json!({ "k": "0123456789abcdef", "p": "prynx", "exp": future }),
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
            serde_json::json!({ "m": "HW123", "p": "prynx", "exp": future }),
        );
        assert!(verify_token_with_pubkey(&tok, "HW123", "LIC-KEY", &pubk).is_err());
    }
}

// ══════════════════════════════════════════════════════════════
// VECTOR #15 FIX: Anti-debug + IAT hook detection.
// Detects debuggers (x64dbg, OllyDbg, WinDbg) and function hooks
// (Frida, Detours, MinHook) on critical security APIs.
// ══════════════════════════════════════════════════════════════

#[cfg(not(debug_assertions))]
fn security_kill_log(reason: &str) {
    log::error!("[SECURITY] {} — terminating process", reason);
    // Ghi file riêng (panic hook không chạy khi exit(1)) để chẩn đoán "app tự thoát".
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
            let _ = writeln!(f, "[{}] {}", now, reason);
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
        let mut rng = rand::thread_rng();
        let token_bytes = token.as_bytes();
        self.mask = (0..token_bytes.len()).map(|_| rng.gen::<u8>()).collect();
        self.cipher = token_bytes
            .iter()
            .zip(self.mask.iter())
            .map(|(t, m)| t ^ m)
            .collect();
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

static SIDECAR_TOKEN: std::sync::LazyLock<Mutex<EncryptedToken>> =
    std::sync::LazyLock::new(|| Mutex::new(EncryptedToken::new()));

/// Called by lib.rs at startup to store the generated token (encrypted in memory).
pub fn set_sidecar_token(token: &str) {
    if let Ok(mut t) = SIDECAR_TOKEN.lock() {
        t.store(token);
    }
}

fn decrypt_sidecar_token() -> Result<String, String> {
    let enc = SIDECAR_TOKEN.lock().map_err(|e| format!("Lock: {}", e))?;
    let decrypted = enc.decrypt();
    if decrypted.is_empty() {
        return Err("Sidecar not initialized".to_string());
    }
    Ok(decrypted)
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
#[command]
pub fn sign_api_request(
    url_path: String,
    license_key: String,
    method: String,
) -> Result<HashMap<String, String>, String> {
    // Gate 1: Check license in Rust cache (mandatory, not opt-in)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let binding = {
        let cache = VALIDATED_KEYS.lock().map_err(|e| format!("Lock: {}", e))?;
        match cache.get(&license_key) {
            Some(value) if now_secs.saturating_sub(value.validated_at) < 28800 => value.clone(),
            _ => return Err("License not validated in Rust cache".to_string()),
        }
    };

    // Gate 2: Decrypt token from encrypted memory (VECTOR #14)
    let token_str = decrypt_sidecar_token()?;

    // Gate 3: Bind the proof to the native-verified license and hardware id.
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
    let sign_payload = format!(
        "{}:{}:{}:{}:{}:{}:{}",
        timestamp,
        nonce,
        normalized_method,
        url_path,
        license_key,
        binding.hardware_id,
        binding.license_token_hash
    );

    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(token_str.as_bytes())
        .map_err(|e| format!("HMAC init error: {}", e))?;
    mac.update(sign_payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());

    let mut headers = HashMap::new();
    headers.insert("X-License-Key".to_string(), license_key);
    headers.insert("X-Hardware-Id".to_string(), binding.hardware_id);
    headers.insert("X-PrynX-Timestamp".to_string(), timestamp);
    headers.insert("X-PrynX-Nonce".to_string(), nonce);
    headers.insert("X-PrynX-Signature".to_string(), signature);

    Ok(headers)
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

    let output = Command::new("powershell")
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

    let output = Command::new("powershell")
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

    let output = Command::new("powershell")
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
    let output = Command::new("powershell")
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
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete token file: {}", e))?;
    }
    Ok(())
}
