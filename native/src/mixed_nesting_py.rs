//! Binding PyO3 cho engine "Bình lồng ghép tự do" (P5).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.2, §16.2.
//!
//! ## Bốn ràng buộc của lớp cầu này
//!
//! 1. **`solve()` phải nhả GIL** trong lúc Rust tính. Nếu không, sidecar FastAPI đứng
//!    hình và endpoint Status/Cancel không phản hồi được — đúng điều §20 gọi là NO-GO.
//! 2. **Progress ghi vào atomic**, không callback về Python từ vòng nóng. Python đọc
//!    snapshot khi nào muốn.
//! 3. **Panic không được làm chết sidecar.** Mọi lời gọi được bọc `catch_unwind` và
//!    quy về lỗi Python có mã ổn định.
//! 4. **Không fallback sang solver cũ.** File này chỉ gọi
//!    `imposition_core::mixed_nesting`; không import `nfp_solver`, `imposition` hay
//!    bất kỳ đường bình bài hiện có nào.
//!
//! ## Hợp đồng lỗi
//!
//! Thông báo lỗi **bắt đầu bằng một mã ổn định** rồi tới câu tiếng Việt cho người dùng.
//! `backend/app/core/mixed_nesting_service.py` tách mã đó để map sang HTTP status. Danh
//! sách mã phải khớp hai bên; có test parity ở `backend/tests/test_mixed_nesting_native.py`.
//!
//! | Mã | Nghĩa | HTTP |
//! |---|---|---|
//! | `MIXED_NESTING_BAD_JSON` | Không parse được JSON | 422 |
//! | `MIXED_NESTING_INVALID_REQUEST` | Sai hợp đồng dữ liệu | 422 |
//! | `MIXED_NESTING_INVALID_GEOMETRY` | Contour không dùng được | 422 |
//! | `MIXED_NESTING_CANCELLED` | Bị hủy trước khi có phương án | 409 |
//! | `MIXED_NESTING_ENGINE_ERROR` | Lỗi engine, kể cả panic | 500 |

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;

use imposition_core::mixed_nesting::baseline::BaselineAnglePolicy;
use imposition_core::mixed_nesting::control::{
    CancelToken, JobPhase, ProgressChannel, ProgressMessageCode, RunControl, SearchEffort,
};
use imposition_core::mixed_nesting::model::{
    MixedNestingRequest, PlacementManifest, ValidationSummary, MIXED_NESTING_ENGINE_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION,
};
use imposition_core::mixed_nesting::multi_start::{solve, SolveError};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizeFailure};
use imposition_core::mixed_nesting::solver::TrialError;

/// Mã lỗi trả về Python. Đổi các chuỗi này là breaking change với sidecar.
mod codes {
    pub const BAD_JSON: &str = "MIXED_NESTING_BAD_JSON";
    pub const INVALID_REQUEST: &str = "MIXED_NESTING_INVALID_REQUEST";
    pub const INVALID_GEOMETRY: &str = "MIXED_NESTING_INVALID_GEOMETRY";
    pub const CANCELLED: &str = "MIXED_NESTING_CANCELLED";
    pub const ENGINE_ERROR: &str = "MIXED_NESTING_ENGINE_ERROR";
}

/// Một vòng chạy lồng ghép. Sidecar giữ đối tượng này để đọc progress và để hủy.
///
/// `cancel` và `progress` dùng `Arc` nên chia sẻ được giữa thread gọi `solve()` và
/// thread đang phục vụ endpoint Status — đó là lý do Status vẫn trả lời khi solver
/// đang chiếm hết CPU.
#[pyclass]
pub struct MixedNestingRun {
    cancel: CancelToken,
    progress: Arc<ProgressChannel>,
}

impl Default for MixedNestingRun {
    fn default() -> Self {
        Self::new()
    }
}

#[pymethods]
impl MixedNestingRun {
    #[new]
    pub fn new() -> Self {
        Self {
            cancel: CancelToken::new(),
            progress: Arc::new(ProgressChannel::new()),
        }
    }

    /// Phiên bản protocol và engine mà bản native này thực thi.
    ///
    /// Sidecar dùng để phát hiện **wheel cũ**: nếu số không khớp thì phải báo
    /// `503 ENGINE_UNAVAILABLE` chứ không được chạy với hợp đồng lệch.
    #[staticmethod]
    pub fn capabilities() -> PyResult<String> {
        let payload = serde_json::json!({
            "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
            "engineVersion": MIXED_NESTING_ENGINE_VERSION,
            "reflection": "forbidden",
            "defaultRotation": "free",
            "continuousTranslation": true,
            "profiles": ["fast", "balanced", "tight"],
        });
        serde_json::to_string(&payload)
            .map_err(|error| engine_error(&format!("không dựng được capabilities: {error}")))
    }

    /// Chạy một lần lồng ghép. Trả JSON placement manifest.
    ///
    /// **Nhả GIL** trong toàn bộ thời gian tính, nên Python thread khác vẫn chạy được để
    /// phục vụ Status và Cancel.
    pub fn solve(&self, py: Python<'_>, request_json: &str) -> PyResult<String> {
        // Parse và validate **trước khi** nhả GIL: hai bước này rẻ, và làm sớm thì lỗi
        // dữ liệu trả về ngay thay vì chiếm một slot việc nặng.
        let request: MixedNestingRequest = serde_json::from_str(request_json).map_err(|error| {
            PyValueError::new_err(format!(
                "{}: Dữ liệu lệnh không đọc được — {error}",
                codes::BAD_JSON
            ))
        })?;

        self.progress.set_phase(JobPhase::Normalizing);
        self.progress
            .set_message(ProgressMessageCode::NormalizingContours);
        self.progress.set_progress(0.02);

        let normalized = match normalize_request(&request) {
            Ok(value) => value,
            Err(failure) => {
                self.progress.set_phase(JobPhase::Failed);
                return Err(map_normalize_failure(&failure));
            }
        };

        let effort = SearchEffort::for_profile(normalized.profile);
        let stop = effort.stop_criterion(normalized.time_budget_ms);
        let control = RunControl::new(stop, self.cancel.clone(), Arc::clone(&self.progress));

        self.progress.set_phase(JobPhase::Baseline);
        self.progress
            .set_message(ProgressMessageCode::BaselineLayout);
        self.progress.set_progress(0.05);

        // ── Nhả GIL: đây là điều kiện gate của P5 ──
        let outcome = py.detach(|| {
            // `catch_unwind` để một panic trong engine không làm chết sidecar (§16.2).
            catch_unwind(AssertUnwindSafe(|| {
                let result = solve(
                    &normalized,
                    effort,
                    &control,
                    BaselineAnglePolicy::FirstAllowed,
                );
                // Đặt pha validating ngay sau khi solver xong, trước khi dựng manifest.
                control.progress().set_phase(JobPhase::Validating);
                control
                    .progress()
                    .set_message(ProgressMessageCode::ValidatingLayout);
                control.progress().set_progress(0.95);
                result
            }))
        });

        let outcome = match outcome {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                self.progress.set_phase(JobPhase::Failed);
                return Err(map_solve_error(&error));
            }
            Err(_) => {
                self.progress.set_phase(JobPhase::Failed);
                return Err(engine_error(
                    "Engine lồng ghép gặp lỗi nội bộ — hãy thử lại hoặc giản lược nét cắt.",
                ));
            }
        };

        // `jobId` là server-owned: engine chỉ echo lại đúng thứ sidecar đã gắn.
        let job_id = request.job_id.clone().unwrap_or_default();
        let manifest = PlacementManifest {
            protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
            engine_version: MIXED_NESTING_ENGINE_VERSION.to_string(),
            job_id,
            seed: normalized.seed,
            status: outcome.status,
            placements: outcome.placements,
            unplaced: outcome.unplaced,
            stats: outcome.stats,
            validation: ValidationSummary {
                valid: outcome.validation.valid,
                validator_version: outcome.validation.validator_version,
            },
        };

        let encoded = serde_json::to_string(&manifest)
            .map_err(|error| engine_error(&format!("không dựng được manifest: {error}")))?;

        self.progress.set_phase(match manifest.status {
            imposition_core::mixed_nesting::model::ManifestStatus::Completed => JobPhase::Completed,
            imposition_core::mixed_nesting::model::ManifestStatus::Cancelled => JobPhase::Cancelled,
            imposition_core::mixed_nesting::model::ManifestStatus::Failed => JobPhase::Failed,
        });
        self.progress.set_message(ProgressMessageCode::Finished);
        self.progress.set_progress(1.0);
        Ok(encoded)
    }

    /// Ảnh chụp tiến độ dạng JSON. Rẻ và không chặn: chỉ đọc mấy atomic.
    #[pyo3(name = "progress")]
    pub fn progress_snapshot(&self) -> PyResult<String> {
        let snapshot = self.progress.snapshot();
        serde_json::to_string(&snapshot)
            .map_err(|error| engine_error(&format!("không dựng được progress: {error}")))
    }

    /// Yêu cầu hủy. **Idempotent**: gọi nhiều lần hoặc gọi sau khi đã xong đều vô hại.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// [PYO3-TEST-FIX 2026-08-26] Tách "dựng chuỗi" khỏi "bọc PyErr".
//
// Vì sao phải tách, đừng gộp lại:
// - `native` khai `pyo3` với feature `extension-module`, nên test binary **không**
//   link `pythonXY.lib`. Không có libpython thì không dựng được interpreter trong
//   test — thêm `auto-initialize` cũng vô ích.
// - `PyErr::new_err` là lazy nên tạo được PyErr mà chưa cần interpreter, nhưng
//   `PyErr::to_string()` thì phải gọi vào interpreter để format exception ⇒ panic
//   "The Python interpreter is not initialized" dưới `cargo test`.
// - Nên hợp đồng mã lỗi được kiểm qua các hàm `*_message` / `*_parts` trả chuỗi và
//   enum Rust thuần; lớp `map_*` chỉ còn việc bọc đúng loại exception.
// ─────────────────────────────────────────────────────────────────────────────

/// Chuỗi thông điệp cho lỗi engine. Kiểm được mà không cần interpreter.
fn engine_error_message(message: &str) -> String {
    format!("{}: {message}", codes::ENGINE_ERROR)
}

fn engine_error(message: &str) -> PyErr {
    PyRuntimeError::new_err(engine_error_message(message))
}

/// Chuỗi thông điệp cho hai lớp thất bại của `normalize_request`.
///
/// Cả hai nhánh đều map sang `PyValueError`, nên chỉ cần chuỗi là đủ để khoá hợp đồng.
fn normalize_failure_message(failure: &NormalizeFailure) -> String {
    match failure {
        NormalizeFailure::Contract(errors) => format!(
            "{}: {} | {errors}",
            codes::INVALID_REQUEST,
            errors
                .items()
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ),
        NormalizeFailure::Geometry(errors) => format!(
            "{}: {} | {}",
            codes::INVALID_GEOMETRY,
            errors
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>()
                .join(","),
            errors
                .iter()
                .map(|item| item.message.clone())
                .collect::<Vec<_>>()
                .join("; "),
        ),
    }
}

/// Hai lớp thất bại của `normalize_request` được giữ tách bạch tới tận Python.
fn map_normalize_failure(failure: &NormalizeFailure) -> PyErr {
    PyValueError::new_err(normalize_failure_message(failure))
}

/// Loại exception Python mà một `SolveError` phải trở thành.
///
/// Tách ra thành enum để test khoá được **cả loại exception**, không chỉ chuỗi —
/// `PyErr::get_type()` cũng cần interpreter nên không dùng được trong `cargo test`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SolveErrorKind {
    /// `PyValueError` — dữ liệu/hình học sai, sidecar map sang 422.
    Value,
    /// `PyRuntimeError` — hủy giữa đường hoặc lỗi engine, sidecar map sang 409/500.
    Runtime,
}

/// Loại exception + chuỗi thông điệp cho một `SolveError`.
fn solve_error_parts(error: &SolveError) -> (SolveErrorKind, String) {
    match error {
        SolveError::InterruptedBeforeAnyResult(interrupt) => (
            SolveErrorKind::Runtime,
            format!(
                "{}: {}",
                codes::CANCELLED,
                interrupt.message_code().message_vi()
            ),
        ),
        SolveError::BaselineInvalid => (
            SolveErrorKind::Runtime,
            engine_error_message(
                "Phương án nền không qua kiểm tra — engine từ chối công bố layout chưa kiểm.",
            ),
        ),
        SolveError::Geometry(TrialError::Nfp(inner)) => (
            SolveErrorKind::Value,
            format!(
                "{}: {} | {}",
                codes::INVALID_GEOMETRY,
                inner.code(),
                inner.message_vi()
            ),
        ),
    }
}

fn map_solve_error(error: &SolveError) -> PyErr {
    let (kind, message) = solve_error_parts(error);
    match kind {
        SolveErrorKind::Value => PyValueError::new_err(message),
        SolveErrorKind::Runtime => PyRuntimeError::new_err(message),
    }
}

#[cfg(test)]
mod tests {
    //! Test Rust-side của binding.
    //!
    //! Đặt trong file này dưới `#[cfg(test)]` theo đúng ghi chú P5 của kế hoạch: crate
    //! `native` là `cdylib`, không được thêm `rlib` hay `native/tests` chỉ để chạy test.
    //!
    //! **[PYO3-TEST-FIX 2026-08-26] Test ở đây KHÔNG ĐƯỢC gọi bất kỳ API nào cần
    //! interpreter.** Crate là `cdylib` build với feature `extension-module`, nên test
    //! binary không link libpython và không có cách nào dựng interpreter — kể cả bật
    //! `auto-initialize`. Cụ thể, tránh: dựng `Python<'_>`, `PyErr::to_string()` /
    //! `Display` trên `PyErr`, `PyErr::get_type()`, `PyErr::value()`. Muốn kiểm hợp đồng
    //! lỗi thì dùng `normalize_failure_message` / `solve_error_parts` / `engine_error_message`.
    //! Phần cần interpreter thật nằm ở `backend/tests/test_mixed_nesting_native.py`.

    use super::*;
    use imposition_core::mixed_nesting::control::Interrupt;
    use imposition_core::mixed_nesting::model::{ContractError, ContractErrorCode, ContractErrors};
    use imposition_core::mixed_nesting::nfp::NfpError;

    #[test]
    fn capabilities_ghi_dung_hop_dong() {
        let json = MixedNestingRun::capabilities().expect("phải dựng được");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["protocolVersion"], MIXED_NESTING_PROTOCOL_VERSION);
        assert_eq!(value["engineVersion"], MIXED_NESTING_ENGINE_VERSION);
        // Ba điều không được đổi nếu không tăng protocol version.
        assert_eq!(value["reflection"], "forbidden");
        assert_eq!(value["defaultRotation"], "free");
        assert_eq!(value["continuousTranslation"], true);
    }

    #[test]
    fn cancel_idempotent_va_chia_se_duoc() {
        let run = MixedNestingRun::new();
        assert!(!run.is_cancelled());
        run.cancel();
        assert!(run.is_cancelled());
        // Gọi lại vô hại.
        run.cancel();
        run.cancel();
        assert!(run.is_cancelled());
    }

    #[test]
    fn progress_doc_duoc_ngay_khi_chua_chay() {
        let run = MixedNestingRun::new();
        let json = run.progress_snapshot().expect("phải dựng được");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["phase"], "queued");
        assert_eq!(value["progress"], 0.0);
        assert!(value["bestSheetCount"].is_null());
    }

    #[test]
    fn ma_loi_on_dinh_va_khac_nhau() {
        // Đây là hợp đồng với sidecar: đổi chuỗi là breaking change.
        assert_eq!(codes::BAD_JSON, "MIXED_NESTING_BAD_JSON");
        assert_eq!(codes::INVALID_REQUEST, "MIXED_NESTING_INVALID_REQUEST");
        assert_eq!(codes::INVALID_GEOMETRY, "MIXED_NESTING_INVALID_GEOMETRY");
        assert_eq!(codes::CANCELLED, "MIXED_NESTING_CANCELLED");
        assert_eq!(codes::ENGINE_ERROR, "MIXED_NESTING_ENGINE_ERROR");
    }

    #[test]
    fn map_loi_hop_dong_giu_ma_may_doc_duoc() {
        let mut errors = ContractErrors::default();
        errors.push(ContractError::new(
            ContractErrorCode::ProtocolVersionUnsupported,
            "protocolVersion",
            "Phiên bản protocol không hỗ trợ.".to_string(),
        ));
        // Kiểm trên chuỗi thuần: `map_normalize_failure(..).to_string()` cần interpreter.
        let text = normalize_failure_message(&NormalizeFailure::Contract(errors));
        assert!(text.contains(codes::INVALID_REQUEST), "{text}");
        assert!(text.contains("PROTOCOL_VERSION_UNSUPPORTED"), "{text}");
    }

    #[test]
    fn map_loi_hinh_hoc_va_loi_huy_khac_lop_nhau() {
        let (geo_kind, geo) = solve_error_parts(&SolveError::Geometry(TrialError::Nfp(
            NfpError::DecompositionFailed,
        )));
        assert!(geo.contains(codes::INVALID_GEOMETRY), "{geo}");
        assert!(geo.contains("NFP_DECOMPOSITION_FAILED"), "{geo}");
        // Lỗi hình học phải là ValueError ⇒ sidecar map 422.
        assert_eq!(geo_kind, SolveErrorKind::Value);

        let (cancelled_kind, cancelled) = solve_error_parts(
            &SolveError::InterruptedBeforeAnyResult(Interrupt::Cancelled),
        );
        assert!(cancelled.contains(codes::CANCELLED), "{cancelled}");
        // Hủy phải là RuntimeError ⇒ sidecar map 409.
        assert_eq!(cancelled_kind, SolveErrorKind::Runtime);

        let (engine_kind, engine) = solve_error_parts(&SolveError::BaselineInvalid);
        assert!(engine.contains(codes::ENGINE_ERROR), "{engine}");
        // Lỗi engine phải là RuntimeError ⇒ sidecar map 500.
        assert_eq!(engine_kind, SolveErrorKind::Runtime);
    }

    #[test]
    fn khong_import_solver_cu() {
        // Chốt cứng: binding mới không được nối vào đường bình bài hiện có.
        let source = include_str!("mixed_nesting_py.rs");
        for line in source.lines() {
            let code = line.trim_start();
            if code.starts_with("//") || !code.starts_with("use ") {
                continue;
            }
            for forbidden in [
                "nfp_solver",
                "crate::imposition",
                "dieline_engine",
                "imposition_core::nfp",
                "imposition_core::sticker",
                "imposition_core::shape",
                "imposition_core::orchestrator",
                "imposition_core::grid",
            ] {
                assert!(
                    !code.contains(forbidden),
                    "binding không được import '{forbidden}': {code}"
                );
            }
        }
    }
}
