use std::cell::RefCell;

use boa_engine::{Context, Source};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

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

/// [DIELINE-ENGINE-STATUS 2026-08-26 §G] Trạng thái payload engine — CHỈ ĐỌC.
///
/// Vì sao cần một đường riêng: `warm_engine()` CỐ Ý no-op ở bản đã khoá (chưa có token
/// thì chưa có khoá, và warmup không được phép thất bại hay log lỗi mỗi lần khởi động),
/// nên trạng thái "engine bị khoá" chỉ lộ ra khi người dùng đã bấm tạo khuôn. Hàm này
/// trả lời câu hỏi đó TRƯỚC đó mà KHÔNG nhận khoá, KHÔNG giải mã, KHÔNG thể ném.
///
/// Không rò gì: header payload (`PRYNXRAW1`/`PRYNXENC1`) và chuỗi version nằm sẵn ở dạng
/// plaintext trong binary — ai mở file cũng đọc được. Mã engine và khoá `rk` không bao
/// giờ đi qua đây.
fn engine_status() -> (bool, &'static str) {
    match split_payload() {
        Ok((kind, version, _)) => (kind == "PRYNXENC1", version),
        // Payload sai định dạng KHÔNG phải "đã khoá": đó là lỗi đóng gói, và nó lộ ra ở
        // `engine_source()` bằng thông điệp riêng (backend trả 500). Truy vấn trạng thái
        // không được ném, nên báo về mặc định không-khoá thay vì fail — khớp đúng
        // `engine_is_locked()`, vốn cũng chỉ true cho `PRYNXENC1`.
        Err(_) => (false, ""),
    }
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

/// [DIELINE-ENGINE-STATUS 2026-08-26 §G] Truy vấn trạng thái engine cho tầng UI.
///
/// Trả `{ locked, payload_version }`. Không nhận credentials, không giải mã, không có
/// nhánh nào ném — kể cả trên bản đã khoá, nơi `generate_dieline_json` sẽ từ chối vì
/// thiếu claim `rk`. Nhờ vậy công cụ khuôn bế biết mình bị khoá TRƯỚC khi người dùng
/// bấm tạo khuôn, mà `warm_dieline_engine` vẫn giữ nguyên chủ đích no-op.
#[pyfunction]
pub fn dieline_engine_status(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let (locked, payload_version) = engine_status();
    let status = PyDict::new(py);
    status.set_item("locked", locked)?;
    status.set_item("payload_version", payload_version)?;
    Ok(status)
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

    // ─────────────────────────────────────────────────────────────────────────────────
    // [DIELINE-RK-GATE 2026-08-26] Baseline preservation cho lõi mật mã engine.
    //
    // Task 4 của spec `.kiro/specs/dieline-engine-unlock-fix` (Property 2 — Preservation,
    // Validates: Requirements 3.1, 3.2). Nhóm dưới đây MỞ RỘNG khuôn mẫu
    // `locked_payload_needs_the_right_key` ở trên — vốn chỉ kiểm MỘT bộ tham số cứng
    // (khoá `[7u8; 32]`, nonce `[1u8; 12]`, AAD `"1.2.3"`) — thành vòng lặp CÓ SEED CỐ
    // ĐỊNH, 128 vòng, phủ cả bốn mệnh đề của bất biến mật mã. Test cũ được GIỮ NGUYÊN làm
    // mốc tối thiểu dễ đọc; test mới là phát biểu tổng quát.
    //
    // Vì sao cần: bản vá của spec này nằm ở phía server (`license-verify` cấp claim `rk`).
    // Lõi mật mã engine — AES-256-GCM, nonce 12 byte, **AAD = app version**, khoá 32 byte
    // bất biến theo từng bản — PHẢI không đổi (3.1), và build không khoá phải vẫn nạp
    // engine plaintext mà không cần `rk` (3.2). Bộ test này là baseline để so sau khi vá.
    //
    // KHÔNG thêm dependency vào `native/Cargo.toml`: RNG là xorshift64* viết tay, seed cố
    // định nên mọi counterexample tái lập được bằng cách chạy lại đúng lệnh.
    // ─────────────────────────────────────────────────────────────────────────────────

    /// Chuỗi lỗi production ở nhánh THIẾU khoá — trích y nguyên từ `engine_source`.
    /// `backend/app/api/routes/dieline.py::_classify_native_failure()` ghim vào chuỗi này
    /// để trả 403 (lỗi bản quyền) thay vì 422 (lỗi thông số), nên nó là hợp đồng chéo giữa
    /// hai tầng, không phải chuỗi nội bộ.
    const LOCKED_MSG: &str = "Dieline engine is locked: a valid license token is required";

    /// Chuỗi lỗi production khi AES-GCM KHÔNG xác thực được: khoá sai, hoặc AAD sai (tráo
    /// payload của bản phát hành khác vào binary này).
    const UNLOCK_FAILED_MSG: &str = "Dieline engine could not be unlocked for this license";

    /// xorshift64* — RNG viết tay, chỉ để sinh dữ liệu test tái lập được.
    /// KHÔNG dùng cho bất kỳ mục đích mật mã nào.
    struct SeededRng(u64);

    impl SeededRng {
        fn new(seed: u64) -> Self {
            assert_ne!(seed, 0, "xorshift đứng im với seed 0");
            Self(seed)
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn fill(&mut self, out: &mut [u8]) {
            for chunk in out.chunks_mut(8) {
                let word = self.next_u64().to_le_bytes();
                chunk.copy_from_slice(&word[..chunk.len()]);
            }
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next_u64() % bound
        }

        /// Chuỗi version kiểu SemVer-ish dùng làm AAD, nằm trong tập ký tự mà
        /// `license-verify` chấp nhận (`/^[0-9A-Za-z][0-9A-Za-z.\-+]{0,63}$/`).
        fn semver_ish(&mut self) -> String {
            format!(
                "{}.{}.{}-rc.{}",
                self.below(3),
                self.below(10),
                self.below(20),
                self.below(50)
            )
        }
    }

    /// Mở payload đã khoá theo ĐÚNG hợp đồng nhánh `"PRYNXENC1"` của `engine_source`:
    /// thiếu khoá ⇒ từ chối TRƯỚC khi giải mã; có khoá ⇒ AES-256-GCM tự xác thực cả khoá
    /// lẫn AAD.
    ///
    /// Phải mô phỏng chứ không gọi thẳng `engine_source`, vì hàm đó đọc payload NHÚNG lúc
    /// build (`ENGINE_PAYLOAD`, không nhận payload làm tham số) nên không đưa payload tổng
    /// hợp vào được, mà task này không được đụng code sản phẩm. Mirror được GHIM vào
    /// production bởi `engine_source_none_matches_build_kind` bên dưới: chuỗi lỗi và thứ
    /// tự kiểm (thiếu khoá trước, giải mã sau) đều phải khớp.
    fn open_locked_payload(
        resource_key: Option<[u8; 32]>,
        nonce: &[u8; 12],
        ciphertext: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, String> {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};

        let key = resource_key.ok_or_else(|| LOCKED_MSG.to_string())?;
        Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "Dieline engine key is invalid".to_string())?
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| UNLOCK_FAILED_MSG.to_string())
    }

    /// Ghim mirror ở trên vào code sản phẩm, và phát biểu 3.2 cho ĐÚNG kiểu build đang chạy.
    ///
    /// Build ĐÃ KHOÁ: `engine_source(None)` phải từ chối bằng CHÍNH chuỗi mirror dùng.
    /// Build plaintext (dev/CI): `None` là đường THÀNH CÔNG — engine nạp được mà không cần
    /// `rk`. Nhờ tách theo `engine_is_locked()`, cùng một test có nghĩa ở cả hai lượt
    /// `cargo test` (không đặt và có đặt `PRYNX_DIELINE_KEY_B64`).
    #[test]
    fn engine_source_none_matches_build_kind() {
        match super::engine_source(None) {
            Ok(src) => {
                assert!(
                    !super::engine_is_locked(),
                    "build ĐÃ KHOÁ không bao giờ được mở bằng `None`"
                );
                assert!(
                    src.contains("__prynxGenerateDieline"),
                    "build plaintext PHẢI nạp được engine mà không cần `rk` (3.2)"
                );
            }
            Err(msg) => {
                assert!(
                    super::engine_is_locked(),
                    "build plaintext không được từ chối `None` (3.2)"
                );
                assert_eq!(
                    msg, LOCKED_MSG,
                    "chuỗi lỗi thiếu khoá đã đổi — mirror trong test và \
                     `_classify_native_failure()` phía backend đều ghim vào chuỗi này (3.8)"
                );
            }
        }
    }

    /// Property 2 (Preservation) — lõi mật mã engine, 128 vòng có seed cố định.
    /// **Validates: Requirements 3.1, 3.2**
    ///
    /// Bốn mệnh đề, đúng theo task 4:
    ///  1. khoá đúng + AAD đúng ⇒ LUÔN mở được, và ra ĐÚNG nội dung đã mã hoá;
    ///  2. đảo bất kỳ MỘT bit của khoá ⇒ LUÔN bị từ chối (vét cạn cả 256 vị trí bit);
    ///  3. AAD khác (version khác) ⇒ LUÔN bị từ chối — tráo payload giữa hai bản là vô ích;
    ///  4. `None` (token hợp lệ nhưng KHÔNG có claim `rk`) ⇒ LUÔN bị từ chối, và bị từ chối
    ///     TRƯỚC khi giải mã, bằng đúng chuỗi lỗi bản quyền. Đây chính là mắt `keyMissing`
    ///     của bug condition; ở đây nó là baseline phải giữ nguyên sau khi vá server.
    ///
    /// Mệnh đề 2 quét theo CỬA SỔ TRƯỢT 32 bit/vòng thay vì cả 256 bit/vòng: AES-GCM ở
    /// profile debug của `cargo test` đắt, 128×256 lần giải mã sẽ kéo dài suite vô ích.
    /// Cửa sổ dịch 32 bit mỗi vòng nên cả 256 vị trí được phủ sau mỗi 8 vòng, tức 16 lần
    /// trên toàn bộ 128 vòng với 16 khoá khác nhau. Độ phủ vị trí bit được khẳng định
    /// tường minh ở cuối test, nên "bất kỳ MỘT bit" là mệnh đề đã kiểm hết, không phải
    /// mệnh đề lấy mẫu.
    #[test]
    fn locked_payload_key_property_holds_across_seeded_rounds() {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};

        const ROUNDS: usize = 128; // ≥ 100 theo yêu cầu của task
        const KEY_BITS: usize = 256;
        const BITS_PER_ROUND: usize = 32;
        /// Seed cố định ⇒ counterexample tái lập được bằng cách chạy lại đúng lệnh.
        const SEED: u64 = 0x5052_594E_5844_4C31; // "PRYNXDL1"

        let mut rng = SeededRng::new(SEED);
        let mut bit_covered = [0usize; KEY_BITS];

        for round in 0..ROUNDS {
            let mut key = [0u8; 32];
            rng.fill(&mut key);
            let mut nonce = [0u8; 12];
            rng.fill(&mut nonce);

            let version = rng.semver_ish();
            let mut other_version = rng.semver_ish();
            if other_version == version {
                // Rút trùng: thêm hậu tố để chắc chắn khác, vẫn trong tập ký tự cho phép.
                other_version.push_str(".1");
            }
            assert_ne!(
                version, other_version,
                "vòng {round}: hai AAD phải khác nhau"
            );

            let mut plaintext = vec![0u8; 24 + rng.below(96) as usize];
            rng.fill(&mut plaintext);

            let ciphertext = Aes256Gcm::new_from_slice(&key)
                .expect("khoá 32 byte")
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &plaintext,
                        aad: version.as_bytes(),
                    },
                )
                .expect("mã hoá phải thành công");

            // (1) khoá đúng + AAD đúng ⇒ mở được ĐÚNG nội dung.
            let opened = open_locked_payload(Some(key), &nonce, &ciphertext, version.as_bytes());
            assert_eq!(
                opened.as_deref(),
                Ok(plaintext.as_slice()),
                "vòng {round}: khoá đúng phải mở ra đúng nội dung (seed {SEED:#018x})"
            );

            // (2) đảo bất kỳ MỘT bit của khoá ⇒ bị từ chối. Cửa sổ trượt theo vòng.
            let window_start = (round * BITS_PER_ROUND) % KEY_BITS;
            for offset in 0..BITS_PER_ROUND {
                let bit = (window_start + offset) % KEY_BITS;
                let mut wrong = key;
                wrong[bit / 8] ^= 1u8 << (bit % 8);
                let rejected =
                    open_locked_payload(Some(wrong), &nonce, &ciphertext, version.as_bytes());
                assert_eq!(
                    rejected.err().as_deref(),
                    Some(UNLOCK_FAILED_MSG),
                    "vòng {round}: đảo bit {bit} của khoá PHẢI bị từ chối, không bao giờ \
                     ra JS rác (seed {SEED:#018x})"
                );
                bit_covered[bit] += 1;
            }

            // (3) AAD khác ⇒ bị từ chối. AAD = app version, nên khoá của bản này không
            //     mở được payload của bản khác dù thuật toán và nonce y hệt.
            let wrong_aad =
                open_locked_payload(Some(key), &nonce, &ciphertext, other_version.as_bytes());
            assert_eq!(
                wrong_aad.err().as_deref(),
                Some(UNLOCK_FAILED_MSG),
                "vòng {round}: AAD \"{other_version}\" khác \"{version}\" PHẢI bị từ chối"
            );

            // (4) thiếu khoá ⇒ bị từ chối bằng đúng chuỗi bản quyền, TRƯỚC khi giải mã.
            let no_key = open_locked_payload(None, &nonce, &ciphertext, version.as_bytes());
            assert_eq!(
                no_key.err().as_deref(),
                Some(LOCKED_MSG),
                "vòng {round}: `None` PHẢI bị từ chối bằng chuỗi lỗi bản quyền"
            );
        }

        // Mệnh đề 2 chỉ có nghĩa "bất kỳ bit nào" nếu cả 256 vị trí đều đã được đảo.
        let uncovered: Vec<usize> = (0..KEY_BITS).filter(|bit| bit_covered[*bit] == 0).collect();
        assert!(
            uncovered.is_empty(),
            "còn vị trí bit chưa kiểm: {uncovered:?} — cửa sổ trượt phải phủ hết 256 bit"
        );
        let total_flips: usize = bit_covered.iter().sum();
        assert_eq!(
            total_flips,
            ROUNDS * BITS_PER_ROUND,
            "số lần đảo bit không khớp số vòng × cửa sổ"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────────
    // [DIELINE-ENGINE-STATUS 2026-08-26 §G] Truy vấn trạng thái engine.
    //
    // Task 7.2 của spec `.kiro/specs/dieline-engine-unlock-fix` (Property 2 —
    // Preservation, Validates: Requirements 3.1, 3.2). Hai mệnh đề:
    //  1. `engine_status()` báo ĐÚNG kiểu payload và KHÔNG ném ở cả hai kiểu build;
    //  2. `warm_engine()` vẫn NO-OP trên payload đã khoá — bất biến sống còn của lô này.
    // ─────────────────────────────────────────────────────────────────────────────────

    /// Trạng thái phải khớp kiểu build và không có nhánh nào thất bại.
    ///
    /// Không có `Result` trong chữ ký `engine_status()` là chủ đích: truy vấn trạng thái
    /// KHÔNG được ném, kể cả trên bản đã khoá nơi `engine_source(None)` từ chối. Nhờ tách
    /// theo `engine_is_locked()`, cùng một test có nghĩa ở cả hai lượt `cargo test`
    /// (không đặt và có đặt `PRYNX_DIELINE_KEY_B64`).
    #[test]
    fn engine_status_reports_payload_kind_without_failing() {
        let built_with_key = !std::env::var("PRYNX_DIELINE_KEY_B64")
            .unwrap_or_default()
            .trim()
            .is_empty();
        let (locked, payload_version) = super::engine_status();

        assert_eq!(
            locked, built_with_key,
            "trạng thái phải khớp PRYNX_DIELINE_KEY_B64 lúc build: đã khoá ⇒ locked = true, \
             plaintext ⇒ locked = false"
        );
        assert_eq!(
            locked,
            super::engine_is_locked(),
            "`locked` PHẢI khớp `engine_is_locked()` — banner phát hiện sớm phía client \
             đọc đúng cờ mà `warm_engine()` dùng để no-op"
        );

        if locked {
            assert!(
                !payload_version.is_empty(),
                "bản đã khoá PHẢI mang chuỗi version trong header (nó là AAD của AES-GCM)"
            );
        } else {
            assert!(
                payload_version.is_empty(),
                "bản plaintext (dev/CI) không nhúng version — `build.rs` ghi header rỗng"
            );
        }
        // Trường trạng thái chỉ được mang header, không bao giờ mang mã engine hay khoá.
        assert!(
            !payload_version.contains("__prynxGenerateDieline"),
            "payload_version không bao giờ được chứa mã engine"
        );
    }

    /// Bất biến sống còn: warmup KHÔNG đổi hành vi vì có thêm truy vấn trạng thái.
    ///
    /// Trên bản đã khoá, `warm_engine()` phải trả Ok NGAY và KHÔNG nạp context — chưa có
    /// token thì chưa có khoá, và warmup không được log lỗi mỗi lần khởi động (1.8).
    /// Chạy trên thread riêng vì `ENGINE_CONTEXT` là thread-local: chỉ thread mới bảo đảm
    /// quan sát được trạng thái "chưa nạp" bất kể thứ tự chạy test.
    #[test]
    fn warm_engine_remains_a_noop_on_locked_payload() {
        if !super::engine_is_locked() {
            // Bản plaintext CỐ Ý parse trước để preview đầu tiên không giật; đường đó đã
            // có `bundled_engine_warms_then_generates_default_dieline` phủ.
            return;
        }
        std::thread::spawn(|| {
            super::warm_engine()
                .expect("warmup ở bản đã khoá PHẢI trả Ok — không được thất bại lúc khởi động");
            assert!(
                super::ENGINE_CONTEXT.with(|slot| slot.borrow().is_none()),
                "bản đã khoá: warmup PHẢI no-op, không được nạp engine khi chưa có khoá"
            );
        })
        .join()
        .expect("thread kiểm warmup không được panic");
    }
}
