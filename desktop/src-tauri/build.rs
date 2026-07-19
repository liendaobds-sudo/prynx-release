fn main() {
    // Bắt buộc Rust biên dịch lại lib.rs khi 2 biến hash đổi giá trị. Nếu không, option_env!
    // trong lib.rs có thể giữ giá trị cache cũ/rỗng → integrity check dùng hash sai → app
    // có thể tự thoát ở máy khách. (Chỉ ảnh hưởng bản release có set hash.)
    println!("cargo:rerun-if-env-changed=PRYNX_SIDECAR_HASH");
    println!("cargo:rerun-if-env-changed=PRYNX_FRONTEND_HASH");
    println!("cargo:rerun-if-env-changed=PRYNX_FEATURE_GATING_ENABLED");
    tauri_build::build()
}
