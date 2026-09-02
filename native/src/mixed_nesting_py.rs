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
//! | `MIXED_NESTING_MANIFEST_MISMATCH` | Manifest production không qua kiểm định độc lập | 500 |

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;

use imposition_core::mixed_nesting::baseline::{BaselineAnglePolicy, BASELINE_VERSION};
use imposition_core::mixed_nesting::candidates::CANDIDATE_RULE_VERSION;
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, JobPhase, NativeBoundaryTimings, ProgressChannel, ProgressMessageCode,
    RunControl, SearchEffort,
};
use imposition_core::mixed_nesting::model::{
    LayoutIntent, ManifestAlgorithmVersions, ManifestCandidateSource, ManifestScore,
    ManifestSearchBudget, ManifestSearchSummary, ManifestStatus, MixedNestingRequest,
    PlacementManifest, TerminationReason, ValidationSummary,
    MIXED_NESTING_CANONICALIZATION_VERSION, MIXED_NESTING_ENGINE_VERSION,
    MIXED_NESTING_MANIFEST_SCHEMA_VERSION, MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION, MIXED_NESTING_TOLERANCE_VERSION,
    MIXED_NESTING_VALIDATOR_VERSION,
};
use imposition_core::mixed_nesting::multi_start::{
    solve, PortfolioExecutionDiagnostics, SolutionSource, SolveError, SolveOutcome,
    MULTI_START_VERSION,
};
use imposition_core::mixed_nesting::normalize::{
    normalize_request, NormalizeFailure, NormalizedRequest, NORMALIZE_RULE_VERSION,
    REFERENCE_POINT_RULE_VERSION,
};
use imposition_core::mixed_nesting::score::{score_layout, LayoutScore, SCORE_VERSION};
use imposition_core::mixed_nesting::solver::{TrialError, SOLVER_VERSION};
use imposition_core::mixed_nesting::validator::{validate_layout, LayoutUnderReview};
use imposition_core::mixed_nesting::{KERNEL_VERSION, NFP_RULE_VERSION, REFINE_RULE_VERSION};

/// Mã lỗi trả về Python. Đổi các chuỗi này là breaking change với sidecar.
mod codes {
    pub const BAD_JSON: &str = "MIXED_NESTING_BAD_JSON";
    pub const INVALID_REQUEST: &str = "MIXED_NESTING_INVALID_REQUEST";
    pub const INVALID_GEOMETRY: &str = "MIXED_NESTING_INVALID_GEOMETRY";
    pub const CANCELLED: &str = "MIXED_NESTING_CANCELLED";
    pub const ENGINE_ERROR: &str = "MIXED_NESTING_ENGINE_ERROR";
    pub const MANIFEST_MISMATCH: &str = "MIXED_NESTING_MANIFEST_MISMATCH";
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
    /// Grant từ admission backend và telemetry thực của portfolio.
    runtime_worker_grant: AtomicU64,
    runtime_trial_capacity: AtomicU64,
    runtime_nfp_cache_max_bytes_per_trial: AtomicU64,
    runtime_portfolio_execution_ready: AtomicBool,
    runtime_portfolio_planned_trials: AtomicU64,
    runtime_portfolio_dispatched_trials: AtomicU64,
    runtime_portfolio_completed_trials: AtomicU64,
    runtime_portfolio_interrupted_trials: AtomicU64,
    runtime_portfolio_rejected_trials: AtomicU64,
    runtime_portfolio_concurrency_limit: AtomicU64,
    runtime_portfolio_waves_dispatched: AtomicU64,
    runtime_portfolio_max_dispatched_wave_width: AtomicU64,
}

impl Default for MixedNestingRun {
    fn default() -> Self {
        Self::new()
    }
}

impl MixedNestingRun {
    /// Xoá publication fence trước mỗi solve. Payload cũ có thể còn trong atomic nhưng
    /// snapshot phải trả `null` cho tới khi lượt mới đã chốt đủ mọi counter.
    fn reset_portfolio_execution(&self) {
        self.runtime_portfolio_execution_ready
            .store(false, Ordering::Release);
    }

    /// Ghi payload trước, bật ready sau bằng Release. Reader dùng Acquire để không thể
    /// thấy một bộ counter nửa cũ nửa mới.
    fn record_portfolio_execution(&self, diagnostics: PortfolioExecutionDiagnostics) {
        self.runtime_portfolio_planned_trials
            .store(diagnostics.planned_trials, Ordering::Relaxed);
        self.runtime_portfolio_dispatched_trials
            .store(diagnostics.dispatched_trials, Ordering::Relaxed);
        self.runtime_portfolio_completed_trials
            .store(diagnostics.completed_trials, Ordering::Relaxed);
        self.runtime_portfolio_interrupted_trials
            .store(diagnostics.interrupted_trials, Ordering::Relaxed);
        self.runtime_portfolio_rejected_trials
            .store(diagnostics.rejected_trials, Ordering::Relaxed);
        self.runtime_portfolio_concurrency_limit
            .store(diagnostics.concurrency_limit, Ordering::Relaxed);
        self.runtime_portfolio_waves_dispatched
            .store(diagnostics.waves_dispatched, Ordering::Relaxed);
        self.runtime_portfolio_max_dispatched_wave_width
            .store(diagnostics.max_dispatched_wave_width, Ordering::Relaxed);
        self.runtime_portfolio_execution_ready
            .store(true, Ordering::Release);
    }

    fn portfolio_execution_snapshot(&self) -> Option<serde_json::Value> {
        self.runtime_portfolio_execution_ready
            .load(Ordering::Acquire)
            .then(|| {
                serde_json::json!({
                    "plannedTrials": self.runtime_portfolio_planned_trials.load(Ordering::Relaxed),
                    "dispatchedTrials": self.runtime_portfolio_dispatched_trials.load(Ordering::Relaxed),
                    "completedTrials": self.runtime_portfolio_completed_trials.load(Ordering::Relaxed),
                    "interruptedTrials": self.runtime_portfolio_interrupted_trials.load(Ordering::Relaxed),
                    "rejectedTrials": self.runtime_portfolio_rejected_trials.load(Ordering::Relaxed),
                    "concurrencyLimit": self.runtime_portfolio_concurrency_limit.load(Ordering::Relaxed),
                    "wavesDispatched": self.runtime_portfolio_waves_dispatched.load(Ordering::Relaxed),
                    "maxDispatchedWaveWidth": self
                        .runtime_portfolio_max_dispatched_wave_width
                        .load(Ordering::Relaxed),
                })
            })
    }

    /// Đánh dấu terminal cancel và trả lỗi máy đọc được. Dùng ở mọi chốt công bố để
    /// không có đường nào serialize/return manifest sau khi người dùng đã hủy.
    fn reject_cancelled(&self) -> PyResult<()> {
        if !self.cancel.is_cancelled() {
            return Ok(());
        }
        self.progress.set_phase(JobPhase::Cancelled);
        self.progress
            .set_message(ProgressMessageCode::CancelledByUser);
        self.progress.set_progress(1.0);
        Err(cancelled_error())
    }
}

#[pymethods]
impl MixedNestingRun {
    #[new]
    pub fn new() -> Self {
        Self {
            cancel: CancelToken::new(),
            progress: Arc::new(ProgressChannel::new()),
            runtime_worker_grant: AtomicU64::new(1),
            runtime_trial_capacity: AtomicU64::new(1),
            runtime_nfp_cache_max_bytes_per_trial: AtomicU64::new(0),
            runtime_portfolio_execution_ready: AtomicBool::new(false),
            runtime_portfolio_planned_trials: AtomicU64::new(0),
            runtime_portfolio_dispatched_trials: AtomicU64::new(0),
            runtime_portfolio_completed_trials: AtomicU64::new(0),
            runtime_portfolio_interrupted_trials: AtomicU64::new(0),
            runtime_portfolio_rejected_trials: AtomicU64::new(0),
            runtime_portfolio_concurrency_limit: AtomicU64::new(0),
            runtime_portfolio_waves_dispatched: AtomicU64::new(0),
            runtime_portfolio_max_dispatched_wave_width: AtomicU64::new(0),
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
            // NEST (audit 2026-08-27 §PROVENANCE.BUILD): sidecar phải biết chính
            // build đang chạy để từ chối manifest được tạo bởi một file .pyd khác.
            "nativeBuildIdentity": env!("PRYNX_EMBED_BUILD_IDENTITY"),
            "manifestSchemaVersion": MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
            "algorithmVersions": {
                "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
                "engineVersion": MIXED_NESTING_ENGINE_VERSION,
                "validatorVersion": MIXED_NESTING_VALIDATOR_VERSION,
                "toleranceVersion": MIXED_NESTING_TOLERANCE_VERSION,
                "canonicalizationVersion": MIXED_NESTING_CANONICALIZATION_VERSION,
                "productionSchemaVersion": MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
                "normalizeRuleVersion": NORMALIZE_RULE_VERSION,
                "referencePointRuleVersion": REFERENCE_POINT_RULE_VERSION,
                "kernelVersion": KERNEL_VERSION,
                "nfpRuleVersion": NFP_RULE_VERSION,
                "scoreVersion": SCORE_VERSION,
                "solverVersion": SOLVER_VERSION,
                "multiStartVersion": MULTI_START_VERSION,
                "baselineVersion": BASELINE_VERSION,
                "candidateRuleVersion": CANDIDATE_RULE_VERSION,
                "refineRuleVersion": REFINE_RULE_VERSION,
            },
            "reflection": "forbidden",
            "defaultRotation": "free",
            "continuousTranslation": true,
            "profiles": ["fast", "balanced", "tight"],
            "layoutIntents": [
                "quantity_fulfillment",
                "autofill_single_sheet",
                "step_repeat_single_sheet"
            ],
            // PERF (audit 2026-08-30 §NEST-NF-3): trial portfolio chạy scoped thread
            // theo grant thật; diagnostics hậu-solve cho biết mức song song đã dispatch.
            "runtimeControlVersion": 1,
            "portfolioParallelEnabled": true,
            "nfpColdMissParallelEnabled": true,
            "nfpCacheByteBudgetEnforced": true,
        });
        serde_json::to_string(&payload)
            .map_err(|error| engine_error(&format!("không dựng được capabilities: {error}")))
    }

    /// Kiểm định lại placement manifest production từ request gốc mà **không solve lại**.
    ///
    /// Persist/load gọi đường này để chứng minh layout vẫn qua đúng final validator của
    /// native build hiện hành. Dữ liệu được sở hữu trước khi nhả GIL; phần Rust thuần
    /// không gọi Python, PDFium hay solver.
    #[staticmethod]
    pub fn validate_manifest(
        py: Python<'_>,
        request_json: &str,
        manifest_json: &str,
    ) -> PyResult<()> {
        let request_json = request_json.to_owned();
        let manifest_json = manifest_json.to_owned();
        let outcome = py.detach(move || {
            catch_unwind(AssertUnwindSafe(|| {
                validate_manifest_payloads(&request_json, &manifest_json)
            }))
        });

        match outcome {
            Ok(Ok(())) => Ok(()),
            Ok(Err(reason)) => Err(manifest_mismatch_error(&reason)),
            Err(_) => Err(manifest_mismatch_error(
                "Final validator gặp lỗi nội bộ khi kiểm placement manifest.",
            )),
        }
    }

    /// Chạy một lần lồng ghép. Trả JSON placement manifest.
    ///
    /// **Nhả GIL** trong toàn bộ thời gian tính, nên Python thread khác vẫn chạy được để
    /// phục vụ Status và Cancel.
    #[pyo3(signature = (
        request_json,
        worker_grant = 1,
        nfp_cache_max_bytes_per_trial = None
    ))]
    pub fn solve(
        &self,
        py: Python<'_>,
        request_json: &str,
        worker_grant: u32,
        nfp_cache_max_bytes_per_trial: Option<u64>,
    ) -> PyResult<String> {
        let native_started = std::time::Instant::now();
        self.reset_portfolio_execution();
        self.reject_cancelled()?;
        if worker_grant == 0 {
            self.progress.set_phase(JobPhase::Failed);
            return Err(PyValueError::new_err(format!(
                "{}: worker_grant phải lớn hơn 0.",
                codes::INVALID_REQUEST
            )));
        }
        if nfp_cache_max_bytes_per_trial == Some(0) {
            self.progress.set_phase(JobPhase::Failed);
            return Err(PyValueError::new_err(format!(
                "{}: nfp_cache_max_bytes_per_trial phải lớn hơn 0 khi được truyền.",
                codes::INVALID_REQUEST
            )));
        }
        self.runtime_worker_grant
            .store(u64::from(worker_grant), Ordering::Relaxed);
        self.runtime_nfp_cache_max_bytes_per_trial.store(
            nfp_cache_max_bytes_per_trial.unwrap_or(0),
            Ordering::Relaxed,
        );
        // Parse và validate **trước khi** nhả GIL: hai bước này rẻ, và làm sớm thì lỗi
        // dữ liệu trả về ngay thay vì chiếm một slot việc nặng.
        let request: MixedNestingRequest = serde_json::from_str(request_json).map_err(|error| {
            PyValueError::new_err(format!(
                "{}: Dữ liệu lệnh không đọc được — {error}",
                codes::BAD_JSON
            ))
        })?;
        if let Err(errors) = request.validate_server_owned_fields() {
            self.progress.set_phase(JobPhase::Failed);
            return Err(map_normalize_failure(&NormalizeFailure::Contract(errors)));
        }

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
        self.reject_cancelled()?;

        let effort = SearchEffort::for_profile(normalized.profile);
        self.runtime_trial_capacity.store(
            u64::from(worker_grant.min(effort.trial_count)),
            Ordering::Relaxed,
        );
        let stop = effort.stop_criterion(normalized.time_budget_ms);
        let control = RunControl::new_with_nfp_resources(
            stop,
            self.cancel.clone(),
            Arc::clone(&self.progress),
            worker_grant as usize,
            nfp_cache_max_bytes_per_trial.unwrap_or(u64::MAX),
        );
        let request_preparation_ms = native_started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;

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
                result
            }))
        });

        let outcome = match outcome {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                // Publication fence terminal: cancel đến sau fence cuối của core nhưng
                // trước khi native map capacity/geometry vẫn phải thắng.
                self.reject_cancelled()?;
                if solve_error_is_cancelled(&error) {
                    self.progress.set_phase(JobPhase::Cancelled);
                    self.progress
                        .set_message(ProgressMessageCode::CancelledByUser);
                    self.progress.set_progress(1.0);
                } else {
                    self.progress.set_phase(JobPhase::Failed);
                }
                return Err(map_solve_error(&error));
            }
            Err(_) => {
                // Panic cũng không được che yêu cầu hủy vừa đến.
                self.reject_cancelled()?;
                self.progress.set_phase(JobPhase::Failed);
                return Err(engine_error(
                    "Engine lồng ghép gặp lỗi nội bộ — hãy thử lại hoặc giản lược nét cắt.",
                ));
            }
        };
        self.reject_cancelled()?;

        // PERF (audit 2026-08-30 §NEST-D0-B): công bố telemetry qua progress
        // trước khi `build_manifest` move outcome. Không nhét dữ liệu runtime vào
        // placement manifest nên fingerprint/schema sản xuất giữ nguyên.
        self.progress.record_phase_timings(outcome.phase_timings);
        self.record_portfolio_execution(outcome.portfolio_execution);
        let manifest_started = std::time::Instant::now();
        let manifest = build_manifest(&request, &normalized, effort, outcome);

        // Hai chốt quanh serialize là chủ đích: cancel không được trả manifest, kể cả
        // khi nó đến sau final validator nhưng trước lúc chuỗi JSON rời native.
        self.reject_cancelled()?;
        let encoded = serde_json::to_string(&manifest)
            .map_err(|error| engine_error(&format!("không dựng được manifest: {error}")))?;
        self.reject_cancelled()?;
        self.progress
            .record_native_boundary_timings(NativeBoundaryTimings {
                request_preparation_ms,
                manifest_serialization_ms: manifest_started
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
                native_total_ms: native_started
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            });

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
        let cache_max_bytes = self
            .runtime_nfp_cache_max_bytes_per_trial
            .load(Ordering::Relaxed);
        let cache_max_bytes = (cache_max_bytes > 0).then_some(cache_max_bytes);
        let portfolio_execution = self.portfolio_execution_snapshot();
        let mut payload = serde_json::to_value(&snapshot)
            .map_err(|error| engine_error(&format!("không dựng được progress: {error}")))?;
        if let Some(object) = payload.as_object_mut() {
            object.insert(
                "runtimeControl".to_string(),
                serde_json::json!({
                    "workerGrant": self.runtime_worker_grant.load(Ordering::Relaxed),
                    "trialCapacity": self.runtime_trial_capacity.load(Ordering::Relaxed),
                    // Grant là tổng compute budget; `portfolioExecution` mới là bằng
                    // chứng trial nào thực sự được dispatch theo wave trong lượt này.
                    "maxConcurrentComputeWorkers": self
                        .runtime_worker_grant
                        .load(Ordering::Relaxed),
                    "portfolioParallelEnabled": true,
                    "portfolioExecution": portfolio_execution,
                    "nfpColdMissParallelEnabled": true,
                    "nfpCacheMaxBytesPerTrial": cache_max_bytes,
                    "nfpCacheByteBudgetEnforced": true,
                }),
            );
        }
        serde_json::to_string(&payload)
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

/// Rút gọn điểm nội bộ vào manifest mà không nhân đôi tie-break có thể dựng lại từ
/// placements. Giữ nguyên integer fixed-point để provenance không phụ thuộc float JSON.
fn manifest_score(score: &LayoutScore) -> ManifestScore {
    ManifestScore {
        invalid_count: score.invalid_count,
        primary_penalty: score.unplaced_count,
        sheet_count: score.sheet_count,
        last_sheet_used_area_fixed: score.last_sheet_used_area_fixed,
        wasted_within_envelope_fixed: score.wasted_within_envelope_fixed,
        score_version: score.score_version,
    }
}

/// Khoá provenance rút gọn của score. Manifest không lưu tie-break placements của
/// baseline, nên re-validator chỉ được chứng minh năm tiêu chí đã công bố; tuyệt đối
/// không solve lại để cố tái tạo baseline.
fn manifest_score_summary_key(score: &ManifestScore) -> (u64, u64, u32, i64, i64) {
    (
        score.invalid_count,
        score.primary_penalty,
        score.sheet_count,
        score.last_sheet_used_area_fixed,
        score.wasted_within_envelope_fixed,
    )
}

fn manifest_candidate(source: SolutionSource) -> ManifestCandidateSource {
    match source {
        SolutionSource::Baseline => ManifestCandidateSource::Baseline,
        SolutionSource::Trial { trial_id } => ManifestCandidateSource::SmartTrial { trial_id },
    }
}

/// Dựng manifest terminal từ đúng request đã normalize và outcome đã qua final validator.
/// Hàm Rust thuần để unit test được mà không cần khởi tạo Python interpreter.
fn build_manifest(
    request: &MixedNestingRequest,
    normalized: &NormalizedRequest,
    effort: SearchEffort,
    outcome: SolveOutcome,
) -> PlacementManifest {
    let job_id = request.job_id.clone().unwrap_or_default();
    let production = request.production_contract.as_ref();
    PlacementManifest {
        schema_version: MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
        manifest_id: job_id.clone(),
        protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
        engine_version: MIXED_NESTING_ENGINE_VERSION.to_string(),
        job_id,
        request_revision: production.map(|contract| contract.request_revision),
        input_hash: production.map(|contract| contract.input_hash.clone()),
        layout_fingerprint: production.map(|contract| contract.layout_fingerprint.clone()),
        layout_intent: normalized.layout_intent,
        seed: normalized.seed,
        status: outcome.status,
        provenance: ManifestAlgorithmVersions {
            native_build_identity: env!("PRYNX_EMBED_BUILD_IDENTITY").to_string(),
            production_schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
            tolerance_version: MIXED_NESTING_TOLERANCE_VERSION,
            canonicalization_version: MIXED_NESTING_CANONICALIZATION_VERSION,
            normalize_rule_version: NORMALIZE_RULE_VERSION,
            reference_point_rule_version: REFERENCE_POINT_RULE_VERSION,
            kernel_version: KERNEL_VERSION,
            nfp_rule_version: NFP_RULE_VERSION,
            score_version: SCORE_VERSION,
            solver_version: SOLVER_VERSION,
            multi_start_version: MULTI_START_VERSION,
            baseline_version: BASELINE_VERSION,
            candidate_rule_version: CANDIDATE_RULE_VERSION,
            refine_rule_version: REFINE_RULE_VERSION,
        },
        search: ManifestSearchSummary {
            budget: ManifestSearchBudget {
                trial_count: effort.trial_count,
                orientation_proposals_per_part: effort.orientation_proposals_per_part,
                beam_width: effort.beam_width,
                refinement_rounds: effort.refinement_rounds,
                multi_start_restarts: effort.multi_start_restarts,
                evaluation_budget: effort.evaluation_budget,
                time_budget_ms: normalized.time_budget_ms,
            },
            trials_run: outcome.trials_run,
            trials_rejected: outcome.trials_rejected,
            selected_candidate: manifest_candidate(outcome.source),
            baseline_score: outcome.baseline_score.as_ref().map(manifest_score),
            selected_score: manifest_score(&outcome.selected_score),
        },
        placements: outcome.placements,
        unplaced: outcome.unplaced,
        stats: outcome.stats,
        validation: ValidationSummary {
            valid: outcome.validation.valid,
            validator_version: outcome.validation.validator_version,
        },
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
/// Kiểm định production thuần Rust. Hàm cố ý không nhận `Python`, progress hay cancel:
/// persist/load chỉ xác minh layout đã có, tuyệt đối không mở đường solve thứ hai.
fn validate_manifest_payloads(request_json: &str, manifest_json: &str) -> Result<(), String> {
    let request: MixedNestingRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("Request production không đúng schema: {error}"))?;
    request
        .validate_server_owned_fields()
        .map_err(|errors| format!("Field server-owned của request không hợp lệ: {errors}"))?;
    let normalized = normalize_request(&request).map_err(|failure| match failure {
        NormalizeFailure::Contract(errors) => {
            format!("Request production không qua contract: {errors}")
        }
        NormalizeFailure::Geometry(errors) => format!(
            "Hình học request production không chuẩn hoá được: {}",
            errors
                .iter()
                .map(|item| item.code.as_str())
                .collect::<Vec<_>>()
                .join(",")
        ),
    })?;
    let contract = request
        .production_contract
        .as_ref()
        .ok_or_else(|| "Request không có productionContract.".to_string())?;
    let job_id = request
        .job_id
        .as_deref()
        .ok_or_else(|| "Request không có jobId server-owned.".to_string())?;

    // `PlacementManifest` và mọi struct lồng nhau quan trọng đều dùng
    // `deny_unknown_fields`; field lạ không được bị serde bỏ qua im lặng.
    let manifest: PlacementManifest = serde_json::from_str(manifest_json)
        .map_err(|error| format!("Placement manifest không đúng schema: {error}"))?;

    if manifest.status != ManifestStatus::Completed {
        return Err("Placement manifest production không ở trạng thái completed.".to_string());
    }
    if manifest.schema_version != MIXED_NESTING_MANIFEST_SCHEMA_VERSION
        || manifest.protocol_version != MIXED_NESTING_PROTOCOL_VERSION
        || manifest.engine_version != MIXED_NESTING_ENGINE_VERSION
    {
        return Err("Phiên bản top-level của placement manifest không khớp native.".to_string());
    }
    if manifest.manifest_id != job_id
        || manifest.job_id != job_id
        || manifest.request_revision != Some(contract.request_revision)
        || manifest.input_hash.as_deref() != Some(contract.input_hash.as_str())
        || manifest.layout_fingerprint.as_deref() != Some(contract.layout_fingerprint.as_str())
        || manifest.layout_intent != normalized.layout_intent
        || manifest.seed != normalized.seed
    {
        return Err("Identity placement manifest không khớp request production.".to_string());
    }

    let provenance = &manifest.provenance;
    if provenance.native_build_identity != env!("PRYNX_EMBED_BUILD_IDENTITY")
        || provenance.production_schema_version != MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
        || provenance.tolerance_version != MIXED_NESTING_TOLERANCE_VERSION
        || provenance.canonicalization_version != MIXED_NESTING_CANONICALIZATION_VERSION
        || provenance.normalize_rule_version != NORMALIZE_RULE_VERSION
        || provenance.reference_point_rule_version != REFERENCE_POINT_RULE_VERSION
        || provenance.kernel_version != KERNEL_VERSION
        || provenance.nfp_rule_version != NFP_RULE_VERSION
        || provenance.score_version != SCORE_VERSION
        || provenance.solver_version != SOLVER_VERSION
        || provenance.multi_start_version != MULTI_START_VERSION
        || provenance.baseline_version != BASELINE_VERSION
        || provenance.candidate_rule_version != CANDIDATE_RULE_VERSION
        || provenance.refine_rule_version != REFINE_RULE_VERSION
    {
        return Err("Provenance thuật toán của placement manifest không khớp native.".to_string());
    }
    let budget = &manifest.search.budget;
    let expected_effort = SearchEffort::for_profile(normalized.profile);
    if budget.trial_count != expected_effort.trial_count
        || budget.orientation_proposals_per_part != expected_effort.orientation_proposals_per_part
        || budget.beam_width != expected_effort.beam_width
        || budget.refinement_rounds != expected_effort.refinement_rounds
        || budget.multi_start_restarts != expected_effort.multi_start_restarts
        || budget.evaluation_budget != expected_effort.evaluation_budget
        || budget.time_budget_ms != normalized.time_budget_ms
        || manifest.search.trials_rejected > manifest.search.trials_run
        || manifest.search.trials_run > expected_effort.trial_count
    {
        return Err("Ngân sách/tóm tắt tìm kiếm trong manifest không khớp request.".to_string());
    }

    // NEST (audit 2026-08-28 §MANIFEST.PROVENANCE): candidate phải trỏ tới đúng
    // work-plan đã thực thi. `trialId == trialsRun` chỉ có nghĩa ở checkpoint autofill
    // bị ngắt giữa trial; quantity tuyệt đối không được khai một trial chưa chạy.
    match manifest.search.selected_candidate {
        ManifestCandidateSource::Baseline => {
            if manifest.search.baseline_score.as_ref() != Some(&manifest.search.selected_score) {
                return Err(
                    "Candidate baseline không khớp baselineScore/selectedScore.".to_string()
                );
            }
        }
        ManifestCandidateSource::SmartTrial { trial_id } => {
            let interrupted_autofill_barrier = normalized.layout_intent
                == LayoutIntent::AutofillSingleSheet
                && matches!(
                    manifest.stats.termination_reason,
                    TerminationReason::Deadline | TerminationReason::WorkBudgetExhausted
                )
                && trial_id == u64::from(manifest.search.trials_run);
            if trial_id >= u64::from(budget.trial_count)
                || (trial_id >= u64::from(manifest.search.trials_run)
                    && !interrupted_autofill_barrier)
            {
                return Err(
                    "Candidate smart_trial không thuộc work-plan/trial đã chạy.".to_string()
                );
            }

            match manifest.search.baseline_score.as_ref() {
                None if normalized.layout_intent != LayoutIntent::AutofillSingleSheet => {
                    return Err(
                        "Candidate smart_trial của bình số lượng phải có baselineScore."
                            .to_string(),
                    );
                }
                Some(baseline)
                    if manifest_score_summary_key(&manifest.search.selected_score)
                        > manifest_score_summary_key(baseline) =>
                {
                    return Err(
                        "Tóm tắt selectedScore của smart_trial tệ hơn baselineScore.".to_string(),
                    );
                }
                _ => {}
            }
        }
    }

    let unplaced_count = u64::try_from(manifest.unplaced.len())
        .map_err(|_| "Số record chưa xếp vượt miền u64.".to_string())?;
    let recomputed_score = manifest_score(&score_layout(
        &normalized,
        &manifest.placements,
        unplaced_count,
    ));
    if manifest.search.selected_score != recomputed_score
        || manifest
            .search
            .baseline_score
            .as_ref()
            .is_some_and(|score| score.score_version != SCORE_VERSION)
    {
        return Err("Điểm số công bố trong placement manifest không khớp layout.".to_string());
    }

    let report = validate_layout(
        &normalized,
        &LayoutUnderReview {
            placements: &manifest.placements,
            unplaced: &manifest.unplaced,
            stats: Some(&manifest.stats),
        },
    );
    if !report.valid {
        return Err(format!(
            "Placement manifest không qua final validator: {}",
            report.codes().join(",")
        ));
    }
    if manifest.validation.valid != report.valid
        || manifest.validation.validator_version != report.validator_version
        || report.validator_version != MIXED_NESTING_VALIDATOR_VERSION
    {
        return Err(
            "Kết luận/version validator trong manifest không khớp kết quả tính lại.".to_string(),
        );
    }

    Ok(())
}

fn manifest_mismatch_error_message(message: &str) -> String {
    format!("{}: {message}", codes::MANIFEST_MISMATCH)
}

fn manifest_mismatch_error(message: &str) -> PyErr {
    PyRuntimeError::new_err(manifest_mismatch_error_message(message))
}

fn engine_error_message(message: &str) -> String {
    format!("{}: {message}", codes::ENGINE_ERROR)
}

fn engine_error(message: &str) -> PyErr {
    PyRuntimeError::new_err(engine_error_message(message))
}

fn cancelled_error_message() -> String {
    format!("{}: Đã hủy theo yêu cầu.", codes::CANCELLED)
}

fn cancelled_error() -> PyErr {
    PyRuntimeError::new_err(cancelled_error_message())
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

fn solve_error_is_cancelled(error: &SolveError) -> bool {
    matches!(
        error,
        SolveError::Cancelled | SolveError::InterruptedBeforeAnyResult(Interrupt::Cancelled)
    )
}

/// Loại exception + chuỗi thông điệp cho một `SolveError`.
fn solve_error_parts(error: &SolveError) -> (SolveErrorKind, String) {
    match error {
        SolveError::Cancelled | SolveError::InterruptedBeforeAnyResult(Interrupt::Cancelled) => {
            (SolveErrorKind::Runtime, cancelled_error_message())
        }
        SolveError::InterruptedBeforeAnyResult(interrupt) => (
            SolveErrorKind::Runtime,
            engine_error_message(&format!(
                "Engine bị ngắt trước khi có phương án: {}",
                interrupt.message_code().message_vi()
            )),
        ),
        SolveError::BaselineInvalid => (
            SolveErrorKind::Runtime,
            engine_error_message(
                "Phương án nền không qua kiểm tra — engine từ chối công bố layout chưa kiểm.",
            ),
        ),
        SolveError::CapacityInvariantExceeded
        | SolveError::Geometry(TrialError::CapacityInvariantExceeded) => (
            SolveErrorKind::Runtime,
            engine_error_message(
                "Solver vượt bất biến sức chứa — engine từ chối công bố layout không đầy đủ.",
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
    use imposition_core::mixed_nesting::model::{ContractError, ContractErrorCode, ContractErrors};
    use imposition_core::mixed_nesting::nfp::NfpError;
    /// Fixture production nhỏ nhất cho re-validator. Dựng thẳng request/manifest và
    /// tự tính score; không gọi baseline, multi-start hay solver.
    fn payloads_production_hop_le() -> (serde_json::Value, serde_json::Value) {
        let job_id = "0123456789abcdef0123456789abcdef";
        let input_hash = format!("sha256:{}", "a".repeat(64));
        let layout_fingerprint = format!("sha256:{}", "b".repeat(64));
        let request = serde_json::json!({
            "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
            "seed": 7,
            "profile": "fast",
            "sheet": {
                "widthMm": 100.0,
                "heightMm": 100.0,
                "marginMm": { "left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0 },
                "maxSheets": 1
            },
            "gapMm": 0.0,
            "orientationPolicy": {
                "defaultRotation": { "mode": "free" },
                "reflection": "forbidden"
            },
            "layoutIntent": "quantity_fulfillment",
            "parts": [{
                "partId": "part-a",
                "quantity": 1,
                "outer": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
                "holes": [],
                "rotationConstraint": { "mode": "inherit" },
                "referencePointMm": [0.0, 0.0],
                "geometryHash": "geometry-a",
                "sourceRevision": "source-a"
            }],
            "jobId": job_id,
            "productionContract": {
                "schemaVersion": MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
                "requestRevision": 1,
                "inputHash": input_hash,
                "layoutFingerprint": layout_fingerprint,
                "alignment": "center",
                "groupingIntent": "free_gang",
                "placementZones": [],
                "clearance": {
                    "partToPart": { "xMm": 0.0, "yMm": 0.0 },
                    "partToSheetEdge": { "xMm": 0.0, "yMm": 0.0 },
                    "partToObstacle": { "xMm": 0.0, "yMm": 0.0 }
                },
                "fixedObstacles": []
            }
        });
        let typed_request: MixedNestingRequest =
            serde_json::from_value(request.clone()).expect("request fixture phải parse được");
        let normalized = normalize_request(&typed_request).expect("request fixture phải hợp lệ");
        let placements = vec![imposition_core::mixed_nesting::model::PlacementRecord {
            instance_id: "part-a#0001".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: imposition_core::mixed_nesting::model::Pose::new(0.0, 10.0, 10.0),
            source_revision: Some("source-a".to_string()),
        }];
        let selected_score = manifest_score(&score_layout(&normalized, &placements, 0));
        let effort = SearchEffort::for_profile(typed_request.profile);
        let manifest = serde_json::json!({
            "schemaVersion": MIXED_NESTING_MANIFEST_SCHEMA_VERSION,
            "manifestId": job_id,
            "protocolVersion": MIXED_NESTING_PROTOCOL_VERSION,
            "engineVersion": MIXED_NESTING_ENGINE_VERSION,
            "jobId": job_id,
            "requestRevision": 1,
            "inputHash": format!("sha256:{}", "a".repeat(64)),
            "layoutFingerprint": format!("sha256:{}", "b".repeat(64)),
            "layoutIntent": "quantity_fulfillment",
            "seed": 7,
            "status": "completed",
            "provenance": {
                "nativeBuildIdentity": env!("PRYNX_EMBED_BUILD_IDENTITY"),
                "productionSchemaVersion": MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
                "toleranceVersion": MIXED_NESTING_TOLERANCE_VERSION,
                "canonicalizationVersion": MIXED_NESTING_CANONICALIZATION_VERSION,
                "normalizeRuleVersion": NORMALIZE_RULE_VERSION,
                "referencePointRuleVersion": REFERENCE_POINT_RULE_VERSION,
                "kernelVersion": KERNEL_VERSION,
                "nfpRuleVersion": NFP_RULE_VERSION,
                "scoreVersion": SCORE_VERSION,
                "solverVersion": SOLVER_VERSION,
                "multiStartVersion": MULTI_START_VERSION,
                "baselineVersion": BASELINE_VERSION,
                "candidateRuleVersion": CANDIDATE_RULE_VERSION,
                "refineRuleVersion": REFINE_RULE_VERSION
            },
            "search": {
                "budget": {
                    "trialCount": effort.trial_count,
                    "orientationProposalsPerPart": effort.orientation_proposals_per_part,
                    "beamWidth": effort.beam_width,
                    "refinementRounds": effort.refinement_rounds,
                    "multiStartRestarts": effort.multi_start_restarts,
                    "evaluationBudget": effort.evaluation_budget
                },
                "trialsRun": 0,
                "trialsRejected": 0,
                "selectedCandidate": { "kind": "baseline" },
                "baselineScore": selected_score,
                "selectedScore": selected_score
            },
            "placements": placements,
            "unplaced": [],
            "stats": {
                "sheetCount": 1,
                "placedCount": 1,
                "unplacedCount": 0,
                "materialUtilization": 0.01,
                "elapsedMs": 0,
                "attempts": 0,
                "orientationEvaluations": 0,
                "poseRefinements": 0,
                "terminationReason": "all_placed"
            },
            "validation": {
                "valid": true,
                "validatorVersion": MIXED_NESTING_VALIDATOR_VERSION
            }
        });
        (request, manifest)
    }

    fn validate_values(
        request: &serde_json::Value,
        manifest: &serde_json::Value,
    ) -> Result<(), String> {
        validate_manifest_payloads(
            &serde_json::to_string(request).unwrap(),
            &serde_json::to_string(manifest).unwrap(),
        )
    }

    #[test]
    fn revalidator_khong_solve_chap_nhan_manifest_hop_le() {
        let (request, manifest) = payloads_production_hop_le();
        validate_values(&request, &manifest).expect("layout hợp lệ phải qua re-validator");
    }

    #[test]
    fn revalidator_tu_choi_schema_status_claim_score_va_hinh_hoc_lech() {
        let (request, manifest) = payloads_production_hop_le();

        let mut cases = Vec::new();
        let mut unknown = manifest.clone();
        unknown["fieldLa"] = serde_json::json!(true);
        cases.push(unknown);
        let mut failed = manifest.clone();
        failed["status"] = serde_json::json!("failed");
        cases.push(failed);
        let mut validator = manifest.clone();
        validator["validation"]["validatorVersion"] =
            serde_json::json!(MIXED_NESTING_VALIDATOR_VERSION + 1);
        cases.push(validator);
        let mut score = manifest.clone();
        score["search"]["selectedScore"]["invalidCount"] = serde_json::json!(1);
        cases.push(score);
        let mut outside = manifest.clone();
        outside["placements"][0]["pose"]["translateXmm"] = serde_json::json!(95.0);
        cases.push(outside);

        for candidate in cases {
            assert!(validate_values(&request, &candidate).is_err());
        }

        let mut request_unknown = request.clone();
        request_unknown["fieldLa"] = serde_json::json!(true);
        assert!(validate_values(&request_unknown, &manifest).is_err());
    }

    #[test]
    fn revalidator_khoa_candidate_voi_trial_va_baseline_score() {
        let (request, manifest) = payloads_production_hop_le();
        let mut invalid = Vec::new();

        let mut baseline_missing = manifest.clone();
        baseline_missing["search"]
            .as_object_mut()
            .unwrap()
            .remove("baselineScore");
        invalid.push(baseline_missing);

        let mut baseline_mismatch = manifest.clone();
        baseline_mismatch["search"]["baselineScore"]["primaryPenalty"] = serde_json::json!(1);
        invalid.push(baseline_mismatch);

        let mut smart_outside_plan = manifest.clone();
        smart_outside_plan["search"]["trialsRun"] = serde_json::json!(1);
        smart_outside_plan["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 999 });
        invalid.push(smart_outside_plan);

        let mut smart_not_run = manifest.clone();
        smart_not_run["search"]["trialsRun"] = serde_json::json!(1);
        smart_not_run["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 1 });
        invalid.push(smart_not_run);

        let mut smart_worse_than_baseline = manifest.clone();
        smart_worse_than_baseline["search"]["trialsRun"] = serde_json::json!(1);
        smart_worse_than_baseline["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 0 });
        smart_worse_than_baseline["search"]["baselineScore"]["sheetCount"] = serde_json::json!(0);
        invalid.push(smart_worse_than_baseline);

        let mut quantity_smart_without_baseline = manifest.clone();
        quantity_smart_without_baseline["search"]["trialsRun"] = serde_json::json!(1);
        quantity_smart_without_baseline["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 0 });
        quantity_smart_without_baseline["search"]
            .as_object_mut()
            .unwrap()
            .remove("baselineScore");
        invalid.push(quantity_smart_without_baseline);

        for candidate in invalid {
            assert!(validate_values(&request, &candidate).is_err());
        }

        let mut smart_tie = manifest.clone();
        smart_tie["search"]["trialsRun"] = serde_json::json!(1);
        smart_tie["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 0 });
        validate_values(&request, &smart_tie)
            .expect("smart trial hòa summary với baseline phải được nhận");

        let (mut autofill_request, mut autofill_manifest) = payloads_production_hop_le();
        autofill_request["layoutIntent"] = serde_json::json!("autofill_single_sheet");
        autofill_request["parts"][0]
            .as_object_mut()
            .unwrap()
            .remove("quantity");
        autofill_manifest["layoutIntent"] = serde_json::json!("autofill_single_sheet");
        autofill_manifest["stats"]["terminationReason"] = serde_json::json!("deadline");
        autofill_manifest["search"]["trialsRun"] = serde_json::json!(0);
        autofill_manifest["search"]["selectedCandidate"] =
            serde_json::json!({ "kind": "smart_trial", "trialId": 0 });
        autofill_manifest["search"]
            .as_object_mut()
            .unwrap()
            .remove("baselineScore");

        let typed_request: MixedNestingRequest =
            serde_json::from_value(autofill_request.clone()).unwrap();
        let normalized = normalize_request(&typed_request).unwrap();
        let placements: Vec<imposition_core::mixed_nesting::model::PlacementRecord> =
            serde_json::from_value(autofill_manifest["placements"].clone()).unwrap();
        autofill_manifest["search"]["selectedScore"] =
            serde_json::to_value(manifest_score(&score_layout(&normalized, &placements, 0)))
                .unwrap();

        validate_values(&autofill_request, &autofill_manifest)
            .expect("checkpoint autofill bị ngắt được phép công bố best-so-far");
    }

    #[test]
    fn capabilities_ghi_dung_hop_dong() {
        let json = MixedNestingRun::capabilities().expect("phải dựng được");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["protocolVersion"], MIXED_NESTING_PROTOCOL_VERSION);
        assert_eq!(value["engineVersion"], MIXED_NESTING_ENGINE_VERSION);
        assert_eq!(
            value["manifestSchemaVersion"],
            MIXED_NESTING_MANIFEST_SCHEMA_VERSION
        );
        let build_identity = value["nativeBuildIdentity"]
            .as_str()
            .expect("phải công bố native build identity");
        assert_eq!(build_identity.len(), 64);
        assert!(build_identity
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        let versions = value["algorithmVersions"]
            .as_object()
            .expect("phải công bố version map production");
        assert_eq!(versions.len(), 16);
        assert_eq!(versions["solverVersion"], SOLVER_VERSION);
        assert_eq!(versions["baselineVersion"], BASELINE_VERSION);
        assert_eq!(
            versions["productionSchemaVersion"],
            MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
        );
        // Ba điều không được đổi nếu không tăng protocol version.
        assert_eq!(value["reflection"], "forbidden");
        assert_eq!(value["defaultRotation"], "free");
        assert_eq!(value["continuousTranslation"], true);
        assert_eq!(
            value["layoutIntents"],
            serde_json::json!([
                "quantity_fulfillment",
                "autofill_single_sheet",
                "step_repeat_single_sheet"
            ])
        );
        assert_eq!(value["runtimeControlVersion"], 1);
        assert_eq!(value["portfolioParallelEnabled"], true);
        assert_eq!(value["nfpColdMissParallelEnabled"], true);
        assert_eq!(value["nfpCacheByteBudgetEnforced"], true);
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
        assert_eq!(value["runtimeControl"]["workerGrant"], 1);
        assert_eq!(value["runtimeControl"]["trialCapacity"], 1);
        assert_eq!(value["runtimeControl"]["maxConcurrentComputeWorkers"], 1);
        assert_eq!(value["runtimeControl"]["portfolioParallelEnabled"], true);
        assert!(value["runtimeControl"]["portfolioExecution"].is_null());
        assert_eq!(value["runtimeControl"]["nfpColdMissParallelEnabled"], true);
        assert!(value["runtimeControl"]["nfpCacheMaxBytesPerTrial"].is_null());
        assert_eq!(value["runtimeControl"]["nfpCacheByteBudgetEnforced"], true);
    }

    #[test]
    fn portfolio_execution_chi_cong_bo_sau_ready_fence() {
        let run = MixedNestingRun::new();
        assert!(run.portfolio_execution_snapshot().is_none());

        run.record_portfolio_execution(PortfolioExecutionDiagnostics {
            planned_trials: 8,
            dispatched_trials: 6,
            completed_trials: 4,
            interrupted_trials: 2,
            rejected_trials: 1,
            concurrency_limit: 4,
            waves_dispatched: 2,
            max_dispatched_wave_width: 4,
        });

        let json = run.progress_snapshot().expect("phải dựng được");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value["runtimeControl"]["portfolioExecution"],
            serde_json::json!({
                "plannedTrials": 8,
                "dispatchedTrials": 6,
                "completedTrials": 4,
                "interruptedTrials": 2,
                "rejectedTrials": 1,
                "concurrencyLimit": 4,
                "wavesDispatched": 2,
                "maxDispatchedWaveWidth": 4,
            })
        );

        run.reset_portfolio_execution();
        assert!(run.portfolio_execution_snapshot().is_none());
    }

    #[test]
    fn ma_loi_on_dinh_va_khac_nhau() {
        // Đây là hợp đồng với sidecar: đổi chuỗi là breaking change.
        assert_eq!(codes::BAD_JSON, "MIXED_NESTING_BAD_JSON");
        assert_eq!(codes::INVALID_REQUEST, "MIXED_NESTING_INVALID_REQUEST");
        assert_eq!(codes::INVALID_GEOMETRY, "MIXED_NESTING_INVALID_GEOMETRY");
        assert_eq!(codes::CANCELLED, "MIXED_NESTING_CANCELLED");
        assert_eq!(codes::ENGINE_ERROR, "MIXED_NESTING_ENGINE_ERROR");
        assert_eq!(codes::MANIFEST_MISMATCH, "MIXED_NESTING_MANIFEST_MISMATCH");
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

        let (cancelled_kind, cancelled) = solve_error_parts(&SolveError::Cancelled);
        assert!(cancelled.contains(codes::CANCELLED), "{cancelled}");
        // Hủy phải là RuntimeError ⇒ sidecar map 409.
        assert_eq!(cancelled_kind, SolveErrorKind::Runtime);

        let (_, deadline) = solve_error_parts(&SolveError::InterruptedBeforeAnyResult(
            Interrupt::DeadlineReached,
        ));
        assert!(!deadline.contains(codes::CANCELLED), "{deadline}");

        let (engine_kind, engine) = solve_error_parts(&SolveError::BaselineInvalid);
        assert!(engine.contains(codes::ENGINE_ERROR), "{engine}");
        // Lỗi engine phải là RuntimeError ⇒ sidecar map 500.
        assert_eq!(engine_kind, SolveErrorKind::Runtime);

        let (capacity_kind, capacity) = solve_error_parts(&SolveError::CapacityInvariantExceeded);
        assert!(capacity.contains(codes::ENGINE_ERROR), "{capacity}");
        assert!(!capacity.contains(codes::INVALID_GEOMETRY), "{capacity}");
        assert_eq!(capacity_kind, SolveErrorKind::Runtime);
    }

    #[test]
    fn cancel_fence_thang_loi_capacity_truoc_khi_native_map() {
        let run = MixedNestingRun::new();
        run.cancel();
        assert!(
            run.reject_cancelled().is_err(),
            "cancel phải chặn trước khi map capacity thành ENGINE_ERROR"
        );
        assert_eq!(run.progress.snapshot().phase, JobPhase::Cancelled);

        // Khi không có cancel, capacity vẫn giữ mapping runtime/500 đã chốt.
        let (kind, message) = solve_error_parts(&SolveError::CapacityInvariantExceeded);
        assert_eq!(kind, SolveErrorKind::Runtime);
        assert!(message.contains(codes::ENGINE_ERROR), "{message}");
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
