//! Điều khiển vòng chạy `mixed_nesting`: seed, progress, cancel hợp tác, work budget
//! và mức nỗ lực tìm kiếm (phase P1).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.3, §12, §14.
//!
//! ## Ba nguyên tắc khóa ở đây
//!
//! 1. **`fast/balanced/tight` chỉ đổi work effort.** [`SearchEffort`] không có trường
//!    nào mô tả góc, bước góc hay lưới toạ độ; [`SearchEffort::for_profile`] cũng
//!    không nhận và không trả về miền xoay. Miền xoay do
//!    `model::RotationConstraint` quyết định, độc lập hoàn toàn với profile.
//! 2. **Progress ghi vào atomic.** Không callback về Python từ vòng lặp nóng, không
//!    mutex trong hot path — nhờ vậy endpoint Status và Cancel vẫn phản hồi khi
//!    solver chiếm hết CPU.
//! 3. **Cancel là hợp tác và idempotent.** Solver gọi [`RunControl::checkpoint`] ở
//!    đầu mỗi batch góc/candidate/refinement; hủy nhiều lần hoặc hủy khi đã terminal
//!    đều vô hại.
//!
//! ## Grant phần cứng đi qua đây, quyết định vẫn ở backend
//!
//! File này KHÔNG tự đặt cap worker/RAM. Số worker và ngân sách cache do backend quyết bằng
//! `plan_worker_count` (chỉ máy `<8 GB` và `<16 GB` mới giảm; máy `≥16 GB` giữ
//! `cpu-1`/full), rồi truyền grant đã admission vào [`RunControl`]. Các con số trong
//! [`SearchEffort`] là ngân sách *tìm kiếm* do người dùng chọn qua profile, không phải
//! trần theo phần cứng — máy mạnh không bị chậm đi vì bất kỳ dòng nào trong file này.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::model::{ManifestStatus, Profile, TerminationReason};

/// Sentinel "chưa có số liệu" cho các atomic `u32` (số tờ tốt nhất, utilization).
const NO_VALUE_U32: u32 = u32::MAX;

/// Độ phân giải khi lưu tỉ lệ `0..1` vào atomic (parts-per-million).
const RATIO_SCALE: f64 = 1_000_000.0;

/// Đổi ms sang nanos. Deadline lưu bằng nanos offset để nạp lại được qua atomic.
const NANOS_PER_MILLI: u64 = 1_000_000;

// ─────────────────────────────────────────────────────────────────────────────
//  State machine của job
// ─────────────────────────────────────────────────────────────────────────────

/// Pha của job theo kế hoạch §12.2.
///
/// ```text
/// queued → waiting_resources → normalizing → baseline → nesting → improving
///        → validating → completed | failed | cancelled
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum JobPhase {
    Queued = 0,
    WaitingResources = 1,
    Normalizing = 2,
    Baseline = 3,
    Nesting = 4,
    Improving = 5,
    Validating = 6,
    Completed = 7,
    Failed = 8,
    Cancelled = 9,
}

impl JobPhase {
    /// Tất cả pha, đúng thứ tự khai báo — dùng cho test và cho ánh xạ atomic.
    pub const ALL: [JobPhase; 10] = [
        Self::Queued,
        Self::WaitingResources,
        Self::Normalizing,
        Self::Baseline,
        Self::Nesting,
        Self::Improving,
        Self::Validating,
        Self::Completed,
        Self::Failed,
        Self::Cancelled,
    ];

    /// Khôi phục từ giá trị atomic. Giá trị lạ ⇒ `None` (không tự đoán).
    pub fn from_u8(raw: u8) -> Option<Self> {
        Self::ALL.get(usize::from(raw)).copied()
    }

    /// Pha kết thúc — không còn chuyển tiếp nào nữa.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    /// Trạng thái ghi vào manifest. `None` với pha chưa terminal — manifest chỉ tồn
    /// tại sau khi job kết thúc, nên không có "manifest nửa vời".
    pub fn manifest_status(self) -> Option<ManifestStatus> {
        match self {
            Self::Completed => Some(ManifestStatus::Completed),
            Self::Failed => Some(ManifestStatus::Failed),
            Self::Cancelled => Some(ManifestStatus::Cancelled),
            _ => None,
        }
    }
}

/// Mã thông báo tiến độ. UI chỉ hiện pha + phần trăm + một câu ngắn; không đẩy log
/// chi tiết từng candidate lên giao diện.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum ProgressMessageCode {
    None = 0,
    QueuedWaitingSlot = 1,
    NormalizingContours = 2,
    BaselineLayout = 3,
    SearchingPoses = 4,
    ImprovingLayout = 5,
    ValidatingLayout = 6,
    Finished = 7,
    CancelledByUser = 8,
    BudgetExhausted = 9,
}

impl ProgressMessageCode {
    pub const ALL: [ProgressMessageCode; 10] = [
        Self::None,
        Self::QueuedWaitingSlot,
        Self::NormalizingContours,
        Self::BaselineLayout,
        Self::SearchingPoses,
        Self::ImprovingLayout,
        Self::ValidatingLayout,
        Self::Finished,
        Self::CancelledByUser,
        Self::BudgetExhausted,
    ];

    pub fn from_u8(raw: u8) -> Option<Self> {
        Self::ALL.get(usize::from(raw)).copied()
    }

    /// Câu thông báo tiếng Việt cho người dùng cuối (thuật ngữ ngành in PrynX).
    pub fn message_vi(self) -> &'static str {
        match self {
            Self::None => "",
            Self::QueuedWaitingSlot => "Đang chờ máy rảnh để nhận việc.",
            Self::NormalizingContours => "Đang chuẩn hoá nét cắt của từng chi tiết.",
            Self::BaselineLayout => "Đang xếp phương án nền an toàn.",
            Self::SearchingPoses => "Đang tìm vị trí và góc xoay cho từng chi tiết.",
            Self::ImprovingLayout => "Đang lồng ghép chặt hơn để bớt tờ.",
            Self::ValidatingLayout => "Đang kiểm tra chồng lấn và khoảng hở.",
            Self::Finished => "Đã xong phương án lồng ghép.",
            Self::CancelledByUser => "Đã hủy theo yêu cầu.",
            Self::BudgetExhausted => "Hết thời lượng tìm kiếm — trả phương án tốt nhất đã kiểm.",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Progress qua atomic
// ─────────────────────────────────────────────────────────────────────────────

/// Ảnh chụp tiến độ trả về cho sidecar/UI.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressSnapshot {
    pub phase: JobPhase,
    /// Tiến độ `0.0..=1.0`.
    pub progress: f64,
    pub attempts: u64,
    pub elapsed_ms: u64,
    /// `None` khi chưa có phương án hợp lệ nào.
    pub best_sheet_count: Option<u32>,
    /// `None` khi chưa có phương án hợp lệ nào.
    pub best_utilization: Option<f64>,
    pub message_code: ProgressMessageCode,
    /// PERF (audit 2026-08-30 §NEST-D0-B): timing phase của core, chỉ có sau
    /// khi solve hoàn tất. Không đưa vào placement manifest nên không đổi schema.
    pub phase_timings: Option<SolvePhaseTimings>,
    /// PERF (audit 2026-08-30 §NEST-D0-C): timing vỏ native nằm ngoài
    /// `multi_start::solve` (chuẩn bị request và serialize manifest).
    pub native_boundary_timings: Option<NativeBoundaryTimings>,
    /// PERF (audit 2026-08-30 §NEST-D0-D): counter NFP/Boolean theo phase.
    /// Chỉ là telemetry runtime, không tham gia manifest, score hoặc fingerprint.
    pub nfp_diagnostics: NfpDiagnostics,
}

/// Timing wall-clock tách phase của một solve thành công.
///
/// Đây là telemetry chẩn đoán, không tham gia score/fingerprint và không được dùng
/// làm điều kiện thay đổi chất lượng. Mỗi field đo một đoạn không chồng lấn trong
/// `multi_start::solve`; tổng sai khác vài ms do lượng tử hoá millisecond.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolvePhaseTimings {
    pub baseline_ms: u64,
    pub baseline_validation_ms: u64,
    pub rotation_probe_ms: u64,
    pub search_ms: u64,
    pub publication_ms: u64,
    pub core_total_ms: u64,
}

/// Timing của biên PyO3 quanh core. Production re-validator chạy sau `solve()` nên
/// không nằm ở đây; orchestrator đo riêng toàn bộ `solve_production`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeBoundaryTimings {
    pub request_preparation_ms: u64,
    pub manifest_serialization_ms: u64,
    pub native_total_ms: u64,
}

/// Counter nóng của NFP/Boolean cho một phase solver.
///
/// Thời gian dùng microsecond để không làm tròn mất các phép nhỏ; đây vẫn là số đo
/// aggregate, tuyệt đối không được dùng để đổi thứ tự candidate hay chất lượng solve.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NfpPhaseDiagnostics {
    pub feasible_region_calls: u64,
    pub interrupted_calls: u64,
    pub blockers_considered: u64,
    pub bbox_rejects: u64,
    pub blocker_rings_generated: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub cache_entries_built: u64,
    pub cache_insert_skipped: u64,
    pub cache_peak_estimated_bytes: u64,
    pub nfp_build_time_us: u64,
    pub difference_calls: u64,
    pub difference_time_us: u64,
    /// Số batch cold-miss NFP thực sự được dựng song song.
    pub prewarm_batches: u64,
    /// Tổng số khoá cold-miss duy nhất đã đưa vào các batch song song.
    pub prewarm_tasks: u64,
    /// Mức song song cao nhất đã dùng trong một batch (không phải grant danh nghĩa).
    pub prewarm_peak_workers: u64,
    /// Wall time cộng dồn của các batch song song, microsecond.
    pub prewarm_wall_time_us: u64,
}

/// Tách baseline khỏi search để biết chính xác phase nào trả giá cold-cache.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NfpDiagnostics {
    pub baseline: NfpPhaseDiagnostics,
    pub search: NfpPhaseDiagnostics,
}

/// Nhãn phase cố định lúc tạo cache. Không đọc phase progress trong vòng nóng để tránh
/// một race chẩn đoán khi UI poll hoặc khi phase chuyển ở publication fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NfpTelemetryPhase {
    Baseline,
    Search,
}

/// Một cập nhật nhỏ từ cache/feasible-region vào counter aggregate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NfpTelemetryMetric {
    FeasibleRegionCall,
    InterruptedCall,
    BlockersConsidered(u64),
    BboxRejects(u64),
    BlockerRingsGenerated(u64),
    CacheHit,
    CacheMiss,
    CacheEntryBuilt {
        estimated_bytes: u64,
        cache_total_estimated_bytes: u64,
    },
    CacheInsertSkipped,
    NfpBuildTimeUs(u64),
    DifferenceCall,
    DifferenceTimeUs(u64),
    PrewarmBatch {
        tasks: u64,
        workers: u64,
        wall_time_us: u64,
    },
}

#[derive(Debug)]
struct AtomicNfpPhaseDiagnostics {
    feasible_region_calls: AtomicU64,
    interrupted_calls: AtomicU64,
    blockers_considered: AtomicU64,
    bbox_rejects: AtomicU64,
    blocker_rings_generated: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    cache_entries_built: AtomicU64,
    cache_insert_skipped: AtomicU64,
    cache_peak_estimated_bytes: AtomicU64,
    nfp_build_time_us: AtomicU64,
    difference_calls: AtomicU64,
    difference_time_us: AtomicU64,
    prewarm_batches: AtomicU64,
    prewarm_tasks: AtomicU64,
    prewarm_peak_workers: AtomicU64,
    prewarm_wall_time_us: AtomicU64,
}

impl AtomicNfpPhaseDiagnostics {
    fn new() -> Self {
        Self {
            feasible_region_calls: AtomicU64::new(0),
            interrupted_calls: AtomicU64::new(0),
            blockers_considered: AtomicU64::new(0),
            bbox_rejects: AtomicU64::new(0),
            blocker_rings_generated: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            cache_entries_built: AtomicU64::new(0),
            cache_insert_skipped: AtomicU64::new(0),
            cache_peak_estimated_bytes: AtomicU64::new(0),
            nfp_build_time_us: AtomicU64::new(0),
            difference_calls: AtomicU64::new(0),
            difference_time_us: AtomicU64::new(0),
            prewarm_batches: AtomicU64::new(0),
            prewarm_tasks: AtomicU64::new(0),
            prewarm_peak_workers: AtomicU64::new(0),
            prewarm_wall_time_us: AtomicU64::new(0),
        }
    }

    fn record(&self, metric: NfpTelemetryMetric) {
        let add = |target: &AtomicU64, value: u64| {
            target.fetch_add(value, Ordering::Relaxed);
        };
        match metric {
            NfpTelemetryMetric::FeasibleRegionCall => add(&self.feasible_region_calls, 1),
            NfpTelemetryMetric::InterruptedCall => add(&self.interrupted_calls, 1),
            NfpTelemetryMetric::BlockersConsidered(count) => add(&self.blockers_considered, count),
            NfpTelemetryMetric::BboxRejects(count) => add(&self.bbox_rejects, count),
            NfpTelemetryMetric::BlockerRingsGenerated(count) => {
                add(&self.blocker_rings_generated, count)
            }
            NfpTelemetryMetric::CacheHit => add(&self.cache_hits, 1),
            NfpTelemetryMetric::CacheMiss => add(&self.cache_misses, 1),
            NfpTelemetryMetric::CacheEntryBuilt {
                estimated_bytes,
                cache_total_estimated_bytes,
            } => {
                add(&self.cache_entries_built, 1);
                self.cache_peak_estimated_bytes
                    .fetch_max(cache_total_estimated_bytes, Ordering::Relaxed);
                debug_assert!(estimated_bytes <= cache_total_estimated_bytes);
            }
            NfpTelemetryMetric::CacheInsertSkipped => add(&self.cache_insert_skipped, 1),
            NfpTelemetryMetric::NfpBuildTimeUs(value) => add(&self.nfp_build_time_us, value),
            NfpTelemetryMetric::DifferenceCall => add(&self.difference_calls, 1),
            NfpTelemetryMetric::DifferenceTimeUs(value) => add(&self.difference_time_us, value),
            NfpTelemetryMetric::PrewarmBatch {
                tasks,
                workers,
                wall_time_us,
            } => {
                add(&self.prewarm_batches, 1);
                add(&self.prewarm_tasks, tasks);
                self.prewarm_peak_workers
                    .fetch_max(workers, Ordering::Relaxed);
                add(&self.prewarm_wall_time_us, wall_time_us);
            }
        }
    }

    fn snapshot(&self) -> NfpPhaseDiagnostics {
        NfpPhaseDiagnostics {
            feasible_region_calls: self.feasible_region_calls.load(Ordering::Relaxed),
            interrupted_calls: self.interrupted_calls.load(Ordering::Relaxed),
            blockers_considered: self.blockers_considered.load(Ordering::Relaxed),
            bbox_rejects: self.bbox_rejects.load(Ordering::Relaxed),
            blocker_rings_generated: self.blocker_rings_generated.load(Ordering::Relaxed),
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            cache_misses: self.cache_misses.load(Ordering::Relaxed),
            cache_entries_built: self.cache_entries_built.load(Ordering::Relaxed),
            cache_insert_skipped: self.cache_insert_skipped.load(Ordering::Relaxed),
            cache_peak_estimated_bytes: self.cache_peak_estimated_bytes.load(Ordering::Relaxed),
            nfp_build_time_us: self.nfp_build_time_us.load(Ordering::Relaxed),
            difference_calls: self.difference_calls.load(Ordering::Relaxed),
            difference_time_us: self.difference_time_us.load(Ordering::Relaxed),
            prewarm_batches: self.prewarm_batches.load(Ordering::Relaxed),
            prewarm_tasks: self.prewarm_tasks.load(Ordering::Relaxed),
            prewarm_peak_workers: self.prewarm_peak_workers.load(Ordering::Relaxed),
            prewarm_wall_time_us: self.prewarm_wall_time_us.load(Ordering::Relaxed),
        }
    }
}

/// Kênh tiến độ lock-free. Solver ghi, endpoint Status đọc — không chặn nhau.
#[derive(Debug)]
pub struct ProgressChannel {
    phase: AtomicU8,
    message_code: AtomicU8,
    /// Tiến độ lưu dạng parts-per-million để dùng được atomic nguyên.
    progress_ppm: AtomicU32,
    attempts: AtomicU64,
    best_sheet_count: AtomicU32,
    best_utilization_ppm: AtomicU32,
    phase_timings_ready: AtomicBool,
    baseline_ms: AtomicU64,
    baseline_validation_ms: AtomicU64,
    rotation_probe_ms: AtomicU64,
    search_ms: AtomicU64,
    publication_ms: AtomicU64,
    core_total_ms: AtomicU64,
    native_boundary_timings_ready: AtomicBool,
    request_preparation_ms: AtomicU64,
    manifest_serialization_ms: AtomicU64,
    native_total_ms: AtomicU64,
    baseline_nfp: AtomicNfpPhaseDiagnostics,
    search_nfp: AtomicNfpPhaseDiagnostics,
    /// Bất biến sau khi khởi tạo nên không cần atomic.
    started_at: Instant,
}

impl ProgressChannel {
    pub fn new() -> Self {
        Self {
            phase: AtomicU8::new(JobPhase::Queued as u8),
            message_code: AtomicU8::new(ProgressMessageCode::QueuedWaitingSlot as u8),
            progress_ppm: AtomicU32::new(0),
            attempts: AtomicU64::new(0),
            best_sheet_count: AtomicU32::new(NO_VALUE_U32),
            best_utilization_ppm: AtomicU32::new(NO_VALUE_U32),
            phase_timings_ready: AtomicBool::new(false),
            baseline_ms: AtomicU64::new(0),
            baseline_validation_ms: AtomicU64::new(0),
            rotation_probe_ms: AtomicU64::new(0),
            search_ms: AtomicU64::new(0),
            publication_ms: AtomicU64::new(0),
            core_total_ms: AtomicU64::new(0),
            native_boundary_timings_ready: AtomicBool::new(false),
            request_preparation_ms: AtomicU64::new(0),
            manifest_serialization_ms: AtomicU64::new(0),
            native_total_ms: AtomicU64::new(0),
            baseline_nfp: AtomicNfpPhaseDiagnostics::new(),
            search_nfp: AtomicNfpPhaseDiagnostics::new(),
            started_at: Instant::now(),
        }
    }

    pub fn set_phase(&self, phase: JobPhase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }

    pub fn set_message(&self, code: ProgressMessageCode) {
        self.message_code.store(code as u8, Ordering::Relaxed);
    }

    /// Ghi tiến độ. Giá trị ngoài `[0,1]` bị kẹp; `NaN` coi như 0 để UI không nhảy.
    pub fn set_progress(&self, ratio: f64) {
        let clamped = if ratio.is_finite() {
            ratio.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let ppm = (clamped * RATIO_SCALE).round() as u32;
        self.progress_ppm.store(ppm, Ordering::Relaxed);
    }

    /// Cộng dồn số lần thử. Rẻ đủ để gọi trong vòng lặp nóng.
    pub fn add_attempts(&self, count: u64) {
        self.attempts.fetch_add(count, Ordering::Relaxed);
    }

    /// Ghi phương án tốt nhất hiện tại (best-so-far).
    pub fn record_best(&self, sheet_count: u32, utilization: f64) {
        self.best_sheet_count
            .store(sheet_count.min(NO_VALUE_U32 - 1), Ordering::Relaxed);
        let ratio = if utilization.is_finite() {
            utilization.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.best_utilization_ppm
            .store((ratio * RATIO_SCALE).round() as u32, Ordering::Relaxed);
    }

    /// Công bố timing phase một lần sau solve. Ghi payload trước rồi bật cờ ready
    /// bằng Release để snapshot Acquire không thấy bản ghi nửa chừng.
    pub fn record_phase_timings(&self, timings: SolvePhaseTimings) {
        self.baseline_ms
            .store(timings.baseline_ms, Ordering::Relaxed);
        self.baseline_validation_ms
            .store(timings.baseline_validation_ms, Ordering::Relaxed);
        self.rotation_probe_ms
            .store(timings.rotation_probe_ms, Ordering::Relaxed);
        self.search_ms.store(timings.search_ms, Ordering::Relaxed);
        self.publication_ms
            .store(timings.publication_ms, Ordering::Relaxed);
        self.core_total_ms
            .store(timings.core_total_ms, Ordering::Relaxed);
        self.phase_timings_ready.store(true, Ordering::Release);
    }

    /// Công bố timing biên một lần sau khi manifest đã serialize xong.
    pub fn record_native_boundary_timings(&self, timings: NativeBoundaryTimings) {
        self.request_preparation_ms
            .store(timings.request_preparation_ms, Ordering::Relaxed);
        self.manifest_serialization_ms
            .store(timings.manifest_serialization_ms, Ordering::Relaxed);
        self.native_total_ms
            .store(timings.native_total_ms, Ordering::Relaxed);
        self.native_boundary_timings_ready
            .store(true, Ordering::Release);
    }

    /// Ghi counter NFP bằng atomic Relaxed; caller chỉ truyền số aggregate hoặc một
    /// event rẻ, không callback và không mutex trong vòng solver nóng.
    pub(crate) fn record_nfp_metric(&self, phase: NfpTelemetryPhase, metric: NfpTelemetryMetric) {
        match phase {
            NfpTelemetryPhase::Baseline => self.baseline_nfp.record(metric),
            NfpTelemetryPhase::Search => self.search_nfp.record(metric),
        }
    }

    pub fn snapshot(&self) -> ProgressSnapshot {
        let phase =
            JobPhase::from_u8(self.phase.load(Ordering::Relaxed)).unwrap_or(JobPhase::Queued);
        let message_code = ProgressMessageCode::from_u8(self.message_code.load(Ordering::Relaxed))
            .unwrap_or(ProgressMessageCode::None);
        let best_sheets = self.best_sheet_count.load(Ordering::Relaxed);
        let best_util = self.best_utilization_ppm.load(Ordering::Relaxed);
        ProgressSnapshot {
            phase,
            progress: f64::from(self.progress_ppm.load(Ordering::Relaxed)) / RATIO_SCALE,
            attempts: self.attempts.load(Ordering::Relaxed),
            elapsed_ms: self
                .started_at
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            best_sheet_count: (best_sheets != NO_VALUE_U32).then_some(best_sheets),
            best_utilization: (best_util != NO_VALUE_U32)
                .then(|| f64::from(best_util) / RATIO_SCALE),
            message_code,
            phase_timings: self.phase_timings_ready.load(Ordering::Acquire).then(|| {
                SolvePhaseTimings {
                    baseline_ms: self.baseline_ms.load(Ordering::Relaxed),
                    baseline_validation_ms: self.baseline_validation_ms.load(Ordering::Relaxed),
                    rotation_probe_ms: self.rotation_probe_ms.load(Ordering::Relaxed),
                    search_ms: self.search_ms.load(Ordering::Relaxed),
                    publication_ms: self.publication_ms.load(Ordering::Relaxed),
                    core_total_ms: self.core_total_ms.load(Ordering::Relaxed),
                }
            }),
            native_boundary_timings: self
                .native_boundary_timings_ready
                .load(Ordering::Acquire)
                .then(|| NativeBoundaryTimings {
                    request_preparation_ms: self.request_preparation_ms.load(Ordering::Relaxed),
                    manifest_serialization_ms: self
                        .manifest_serialization_ms
                        .load(Ordering::Relaxed),
                    native_total_ms: self.native_total_ms.load(Ordering::Relaxed),
                }),
            nfp_diagnostics: NfpDiagnostics {
                baseline: self.baseline_nfp.snapshot(),
                search: self.search_nfp.snapshot(),
            },
        }
    }

    /// Thời gian đã chạy kể từ lúc tạo kênh.
    pub fn elapsed(&self) -> Duration {
        self.started_at.elapsed()
    }
}

impl Default for ProgressChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod phase_timing_tests {
    use super::*;

    #[test]
    fn timing_phase_chi_xuat_hien_sau_khi_cong_bo_day_du() {
        let progress = ProgressChannel::new();
        assert!(progress.snapshot().phase_timings.is_none());

        let expected = SolvePhaseTimings {
            baseline_ms: 11,
            baseline_validation_ms: 12,
            rotation_probe_ms: 13,
            search_ms: 14,
            publication_ms: 15,
            core_total_ms: 65,
        };
        progress.record_phase_timings(expected);

        assert_eq!(progress.snapshot().phase_timings, Some(expected));

        let boundary = NativeBoundaryTimings {
            request_preparation_ms: 2,
            manifest_serialization_ms: 3,
            native_total_ms: 70,
        };
        assert!(progress.snapshot().native_boundary_timings.is_none());
        progress.record_native_boundary_timings(boundary);
        assert_eq!(progress.snapshot().native_boundary_timings, Some(boundary));

        progress.record_nfp_metric(
            NfpTelemetryPhase::Baseline,
            NfpTelemetryMetric::CacheEntryBuilt {
                estimated_bytes: 100,
                cache_total_estimated_bytes: 100,
            },
        );
        progress.record_nfp_metric(
            NfpTelemetryPhase::Baseline,
            NfpTelemetryMetric::CacheEntryBuilt {
                estimated_bytes: 50,
                cache_total_estimated_bytes: 150,
            },
        );
        progress.record_nfp_metric(NfpTelemetryPhase::Search, NfpTelemetryMetric::CacheHit);
        let nfp = progress.snapshot().nfp_diagnostics;
        assert_eq!(nfp.baseline.cache_entries_built, 2);
        assert_eq!(nfp.baseline.cache_peak_estimated_bytes, 150);
        assert_eq!(nfp.search.cache_hits, 1);
        assert_eq!(nfp.search.cache_entries_built, 0);
    }

    #[test]
    fn run_control_mac_dinh_tuan_tu_va_ton_trong_grant_nfp() {
        let default = RunControl::new(
            StopCriterion::fixed_work_plan(10),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        assert_eq!(default.nfp_worker_grant(), 1);
        assert_eq!(default.nfp_cache_byte_budget(), u64::MAX);

        let granted = RunControl::new_with_nfp_resources(
            StopCriterion::fixed_work_plan(10),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
            4,
            12_345,
        );
        assert_eq!(granted.nfp_worker_grant(), 4);
        assert_eq!(granted.nfp_cache_byte_budget(), 12_345);

        let zero = RunControl::new_with_nfp_resources(
            StopCriterion::fixed_work_plan(10),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
            0,
            0,
        );
        assert_eq!(zero.nfp_worker_grant(), 1);
        assert_eq!(zero.nfp_cache_byte_budget(), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cancel hợp tác
// ─────────────────────────────────────────────────────────────────────────────

/// Cờ hủy dùng chung giữa sidecar và solver.
///
/// Hủy nhiều lần hoặc hủy khi job đã terminal là **idempotent** — chỉ set một cờ.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

/// Lý do vòng lặp bị ngắt tại checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interrupt {
    /// Người dùng hủy.
    Cancelled,
    /// Hết deadline wall-clock.
    DeadlineReached,
    /// Hết ngân sách work-plan cố định.
    WorkBudgetExhausted,
}

impl Interrupt {
    /// Ánh xạ sang `terminationReason` của manifest.
    pub fn termination_reason(self) -> TerminationReason {
        match self {
            Self::Cancelled => TerminationReason::Cancelled,
            Self::DeadlineReached => TerminationReason::Deadline,
            Self::WorkBudgetExhausted => TerminationReason::WorkBudgetExhausted,
        }
    }

    /// Thông báo tiếng Việt tương ứng.
    pub fn message_code(self) -> ProgressMessageCode {
        match self {
            Self::Cancelled => ProgressMessageCode::CancelledByUser,
            Self::DeadlineReached | Self::WorkBudgetExhausted => {
                ProgressMessageCode::BudgetExhausted
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Điều kiện dừng
// ─────────────────────────────────────────────────────────────────────────────

/// Điều kiện dừng của một vòng chạy.
///
/// - `time_budget_ms = None` ⇒ **work-plan cố định**: chỉ dừng theo
///   `evaluation_budget`, không đọc đồng hồ ⇒ cùng seed cho cùng kết quả bất kể số
///   worker. Đây là chế độ dùng cho test determinism và benchmark.
/// - `time_budget_ms = Some(ms)` ⇒ thêm deadline wall-clock: chỉ cam kết best-so-far
///   hợp lệ và ghi `terminationReason = deadline`, không cam kết bit-identical giữa
///   hai máy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopCriterion {
    pub evaluation_budget: u64,
    pub time_budget_ms: Option<u64>,
}

impl StopCriterion {
    /// Work-plan cố định — deterministic.
    pub const fn fixed_work_plan(evaluation_budget: u64) -> Self {
        Self {
            evaluation_budget,
            time_budget_ms: None,
        }
    }

    /// Work-plan cố định + deadline wall-clock.
    pub const fn with_deadline(evaluation_budget: u64, time_budget_ms: u64) -> Self {
        Self {
            evaluation_budget,
            time_budget_ms: Some(time_budget_ms),
        }
    }

    /// Chế độ có cam kết tái lập bit-identical hay không.
    pub const fn is_deterministic(&self) -> bool {
        self.time_budget_ms.is_none()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mức nỗ lực tìm kiếm
// ─────────────────────────────────────────────────────────────────────────────

/// Ngân sách tìm kiếm của một vòng chạy.
///
/// **Bằng chứng cấu trúc:** không có trường nào tên `angle_step`, `rotation_step`,
/// `allowed_angles`, `translation_step` hay `grid`. Profile không thể thu hẹp miền
/// góc vì miền góc không đi qua struct này.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchEffort {
    /// Số trial độc lập (mỗi trial có `trialId` và seed dẫn xuất riêng).
    pub trial_count: u32,
    /// Số góc đề xuất tối đa cho mỗi chi tiết ở pha coarse. Đây là **cách lấy mẫu**,
    /// không phải danh sách góc hợp lệ: pose cuối vẫn được refine liên tục.
    pub orientation_proposals_per_part: u32,
    /// Độ rộng beam khi giữ top-K pose.
    pub beam_width: u32,
    /// Số vòng refine liên tục `(theta, tx, ty)` quanh pose tốt.
    pub refinement_rounds: u32,
    /// Số lần multi-start.
    pub multi_start_restarts: u32,
    /// Ngân sách đánh giá của work-plan cố định.
    pub evaluation_budget: u64,
}

impl SearchEffort {
    /// Ngân sách theo profile. Ba profile khác nhau **chỉ ở lượng công**; cả ba đều
    /// giữ nguyên toàn bộ rotation domain hợp lệ và đều có thể trả góc không-cardinal.
    ///
    /// ## `evaluation_budget` được hiệu chỉnh bằng đo, không phải đoán
    ///
    /// PERF (đo 2026-08-26, `--release`, 16 lõi): sau khi `refine.rs` nạp đúng ngân sách
    /// (xem `refine::charge_evaluation`), tốc độ thực đo được là **≈9.700 lượt đánh giá
    /// pose mỗi giây**. Ca `S20` (20 con, 5 loại, có hình lõm) dùng 474.651 lượt và mất
    /// **48,3 giây** ở `Balanced` — nghĩa là trần cũ 1.500.000 **chưa bao giờ bít**, và
    /// "work-plan cố định" tuy xác định nhưng không chặn được thời gian chạy.
    ///
    /// Trần mới nhắm khoảng thời gian mà thợ in chấp nhận được cho một lượt bình:
    /// `Fast ≈ 3 giây`, `Balanced ≈ 10 giây`, `Tight ≈ 31 giây`.
    ///
    /// Ba con số này **giống nhau trên mọi máy** — chúng là ngân sách *công việc*, không
    /// phải cap phần cứng. Máy mạnh chạy xong sớm hơn chứ không bị hạ trần (rule #1 của
    /// AGENTS.md). Muốn bám theo đồng hồ tường thì dùng `timeBudgetMs`.
    ///
    /// Baseline **không** nạp ngân sách (xem `baseline.rs`), nên hạ trần không bao giờ
    /// làm sàn an toàn bị bỏ dở: hết trần thì vẫn còn baseline đã validate để công bố.
    pub const fn for_profile(profile: Profile) -> Self {
        match profile {
            Profile::Fast => Self {
                trial_count: 4,
                orientation_proposals_per_part: 12,
                beam_width: 4,
                refinement_rounds: 2,
                multi_start_restarts: 1,
                evaluation_budget: 30_000,
            },
            Profile::Balanced => Self {
                trial_count: 12,
                orientation_proposals_per_part: 32,
                beam_width: 8,
                refinement_rounds: 6,
                multi_start_restarts: 3,
                evaluation_budget: 100_000,
            },
            Profile::Tight => Self {
                trial_count: 32,
                orientation_proposals_per_part: 96,
                beam_width: 16,
                refinement_rounds: 18,
                multi_start_restarts: 8,
                evaluation_budget: 300_000,
            },
        }
    }

    /// Dựng điều kiện dừng: có `timeBudgetMs` thì thêm deadline, không thì chạy
    /// work-plan cố định (deterministic).
    pub const fn stop_criterion(&self, time_budget_ms: Option<u64>) -> StopCriterion {
        match time_budget_ms {
            Some(ms) => StopCriterion::with_deadline(self.evaluation_budget, ms),
            None => StopCriterion::fixed_work_plan(self.evaluation_budget),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Seed dẫn xuất
// ─────────────────────────────────────────────────────────────────────────────

/// SplitMix64 — bộ trộn bit thuần, không phụ thuộc crate ngoài.
const fn splitmix64(seed: u64) -> u64 {
    let z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Seed của một trial, dẫn xuất cố định từ seed gốc và `trialId`.
///
/// Vì seed chỉ phụ thuộc `(root_seed, trial_id)` — không phụ thuộc thứ tự hoàn thành
/// của thread — nên work-plan cố định cho cùng kết quả với 1 worker và với N worker.
pub const fn derive_trial_seed(root_seed: u64, trial_id: u64) -> u64 {
    splitmix64(root_seed ^ splitmix64(trial_id ^ 0x5DEE_CE66_D1B1_4A2F))
}

// ─────────────────────────────────────────────────────────────────────────────
//  RunControl — checkpoint hợp tác
// ─────────────────────────────────────────────────────────────────────────────

/// Bộ điều khiển một vòng chạy: gộp cancel, deadline, work budget và progress.
///
/// Solver gọi [`RunControl::checkpoint`] ở đầu mỗi batch góc/candidate/refinement.
/// Mục tiêu độ trễ hủy: ≤1 giây tại checkpoint.
#[derive(Debug)]
pub struct RunControl {
    cancel: CancelToken,
    progress: Arc<ProgressChannel>,
    stop: StopCriterion,
    /// Mốc gốc của deadline cooperative cho TOÀN solve.
    ///
    /// PERF (audit 2026-09-02 §PERF-NEST-04): budget trước đây được nạp lại sau
    /// baseline, nên tổng thực tế là `baseline + budget + publication`. Nay mốc mặc
    /// định chốt từ `new()`; chỉ ca baseline autofill chưa có candidate hợp lệ mới được
    /// mở cửa sổ rescue tường minh để không công bố thiếu mẫu.
    started: Instant,
    /// Nanos kể từ [`Self::started`] mà deadline hết hiệu lực. Chỉ đọc khi
    /// `stop.time_budget_ms.is_some()`, nên work-plan cố định vẫn không đọc đồng hồ.
    deadline_nanos: AtomicU64,
    evaluations: AtomicU64,
    /// Grant đã admission từ backend. `new()` giữ 1 để mọi caller cũ vẫn tuần tự.
    nfp_worker_grant: usize,
    /// Ngân sách payload cache NFP của đúng lượt solve này, byte ước lượng.
    nfp_cache_byte_budget: u64,
}

impl RunControl {
    pub fn new(stop: StopCriterion, cancel: CancelToken, progress: Arc<ProgressChannel>) -> Self {
        Self::new_with_nfp_resources(stop, cancel, progress, 1, u64::MAX)
    }

    /// Tạo control với grant NFP đã được tầng admission/hardware planner phê duyệt.
    ///
    /// PERF (audit 2026-08-30 §NEST-NFP-P1): core chỉ tiêu thụ grant, không tự đo RAM
    /// hay hard-cap máy mạnh. `worker_grant = 0` được chuẩn hoá thành 1 để không có
    /// cấu hình làm mất đường thực thi tuần tự.
    pub fn new_with_nfp_resources(
        stop: StopCriterion,
        cancel: CancelToken,
        progress: Arc<ProgressChannel>,
        nfp_worker_grant: usize,
        nfp_cache_byte_budget: u64,
    ) -> Self {
        Self {
            cancel,
            progress,
            stop,
            started: Instant::now(),
            deadline_nanos: AtomicU64::new(Self::budget_nanos(stop)),
            evaluations: AtomicU64::new(0),
            nfp_worker_grant: nfp_worker_grant.max(1),
            nfp_cache_byte_budget,
        }
    }

    /// Ngân sách thời gian quy ra nanos. `None` ⇒ 0, nhưng giá trị đó không bao giờ được
    /// đọc vì `checkpoint()` kiểm `time_budget_ms.is_some()` trước.
    fn budget_nanos(stop: StopCriterion) -> u64 {
        stop.time_budget_ms
            .unwrap_or(0)
            .saturating_mul(NANOS_PER_MILLI)
    }

    fn elapsed_nanos(&self) -> u64 {
        self.started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
    }

    /// Mở một cửa sổ rescue khi baseline autofill chưa có candidate đủ mọi design.
    ///
    /// Đây không phải đường thường và không được gọi cho baseline hợp lệ. Chọn soft
    /// overrun thay vì trả artifact thiếu mẫu/fail ngẫu nhiên theo tốc độ máy.
    pub(crate) fn rearm_deadline_for_required_rescue(&self) {
        if self.stop.time_budget_ms.is_none() {
            return;
        }
        let moc = self
            .elapsed_nanos()
            .saturating_add(Self::budget_nanos(self.stop));
        self.deadline_nanos.store(moc, Ordering::Relaxed);
    }

    pub fn cancel_token(&self) -> &CancelToken {
        &self.cancel
    }

    pub fn progress(&self) -> &Arc<ProgressChannel> {
        &self.progress
    }

    pub const fn stop_criterion(&self) -> StopCriterion {
        self.stop
    }

    /// Số worker tối đa dành riêng cho batch cold-miss NFP của một cache/trial.
    pub const fn nfp_worker_grant(&self) -> usize {
        self.nfp_worker_grant
    }

    /// Ngân sách payload cache NFP đã admission cho một cache/trial.
    pub const fn nfp_cache_byte_budget(&self) -> u64 {
        self.nfp_cache_byte_budget
    }

    /// Tính thêm `count` lần đánh giá vào ngân sách work-plan.
    pub fn charge_evaluations(&self, count: u64) {
        self.evaluations.fetch_add(count, Ordering::Relaxed);
    }

    pub fn evaluations(&self) -> u64 {
        self.evaluations.load(Ordering::Relaxed)
    }

    /// Ngân sách work-plan còn lại trước khi chia cố định cho các trial.
    ///
    /// PERF (audit 2026-08-30 §NEST-NF-3): multi-start chụp giá trị này đúng một lần,
    /// rồi chia quota theo `trial_id`. Mỗi trial dùng atomic riêng nên worker nhanh hơn
    /// không thể lấy mất ngân sách của worker chậm hơn.
    pub fn remaining_evaluation_budget(&self) -> u64 {
        self.stop
            .evaluation_budget
            .saturating_sub(self.evaluations())
    }

    /// Tạo control độc lập cho một trial nhưng giữ chung cửa sổ wall-clock và token hủy.
    /// `started` và `deadline_nanos` được chụp nguyên giá trị nên mọi trial, kể cả wave
    /// khởi động sau, cùng nhìn đúng một mốc hết hạn tuyệt đối. Chỉ `evaluations` là tách
    /// riêng; grant NFP và cache byte-budget thuộc riêng trial này.
    pub(crate) fn fork_for_trial(
        &self,
        evaluation_budget: u64,
        nfp_worker_grant: usize,
        nfp_cache_byte_budget: u64,
    ) -> Self {
        Self {
            cancel: self.cancel.clone(),
            progress: Arc::clone(&self.progress),
            stop: StopCriterion {
                evaluation_budget,
                time_budget_ms: self.stop.time_budget_ms,
            },
            started: self.started,
            deadline_nanos: AtomicU64::new(self.deadline_nanos.load(Ordering::Relaxed)),
            evaluations: AtomicU64::new(0),
            nfp_worker_grant: nfp_worker_grant.max(1),
            nfp_cache_byte_budget,
        }
    }

    /// Checkpoint cho đoạn fixed-work bắt buộc: chỉ hủy trực tiếp của người dùng được
    /// phép ngắt. Baseline deadline-mode dùng [`Self::checkpoint_deadline_only`]; helper
    /// này còn dành cho các đoạn hữu hạn phải hoàn tất để giữ candidate hợp lệ.
    pub(crate) fn checkpoint_cancel_only(&self) -> Result<(), Interrupt> {
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        Ok(())
    }

    /// Checkpoint baseline/probe: hủy + deadline, nhưng không tiêu work budget trial.
    /// Với fixed-work (`time_budget_ms=None`) nhánh này không đọc đồng hồ.
    pub(crate) fn checkpoint_deadline_only(&self) -> Result<(), Interrupt> {
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        if self.stop.time_budget_ms.is_some()
            && self.elapsed_nanos() >= self.deadline_nanos.load(Ordering::Relaxed)
        {
            return Err(Interrupt::DeadlineReached);
        }
        Ok(())
    }

    /// Điểm dừng hợp tác. Thứ tự kiểm có chủ đích: hủy của người dùng luôn thắng
    /// deadline và work budget để thông báo cuối không nói sai nguyên nhân.
    pub fn checkpoint(&self) -> Result<(), Interrupt> {
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        if self.stop.time_budget_ms.is_some()
            && self.elapsed_nanos() >= self.deadline_nanos.load(Ordering::Relaxed)
        {
            return Err(Interrupt::DeadlineReached);
        }
        if self.evaluations() >= self.stop.evaluation_budget {
            return Err(Interrupt::WorkBudgetExhausted);
        }
        Ok(())
    }
}
