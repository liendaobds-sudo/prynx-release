//! Chuẩn bị payload engine dieline cho `include_str!` — plaintext (dev) hoặc đã mã hoá (release).
//!
//! VÌ SAO (anticrack, audit 2026-07-26): trước đây `dieline_engine.rs` nhúng THẲNG
//! `generated/dieline_engine.bundle.js` và việc kiểm license chỉ là một hàm trả
//! `Result<(), String>`. Kẻ crack chỉ cần patch hàm đó thành `Ok(())` là dùng được
//! engine — kết quả kiểm là một BOOLEAN nên sửa được thành "đúng".
//!
//! Nay engine được mã hoá AES-256-GCM bằng khoá phát hành theo TỪNG BẢN; khoá KHÔNG
//! nằm trong binary mà do edge function `license-verify` cấp trong token đã ký (field
//! `rk`). Patch bỏ verify sẽ không có khoá ⇒ giải mã ra rác ⇒ engine không nạp được.
//! Muốn dùng phải có token hợp lệ THẬT, và khoá đổi mỗi bản phát hành nên một khoá bị
//! rò chỉ mở được đúng bản đó.
//!
//! Cách bật: đặt `PRYNX_DIELINE_KEY_B64` (32 byte, base64 chuẩn) khi build.
//! Không đặt → nhúng plaintext để dev/CI (`cargo test`) chạy như cũ.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Header 1 dòng để runtime biết payload thuộc dạng nào (không đoán theo nội dung).
const HEADER_RAW: &str = "PRYNXRAW1";
const HEADER_ENC: &str = "PRYNXENC1";

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let bundle_path = manifest_dir.join("src/generated/dieline_engine.bundle.js");
    let out_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("dieline_payload.txt");

    println!("cargo:rerun-if-changed={}", bundle_path.display());
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=PRYNX_DIELINE_KEY_B64");
    println!("cargo:rerun-if-env-changed=PRYNX_DIELINE_VERSION");

    let source = fs::read(&bundle_path).unwrap_or_else(|e| {
        panic!("Không đọc được bundle dieline {}: {e}", bundle_path.display())
    });

    let key_b64 = env::var("PRYNX_DIELINE_KEY_B64").unwrap_or_default();
    let key_b64 = key_b64.trim();

    if key_b64.is_empty() {
        write_payload(&out_path, HEADER_RAW, "", &source);
        println!("cargo:warning=dieline engine nhung PLAINTEXT (dev/CI). Dat PRYNX_DIELINE_KEY_B64 de khoa ban phat hanh.");
        return;
    }

    let version = env::var("PRYNX_DIELINE_VERSION").unwrap_or_else(|_| "dev".to_string());
    let cipher_blob = encrypt(key_b64, &version, &source);
    write_payload(&out_path, HEADER_ENC, &version, cipher_blob.as_bytes());
}

/// `<HEADER> <version>\n<body>` — version dùng làm AAD nên không thể tráo payload
/// của bản khác vào binary này.
fn write_payload(out_path: &Path, header: &str, version: &str, body: &[u8]) {
    let mut buf = Vec::with_capacity(body.len() + 64);
    buf.extend_from_slice(header.as_bytes());
    buf.push(b' ');
    buf.extend_from_slice(version.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(body);
    fs::write(out_path, buf)
        .unwrap_or_else(|e| panic!("Không ghi được {}: {e}", out_path.display()));
}

/// Trả về `"<nonce_b64>.<ciphertext_b64>"` (base64 URL-safe không đệm).
fn encrypt(key_b64: &str, version: &str, plaintext: &[u8]) -> String {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine as _;

    let key_bytes = STANDARD
        .decode(key_b64)
        .expect("PRYNX_DIELINE_KEY_B64 không phải base64 hợp lệ");
    assert_eq!(
        key_bytes.len(),
        32,
        "PRYNX_DIELINE_KEY_B64 phải là 32 byte (AES-256), nhận {} byte",
        key_bytes.len()
    );

    // Nonce 12 byte dẫn xuất từ khoá + version + độ dài: build KHÔNG cần RNG (build.rs
    // chạy trong môi trường tối giản) nhưng vẫn khác nhau giữa các bản phát hành vì
    // khoá là mới mỗi bản. Mỗi khoá chỉ dùng cho MỘT thông điệp nên không tái dùng nonce.
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, &key_bytes);
    sha2::Digest::update(&mut hasher, version.as_bytes());
    sha2::Digest::update(&mut hasher, (plaintext.len() as u64).to_le_bytes());
    let digest = sha2::Digest::finalize(hasher);
    let nonce_bytes = &digest[..12];

    let cipher = Aes256Gcm::new_from_slice(&key_bytes).expect("khoá AES-256 hợp lệ");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: plaintext,
                aad: version.as_bytes(),
            },
        )
        .expect("mã hoá bundle dieline thất bại");

    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(nonce_bytes),
        URL_SAFE_NO_PAD.encode(ciphertext)
    )
}
