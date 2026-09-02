//! Solver thông minh: một trial (P4).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2, §11.3, §11.4.
//!
//! ## Anytime heuristic, không phải tối ưu toàn cục
//!
//! §11.3 ghi rõ: "`free` không có nghĩa brute-force vô hạn góc. Solver là anytime
//! heuristic: lấy mẫu hữu hạn rồi tinh chỉnh liên tục trong miền hợp lệ; không cam kết
//! tối ưu toàn cục." Module này thực hiện đúng vòng đó cho **một** trial:
//!
//! ```text
//! với mỗi con (theo thứ tự của trial):
//!   với mỗi tờ (tờ đã mở trước, rồi mở tờ mới):
//!     với mỗi góc đề xuất (candidates::candidate_angles):
//!       miền vị trí hợp lệ ← nfp::feasible_region
//!       với mỗi vị trí ứng viên (đỉnh tiếp xúc, top-K theo beam):
//!         pose ← refine::refine_pose   ← tinh chỉnh LIÊN TỤC (theta, tx, ty)
//!       giữ pose tốt nhất theo mục tiêu cục bộ
//! ```
//!
//! Vì bước cuối là tinh chỉnh liên tục, pose công bố thường **không** nằm trong tập mẫu
//! ban đầu — đó là điều làm free-angle có thật thay vì chỉ có trên giấy.
//!
//! ## Kết quả của trial CHƯA được công bố
//!
//! Trial trả về một layout ứng viên. [`super::multi_start`] mới là nơi so với baseline và
//! cho qua [`super::validator`]. Không có đường nào để một trial tự công bố kết quả.

use super::candidates::{candidate_angles, order_parts, translation_candidates, PartOrder};
use super::control::{derive_trial_seed, Interrupt, NfpTelemetryPhase, RunControl, SearchEffort};
use super::model::{
    format_instance_id, PlacementRecord, PointMm, Pose, UnplacedReason, UnplacedRecord,
    MAX_INSTANCES_TOTAL,
};
use super::nfp::{
    feasible_region_after_with_clearance, feasible_region_cached,
    feasible_region_cached_with_clearance, NfpClearance, NfpError, RegionMm,
};
use super::nfp_cache::NfpCache;
use super::normalize::{NormalizedPart, NormalizedRequest};
use super::refine::{
    refine_pose, refine_pose_production, LocalObjective, ProductionRefineContext, RefineContext,
    RefinedPose,
};
use super::score::{score_layout, LayoutScore};

/// Version của vòng solver.
pub const SOLVER_VERSION: u32 = 4;

/// Kế hoạch của một trial. Hai trường quyết định toàn bộ hành vi, và cả hai đều **suy ra
/// từ seed gốc** nên trial nào chạy ở worker nào cũng cho cùng kết quả.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrialPlan {
    pub trial_id: u64,
    /// Seed dẫn xuất cố định từ `(seed gốc, trial_id)`.
    pub seed: u64,
    pub part_order: PartOrder,
}

/// Lập danh sách trial cho một lần chạy.
///
/// Số trial do [`SearchEffort::trial_count`] quyết định — tức do profile, tức do **lượng
/// công**, không phải do miền hợp lệ. Thứ tự chi tiết luân phiên qua
/// [`PartOrder::ALL`] để multi-start có nhiều điểm khởi đầu thật khác nhau.
pub fn plan_trials(root_seed: u64, effort: SearchEffort) -> Vec<TrialPlan> {
    (0..u64::from(effort.trial_count.max(1)))
        .map(|trial_id| TrialPlan {
            trial_id,
            seed: derive_trial_seed(root_seed, trial_id),
            part_order: PartOrder::ALL[(trial_id as usize) % PartOrder::ALL.len()],
        })
        .collect()
}

/// Kết quả một trial.
#[derive(Debug, Clone, PartialEq)]
pub struct TrialResult {
    pub trial_id: u64,
    pub placements: Vec<PlacementRecord>,
    pub unplaced: Vec<UnplacedRecord>,
    pub sheet_count: u32,
    pub score: LayoutScore,
    pub attempts: u64,
    pub orientation_evaluations: u64,
    pub pose_refinements: u64,
    /// Số sweep autofill đã hoàn tất và tạo thành publication barrier xác định.
    ///
    /// Luôn bằng 0 với bài toán có số lượng. Một trial bị deadline/work budget chỉ
    /// được multi-start cân nhắc khi giá trị này lớn hơn 0.
    pub completed_sweeps: u32,
    /// `true` khi trial bị ngắt giữa đường; layout vẫn hợp lệ nhưng chưa xếp hết.
    pub interrupted: Option<Interrupt>,
}

/// Lỗi của trial.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrialError {
    Nfp(NfpError),
    /// Solver chứng minh được pose thứ `MAX_INSTANCES_TOTAL + 1`.
    ///
    /// Đây là invariant engine/protocol, không phải sheet full hay dữ liệu hình học sai.
    CapacityInvariantExceeded,
}

impl From<NfpError> for TrialError {
    fn from(value: NfpError) -> Self {
        Self::Nfp(value)
    }
}

/// Chặn trước khi thêm placement tiếp theo; tách thành helper để test đúng biên MAX
/// mà không phải thực sự lồng 100.001 chi tiết.
fn ensure_autofill_capacity(current_len: usize) -> Result<(), TrialError> {
    if current_len >= MAX_INSTANCES_TOTAL as usize {
        Err(TrialError::CapacityInvariantExceeded)
    } else {
        Ok(())
    }
}

/// Miền ứng viên theo đúng ba lớp clearance của contract production.
///
/// FIX/PARITY (audit 2026-08-29 §MAP-NEST-07): fixed obstacle và part đã đặt không
/// được trộn vào một scalar max/hypot. Legacy vẫn đi nguyên API isotropic cũ.
#[allow(clippy::too_many_arguments)]
fn feasible_region_for_request(
    request: &NormalizedRequest,
    placement_bounds: &super::normalize::BoundsMm,
    existing: &[Vec<PointMm>],
    fixed_count: usize,
    moving: &[PointMm],
    cache: &mut NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    let Some(contract) = request.production_contract.as_ref() else {
        return feasible_region_cached(
            placement_bounds,
            existing,
            moving,
            request.conservative_solver_gap_mm(),
            &request.tolerance,
            cache,
            should_stop,
        );
    };

    let (fixed_obstacles, placed_parts) = existing.split_at(fixed_count);
    let Some(base) = feasible_region_cached_with_clearance(
        placement_bounds,
        fixed_obstacles,
        moving,
        NfpClearance::sheet_axis(contract.clearance.part_to_obstacle),
        &request.tolerance,
        cache,
        should_stop,
    )?
    else {
        return Ok(None);
    };
    feasible_region_after_with_clearance(
        base,
        placed_parts,
        moving,
        NfpClearance::sheet_axis(contract.clearance.part_to_part),
        &request.tolerance,
        cache,
        should_stop,
    )
}

#[allow(clippy::too_many_arguments)]
fn refine_for_request(
    request: &NormalizedRequest,
    part: &NormalizedPart,
    existing: &[Vec<PointMm>],
    fixed_count: usize,
    placement_bounds: &super::normalize::BoundsMm,
    start: &Pose,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<Option<RefinedPose>, Interrupt> {
    if let Some(contract) = request.production_contract.as_ref() {
        let (fixed_obstacles, placed_parts) = existing.split_at(fixed_count);
        return refine_pose_production(
            &ProductionRefineContext {
                part,
                placed_parts,
                fixed_obstacles,
                usable: placement_bounds,
                part_clearance: contract.clearance.part_to_part,
                obstacle_clearance: contract.clearance.part_to_obstacle,
                tol: request.tolerance,
            },
            start,
            effort,
            control,
        );
    }

    refine_pose(
        &RefineContext {
            part,
            placed: existing,
            usable: placement_bounds,
            gap_mm: request.conservative_solver_gap_mm(),
            tol: request.tolerance,
        },
        start,
        effort,
        control,
    )
}

/// Chạy một trial.
///
/// Bị hủy hoặc hết ngân sách **không** phải lỗi: trial trả về best-so-far với
/// `interrupted` đã đặt, đúng yêu cầu "timeout trả best-so-far hợp lệ" của §16.1. Các con
/// chưa xử lý được ghi `unplaced` với lý do `SEARCH_BUDGET_EXHAUSTED` hoặc `CANCELLED` —
/// §11.4 cấm báo chúng là "hình học không vừa".
pub fn run_trial(
    request: &NormalizedRequest,
    plan: TrialPlan,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<TrialResult, TrialError> {
    if request.layout_intent.is_single_sheet_autofill() {
        return run_autofill_trial(request, plan, effort, control);
    }

    let tol = request.tolerance;
    // PERF (audit 2026-08-28 §NFP-CACHE): một cache cho CẢ trial. NFP của một hình chỉ
    // dựng một lần rồi dùng lại cho mọi con cùng hình, mọi góc, mọi sweep. Cache theo
    // trial nên trial vẫn độc lập — `multi_start` chạy song song được mà không đổi kết quả.
    let mut nfp_cache = NfpCache::with_telemetry_and_resources(
        control.progress().clone(),
        NfpTelemetryPhase::Search,
        control.nfp_worker_grant(),
        control.nfp_cache_byte_budget(),
    );
    let fixed_obstacles: Vec<Vec<PointMm>> = request
        .fixed_obstacles()
        .iter()
        .map(|obstacle| obstacle.outer.clone())
        .collect();
    let fixed_count = fixed_obstacles.len();
    let ordered = order_parts(&request.parts, plan.part_order, &tol);

    // Danh sách con, giữ thứ tự của trial.
    struct Instance<'a> {
        part: &'a NormalizedPart,
        instance_id: String,
    }
    let mut instances: Vec<Instance<'_>> = Vec::new();
    for part in ordered {
        for ordinal in 1..=part.quantity {
            instances.push(Instance {
                part,
                instance_id: format_instance_id(&part.part_id, ordinal),
            });
        }
    }

    let mut placements: Vec<PlacementRecord> = Vec::new();
    let mut unplaced: Vec<UnplacedRecord> = Vec::new();
    let mut sheets: Vec<Vec<Vec<PointMm>>> = Vec::new();
    let mut attempts: u64 = 0;
    let mut orientation_evaluations: u64 = 0;
    let mut pose_refinements: u64 = 0;
    let mut interrupted: Option<Interrupt> = None;

    for (index, instance) in instances.iter().enumerate() {
        if interrupted.is_none() {
            if let Err(stop) = control.checkpoint() {
                interrupted = Some(stop);
            }
        }
        if let Some(stop) = interrupted {
            // Đã ngắt: mọi con còn lại ghi đúng lý do, không xếp thêm.
            unplaced.push(UnplacedRecord {
                instance_id: instance.instance_id.clone(),
                part_id: instance.part.part_id.clone(),
                reason: match stop {
                    Interrupt::Cancelled => UnplacedReason::Cancelled,
                    Interrupt::DeadlineReached | Interrupt::WorkBudgetExhausted => {
                        UnplacedReason::SearchBudgetExhausted
                    }
                },
            });
            continue;
        }

        let angles = candidate_angles(instance.part, effort, plan.seed ^ index as u64, &tol);
        let placement_bounds = request.placement_bounds_for(instance.part);
        let mut best: Option<(usize, Pose, Vec<PointMm>, LocalObjective)> = None;

        let sheet_limit = (sheets.len() + 1).min(request.sheet.max_sheets as usize);
        'sheet: for sheet_index in 0..sheet_limit {
            for angle in &angles {
                match control.checkpoint() {
                    Ok(()) => {}
                    Err(stop) => {
                        interrupted = Some(stop);
                        break 'sheet;
                    }
                }
                orientation_evaluations += 1;
                control.charge_evaluations(1);

                let Some(local) = local_ring_at(instance.part, *angle, &tol) else {
                    continue;
                };
                let existing: &[Vec<PointMm>] = sheets
                    .get(sheet_index)
                    .map_or(fixed_obstacles.as_slice(), |v| v.as_slice());
                let Some(region) = feasible_region_for_request(
                    request,
                    &placement_bounds,
                    existing,
                    fixed_count,
                    &local,
                    &mut nfp_cache,
                    Some(&|| control.checkpoint().is_err()),
                )?
                else {
                    // Bị ngắt GIỮA lúc dựng miền. Phải báo đúng lý do, không được để rơi
                    // xuống nhánh "hình học không vừa" — §11.4 cấm.
                    match control.checkpoint() {
                        Err(stop) => {
                            interrupted = Some(stop);
                            break 'sheet;
                        }
                        // Đua rất hẹp: lý do đã hết hiệu lực. Coi như chưa có chỗ ở góc
                        // này rồi thử góc kế — không bịa ra một lý do ngắt.
                        Ok(()) => continue,
                    }
                };
                if region.is_empty() {
                    continue;
                }
                for candidate in translation_candidates(&region, effort, &tol) {
                    attempts += 1;
                    control.charge_evaluations(1);
                    let start = Pose::new(*angle, candidate.x, candidate.y);
                    let refined = match refine_for_request(
                        request,
                        instance.part,
                        existing,
                        fixed_count,
                        &placement_bounds,
                        &start,
                        effort,
                        control,
                    ) {
                        Ok(Some(refined)) => refined,
                        Ok(None) => continue,
                        Err(stop) => {
                            interrupted = Some(stop);
                            break 'sheet;
                        }
                    };
                    pose_refinements += refined.evaluations;
                    let better = best
                        .as_ref()
                        .is_none_or(|(_, _, _, current)| refined.objective < *current);
                    if better {
                        best = Some((sheet_index, refined.pose, refined.ring, refined.objective));
                    }
                }
                // Tờ này đã có chỗ: không mở tờ mới cho con này nữa. Đây là điều giữ
                // cho solver không dùng nhiều tờ hơn cần thiết.
                if best.is_some() {
                    break 'sheet;
                }
            }
        }

        match best {
            Some((sheet_index, pose, ring, _)) => {
                while sheets.len() <= sheet_index {
                    sheets.push(fixed_obstacles.clone());
                }
                sheets[sheet_index].push(ring);
                placements.push(PlacementRecord {
                    instance_id: instance.instance_id.clone(),
                    part_id: instance.part.part_id.clone(),
                    sheet_index: sheet_index as u32,
                    pose,
                    source_revision: instance.part.source_revision.clone(),
                });
            }
            None => {
                let reason = if let Some(stop) = interrupted {
                    match stop {
                        Interrupt::Cancelled => UnplacedReason::Cancelled,
                        _ => UnplacedReason::SearchBudgetExhausted,
                    }
                } else {
                    unplaced_reason_for(
                        request,
                        instance.part,
                        &angles,
                        sheets.len(),
                        &fixed_obstacles,
                    )?
                };
                unplaced.push(UnplacedRecord {
                    instance_id: instance.instance_id.clone(),
                    part_id: instance.part.part_id.clone(),
                    reason,
                });
            }
        }
    }

    let score = score_layout(request, &placements, unplaced.len() as u64);
    Ok(TrialResult {
        trial_id: plan.trial_id,
        placements,
        unplaced,
        sheet_count: sheets.len() as u32,
        score,
        attempts,
        orientation_evaluations,
        pose_refinements,
        completed_sweeps: 0,
        interrupted,
    })
}

enum AutofillPlacement {
    Placed(Pose, Vec<PointMm>),
    NoFit,
    Interrupted(Interrupt),
}

/// Thử một instance bằng đúng pipeline smart solver hiện hữu trên tờ duy nhất.
///
/// [CHẶNG-A LÔ 2B 2026-08-27] Không thu hẹp miền xoay về góc vuông:
/// `candidate_angles` vẫn cấp góc khởi tạo và `refine_pose` tinh chỉnh liên tục
/// cả theta, X, Y. Caller sở hữu publication barrier của cả sweep.
#[allow(clippy::too_many_arguments)]
fn try_autofill_instance(
    request: &NormalizedRequest,
    part: &NormalizedPart,
    candidate_seed: u64,
    effort: SearchEffort,
    control: &RunControl,
    placed_rings: &[Vec<PointMm>],
    attempts: &mut u64,
    orientation_evaluations: &mut u64,
    pose_refinements: &mut u64,
    nfp_cache: &mut NfpCache,
) -> Result<AutofillPlacement, TrialError> {
    let tol = request.tolerance;
    let fixed_count = request.fixed_obstacles().len();
    let placement_bounds = request.placement_bounds_for(part);
    let angles = candidate_angles(part, effort, candidate_seed, &tol);
    let mut best: Option<(Pose, Vec<PointMm>, LocalObjective)> = None;

    for angle in &angles {
        if let Err(stop) = control.checkpoint() {
            return Ok(AutofillPlacement::Interrupted(stop));
        }
        *orientation_evaluations += 1;
        control.charge_evaluations(1);

        let Some(local) = local_ring_at(part, *angle, &tol) else {
            continue;
        };
        let Some(region) = feasible_region_for_request(
            request,
            &placement_bounds,
            placed_rings,
            fixed_count,
            &local,
            nfp_cache,
            Some(&|| control.checkpoint().is_err()),
        )?
        else {
            // Ngắt giữa lúc dựng miền: trả interrupt cho caller, đừng báo "không vừa".
            return Ok(match control.checkpoint() {
                Err(stop) => AutofillPlacement::Interrupted(stop),
                Ok(()) => AutofillPlacement::NoFit,
            });
        };
        if region.is_empty() {
            continue;
        }
        for candidate in translation_candidates(&region, effort, &tol) {
            *attempts += 1;
            control.charge_evaluations(1);
            let start = Pose::new(*angle, candidate.x, candidate.y);
            let refined = match refine_for_request(
                request,
                part,
                placed_rings,
                fixed_count,
                &placement_bounds,
                &start,
                effort,
                control,
            ) {
                Ok(Some(refined)) => refined,
                Ok(None) => continue,
                Err(stop) => return Ok(AutofillPlacement::Interrupted(stop)),
            };
            *pose_refinements += refined.evaluations;
            let better = best
                .as_ref()
                .is_none_or(|(_, _, current)| refined.objective < *current);
            if better {
                best = Some((refined.pose, refined.ring, refined.objective));
            }
        }
        // Giữ nguyên chính sách của đường quantity: góc đầu tiên có pose hợp lệ
        // kết thúc pha coarse; refine đã tối ưu theta liên tục quanh pose đó.
        if best.is_some() {
            break;
        }
    }

    Ok(match best {
        Some((pose, ring, _)) => AutofillPlacement::Placed(pose, ring),
        None => AutofillPlacement::NoFit,
    })
}

/// Smart autofill cho đúng một tờ, không dựng quantity/probe cap giả.
///
/// Mỗi sweep thử tối đa một instance của từng part. Part có ít placement hơn được
/// thử trước; tie-break bằng thứ tự ổn định của trial. Deadline/work budget giữa
/// sweep rollback placements, rings và counts về sweep hoàn chỉnh gần nhất.
fn run_autofill_trial(
    request: &NormalizedRequest,
    plan: TrialPlan,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<TrialResult, TrialError> {
    let tol = request.tolerance;
    let ordered = order_parts(&request.parts, plan.part_order, &tol);
    let mut counts: Vec<u32> = vec![0; ordered.len()];
    let mut placements: Vec<PlacementRecord> = Vec::new();
    let mut placed_rings: Vec<Vec<PointMm>> = request
        .fixed_obstacles()
        .iter()
        .map(|obstacle| obstacle.outer.clone())
        .collect();
    let fixed_ring_count = placed_rings.len();
    let mut attempts: u64 = 0;
    let mut orientation_evaluations: u64 = 0;
    let mut pose_refinements: u64 = 0;
    let mut completed_sweeps: u32 = 0;
    // PERF (audit 2026-08-28 §NFP-CACHE): xem chú thích ở `run_trial`.
    let mut nfp_cache = NfpCache::with_telemetry_and_resources(
        control.progress().clone(),
        NfpTelemetryPhase::Search,
        control.nfp_worker_grant(),
        control.nfp_cache_byte_budget(),
    );

    let interrupted = 'search: loop {
        let barrier_len = placements.len();
        let barrier_rings_len = placed_rings.len();
        let barrier_counts = counts.clone();
        if let Err(stop) = control.checkpoint() {
            break 'search Some(stop);
        }

        let sweep_index = completed_sweeps;
        let mut sweep_order: Vec<usize> = (0..ordered.len()).collect();
        sweep_order.sort_by(|left, right| counts[*left].cmp(&counts[*right]).then(left.cmp(right)));
        let mut placed_in_sweep = false;

        for base_rank in sweep_order {
            if let Err(stop) = control.checkpoint() {
                placements.truncate(barrier_len);
                placed_rings.truncate(barrier_rings_len);
                counts.clone_from(&barrier_counts);
                debug_assert_eq!(counts, barrier_counts);
                break 'search Some(stop);
            }
            let part = ordered[base_rank];
            let sweep_seed = derive_trial_seed(plan.seed, u64::from(sweep_index));
            let candidate_seed = derive_trial_seed(sweep_seed, base_rank as u64);
            match try_autofill_instance(
                request,
                part,
                candidate_seed,
                effort,
                control,
                &placed_rings,
                &mut attempts,
                &mut orientation_evaluations,
                &mut pose_refinements,
                &mut nfp_cache,
            )? {
                AutofillPlacement::Placed(pose, ring) => {
                    // Đã tìm được pose cho con kế tiếp: nếu đang ở MAX thì đây là
                    // invariant terminal, không được trả layout/barrier như sheet full.
                    ensure_autofill_capacity(placements.len())?;
                    counts[base_rank] += 1;
                    placements.push(PlacementRecord {
                        instance_id: format_instance_id(&part.part_id, counts[base_rank]),
                        part_id: part.part_id.clone(),
                        sheet_index: 0,
                        pose,
                        source_revision: part.source_revision.clone(),
                    });
                    placed_rings.push(ring);
                    placed_in_sweep = true;
                }
                AutofillPlacement::NoFit => {}
                AutofillPlacement::Interrupted(stop) => {
                    placements.truncate(barrier_len);
                    placed_rings.truncate(barrier_rings_len);
                    counts.clone_from(&barrier_counts);
                    debug_assert_eq!(counts, barrier_counts);
                    break 'search Some(stop);
                }
            }
        }

        debug_assert_eq!(fixed_ring_count + placements.len(), placed_rings.len());
        completed_sweeps = completed_sweeps.saturating_add(1);
        if !placed_in_sweep {
            break 'search None;
        }
    };

    let unplaced = Vec::new();
    let score = score_layout(request, &placements, 0);
    Ok(TrialResult {
        trial_id: plan.trial_id,
        sheet_count: u32::from(!placements.is_empty()),
        placements,
        unplaced,
        score,
        attempts,
        orientation_evaluations,
        pose_refinements,
        completed_sweeps,
        interrupted,
    })
}

#[cfg(test)]
mod capacity_tests {
    use super::*;

    #[test]
    fn capacity_guard_chan_dung_con_max_cong_mot() {
        assert_eq!(
            ensure_autofill_capacity(MAX_INSTANCES_TOTAL as usize - 1),
            Ok(())
        );
        assert_eq!(
            ensure_autofill_capacity(MAX_INSTANCES_TOTAL as usize),
            Err(TrialError::CapacityInvariantExceeded)
        );
    }
}

/// Contour của chi tiết trong hệ local tại một góc — điểm tham chiếu ở gốc.
fn local_ring_at(
    part: &NormalizedPart,
    angle_deg: f64,
    tol: &super::model::Tolerance,
) -> Option<Vec<PointMm>> {
    super::transform::place_ring_checked(
        &part.outer,
        &Pose::new(angle_deg, 0.0, 0.0),
        part.reference_point_mm,
        tol,
    )
    .ok()
}

/// Phân biệt hai lý do chưa xếp được, theo §11.4.
///
/// "Chi tiết quá khổ ở mọi hướng hợp lệ" và "đã chạm trần số tờ" là hai chuyện khác nhau
/// hẳn với thợ in: một cái phải sửa bản mẫu, một cái chỉ cần cho thêm tờ.
fn unplaced_reason_for(
    request: &NormalizedRequest,
    part: &NormalizedPart,
    angles: &[f64],
    sheets_open: usize,
    fixed_obstacles: &[Vec<PointMm>],
) -> Result<UnplacedReason, TrialError> {
    let placement_bounds = request.placement_bounds_for(part);
    let mut fits_empty_sheet = false;
    let mut nfp_cache = NfpCache::new();
    for angle in angles {
        let Some(local) = local_ring_at(part, *angle, &request.tolerance) else {
            continue;
        };
        if !feasible_region_for_request(
            request,
            &placement_bounds,
            fixed_obstacles,
            fixed_obstacles.len(),
            &local,
            &mut nfp_cache,
            None,
        )?
        .unwrap_or_default()
        .is_empty()
        {
            fits_empty_sheet = true;
            break;
        }
    }
    Ok(if !fits_empty_sheet {
        UnplacedReason::NoFeasiblePose
    } else if sheets_open >= request.sheet.max_sheets as usize {
        UnplacedReason::MaxSheetsReached
    } else {
        UnplacedReason::NoFeasiblePose
    })
}
