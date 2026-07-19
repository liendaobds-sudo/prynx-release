use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD}, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

const PUBLIC_KEY_B64: &str = "AxpiZnEFXady9wI01spdMRrTNtEthMD30W/90gi27Zk=";
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 8 * 24 * 60 * 60 + 300;

fn decode_url(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(value)
        .or_else(|_| URL_SAFE.decode(value))
        .map_err(|_| "Malformed license token encoding".to_string())
}

fn now_seconds() -> Result<u64, String> {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| "System clock is invalid".to_string())
}

pub fn authorize_dieline(token: &str, hwid: &str, license_key: &str) -> Result<(), String> {
    // This convenience exists only in debug/test binaries. A release DLL can
    // never enable it by changing an environment variable.
    if cfg!(debug_assertions) && hwid == "DEV_MODE" && license_key == "DEV_MODE" {
        return Ok(());
    }
    if token.is_empty() || hwid.is_empty() || license_key.is_empty() {
        return Err("Dieline entitlement credentials are required".to_string());
    }
    let (payload_b64, signature_b64) = token.split_once('.')
        .ok_or_else(|| "Malformed license token".to_string())?;
    let public_bytes: [u8; 32] = STANDARD.decode(PUBLIC_KEY_B64)
        .map_err(|_| "Embedded license key is invalid".to_string())?
        .try_into().map_err(|_| "Embedded license key has invalid length".to_string())?;
    let public_key = VerifyingKey::from_bytes(&public_bytes)
        .map_err(|_| "Embedded license key is invalid".to_string())?;
    let signature = Signature::from_slice(&decode_url(signature_b64)?)
        .map_err(|_| "License signature has invalid length".to_string())?;
    public_key.verify_strict(payload_b64.as_bytes(), &signature)
        .map_err(|_| "Invalid license token signature".to_string())?;

    let claims: Value = serde_json::from_slice(&decode_url(payload_b64)?)
        .map_err(|_| "License token payload is invalid".to_string())?;
    let now = now_seconds()?;
    let exp = claims.get("exp").and_then(Value::as_u64)
        .ok_or_else(|| "License token exp is invalid".to_string())?;
    if exp < now { return Err("License token expired".to_string()); }
    if exp.saturating_sub(now) > MAX_TOKEN_LIFETIME_SECONDS {
        return Err("License token lifetime is implausible".to_string());
    }
    if claims.get("m").and_then(Value::as_str) != Some(hwid) {
        return Err("License token machine mismatch".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(license_key.as_bytes()));
    if claims.get("k").and_then(Value::as_str) != Some(&digest[..16]) {
        return Err("License token key mismatch".to_string());
    }
    if let Some(product) = claims.get("p").and_then(Value::as_str) {
        if product != "prynx" { return Err("License token product mismatch".to_string()); }
    }
    let plan = claims.get("plan").and_then(Value::as_str).unwrap_or("free");
    let feature_allowed = claims.get("features").and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| {
            matches!(item.as_str(), Some("packaging.dieline") | Some("*"))
        }));
    if !matches!(plan, "pro" | "dev") && !feature_allowed {
        return Err("Feature 'packaging.dieline' requires Pro".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn debug_dev_identity_is_allowed() {
        super::authorize_dieline("", "DEV_MODE", "DEV_MODE").expect("debug bypass");
    }

    #[test]
    fn missing_or_forged_tokens_are_rejected() {
        assert!(super::authorize_dieline("", "MACHINE", "KEY").is_err());
        assert!(super::authorize_dieline("e30.ZmFrZQ", "MACHINE", "KEY").is_err());
    }
}
