//! Multi-start và điều phối công bố kết quả (P4).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.1, §11.3, §11.6, §12.2.
//!
//! ## Bốn cam kết mà module này thực thi
//!
//! 1. **Không bao giờ tệ hơn baseline hợp lệ.** Baseline luôn được chạy và được đưa vào
//!    tập ứng viên sau khi validate. Riêng autofill, baseline rẻ có thể thiếu một design
//!    chỉ vừa ở cửa sổ góc hẹp; khi đó nó không được công bố nhưng smart trial vẫn được
//!    quyền rescue thay vì bị heuristic baseline chặn từ cửa (§11.1).
//! 2. **Không công bố layout chưa validate.** Mỗi ứng viên đi qua
//!    [`super::validator::validate_layout`] *trước khi* được đưa vào cuộc so sánh. Ứng viên
//!    invalid bị **loại**, không phải "sửa nhẹ rồi công bố" (§11.6).
//! 3. **Gộp kết quả không phụ thuộc thứ tự.** [`reduce_candidates`] dùng thứ tự toàn phần
//!    của [`LayoutScore`], nên gộp theo thứ tự nào cũng cho cùng đáp án — điều kiện cần để
//!    fixed work-plan cho cùng kết quả bất kể số worker (§11.3).
//! 4. **Hết hạn/ngân sách trả best-so-far ở barrier hoàn chỉnh**; hủy là lỗi terminal và
//!    không tạo `SolveOutcome`. Trial đang dở luôn bị loại khỏi tập công bố (§12.3).
//!
//! ## Portfolio chạy song song nhưng không tranh ngân sách
//!
//! Trial là **độc lập**: mỗi trial chỉ đọc request và `(seed, trial_id, part_order)` của
//! chính nó. Module chia trước work-budget và grant NFP theo `trial_id`, chạy các wave bằng
//! scoped thread cục bộ rồi sort lại theo `trial_id` trước validate/reduce. Không dùng pool
//! Rayon toàn cục, không có atomic work-budget chung để trial hoàn tất sớm cướp phần trial
//! khác. Test `portfolio_fixed_work_giu_nguyen_ket_qua_voi_1_2_4_worker` chốt đầu ra.

use super::baseline::{
    run_baseline, run_rotation_probe_from_baseline, BaselineAnglePolicy, BaselineError,
};
use super::control::{
    Interrupt, JobPhase, ProgressMessageCode, RunControl, SearchEffort, SolvePhaseTimings,
};
use std::collections::BTreeMap;
use std::thread;
use std::time::Instant;

use super::model::{
    LayoutAlignment, ManifestStatus, PlacementRecord, RunStats, TerminationReason, UnplacedRecord,
};
use super::normalize::{BoundsMm, NormalizedRequest};
use super::score::{score_layout, sheet_envelopes, LayoutScore};
use super::solver::{plan_trials, run_trial, TrialError, TrialPlan, TrialResult};
use super::transform::place_ring_checked;
use super::validator::{
    recompute_stats, validate_layout, LayoutUnderReview, RunCounters, ValidationCode,
    ValidationReport,
};

/// Version của vòng multi-start.
pub const MULTI_START_VERSION: u32 = 5;

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
    /// Điểm baseline đã validate. `None` chỉ xảy ra ở autofill khi baseline chưa phủ
    /// đủ mỗi design và smart solver phải rescue trước khi được phép công bố.
    pub baseline_score: Option<LayoutScore>,
    /// Điểm của chính placements được công bố, trước khi rút gọn vào manifest.
    pub selected_score: LayoutScore,
    /// Số trial đã chạy xong.
    pub trials_run: u32,
    /// Số trial bị loại vì không qua validator — số này lớn là dấu hiệu solver có bệnh.
    pub trials_rejected: u32,
    /// PERF (audit 2026-08-30 §NEST-D0-C): wall-time các phase core, không tham gia
    /// score/fingerprint.
    pub phase_timings: SolvePhaseTimings,
    /// PERF (audit 2026-08-30 §NEST-NF-3): số liệu thực thi portfolio đã chốt tại
    /// barrier cuối. Chỉ dùng cho progress/log, không tham gia manifest hay score.
    pub portfolio_execution: PortfolioExecutionDiagnostics,
}

/// Số liệu thực thi portfolio của đúng một lượt solve thành công.
///
/// `completed_trials` đếm trial chạy tới terminal bình thường, kể cả candidate sau đó
/// bị validator loại. `interrupted_trials` đếm trial dừng ở completed barrier vì
/// deadline/work budget. `rejected_trials` là một chiều độc lập nên có thể giao với
/// interrupted ở autofill. Các counter này không tham gia quyết định chọn layout.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PortfolioExecutionDiagnostics {
    pub planned_trials: u64,
    pub dispatched_trials: u64,
    pub completed_trials: u64,
    pub interrupted_trials: u64,
    pub rejected_trials: u64,
    pub concurrency_limit: u64,
    pub waves_dispatched: u64,
    pub max_dispatched_wave_width: u64,
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

/// Lỗi khiến không công bố được gì.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SolveError {
    /// Ngay cả baseline cũng không qua validator. Đây là lỗi engine, phải fail job.
    BaselineInvalid,
    /// Hình học không dựng được vùng lồng ghép.
    Geometry(TrialError),
    /// Người dùng hủy: không được dựng manifest, kể cả baseline đã hoàn tất.
    Cancelled,
    /// Baseline bị ngắt trước khi có phương án nào.
    InterruptedBeforeAnyResult(Interrupt),
    /// Engine vẫn tìm được pose sau khi đã đạt trần contract.
    CapacityInvariantExceeded,
}

impl From<TrialError> for SolveError {
    fn from(error: TrialError) -> Self {
        match error {
            TrialError::Nfp(_) => Self::Geometry(error),
            TrialError::CapacityInvariantExceeded => Self::CapacityInvariantExceeded,
        }
    }
}

impl From<BaselineError> for SolveError {
    fn from(error: BaselineError) -> Self {
        match error {
            BaselineError::Interrupted(Interrupt::Cancelled) => Self::Cancelled,
            BaselineError::Interrupted(stop) => Self::InterruptedBeforeAnyResult(stop),
            BaselineError::Nfp(error) => Self::Geometry(TrialError::Nfp(error)),
            BaselineError::CapacityInvariantExceeded => Self::CapacityInvariantExceeded,
        }
    }
}

/// Publication fence chỉ xét hủy trực tiếp.
///
/// Deadline/work budget không được chặn một barrier đã hoàn tất; hai tín hiệu đó chỉ
/// dừng smart search và vẫn công bố best completed candidate.
fn reject_cancelled(control: &RunControl) -> Result<(), SolveError> {
    if control.cancel_token().is_cancelled() {
        Err(SolveError::Cancelled)
    } else {
        Ok(())
    }
}

/// Quota bất biến của một trial. Không trường nào thay đổi theo thứ tự thread hoàn tất.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrialAllocation {
    plan: TrialPlan,
    evaluation_budget: u64,
    nfp_worker_grant: usize,
}

#[derive(Debug)]
struct ExecutedTrial {
    trial_id: u64,
    result: Result<TrialResult, TrialError>,
    evaluations: u64,
}

/// Chia số nguyên theo rank: phần dư thuộc các `trial_id` nhỏ hơn.
fn quota_by_rank(total: u64, count: usize, rank: usize) -> u64 {
    debug_assert!(count > 0 && rank < count);
    let count_u64 = u64::try_from(count).unwrap_or(u64::MAX);
    let rank_u64 = u64::try_from(rank).unwrap_or(u64::MAX);
    total / count_u64 + u64::from(rank_u64 < total % count_u64)
}

/// Lập quota worker/work cố định trước khi mở thread.
///
/// Worker được chia theo slot của mỗi wave. Tổng quota của một wave đầy luôn đúng bằng
/// grant đã admission; wave cuối có thể dùng ít hơn nhưng không bao giờ vượt. Work-budget
/// được chia trên toàn bộ trial, nên chạy 1/2/N worker dùng đúng cùng quota theo `trial_id`.
fn allocate_trials(
    mut plans: Vec<TrialPlan>,
    total_evaluation_budget: u64,
    total_worker_grant: usize,
) -> (Vec<TrialAllocation>, usize) {
    plans.sort_by_key(|plan| plan.trial_id);
    let trial_count = plans.len();
    if trial_count == 0 {
        return (Vec::new(), 0);
    }

    let worker_grant = total_worker_grant.max(1);
    let concurrent_trials = worker_grant.min(trial_count);
    let base_workers = worker_grant / concurrent_trials;
    let extra_worker_slots = worker_grant % concurrent_trials;
    let allocations = plans
        .into_iter()
        .enumerate()
        .map(|(rank, plan)| {
            let slot = rank % concurrent_trials;
            TrialAllocation {
                plan,
                evaluation_budget: quota_by_rank(total_evaluation_budget, trial_count, rank),
                nfp_worker_grant: base_workers + usize::from(slot < extra_worker_slots),
            }
        })
        .collect();
    (allocations, concurrent_trials)
}

/// Chạy đúng một wave bằng scoped thread cục bộ.
///
/// Mỗi child control có evaluation atomic và NFP cache riêng. Deadline được fork từ cùng
/// mốc tuyệt đối của parent. Work thực dùng được charge vào parent **trước** cancel fence.
/// Sau join, lỗi được chọn theo `trial_id` thấp nhất; caller chỉ nhận các kết quả thành
/// công đã sort và phải validate/drop ngay trước khi dispatch wave kế.
fn execute_trial_wave(
    request: &NormalizedRequest,
    effort: SearchEffort,
    control: &RunControl,
    wave: &[TrialAllocation],
) -> Result<Vec<TrialResult>, SolveError> {
    let mut executed = thread::scope(|scope| {
        let handles: Vec<_> = wave
            .iter()
            .copied()
            .map(|allocation| {
                let trial_control = control.fork_for_trial(
                    allocation.evaluation_budget,
                    allocation.nfp_worker_grant,
                    control.nfp_cache_byte_budget(),
                );
                scope.spawn(move || {
                    let result = run_trial(request, allocation.plan, effort, &trial_control);
                    ExecutedTrial {
                        trial_id: allocation.plan.trial_id,
                        result,
                        evaluations: trial_control.evaluations(),
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("scoped trial worker không được panic"))
            .collect::<Vec<_>>()
    });
    executed.sort_by_key(|trial| trial.trial_id);
    let charged = executed.iter().fold(0_u64, |total, trial| {
        total.saturating_add(trial.evaluations)
    });
    control.charge_evaluations(charged);
    reject_cancelled(control)?;

    // Vì vector đã sort, lỗi đầu tiên luôn thuộc trial_id thấp nhất — không phụ thuộc
    // worker nào hoàn tất trước. Trả lỗi tại đây bảo đảm wave sau không được dispatch.
    if let Some(error) = executed
        .iter()
        .find_map(|trial| trial.result.as_ref().err())
    {
        return Err((*error).into());
    }
    Ok(executed
        .into_iter()
        .map(|trial| {
            let result = trial
                .result
                .expect("đã loại mọi lỗi trial trước khi lấy kết quả wave");
            debug_assert_eq!(result.trial_id, trial.trial_id);
            result
        })
        .collect())
}

#[cfg(test)]
mod portfolio_allocation_tests {
    use super::*;
    use crate::mixed_nesting::candidates::PartOrder;

    fn plan(trial_id: u64) -> TrialPlan {
        TrialPlan {
            trial_id,
            seed: trial_id + 10,
            part_order: PartOrder::AreaDescending,
        }
    }

    #[test]
    fn quota_duoc_chia_truoc_theo_trial_id_va_khong_vuot_grant_moi_wave() {
        let plans = vec![plan(3), plan(1), plan(0), plan(2)];
        let (allocations, concurrency) = allocate_trials(plans, 10, 7);
        assert_eq!(concurrency, 4);
        assert_eq!(
            allocations
                .iter()
                .map(|item| item.plan.trial_id)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert_eq!(
            allocations
                .iter()
                .map(|item| item.evaluation_budget)
                .collect::<Vec<_>>(),
            vec![3, 3, 2, 2]
        );
        assert_eq!(
            allocations
                .iter()
                .map(|item| item.nfp_worker_grant)
                .collect::<Vec<_>>(),
            vec![2, 2, 2, 1]
        );
        assert_eq!(
            allocations
                .chunks(concurrency)
                .map(|wave| wave.iter().map(|item| item.nfp_worker_grant).sum::<usize>())
                .max(),
            Some(7)
        );
    }

    #[test]
    fn grant_nho_hon_so_trial_tao_wave_co_tong_khong_vuot_grant() {
        let plans = (0..5).map(plan).collect();
        let (allocations, concurrency) = allocate_trials(plans, 13, 2);
        assert_eq!(concurrency, 2);
        assert_eq!(
            allocations
                .iter()
                .map(|item| item.evaluation_budget)
                .collect::<Vec<_>>(),
            vec![3, 3, 3, 2, 2]
        );
        assert!(allocations
            .chunks(concurrency)
            .all(|wave| { wave.iter().map(|item| item.nfp_worker_grant).sum::<usize>() <= 2 }));
    }
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

/// Giữ tối đa một candidate trong mỗi nhánh portfolio.
///
/// Chỉ thay khi điểm **tốt hơn nghiêm ngặt**. Vì caller đưa trial theo `trial_id` tăng
/// dần, candidate bằng điểm giữ ID thấp hơn giống hệt [`reduce_candidates`], nhưng RAM
/// không tăng theo số trial.
fn retain_best_candidate(slot: &mut Option<ScoredCandidate>, candidate: ScoredCandidate) {
    if slot
        .as_ref()
        .is_none_or(|current| candidate.score.is_better_than(&current.score))
    {
        *slot = Some(candidate);
    }
}

/// Danh sách unplaced dùng cho validator của candidate nội bộ.
///
/// Autofill không có số lượng đích và luôn công bố `unplaced=[]`. Baseline động từ
/// Chặng A Lô 2A đã có đúng hình dạng đó; đường trial cũ còn được lọc qua lát cắt này
/// trong thời gian chuyển tiếp tới Lô 2B. Validator phải kiểm đúng artifact sẽ công bố.
fn unplaced_de_validate<'a>(
    request: &NormalizedRequest,
    unplaced: &'a [UnplacedRecord],
) -> &'a [UnplacedRecord] {
    if request.layout_intent.quantity_la_yeu_cau() {
        unplaced
    } else {
        &[]
    }
}

fn aligned_axis_shift(
    alignment: LayoutAlignment,
    lower: f64,
    upper: f64,
    usable_lower: f64,
    usable_upper: f64,
    horizontal: bool,
) -> f64 {
    if horizontal {
        match alignment {
            LayoutAlignment::TopLeft
            | LayoutAlignment::CenterLeft
            | LayoutAlignment::BottomLeft => return usable_lower - lower,
            LayoutAlignment::TopRight
            | LayoutAlignment::CenterRight
            | LayoutAlignment::BottomRight => return usable_upper - upper,
            _ => {}
        }
    } else {
        match alignment {
            LayoutAlignment::BottomLeft
            | LayoutAlignment::BottomCenter
            | LayoutAlignment::BottomRight => return usable_lower - lower,
            LayoutAlignment::TopLeft | LayoutAlignment::TopCenter | LayoutAlignment::TopRight => {
                return usable_upper - upper
            }
            _ => {}
        }
    }
    ((usable_lower + usable_upper) - (lower + upper)) / 2.0
}

/// Căn toàn bộ cụm đúng một lần theo từng tờ, sau khi đã chọn candidate.
///
/// NEST (audit 2026-08-29 §NEST-CENTER-1/2): solver vẫn tìm kiếm bottom-left để
/// không mở rộng hot path. Exact alignment phải qua cùng final validator. Nếu fixed
/// obstacle làm phép dịch chính xác không khả thi, giữ nguyên candidate đã hợp lệ;
/// không chia đôi đoạn dịch vì feasibility không đơn điệu trên obstacle rời rạc.
fn align_for_publication(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
    unplaced: &[UnplacedRecord],
) -> Vec<PlacementRecord> {
    let Some(production) = request.production_contract.as_ref() else {
        return placements.to_vec();
    };
    let Some(envelopes) = sheet_envelopes(request, placements) else {
        return placements.to_vec();
    };

    let tol = request.tolerance;
    let parts = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), part))
        .collect::<BTreeMap<_, _>>();
    let mut shift_intervals: BTreeMap<u32, BoundsMm> = BTreeMap::new();
    for record in placements {
        let Some(part) = parts.get(record.part_id.as_str()) else {
            return placements.to_vec();
        };
        let Ok(ring) = place_ring_checked(&part.outer, &record.pose, part.reference_point_mm, &tol)
        else {
            return placements.to_vec();
        };
        let Some(bounds) = BoundsMm::from_ring(&ring) else {
            return placements.to_vec();
        };
        let effective = request.placement_bounds_for(part);
        let interval = BoundsMm {
            min_x: effective.min_x - tol.linear_mm - bounds.min_x,
            min_y: effective.min_y - tol.linear_mm - bounds.min_y,
            max_x: effective.max_x + tol.linear_mm - bounds.max_x,
            max_y: effective.max_y + tol.linear_mm - bounds.max_y,
        };
        if ![
            interval.min_x,
            interval.min_y,
            interval.max_x,
            interval.max_y,
        ]
        .into_iter()
        .all(f64::is_finite)
        {
            return placements.to_vec();
        }

        // FIX (audit 2026-08-29 §MAP-NEST-H2): mọi mẫu trên cùng tờ phải nhận
        // đúng một rigid shift; giao interval giữ tương quan và không tạo va chạm mới.
        shift_intervals
            .entry(record.sheet_index)
            .and_modify(|current| {
                current.min_x = current.min_x.max(interval.min_x);
                current.min_y = current.min_y.max(interval.min_y);
                current.max_x = current.max_x.min(interval.max_x);
                current.max_y = current.max_y.min(interval.max_y);
            })
            .or_insert(interval);
    }

    let usable = request.sheet.usable;
    let mut shifts: BTreeMap<u32, (f64, f64)> = BTreeMap::new();
    for (sheet_index, bounds) in envelopes {
        let Some(interval) = shift_intervals.get(&sheet_index) else {
            return placements.to_vec();
        };
        if interval.min_x > interval.max_x || interval.min_y > interval.max_y {
            return placements.to_vec();
        }
        let desired_dx = aligned_axis_shift(
            production.alignment,
            bounds.min_x,
            bounds.max_x,
            usable.min_x,
            usable.max_x,
            true,
        );
        let desired_dy = aligned_axis_shift(
            production.alignment,
            bounds.min_y,
            bounds.max_y,
            usable.min_y,
            usable.max_y,
            false,
        );
        if !desired_dx.is_finite() || !desired_dy.is_finite() {
            return placements.to_vec();
        }
        shifts.insert(
            sheet_index,
            (
                desired_dx.clamp(interval.min_x, interval.max_x),
                desired_dy.clamp(interval.min_y, interval.max_y),
            ),
        );
    }

    let mut aligned = placements.to_vec();
    for record in &mut aligned {
        let Some((dx, dy)) = shifts.get(&record.sheet_index) else {
            return placements.to_vec();
        };
        record.pose.translate_x_mm += dx;
        record.pose.translate_y_mm += dy;
    }

    let report = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &aligned,
            unplaced,
            stats: None,
        },
    );
    if report.valid {
        aligned
    } else {
        placements.to_vec()
    }
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
    let core_started = Instant::now();
    // PERF (audit 2026-08-30 §NEST-NF-3): mỗi nhánh chỉ giữ ứng viên tốt nhất.
    // Không giữ toàn bộ placements của mọi trial tới cuối run.
    let mut best_baseline_candidate: Option<ScoredCandidate> = None;
    let mut best_smart_candidate: Option<ScoredCandidate> = None;
    let mut deadline_hit = false;
    let mut budget_hit = false;

    // ── 1. Baseline: sàn an toàn, luôn chạy trước ──
    let baseline_started = Instant::now();
    let baseline = match run_baseline(request, control, baseline_policy) {
        Ok(outcome) => outcome,
        Err(error) => {
            // Cancel thắng race kể cả khi vòng nóng vừa phát hiện một lỗi terminal khác.
            reject_cancelled(control)?;
            return Err(error.into());
        }
    };
    let baseline_ms = elapsed_ms(baseline_started);

    let baseline_validation_started = Instant::now();
    reject_cancelled(control)?;
    let baseline_report = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &baseline.placements,
            unplaced: unplaced_de_validate(request, &baseline.unplaced),
            stats: None,
        },
    );
    let chi_thieu_design_autofill = !request.layout_intent.quantity_la_yeu_cau()
        && !request.layout_intent.prefers_periodic_motif()
        && !baseline_report.issues.is_empty()
        && baseline_report
            .issues
            .iter()
            .all(|issue| issue.code == ValidationCode::MissingAutofillPart);
    if !baseline_report.valid && !chi_thieu_design_autofill {
        // Mọi lỗi baseline khác vẫn là lỗi engine. Không được dùng rescue để che lỗi
        // transform, collision, quantity hay thống kê.
        return Err(SolveError::BaselineInvalid);
    }
    // NESTROW (audit 2026-09-07 §NESTROW.1): validator va chạm không chứng minh nhịp
    // lặp. S&R chỉ công bố baseline đã được dựng theo motif; nếu thiếu, không dùng
    // generic rescue để âm thầm đổi thành xếp dàn tự do. N-up vẫn giữ rescue/score cũ.
    if request.layout_intent.prefers_periodic_motif() && !baseline.periodic_motif {
        return Err(SolveError::BaselineInvalid);
    }
    let step_repeat_baseline_locked = request.layout_intent.prefers_periodic_motif()
        && baseline_report.valid
        && baseline.periodic_motif;
    reject_cancelled(control)?;
    let mut baseline_score = if baseline_report.valid {
        let baseline_score = score_layout(
            request,
            &baseline.placements,
            baseline.unplaced.len() as u64,
        );
        best_baseline_candidate = Some(ScoredCandidate {
            source: SolutionSource::Baseline,
            placements: baseline.placements.clone(),
            unplaced: baseline.unplaced.clone(),
            score: baseline_score.clone(),
        });
        Some(baseline_score)
    } else {
        None
    };

    let mut attempts = baseline.attempts;
    let mut orientation_evaluations = baseline.orientation_evaluations;
    let mut pose_refinements: u64 = 0;
    let mut trials_run: u32 = 0;
    let mut trials_rejected: u32 = 0;
    let baseline_validation_ms = elapsed_ms(baseline_validation_started);
    match control.checkpoint_deadline_only() {
        Ok(()) => {}
        Err(Interrupt::Cancelled) => return Err(SolveError::Cancelled),
        Err(Interrupt::DeadlineReached) => deadline_hit = true,
        Err(Interrupt::WorkBudgetExhausted) => {
            unreachable!("checkpoint baseline không đọc work budget")
        }
    }

    // Autofill chưa đủ mọi design không có candidate an toàn để công bố. Cho riêng
    // đường rescue đúng một cửa sổ mới kể cả khi deadline cũ còn rất ít thời gian;
    // nếu chỉ nạp lại sau khi nó đã hết, trial đầu có thể bị cắt giữa sweep và không
    // tạo được candidate đủ mẫu. Đường baseline hợp lệ không đi qua ngoại lệ này.
    if chi_thieu_design_autofill {
        control.rearm_deadline_for_required_rescue();
        deadline_hit = false;
    }

    // ── 2. Warm-start xoay rẻ từ baseline autofill ──
    //
    // PERF (audit 2026-08-29 §ROTATION-WARM-START): deadline 3 giây có thể cắt smart
    // trial giữa sweep đầu, khiến nó rollback về barrier rỗng và không có candidate nào
    // tranh với baseline toàn 0°. Probe prefix cố định này chỉ thay một pose và vẫn qua
    // validator độc lập. Baseline gốc ở nguyên trong tập ứng viên nên sàn chất lượng
    // không thể mất.
    control.progress().set_phase(JobPhase::Nesting);
    control
        .progress()
        .set_message(ProgressMessageCode::SearchingPoses);
    control.progress().set_progress(0.35);
    let rotation_probe_started = Instant::now();
    if baseline_report.valid && !step_repeat_baseline_locked && !deadline_hit {
        let baseline_score_for_probe = baseline_score
            .as_ref()
            .expect("baseline hợp lệ phải có điểm trước rotation probe");
        let probe = match run_rotation_probe_from_baseline(
            request,
            &baseline,
            baseline_score_for_probe,
            control,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                reject_cancelled(control)?;
                return Err(error.into());
            }
        };
        attempts += probe.attempts;
        orientation_evaluations += probe.orientation_evaluations;
        reject_cancelled(control)?;

        if let Some((placements, probe_score)) = probe.placements.zip(probe.score) {
            let report = validate_layout(
                request,
                &LayoutUnderReview {
                    placements: &placements,
                    unplaced: unplaced_de_validate(request, &baseline.unplaced),
                    stats: None,
                },
            );
            reject_cancelled(control)?;
            if report.valid {
                // PERF (audit 2026-08-29 §ROTATION-WARM-START): probe đã tính điểm
                // trên chính placements này; validator không thay đổi candidate, nên dùng lại
                // để không transform toàn bộ contour thêm một lần.
                // Probe là một thành viên của portfolio baseline. `baselineScore` trong
                // manifest phải là sàn mạnh nhất của cả portfolio; nếu vẫn giữ điểm của
                // baseline gốc thì candidate mang nhãn `baseline` nhưng selectedScore
                // khác baselineScore và native validator sẽ từ chối công bố.
                if baseline_score
                    .as_ref()
                    .is_none_or(|current| probe_score.is_better_than(current))
                {
                    baseline_score = Some(probe_score.clone());
                    best_baseline_candidate = Some(ScoredCandidate {
                        // Probe là một thành viên của portfolio baseline, không phải smart
                        // trial và không tiêu trial_id/work budget.
                        source: SolutionSource::Baseline,
                        score: probe_score,
                        placements,
                        unplaced: baseline.unplaced.clone(),
                    });
                }
            }
        }
    }
    let rotation_probe_ms = elapsed_ms(rotation_probe_started);
    match control.checkpoint_deadline_only() {
        Ok(()) => {}
        Err(Interrupt::Cancelled) => return Err(SolveError::Cancelled),
        Err(Interrupt::DeadlineReached) => deadline_hit = true,
        Err(Interrupt::WorkBudgetExhausted) => {
            unreachable!("checkpoint probe không đọc work budget")
        }
    }

    // ── 3. Các trial ──
    //
    // PERF (audit 2026-09-02 §PERF-NEST-04): deadline giữ nguyên mốc từ lúc tạo
    // RunControl. Không nạp lại sau baseline; tổng cooperative là baseline/probe/search.
    // Publication/final validator vẫn được phép hoàn tất để không xuất artifact chưa kiểm.
    let search_started = Instant::now();
    control.progress().set_phase(JobPhase::Improving);
    control
        .progress()
        .set_message(ProgressMessageCode::ImprovingLayout);
    control.progress().set_progress(0.55);
    // PERF (audit 2026-08-30 §NEST-NF-3): baseline ở trên đã dùng toàn bộ NFP grant.
    // Từ đây grant được chia cố định cho trial theo ID và chạy bằng scoped threads cục bộ.
    // Mỗi trial có cache + evaluation atomic riêng; chỉ telemetry aggregate dùng chung.
    // PERF (audit 2026-08-31 §NEST-SR-AUTHORITATIVE): baseline S&R đã được
    // validator xác nhận là kết quả chế bản authoritative. Không dispatch portfolio
    // free-nesting rồi bỏ kết quả hoặc phá nhịp lặp; đây là loại bỏ công việc sai
    // contract, không phải giảm budget/cap máy mạnh. N-up autofill thường vẫn chạy đủ
    // trial.
    let (allocations, concurrent_trials) = if step_repeat_baseline_locked {
        (Vec::new(), 1)
    } else {
        allocate_trials(
            plan_trials(request.seed, effort),
            control.remaining_evaluation_budget(),
            control.nfp_worker_grant(),
        )
    };
    let mut portfolio_execution = PortfolioExecutionDiagnostics {
        planned_trials: u64::try_from(allocations.len()).unwrap_or(u64::MAX),
        concurrency_limit: u64::try_from(concurrent_trials).unwrap_or(u64::MAX),
        ..PortfolioExecutionDiagnostics::default()
    };
    for wave in allocations.chunks(concurrent_trials.max(1)) {
        // WorkBudgetExhausted ở parent không chặn dispatch: quota mỗi child đã được chia
        // trước. Cancel/deadline vẫn là barrier chung và deadline không nạp lại giữa wave.
        match control.checkpoint() {
            Ok(()) | Err(Interrupt::WorkBudgetExhausted) => {}
            Err(Interrupt::Cancelled) => return Err(SolveError::Cancelled),
            Err(Interrupt::DeadlineReached) => {
                deadline_hit = true;
                break;
            }
        }

        let wave_width = u64::try_from(wave.len()).unwrap_or(u64::MAX);
        portfolio_execution.dispatched_trials = portfolio_execution
            .dispatched_trials
            .saturating_add(wave_width);
        portfolio_execution.waves_dispatched =
            portfolio_execution.waves_dispatched.saturating_add(1);
        portfolio_execution.max_dispatched_wave_width = portfolio_execution
            .max_dispatched_wave_width
            .max(wave_width);

        // Wave được join, charge, sort và fail theo trial_id ngay tại đây. Kết quả bị
        // ngắt/invalid được drop trước khi wave kế tiếp chạy; RAM chỉ giữ tối đa một wave
        // cộng một smart candidate tốt nhất.
        for trial in execute_trial_wave(request, effort, control, wave)? {
            attempts += trial.attempts;
            orientation_evaluations += trial.orientation_evaluations;
            pose_refinements += trial.pose_refinements;
            reject_cancelled(control)?;
            let stop_after_barrier = match trial.interrupted {
                Some(Interrupt::Cancelled) => return Err(SolveError::Cancelled),
                Some(Interrupt::DeadlineReached) => {
                    portfolio_execution.interrupted_trials =
                        portfolio_execution.interrupted_trials.saturating_add(1);
                    deadline_hit = true;
                    true
                }
                Some(Interrupt::WorkBudgetExhausted) => {
                    portfolio_execution.interrupted_trials =
                        portfolio_execution.interrupted_trials.saturating_add(1);
                    budget_hit = true;
                    true
                }
                None => {
                    portfolio_execution.completed_trials =
                        portfolio_execution.completed_trials.saturating_add(1);
                    trials_run += 1;
                    false
                }
            };
            // Quantity bị ngắt không có publication barrier hoàn chỉnh. Autofill thì có
            // thể công bố sweep gần nhất, nhưng chỉ sau ít nhất một sweep đầy đủ.
            if stop_after_barrier
                && (request.layout_intent.quantity_la_yeu_cau() || trial.completed_sweeps == 0)
            {
                continue;
            }

            let report = validate_layout(
                request,
                &LayoutUnderReview {
                    placements: &trial.placements,
                    unplaced: unplaced_de_validate(request, &trial.unplaced),
                    stats: None,
                },
            );
            reject_cancelled(control)?;
            if !report.valid {
                trials_rejected += 1;
                continue;
            }
            retain_best_candidate(
                &mut best_smart_candidate,
                ScoredCandidate {
                    source: SolutionSource::Trial {
                        trial_id: trial.trial_id,
                    },
                    placements: trial.placements,
                    unplaced: trial.unplaced,
                    score: trial.score,
                },
            );
        }
    }
    let search_ms = elapsed_ms(search_started);

    // ── 4. Gộp: thứ tự toàn phần, không phụ thuộc thứ tự gộp ──
    let publication_started = Instant::now();
    // PERF (audit 2026-08-30 §NEST-D0-C): phase Validating phải bắt đầu trước
    // final validator/alignment, không đặt trễ sau khi core đã xong.
    control.progress().set_phase(JobPhase::Validating);
    control
        .progress()
        .set_message(ProgressMessageCode::ValidatingLayout);
    control.progress().set_progress(0.9);
    reject_cancelled(control)?;
    // Autofill có thể bắt đầu với baseline thiếu design. Nếu mọi smart trial cũng
    // không dựng được một candidate đủ design thì fail closed, tuyệt đối không dựng
    // manifest từ baseline thiếu nội dung.
    let best = match (best_baseline_candidate, best_smart_candidate) {
        (Some(baseline), Some(_)) if step_repeat_baseline_locked => baseline,
        (Some(baseline), Some(smart)) if smart.score.is_better_than(&baseline.score) => smart,
        (Some(baseline), _) => baseline,
        (None, Some(smart)) => smart,
        (None, None) => return Err(SolveError::BaselineInvalid),
    };

    // ── 5. Công bố theo đúng ý định bố cục ──
    //
    // [CHẶNG-A LÔ 2A 2026-08-27] Autofill không có số lượng đích, nên mọi `unplaced`
    // nội bộ trên đường trial chuyển tiếp không phải nợ sản xuất và không được công bố.
    // `score.rs` chấm trực tiếp mức cân bằng và tổng placement của autofill.
    let autofill = !request.layout_intent.quantity_la_yeu_cau();
    let published_unplaced: Vec<UnplacedRecord> = if autofill {
        Vec::new()
    } else {
        best.unplaced.clone()
    };
    let published_placements =
        align_for_publication(request, &best.placements, &published_unplaced);

    // ── Lý do kết thúc: deadline thắng work budget ──
    let all_placed = best.unplaced.is_empty();
    let termination_reason = if deadline_hit {
        TerminationReason::Deadline
    } else if budget_hit {
        TerminationReason::WorkBudgetExhausted
    } else if autofill {
        // Baseline động chỉ dừng sau một sweep đầy đủ không đặt thêm được: tờ đã đầy
        // theo miền ứng viên của baseline, không phải "đã xếp hết quantity".
        TerminationReason::SheetFull
    } else if all_placed {
        TerminationReason::AllPlaced
    } else if best.sheet_limit_reached() {
        TerminationReason::MaxSheetsReached
    } else {
        TerminationReason::WorkBudgetExhausted
    };

    let stats = recompute_stats(
        request,
        &published_placements,
        &published_unplaced,
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

    // ── 6. Validate lần cuối chính phương án sẽ công bố, kèm cả thống kê ──
    let validation = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &published_placements,
            unplaced: &published_unplaced,
            stats: Some(&stats),
        },
    );
    if !validation.valid {
        // Không thể xảy ra vì mọi ứng viên đã validate; nhưng nếu thống kê lệch thì
        // vẫn phải fail thay vì công bố.
        return Err(SolveError::BaselineInvalid);
    }
    reject_cancelled(control)?;
    let selected_score = score_layout(
        request,
        &published_placements,
        published_unplaced.len() as u64,
    );
    let publication_ms = elapsed_ms(publication_started);
    let phase_timings = SolvePhaseTimings {
        baseline_ms,
        baseline_validation_ms,
        rotation_probe_ms,
        search_ms,
        publication_ms,
        core_total_ms: elapsed_ms(core_started),
    };
    portfolio_execution.rejected_trials = u64::from(trials_rejected);

    Ok(SolveOutcome {
        status: ManifestStatus::Completed,
        source: best.source,
        placements: published_placements,
        unplaced: published_unplaced,
        stats,
        validation,
        baseline_score,
        selected_score,
        trials_run,
        trials_rejected,
        phase_timings,
        portfolio_execution,
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
