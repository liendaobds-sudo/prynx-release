//! Hồi quy PERF (audit 2026-09-02 §PERF-NEST-04): deadline bao toàn bộ lượt solve.
//!
//! ## Bất biến khoá ở đây
//!
//! 1. Mốc deadline bắt đầu từ lúc tạo `RunControl`; baseline không mở lại một cửa sổ
//!    search mới.
//! 2. Quantity bị ngắt phải giữ đủ ledger `placements + unplaced = quantity`; mọi con
//!    chưa duyệt vì deadline/work budget mang `SearchBudgetExhausted`.
//! 3. Autofill chỉ công bố tại barrier của một sweep đầy đủ; deadline không được làm
//!    rơi riêng một design hay lọt partial sweep.
//! 4. Fixed-work không đọc đồng hồ và vẫn deterministic/byte-parity.
//! 5. Hủy trực tiếp của người dùng luôn thắng deadline lẫn work budget.

use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use imposition_core::mixed_nesting::baseline::{run_baseline, BaselineAnglePolicy};
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    LayoutIntent, MixedNestingRequest, OrientationPolicy, PartSpec, PointMm, Profile, Reflection,
    RotationConstraint, SheetMarginMm, SheetSpec, TerminationReason, UnplacedReason,
};
use imposition_core::mixed_nesting::multi_start::{solve, SolutionSource};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::solver::{plan_trials, run_trial};

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích
// ─────────────────────────────────────────────────────────────────────────────

fn pt(x: f64, y: f64) -> PointMm {
    PointMm::new(x, y)
}

fn rect(w: f64, h: f64) -> Vec<PointMm> {
    vec![pt(0.0, 0.0), pt(w, 0.0), pt(w, h), pt(0.0, h)]
}

fn part(id: &str, quantity: u32, outer: Vec<PointMm>) -> PartSpec {
    PartSpec {
        part_id: id.to_string(),
        quantity,
        outer,
        holes: Vec::new(),
        rotation_constraint: RotationConstraint::Inherit,
        reference_point_mm: Some(pt(0.0, 0.0)),
        geometry_hash: None,
        source_revision: None,
    }
}

fn normalized(parts: Vec<PartSpec>) -> NormalizedRequest {
    let request = MixedNestingRequest {
        seed: 20_260_828,
        profile: Profile::Fast,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: 700.0,
            height_mm: 1000.0,
            margin_mm: SheetMarginMm {
                left: 10.0,
                right: 10.0,
                top: 10.0,
                bottom: 10.0,
            },
            max_sheets: 20,
        },
        gap_mm: 3.0,
        layout_intent: LayoutIntent::QuantityFulfillment,
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    };
    normalize_request(&request).expect("request hợp lệ")
}

fn normalized_autofill(
    mut parts: Vec<PartSpec>,
    sheet_width_mm: f64,
    sheet_height_mm: f64,
) -> NormalizedRequest {
    for item in &mut parts {
        item.quantity = 0;
    }
    let request = MixedNestingRequest {
        seed: 20_260_902,
        profile: Profile::Fast,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: sheet_width_mm,
            height_mm: sheet_height_mm,
            margin_mm: SheetMarginMm {
                left: 0.0,
                right: 0.0,
                top: 0.0,
                bottom: 0.0,
            },
            max_sheets: 1,
        },
        gap_mm: 0.0,
        layout_intent: LayoutIntent::AutofillSingleSheet,
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    };
    normalize_request(&request).expect("autofill hợp lệ")
}

fn control_voi_ngan_sach(time_budget_ms: Option<u64>) -> RunControl {
    let stop = match time_budget_ms {
        Some(ms) => StopCriterion::with_deadline(u64::MAX, ms),
        None => StopCriterion::fixed_work_plan(u64::MAX),
    };
    RunControl::new(stop, CancelToken::new(), Arc::new(ProgressChannel::new()))
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Deadline toàn lượt và ưu tiên nguyên nhân dừng
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn deadline_0_giu_nguyen_truoc_va_sau_baseline_quantity() {
    // 0 ms là biên deterministic: test không phụ thuộc máy nhanh/chậm hay `sleep`.
    let request = normalized(vec![part("part-a", 12, rect(120.0, 90.0))]);
    let control = control_voi_ngan_sach(Some(0));
    assert_eq!(control.checkpoint(), Err(Interrupt::DeadlineReached));

    let baseline = run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed)
        .expect("quantity phải trả best-so-far có ledger đầy đủ");

    assert!(baseline.placements.is_empty());
    assert_eq!(baseline.unplaced.len(), 12);
    assert!(baseline
        .unplaced
        .iter()
        .all(|record| record.reason == UnplacedReason::SearchBudgetExhausted));
    assert_eq!(
        control.checkpoint(),
        Err(Interrupt::DeadlineReached),
        "baseline không được nạp lại deadline cho search"
    );
}

#[test]
fn work_plan_co_dinh_khong_doc_dong_ho_va_giu_parity_baseline() {
    let request = normalized(vec![part("part-a", 8, rect(90.0, 60.0))]);
    let exhausted = RunControl::new(
        StopCriterion::fixed_work_plan(0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    assert_eq!(exhausted.checkpoint(), Err(Interrupt::WorkBudgetExhausted));
    assert!(exhausted.stop_criterion().is_deterministic());

    let by_exhausted_work = run_baseline(&request, &exhausted, BaselineAnglePolicy::FirstAllowed)
        .expect("work budget trial không được cắt baseline fixed-work");
    let reference = run_baseline(
        &request,
        &control_voi_ngan_sach(None),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline tham chiếu phải hợp lệ");
    assert_eq!(by_exhausted_work, reference);
}

#[test]
fn huy_thang_ca_deadline_va_work_budget_da_het() {
    let cancel = CancelToken::new();
    let control = RunControl::new(
        StopCriterion::with_deadline(0, 0),
        cancel.clone(),
        Arc::new(ProgressChannel::new()),
    );
    cancel.cancel();

    assert_eq!(
        control.checkpoint(),
        Err(Interrupt::Cancelled),
        "thông báo cuối phải nói đúng nguyên nhân: người dùng hủy"
    );

    let request = normalized(vec![part("part-a", 2, rect(20.0, 20.0))]);
    assert!(matches!(
        solve(
            &request,
            SearchEffort::for_profile(Profile::Fast),
            &control,
            BaselineAnglePolicy::FirstAllowed,
        ),
        Err(imposition_core::mixed_nesting::multi_start::SolveError::Cancelled)
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Hệ quả đầu-cuối trong `solve`
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn deadline_0_khong_mo_cua_so_trial_moi_sau_baseline() {
    let request = normalized(vec![part("part-a", 12, rect(120.0, 90.0))]);
    let control = control_voi_ngan_sach(Some(0));

    let outcome = solve(
        &request,
        SearchEffort::for_profile(Profile::Fast),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("quantity phải công bố best-so-far có ledger hợp lệ");

    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(outcome.source, SolutionSource::Baseline);
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::Deadline
    );
    assert_eq!(outcome.stats.placed_count, 0);
    assert_eq!(outcome.unplaced.len(), 12);
    assert!(outcome
        .unplaced
        .iter()
        .all(|record| record.reason == UnplacedReason::SearchBudgetExhausted));
    assert_eq!(outcome.trials_run, 0);
    assert_eq!(outcome.portfolio_execution.dispatched_trials, 0);
}

#[test]
fn trial_bi_ngat_van_khai_du_unplaced_khong_am_tham_bo_con() {
    // Work budget 0 cắt trial ngay checkpoint đầu, không phụ thuộc wall-clock.
    let request = normalized(vec![part("part-a", 30, rect(150.0, 110.0))]);
    let effort = SearchEffort::for_profile(Profile::Fast);
    let plan = plan_trials(request.seed, effort)[0];
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let trial = run_trial(&request, plan, effort, &control).expect("trial phải trả ledger");

    // Bất biến kế toán: đặt + chưa đặt = tổng số lượng yêu cầu, mọi lúc.
    assert_eq!(
        trial.placements.len() + trial.unplaced.len(),
        30,
        "không con nào được biến mất khỏi sổ sách"
    );
    assert_eq!(trial.interrupted, Some(Interrupt::WorkBudgetExhausted));
    assert!(trial
        .unplaced
        .iter()
        .all(|record| record.reason == UnplacedReason::SearchBudgetExhausted));
}

#[test]
fn autofill_deadline_0_chi_cong_bo_sweep_dau_day_du() {
    let request = normalized_autofill(
        vec![
            part("part-a", 0, rect(20.0, 20.0)),
            part("part-b", 0, rect(20.0, 20.0)),
        ],
        100.0,
        80.0,
    );

    let outcome = solve(
        &request,
        SearchEffort::for_profile(Profile::Fast),
        &control_voi_ngan_sach(Some(0)),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline autofill phải hoàn tất barrier tối thiểu");

    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(outcome.source, SolutionSource::Baseline);
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::Deadline
    );
    assert_eq!(outcome.trials_run, 0);
    assert_eq!(outcome.portfolio_execution.dispatched_trials, 0);
    assert!(outcome.unplaced.is_empty());
    let count_a = outcome
        .placements
        .iter()
        .filter(|record| record.part_id == "part-a")
        .count();
    let count_b = outcome
        .placements
        .iter()
        .filter(|record| record.part_id == "part-b")
        .count();
    assert_eq!((count_a, count_b), (1, 1));
}

#[test]
fn autofill_trial_bi_ngat_chi_tra_barrier_sweep_hoan_chinh() {
    let request = normalized_autofill(
        vec![
            part("part-a", 0, rect(20.0, 20.0)),
            part("part-b", 0, rect(20.0, 20.0)),
        ],
        100.0,
        80.0,
    );
    let effort = SearchEffort {
        trial_count: 1,
        orientation_proposals_per_part: 4,
        beam_width: 1,
        refinement_rounds: 2,
        multi_start_restarts: 1,
        evaluation_budget: u64::MAX,
    };
    let plan = plan_trials(request.seed, effort)[0];

    // Dò theo work budget deterministic, không dùng sleep/deadline wall-clock.
    let mut found = None;
    for budget in 2..2_000 {
        let control = RunControl::new(
            StopCriterion::fixed_work_plan(budget),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        let trial = run_trial(&request, plan, effort, &control).expect("trial hợp lệ");
        if trial.interrupted == Some(Interrupt::WorkBudgetExhausted) && trial.completed_sweeps > 0 {
            found = Some((budget, trial));
            break;
        }
    }
    let (budget, barrier) = found.expect("phải tìm được budget dừng sau ít nhất một sweep");
    let count_a = barrier
        .placements
        .iter()
        .filter(|record| record.part_id == "part-a")
        .count();
    let count_b = barrier
        .placements
        .iter()
        .filter(|record| record.part_id == "part-b")
        .count();
    assert_eq!(count_a, count_b, "partial sweep đã lọt qua barrier");
    assert_eq!(count_a, barrier.completed_sweeps as usize);

    let replay_control = RunControl::new(
        StopCriterion::fixed_work_plan(budget),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let replay = run_trial(&request, plan, effort, &replay_control).expect("replay hợp lệ");
    assert_eq!(replay.placements, barrier.placements);
    assert_eq!(replay.score, barrier.score);
    assert_eq!(replay.completed_sweeps, barrier.completed_sweeps);
}

#[test]
fn autofill_thieu_design_duoc_cap_cua_so_rescue_day_du() {
    // Baseline Fast chỉ thử prefix góc rẻ; nan này chỉ vừa ở góc thứ 17. Control được
    // cố ý làm già trước solve nhưng chưa hết deadline: nếu chỉ rearm sau khi đã thấy
    // `deadline_hit`, smart trial rất dễ bị cắt giữa sweep đầu và không có candidate.
    let mut nan_a = part("part-a", 0, rect(139.0, 0.5));
    nan_a.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: (0..=15).map(f64::from).chain([60.0]).collect(),
    };
    let mut nan_b = nan_a.clone();
    nan_b.part_id = "part-b".to_string();
    let request = normalized_autofill(vec![nan_a, nan_b], 70.6, 250.0);

    let baseline = run_baseline(
        &request,
        &control_voi_ngan_sach(None),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline phải trả candidate thiếu design để rescue");
    assert!(
        baseline.placements.is_empty(),
        "fixture không còn thiếu design"
    );

    let control = control_voi_ngan_sach(Some(500));
    sleep(Duration::from_millis(400));
    assert_eq!(
        control.checkpoint(),
        Ok(()),
        "fixture phải vào solve khi deadline cũ còn một cửa sổ rất ngắn"
    );
    let outcome = solve(
        &request,
        SearchEffort::for_profile(Profile::Tight),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("rescue phải có trọn cửa sổ mới để phủ đủ design");
    assert!(
        outcome.phase_timings.search_ms >= 250,
        "rescue chỉ nhận {}ms, dấu hiệu vẫn dùng phần deadline cũ còn sót thay vì cửa sổ 500ms",
        outcome.phase_timings.search_ms
    );

    assert_eq!(outcome.source, SolutionSource::Trial { trial_id: 0 });
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert!(outcome
        .placements
        .iter()
        .any(|record| record.part_id == "part-a"));
    assert!(outcome
        .placements
        .iter()
        .any(|record| record.part_id == "part-b"));
}
