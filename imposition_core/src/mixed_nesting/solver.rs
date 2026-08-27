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
use super::control::{derive_trial_seed, Interrupt, RunControl, SearchEffort};
use super::model::{
    format_instance_id, PlacementRecord, PointMm, Pose, UnplacedReason, UnplacedRecord,
};
use super::nfp::{feasible_region, inner_fit_rect, NfpError};
use super::normalize::{NormalizedPart, NormalizedRequest};
use super::refine::{refine_pose, LocalObjective, RefineContext};
use super::score::{score_layout, LayoutScore};

/// Version của vòng solver.
pub const SOLVER_VERSION: u32 = 1;

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
    /// `true` khi trial bị ngắt giữa đường; layout vẫn hợp lệ nhưng chưa xếp hết.
    pub interrupted: Option<Interrupt>,
}

/// Lỗi của trial.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrialError {
    Nfp(NfpError),
}

impl From<NfpError> for TrialError {
    fn from(value: NfpError) -> Self {
        Self::Nfp(value)
    }
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
    let tol = request.tolerance;
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
                let existing: &[Vec<PointMm>] =
                    sheets.get(sheet_index).map_or(&[], |v| v.as_slice());
                let region = feasible_region(
                    &request.sheet.usable,
                    existing,
                    &local,
                    request.gap_mm,
                    &tol,
                )?;
                if region.is_empty() {
                    continue;
                }
                let context = RefineContext {
                    part: instance.part,
                    placed: existing,
                    usable: &request.sheet.usable,
                    gap_mm: request.gap_mm,
                    tol,
                };
                for candidate in translation_candidates(&region, effort, &tol) {
                    attempts += 1;
                    control.charge_evaluations(1);
                    let start = Pose::new(*angle, candidate.x, candidate.y);
                    let refined = match refine_pose(&context, &start, effort, control) {
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
                    sheets.push(Vec::new());
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
                    unplaced_reason_for(request, instance.part, &angles, sheets.len())
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
        interrupted,
    })
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
) -> UnplacedReason {
    let fits_empty_sheet = angles.iter().any(|angle| {
        local_ring_at(part, *angle, &request.tolerance)
            .and_then(|local| inner_fit_rect(&request.sheet.usable, &local, &request.tolerance))
            .is_some()
    });
    if !fits_empty_sheet {
        UnplacedReason::NoFeasiblePose
    } else if sheets_open >= request.sheet.max_sheets as usize {
        UnplacedReason::MaxSheetsReached
    } else {
        UnplacedReason::NoFeasiblePose
    }
}
