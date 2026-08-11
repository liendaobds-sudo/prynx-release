use std::cell::RefCell;

use boa_engine::{Context, Source};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;

/// Payload engine do `build.rs` sinh: `PRYNXRAW1 <ver>\n<js>` (dev/CI) hoặc
/// `PRYNXENC1 <ver>\n<nonce_b64>.<ciphertext_b64>` (bản phát hành đã khoá).
///
/// ANTICRACK (audit 2026-07-26): ở bản đã khoá, binary KHÔNG chứa mã engine — chỉ chứa
/// ciphertext. Khoá đến từ claim `rk` trong token license đã ký (xem `dieline_license`).
/// Vì vậy việc kiểm license không còn là điều kiện có thể patch, mà là NGUYÊN LIỆU bắt
/// buộc để engine tồn tại.
const ENGINE_PAYLOAD: &str = include_str!(concat!(env!("OUT_DIR"), "/dieline_payload.txt"));
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 24 * 1024 * 1024;

/// Payload thuộc dạng nào + phần thân sau dòng header.
fn split_payload() -> Result<(&'static str, &'static str, &'static str), String> {
    let (head, body) = ENGINE_PAYLOAD
        .split_once('\n')
        .ok_or_else(|| "Dieline engine payload is malformed".to_string())?;
    let mut parts = head.trim_end_matches('\r').splitn(2, ' ');
    let kind = parts.next().unwrap_or("");
    let version = parts.next().unwrap_or("");
    Ok((kind, version, body))
}

/// True nếu binary này cần khoá mới nạp được engine (bản phát hành đã khoá).
fn engine_is_locked() -> bool {
    matches!(split_payload(), Ok(("PRYNXENC1", _, _)))
}

/// Giải mã (nếu cần) để lấy mã nguồn engine.
///
/// Không log nội dung khoá/plaintext ở bất kỳ nhánh nào; lỗi trả về thông điệp chung
/// (anti-recon, nhất quán với backend).
fn engine_source(resource_key: Option<[u8; 32]>) -> Result<String, String> {
    let (kind, version, body) = split_payload()?;
    match kind {
        "PRYNXRAW1" => Ok(body.to_string()),
        "PRYNXENC1" => {
            use aes_gcm::aead::{Aead, KeyInit, Payload};
            use aes_gcm::{Aes256Gcm, Nonce};
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use base64::Engine as _;

            let key = resource_key.ok_or_else(|| {
                "Dieline engine is locked: a valid license token is required".to_string()
            })?;
            let (nonce_b64, ct_b64) = body
                .trim()
                .split_once('.')
                .ok_or_else(|| "Dieline engine payload is malformed".to_string())?;
            let nonce = URL_SAFE_NO_PAD
                .decode(nonce_b64)
                .map_err(|_| "Dieline engine payload is malformed".to_string())?;
            let ciphertext = URL_SAFE_NO_PAD
                .decode(ct_b64)
                .map_err(|_| "Dieline engine payload is malformed".to_string())?;
            let cipher = Aes256Gcm::new_from_slice(&key)
                .map_err(|_| "Dieline engine key is invalid".to_string())?;
            let plaintext = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: version.as_bytes(),
                    },
                )
                // AES-GCM xác thực: khoá sai / payload bị tráo đều fail ở đây, không
                // bao giờ eval được JS rác.
                .map_err(|_| "Dieline engine could not be unlocked for this license".to_string())?;
            String::from_utf8(plaintext)
                .map_err(|_| "Dieline engine payload is not valid UTF-8".to_string())
        }
        _ => Err("Dieline engine payload has an unknown format".to_string()),
    }
}

thread_local! {
    // Boa contexts are intentionally thread-local: they are not Send, and
    // parsing the bundled engine on every preview request would cause jitter.
    // The context is `&'static mut` (leaked) rather than owned on purpose: boa's
    // GC heap lives in a separate thread-local whose teardown order at thread
    // exit is unspecified. If that heap is dropped before this Context, the
    // Context's drop underflows a GC refcount (boa_gc gc_header.rs) and aborts
    // the thread. Leaking the Context means it is never dropped, so no GC
    // teardown race exists. The engine worker thread lives for the whole
    // process, making this a no-op leak in production.
    static ENGINE_CONTEXT: RefCell<Option<&'static mut Context>> = const { RefCell::new(None) };
}

fn format_js_error(error: boa_engine::JsError) -> String {
    format!("{error}")
}

fn ensure_engine_context(
    slot: &mut Option<&'static mut Context>,
    resource_key: Option<[u8; 32]>,
) -> Result<(), String> {
    if slot.is_none() {
        let source = engine_source(resource_key)?;
        let mut context = Context::default();
        context
            .eval(Source::from_bytes(source.as_bytes()))
            .map_err(format_js_error)?;
        *slot = Some(Box::leak(Box::new(context)));
    }
    Ok(())
}

/// Warmup KHÔNG có credentials.
///
/// Ở bản đã khoá, warmup phải là NO-OP: chưa có token thì chưa có khoá, và ta KHÔNG
/// muốn warmup thất bại làm backend log lỗi mỗi lần khởi động. Lần `generate` đầu tiên
/// (đã có token) sẽ nạp engine. Ở dev/CI (plaintext) warmup vẫn parse trước như cũ để
/// preview đầu tiên không bị giật.
fn warm_engine() -> Result<(), String> {
    if engine_is_locked() {
        return Ok(());
    }
    ENGINE_CONTEXT.with(|slot| ensure_engine_context(&mut slot.borrow_mut(), None))
}

fn run_engine(request_json: &str, resource_key: Option<[u8; 32]>) -> Result<String, String> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err("Dieline request is too large".to_string());
    }
    crate::dieline_request::validate_request_json(request_json)?;

    ENGINE_CONTEXT.with(|slot| {
        let mut slot = slot.borrow_mut();
        ensure_engine_context(&mut slot, resource_key)?;
        let context = slot.as_mut().expect("context initialized");
        // Serialize the JSON as a JavaScript string literal. User-controlled
        // data never becomes executable source.
        let quoted = serde_json::to_string(request_json)
            .map_err(|_| "Could not encode dieline request".to_string())?;
        let script = format!("__prynxGenerateDieline({quoted})");
        let value = context
            .eval(Source::from_bytes(script.as_bytes()))
            .map_err(format_js_error)?;
        let result = value
            .to_string(context)
            .map_err(format_js_error)?
            .to_std_string_escaped();

        if result.len() > MAX_RESPONSE_BYTES {
            return Err("Dieline result is too large".to_string());
        }
        serde_json::from_str::<serde_json::Value>(&result)
            .map_err(|_| "Dieline engine returned invalid JSON".to_string())?;
        Ok(result)
    })
}

/// Parse and initialize the protected engine without generating user data.
/// The backend calls this on its dedicated worker so the first preview is warm.
#[pyfunction]
pub fn warm_dieline_engine(py: Python<'_>) -> PyResult<()> {
    py.detach(warm_engine).map_err(PyRuntimeError::new_err)
}

#[pyfunction]
pub fn generate_dieline_json(
    py: Python<'_>,
    request_json: String,
    license_token: String,
    hwid: String,
    license_key: String,
) -> PyResult<String> {
    py.detach(move || {
        let grant = crate::dieline_license::authorize_dieline(&license_token, &hwid, &license_key)?;
        run_engine(&request_json, grant.resource_key)
    })
    .map_err(PyRuntimeError::new_err)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_json_input() {
        assert!(super::run_engine("not-json", None).is_err());
    }

    /// Payload phải khớp cách build: không có khoá → plaintext; có khoá → đã mã hoá.
    /// Nếu lẫn lộn, các test engine bên dưới sẽ hỏng theo cách khó hiểu.
    #[test]
    fn payload_kind_matches_build_env() {
        let built_with_key = !std::env::var("PRYNX_DIELINE_KEY_B64")
            .unwrap_or_default()
            .trim()
            .is_empty();
        assert_eq!(
            super::engine_is_locked(),
            built_with_key,
            "payload không khớp PRYNX_DIELINE_KEY_B64 lúc build (cargo có thể đang dùng cache cũ)"
        );
    }

    /// Đường ĐÃ KHOÁ, end-to-end trên payload THẬT do `build.rs` sinh:
    ///  - khoá đúng  → ra được mã engine;
    ///  - thiếu khoá → từ chối;
    ///  - khoá sai   → từ chối (không bao giờ eval JS rác).
    /// Chỉ chạy khi build có khoá (bản phát hành / kiểm thử khoá), ngược lại bỏ qua.
    #[test]
    fn locked_build_unlocks_only_with_issued_key() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;

        let key_b64 = std::env::var("PRYNX_DIELINE_KEY_B64").unwrap_or_default();
        let key_b64 = key_b64.trim();
        if key_b64.is_empty() || !super::engine_is_locked() {
            return; // build plaintext (dev/CI) — không có gì để kiểm ở đây
        }
        let key: [u8; 32] = STANDARD
            .decode(key_b64)
            .expect("khoá base64")
            .try_into()
            .unwrap();

        let src = super::engine_source(Some(key)).expect("khoá đúng phải mở được engine");
        assert!(
            src.contains("__prynxGenerateDieline"),
            "giải mã ra phải là mã engine thật"
        );
        assert!(
            super::engine_source(None).is_err(),
            "thiếu khoá PHẢI bị từ chối"
        );
        let mut wrong = key;
        wrong[0] ^= 0xFF;
        assert!(
            super::engine_source(Some(wrong)).is_err(),
            "khoá sai PHẢI bị từ chối"
        );
    }

    /// Bản ĐÃ KHOÁ: khoá sai/thiếu KHÔNG bao giờ ra được mã nguồn engine.
    /// Không phụ thuộc cách build (tự dựng payload mã hoá rồi giải mã lại).
    #[test]
    fn locked_payload_needs_the_right_key() {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};

        let key = [7u8; 32];
        let nonce = [1u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: b"globalThis.__prynxGenerateDieline = () => '{}';",
                    aad: b"1.2.3",
                },
            )
            .unwrap();

        let open = |k: &[u8; 32]| {
            Aes256Gcm::new_from_slice(k).unwrap().decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: b"1.2.3",
                },
            )
        };
        assert!(open(&key).is_ok(), "khoá đúng phải mở được");
        assert!(
            open(&[8u8; 32]).is_err(),
            "khoá sai PHẢI thất bại, không ra JS rác"
        );

        // AAD = version: tráo payload của bản khác vào binary này cũng thất bại.
        let wrong_aad = Aes256Gcm::new_from_slice(&key).unwrap().decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: b"9.9.9",
            },
        );
        assert!(wrong_aad.is_err(), "sai version (AAD) PHẢI thất bại");
    }

    /// Khoá để chạy engine trong test: `None` ở build plaintext, lấy từ env ở build đã
    /// khoá — nhờ vậy CÙNG bộ test chạy được cho cả hai kiểu build.
    fn test_key() -> Option<[u8; 32]> {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let raw = std::env::var("PRYNX_DIELINE_KEY_B64").unwrap_or_default();
        let raw = raw.trim().to_string();
        if raw.is_empty() {
            return None;
        }
        STANDARD.decode(raw).ok()?.try_into().ok()
    }

    #[test]
    fn bundled_engine_warms_then_generates_default_dieline() {
        super::warm_engine().expect("engine warmup should succeed");
        let request = include_str!("../tests/fixtures/dieline_default_request.json");
        let raw = super::run_engine(request, test_key()).expect("bundled engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        assert_eq!(value["dieline"]["params"]["boxType"], "rte");
        assert!(value["dieline"]["panels"]
            .as_array()
            .is_some_and(|p| !p.is_empty()));
        assert!(value["nestingResult"]["countPerSheet"]
            .as_u64()
            .is_some_and(|n| n > 0));
    }

    /// [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ phải chạy được TRONG Boa, không
    /// chỉ qua được tầng validate. Test này là chốt end-to-end phía Rust: bundle nhúng
    /// trong binary có generator mới, sinh đủ panel tai treo + cửa sổ mặt trước.
    /// Trước khi vá, request bị `dieline_request` chặn nên lỗi hiện ra ở UI chỉ là
    /// "Không thể tạo khuôn với thông số này." — không chỉ được tầng nào chặn.
    #[test]
    fn bundled_hanging_window_generates_hang_tabs_and_window() {
        let mut request: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/dieline_default_request.json"
        ))
        .expect("valid request fixture");
        request["params"]["boxType"] = serde_json::Value::String("hanging_window".to_owned());
        // Preset mẫu Dacdora: L=80 × W=30 × D=140.
        request["params"]["L"] = serde_json::json!(80);
        request["params"]["W"] = serde_json::json!(30);
        request["params"]["D"] = serde_json::json!(140);
        request["includeNesting"] = serde_json::Value::Bool(false);

        let raw = super::run_engine(&request.to_string(), test_key())
            .expect("bundled hanging-window engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        let dieline = &value["dieline"];
        assert_eq!(dieline["params"]["boxType"], "hanging_window");

        let panels = dieline["panels"].as_array().expect("panels array");
        let names: Vec<&str> = panels
            .iter()
            .filter_map(|panel| panel["name"].as_str())
            .collect();
        for expected in ["hang_tab_1", "hang_tab_2", "hang_tab_lip", "front", "back"] {
            assert!(
                names.contains(&expected),
                "thiếu panel {expected}: {names:?}"
            );
        }

        // Cửa sổ mặt trước phải là LỖ thật trên panel (3D khoét được), không chỉ là nét vẽ.
        let front = panels
            .iter()
            .find(|panel| panel["name"] == "front")
            .expect("panel mặt trước");
        assert!(
            front["holes"].as_array().is_some_and(|h| !h.is_empty()),
            "mặt trước phải có lỗ cửa sổ",
        );
    }

    #[test]
    fn bundled_slb_has_only_one_visible_tuck_fold() {
        let mut request: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/dieline_default_request.json"
        ))
        .expect("valid request fixture");
        request["params"]["boxType"] = serde_json::Value::String("slb".to_owned());
        request["includeNesting"] = serde_json::Value::Bool(false);

        let raw = super::run_engine(&request.to_string(), test_key())
            .expect("bundled SLB engine should run");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid response JSON");
        let dieline = &value["dieline"];
        let top_threshold = request["params"]["D"].as_f64().unwrap()
            + request["params"]["W"].as_f64().unwrap()
            - 5.0;

        let visible_top_creases = dieline["allPaths"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|path| {
                if path["tag"] != "CREASE" {
                    return false;
                }
                let Some(points) = path["points"].as_array() else {
                    return false;
                };
                if points.len() != 2 {
                    return false;
                }
                let (Some(y1), Some(y2)) = (points[0]["y"].as_f64(), points[1]["y"].as_f64())
                else {
                    return false;
                };
                (y1 - y2).abs() < f64::EPSILON && y1 > top_threshold
            })
            .count();
        assert_eq!(
            visible_top_creases, 1,
            "SLB top tuck must expose one fold line"
        );

        let tuck_panel = dieline["panels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|panel| panel["name"] == "tuck_top")
            .expect("SLB tuck_top panel");
        let false_tuck_creases = tuck_panel["paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|path| path["tag"] == "CREASE")
            .count();
        assert_eq!(
            false_tuck_creases, 0,
            "tuck panel must not add a duplicate crease"
        );
    }
}
