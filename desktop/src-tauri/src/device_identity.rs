//! Device authority v3 cho license PrynX.
//!
//! Ưu tiên tạo private key trong Microsoft Platform Crypto Provider (TPM). Nếu
//! TPM không sẵn sàng, dùng Microsoft Software Key Storage Provider với policy
//! non-exportable; token v3 có lease offline tối đa 72 giờ. Module chỉ expose thao tác có
//! cấu trúc, renderer không có primitive "ký bytes tùy ý".

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::command;

const LICENSE_PROTOCOL_V3: u8 = 3;
const DEVICE_KEY_ID_PREFIX: &str = "d3_";
const PROOF_DOMAIN: &str = "PRYNX-LICENSE-PROOF-V3";
const EXPECTED_ENVIRONMENT: &str = "prod";
const EXPECTED_PRODUCT: &str = "prynx";
const MAX_CHALLENGE_FUTURE_SECONDS: u64 = 5 * 60;
const CHALLENGE_CLOCK_SKEW_SECONDS: u64 = 30;
const DEVICE_PROOF_RECEIPT_TTL_SECONDS: u64 = 3 * 60;
const MAX_PENDING_DEVICE_PROOFS: usize = 32;

static DEVICE_KEY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PENDING_DEVICE_PROOFS: OnceLock<Mutex<HashMap<String, PendingDeviceProofReceipt>>> =
    OnceLock::new();

fn device_key_guard() -> std::sync::MutexGuard<'static, ()> {
    DEVICE_KEY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pending_device_proofs() -> &'static Mutex<HashMap<String, PendingDeviceProofReceipt>> {
    PENDING_DEVICE_PROOFS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct RsaPublicJwk {
    pub e: String,
    pub kty: String,
    pub n: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DevicePublicIdentity {
    pub protocol_version: u8,
    pub device_key_id: String,
    pub proof_alg: String,
    pub public_key_jwk: RsaPublicJwk,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ServerLicenseChallenge {
    pub protocol_version: u8,
    pub environment: String,
    pub action: String,
    pub license_id: String,
    pub product_id: String,
    pub device_key_id: String,
    pub challenge_id: String,
    pub challenge: String,
    pub expires_at: u64,
    pub request_hash: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DeviceLicenseProof {
    pub protocol_version: u8,
    pub device_key_id: String,
    pub proof_alg: String,
    pub proof: String,
    pub proof_input_hash: String,
}

/// Biên nhận chỉ sống trong process native, được tạo đúng lúc CNG ký
/// challenge. Renderer chỉ nhìn thấy `cid` trong token server ký, không thể tự
/// tạo biên nhận để mở lại cache license hoặc thay binding.
#[derive(Clone, Debug)]
struct PendingDeviceProofReceipt {
    challenge_id: String,
    device_key_id: String,
    license_id: String,
    action: String,
    signed_at: u64,
    expires_at: u64,
    created_at: std::time::Instant,
}

fn is_lower_hex(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_base64url_no_pad(value: &str, expected_len: usize) -> bool {
    value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_canonical_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn valid_action(value: &str) -> bool {
    matches!(
        value,
        "enroll" | "refresh" | "rk_grant" | "release" | "recover"
    )
}

fn validate_challenge(
    challenge: &ServerLicenseChallenge,
    local_device_key_id: &str,
    now_seconds: u64,
) -> Result<(), String> {
    if challenge.protocol_version != LICENSE_PROTOCOL_V3 {
        return Err("Server trả sai phiên bản giao thức license".to_string());
    }
    if challenge.environment != EXPECTED_ENVIRONMENT
        || challenge.product_id != EXPECTED_PRODUCT
        || !valid_action(&challenge.action)
    {
        return Err("Phạm vi challenge license không hợp lệ".to_string());
    }
    if !is_canonical_uuid(&challenge.license_id) || !is_canonical_uuid(&challenge.challenge_id) {
        return Err("Định danh challenge license không hợp lệ".to_string());
    }
    if challenge.device_key_id != local_device_key_id
        || !challenge.device_key_id.starts_with(DEVICE_KEY_ID_PREFIX)
        || !is_base64url_no_pad(&challenge.device_key_id[DEVICE_KEY_ID_PREFIX.len()..], 43)
    {
        return Err("Challenge không thuộc khóa thiết bị hiện tại".to_string());
    }
    if !is_lower_hex(&challenge.challenge, 64) || !is_lower_hex(&challenge.request_hash, 64) {
        return Err("Nonce hoặc request hash của challenge không hợp lệ".to_string());
    }
    if challenge
        .expires_at
        .saturating_add(CHALLENGE_CLOCK_SKEW_SECONDS)
        < now_seconds
        || challenge.expires_at > now_seconds.saturating_add(MAX_CHALLENGE_FUTURE_SECONDS)
    {
        return Err("Challenge license đã hết hạn hoặc có thời hạn bất thường".to_string());
    }
    Ok(())
}

/// Canonical transcript v3: UTF-8, LF, thứ tự cố định và luôn có LF cuối.
/// Mọi giá trị đã qua validator nên không thể chèn newline hoặc alias encoding.
fn canonical_proof_transcript(challenge: &ServerLicenseChallenge) -> String {
    format!(
        "{PROOF_DOMAIN}\nprotocol={}\nenvironment={}\naction={}\nlicense_id={}\nproduct={}\ndevice_key_id={}\nchallenge_id={}\nchallenge={}\nexpires_at={}\nrequest_hash={}\n",
        challenge.protocol_version,
        challenge.environment,
        challenge.action,
        challenge.license_id,
        challenge.product_id,
        challenge.device_key_id,
        challenge.challenge_id,
        challenge.challenge,
        challenge.expires_at,
        challenge.request_hash,
    )
}

fn canonical_jwk_thumbprint_input(jwk: &RsaPublicJwk) -> Result<String, String> {
    if jwk.kty != "RSA" || jwk.e != "AQAB" || !is_base64url_no_pad(&jwk.n, 342) {
        return Err("Public key CNG không phải RSA-2048 exponent 65537".to_string());
    }
    // RFC 7638: tên member theo thứ tự từ điển, không whitespace.
    Ok(format!(
        "{{\"e\":\"{}\",\"kty\":\"{}\",\"n\":\"{}\"}}",
        jwk.e, jwk.kty, jwk.n
    ))
}

fn device_key_id_from_jwk(jwk: &RsaPublicJwk) -> Result<String, String> {
    let canonical = canonical_jwk_thumbprint_input(jwk)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!(
        "{DEVICE_KEY_ID_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(digest)
    ))
}

fn unix_time_seconds() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "Đồng hồ hệ thống nằm trước Unix epoch".to_string())
}

fn prune_pending_device_proofs(
    pending: &mut HashMap<String, PendingDeviceProofReceipt>,
    now_seconds: u64,
) {
    let ttl = std::time::Duration::from_secs(DEVICE_PROOF_RECEIPT_TTL_SECONDS);
    pending.retain(|_, receipt| {
        receipt.created_at.elapsed() <= ttl
            && receipt
                .expires_at
                .saturating_add(CHALLENGE_CLOCK_SKEW_SECONDS)
                >= now_seconds
    });
}

fn record_device_proof_receipt(
    challenge: &ServerLicenseChallenge,
    proof: &DeviceLicenseProof,
) -> Result<(), String> {
    if challenge.challenge_id.is_empty()
        || challenge.device_key_id != proof.device_key_id
        || !valid_action(&challenge.action)
    {
        return Err("Không thể tạo biên nhận proof thiết bị".to_string());
    }
    let now_seconds = unix_time_seconds()?;
    let mut pending = pending_device_proofs()
        .lock()
        .map_err(|error| format!("Lock biên nhận proof thất bại: {error}"))?;
    prune_pending_device_proofs(&mut pending, now_seconds);

    // SEC (audit 2026-09-04 §SEC.16-A1): cùng một cid chỉ được ký đúng một
    // transcript trong process. Nếu cho overwrite, renderer có thể ký challenge
    // thật rồi thay action bằng transcript tự dựng trước khi đăng ký token.
    if pending.contains_key(&challenge.challenge_id) {
        return Err("Challenge thiết bị đã được ký trong phiên này".to_string());
    }
    // Chỉ giữ lượt mới nhất cho cùng license/action/device. Server vẫn là nơi
    // consume nonce thật; giới hạn này đóng replay cục bộ và giữ bộ nhớ hữu hạn.
    pending.retain(|_, receipt| {
        receipt.license_id != challenge.license_id
            || receipt.action != challenge.action
            || receipt.device_key_id != challenge.device_key_id
    });
    if pending.len() >= MAX_PENDING_DEVICE_PROOFS {
        return Err("Quá nhiều proof thiết bị đang chờ; vui lòng thử lại".to_string());
    }
    pending.insert(
        challenge.challenge_id.clone(),
        PendingDeviceProofReceipt {
            challenge_id: challenge.challenge_id.clone(),
            device_key_id: challenge.device_key_id.clone(),
            license_id: challenge.license_id.clone(),
            action: challenge.action.clone(),
            signed_at: now_seconds,
            expires_at: challenge.expires_at,
            created_at: std::time::Instant::now(),
        },
    );
    Ok(())
}

/// Tiêu thụ một lần biên nhận tương ứng với `cid` trong token v3 đã được native
/// xác minh chữ ký. Mất biên nhận hoặc lỗi sau consume buộc xin challenge mới;
/// đây là fail-closed có chủ đích, không có fallback về HWID/token legacy.
fn consume_device_proof_receipt_from(
    pending: &mut HashMap<String, PendingDeviceProofReceipt>,
    challenge_id: &str,
    device_key_id: &str,
    token_issued_at: u64,
    replacement_requested: bool,
    now_seconds: u64,
) -> Result<(), String> {
    prune_pending_device_proofs(pending, now_seconds);
    let receipt = pending
        .get(challenge_id)
        .ok_or_else(|| "Biên nhận proof thiết bị không tồn tại hoặc đã hết hạn".to_string())?;
    if receipt.challenge_id != challenge_id || receipt.device_key_id != device_key_id {
        return Err("Biên nhận proof không khớp token hoặc khóa CNG".to_string());
    }
    if token_issued_at.saturating_add(CHALLENGE_CLOCK_SKEW_SECONDS) < receipt.signed_at
        || token_issued_at
            > receipt
                .expires_at
                .saturating_add(CHALLENGE_CLOCK_SKEW_SECONDS)
    {
        return Err("Token không nằm trong cửa sổ challenge đã ký".to_string());
    }
    if receipt.action == "release" {
        return Err("Proof release không được dùng để đăng ký quyền cục bộ".to_string());
    }
    if replacement_requested && receipt.action != "recover" {
        return Err("Thay license binding yêu cầu proof recovery đúng phạm vi".to_string());
    }
    pending.remove(challenge_id);
    Ok(())
}

pub(crate) fn consume_device_proof_receipt(
    challenge_id: &str,
    device_key_id: &str,
    token_issued_at: u64,
    replacement_requested: bool,
) -> Result<(), String> {
    let now_seconds = unix_time_seconds()?;
    let mut pending = pending_device_proofs()
        .lock()
        .map_err(|error| format!("Lock biên nhận proof thất bại: {error}"))?;
    consume_device_proof_receipt_from(
        &mut pending,
        challenge_id,
        device_key_id,
        token_issued_at,
        replacement_requested,
        now_seconds,
    )
}

/// Logout/revoke phải huỷ luôn mọi receipt đang bay. Dùng cùng khóa thao tác CNG
/// để clear không thể chen giữa lúc ký và lúc ghi receipt.
pub(crate) fn clear_device_proof_receipts() -> Result<(), String> {
    let _guard = device_key_guard();
    let mut pending = pending_device_proofs()
        .lock()
        .map_err(|error| format!("Lock biên nhận proof thất bại: {error}"))?;
    pending.clear();
    Ok(())
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use windows::core::w;
    use windows::Win32::Security::Cryptography::{
        NCryptCreatePersistedKey, NCryptExportKey, NCryptFinalizeKey, NCryptFreeObject,
        NCryptGetProperty, NCryptOpenKey, NCryptOpenStorageProvider, NCryptSetProperty,
        NCryptSignHash, BCRYPT_PSS_PADDING_INFO, BCRYPT_RSAPUBLIC_BLOB, BCRYPT_RSAPUBLIC_MAGIC,
        BCRYPT_SHA256_ALGORITHM, CERT_KEY_SPEC, MS_PLATFORM_CRYPTO_PROVIDER,
        NCRYPT_ALLOW_EXPORT_FLAG, NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG, NCRYPT_ALLOW_SIGNING_FLAG,
        NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS, NCRYPT_IMPL_HARDWARE_FLAG,
        NCRYPT_IMPL_TYPE_PROPERTY, NCRYPT_KEY_HANDLE, NCRYPT_KEY_USAGE_PROPERTY,
        NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_PSS_FLAG, NCRYPT_PERSIST_FLAG, NCRYPT_PROV_HANDLE,
        NCRYPT_RSA_ALGORITHM, NCRYPT_SILENT_FLAG,
    };
    use windows::Win32::Security::OBJECT_SECURITY_INFORMATION;

    const DEVICE_KEY_NAME: windows::core::PCWSTR = w!("PrintSolutions.PrynX.DeviceAuthority.v3");
    const SOFTWARE_PROVIDER_NAME: windows::core::PCWSTR =
        w!("Microsoft Software Key Storage Provider");
    const RSA_PUBLIC_BLOB_HEADER_BYTES: usize = 24;

    struct ProviderHandle(NCRYPT_PROV_HANDLE);

    impl Drop for ProviderHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                let _ = unsafe { NCryptFreeObject(self.0.into()) };
                self.0 = NCRYPT_PROV_HANDLE::default();
            }
        }
    }

    struct KeyHandle(NCRYPT_KEY_HANDLE);

    impl Drop for KeyHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                let _ = unsafe { NCryptFreeObject(self.0.into()) };
                self.0 = NCRYPT_KEY_HANDLE::default();
            }
        }
    }

    fn cng_error(operation: &str, error: windows::core::Error) -> String {
        // Không đưa key/blob/nonce vào lỗi. HRESULT đủ để chẩn đoán CNG.
        format!("{operation} thất bại ({:#010x})", error.code().0 as u32)
    }

    fn get_u32_property(
        object: windows::Win32::Security::Cryptography::NCRYPT_HANDLE,
        property: windows::core::PCWSTR,
    ) -> Result<u32, String> {
        let mut bytes = [0u8; 4];
        let mut written = 0u32;
        unsafe {
            NCryptGetProperty(
                object,
                property,
                Some(&mut bytes),
                &mut written,
                OBJECT_SECURITY_INFORMATION(0),
            )
        }
        .map_err(|error| cng_error("Đọc thuộc tính CNG", error))?;
        if written != bytes.len() as u32 {
            return Err("Thuộc tính CNG có kích thước không hợp lệ".to_string());
        }
        Ok(u32::from_ne_bytes(bytes))
    }

    fn open_platform_provider() -> Result<ProviderHandle, String> {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) }
            .map_err(|error| cng_error("Mở Microsoft Platform Crypto Provider", error))?;
        let provider = ProviderHandle(provider);
        let implementation = get_u32_property(provider.0.into(), NCRYPT_IMPL_TYPE_PROPERTY)?;
        if implementation & NCRYPT_IMPL_HARDWARE_FLAG == 0 {
            return Err("Crypto provider không được Windows đánh dấu hardware-backed".to_string());
        }
        Ok(provider)
    }

    fn open_software_provider() -> Result<ProviderHandle, String> {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        unsafe { NCryptOpenStorageProvider(&mut provider, SOFTWARE_PROVIDER_NAME, 0) }
            .map_err(|error| cng_error("Mở Microsoft Software Key Storage Provider", error))?;
        Ok(ProviderHandle(provider))
    }

    fn set_u32_property(
        key: NCRYPT_KEY_HANDLE,
        property: windows::core::PCWSTR,
        value: u32,
    ) -> Result<(), String> {
        unsafe {
            NCryptSetProperty(
                key.into(),
                property,
                &value.to_ne_bytes(),
                NCRYPT_PERSIST_FLAG,
            )
        }
        .map_err(|error| cng_error("Thiết lập thuộc tính khóa CNG", error))
    }

    fn open_existing_key(provider: NCRYPT_PROV_HANDLE) -> Result<KeyHandle, windows::core::Error> {
        let mut key = NCRYPT_KEY_HANDLE::default();
        unsafe {
            NCryptOpenKey(
                provider,
                &mut key,
                DEVICE_KEY_NAME,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        }?;
        Ok(KeyHandle(key))
    }

    fn create_key(provider: NCRYPT_PROV_HANDLE) -> Result<KeyHandle, String> {
        let mut key = NCRYPT_KEY_HANDLE::default();
        unsafe {
            NCryptCreatePersistedKey(
                provider,
                &mut key,
                NCRYPT_RSA_ALGORITHM,
                DEVICE_KEY_NAME,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        }
        .map_err(|error| cng_error("Tạo khóa định danh CNG", error))?;
        let key = KeyHandle(key);
        set_u32_property(key.0, NCRYPT_LENGTH_PROPERTY, 2048)?;
        set_u32_property(key.0, NCRYPT_KEY_USAGE_PROPERTY, NCRYPT_ALLOW_SIGNING_FLAG)?;
        set_u32_property(key.0, NCRYPT_EXPORT_POLICY_PROPERTY, 0)?;
        unsafe { NCryptFinalizeKey(key.0, NCRYPT_SILENT_FLAG) }
            .map_err(|error| cng_error("Hoàn tất khóa định danh CNG", error))?;
        Ok(key)
    }

    fn create_or_reopen_key(
        provider: NCRYPT_PROV_HANDLE,
        provider_label: &str,
    ) -> Result<KeyHandle, String> {
        match open_existing_key(provider) {
            Ok(key) => Ok(key),
            Err(open_error) => match create_key(provider) {
                Ok(key) => Ok(key),
                // Hai process có thể cùng thấy "chưa có"; process thắng tạo key,
                // process còn lại chỉ được reopen, tuyệt đối không overwrite.
                Err(create_error) => open_existing_key(provider).map_err(|retry_error| {
                    format!(
                        "Không mở/tạo được khóa {provider_label} (open={:#010x}, create={}, retry={:#010x})",
                        open_error.code().0 as u32,
                        create_error,
                        retry_error.code().0 as u32,
                    )
                }),
            },
        }
    }

    fn load_device_key() -> Result<KeyHandle, String> {
        let platform_provider = open_platform_provider().ok();
        if let Some(provider) = platform_provider.as_ref() {
            if let Ok(key) = open_existing_key(provider.0) {
                return Ok(key);
            }
        }

        // SEC (audit 2026-09-04 §SEC.16-A1): nếu đã từng fallback vì TPM lỗi,
        // giữ nguyên software key để device ID không tự đổi khi TPM hoạt động lại.
        let software_provider = open_software_provider()?;
        if let Ok(key) = open_existing_key(software_provider.0) {
            return Ok(key);
        }

        if let Some(provider) = platform_provider.as_ref() {
            if let Ok(key) = create_or_reopen_key(provider.0, "TPM") {
                return Ok(key);
            }
        }
        create_or_reopen_key(software_provider.0, "CNG software")
    }

    fn validate_key_policy(key: NCRYPT_KEY_HANDLE) -> Result<(), String> {
        let bits = get_u32_property(key.into(), NCRYPT_LENGTH_PROPERTY)?;
        let usage = get_u32_property(key.into(), NCRYPT_KEY_USAGE_PROPERTY)?;
        let export_policy = get_u32_property(key.into(), NCRYPT_EXPORT_POLICY_PROPERTY)?;
        if bits != 2048 || usage & NCRYPT_ALLOW_SIGNING_FLAG == 0 {
            return Err("Khóa thiết bị không đúng policy RSA-2048 SIGN".to_string());
        }
        if export_policy & (NCRYPT_ALLOW_EXPORT_FLAG | NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG) != 0 {
            return Err("Khóa thiết bị đang cho phép export".to_string());
        }
        Ok(())
    }

    fn read_u32_le(blob: &[u8], offset: usize) -> Result<u32, String> {
        let bytes: [u8; 4] = blob
            .get(offset..offset + 4)
            .ok_or_else(|| "Public-key blob bị cắt ngắn".to_string())?
            .try_into()
            .map_err(|_| "Public-key blob có header không hợp lệ".to_string())?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn export_public_jwk(key: NCRYPT_KEY_HANDLE) -> Result<RsaPublicJwk, String> {
        let mut required = 0u32;
        unsafe {
            NCryptExportKey(
                key,
                None,
                BCRYPT_RSAPUBLIC_BLOB,
                None,
                None,
                &mut required,
                NCRYPT_FLAGS(0),
            )
        }
        .map_err(|error| cng_error("Đo kích thước public key CNG", error))?;
        if !(RSA_PUBLIC_BLOB_HEADER_BYTES as u32..=1024).contains(&required) {
            return Err("Kích thước public-key blob bất thường".to_string());
        }
        let mut blob = vec![0u8; required as usize];
        let mut written = 0u32;
        unsafe {
            NCryptExportKey(
                key,
                None,
                BCRYPT_RSAPUBLIC_BLOB,
                None,
                Some(&mut blob),
                &mut written,
                NCRYPT_FLAGS(0),
            )
        }
        .map_err(|error| cng_error("Export public key CNG", error))?;
        if written != required {
            return Err("Public-key blob có chiều dài không ổn định".to_string());
        }

        let magic = read_u32_le(&blob, 0)?;
        let bit_length = read_u32_le(&blob, 4)?;
        let exponent_length = read_u32_le(&blob, 8)? as usize;
        let modulus_length = read_u32_le(&blob, 12)? as usize;
        let prime1_length = read_u32_le(&blob, 16)?;
        let prime2_length = read_u32_le(&blob, 20)?;
        if magic != BCRYPT_RSAPUBLIC_MAGIC.0
            || bit_length != 2048
            || exponent_length == 0
            || exponent_length > 8
            || modulus_length != 256
            || prime1_length != 0
            || prime2_length != 0
        {
            return Err("Public key CNG không đúng định dạng RSA-2048".to_string());
        }
        let exponent_start = RSA_PUBLIC_BLOB_HEADER_BYTES;
        let modulus_start = exponent_start + exponent_length;
        let end = modulus_start + modulus_length;
        if end != blob.len() {
            return Err("Public-key blob chứa dữ liệu thừa hoặc thiếu".to_string());
        }
        let exponent = &blob[exponent_start..modulus_start];
        if exponent != [0x01, 0x00, 0x01] {
            return Err("Public key CNG không dùng exponent 65537".to_string());
        }
        Ok(RsaPublicJwk {
            e: URL_SAFE_NO_PAD.encode(exponent),
            kty: "RSA".to_string(),
            n: URL_SAFE_NO_PAD.encode(&blob[modulus_start..end]),
        })
    }

    fn load_identity() -> Result<(KeyHandle, DevicePublicIdentity), String> {
        let key = load_device_key()?;
        validate_key_policy(key.0)?;
        let public_key_jwk = export_public_jwk(key.0)?;
        let device_key_id = device_key_id_from_jwk(&public_key_jwk)?;
        Ok((
            key,
            DevicePublicIdentity {
                protocol_version: LICENSE_PROTOCOL_V3,
                device_key_id,
                proof_alg: "PS256".to_string(),
                public_key_jwk,
            },
        ))
    }

    fn sign_digest(key: NCRYPT_KEY_HANDLE, digest: &[u8; 32]) -> Result<Vec<u8>, String> {
        let padding = BCRYPT_PSS_PADDING_INFO {
            pszAlgId: BCRYPT_SHA256_ALGORITHM,
            cbSalt: 32,
        };
        let padding_ptr = &padding as *const BCRYPT_PSS_PADDING_INFO as *const core::ffi::c_void;
        let mut required = 0u32;
        unsafe {
            NCryptSignHash(
                key,
                Some(padding_ptr),
                digest,
                None,
                &mut required,
                NCRYPT_PAD_PSS_FLAG,
            )
        }
        .map_err(|error| cng_error("Đo chữ ký proof CNG", error))?;
        if required != 256 {
            return Err("CNG trả chiều dài chữ ký RSA bất thường".to_string());
        }
        let mut signature = vec![0u8; required as usize];
        let mut written = 0u32;
        unsafe {
            NCryptSignHash(
                key,
                Some(padding_ptr),
                digest,
                Some(&mut signature),
                &mut written,
                NCRYPT_PAD_PSS_FLAG,
            )
        }
        .map_err(|error| cng_error("Ký proof bằng CNG", error))?;
        if written != required {
            return Err("CNG trả chữ ký bị cắt ngắn".to_string());
        }
        Ok(signature)
    }

    pub(super) fn get_identity() -> Result<DevicePublicIdentity, String> {
        let (_key, identity) = load_identity()?;
        Ok(identity)
    }

    pub(super) fn sign_challenge(
        challenge: ServerLicenseChallenge,
    ) -> Result<DeviceLicenseProof, String> {
        let (key, identity) = load_identity()?;
        validate_challenge(&challenge, &identity.device_key_id, unix_time_seconds()?)?;
        let transcript = canonical_proof_transcript(&challenge);
        let digest: [u8; 32] = Sha256::digest(transcript.as_bytes()).into();
        let signature = sign_digest(key.0, &digest)?;
        Ok(DeviceLicenseProof {
            protocol_version: LICENSE_PROTOCOL_V3,
            device_key_id: identity.device_key_id,
            proof_alg: "PS256".to_string(),
            proof: URL_SAFE_NO_PAD.encode(signature),
            proof_input_hash: URL_SAFE_NO_PAD.encode(digest),
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::*;

    pub(super) fn get_identity() -> Result<DevicePublicIdentity, String> {
        Err("Device authority CNG chỉ hỗ trợ trên Windows".to_string())
    }

    pub(super) fn sign_challenge(
        _challenge: ServerLicenseChallenge,
    ) -> Result<DeviceLicenseProof, String> {
        Err("Device authority CNG chỉ hỗ trợ trên Windows".to_string())
    }
}

#[command]
pub fn get_device_public_identity() -> Result<DevicePublicIdentity, String> {
    let _guard = device_key_guard();
    platform::get_identity()
}

#[command]
pub fn sign_device_license_challenge(
    challenge: ServerLicenseChallenge,
) -> Result<DeviceLicenseProof, String> {
    let _guard = device_key_guard();
    let proof = platform::sign_challenge(challenge.clone())?;
    record_device_proof_receipt(&challenge, &proof)?;
    Ok(proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector_challenge() -> ServerLicenseChallenge {
        ServerLicenseChallenge {
            protocol_version: 3,
            environment: "prod".to_string(),
            action: "refresh".to_string(),
            license_id: "018f0f5e-7b7c-7e24-8a5e-847f567f3341".to_string(),
            product_id: "prynx".to_string(),
            device_key_id: "d3_NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs".to_string(),
            challenge_id: "018f0f5e-8d51-7f77-bbd5-f19db33c4b7a".to_string(),
            challenge: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
                .to_string(),
            expires_at: 1_788_480_120,
            request_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .to_string(),
        }
    }

    #[test]
    fn transcript_v3_co_dinh_tung_byte() {
        let transcript = canonical_proof_transcript(&vector_challenge());
        assert_eq!(transcript.as_bytes().len(), 414);
        assert_eq!(
            hex::encode(Sha256::digest(transcript.as_bytes())),
            "b46deeba2558b8d68c750d77f8062da21d67dc08bee48e4a56187d812c080f3d"
        );
        assert!(transcript.ends_with('\n'));
        assert!(!transcript.contains('\r'));
    }

    #[test]
    fn jwk_thumbprint_co_format_on_dinh() {
        let mut modulus = vec![0u8; 256];
        modulus[0] = 0x80;
        modulus[255] = 0x01;
        let jwk = RsaPublicJwk {
            e: "AQAB".to_string(),
            kty: "RSA".to_string(),
            n: URL_SAFE_NO_PAD.encode(modulus),
        };
        assert_eq!(jwk.n.len(), 342);
        assert_eq!(
            canonical_jwk_thumbprint_input(&jwk).unwrap(),
            format!("{{\"e\":\"AQAB\",\"kty\":\"RSA\",\"n\":\"{}\"}}", jwk.n)
        );
        let device_id = device_key_id_from_jwk(&jwk).unwrap();
        assert!(device_id.starts_with("d3_"));
        assert_eq!(device_id.len(), 46);
    }

    #[test]
    fn challenge_sai_scope_hoac_encoding_bi_tu_choi() {
        let valid = vector_challenge();
        assert!(validate_challenge(&valid, &valid.device_key_id, 1_788_480_100).is_ok());

        let mut invalid = valid.clone();
        invalid.action = "sign_anything".to_string();
        assert!(validate_challenge(&invalid, &valid.device_key_id, 1_788_480_100).is_err());

        let mut invalid = valid.clone();
        invalid.challenge = invalid.challenge.to_uppercase();
        assert!(validate_challenge(&invalid, &valid.device_key_id, 1_788_480_100).is_err());

        assert!(validate_challenge(
            &valid,
            "d3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1_788_480_100
        )
        .is_err());
        assert!(validate_challenge(&valid, &valid.device_key_id, 1_788_481_000).is_err());
    }

    fn proof_receipt(action: &str, created_at: std::time::Instant) -> PendingDeviceProofReceipt {
        let challenge = vector_challenge();
        PendingDeviceProofReceipt {
            challenge_id: challenge.challenge_id,
            device_key_id: challenge.device_key_id,
            license_id: challenge.license_id,
            action: action.to_string(),
            signed_at: 1_788_480_000,
            expires_at: 1_788_480_120,
            created_at,
        }
    }

    #[test]
    fn receipt_v3_tieu_thu_dung_mot_lan_va_bind_device() {
        let receipt = proof_receipt("refresh", std::time::Instant::now());
        let cid = receipt.challenge_id.clone();
        let device_id = receipt.device_key_id.clone();
        let mut pending = HashMap::from([(cid.clone(), receipt)]);

        assert!(consume_device_proof_receipt_from(
            &mut pending,
            &cid,
            &device_id,
            1_788_480_010,
            false,
            1_788_480_020,
        )
        .is_ok());
        assert!(pending.is_empty());
        assert!(consume_device_proof_receipt_from(
            &mut pending,
            &cid,
            &device_id,
            1_788_480_010,
            false,
            1_788_480_020,
        )
        .is_err());

        let receipt = proof_receipt("refresh", std::time::Instant::now());
        let mut pending = HashMap::from([(cid.clone(), receipt)]);
        assert!(consume_device_proof_receipt_from(
            &mut pending,
            &cid,
            "d3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            1_788_480_010,
            false,
            1_788_480_020,
        )
        .is_err());
        assert!(pending.contains_key(&cid));
    }

    #[test]
    fn receipt_v3_het_han_release_va_replacement_sai_scope_bi_khoa() {
        let old = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(
                DEVICE_PROOF_RECEIPT_TTL_SECONDS + 1,
            ))
            .expect("instant đủ xa");
        let expired = proof_receipt("refresh", old);
        let cid = expired.challenge_id.clone();
        let device_id = expired.device_key_id.clone();
        let mut pending = HashMap::from([(cid.clone(), expired)]);
        assert!(consume_device_proof_receipt_from(
            &mut pending,
            &cid,
            &device_id,
            1_788_480_010,
            false,
            1_788_480_020,
        )
        .is_err());
        assert!(pending.is_empty());

        for (action, replacement) in [("release", false), ("refresh", true)] {
            let receipt = proof_receipt(action, std::time::Instant::now());
            let mut pending = HashMap::from([(cid.clone(), receipt)]);
            assert!(consume_device_proof_receipt_from(
                &mut pending,
                &cid,
                &device_id,
                1_788_480_010,
                replacement,
                1_788_480_020,
            )
            .is_err());
            assert!(pending.contains_key(&cid));
        }

        let recovery = proof_receipt("recover", std::time::Instant::now());
        let mut pending = HashMap::from([(cid.clone(), recovery)]);
        assert!(consume_device_proof_receipt_from(
            &mut pending,
            &cid,
            &device_id,
            1_788_480_010,
            true,
            1_788_480_020,
        )
        .is_ok());
    }
}
