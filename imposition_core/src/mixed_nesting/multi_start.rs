//! Multi-start và điều phối công bố kết quả (P4).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.1, §11.3, §11.6, §12.2.
//!
//! ## Bốn cam kết mà module này thực thi
//!
//! 1. **Không bao giờ tệ hơn baseline.** Baseline luôn được chạy và luôn nằm trong tập ứng
//!    viên. Nếu mọi trial đều tệ hơn hoặc invalid, kết quả công bố là baseline đã validate
//!    (§11.1).
//! 2. **Không công bố layout chưa validate.** Mỗi ứng viên đi qua
//!    [`super::validator::validate_layout`] *trước khi* được đưa vào cuộc so sánh. Ứng viên
//!    invalid bị **loại**, không phải "sửa nhẹ rồi công bố" (§11.6).
//! 3. **Gộp kết quả không phụ thuộc thứ tự.** [`reduce_candidates`] dùng thứ tự toàn phần
//!    của [`LayoutScore`], nên gộp theo thứ tự nào cũng cho cùng đáp án — điều kiện cần để
//!    fixed work-plan cho cùng kết quả bất kể số worker (§11.3).
//! 4. **Hủy hoặc hết hạn vẫn trả best-so-far hợp lệ**, kèm `terminationReason` đúng, và
//!    không bao giờ trả layout dở dang (§12.3).
//!
//! ## Vì sao chạy tuần tự mà vẫn nói về số worker
//!
//! Trial là **độc lập**: mỗi trial chỉ đọc request và `(seed, trial_id, part_order)` của
//! chính nó. Vì vậy song song hoá là việc của lớp gọi (local Rayon pool theo budget đã tính
//! ở backend), và tính xác định không phụ thuộc lựa chọn đó — miễn là bước gộp dùng
//! [`reduce_candidates`]. Test `ket_qua_khong_doi_theo_thu_tu_gop` chốt điều đó.

use super::baseline::{run_baseline, BaselineAnglePolicy, BaselineError};
use super::control::{Interrupt, RunControl, SearchEffort};
use super::model::{ManifestStatus, PlacementRecord, RunStats, TerminationReason, UnplacedRecord};
use super::normalize::NormalizedRequest;
use super::score::{score_layout, LayoutScore};
use super::solver::{plan_trials, run_trial, TrialError};
use super::validator::{
    recompute_stats, validate_layout, LayoutUnderReview, RunCounters, ValidationReport,
};

/// Version của vòng multi-start.
pub const MULTI_START_VERSION: u32 = 1;

/// Nguồn gốc của phương án được công bố — vào report để không ai phải đoán.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolutionSource {
    /// Phương án nền. Xuất hiện khi mọi trial đều tệ hơn hoặc invalid.
    Baseline,
    /// Một trial của smart solver.
    Trial { trial_id: u64 },
}

/// Một ứng viên **đã validate** kèm điểm.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoredCandidate {
    pub source: SolutionSource,
    pub placements: Vec<PlacementRecord>,
    pub unplaced: Vec<UnplacedRecord>,
    pub score: LayoutScore,
}

/// Kết quả cuối của một lần chạy.
#[derive(Debug, Clone, PartialEq)]
pub struct SolveOutcome {
    pub status: ManifestStatus,
    pub source: SolutionSource,
    pub placements: Vec<PlacementRecord>,
    pub unplaced: Vec<UnplacedRecord>,
    pub stats: RunStats,
    pub validation: ValidationReport,
    /// Số trial đã chạy xong.
    pub trials_run: u32,
    /// Số trial bị loại vì không qua validator — số này lớn là dấu hiệu solver có bệnh.
    pub trials_rejected: u32,
}

/// Lỗi khiến không công bố được gì.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SolveError {
    /// Ngay cả baseline cũng không qua validator. Đây là lỗi engine, phải fail job.
    BaselineInvalid,
    /// Hình học không dựng được vùng lồng ghép.
    Geometry(TrialError),
    /// Baseline bị ngắt trước khi có phương án nào.
    InterruptedBeforeAnyResult(Interrupt),
}

/// Gộp các ứng viên đã validate thành ứng viên tốt nhất.
///
/// Dùng thứ tự toàn phần của [`LayoutScore`], nên **không phụ thuộc thứ tự gộp**. Khi hai
/// ứng viên bằng điểm hoàn toàn, ưu tiên cái xuất hiện trước trong danh sách — và vì danh
/// sách trial được lập theo `trial_id` tăng dần, kết quả vẫn xác định.
pub fn reduce_candidates(candidates: &[ScoredCandidate]) -> Option<&ScoredCandidate> {
    candidates
        .iter()
        .fold(None, |best: Option<&ScoredCandidate>, item| match best {
            None => Some(item),
            Some(current) => {
                if item.score.is_better_than(&current.score) {
                    Some(item)
                } else {
                    Some(current)
                }
            }
        })
}

/// Chạy đủ vòng: baseline → các trial → validate từng cái → gộp → công bố.
///
/// `baseline_policy` để tường minh: đường sản xuất dùng
/// [`BaselineAnglePolicy::FirstAllowed`]; benchmark có thể truyền
/// [`BaselineAnglePolicy::CardinalForBenchmark`] để đo lợi ích của free-angle.
pub fn solve(
    request: &NormalizedRequest,
    effort: SearchEffort,
    control: &RunControl,
    baseline_policy: BaselineAnglePolicy,
) -> Result<SolveOutcome, SolveError> {
    let mut candidates: Vec<ScoredCandidate> = Vec::new();
    let mut cancelled = false;
    let mut deadline_hit = false;
    let mut budget_hit = false;

    // ── 1. Baseline: sàn an toàn, luôn chạy trước ──
    let baseline = match run_baseline(request, control, baseline_policy) {
        Ok(outcome) => outcome,
        Err(BaselineError::Interrupted(stop)) => {
            return Err(SolveError::InterruptedBeforeAnyResult(stop))
        }
        Err(BaselineError::Nfp(error)) => return Err(SolveError::Geometry(TrialError::Nfp(error))),
    };
    let baseline_report = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &baseline.placements,
            unplaced: &baseline.unplaced,
            stats: None,
        },
    );
    if !baseline_report.valid {
        // Baseline invalid là lỗi engine, không phải lỗi dữ liệu người dùng. Fail job
        // thay vì công bố một phương án chưa kiểm.
        return Err(SolveError::BaselineInvalid);
    }
    let baseline_score = score_layout(
        request,
        &baseline.placements,
        baseline.unplaced.len() as u64,
    );
    candidates.push(ScoredCandidate {
        source: SolutionSource::Baseline,
        placements: baseline.placements.clone(),
        unplaced: baseline.unplaced.clone(),
        score: baseline_score,
    });

    // ── 2. Các trial ──
    let mut attempts = baseline.attempts;
    let mut orientation_evaluations = baseline.orientation_evaluations;
    let mut pose_refinements: u64 = 0;
    let mut trials_run: u32 = 0;
    let mut trials_rejected: u32 = 0;

    for plan in plan_trials(request.seed, effort) {
        // Ngắt trước khi bắt đầu trial: dừng vòng, giữ nguyên best-so-far.
        match control.checkpoint() {
            Ok(()) => {}
            Err(Interrupt::Cancelled) => {
                cancelled = true;
                break;
            }
            Err(Interrupt::DeadlineReached) => {
                deadline_hit = true;
                break;
            }
            Err(Interrupt::WorkBudgetExhausted) => {
                budget_hit = true;
                break;
            }
        }

        let trial = run_trial(request, plan, effort, control).map_err(SolveError::Geometry)?;
        trials_run += 1;
        attempts += trial.attempts;
        orientation_evaluations += trial.orientation_evaluations;
        pose_refinements += trial.pose_refinements;
        match trial.interrupted {
            Some(Interrupt::Cancelled) => cancelled = true,
            Some(Interrupt::DeadlineReached) => deadline_hit = true,
            Some(Interrupt::WorkBudgetExhausted) => budget_hit = true,
            None => {}
        }

        // Validate TRƯỚC khi cho vào cuộc so sánh. Đây là điều làm cho một lỗi trong
        // candidates/refine không thể trở thành layout được công bố.
        let report = validate_layout(
            request,
            &LayoutUnderReview {
                placements: &trial.placements,
                unplaced: &trial.unplaced,
                stats: None,
            },
        );
        if !report.valid {
            trials_rejected += 1;
            continue;
        }
        candidates.push(ScoredCandidate {
            source: SolutionSource::Trial {
                trial_id: trial.trial_id,
            },
            placements: trial.placements,
            unplaced: trial.unplaced,
            score: trial.score,
        });

        if cancelled {
            break;
        }
    }

    // ── 3. Gộp: thứ tự toàn phần, không phụ thuộc thứ tự gộp ──
    let best = reduce_candidates(&candidates).expect("luôn có ít nhất baseline");

    // ── 4. Lý do kết thúc: hủy thắng deadline, deadline thắng work budget ──
    let all_placed = best.unplaced.is_empty();
    let termination_reason = if cancelled {
        TerminationReason::Cancelled
    } else if deadline_hit {
        TerminationReason::Deadline
    } else if budget_hit {
        TerminationReason::WorkBudgetExhausted
    } else if all_placed {
        TerminationReason::AllPlaced
    } else if best.sheet_limit_reached() {
        TerminationReason::MaxSheetsReached
    } else {
        TerminationReason::WorkBudgetExhausted
    };

    let stats = recompute_stats(
        request,
        &best.placements,
        &best.unplaced,
        RunCounters {
            elapsed_ms: control
                .progress()
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            attempts,
            orientation_evaluations,
            pose_refinements,
            termination_reason,
        },
    );

    // ── 5. Validate lần cuối chính phương án sẽ công bố, kèm cả thống kê ──
    let validation = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &best.placements,
            unplaced: &best.unplaced,
            stats: Some(&stats),
        },
    );
    if !validation.valid {
        // Không thể xảy ra vì mọi ứng viên đã validate; nhưng nếu thống kê lệch thì
        // vẫn phải fail thay vì công bố.
        return Err(SolveError::BaselineInvalid);
    }

    Ok(SolveOutcome {
        status: if cancelled {
            ManifestStatus::Cancelled
        } else {
            ManifestStatus::Completed
        },
        source: best.source,
        placements: best.placements.clone(),
        unplaced: best.unplaced.clone(),
        stats,
        validation,
        trials_run,
        trials_rejected,
    })
}

impl ScoredCandidate {
    /// Có con nào chưa xếp vì chạm trần số tờ hay không.
    fn sheet_limit_reached(&self) -> bool {
        self.unplaced
            .iter()
            .any(|record| record.reason == super::model::UnplacedReason::MaxSheetsReached)
    }
}
