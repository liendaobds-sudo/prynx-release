//! NESTROW (audit 2026-09-07 §NESTROW.1): S&R phải lặp đều trên contour thật.
//!
//! Fixture giữ engineRequest của manifest nguồn 6/7/8/12 trong audit, không
//! giản lược contour, bỏ ốc hoặc thay miền góc để tạo một ca dễ hơn. Kiểm nhịp
//! độc lập với `periodic_motif`: các pose phải thuộc cùng lattice hai chiều,
//! tối đa hai phase cứng 0/180, có láng giềng thực ở cả hai hướng.

use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use imposition_core::mixed_nesting::baseline::{
    run_baseline, BaselineAnglePolicy, BaselineError, BaselineOutcome,
};
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, ProgressChannel, RunControl, SearchEffort,
};
use imposition_core::mixed_nesting::model::{
    ContractErrorCode, FixedObstacleKind, FixedObstacleSpec, LayoutIntent, ManifestStatus,
    MixedNestingRequest, PlacementRecord, PointMm, Pose, RunStats, SheetAxisClearanceMm, Tolerance,
    UnplacedRecord,
};
use imposition_core::mixed_nesting::multi_start::{solve, SolveOutcome};
use imposition_core::mixed_nesting::normalize::{
    normalize_request, NormalizeFailure, NormalizedRequest,
};
use imposition_core::mixed_nesting::validator::{validate_layout, LayoutUnderReview};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    source_pdf: String,
    source_sha256: String,
    settings: serde_json::Value,
    cases: Vec<UserCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserCase {
    source_page: u32,
    label: String,
    observed_count_floor: usize,
    engine_request: MixedNestingRequest,
    observed_greedy_placements: Vec<PlacementRecord>,
}

fn fixture() -> &'static Fixture {
    static VALUE: OnceLock<Fixture> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!(
            "fixtures/step_repeat_user_pages_20260907.json"
        ))
        .expect("fixture audit thực phải đọc được")
    })
}

fn control(request: &NormalizedRequest, deadline: bool, worker_grant: usize) -> RunControl {
    let effort = SearchEffort::for_profile(request.profile);
    let stop = effort.stop_criterion(if deadline {
        assert_eq!(request.time_budget_ms, Some(3_000));
        request.time_budget_ms
    } else {
        None
    });
    RunControl::new_with_nfp_resources(
        stop,
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
        worker_grant,
        u64::MAX,
    )
}

fn assert_independent_valid(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
    unplaced: &[UnplacedRecord],
    stats: Option<&RunStats>,
) {
    let report = validate_layout(
        request,
        &LayoutUnderReview {
            placements,
            unplaced,
            stats,
        },
    );
    assert!(report.valid, "validator độc lập: {:?}", report.codes());
    assert!(placements.iter().all(|item| item.sheet_index == 0));
    // Miền cardinal là input thực, không phải test tự thu hẹp xuống 0/180.
    assert!(placements
        .iter()
        .all(|item| [0.0, 90.0, 180.0, 270.0]
            .iter()
            .any(|angle| (item.pose.rotation_deg - angle).abs() <= Tolerance::v1().angular_deg)));
}

fn baseline_cases() -> &'static Vec<(NormalizedRequest, BaselineOutcome)> {
    static VALUE: OnceLock<Vec<(NormalizedRequest, BaselineOutcome)>> = OnceLock::new();
    VALUE.get_or_init(|| {
        fixture()
            .cases
            .iter()
            .map(|case| {
                let request =
                    normalize_request(&case.engine_request).expect("request thật phải hợp lệ");
                let run_control = control(&request, false, 1);
                assert_eq!(run_control.stop_criterion().time_budget_ms, None);
                let started = Instant::now();
                let result =
                    run_baseline(&request, &run_control, BaselineAnglePolicy::FirstAllowed)
                        .expect("baseline fixed-work trên contour thật phải chạy");
                eprintln!(
                    "NESTROW baseline page={} {} count={} floor={} periodic={} elapsed_ms={}",
                    case.source_page,
                    case.label,
                    result.placements.len(),
                    case.observed_count_floor,
                    result.periodic_motif,
                    started.elapsed().as_millis()
                );
                assert_independent_valid(&request, &result.placements, &result.unplaced, None);
                (request, result)
            })
            .collect()
    })
}

fn deadline_cases() -> &'static Vec<(NormalizedRequest, SolveOutcome)> {
    static VALUE: OnceLock<Vec<(NormalizedRequest, SolveOutcome)>> = OnceLock::new();
    VALUE.get_or_init(|| {
        fixture()
            .cases
            .iter()
            .map(|case| {
                let request =
                    normalize_request(&case.engine_request).expect("request thật phải hợp lệ");
                let effort = SearchEffort::for_profile(request.profile);
                let run_control = control(&request, true, 1);
                // Không được chỉ khai timeBudgetMs trong JSON rồi chạy control unbounded.
                assert_eq!(run_control.stop_criterion().time_budget_ms, Some(3_000));
                let started = Instant::now();
                let result = solve(
                    &request,
                    effort,
                    &run_control,
                    BaselineAnglePolicy::FirstAllowed,
                )
                .expect("S&R production budget phải công bố kết quả đúng hợp đồng");
                eprintln!(
                    "NESTROW deadline page={} {} count={} floor={} elapsed_ms={} termination={:?}",
                    case.source_page,
                    case.label,
                    result.placements.len(),
                    case.observed_count_floor,
                    started.elapsed().as_millis(),
                    result.stats.termination_reason
                );
                eprintln!(
                    "NESTROW phases page={}: {:?}",
                    case.source_page, result.phase_timings
                );
                assert_eq!(result.status, ManifestStatus::Completed);
                assert_independent_valid(
                    &request,
                    &result.placements,
                    &result.unplaced,
                    Some(&result.stats),
                );
                (request, result)
            })
            .collect()
    })
}

type Vector = (f64, f64);

fn delta(a: Vector, b: Vector) -> Vector {
    (a.0 - b.0, a.1 - b.1)
}
fn near(a: Vector, b: Vector) -> bool {
    let eps = Tolerance::v1().linear_mm;
    (a.0 - b.0).abs() <= eps && (a.1 - b.1).abs() <= eps
}

#[derive(Debug)]
struct PeriodicProof {
    u: Vector,
    v: Vector,
    phase_count: usize,
    adjacent_u: usize,
    adjacent_v: usize,
}

fn lattice_coordinates(points: &[Vector], u: Vector, v: Vector) -> Option<BTreeSet<(i64, i64)>> {
    let determinant = u.0 * v.1 - u.1 * v.0;
    if determinant.abs() <= Tolerance::v1().linear_mm {
        return None;
    }
    let origin = points[0];
    let mut coordinates = BTreeSet::new();
    for &point in points {
        let p = delta(point, origin);
        let c = (p.0 * v.1 - p.1 * v.0) / determinant;
        let r = (u.0 * p.1 - u.1 * p.0) / determinant;
        let c_int = c.round() as i64;
        let r_int = r.round() as i64;
        if !near(
            p,
            (
                c_int as f64 * u.0 + r_int as f64 * v.0,
                c_int as f64 * u.1 + r_int as f64 * v.1,
            ),
        ) {
            return None;
        }
        if !coordinates.insert((c_int, r_int)) {
            return None;
        }
    }
    Some(coordinates)
}

fn periodic_proof(placements: &[PlacementRecord]) -> Option<PeriodicProof> {
    if placements.len() < 9 {
        return None;
    }
    let mut phases: Vec<(f64, Vec<Vector>)> = Vec::new();
    for placement in placements {
        let angle = placement.pose.rotation_deg;
        let point = (placement.pose.translate_x_mm, placement.pose.translate_y_mm);
        if !angle.is_finite() || !point.0.is_finite() || !point.1.is_finite() {
            return None;
        }
        if let Some(phase) = phases
            .iter_mut()
            .find(|(a, _)| (*a - angle).abs() <= Tolerance::v1().angular_deg)
        {
            phase.1.push(point);
        } else {
            phases.push((angle, vec![point]));
        }
    }
    if phases.is_empty() || phases.len() > 2 {
        return None;
    }
    if phases.len() == 2
        && ((phases[0].0 - phases[1].0).abs() - 180.0).abs() > Tolerance::v1().angular_deg
    {
        return None;
    }
    if phases.len() == 2 && phases.iter().any(|(_, points)| points.len() < 4) {
        // Một tem lẻ bất kỳ không đủ bằng chứng cho phase thứ hai của motif.
        return None;
    }
    phases.sort_by_key(|(_, points)| std::cmp::Reverse(points.len()));
    let primary = &phases[0].1;
    let eps = Tolerance::v1().linear_mm;
    // Basis phải là chênh lệch có láng giềng thật lặp >=3 lần. Không cho lattice
    // micro-grid 1e-6 "giải thích" mọi số thập phân của bố cục greedy bất kỳ.
    let mut differences: Vec<(Vector, usize)> = Vec::new();
    for i in 0..primary.len() {
        for j in i + 1..primary.len() {
            let mut d = delta(primary[j], primary[i]);
            if d.1 < -eps || (d.1.abs() <= eps && d.0 < 0.0) {
                d = (-d.0, -d.1);
            }
            if near(d, (0.0, 0.0)) {
                return None;
            }
            if let Some(entry) = differences.iter_mut().find(|(other, _)| near(*other, d)) {
                entry.1 += 1;
            } else {
                differences.push((d, 1));
            }
        }
    }
    let mut vectors: Vec<Vector> = differences
        .into_iter()
        .filter(|(_, count)| *count >= 3)
        .map(|(vector, _)| vector)
        .collect();
    vectors.sort_by(|a, b| (a.0 * a.0 + a.1 * a.1).total_cmp(&(b.0 * b.0 + b.1 * b.1)));
    for (i, &u) in vectors.iter().enumerate() {
        for &v in vectors.iter().skip(i + 1) {
            let Some(primary_coords) = lattice_coordinates(primary, u, v) else {
                continue;
            };
            let adjacent_u = primary_coords
                .iter()
                .filter(|(c, r)| primary_coords.contains(&(c + 1, *r)))
                .count();
            let adjacent_v = primary_coords
                .iter()
                .filter(|(c, r)| primary_coords.contains(&(*c, r + 1)))
                .count();
            let columns: BTreeSet<i64> = primary_coords.iter().map(|(c, _)| *c).collect();
            let rows: BTreeSet<i64> = primary_coords.iter().map(|(_, r)| *r).collect();
            if adjacent_u < 3 || adjacent_v < 3 || columns.len() < 3 || rows.len() < 3 {
                continue;
            }
            // Mỗi hướng xoay là một phase cố định của cùng basis. Cho phép bỏ
            // member/cell vì ốc, không cho đẩy riêng điểm ra khỏi hai coset này.
            if phases
                .iter()
                .all(|(_, points)| lattice_coordinates(points, u, v).is_some())
            {
                if phases.len() == 2 {
                    let secondary = lattice_coordinates(&phases[1].1, u, v).unwrap();
                    if primary_coords.intersection(&secondary).count() < 4 {
                        continue;
                    }
                }
                return Some(PeriodicProof {
                    u,
                    v,
                    phase_count: phases.len(),
                    adjacent_u,
                    adjacent_v,
                });
            }
        }
    }
    None
}

#[test]
fn fixture_keeps_exact_user_contours_settings_marks_and_rotation_domain() {
    let fixture = fixture();
    assert_eq!(fixture.source_pdf, "test/test nesting.pdf");
    assert_eq!(
        fixture.source_sha256,
        "efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab"
    );
    assert_eq!(fixture.settings["sheetWidth"], 320);
    assert_eq!(fixture.settings["sheetHeight"], 430);
    assert_eq!(fixture.settings["gapX"], 2);
    assert_eq!(fixture.settings["gapY"], 2);
    assert_eq!(fixture.cases.len(), 4);
    for (case, (page, vertices, floor)) in
        fixture
            .cases
            .iter()
            .zip([(6, 67, 66), (7, 45, 66), (8, 70, 57), (12, 118, 29)])
    {
        assert_eq!(case.source_page, page);
        assert_eq!(case.observed_count_floor, floor);
        assert_eq!(case.observed_greedy_placements.len(), floor);
        assert_eq!(case.engine_request.parts[0].outer.len(), vertices);
        assert_eq!(case.engine_request.time_budget_ms, Some(3_000));
        assert_eq!(
            case.engine_request.layout_intent,
            LayoutIntent::StepRepeatSingleSheet
        );
        let normalized =
            normalize_request(&case.engine_request).expect("fixture production phải normalize");
        assert_eq!(normalized.fixed_obstacles().len(), 4);
        let contract = normalized.production_contract.as_ref().unwrap();
        assert_eq!(contract.clearance.part_to_part.x_mm, 2.0);
        assert_eq!(contract.clearance.part_to_part.y_mm, 2.0);
        assert_independent_valid(&normalized, &case.observed_greedy_placements, &[], None);
    }
}

#[test]
fn proof_checker_rejects_observed_greedy_and_accepts_rigid_skew_with_missing_members() {
    for case in &fixture().cases {
        assert!(
            periodic_proof(&case.observed_greedy_placements).is_none(),
            "checker không được hợp thức hóa drift của nguồn {}",
            case.source_page
        );
    }
    // Test toán học cho checker, không tuyên bố mẫu nhân tạo này vừa tờ/đủ gap.
    let mut synthetic = Vec::new();
    for row in 0..5 {
        for column in 0..4 {
            for phase in 0..2 {
                if row == 0 && column == 0 && phase == 1 {
                    continue;
                }
                let mut placement = fixture().cases[0].observed_greedy_placements[0].clone();
                placement.instance_id = format!("trang-6#{:04}", synthetic.len() + 1);
                placement.pose.rotation_deg = phase as f64 * 180.0;
                placement.pose.translate_x_mm =
                    10.0 + column as f64 * 90.0 + row as f64 * 7.0 + phase as f64 * 41.0;
                placement.pose.translate_y_mm = 20.0 + row as f64 * 60.0 + phase as f64 * 3.0;
                synthetic.push(placement);
            }
        }
    }
    let proof = periodic_proof(&synthetic).expect("phải nhận lattice xiên và cell bị bỏ vì ốc");
    assert_eq!(proof.phase_count, 2);
    assert!(proof.adjacent_u >= 3 && proof.adjacent_v >= 3);
    assert!((proof.u.0 * proof.v.1 - proof.u.1 * proof.v.0).abs() > 0.0);
    let mut singleton_phase: Vec<_> = synthetic
        .iter()
        .filter(|p| p.pose.rotation_deg == 0.0)
        .cloned()
        .collect();
    assert!(
        periodic_proof(&singleton_phase).is_some(),
        "lattice một hướng vẫn hợp lệ"
    );
    singleton_phase.push(
        synthetic
            .iter()
            .find(|p| p.pose.rotation_deg == 180.0)
            .unwrap()
            .clone(),
    );
    assert!(
        periodic_proof(&singleton_phase).is_none(),
        "một tem khác hướng lẻ không phải phase có bằng chứng"
    );
    synthetic[16].pose.translate_y_mm += 0.02;
    assert!(
        periodic_proof(&synthetic).is_none(),
        "một member bị đẩy 0.02 mm là mất motif"
    );
}

#[test]
fn actual_user_baseline_is_periodic_beyond_first_row() {
    let failures: Vec<_> = fixture()
        .cases
        .iter()
        .zip(baseline_cases())
        .filter_map(|(case, (_, outcome))| {
            let proof = periodic_proof(&outcome.placements);
            eprintln!("NESTROW basis page={}: {proof:?}", case.source_page);
            (!outcome.periodic_motif || proof.is_none()).then_some(case.source_page)
        })
        .collect();
    assert!(
        failures.is_empty(),
        "S&R không được công bố greedy mất nhịp: nguồn {failures:?}"
    );
}

#[test]
fn actual_user_baseline_keeps_recorded_density_floors() {
    let losses: Vec<_> = fixture()
        .cases
        .iter()
        .zip(baseline_cases())
        .filter_map(|(case, (_, outcome))| {
            (outcome.placements.len() < case.observed_count_floor).then_some((
                case.source_page,
                outcome.placements.len(),
                case.observed_count_floor,
            ))
        })
        .collect();
    assert!(
        losses.is_empty(),
        "Không âm thầm hạ sàn (trang, actual, floor): {losses:?}"
    );
}

#[test]
fn actual_user_production_deadline_publishes_only_periodic_geometry() {
    let failures: Vec<_> = fixture()
        .cases
        .iter()
        .zip(deadline_cases())
        .filter_map(|(case, (_, outcome))| {
            periodic_proof(&outcome.placements)
                .is_none()
                .then_some(case.source_page)
        })
        .collect();
    assert!(
        failures.is_empty(),
        "Control 3000 ms không được công bố greedy mất nhịp: {failures:?}"
    );
}

#[test]
fn actual_user_production_deadline_keeps_recorded_density_floors() {
    let losses: Vec<_> = fixture()
        .cases
        .iter()
        .zip(deadline_cases())
        .filter_map(|(case, (_, outcome))| {
            (outcome.placements.len() < case.observed_count_floor).then_some((
                case.source_page,
                outcome.placements.len(),
                case.observed_count_floor,
            ))
        })
        .collect();
    assert!(
        losses.is_empty(),
        "Production 3000 ms giảm sàn (trang, actual, floor): {losses:?}"
    );
}

#[test]
fn actual_user_fixed_work_solve_is_deterministic_across_worker_grants() {
    for (case, (request, _)) in fixture().cases.iter().zip(baseline_cases()) {
        let effort = SearchEffort::for_profile(request.profile);
        let first = solve(
            request,
            effort,
            &control(request, false, 1),
            BaselineAnglePolicy::FirstAllowed,
        )
        .expect("solve fixed-work grant 1");
        let second = solve(
            request,
            effort,
            &control(request, false, 3),
            BaselineAnglePolicy::FirstAllowed,
        )
        .expect("solve fixed-work grant 3");
        assert_eq!(
            first.placements, second.placements,
            "nguồn {} đổi pose theo worker",
            case.source_page
        );
        assert_eq!(first.selected_score, second.selected_score);
        assert_independent_valid(
            request,
            &second.placements,
            &second.unplaced,
            Some(&second.stats),
        );
        assert!(
            periodic_proof(&second.placements).is_some(),
            "deterministic không thay thế hợp đồng đều hàng"
        );
    }
}

#[test]
fn freegang_same_actual_contour_is_not_forced_into_step_repeat_policy() {
    let mut raw = fixture().cases[0].engine_request.clone();
    raw.layout_intent = LayoutIntent::AutofillSingleSheet;
    let request = normalize_request(&raw).expect("free-gang cùng contour/gap/ốc phải hợp lệ");
    let outcome = run_baseline(
        &request,
        &control(&request, false, 1),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("free-gang phải giữ luật xếp riêng");
    assert!(
        !outcome.periodic_motif,
        "không được khóa motif chỉ vì job có một loại tem"
    );
    assert_independent_valid(&request, &outcome.placements, &outcome.unplaced, None);
}

fn synthetic_step_repeat_rectangle(
    width: f64,
    height: f64,
    sheet_width: f64,
    sheet_height: f64,
    angles: &[f64],
) -> MixedNestingRequest {
    // Ca biên riêng, không thay fixture thực hoặc các sàn sức chứa của người dùng.
    let mut value = serde_json::to_value(&fixture().cases[0].engine_request).unwrap();
    value["productionContract"] = serde_json::Value::Null;
    value["gapMm"] = serde_json::json!(0.0);
    value["sheet"] = serde_json::json!({
        "widthMm": sheet_width, "heightMm": sheet_height, "maxSheets": 1,
        "marginMm": {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0},
    });
    value["orientationPolicy"] = serde_json::json!({
        "defaultRotation": {"mode": "discrete", "anglesDeg": angles},
        "reflection": "forbidden",
    });
    value["parts"] = serde_json::json!([{
        "partId": "boundary-rectangle",
        "outer": [[0.0, 0.0], [width, 0.0], [width, height], [0.0, height]],
        "holes": [], "rotationConstraint": {"mode": "inherit"},
        "referencePointMm": [0.0, 0.0],
    }]);
    serde_json::from_value(value).expect("ca tổng hợp phải đúng schema trước khi normalize")
}

#[test]
fn step_repeat_bootstraps_allowed_non_cardinal_without_freegang_rescue() {
    let request = normalize_request(&synthetic_step_repeat_rectangle(
        120.0,
        10.0,
        100.0,
        112.0,
        &[0.0, 60.0],
    ))
    .expect("nan chỉ vừa ở góc 60 độ là request hợp lệ");
    let outcome = solve(
        &request,
        SearchEffort::for_profile(request.profile),
        &control(&request, false, 1),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("chỉ góc 60 độ vừa vẫn phải có mẫu S&R hợp lệ");
    assert!(!outcome.placements.is_empty());
    assert!(outcome.validation.valid);
    assert!(
        outcome
            .placements
            .iter()
            .all(|placement| (placement.pose.rotation_deg - 60.0).abs()
                <= Tolerance::v1().angular_deg)
    );
}

#[test]
fn step_repeat_rejects_oversized_capacity_at_contract_boundary() {
    let raw = synthetic_step_repeat_rectangle(0.5, 0.5, 200.0, 200.0, &[0.0]);
    // Contract đã chặn cận 160.000 con trước allocation của solver. Không ép một
    // request không reachable qua normalize rồi gọi đó là reproducer OOM runtime.
    let Err(NormalizeFailure::Contract(errors)) = normalize_request(&raw) else {
        panic!("phải từ chối cận sức chứa vượt protocol trước khi vào solver");
    };
    assert!(errors
        .items()
        .iter()
        .any(|error| error.code == ContractErrorCode::AutofillCapacityBoundTooLarge));
}

#[test]
fn step_repeat_cancel_before_floor_never_returns_a_manifest() {
    let request = normalize_request(&fixture().cases[0].engine_request).unwrap();
    let token = CancelToken::new();
    token.cancel();
    let run_control = RunControl::new_with_nfp_resources(
        SearchEffort::for_profile(request.profile).stop_criterion(None),
        token,
        Arc::new(ProgressChannel::new()),
        1,
        u64::MAX,
    );
    assert_eq!(
        run_baseline(&request, &run_control, BaselineAnglePolicy::FirstAllowed),
        Err(BaselineError::Interrupted(Interrupt::Cancelled)),
    );
}

#[test]
fn step_repeat_obstacle_corridor_has_a_periodic_positive_floor() {
    let mut raw = synthetic_step_repeat_rectangle(80.0, 80.0, 100.0, 100.0, &[0.0]);
    let mut contract = fixture().cases[0]
        .engine_request
        .production_contract
        .clone()
        .unwrap();
    contract.clearance.part_to_part = SheetAxisClearanceMm::zero();
    contract.clearance.part_to_obstacle = SheetAxisClearanceMm::zero();
    contract.clearance.part_to_sheet_edge = SheetAxisClearanceMm::zero();
    contract.placement_zones.clear();
    contract.fixed_obstacles = [("left-strip", 0.0, 3.0), ("right-strip", 88.0, 100.0)]
        .into_iter()
        .map(|(id, left, right)| FixedObstacleSpec {
            obstacle_id: id.to_string(),
            kind: FixedObstacleKind::SheetMark,
            outer: vec![
                PointMm::new(left, 0.0),
                PointMm::new(right, 0.0),
                PointMm::new(right, 100.0),
                PointMm::new(left, 100.0),
            ],
        })
        .collect();
    raw.production_contract = Some(contract);
    let request = normalize_request(&raw).expect("corridor đủ rộng là request hợp lệ");
    let witness = PlacementRecord {
        instance_id: "boundary-rectangle#0001".to_string(),
        part_id: "boundary-rectangle".to_string(),
        sheet_index: 0,
        pose: Pose::new(0.0, 4.0, 10.0),
        source_revision: None,
    };
    assert_independent_valid(&request, &[witness], &[], None);
    let baseline = run_baseline(
        &request,
        &control(&request, false, 1),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("S&R phải tìm được phase giữa hai vật cản");
    assert!(
        !baseline.placements.is_empty(),
        "mép/midpoint không đủ: witness(4,10) đã được validator chấp nhận"
    );
    assert!(baseline.periodic_motif);
    let outcome = solve(
        &request,
        SearchEffort::for_profile(request.profile),
        &control(&request, false, 1),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("không được báo BaselineInvalid khi corridor còn chỗ");
    assert_independent_valid(
        &request,
        &outcome.placements,
        &outcome.unplaced,
        Some(&outcome.stats),
    );
}
