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
//!    deadline/ngân sách trả **best-so-far ở barrier hoàn chỉnh**; cancel không tạo outcome.

use std::sync::Arc;
use std::time::{Duration, Instant};

use imposition_core::mixed_nesting::baseline::{
    run_baseline, BaselineAnglePolicy, BaselineError, BASELINE_VERSION,
};
use imposition_core::mixed_nesting::candidates::PartOrder;
use imposition_core::mixed_nesting::control::{
    CancelToken, JobPhase, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    format_instance_id, AxisAlignedBoundsSpec, ClearanceSpec, FixedObstacleKind, FixedObstacleSpec,
    GroupingIntent, LayoutAlignment, LayoutIntent, ManifestStatus, MixedNestingRequest,
    OrientationPolicy, PartPlacementZoneSpec, PartSpec, PointMm, ProductionContractV1, Profile,
    Reflection, RotationConstraint, SheetAxisClearanceMm, SheetMarginMm, SheetSpec,
    TerminationReason, Tolerance, UnplacedReason, MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
    MIXED_NESTING_PROTOCOL_VERSION,
};
use imposition_core::mixed_nesting::multi_start::{
    reduce_candidates, solve, ScoredCandidate, SolutionSource, SolveError, MULTI_START_VERSION,
};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::orientation::RotationDomain;
use imposition_core::mixed_nesting::score::{score_layout, sheet_envelopes, LayoutScore};
use imposition_core::mixed_nesting::solver::{plan_trials, run_trial, TrialError, SOLVER_VERSION};
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
        protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
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
        layout_intent: Default::default(),
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    }
}

fn normalized(parts: Vec<PartSpec>) -> NormalizedRequest {
    normalize_request(&request_of(parts, 400.0, 500.0, 10.0, 3.0, 20)).expect("hợp lệ")
}

fn normalized_maximize_area(mut parts: Vec<PartSpec>, autofill: bool) -> NormalizedRequest {
    if autofill {
        for item in &mut parts {
            item.quantity = 0;
        }
    }
    let mut request = request_of(parts, 120.0, 120.0, 10.0, 0.0, if autofill { 1 } else { 2 });
    if autofill {
        request.layout_intent = LayoutIntent::AutofillSingleSheet;
    }
    request.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "e".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "f".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::MaximizeArea,
        placement_zones: vec![
            PartPlacementZoneSpec {
                part_id: "part-b".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 10.0,
                    min_y_mm: 10.0,
                    max_x_mm: 110.0,
                    max_y_mm: 60.0,
                },
            },
            PartPlacementZoneSpec {
                part_id: "part-a".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 10.0,
                    min_y_mm: 60.0,
                    max_x_mm: 110.0,
                    max_y_mm: 110.0,
                },
            },
        ],
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm::zero(),
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm::zero(),
        },
        fixed_obstacles: Vec::new(),
    });
    normalize_request(&request).expect("maximize_area phải hợp lệ")
}

fn production_request_with_obstacle(parts: Vec<PartSpec>) -> NormalizedRequest {
    let mut request = request_of(parts, 180.0, 100.0, 10.0, 0.0, 2);
    request.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "a".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "b".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 1.0,
                y_mm: 1.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 2.0,
                y_mm: 2.0,
            },
        },
        fixed_obstacles: vec![FixedObstacleSpec {
            obstacle_id: "boong-left".to_string(),
            kind: FixedObstacleKind::CncExcludeZone,
            outer: vec![
                pt(10.0, 10.0),
                pt(70.0, 10.0),
                pt(70.0, 90.0),
                pt(10.0, 90.0),
            ],
        }],
    });
    normalize_request(&request).expect("production request hợp lệ")
}

fn alignment_request(
    alignment: LayoutAlignment,
    quantity: u32,
    width_mm: f64,
    height_mm: f64,
    margin: SheetMarginMm,
    edge_clearance: SheetAxisClearanceMm,
    fixed_obstacles: Vec<FixedObstacleSpec>,
) -> NormalizedRequest {
    let mut item = part("part-a", quantity, rect(20.0, 20.0));
    item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut request = request_of(vec![item], width_mm, height_mm, 0.0, 0.0, quantity);
    request.sheet.margin_mm = margin;
    request.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "c".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "d".repeat(64)),
        alignment,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm::zero(),
            part_to_sheet_edge: edge_clearance,
            part_to_obstacle: SheetAxisClearanceMm::zero(),
        },
        fixed_obstacles,
    });
    normalize_request(&request).expect("request căn cụm hợp lệ")
}

fn normalized_autofill(
    mut parts: Vec<PartSpec>,
    width_mm: f64,
    height_mm: f64,
    gap_mm: f64,
) -> NormalizedRequest {
    for item in &mut parts {
        item.quantity = 0;
    }
    let mut request = request_of(parts, width_mm, height_mm, 0.0, gap_mm, 1);
    request.layout_intent = LayoutIntent::AutofillSingleSheet;
    normalize_request(&request).expect("autofill hợp lệ")
}

fn control_unbounded() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    )
}

fn control_exhausted() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(0),
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
    assert_eq!(SOLVER_VERSION, 4);
    // NESTROW (audit 2026-09-07 §NESTROW.1): S&R dùng baseline motif phiên bản mới.
    assert_eq!(BASELINE_VERSION, 13);
    assert_eq!(MULTI_START_VERSION, 5);
}

#[test]
fn smart_trial_giu_gap_di_huong_ca_hai_truc_bang_zero() {
    let cases = [
        (
            "gapY không ép khoảng ngang",
            31.0,
            11.0,
            SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 10.0,
            },
        ),
        (
            "gapX không ép khoảng dọc",
            11.0,
            31.0,
            SheetAxisClearanceMm {
                x_mm: 10.0,
                y_mm: 0.0,
            },
        ),
    ];

    for (name, width_mm, height_mm, part_clearance) in cases {
        let mut item = part("part-a", 3, rect(10.0, 10.0));
        item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
        let mut raw = request_of(vec![item], width_mm, height_mm, 0.0, 0.0, 1);
        raw.production_contract = Some(ProductionContractV1 {
            schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
            request_revision: 1,
            input_hash: format!("sha256:{}", "c".repeat(64)),
            layout_fingerprint: format!("sha256:{}", "d".repeat(64)),
            alignment: LayoutAlignment::Center,
            grouping_intent: GroupingIntent::FreeGang,
            placement_zones: Vec::new(),
            clearance: ClearanceSpec {
                part_to_part: part_clearance,
                part_to_sheet_edge: SheetAxisClearanceMm::zero(),
                part_to_obstacle: SheetAxisClearanceMm::zero(),
            },
            fixed_obstacles: Vec::new(),
        });
        let request = normalize_request(&raw).expect("request dị hướng phải hợp lệ");
        let plan = plan_trials(request.seed, small_effort())[0];
        let trial = run_trial(&request, plan, small_effort(), &control_unbounded())
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));

        assert_eq!(trial.placements.len(), 3, "{name}: {trial:?}");
        assert!(trial.unplaced.is_empty(), "{name}: {trial:?}");
        let report = validate_layout(
            &request,
            &LayoutUnderReview {
                placements: &trial.placements,
                unplaced: &trial.unplaced,
                stats: None,
            },
        );
        assert!(report.valid, "{name}: {:?}", report.codes());
    }
}

#[test]
fn solve_step_repeat_giu_ba_cell_voi_gap_di_huong_zero_axis() {
    let cases = [
        (
            "S&R ngang",
            31.0,
            11.0,
            SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 10.0,
            },
        ),
        (
            "S&R dọc",
            11.0,
            31.0,
            SheetAxisClearanceMm {
                x_mm: 10.0,
                y_mm: 0.0,
            },
        ),
    ];

    for (name, width_mm, height_mm, part_clearance) in cases {
        let mut item = part("part-a", 0, rect(10.0, 10.0));
        item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
        let mut raw = request_of(vec![item], width_mm, height_mm, 0.0, 0.0, 1);
        raw.layout_intent = LayoutIntent::StepRepeatSingleSheet;
        raw.production_contract = Some(ProductionContractV1 {
            schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
            request_revision: 1,
            input_hash: format!("sha256:{}", "5".repeat(64)),
            layout_fingerprint: format!("sha256:{}", "6".repeat(64)),
            alignment: LayoutAlignment::Center,
            grouping_intent: GroupingIntent::FreeGang,
            placement_zones: Vec::new(),
            clearance: ClearanceSpec {
                part_to_part: part_clearance,
                part_to_sheet_edge: SheetAxisClearanceMm::zero(),
                part_to_obstacle: SheetAxisClearanceMm {
                    x_mm: 50.0,
                    y_mm: 50.0,
                },
            },
            fixed_obstacles: Vec::new(),
        });
        let request = normalize_request(&raw).expect("S&R dị hướng phải hợp lệ");
        let outcome = solve(
            &request,
            small_effort(),
            &control_unbounded(),
            BaselineAnglePolicy::FirstAllowed,
        )
        .unwrap_or_else(|error| panic!("{name}: {error:?}"));

        assert_eq!(outcome.placements.len(), 3, "{name}: {outcome:?}");
        assert!(outcome.unplaced.is_empty(), "{name}: {outcome:?}");
        assert!(
            outcome.validation.valid,
            "{name}: {:?}",
            outcome.validation.codes()
        );
    }
}

#[test]
fn probe_xoay_thang_thi_baseline_score_phai_theo_portfolio() {
    // Khối 100×100 chiếm hết chiều cao; tem 80×60 chỉ đặt được một con bên phải.
    // Xoay tem thành 60×80 giữ đủ hai design nhưng giảm bề rộng envelope 180→160 mm.
    // GapY=50 không được chặn cặp đang tách theo X; partToObstacle lớn nhưng request
    // không có obstacle nên càng không được trở thành authority của rotation probe.
    let mut raw = request_of(
        vec![
            part("khoi", 0, rect(100.0, 100.0)),
            part("tem", 0, rect(80.0, 60.0)),
        ],
        181.0,
        100.0,
        0.0,
        0.0,
        1,
    );
    raw.layout_intent = LayoutIntent::AutofillSingleSheet;
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "7".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "8".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 50.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 80.0,
                y_mm: 80.0,
            },
        },
        fixed_obstacles: Vec::new(),
    });
    let request = normalize_request(&raw).expect("fixture probe dị hướng phải hợp lệ");
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline gốc phải chạy");
    let original_score = score_layout(&request, &baseline.placements, 0);

    let outcome = solve(
        &request,
        small_effort(),
        &control_exhausted(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("probe baseline phải được công bố dù smart budget bằng 0");

    assert_eq!(outcome.source, SolutionSource::Baseline);
    assert!(outcome
        .placements
        .iter()
        .any(|item| item.part_id == "tem" && item.pose.rotation_deg != 0.0));
    assert!(outcome.selected_score.is_better_than(&original_score));
    let portfolio_floor = outcome
        .baseline_score
        .expect("portfolio baseline hợp lệ phải có baselineScore");
    assert_eq!(
        portfolio_floor.invalid_count,
        outcome.selected_score.invalid_count
    );
    assert_eq!(
        portfolio_floor.unplaced_count,
        outcome.selected_score.unplaced_count
    );
    assert_eq!(
        portfolio_floor.sheet_count,
        outcome.selected_score.sheet_count
    );
    assert_eq!(
        portfolio_floor.last_sheet_used_area_fixed,
        outcome.selected_score.last_sheet_used_area_fixed
    );
    assert_eq!(
        portfolio_floor.wasted_within_envelope_fixed,
        outcome.selected_score.wasted_within_envelope_fixed
    );
}

#[test]
fn smart_trial_tranh_fixed_obstacle_va_qua_validator() {
    let request = production_request_with_obstacle(vec![part("part-a", 4, rect(20.0, 20.0))]);
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();
    assert_eq!(trial.placements.len(), 4);
    assert!(trial.unplaced.is_empty());
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
        "smart trial vi phạm obstacle: {:?}",
        report.codes()
    );
}

#[test]
fn smart_trial_maximize_area_khong_dat_mau_ra_ngoai_zone() {
    let mut qua_cao = part("part-a", 1, rect(20.0, 60.0));
    qua_cao.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut vua_zone = part("part-b", 1, rect(20.0, 20.0));
    vua_zone.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let request = normalized_maximize_area(vec![qua_cao, vua_zone], false);
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();

    assert_eq!(trial.placements.len(), 1);
    assert_eq!(trial.placements[0].part_id, "part-b");
    assert_eq!(trial.unplaced.len(), 1);
    assert_eq!(trial.unplaced[0].part_id, "part-a");
    assert_eq!(trial.unplaced[0].reason, UnplacedReason::NoFeasiblePose);
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &trial.placements,
            unplaced: &trial.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "smart trial vượt zone: {:?}", report.codes());
}

#[test]
fn smart_autofill_maximize_area_lap_day_tung_zone() {
    let request = normalized_maximize_area(
        vec![
            part("part-a", 1, rect(20.0, 20.0)),
            part("part-b", 1, rect(20.0, 20.0)),
        ],
        true,
    );
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();
    for part_id in ["part-a", "part-b"] {
        assert!(
            trial.placements.iter().any(|item| item.part_id == part_id),
            "autofill phải có {part_id}: {:?}",
            trial.placements
        );
    }
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
        "smart autofill vượt zone: {:?}",
        report.codes()
    );
}

#[test]
fn publication_alignment_clamp_theo_giao_zone() {
    let mut top = part("part-a", 1, rect(20.0, 20.0));
    top.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut bottom = part("part-b", 1, rect(20.0, 49.0));
    bottom.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let request = normalized_maximize_area(vec![top, bottom], false);
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline maximize_area phải chạy");
    let baseline_by_id: std::collections::BTreeMap<_, _> = baseline
        .placements
        .iter()
        .map(|record| (record.instance_id.as_str(), record))
        .collect();

    let outcome = solve(
        &request,
        small_effort(),
        &control_exhausted(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("publication phải clamp được thay vì fallback toàn bộ");
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());

    let mut common_delta: Option<(f64, f64)> = None;
    for published in &outcome.placements {
        let original = baseline_by_id[published.instance_id.as_str()];
        let delta = (
            published.pose.translate_x_mm - original.pose.translate_x_mm,
            published.pose.translate_y_mm - original.pose.translate_y_mm,
        );
        if let Some(expected) = common_delta {
            assert!((delta.0 - expected.0).abs() <= request.tolerance.linear_mm);
            assert!((delta.1 - expected.1).abs() <= request.tolerance.linear_mm);
        } else {
            common_delta = Some(delta);
        }
    }
    let (dx, dy) = common_delta.expect("phải có placements");
    assert!((dx - 40.0).abs() <= request.tolerance.linear_mm);
    assert!(
        dy > 0.0 && dy < 15.0,
        "Y phải được clamp theo zone dưới, không fallback hoặc dịch đủ: {dy}"
    );
    let bottom = outcome
        .placements
        .iter()
        .find(|record| record.part_id == "part-b")
        .unwrap();
    assert!(
        bottom.pose.translate_y_mm + 49.0 <= 60.0 + request.tolerance.linear_mm,
        "mẫu dưới vượt zone: {:?}",
        bottom.pose
    );
}

#[test]
fn publication_can_giua_tung_to_trong_usable_co_le_bat_doi_xung() {
    let request = alignment_request(
        LayoutAlignment::Center,
        2,
        50.0,
        50.0,
        SheetMarginMm {
            left: 3.0,
            right: 7.0,
            top: 5.0,
            bottom: 1.0,
        },
        SheetAxisClearanceMm {
            x_mm: 2.0,
            y_mm: 3.0,
        },
        Vec::new(),
    );
    let outcome = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("căn giữa production phải thành công");
    let envelopes = sheet_envelopes(&request, &outcome.placements).expect("pose hợp lệ");

    assert_eq!(envelopes.len(), 2, "mỗi tờ chỉ vừa một chi tiết");
    for bounds in envelopes.values() {
        assert!((bounds.center().x - request.sheet.usable.center().x).abs() < 1e-6);
        assert!((bounds.center().y - request.sheet.usable.center().y).abs() < 1e-6);
    }
    assert!(outcome.validation.valid);
}

#[test]
fn publication_gap_obstacle_chan_tam_thi_giu_candidate_hop_le() {
    let obstacle = FixedObstacleSpec {
        obstacle_id: "boong-giua".to_string(),
        kind: FixedObstacleKind::CncExcludeZone,
        outer: vec![
            pt(40.0, 30.0),
            pt(60.0, 30.0),
            pt(60.0, 50.0),
            pt(40.0, 50.0),
        ],
    };
    let make_request = |alignment| {
        alignment_request(
            alignment,
            1,
            100.0,
            80.0,
            SheetMarginMm {
                left: 5.0,
                right: 5.0,
                top: 5.0,
                bottom: 5.0,
            },
            SheetAxisClearanceMm::zero(),
            vec![obstacle.clone()],
        )
    };
    let bottom_left_request = make_request(LayoutAlignment::BottomLeft);
    let centered_request = make_request(LayoutAlignment::Center);
    let bottom_left = solve(
        &bottom_left_request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("candidate neo góc phải hợp lệ");
    let centered = solve(
        &centered_request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("obstacle không được làm hỏng job");

    assert_eq!(centered.placements, bottom_left.placements);
    assert!(centered.validation.valid);
    let bounds = sheet_envelopes(&centered_request, &centered.placements).expect("pose hợp lệ")[&0];
    assert!(
        (bounds.center().x - centered_request.sheet.usable.center().x).abs() > 1.0,
        "exact center phải bị obstacle chặn và fallback"
    );
}

#[test]
fn autofill_smart_tu_sinh_instance_va_id_lien_tuc() {
    let request = normalized_autofill(vec![part("part-a", 1, rect(30.0, 20.0))], 100.0, 80.0, 0.0);
    assert_eq!(request.parts[0].quantity, 0, "không được dựng quantity giả");
    let plan = plan_trials(request.seed, small_effort())[0];
    let trial = run_trial(&request, plan, small_effort(), &control_unbounded()).unwrap();

    assert!(trial.interrupted.is_none());
    assert!(
        trial.completed_sweeps >= 2,
        "phải có sweep đặt và sweep rỗng"
    );
    assert!(trial.placements.len() > 1, "{:?}", trial.placements);
    assert!(trial.unplaced.is_empty());
    assert!(trial.placements.iter().all(|item| item.sheet_index == 0));
    for (index, item) in trial.placements.iter().enumerate() {
        assert_eq!(
            item.instance_id,
            format_instance_id("part-a", index as u32 + 1)
        );
    }
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
fn autofill_gang_can_bang_va_khong_phu_thuoc_thu_tu_payload() {
    let a = part("part-a", 1, rect(20.0, 20.0));
    let b = part("part-b", 1, rect(20.0, 20.0));
    let request_ab = normalized_autofill(vec![a.clone(), b.clone()], 100.0, 80.0, 0.0);
    let request_ba = normalized_autofill(vec![b, a], 100.0, 80.0, 0.0);
    let plan_ab = plan_trials(request_ab.seed, small_effort())[0];
    let plan_ba = plan_trials(request_ba.seed, small_effort())[0];
    let trial_ab = run_trial(&request_ab, plan_ab, small_effort(), &control_unbounded()).unwrap();
    let trial_ba = run_trial(&request_ba, plan_ba, small_effort(), &control_unbounded()).unwrap();

    let count = |trial: &imposition_core::mixed_nesting::solver::TrialResult, id: &str| {
        trial
            .placements
            .iter()
            .filter(|item| item.part_id == id)
            .count()
    };
    let count_a = count(&trial_ab, "part-a");
    let count_b = count(&trial_ab, "part-b");
    assert!(count_a > 0 && count_b > 0);
    assert!(count_a.abs_diff(count_b) <= 1, "{count_a} vs {count_b}");
    assert_eq!(trial_ab.placements, trial_ba.placements);
    assert_eq!(trial_ab.score, trial_ba.score);
}

#[test]
fn autofill_bootstrap_va_smart_giu_goc_khong_cardinal() {
    let request = normalized_autofill(
        vec![part("part-nan", 1, rect(130.0, 10.0))],
        120.0,
        120.0,
        0.0,
    );
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert_eq!(
        baseline.placements.len(),
        1,
        "baseline phải bootstrap design chéo"
    );

    let plan = plan_trials(request.seed, SearchEffort::for_profile(Profile::Tight))[0];
    let trial = run_trial(
        &request,
        plan,
        SearchEffort::for_profile(Profile::Tight),
        &control_unbounded(),
    )
    .unwrap();
    assert!(!trial.placements.is_empty());
    assert!(trial.placements.iter().any(|item| {
        ![0.0_f64, 90.0, 180.0, 270.0]
            .iter()
            .any(|cardinal| (item.pose.rotation_deg - cardinal).abs() < 1e-6)
    }));
}

#[test]
fn autofill_smart_rescue_design_ngoai_tap_goc_baseline() {
    // Baseline Fast chỉ đọc 12 góc đầu của miền rời rạc. Nan này chỉ vừa ở 60°,
    // là góc thứ 17: baseline hợp lệ về hình học nhưng thiếu design. Multi-start
    // phải cho smart Tight rescue, không được dùng heuristic baseline làm admission.
    let mut nan = part("part-nan", 1, rect(139.0, 0.5));
    nan.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: (0..=15).map(f64::from).chain([60.0]).collect(),
    };
    let request = normalized_autofill(vec![nan], 70.6, 121.0, 0.0);
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline rẻ vẫn phải chạy an toàn");
    assert!(
        baseline.placements.is_empty(),
        "regression cần baseline bỏ lỡ góc thứ 17: {:?}",
        baseline.placements
    );
    let baseline_report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &baseline.placements,
            unplaced: &baseline.unplaced,
            stats: None,
        },
    );
    assert_eq!(baseline_report.codes(), vec!["MISSING_AUTOFILL_PART"]);

    let mut effort = SearchEffort::for_profile(Profile::Tight);
    effort.trial_count = 1;
    let outcome = solve(
        &request,
        effort,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("smart phải được chạy để rescue design baseline bỏ lỡ");
    assert_eq!(outcome.source, SolutionSource::Trial { trial_id: 0 });
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert!(outcome
        .placements
        .iter()
        .all(|placement| (placement.pose.rotation_deg - 60.0).abs() < 1e-6));
}

#[test]
fn autofill_baseline_va_smart_cung_thieu_design_thi_khong_cong_bo() {
    let request = normalized_autofill(
        vec![part("part-huge", 1, rect(500.0, 500.0))],
        100.0,
        100.0,
        0.0,
    );
    let result = solve(
        &request,
        small_effort(),
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    );
    assert_eq!(
        result,
        Err(SolveError::BaselineInvalid),
        "không được công bố manifest autofill thiếu design"
    );
}

#[test]
fn autofill_interrupt_giua_sweep_rollback_ve_barrier() {
    let request = normalized_autofill(
        vec![
            part("part-a", 1, rect(20.0, 20.0)),
            part("part-b", 1, rect(20.0, 20.0)),
        ],
        100.0,
        80.0,
        0.0,
    );
    let plan = plan_trials(request.seed, small_effort())[0];

    // Dò deterministic budget đầu tiên có ít nhất một sweep hoàn tất rồi bị ngắt.
    let mut found = None;
    for budget in 2..2_000 {
        let control = RunControl::new(
            StopCriterion::fixed_work_plan(budget),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        let trial = run_trial(&request, plan, small_effort(), &control).unwrap();
        if trial.interrupted
            == Some(imposition_core::mixed_nesting::control::Interrupt::WorkBudgetExhausted)
            && trial.completed_sweeps > 0
        {
            found = Some((budget, trial));
            break;
        }
    }
    let (budget, barrier) = found.expect("phải tìm được budget cắt giữa sweep sau barrier");
    let replay_control = RunControl::new(
        StopCriterion::fixed_work_plan(budget),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let replay = run_trial(&request, plan, small_effort(), &replay_control).unwrap();
    assert_eq!(replay.placements, barrier.placements);
    assert_eq!(replay.score, barrier.score);
    assert_eq!(replay.completed_sweeps, barrier.completed_sweeps);

    // Barrier phải là sweep đầy đủ: hai design có cùng số placement.
    let count_a = barrier
        .placements
        .iter()
        .filter(|item| item.part_id == "part-a")
        .count();
    let count_b = barrier
        .placements
        .iter()
        .filter(|item| item.part_id == "part-b")
        .count();
    assert_eq!(count_a, count_b, "partial sweep đã lọt qua barrier");
}

#[test]
fn autofill_barrier_hoan_chinh_duoc_cham_va_co_the_thang_baseline() {
    // Baseline bootstrap đặt được một nan chéo, nhưng sau đó cố ý quay về đường góc
    // rẻ. Smart trial có thể đặt thêm nan; khi budget cắt giữa sweep kế tiếp, barrier
    // hoàn chỉnh tốt hơn phải được validate và tranh thắng, không bị loại như partial.
    let request = normalized_autofill(
        vec![part("part-nan", 1, rect(130.0, 10.0))],
        120.0,
        120.0,
        0.0,
    );
    let effort = SearchEffort {
        trial_count: 1,
        orientation_proposals_per_part: 16,
        beam_width: 2,
        refinement_rounds: 4,
        multi_start_restarts: 1,
        evaluation_budget: u64::MAX,
    };
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    let baseline_score = score_layout(&request, &baseline.placements, 0);
    let plan = plan_trials(request.seed, effort)[0];

    let mut found = None;
    for budget in 2..10_000 {
        let control = RunControl::new(
            StopCriterion::fixed_work_plan(budget),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        let trial = run_trial(&request, plan, effort, &control).unwrap();
        if trial.interrupted
            == Some(imposition_core::mixed_nesting::control::Interrupt::WorkBudgetExhausted)
            && trial.completed_sweeps > 0
            && trial.score.is_better_than(&baseline_score)
        {
            found = Some((budget, trial));
            break;
        }
    }
    let (budget, barrier) =
        found.expect("phải có completed barrier smart tốt hơn baseline bootstrap");
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(budget),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let outcome = solve(
        &request,
        effort,
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("multi-start phải công bố được completed barrier");

    assert_eq!(outcome.source, SolutionSource::Trial { trial_id: 0 });
    assert_eq!(outcome.placements, barrier.placements);
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::WorkBudgetExhausted
    );
    assert_eq!(
        outcome.trials_run, 0,
        "barrier timeout không phải trial bão hòa"
    );
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
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
    assert_ne!(SolveError::BaselineInvalid, SolveError::Cancelled);
}

#[test]
fn capacity_invariant_duoc_map_thanh_loi_terminal_rieng() {
    let from_baseline = SolveError::from(BaselineError::CapacityInvariantExceeded);
    let from_trial = SolveError::from(TrialError::CapacityInvariantExceeded);
    assert_eq!(from_baseline, SolveError::CapacityInvariantExceeded);
    assert_eq!(from_trial, SolveError::CapacityInvariantExceeded);
    assert_ne!(from_trial, SolveError::BaselineInvalid);
    assert_ne!(
        from_trial,
        SolveError::Geometry(TrialError::CapacityInvariantExceeded),
        "capacity không được giả làm lỗi hình học"
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
fn portfolio_fixed_work_giu_nguyen_ket_qua_voi_1_2_4_8_15_worker() {
    let request = normalized(vec![
        part("part-a", 3, rect(73.0, 51.0)),
        part("part-b", 4, shape_l()),
    ]);
    let effort = SearchEffort {
        trial_count: 4,
        orientation_proposals_per_part: 8,
        beam_width: 2,
        refinement_rounds: 3,
        multi_start_restarts: 1,
        evaluation_budget: 20_000,
    };

    let run = |worker_grant| {
        let control = RunControl::new_with_nfp_resources(
            StopCriterion::fixed_work_plan(effort.evaluation_budget),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
            worker_grant,
            64 * 1024 * 1024,
        );
        let outcome = solve(
            &request,
            effort,
            &control,
            BaselineAnglePolicy::FirstAllowed,
        )
        .expect("portfolio fixed-work phải có phương án hợp lệ");
        (outcome, control.evaluations())
    };

    let sequential = run(1);
    assert_eq!(sequential.0.portfolio_execution.planned_trials, 4);
    assert_eq!(sequential.0.portfolio_execution.dispatched_trials, 4);
    assert_eq!(sequential.0.portfolio_execution.concurrency_limit, 1);
    assert_eq!(sequential.0.portfolio_execution.waves_dispatched, 4);
    assert_eq!(
        sequential.0.portfolio_execution.max_dispatched_wave_width,
        1
    );
    // Grant 8/15 còn buộc mỗi trial dùng NFP worker >1, nhờ đó khóa luôn tương tác
    // giữa hai tầng song song thay vì chỉ kiểm outer portfolio 1/2/4 trial.
    for (worker_grant, parallel) in [(2, run(2)), (4, run(4)), (8, run(8)), (15, run(15))] {
        assert_eq!(
            parallel.0.placements, sequential.0.placements,
            "grant {worker_grant}: placement phải exact như reference tuần tự"
        );
        assert_eq!(parallel.0.unplaced, sequential.0.unplaced);
        assert_eq!(parallel.0.selected_score, sequential.0.selected_score);
        assert_eq!(parallel.0.baseline_score, sequential.0.baseline_score);
        assert_eq!(parallel.0.source, sequential.0.source);
        assert_eq!(parallel.0.trials_run, sequential.0.trials_run);
        assert_eq!(parallel.0.trials_rejected, sequential.0.trials_rejected);
        assert_eq!(parallel.0.portfolio_execution.planned_trials, 4);
        assert_eq!(parallel.0.portfolio_execution.dispatched_trials, 4);
        assert_eq!(
            parallel.0.portfolio_execution.completed_trials,
            sequential.0.portfolio_execution.completed_trials
        );
        assert_eq!(
            parallel.0.portfolio_execution.interrupted_trials,
            sequential.0.portfolio_execution.interrupted_trials
        );
        assert_eq!(
            parallel.0.portfolio_execution.rejected_trials,
            sequential.0.portfolio_execution.rejected_trials
        );
        let expected_concurrency = u64::try_from(worker_grant.min(4)).unwrap();
        assert_eq!(
            parallel.0.portfolio_execution.concurrency_limit,
            expected_concurrency
        );
        assert_eq!(
            parallel.0.portfolio_execution.waves_dispatched,
            4_u64.div_ceil(expected_concurrency)
        );
        assert_eq!(
            parallel.0.portfolio_execution.max_dispatched_wave_width,
            expected_concurrency
        );
        assert_eq!(parallel.0.stats.sheet_count, sequential.0.stats.sheet_count);
        assert_eq!(
            parallel.0.stats.placed_count,
            sequential.0.stats.placed_count
        );
        assert_eq!(
            parallel.0.stats.unplaced_count,
            sequential.0.stats.unplaced_count
        );
        assert_eq!(parallel.0.stats.attempts, sequential.0.stats.attempts);
        assert_eq!(
            parallel.0.stats.orientation_evaluations,
            sequential.0.stats.orientation_evaluations
        );
        assert_eq!(
            parallel.0.stats.pose_refinements,
            sequential.0.stats.pose_refinements
        );
        assert_eq!(
            parallel.0.stats.termination_reason,
            sequential.0.stats.termination_reason
        );
        assert_eq!(
            parallel.1, sequential.1,
            "grant {worker_grant}: tổng work đã nạp phải exact"
        );
    }
}

#[test]
fn portfolio_deadline_dung_trong_cua_so_huu_han_va_giu_best_hop_le() {
    let request = normalized(vec![
        part("part-a", 8, rect(63.0, 41.0)),
        part("part-b", 8, shape_l()),
    ]);
    let effort = SearchEffort {
        trial_count: 8,
        orientation_proposals_per_part: 16,
        beam_width: 4,
        refinement_rounds: 6,
        multi_start_restarts: 2,
        evaluation_budget: u64::MAX,
    };
    let control = RunControl::new_with_nfp_resources(
        StopCriterion::with_deadline(u64::MAX, 1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
        4,
        64 * 1024 * 1024,
    );
    let started = Instant::now();
    let outcome = solve(
        &request,
        effort,
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("deadline phải giữ best-so-far hợp lệ");

    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::Deadline
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "deadline cooperative không được treo quá một wave NFP: {:?}",
        started.elapsed()
    );
}

#[test]
fn portfolio_parallel_ton_trong_cancel_va_join_huu_han() {
    let request = normalized(vec![
        part("part-a", 8, rect(63.0, 41.0)),
        part("part-b", 8, shape_l()),
    ]);
    let effort = SearchEffort {
        trial_count: 8,
        orientation_proposals_per_part: 32,
        beam_width: 8,
        refinement_rounds: 8,
        multi_start_restarts: 2,
        evaluation_budget: 100_000,
    };
    let cancel = CancelToken::new();
    let progress = Arc::new(ProgressChannel::new());
    let control = RunControl::new_with_nfp_resources(
        StopCriterion::fixed_work_plan(effort.evaluation_budget),
        cancel.clone(),
        Arc::clone(&progress),
        4,
        64 * 1024 * 1024,
    );
    let handle = std::thread::spawn(move || {
        solve(
            &request,
            effort,
            &control,
            BaselineAnglePolicy::FirstAllowed,
        )
    });

    let wait_started = Instant::now();
    while progress.snapshot().phase != JobPhase::Improving {
        assert!(
            wait_started.elapsed() < Duration::from_secs(10),
            "solver không vào pha portfolio trong thời gian test"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let cancel_started = Instant::now();
    cancel.cancel();
    let result = handle.join().expect("scoped portfolio không được panic");
    assert_eq!(result, Err(SolveError::Cancelled));
    assert!(
        cancel_started.elapsed() < Duration::from_secs(5),
        "cancel phải dừng trong tối đa một NFP wave: {:?}",
        cancel_started.elapsed()
    );
}

#[test]
fn huy_khong_tra_solve_outcome_du_baseline_co_the_dung_duoc() {
    let request = normalized(vec![part("part-a", 8, rect(90.0, 60.0))]);
    // Dựng được baseline trước để chứng minh lỗi hủy không phụ thuộc việc có sàn an toàn.
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
    // Baseline chạy lại trong `solve` gặp cờ hủy: cancel là lỗi terminal, không manifest.
    assert_eq!(
        outcome,
        Err(SolveError::Cancelled),
        "hủy phải trả lỗi riêng, không được trả SolveOutcome/manifest"
    );
}

#[test]
fn het_work_budget_giua_vong_trial_van_cong_bo_baseline() {
    let request = normalized(vec![part("part-a", 6, rect(100.0, 70.0))]);
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    // Ngân sách đã hết TRƯỚC solve. Baseline vẫn phải hoàn chỉnh; smart search dừng ở
    // barrier đầu tiên rồi công bố đúng baseline đó.
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    control.charge_evaluations(1);
    let outcome = solve(
        &request,
        small_effort(),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("work budget không được cắt baseline");
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
    assert_eq!(outcome.placements, baseline.placements);
    assert_eq!(outcome.unplaced, baseline.unplaced);
    assert_eq!(outcome.trials_run, 0);
    assert_eq!(outcome.trials_rejected, 0);
    // Vẫn bảo toàn số lượng.
    assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 6);
}

#[test]
fn trial_do_bi_ngat_giua_chung_khong_duoc_tranh_thang_baseline() {
    let request = normalized(vec![part("part-a", 6, rect(100.0, 70.0))]);
    let baseline = run_baseline(
        &request,
        &control_unbounded(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    // Evaluation đầu tiên cho trial bắt đầu được, rồi work budget cắt ngay trong lúc
    // tìm pose. Layout dở của trial có thể vẫn hợp lệ hình học nhưng chưa qua barrier.
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
    .expect("work budget phải trả completed barrier gần nhất");

    assert_eq!(outcome.status, ManifestStatus::Completed);
    assert_eq!(outcome.source, SolutionSource::Baseline);
    assert_eq!(outcome.placements, baseline.placements);
    assert_eq!(outcome.unplaced, baseline.unplaced);
    assert_eq!(
        outcome.trials_run, 0,
        "trial dở không được tính là hoàn tất"
    );
    assert_eq!(
        outcome.trials_rejected, 0,
        "trial dở không phải trial invalid"
    );
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::WorkBudgetExhausted
    );
}

#[test]
fn deadline_tra_best_so_far_va_ghi_dung_termination_reason() {
    let request = normalized(vec![part("part-a", 6, rect(100.0, 70.0))]);
    // PERF (audit 2026-09-02 §PERF-NEST-04): deadline đã hết trước solve phải cắt
    // cả baseline quantity, nhưng vẫn công bố một ledger đầy đủ và hợp lệ.
    let control = RunControl::new(
        StopCriterion::with_deadline(u64::MAX, 0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let outcome = solve(
        &request,
        small_effort(),
        &control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("deadline phải giữ best-so-far có ledger hợp lệ");
    assert!(outcome.validation.valid, "{:?}", outcome.validation.codes());
    assert_eq!(outcome.source, SolutionSource::Baseline);
    assert!(outcome.placements.is_empty());
    assert_eq!(outcome.unplaced.len(), 6);
    assert_eq!(outcome.placements.len() + outcome.unplaced.len(), 6);
    assert!(outcome
        .unplaced
        .iter()
        .all(|record| record.reason == UnplacedReason::SearchBudgetExhausted));
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::Deadline
    );
    assert_eq!(outcome.trials_run, 0);
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
