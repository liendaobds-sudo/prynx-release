use std::time::{SystemTime, UNIX_EPOCH};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PUBLIC_KEY_B64: &str = "AxpiZnEFXady9wI01spdMRrTNtEthMD30W/90gi27Zk=";
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 8 * 24 * 60 * 60 + 300;
const MAX_CLAIM_LIFETIME_SECONDS: u64 = 8 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: u64 = 5 * 60;
const LICENSE_PROTOCOL_V2: u64 = 2;
const LICENSE_PROTOCOL_V3: u64 = 3;
const V3_MAX_CLAIM_LIFETIME_SECONDS: u64 = 15 * 60;
const DEVICE_KEY_ID_PREFIX: &str = "d3_";

fn decode_url(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| "Malformed license token encoding".to_string())
}

fn now_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| "System clock is invalid".to_string())
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

#[cfg(target_os = "windows")]
mod device_identity {
    use super::*;
    use windows::core::w;
    use windows::Win32::Security::Cryptography::{
        NCryptExportKey, NCryptFreeObject, NCryptGetProperty, NCryptOpenKey,
        NCryptOpenStorageProvider, NCryptSignHash, BCRYPT_PSS_PADDING_INFO, BCRYPT_RSAPUBLIC_BLOB,
        BCRYPT_RSAPUBLIC_MAGIC, BCRYPT_SHA256_ALGORITHM, CERT_KEY_SPEC,
        MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_ALLOW_EXPORT_FLAG, NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG,
        NCRYPT_ALLOW_SIGNING_FLAG, NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_FLAGS,
        NCRYPT_IMPL_HARDWARE_FLAG, NCRYPT_IMPL_TYPE_PROPERTY, NCRYPT_KEY_HANDLE,
        NCRYPT_KEY_USAGE_PROPERTY, NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_PSS_FLAG, NCRYPT_PROV_HANDLE,
        NCRYPT_SILENT_FLAG,
    };
    use windows::Win32::Security::OBJECT_SECURITY_INFORMATION;

    const DEVICE_KEY_NAME: windows::core::PCWSTR = w!("PrintSolutions.PrynX.DeviceAuthority.v3");
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
        // Không đưa public blob hay material nhạy cảm vào lỗi runtime.
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
        .map_err(|error| cng_error("Đọc thuộc tính khóa thiết bị", error))?;
        if written != bytes.len() as u32 {
            return Err("Thuộc tính khóa thiết bị có kích thước không hợp lệ".to_string());
        }
        Ok(u32::from_ne_bytes(bytes))
    }

    fn read_u32_le(blob: &[u8], offset: usize) -> Result<u32, String> {
        let bytes: [u8; 4] = blob
            .get(offset..offset + 4)
            .ok_or_else(|| "Public-key blob TPM bị cắt ngắn".to_string())?
            .try_into()
            .map_err(|_| "Public-key blob TPM có header không hợp lệ".to_string())?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn export_device_key_id(key: NCRYPT_KEY_HANDLE) -> Result<String, String> {
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
        .map_err(|error| cng_error("Đo public key TPM", error))?;
        if !(RSA_PUBLIC_BLOB_HEADER_BYTES as u32..=1024).contains(&required) {
            return Err("Kích thước public-key blob TPM bất thường".to_string());
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
        .map_err(|error| cng_error("Đọc public key TPM", error))?;
        if written != required {
            return Err("Public-key blob TPM có chiều dài không ổn định".to_string());
        }

        let magic = read_u32_le(&blob, 0)?;
        let bits = read_u32_le(&blob, 4)?;
        let exponent_len = read_u32_le(&blob, 8)? as usize;
        let modulus_len = read_u32_le(&blob, 12)? as usize;
        let prime1_len = read_u32_le(&blob, 16)?;
        let prime2_len = read_u32_le(&blob, 20)?;
        if magic != BCRYPT_RSAPUBLIC_MAGIC.0
            || bits != 2048
            || exponent_len == 0
            || exponent_len > 8
            || modulus_len != 256
            || prime1_len != 0
            || prime2_len != 0
        {
            return Err("Public key TPM không đúng định dạng RSA-2048".to_string());
        }
        let exponent_start = RSA_PUBLIC_BLOB_HEADER_BYTES;
        let modulus_start = exponent_start + exponent_len;
        let end = modulus_start + modulus_len;
        if end != blob.len() || blob[exponent_start..modulus_start] != [0x01, 0x00, 0x01] {
            return Err("Public key TPM không dùng exponent 65537".to_string());
        }

        let e = URL_SAFE_NO_PAD.encode(&blob[exponent_start..modulus_start]);
        let n = URL_SAFE_NO_PAD.encode(&blob[modulus_start..end]);
        let canonical_jwk = format!("{{\"e\":\"{e}\",\"kty\":\"RSA\",\"n\":\"{n}\"}}");
        let thumbprint = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical_jwk.as_bytes()));
        Ok(format!("{DEVICE_KEY_ID_PREFIX}{thumbprint}"))
    }

    fn prove_private_key_presence(
        key: NCRYPT_KEY_HANDLE,
        device_key_id: &str,
    ) -> Result<(), String> {
        // Chỉ mở/export public metadata chưa đủ mạnh khi cây key store bị chép.
        // Một phép ký cục bộ buộc Platform KSP gọi private key đã seal trong TPM.
        let digest: [u8; 32] =
            Sha256::digest(format!("PRYNX-LOCAL-DEVICE-PRESENCE-V3\n{device_key_id}\n").as_bytes())
                .into();
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
                &digest,
                None,
                &mut required,
                NCRYPT_PAD_PSS_FLAG,
            )
        }
        .map_err(|error| cng_error("Chứng minh private key TPM", error))?;
        if required != 256 {
            return Err("TPM trả chiều dài chữ ký presence bất thường".to_string());
        }
        let mut signature = vec![0u8; required as usize];
        let mut written = 0u32;
        unsafe {
            NCryptSignHash(
                key,
                Some(padding_ptr),
                &digest,
                Some(&mut signature),
                &mut written,
                NCRYPT_PAD_PSS_FLAG,
            )
        }
        .map_err(|error| cng_error("Chứng minh private key TPM", error))?;
        if written != required {
            return Err("TPM trả chữ ký presence bị cắt ngắn".to_string());
        }
        Ok(())
    }

    pub(super) fn local_device_key_id() -> Result<String, String> {
        let mut provider = NCRYPT_PROV_HANDLE::default();
        unsafe { NCryptOpenStorageProvider(&mut provider, MS_PLATFORM_CRYPTO_PROVIDER, 0) }
            .map_err(|error| cng_error("Mở Microsoft Platform Crypto Provider", error))?;
        let provider = ProviderHandle(provider);
        let implementation = get_u32_property(provider.0.into(), NCRYPT_IMPL_TYPE_PROPERTY)?;
        if implementation & NCRYPT_IMPL_HARDWARE_FLAG == 0 {
            return Err(
                "Crypto provider của khóa thiết bị không được đánh dấu hardware-backed".to_string(),
            );
        }

        let mut key = NCRYPT_KEY_HANDLE::default();
        unsafe {
            NCryptOpenKey(
                provider.0,
                &mut key,
                DEVICE_KEY_NAME,
                CERT_KEY_SPEC(0),
                NCRYPT_SILENT_FLAG,
            )
        }
        .map_err(|error| cng_error("Mở khóa thiết bị TPM", error))?;
        let key = KeyHandle(key);
        let bits = get_u32_property(key.0.into(), NCRYPT_LENGTH_PROPERTY)?;
        let usage = get_u32_property(key.0.into(), NCRYPT_KEY_USAGE_PROPERTY)?;
        let export_policy = get_u32_property(key.0.into(), NCRYPT_EXPORT_POLICY_PROPERTY)?;
        if bits != 2048 || usage & NCRYPT_ALLOW_SIGNING_FLAG == 0 {
            return Err("Khóa thiết bị không đúng policy RSA-2048 SIGN".to_string());
        }
        if export_policy & (NCRYPT_ALLOW_EXPORT_FLAG | NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG) != 0 {
            return Err("Khóa thiết bị đang cho phép export".to_string());
        }
        let device_key_id = export_device_key_id(key.0)?;
        prove_private_key_presence(key.0, &device_key_id)?;
        Ok(device_key_id)
    }
}

#[cfg(not(target_os = "windows"))]
mod device_identity {
    pub(super) fn local_device_key_id() -> Result<String, String> {
        Err("Device authority TPM chỉ hỗ trợ trên Windows".to_string())
    }
}

/// Quyền dùng engine dieline, KÈM khoá mở engine.
///
/// ANTICRACK (audit 2026-07-26): trước đây hàm này trả `Result<(), String>` — kết quả
/// kiểm license chỉ là BOOLEAN nên patch một chỗ là bỏ được. Nay nó trả về `resource_key`
/// lấy từ claim `rk` của token ĐÃ VERIFY; `dieline_engine` cần đúng khoá đó để giải mã
/// engine đã mã hoá lúc build. Patch bỏ verify không giúp gì: không có khoá thì không có
/// engine. Xem `native/build.rs`.
#[derive(Debug, Clone, Default)]
pub struct DielineGrant {
    /// Khoá AES-256 mở engine. `None` khi binary nhúng plaintext (dev/CI) hoặc khi
    /// token do server cũ cấp (chưa có `rk`) — runtime tự quyết định có cần hay không.
    pub resource_key: Option<[u8; 32]>,
}

fn valid_license_challenge(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_device_key_id(value: &str) -> bool {
    value
        .strip_prefix(DEVICE_KEY_ID_PREFIX)
        .is_some_and(|thumbprint| is_base64url_no_pad(thumbprint, 43))
}

fn validate_v3_device_binding(
    claims: &Value,
    hwid: &str,
    local_device_key_id: Option<&str>,
) -> Result<(), String> {
    let device_key_id = claims
        .get("d")
        .and_then(Value::as_str)
        .filter(|value| valid_device_key_id(value))
        .ok_or_else(|| "License token v3 device key is invalid".to_string())?;
    let thumbprint = device_key_id
        .strip_prefix(DEVICE_KEY_ID_PREFIX)
        .ok_or_else(|| "License token v3 device key is invalid".to_string())?;
    let confirmation = claims
        .get("cnf")
        .and_then(Value::as_object)
        .filter(|value| value.len() == 1)
        .and_then(|value| value.get("jkt"))
        .and_then(Value::as_str)
        .filter(|value| is_base64url_no_pad(value, 43))
        .ok_or_else(|| "License token v3 confirmation is invalid".to_string())?;
    if confirmation != thumbprint {
        return Err("License token v3 confirmation mismatch".to_string());
    }
    if claims.get("m").and_then(Value::as_str) != Some(device_key_id) || hwid != device_key_id {
        return Err("License token v3 device binding mismatch".to_string());
    }
    let local = local_device_key_id
        .ok_or_else(|| "Local TPM device key is required for license token v3".to_string())?;
    if local != device_key_id {
        return Err("License token belongs to another TPM device key".to_string());
    }
    Ok(())
}

fn validate_dieline_claims(
    claims: &Value,
    hwid: &str,
    license_key: &str,
    now: u64,
    local_device_key_id: Option<&str>,
) -> Result<DielineGrant, String> {
    let exp = claims
        .get("exp")
        .and_then(Value::as_u64)
        .ok_or_else(|| "License token exp is invalid".to_string())?;
    if exp < now {
        return Err("License token expired".to_string());
    }
    if exp.saturating_sub(now) > MAX_TOKEN_LIFETIME_SECONDS {
        return Err("License token lifetime is implausible".to_string());
    }

    // SEC (audit 2026-09-04 §SEC.16-A1): v3 bind token với public-key
    // fingerprint của khóa TPM. V2 chỉ còn đường drain có hạn ở phía server.
    let version = claims
        .get("v")
        .and_then(Value::as_u64)
        .ok_or_else(|| "PrynX license token version is invalid".to_string())?;
    let issued_at = claims
        .get("iat")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "License token issued-at is invalid".to_string())?;
    if issued_at > now.saturating_add(CLOCK_SKEW_SECONDS) || exp < issued_at {
        return Err("License token lifetime is invalid".to_string());
    }

    match version {
        LICENSE_PROTOCOL_V2 => {
            if exp - issued_at > MAX_CLAIM_LIFETIME_SECONDS {
                return Err("License token v2 lifetime is invalid".to_string());
            }
            claims
                .get("challenge")
                .and_then(Value::as_str)
                .filter(|value| valid_license_challenge(value))
                .ok_or_else(|| "License token v2 challenge is invalid".to_string())?;
            if claims.get("m").and_then(Value::as_str) != Some(hwid) {
                return Err("License token machine mismatch".to_string());
            }
        }
        LICENSE_PROTOCOL_V3 => {
            if exp - issued_at > V3_MAX_CLAIM_LIFETIME_SECONDS
                || exp.saturating_sub(now)
                    > V3_MAX_CLAIM_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS
            {
                return Err("License token v3 lifetime is invalid".to_string());
            }
            let minimum_protocol = claims
                .get("min_v")
                .and_then(Value::as_u64)
                .ok_or_else(|| "License token v3 minimum protocol is invalid".to_string())?;
            if minimum_protocol < LICENSE_PROTOCOL_V3 || minimum_protocol > version {
                return Err("License token v3 minimum protocol is invalid".to_string());
            }
            let challenge_id = claims
                .get("cid")
                .and_then(Value::as_str)
                .filter(|value| is_canonical_uuid(value))
                .ok_or_else(|| "License token v3 challenge receipt is invalid".to_string())?;
            let _ = challenge_id;
            if claims.get("challenge").is_some() {
                return Err("License token v3 contains a legacy challenge".to_string());
            }
            validate_v3_device_binding(claims, hwid, local_device_key_id)?;
        }
        _ => return Err("Unsupported PrynX license token version".to_string()),
    }
    let digest = format!("{:x}", Sha256::digest(license_key.as_bytes()));
    if claims.get("k").and_then(Value::as_str) != Some(&digest[..16]) {
        return Err("License token key mismatch".to_string());
    }
    match claims.get("p").and_then(Value::as_str) {
        Some("prynx") => {}
        Some(_) => return Err("License token product mismatch".to_string()),
        None => return Err("License token missing required field: product".to_string()),
    }
    let plan = claims.get("plan").and_then(Value::as_str).unwrap_or("free");
    let feature_allowed = claims
        .get("features")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| matches!(item.as_str(), Some("packaging.dieline") | Some("*")))
        });
    if !matches!(plan, "pro" | "dev") && !feature_allowed {
        return Err("Feature 'packaging.dieline' requires Pro".to_string());
    }

    // Khoá tài nguyên (`rk`) — chỉ đọc SAU khi mọi kiểm tra trên đã qua, nên khoá chỉ
    // rời khỏi token khi token thật sự hợp lệ, đúng máy, đúng license và đủ quyền.
    let resource_key = match claims.get("rk").and_then(Value::as_str) {
        None => None,
        Some(raw) => {
            let bytes = decode_url(raw).or_else(|_| {
                STANDARD
                    .decode(raw)
                    .map_err(|_| "Malformed resource key".to_string())
            })?;
            let key: [u8; 32] = bytes
                .try_into()
                .map_err(|_| "Resource key has invalid length".to_string())?;
            Some(key)
        }
    };

    Ok(DielineGrant { resource_key })
}

pub fn authorize_dieline(
    token: &str,
    hwid: &str,
    license_key: &str,
) -> Result<DielineGrant, String> {
    // This convenience exists only in debug/test binaries. A release DLL can
    // never enable it by changing an environment variable.
    if cfg!(debug_assertions) && hwid == "DEV_MODE" && license_key == "DEV_MODE" {
        return Ok(DielineGrant::default());
    }
    if token.is_empty() || hwid.is_empty() || license_key.is_empty() {
        return Err("Dieline entitlement credentials are required".to_string());
    }
    let (payload_b64, signature_b64) = token
        .split_once('.')
        .ok_or_else(|| "Malformed license token".to_string())?;
    let public_bytes: [u8; 32] = STANDARD
        .decode(PUBLIC_KEY_B64)
        .map_err(|_| "Embedded license key is invalid".to_string())?
        .try_into()
        .map_err(|_| "Embedded license key has invalid length".to_string())?;
    let public_key = VerifyingKey::from_bytes(&public_bytes)
        .map_err(|_| "Embedded license key is invalid".to_string())?;
    let signature = Signature::from_slice(&decode_url(signature_b64)?)
        .map_err(|_| "License signature has invalid length".to_string())?;
    public_key
        .verify_strict(payload_b64.as_bytes(), &signature)
        .map_err(|_| "Invalid license token signature".to_string())?;

    let claims: Value = serde_json::from_slice(&decode_url(payload_b64)?)
        .map_err(|_| "License token payload is invalid".to_string())?;
    let now = now_seconds()?;
    let local_device_key_id = match claims.get("v").and_then(Value::as_u64) {
        Some(LICENSE_PROTOCOL_V3) => Some(device_identity::local_device_key_id()?),
        _ => None,
    };
    validate_dieline_claims(
        &claims,
        hwid,
        license_key,
        now,
        local_device_key_id.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use sha2::Digest;

    const NOW: u64 = 2_000_000_000;
    const HWID: &str = "0123456789ABCDEF";
    const LICENSE_KEY: &str = "PRYNX-TEST-KEY";
    const DEVICE_THUMBPRINT: &str = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";
    const DEVICE_KEY_ID: &str = "d3_NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

    fn valid_claims() -> Value {
        let digest = format!("{:x}", sha2::Sha256::digest(LICENSE_KEY.as_bytes()));
        json!({
            "v": 2,
            "iat": NOW,
            "challenge": "a".repeat(64),
            "exp": NOW + 3600,
            "m": HWID,
            "k": &digest[..16],
            "p": "prynx",
            "plan": "pro"
        })
    }

    fn valid_v3_claims() -> Value {
        let digest = format!("{:x}", sha2::Sha256::digest(LICENSE_KEY.as_bytes()));
        json!({
            "v": 3,
            "min_v": 3,
            "iat": NOW,
            "exp": NOW + 900,
            "cid": "018f0f5e-8d51-7f77-bbd5-f19db33c4b7a",
            "d": DEVICE_KEY_ID,
            "cnf": { "jkt": DEVICE_THUMBPRINT },
            "m": DEVICE_KEY_ID,
            "k": &digest[..16],
            "p": "prynx",
            "plan": "pro"
        })
    }

    #[test]
    fn debug_dev_identity_is_allowed() {
        let grant = super::authorize_dieline("", "DEV_MODE", "DEV_MODE").expect("debug bypass");
        assert!(grant.resource_key.is_none());
    }

    #[test]
    fn missing_or_forged_tokens_are_rejected() {
        assert!(super::authorize_dieline("", "MACHINE", "KEY").is_err());
        assert!(super::authorize_dieline("e30.ZmFrZQ", "MACHINE", "KEY").is_err());
    }

    #[test]
    fn claims_v2_hop_le_duoc_mo_engine() {
        assert!(
            super::validate_dieline_claims(&valid_claims(), HWID, LICENSE_KEY, NOW, None,).is_ok()
        );
    }

    #[test]
    fn token_v1_hoac_thieu_claim_v2_bi_tu_choi() {
        for field in ["v", "iat", "challenge"] {
            let mut claims = valid_claims();
            claims.as_object_mut().unwrap().remove(field);
            assert!(
                super::validate_dieline_claims(&claims, HWID, LICENSE_KEY, NOW, None).is_err(),
                "thiếu {field} phải fail-closed"
            );
        }

        let mut v1 = valid_claims();
        v1["v"] = json!(1);
        assert!(super::validate_dieline_claims(&v1, HWID, LICENSE_KEY, NOW, None).is_err());
    }

    #[test]
    fn issued_at_va_challenge_sai_hop_dong_bi_tu_choi() {
        let mut future = valid_claims();
        future["iat"] = json!(NOW + super::CLOCK_SKEW_SECONDS + 1);
        assert!(super::validate_dieline_claims(&future, HWID, LICENSE_KEY, NOW, None).is_err());

        let mut too_long = valid_claims();
        too_long["exp"] = json!(NOW + super::MAX_CLAIM_LIFETIME_SECONDS + 1);
        assert!(super::validate_dieline_claims(&too_long, HWID, LICENSE_KEY, NOW, None).is_err());

        for invalid in ["a".repeat(63), "g".repeat(64)] {
            let mut malformed = valid_claims();
            malformed["challenge"] = json!(invalid);
            assert!(
                super::validate_dieline_claims(&malformed, HWID, LICENSE_KEY, NOW, None).is_err()
            );
        }
    }

    #[test]
    fn token_v3_can_khoa_tpm_cuc_bo_moi_mo_duoc_engine() {
        assert!(super::validate_dieline_claims(
            &valid_v3_claims(),
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(DEVICE_KEY_ID),
        )
        .is_ok());

        let other_device = "d3_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let reason = super::validate_dieline_claims(
            &valid_v3_claims(),
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(other_device),
        )
        .expect_err("token chép sang máy không có private key tương ứng phải bị từ chối");
        assert!(reason.contains("another TPM"));
    }

    #[test]
    fn token_v3_thieu_hoac_lech_claim_binding_bi_tu_choi() {
        for field in ["min_v", "cid", "d", "cnf"] {
            let mut claims = valid_v3_claims();
            claims.as_object_mut().unwrap().remove(field);
            assert!(
                super::validate_dieline_claims(
                    &claims,
                    DEVICE_KEY_ID,
                    LICENSE_KEY,
                    NOW,
                    Some(DEVICE_KEY_ID),
                )
                .is_err(),
                "thiếu {field} phải fail-closed"
            );
        }

        let mut wrong_confirmation = valid_v3_claims();
        wrong_confirmation["cnf"]["jkt"] = json!("A".repeat(43));
        assert!(super::validate_dieline_claims(
            &wrong_confirmation,
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(DEVICE_KEY_ID),
        )
        .is_err());

        let mut too_long = valid_v3_claims();
        too_long["exp"] = json!(NOW + super::V3_MAX_CLAIM_LIFETIME_SECONDS + 1);
        assert!(super::validate_dieline_claims(
            &too_long,
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(DEVICE_KEY_ID),
        )
        .is_err());

        let mut clock_rollback = valid_v3_claims();
        clock_rollback["iat"] = json!(NOW + 10_000);
        clock_rollback["exp"] = json!(NOW + 10_900);
        assert!(super::validate_dieline_claims(
            &clock_rollback,
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(DEVICE_KEY_ID),
        )
        .is_err());

        let mut hybrid = valid_v3_claims();
        hybrid["challenge"] = json!("a".repeat(64));
        assert!(super::validate_dieline_claims(
            &hybrid,
            DEVICE_KEY_ID,
            LICENSE_KEY,
            NOW,
            Some(DEVICE_KEY_ID),
        )
        .is_err());
    }
}
