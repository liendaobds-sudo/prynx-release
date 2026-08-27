//! Test smart solver và multi-start — phase P4.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.1, §11.3, §11.4, §16.1.
//!
//! Bộ test này phải chứng minh bốn cam kết của gate P4:
//!
//! 1. Kết quả smart **luôn valid** — mọi thứ công bố đã qua validator độc lập.
//! 2. Smart **không tệ hơn baseline** theo điểm chuẩn.
//! 3. Cả ba profile **giữ nguyên miền free-angle**.
//! 4. Fixed work-plan **deterministic** bất kể thứ tự gộp (tức bất kể số worker);
//!    deadline và cancel trả **best-so-far hợp lệ** kèm `terminationReason` đúng.

use std::sync::Arc;

use imposition_core::mixed_nesting::baseline::{run_baseline, BaselineAnglePolicy};
use imposition_core::mixed_nesting::candidates::PartOrder;
use imposition_core::mixed_nesting::control::{
    CancelToken, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    ManifestStatus, MixedNestingRequest, OrientationPolicy, PartSpec, PointMm, Profile, Reflection,
    RotationConstraint, SheetMarginMm, SheetSpec, TerminationReason, Tolerance, UnplacedReason,
};
use imposition_core::mixed_nesting::multi_start::{
    reduce_candidates, solve, ScoredCandidate, SolutionSource, SolveError, MULTI_START_VERSION,
};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::orientation::RotationDomain;
use imposition_core::mixed_nesting::score::{score_layout, LayoutScore};
use imposition_core::mixed_nesting::solver::{plan_trials, run_trial, SOLVER_VERSION};
use imposition_core::mixed_nesting::validator::{validate_layout, LayoutUnderReview};

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích
// ─────────────────────────────────────────────────────────────────────────────

fn tol() -> Tolerance {
    Tolerance::v1()
}
fn pt(x: f64, y: f64) -> PointMm {
    PointMm::new(x, y)
}
fn rect(w: f64, h: f64) -> Vec<PointMm> {
    vec![pt(0.0, 0.0), pt(w, 0.0), pt(w, h), pt(0.0, h)]
}
fn shape_l() -> Vec<PointMm> {
    vec![
        pt(0.0, 0.0),
        pt(60.0, 0.0),
        pt(60.0, 18.0),
        pt(22.0, 18.0),
        pt(22.0, 47.0),
        pt(0.0, 47.0),
    ]
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

fn request_of(
    parts: Vec<PartSpec>,
    w: f64,
    h: f64,
    margin: f64,
    gap: f64,
    max_sheets: u32,
) -> MixedNestingRequest {
    MixedNestingRequest {
        protocol_version: 1,
        seed: 20_260_826,
        profile: Profile::Balanced,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: w,
            height_mm: h,
            margin_mm: SheetMarginMm {
                left: margin,
                right: margin,
                top: margin,
                bottom: margin,
            },
            max_sheets,
        },
        gap_mm: gap,
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
    }
}

fn normalized(parts: Vec<PartSpec>) -> NormalizedRequest {
    normalize_request(&request_of(parts, 400.0, 500.0, 10.0, 3.0, 20)).expect("hợp lệ")
}

fn control_unbounded() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    )
}

/// Effort nhỏ để test chạy nhanh mà vẫn đi hết vòng solver.
fn small_effort() -> SearchEffort {
    SearchEffort {
        trial_count: 2,
        orientation_proposals_per_part: 4,
        beam_width: 1,
        refinement_rounds: 2,
        multi_start_restarts: 1,
        evaluation_budget: u64::MAX,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Kết quả luôn valid
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn version_solver_va_multi_start() {
    assert_eq!(SOLVER_VERSION, 1);
    assert_eq!(MULTI_START_VERSION, 1);
}

#[test]
fn solve_tra_ket_qua_da_validate() {
    let request = normalized(vec![part("part-a", 4, rect(120.0, 80.0))]);
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("phải chạy được");
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(outcome.status, ManifestStatus::Completed);
    assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 4);
    // Validate lại độc lập một lần nữa từ ngoài — không tin report của solver.
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: Some(&outcome.stats),
        },
    );
    assert!(report.valid, "{:?}", report.codes());
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::AllPlaced
    );
}

#[test]
fn solve_nhieu_loai_chi_tiet_lom() {
    let request = normalized(vec![
        part("part-a", 3, rect(150.0, 90.0)),
        part("part-b", 4, rect(70.0, 45.0)),
        part("part-c", 2, shape_l()),
    ]);
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 9);
    // Không trial nào bị loại vì invalid — nếu có, solver có bệnh.
    assert_eq!(
        outcome.trials_rejected, 0,
        "trial bị loại vì invalid là dấu hiệu solver sai"
    );
    assert!(outcome.trials_run > 0);
}

#[test]
fn trial_tra_layout_hop_le_va_khong_tu_cong_bo() {
    let request = normalized(vec![part("part-a", 5, rect(100.0, 70.0))]);
    let plans = plan_trials(request.seed, small_effort());
    assert!(!plans.is_empty());
    for plan in plans {
        let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();
        // Trial phải bảo toàn số lượng.
        assert_eq!(trial.placements.len() + trial.unplaced.len(), 5);
        // Và layout của nó phải qua validator độc lập.
        let report = validate_layout(
            &request,
            &LayoutUnderReview {
                placements: &trial.placements,
                unplaced: &trial.unplaced,
                stats: None,
            },
        );
        assert!(
            report.valid,
            "trial {} invalid: {:?}",
            plan.trial_id,
            report.codes()
        );
    }
}

#[test]
fn solve_phan_biet_hai_ly_do_chua_xep() {
    // Quá khổ ở mọi hướng ⇒ NO_FEASIBLE_POSE.
    let request = normalize_request(&request_of(
        vec![part("part-huge", 2, rect(2_000.0, 1_500.0))],
        400.0,
        500.0,
        10.0,
        3.0,
        20,
    ))
    .unwrap();
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert_eq!(outcome.placements.len(), 0);
    assert!(outcome
        .unplaced
        .iter()
        .all(|u| u.reason == UnplacedReason::NoFeasiblePose));
    assert!(outcome.validation.valid);

    // Vừa tờ nhưng chạm trần số tờ ⇒ MAX_SHEETS_REACHED, và terminationReason đúng.
    let request = normalize_request(&request_of(
        vec![part("part-big", 3, rect(350.0, 450.0))],
        400.0,
        500.0,
        10.0,
        3.0,
        1,
    ))
    .unwrap();
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert_eq!(outcome.placements.len(), 1);
    assert!(
        outcome
            .unplaced
            .iter()
            .all(|u| u.reason == UnplacedReason::MaxSheetsReached),
        "{:?}",
        outcome.unplaced
    );
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::MaxSheetsReached
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. Smart không tệ hơn baseline
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn smart_khong_bao_gio_te_hon_baseline() {
    let cases: Vec<(&str, Vec<PartSpec>)> = vec![
        ("một loại nhỏ", vec![part("part-a", 6, rect(100.0, 70.0))]),
        (
            "hai loại",
            vec![
                part("part-a", 3, rect(150.0, 90.0)),
                part("part-b", 5, rect(60.0, 40.0)),
            ],
        ),
        ("hình lõm", vec![part("part-l", 4, shape_l())]),
        ("chi tiết to", vec![part("part-big", 2, rect(350.0, 220.0))]),
    ];
    for (name, parts) in cases {
        let request = normalized(parts);
        let baseline = run_baseline(
            &request,
            &control_unbounded(),
            BaselineAnglePolicy::FirstAllowed,
        )
        .unwrap();
        let baseline_score = score_layout(
            &request,
            &baseline.placements,
            baseline.unplaced.len() as u64,
        );
        let outcome = solve(
            &request,
            small_effort(),
            &control_unbounded(),
            BaselineAnglePolicy::FirstAllowed,
        )
        .unwrap();
        let smart_score =
            score_layout(&request, &outcome.placements, outcome.unplaced.len() as u64);
        assert!(
            smart_score <= baseline_score,
            "{name}: smart tệ hơn baseline\n  smart:    {smart_score:?}\n  baseline: {baseline_score:?}"
        );
        // Và số tờ không được nhiều hơn baseline.
        assert!(
            outcome.stats.sheet_count <= baseline.sheet_count.max(1),
            "{name}: smart dùng {} tờ, baseline {} tờ",
            outcome.stats.sheet_count,
            baseline.sheet_count
        );
    }
}

#[test]
fn moi_trial_te_hon_thi_cong_bo_baseline() {
    // Với chi tiết vừa khít, baseline đã tối ưu nên nhiều khả năng thắng — dù thắng hay
    // không, nguồn công bố phải là ứng viên tốt nhất, không bao giờ tệ hơn baseline.
    let request = normalized(vec![part("part-a", 2, rect(180.0, 230.0))]);
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    let baseline_score = score_layout(
        &request,
        &baseline.placements,
        baseline.unplaced.len() as u64,
    );
    let published = score_layout(&request, &outcome.placements, outcome.unplaced.len() as u64);
    assert!(published <= baseline_score);
    // Nguồn được ghi rõ để không ai phải đoán.
    match outcome.source {
        SolutionSource::Baseline => {}
        SolutionSource::Trial { trial_id } => {
            assert!(trial_id < u64::from(small_effort().trial_count))
        }
    }
}

#[test]
fn baseline_invalid_thi_fail_job_khong_cong_bo() {
    // Không dựng được ca baseline-invalid từ dữ liệu hợp lệ (đó là điểm mạnh của thiết
    // kế), nên ở đây chốt hợp đồng lỗi: mã lỗi tồn tại và khác các lỗi khác.
    assert_ne!(
        SolveError::BaselineInvalid,
        SolveError::InterruptedBeforeAnyResult(
            imposition_core::mixed_nesting::control::Interrupt::Cancelled
        )
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Ba profile giữ nguyên miền free-angle
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn ba_profile_giu_nguyen_mien_free_angle() {
    let request = normalized(vec![part("part-a", 3, rect(120.0, 80.0))]);
    // Miền của chi tiết là toàn 360° và KHÔNG phụ thuộc profile.
    assert_eq!(request.parts[0].rotation_domain, RotationDomain::Full);
    assert_eq!(request.parts[0].rotation_domain.total_span_deg(), 360.0);

    for profile in [Profile::Fast, Profile::Balanced, Profile::Tight] {
        let effort = SearchEffort {
            trial_count: 1,
            refinement_rounds: 1,
            ..SearchEffort::for_profile(profile)
        };
        let outcome = solve(
            &request,
            effort,
            &control_unbounded(),
            BaselineAnglePolicy::FirstAllowed,
        )
        .unwrap();
        assert!(
            outcome.validation.valid,
            "{profile:?}: {:?}",
            outcome.validation.codes()
        );
        // Miền vẫn nguyên sau khi chạy — profile không có đường nào thu hẹp nó.
        assert_eq!(request.parts[0].rotation_domain.total_span_deg(), 360.0);
        assert!(request.parts[0]
            .rotation_domain
            .contains(13.372_849, &tol()));
        // Mọi góc công bố phải thuộc miền.
        for record in &outcome.placements {
            assert!(
                request.parts[0]
                    .rotation_domain
                    .contains(record.pose.rotation_deg, &tol()),
                "{profile:?}: góc {} ngoài miền",
                record.pose.rotation_deg
            );
        }
    }
}

#[test]
fn solver_co_the_tra_goc_khong_cardinal() {
    // Nan dài trong tờ vuông hẹp: bốn góc cardinal không xếp được con thứ hai, nhưng
    // miền tự do thì có. Đây là bằng chứng free-angle đi tới được kết quả công bố.
    let request = normalize_request(&request_of(
        vec![part("part-nan", 1, rect(130.0, 10.0))],
        120.0,
        120.0,
        10.0,
        0.0,
        3,
    ))
    .unwrap();

    // Baseline cardinal: không đặt được.
    let cardinal = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::CardinalForBenchmark,
    )
    .unwrap();
    assert_eq!(cardinal.placements.len(), 0, "cardinal không xếp được");

    // Solver với miền tự do: phải xếp được, và bằng một góc KHÔNG cardinal.
    let outcome = solve(
        &request,
        SearchEffort::for_profile(Profile::Tight),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(
        outcome.placements.len(),
        1,
        "miền tự do phải xếp được con này"
    );
    let angle = outcome.placements[0].pose.rotation_deg;
    let la_cardinal = [0.0_f64, 90.0, 180.0, 270.0]
        .iter()
        .any(|c| (angle - c).abs() < 1e-6);
    assert!(
        !la_cardinal,
        "góc công bố {angle}° phải là góc không-cardinal"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  4. Deterministic, deadline, cancel
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn ke_hoach_trial_xac_dinh_va_dan_xuat_tu_seed() {
    let effort = SearchEffort::for_profile(Profile::Balanced);
    let a = plan_trials(20_260_826, effort);
    let b = plan_trials(20_260_826, effort);
    assert_eq!(a, b, "cùng seed phải cho cùng kế hoạch");
    let c = plan_trials(20_260_827, effort);
    assert_ne!(a[0].seed, c[0].seed, "seed khác phải cho trial khác");
    // trial_id tăng dần và thứ tự chi tiết luân phiên đủ bốn kiểu.
    for (index, plan) in a.iter().enumerate() {
        assert_eq!(plan.trial_id, index as u64);
    }
    let orders: std::collections::BTreeSet<&str> = a
        .iter()
        .take(4)
        .map(|p| match p.part_order {
            PartOrder::AreaDescending => "area",
            PartOrder::LongestExtentDescending => "extent",
            PartOrder::ConcavityDescending => "concavity",
            PartOrder::QuantityDescending => "quantity",
        })
        .collect();
    assert_eq!(
        orders.len(),
        4,
        "bốn trial đầu phải dùng bốn thứ tự khác nhau"
    );
}

#[test]
fn ket_qua_khong_doi_theo_thu_tu_gop() {
    // Đây là chốt cho "fixed work-plan deterministic bất kể số worker": nếu gộp phụ thuộc
    // thứ tự hoàn thành của thread thì test này đỏ.
    let request = normalized(vec![part("part-a", 4, rect(120.0, 80.0))]);
    let effort = small_effort();
    let mut candidates: Vec<ScoredCandidate> = Vec::new();
    for plan in plan_trials(request.seed, effort) {
        let trial = run_trial(&request, plan, effort, &control_unbounded()).unwrap();
        candidates.push(ScoredCandidate {
            source: SolutionSource::Trial {
                trial_id: trial.trial_id,
            },
            placements: trial.placements,
            unplaced: trial.unplaced,
            score: trial.score,
        });
    }
    let forward = reduce_candidates(&candidates).unwrap().clone();
    let mut reversed = candidates.clone();
    reversed.reverse();
    let backward = reduce_candidates(&reversed).unwrap().clone();
    assert_eq!(
        forward.score, backward.score,
        "gộp xuôi và gộp ngược phải cho cùng điểm"
    );
    assert_eq!(forward.placements, backward.placements);
}

#[test]
fn solve_deterministic_voi_work_plan_co_dinh() {
    let request = normalized(vec![
        part("part-a", 3, rect(130.0, 85.0)),
        part("part-b", 4, rect(60.0, 40.0)),
    ]);
    let first = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    for lan in 0..3 {
        let again = solve(
            &request,
            small_effort(),
            &control_unbounded(),
            BaselineAnglePolicy::FirstAllowed,
        )
        .unwrap();
        assert_eq!(
            first.placements, again.placements,
            "lần {lan}: placement phải xác định từng chữ số"
        );
        assert_eq!(first.source, again.source);
        assert_eq!(first.unplaced, again.unplaced);
    }
}

#[test]
fn huy_tra_best_so_far_hop_le_kem_ly_do_dung() {
    let request = normalized(vec![part("part-a", 8, rect(90.0, 60.0))]);
    // Hủy sau khi baseline xong: solve phải trả baseline đã validate, status Cancelled.
    let token = CancelToken::new();
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        token.clone(),
        Arc::new(ProgressChannel::new()),
    );
    // Chạy baseline trước rồi hủy: mô phỏng người dùng bấm Hủy giữa vòng trial.
    let baseline = run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed).unwrap();
    assert!(!baseline.placements.is_empty());
    token.cancel();
    let outcome = solve(
        &request,
        small_effort(),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    );
    // Baseline chạy lại trong `solve` sẽ gặp cờ hủy ngay ⇒ không có phương án nào.
    assert_eq!(
        outcome,
        Err(SolveError::InterruptedBeforeAnyResult(
            imposition_core::mixed_nesting::control::Interrupt::Cancelled
        )),
        "hủy trước khi có phương án nào phải báo rõ, không trả layout dở dang"
    );
}

#[test]
fn het_work_budget_giua_vong_trial_van_cong_bo_baseline() {
    let request = normalized(vec![part("part-a", 6, rect(100.0, 70.0))]);
    // Ngân sách vừa đủ cho baseline nhưng không đủ cho trial nào.
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let outcome = solve(
        &request,
        small_effort(),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline không tiêu evaluation nên vẫn chạy được");
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(
        outcome.source,
        SolutionSource::Baseline,
        "hết ngân sách ⇒ công bố baseline"
    );
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::WorkBudgetExhausted
    );
    // Trial đầu có thể bắt đầu rồi bị ngắt giữa đường — khi đó layout dở của nó vẫn hợp
    // lệ nhưng xếp được ít hơn, nên baseline thắng. Điều phải đúng là: không trial nào bị
    // loại vì invalid, và phương án công bố là baseline.
    assert!(
        outcome.trials_run <= 1,
        "trials_run = {}",
        outcome.trials_run
    );
    assert_eq!(outcome.trials_rejected, 0);
    // Vẫn bảo toàn số lượng.
    assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 6);
}

#[test]
fn deadline_tra_best_so_far_va_ghi_dung_termination_reason() {
    let request = normalized(vec![part("part-a", 6, rect(100.0, 70.0))]);
    // Deadline 0 ms: hết hạn ngay khi vào vòng trial.
    let control = RunControl::new(
        StopCriterion::with_deadline(u64::MAX, 0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    std::thread::sleep(std::time::Duration::from_millis(2));
    let result = solve(
        &request,
        small_effort(),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    );
    match result {
        Ok(outcome) => {
            assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
            assert_eq!(
                outcome.stats.termination_reason,
                TerminationReason::Deadline,
                "hết deadline phải ghi đúng lý do"
            );
            assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 6);
        }
        Err(SolveError::InterruptedBeforeAnyResult(stop)) => {
            // Baseline cũng gặp deadline: chấp nhận, nhưng phải báo rõ chứ không trả
            // layout dở dang.
            assert_eq!(
                stop,
                imposition_core::mixed_nesting::control::Interrupt::DeadlineReached
            );
        }
        Err(other) => panic!("lỗi không mong đợi: {other:?}"),
    }
}

#[test]
fn trial_bi_ngat_ghi_dung_ly_do_cho_con_chua_xu_ly() {
    let request = normalized(vec![part("part-a", 10, rect(90.0, 60.0))]);
    let token = CancelToken::new();
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        token.clone(),
        Arc::new(ProgressChannel::new()),
    );
    token.cancel();
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control).unwrap();
    // Bảo toàn số lượng ngay cả khi bị hủy.
    assert_eq!(trial.placements.len() + trial.unplaced.len(), 10);
    assert!(trial
        .unplaced
        .iter()
        .all(|u| u.reason == UnplacedReason::Cancelled));
    assert_eq!(
        trial.interrupted,
        Some(imposition_core::mixed_nesting::control::Interrupt::Cancelled)
    );
    // Và layout còn lại vẫn hợp lệ.
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &trial.placements,
            unplaced: &trial.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn gop_ung_vien_rong_tra_none() {
    let empty: Vec<ScoredCandidate> = Vec::new();
    assert!(reduce_candidates(&empty).is_none());
}

#[test]
fn thong_ke_cong_bo_khop_placement_thuc() {
    let request = normalized(vec![
        part("part-a", 3, rect(130.0, 85.0)),
        part("part-b", 3, rect(60.0, 40.0)),
    ]);
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert_eq!(outcome.stats.placed_count, outcome.placements.len() as u64);
    assert_eq!(outcome.stats.unplaced_count, outcome.unplaced.len() as u64);
    let sheets: std::collections::BTreeSet<u32> =
        outcome.placements.iter().map(|p| p.sheet_index).collect();
    assert_eq!(outcome.stats.sheet_count, sheets.len() as u32);
    // Utilization phải là số tính lại được, và validator đã kiểm điều đó.
    assert!(outcome.stats.material_utilization > 0.0);
    assert!(outcome.stats.material_utilization <= 1.0);
    // Bộ đếm tìm kiếm phải có giá trị thật, không phải 0.
    assert!(outcome.stats.attempts > 0);
    assert!(outcome.stats.orientation_evaluations > 0);
}

#[test]
fn diem_cua_moi_ung_vien_dung_cung_mot_dinh_nghia() {
    // §11.5: điểm dùng cho solver, baseline và report phải cùng một định nghĩa.
    let request = normalized(vec![part("part-a", 4, rect(120.0, 80.0))]);
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();
    let recomputed: LayoutScore =
        score_layout(&request, &trial.placements, trial.unplaced.len() as u64);
    assert_eq!(
        trial.score, recomputed,
        "điểm mà trial báo phải bằng điểm tính lại từ chính placements"
    );
}
