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
//! ## Không có cap phần cứng ở đây
//!
//! File này KHÔNG chứa cap worker/RAM. Số worker do backend quyết bằng
//! `plan_worker_count` (chỉ máy `<8 GB` và `<16 GB` mới giảm; máy `≥16 GB` giữ
//! `cpu-1`/full). Các con số trong [`SearchEffort`] là ngân sách *tìm kiếm* do người
//! dùng chọn qua profile, không phải trần theo phần cứng — máy mạnh không bị chậm đi
//! vì bất kỳ dòng nào trong file này.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::model::{ManifestStatus, Profile, TerminationReason};

/// Sentinel "chưa có số liệu" cho các atomic `u32` (số tờ tốt nhất, utilization).
const NO_VALUE_U32: u32 = u32::MAX;

/// Độ phân giải khi lưu tỉ lệ `0..1` vào atomic (parts-per-million).
const RATIO_SCALE: f64 = 1_000_000.0;

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
    /// `None` khi chạy work-plan cố định — khi đó không đọc đồng hồ trong hot path.
    deadline: Option<Instant>,
    evaluations: AtomicU64,
}

impl RunControl {
    pub fn new(stop: StopCriterion, cancel: CancelToken, progress: Arc<ProgressChannel>) -> Self {
        let deadline = stop
            .time_budget_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms));
        Self {
            cancel,
            progress,
            stop,
            deadline,
            evaluations: AtomicU64::new(0),
        }
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

    /// Tính thêm `count` lần đánh giá vào ngân sách work-plan.
    pub fn charge_evaluations(&self, count: u64) {
        self.evaluations.fetch_add(count, Ordering::Relaxed);
    }

    pub fn evaluations(&self) -> u64 {
        self.evaluations.load(Ordering::Relaxed)
    }

    /// Điểm dừng hợp tác. Thứ tự kiểm có chủ đích: hủy của người dùng luôn thắng
    /// deadline và work budget để thông báo cuối không nói sai nguyên nhân.
    pub fn checkpoint(&self) -> Result<(), Interrupt> {
        if self.cancel.is_cancelled() {
            return Err(Interrupt::Cancelled);
        }
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline {
                return Err(Interrupt::DeadlineReached);
            }
        }
        if self.evaluations() >= self.stop.evaluation_budget {
            return Err(Interrupt::WorkBudgetExhausted);
        }
        Ok(())
    }
}
