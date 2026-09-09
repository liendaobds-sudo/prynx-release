// SEC (audit 2026-09-09 §SEC.LIC20.01/02): kiểm ngay ở build script, trước khi
// có thể tạo installer. Cargo check/test dùng chế độ dev của Tauri nên không
// cần hash; đóng gói (kể cả --debug) phải đi qua pipeline có đủ sidecar/overlay.
pub(crate) fn validate_release_packaging_inputs(
    is_dev: bool,
    frontend_hash: Option<&str>,
    sidecar_hash: Option<&str>,
    tauri_config: Option<&str>,
) -> Result<(), String> {
    if is_dev {
        return Ok(());
    }

    let fail = |detail: &str| {
        format!(
            "Không đủ cấu hình đóng gói PrynX: {detail}. \
             Hãy chạy build_production.ps1 ở thư mục gốc; không đóng gói bằng tauri build trực tiếp."
        )
    };
    for (name, hash) in [
        ("PRYNX_FRONTEND_HASH", frontend_hash),
        ("PRYNX_SIDECAR_HASH", sidecar_hash),
    ] {
        // Runtime dùng hex chữ thường và so sánh chính xác; không trim/đổi chữ
        // để tránh cho qua một giá trị mà EXE sau đó lại từ chối.
        if !hash.is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err(fail(&format!(
                "{name} phải là SHA-256 gồm 64 ký tự hex chữ thường"
            )));
        }
    }

    // Tauri merge TAURI_CONFIG sau base/platform config; mảng externalBin được
    // thay toàn bộ. Bắt buộc đúng overlay để hash có mặt nhưng backend không
    // vào installer cũng không thể lọt. Không in config có thể chứa dữ liệu riêng.
    let overlay: serde_json::Value =
        serde_json::from_str(tauri_config.ok_or_else(|| fail("thiếu overlay TAURI_CONFIG"))?)
            .map_err(|_| fail("overlay TAURI_CONFIG không phải JSON hợp lệ"))?;
    let expected_sidecar = serde_json::json!(["binaries/pdf-inspector-backend"]);
    if overlay.pointer("/bundle/externalBin") != Some(&expected_sidecar) {
        return Err(fail(
            "overlay phải đóng gói đúng sidecar pdf-inspector-backend",
        ));
    }
    if overlay
        .pointer("/build/beforeBuildCommand")
        .and_then(serde_json::Value::as_str)
        != Some("")
    {
        return Err(fail(
            "overlay phải giữ frontend đã được pipeline build và băm",
        ));
    }
    Ok(())
}

#[cfg(not(test))]
fn main() {
    // Bắt buộc Rust biên dịch lại lib.rs khi 2 biến hash đổi giá trị. Nếu không, option_env!
    // trong lib.rs có thể giữ giá trị cache cũ/rỗng → integrity check dùng hash sai → app
    // có thể tự thoát ở máy khách. (Chỉ ảnh hưởng bản release có set hash.)
    println!("cargo:rerun-if-env-changed=PRYNX_SIDECAR_HASH");
    println!("cargo:rerun-if-env-changed=PRYNX_FRONTEND_HASH");
    println!("cargo:rerun-if-env-changed=PRYNX_FEATURE_GATING_ENABLED");
    println!("cargo:rerun-if-env-changed=PRYNX_LOGO_REBUILD_ENABLED");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-env-changed=DEP_TAURI_DEV");
    if let Err(error) = validate_release_packaging_inputs(
        tauri_build::is_dev(),
        std::env::var("PRYNX_FRONTEND_HASH").ok().as_deref(),
        std::env::var("PRYNX_SIDECAR_HASH").ok().as_deref(),
        std::env::var("TAURI_CONFIG").ok().as_deref(),
    ) {
        panic!("{error}");
    }
    tauri_build::build()
}
