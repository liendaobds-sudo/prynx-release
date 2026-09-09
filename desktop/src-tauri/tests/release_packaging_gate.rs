// SEC (audit 2026-09-09 §SEC.LIC20.01/02): chạy chính helper của build script,
// không thay đổi environment toàn cục và không đóng gói/chạy ứng dụng.
#[path = "../build.rs"]
mod build_script;

use build_script::validate_release_packaging_inputs;

const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OVERLAY: &str = r#"{"build":{"beforeBuildCommand":""},"bundle":{"externalBin":["binaries/pdf-inspector-backend"]}}"#;

#[test]
fn dev_va_cargo_qa_khong_can_input_dong_goi() {
    assert!(validate_release_packaging_inputs(true, None, None, None).is_ok());
    assert!(validate_release_packaging_inputs(true, Some("dev"), None, Some("{}")).is_ok());
}

#[test]
fn dong_goi_thieu_tung_hash_phai_dung_som() {
    for (frontend, sidecar, missing) in [
        (None, Some(HASH), "PRYNX_FRONTEND_HASH"),
        (Some(HASH), None, "PRYNX_SIDECAR_HASH"),
    ] {
        let error =
            validate_release_packaging_inputs(false, frontend, sidecar, Some(OVERLAY)).unwrap_err();
        assert!(error.contains(missing));
        assert!(error.contains("build_production.ps1"));
    }
}

#[test]
fn hash_phai_khop_dinh_dang_runtime_khong_tu_chuan_hoa() {
    for invalid in [
        "".to_string(),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        format!(" {HASH}"),
        "á".repeat(32),
    ] {
        for (frontend, sidecar) in [(invalid.as_str(), HASH), (HASH, invalid.as_str())] {
            assert!(validate_release_packaging_inputs(
                false,
                Some(frontend),
                Some(sidecar),
                Some(OVERLAY),
            )
            .is_err());
        }
    }
}

#[test]
fn co_hash_nhung_thieu_overlay_hoac_sidecar_van_bi_chan() {
    for config in [
        None,
        Some("not-json"),
        Some("null"),
        Some("{}"),
        Some(r#"{"bundle":{"externalBin":[]}}"#),
        Some(r#"{"bundle":{"externalBin":"binaries/pdf-inspector-backend"}}"#),
        Some(r#"{"bundle":{"externalBin":["backend-khac"]}}"#),
        Some(r#"{"bundle":{"externalBin":["binaries/pdf-inspector-backend","extra"]}}"#),
        Some(
            r#"{"bundle":{"externalBin":["binaries/pdf-inspector-backend","binaries/pdf-inspector-backend"]}}"#,
        ),
    ] {
        assert!(validate_release_packaging_inputs(false, Some(HASH), Some(HASH), config).is_err());
    }
}

#[test]
fn khong_duoc_build_lai_frontend_sau_khi_pipeline_da_chot_hash() {
    for hook in [serde_json::Value::Null, serde_json::json!("npm run build")] {
        let overlay = serde_json::json!({
            "bundle": {"externalBin": ["binaries/pdf-inspector-backend"]},
            "build": {"beforeBuildCommand": hook},
        });
        assert!(validate_release_packaging_inputs(
            false,
            Some(HASH),
            Some(HASH),
            Some(&overlay.to_string()),
        )
        .is_err());
    }
}

#[test]
fn hai_overlay_chinh_thuc_deu_qua_gate_khi_co_hash() {
    for overlay in [
        include_str!("../tauri.prod.conf.json"),
        include_str!("../tauri.release.conf.json"),
    ] {
        validate_release_packaging_inputs(false, Some(HASH), Some(HASH), Some(overlay)).unwrap();
    }
}

#[test]
fn thong_bao_loi_khong_echo_hash_hoac_config() {
    let secret_like = "DU_LIEU_RIENG_KHONG_DUOC_IN_RA";
    let error =
        validate_release_packaging_inputs(false, Some(secret_like), Some(HASH), None).unwrap_err();
    assert!(!error.contains(secret_like));
    let error = validate_release_packaging_inputs(false, Some(HASH), Some(HASH), Some(secret_like))
        .unwrap_err();
    assert!(!error.contains(secret_like));
}

#[test]
fn gate_duoc_noi_truoc_tauri_build_va_theo_che_do_tauri() {
    let source = include_str!("../build.rs");
    let main = source.split("fn main() {").nth(1).unwrap();
    assert!(main.contains("tauri_build::is_dev()"));
    assert!(
        main.find("validate_release_packaging_inputs(").unwrap()
            < main.find("tauri_build::build()").unwrap()
    );
    assert!(!main.contains("CARGO_FEATURE_CUSTOM_PROTOCOL"));
    assert!(!main.contains("PROFILE"));
}
