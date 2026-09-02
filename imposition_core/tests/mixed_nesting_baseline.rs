//! Test baseline và điểm chuẩn — phase P3a.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.1, §11.5.
//!
//! Bộ test này phải chứng minh:
//!
//! 1. Baseline **constraint-safe**: mọi kết quả đi qua final validator độc lập.
//! 2. Baseline **deterministic**: cùng đầu vào cho cùng kết quả từng chữ số.
//! 3. Tịnh tiến vẫn **liên tục** — vị trí không nằm trên lưới nào.
//! 4. Baseline **tôn trọng ràng buộc xoay** của từng chi tiết.
//! 5. Baseline cardinal **không** là mặc định, và chính sách góc là tham số tường minh.
//! 6. Điểm chuẩn là **thứ tự toàn phần**, đúng thứ tự lexicographic của §11.5, và
//!    `materialUtilization` không nằm trong thứ tự đó.

use imposition_core::mixed_nesting::baseline::{
    baseline_angles, run_baseline, run_rotation_probe_from_baseline, BaselineAnglePolicy,
    BaselineOutcome, BASELINE_VERSION, MAX_CANDIDATES_PER_ANGLE,
};
use imposition_core::mixed_nesting::collision::{
    judge_pair, min_distance_mm, rings_overlap, PairVerdict,
};
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::Tolerance;
use imposition_core::mixed_nesting::model::{
    AxisAlignedBoundsSpec, ClearanceSpec, FixedObstacleKind, FixedObstacleSpec, GroupingIntent,
    LayoutAlignment, LayoutIntent, MixedNestingRequest, OrientationPolicy, PartPlacementZoneSpec,
    PartSpec, PlacementRecord, PointMm, Pose, ProductionContractV1, Profile, Reflection,
    RotationConstraint, SheetAxisClearanceMm, SheetMarginMm, SheetSpec, TerminationReason,
    UnplacedReason, MIXED_NESTING_PRODUCTION_SCHEMA_VERSION, MIXED_NESTING_PROTOCOL_VERSION,
};
use imposition_core::mixed_nesting::multi_start::{solve, SolutionSource};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::orientation::{resolve_rotation_domain, RotationDomain};
use imposition_core::mixed_nesting::score::{
    score_layout, LayoutScore, PlacementKey, SCORE_VERSION,
};
use imposition_core::mixed_nesting::solver::{plan_trials, run_trial};
use imposition_core::mixed_nesting::validator::{
    recompute_stats, validate_layout, LayoutUnderReview, RunCounters,
};
use std::collections::BTreeMap;
use std::sync::Arc;

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

fn shape_motif_nua_vong() -> Vec<PointMm> {
    // Footprint thu gọn từ trang 9 của test/test nesting.pdf. Giữ fixture tại Rust để
    // regression không phụ thuộc file PDF hay sidecar Python.
    vec![
        pt(29.360679, 7.955795),
        pt(30.752230, 8.201384),
        pt(31.934278, 8.862663),
        pt(34.221444, 8.051273),
        pt(35.487164, 8.224541),
        pt(36.538686, 8.772281),
        pt(37.738327, 8.317566),
        pt(45.056116, 8.992809),
        pt(46.089969, 9.179583),
        pt(47.214132, 9.895228),
        pt(49.485941, 9.663291),
        pt(51.561924, 10.659894),
        pt(53.049000, 10.317101),
        pt(54.564810, 10.847694),
        pt(55.569599, 12.174677),
        pt(55.820272, 13.541567),
        pt(55.058756, 16.041083),
        pt(55.060128, 19.343409),
        pt(54.085000, 22.179585),
        pt(53.104418, 23.257455),
        pt(51.980065, 23.715995),
        pt(52.514031, 25.559049),
        pt(52.498469, 26.838243),
        pt(51.784928, 29.310458),
        pt(40.940600, 48.512364),
        pt(33.903422, 61.807323),
        pt(32.419322, 63.760988),
        pt(31.154033, 64.163085),
        pt(29.961515, 63.809840),
        pt(28.332837, 61.829519),
        pt(20.464677, 47.381371),
        pt(11.904210, 29.901768),
        pt(10.779235, 26.319600),
        pt(10.844408, 23.244472),
        pt(9.523215, 22.694930),
        pt(8.883305, 21.957144),
        pt(5.422629, 12.816108),
        pt(5.738148, 11.421860),
        pt(7.040330, 10.367492),
        pt(9.430775, 9.924690),
        pt(10.824155, 10.218012),
        pt(11.459839, 9.708220),
        pt(13.384933, 9.202183),
        pt(15.402610, 9.309945),
        pt(16.635017, 8.828237),
        pt(18.791661, 8.638629),
        pt(20.835796, 8.835933),
        pt(21.542148, 9.376098),
        pt(22.553894, 8.562730),
        pt(23.927669, 8.136193),
        pt(25.369503, 8.185730),
        pt(26.648591, 8.640931),
    ]
}

fn shape_lattice_cung_huong() -> Vec<PointMm> {
    // Footprint trang 7 của test/test nesting.pdf: phần đầu hẹp, thân phình nên hàng
    // kế tiếp ăn vào nửa nhịp. Đây là fixture bắt lỗi greedy tích lũy drift theo hàng.
    vec![
        pt(24.902869, 1.332084),
        pt(28.029146, 1.866307),
        pt(30.919270, 3.286372),
        pt(32.078549, 4.333506),
        pt(32.936492, 5.609121),
        pt(33.404573, 7.110158),
        pt(33.035083, 10.193329),
        pt(31.074159, 13.453379),
        pt(34.907345, 14.532190),
        pt(37.845056, 15.852990),
        pt(38.921842, 16.812682),
        pt(40.376080, 19.259489),
        pt(40.801012, 21.692873),
        pt(47.093521, 25.434239),
        pt(48.868466, 27.373572),
        pt(49.291524, 28.683188),
        pt(49.089076, 31.297098),
        pt(47.378134, 34.797438),
        pt(44.540583, 38.030466),
        pt(40.981204, 40.559752),
        pt(36.946503, 42.405127),
        pt(32.679427, 43.585705),
        pt(27.045842, 44.155425),
        pt(21.128619, 43.652361),
        pt(16.602922, 42.591374),
        pt(10.826409, 40.233326),
        pt(6.944324, 37.733949),
        pt(4.681767, 35.709225),
        pt(2.749663, 33.391354),
        pt(0.721869, 29.587500),
        pt(0.413503, 26.714993),
        pt(0.841153, 25.332371),
        pt(1.622946, 24.167999),
        pt(3.914606, 22.381645),
        pt(9.207111, 20.089121),
        pt(9.956293, 17.315182),
        pt(10.603725, 16.118030),
        pt(12.853148, 14.027261),
        pt(15.144024, 12.983494),
        pt(19.944065, 12.631885),
        pt(18.278597, 7.367239),
        pt(18.634812, 4.686530),
        pt(19.398528, 3.459109),
        pt(20.642471, 2.353692),
        pt(22.382549, 1.585181),
    ]
}

fn translated(ring: &[PointMm], dx: f64, dy: f64) -> Vec<PointMm> {
    ring.iter()
        .map(|point| pt(point.x + dx, point.y + dy))
        .collect()
}

/// Đường phán quyết trước §NEST-D1-A: sau khi kiểm overlap, `min_distance_mm`
/// kiểm lại overlap lần hai. Chỉ dùng cho parity/A-B test, không đi vào production.
fn judge_pair_reference(
    a: &[PointMm],
    b: &[PointMm],
    gap_mm: f64,
    tolerance: &Tolerance,
) -> PairVerdict {
    if rings_overlap(a, b, tolerance) {
        return PairVerdict::Overlap;
    }
    let measured = min_distance_mm(a, b, tolerance);
    if measured + tolerance.linear_mm < gap_mm {
        PairVerdict::ClearanceTooSmall {
            measured_mm: measured,
            required_mm: gap_mm,
        }
    } else {
        PairVerdict::Ok {
            measured_mm: measured,
        }
    }
}

fn measure_reference_pairs(
    subject: &[PointMm],
    cases: &[(Vec<PointMm>, f64)],
    iterations: usize,
) -> (std::time::Duration, usize) {
    let mut checksum = 0usize;
    let started = std::time::Instant::now();
    for _ in 0..iterations {
        for (other, gap) in cases {
            checksum ^= std::hint::black_box(judge_pair_reference(subject, other, *gap, &tol()))
                .is_ok() as usize;
        }
    }
    (started.elapsed(), checksum)
}

fn measure_optimized_pairs(
    subject: &[PointMm],
    cases: &[(Vec<PointMm>, f64)],
    iterations: usize,
) -> (std::time::Duration, usize) {
    let mut checksum = 0usize;
    let started = std::time::Instant::now();
    for _ in 0..iterations {
        for (other, gap) in cases {
            checksum ^=
                std::hint::black_box(judge_pair(subject, other, *gap, &tol())).is_ok() as usize;
        }
    }
    (started.elapsed(), checksum)
}

fn control() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    )
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

fn request_with(
    parts: Vec<PartSpec>,
    sheet_w: f64,
    sheet_h: f64,
    gap: f64,
    max_sheets: u32,
) -> MixedNestingRequest {
    MixedNestingRequest {
        protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
        seed: 20_260_826,
        profile: Profile::Balanced,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: sheet_w,
            height_mm: sheet_h,
            margin_mm: SheetMarginMm {
                left: 10.0,
                right: 10.0,
                top: 10.0,
                bottom: 10.0,
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
    normalize_request(&request_with(parts, 700.0, 1000.0, 3.0, 20)).expect("hợp lệ")
}

fn normalized_maximize_area(mut parts: Vec<PartSpec>, autofill: bool) -> NormalizedRequest {
    if autofill {
        for item in &mut parts {
            item.quantity = 0;
        }
    }
    let mut request = request_with(parts, 120.0, 120.0, 0.0, if autofill { 1 } else { 2 });
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
        // Cố ý đảo thứ tự: mọi producer phải dùng association partId.
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

fn with_production_obstacle(mut request: MixedNestingRequest) -> MixedNestingRequest {
    request.gap_mm = 0.0;
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
            kind: FixedObstacleKind::Gripper,
            outer: vec![
                pt(10.0, 10.0),
                pt(70.0, 10.0),
                pt(70.0, 90.0),
                pt(10.0, 90.0),
            ],
        }],
    });
    request
}

fn normalized_autofill(
    mut parts: Vec<PartSpec>,
    sheet_w: f64,
    sheet_h: f64,
    gap: f64,
) -> NormalizedRequest {
    for part in &mut parts {
        part.quantity = 0;
    }
    let mut request = request_with(parts, sheet_w, sheet_h, gap, 1);
    request.layout_intent = LayoutIntent::AutofillSingleSheet;
    normalize_request(&request).expect("autofill phải hợp lệ")
}

fn normalized_step_repeat(
    mut parts: Vec<PartSpec>,
    sheet_w: f64,
    sheet_h: f64,
    gap: f64,
) -> NormalizedRequest {
    for part in &mut parts {
        part.quantity = 0;
    }
    let mut request = request_with(parts, sheet_w, sheet_h, gap, 1);
    request.layout_intent = LayoutIntent::StepRepeatSingleSheet;
    normalize_request(&request).expect("S&R một tờ phải hợp lệ")
}

fn placement_counts(placements: &[PlacementRecord]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for placement in placements {
        *counts.entry(placement.part_id.clone()).or_insert(0) += 1;
    }
    counts
}

/// Chạy baseline rồi **bắt buộc** cho qua validator — đúng như đường sản xuất.
fn baseline_and_validate(
    request: &NormalizedRequest,
    policy: BaselineAnglePolicy,
) -> (Vec<PlacementRecord>, u64, u32) {
    let outcome = run_baseline(request, &control(), policy).expect("baseline phải chạy");
    let report = validate_layout(
        request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(
        report.valid,
        "baseline PHẢI qua validator, lỗi: {:?}",
        report.codes()
    );
    (
        outcome.placements,
        outcome.unplaced.len() as u64,
        outcome.sheet_count,
    )
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Baseline constraint-safe
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn version_baseline_va_score() {
    assert_eq!(BASELINE_VERSION, 12);
    assert_eq!(SCORE_VERSION, 2);
    // Trần ứng viên phải đủ rộng để đỉnh Bottom-Left đầu tiên hầu như luôn dùng được.
    assert_eq!(MAX_CANDIDATES_PER_ANGLE, 64);
}

#[test]
fn baseline_chu_dong_tranh_fixed_obstacle_truoc_final_validator() {
    let raw = with_production_obstacle(request_with(
        vec![part("part-a", 4, rect(20.0, 20.0))],
        180.0,
        100.0,
        0.0,
        2,
    ));
    let request = normalize_request(&raw).unwrap();
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert_eq!(outcome.placements.len(), 4);
    assert!(outcome.unplaced.is_empty());
    assert!(
        outcome
            .placements
            .iter()
            .all(|placement| placement.pose.translate_x_mm >= 72.0 - tol().linear_mm),
        "baseline không được đặt vào dải boong bên trái: {:?}",
        outcome.placements
    );
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn baseline_production_giu_gap_di_huong_khi_mot_truc_bang_zero() {
    // FIX/PARITY (audit 2026-08-29 §MAP-NEST-07/08): gap của vật cản cố ý rất lớn
    // nhưng không có vật cản; nó không được trở thành authority cho cặp part↔part.
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
        let mut raw = request_with(vec![item], width_mm, height_mm, 0.0, 1);
        raw.sheet.margin_mm = SheetMarginMm {
            left: 0.0,
            right: 0.0,
            top: 0.0,
            bottom: 0.0,
        };
        raw.production_contract = Some(ProductionContractV1 {
            schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
            request_revision: 1,
            input_hash: format!("sha256:{}", "7".repeat(64)),
            layout_fingerprint: format!("sha256:{}", "8".repeat(64)),
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
        let request = normalize_request(&raw).expect("request dị hướng phải hợp lệ");
        let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));

        assert_eq!(outcome.placements.len(), 3, "{name}: {outcome:?}");
        assert!(outcome.unplaced.is_empty(), "{name}: {outcome:?}");
        let report = validate_layout(
            &request,
            &LayoutUnderReview {
                placements: &outcome.placements,
                unplaced: &outcome.unplaced,
                stats: None,
            },
        );
        assert!(report.valid, "{name}: {:?}", report.codes());
    }
}

#[test]
fn blank_fit_dung_rieng_gap_vat_can_khi_phan_loai_unplaced() {
    let mut item = part("part-a", 4, rect(10.0, 10.0));
    item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut raw = request_with(vec![item], 41.0, 11.0, 0.0, 1);
    raw.sheet.margin_mm = SheetMarginMm {
        left: 0.0,
        right: 0.0,
        top: 0.0,
        bottom: 0.0,
    };
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "1".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "2".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 10.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 50.0,
            },
        },
        fixed_obstacles: vec![FixedObstacleSpec {
            obstacle_id: "dau-to".to_string(),
            kind: FixedObstacleKind::SheetMark,
            outer: rect(10.0, 10.0),
        }],
    });
    let request = normalize_request(&raw).expect("fixture blank-fit phải hợp lệ");
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("blank-fit dị hướng phải chạy");

    assert_eq!(outcome.placements.len(), 3, "{outcome:?}");
    assert_eq!(outcome.unplaced.len(), 1, "{outcome:?}");
    assert_eq!(outcome.unplaced[0].reason, UnplacedReason::MaxSheetsReached);
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn autofill_tach_gap_vat_can_khoi_gap_giua_cac_part() {
    // Prefix obstacle đi qua full NFP; hai part sau đi qua incremental NFP. Clearance Y
    // lớn của dấu tờ vẫn cho phép xếp sát theo X vì gapX bằng 0.
    let mut item = part("part-a", 0, rect(10.0, 10.0));
    item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut raw = request_with(vec![item], 41.0, 11.0, 0.0, 1);
    raw.layout_intent = LayoutIntent::AutofillSingleSheet;
    raw.sheet.margin_mm = SheetMarginMm {
        left: 0.0,
        right: 0.0,
        top: 0.0,
        bottom: 0.0,
    };
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "9".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "0".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 10.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 0.0,
                y_mm: 50.0,
            },
        },
        fixed_obstacles: vec![FixedObstacleSpec {
            obstacle_id: "dau-to".to_string(),
            kind: FixedObstacleKind::SheetMark,
            outer: rect(10.0, 10.0),
        }],
    });
    let request = normalize_request(&raw).expect("autofill có vật cản phải hợp lệ");
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("autofill dị hướng phải chạy");

    assert_eq!(outcome.placements.len(), 3, "{outcome:?}");
    assert!(outcome.unplaced.is_empty());
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn autofill_mot_mau_tu_sinh_nhieu_instance_khong_can_quantity() {
    let request = normalized_autofill(
        vec![part("part-a", 99, rect(30.0, 20.0))],
        180.0,
        120.0,
        0.0,
    );
    assert_eq!(request.parts[0].quantity, 0);
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert!(
        outcome.placements.len() > 1,
        "autofill phải tự sinh tới khi tờ đầy"
    );
    assert!(
        outcome.unplaced.is_empty(),
        "autofill không có nợ quantity giả"
    );
    assert_eq!(outcome.sheet_count, 1);
    for (index, placement) in outcome.placements.iter().enumerate() {
        assert_eq!(placement.instance_id, format!("part-a#{:04}", index + 1));
        assert_eq!(placement.sheet_index, 0);
    }
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn autofill_khuon_thuon_xen_ke_nua_vong_de_tang_suc_chua() {
    // FIX (audit 2026-08-29 §NEST-HALF-TURN): hình gần tam giác cần quay xen kẽ
    // để hai cạnh xiên ăn vào nhau; deadline smart ngắn không được làm mất phương án này.
    let mut item = part(
        "tam-giac",
        0,
        vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(24.0, 35.0), pt(16.0, 35.0)],
    );
    item.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0, 180.0],
    };
    // request_with có lề 10 mm mỗi cạnh nên vùng dùng được đúng 160×70 mm.
    let request = normalized_autofill(vec![item], 180.0, 90.0, 2.0);

    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline half-turn phải chạy");
    let angles: Vec<f64> = outcome
        .placements
        .iter()
        .map(|placement| placement.pose.rotation_deg)
        .collect();

    assert_eq!(outcome.placements.len(), 6);
    assert_eq!(angles, vec![0.0, 180.0, 0.0, 180.0, 0.0, 180.0]);
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn periodic_half_turn_exact_fit_khong_hut_hang_vi_tolerance() {
    // FIX/PARITY (audit 2026-08-29 §MAP-NEST-07/08): usable cao đúng ba envelope
    // motif. GapY=0 phải giữ đủ ba hàng; tolerance chỉ dùng khi phán quyết, không được
    // cộng lặp vào row step rồi làm capacity hụt còn hai hàng.
    let mut item = part(
        "tam-giac",
        0,
        vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(24.0, 35.0), pt(16.0, 35.0)],
    );
    item.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0, 180.0],
    };
    let mut raw = request_with(vec![item], 160.0, 105.0, 0.0, 1);
    raw.layout_intent = LayoutIntent::StepRepeatSingleSheet;
    raw.sheet.margin_mm = SheetMarginMm {
        left: 0.0,
        right: 0.0,
        top: 0.0,
        bottom: 0.0,
    };
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "3".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "4".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 2.0,
                y_mm: 0.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 50.0,
                y_mm: 50.0,
            },
        },
        fixed_obstacles: Vec::new(),
    });
    let request = normalize_request(&raw).expect("fixture half-turn exact-fit phải hợp lệ");
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("periodic half-turn exact-fit phải chạy");

    assert!(
        outcome.periodic_motif,
        "S&R không được rơi về greedy vì tolerance tích lũy: {outcome:#?}"
    );
    let mut primary_rows: Vec<f64> = Vec::new();
    for placement in outcome
        .placements
        .iter()
        .filter(|placement| placement.pose.rotation_deg == 0.0)
    {
        if !primary_rows
            .iter()
            .any(|y| (*y - placement.pose.translate_y_mm).abs() <= tol().linear_mm)
        {
            primary_rows.push(placement.pose.translate_y_mm);
        }
    }
    assert_eq!(primary_rows.len(), 3, "{outcome:#?}");
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn autofill_motif_nua_vong_lap_cung_cap_qua_nhieu_hang() {
    // MOTIF (audit 2026-08-29 §NEST-PERIODIC-PAIR): ca nhiều hàng phải khóa cùng
    // transform của cặp, không chỉ cho ra histogram 0°/180° đẹp nhưng vị trí trôi.
    let mut item = part("tem-dua-hau", 0, shape_motif_nua_vong());
    item.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0, 180.0],
    };
    // Helper trừ lề 10 mm mỗi cạnh ⇒ usable 314×424 mm như fixture production.
    let request = normalized_step_repeat(vec![item], 334.0, 444.0, 2.0);
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline motif half-turn phải chạy");

    assert!(outcome.placements.len() >= 48);
    assert_eq!(outcome.placements.len() % 2, 0);
    let expected_delta = (
        outcome.placements[1].pose.translate_x_mm - outcome.placements[0].pose.translate_x_mm,
        outcome.placements[1].pose.translate_y_mm - outcome.placements[0].pose.translate_y_mm,
    );
    let mut primary_rows: Vec<f64> = Vec::new();
    for pair in outcome.placements.chunks_exact(2) {
        assert_eq!(pair[0].pose.rotation_deg, 0.0);
        assert_eq!(pair[1].pose.rotation_deg, 180.0);
        let delta = (
            pair[1].pose.translate_x_mm - pair[0].pose.translate_x_mm,
            pair[1].pose.translate_y_mm - pair[0].pose.translate_y_mm,
        );
        assert!((delta.0 - expected_delta.0).abs() <= tol().linear_mm);
        assert!((delta.1 - expected_delta.1).abs() <= tol().linear_mm);
        if !primary_rows
            .iter()
            .any(|y| (*y - pair[0].pose.translate_y_mm).abs() <= tol().linear_mm)
        {
            primary_rows.push(pair[0].pose.translate_y_mm);
        }
    }
    assert!(
        primary_rows.len() > 1,
        "fixture phải thật sự đi qua nhiều hàng"
    );

    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn autofill_lattice_cung_huong_khong_tich_luy_drift_va_chi_bo_cell_de_oc() {
    // MOTIF (audit 2026-08-31 §NEST-PERIODIC-LATTICE): footprint trang 7 phải dùng
    // một basis xuyên suốt. Bốn dấu ốc chỉ làm rỗng cell góc, không đẩy lệch hàng sau.
    let mut item = part("tem-tan-cay", 0, shape_lattice_cung_huong());
    item.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut raw = request_with(vec![item], 320.0, 430.0, 0.0, 1);
    raw.layout_intent = LayoutIntent::StepRepeatSingleSheet;
    raw.sheet.margin_mm = SheetMarginMm {
        left: 3.0,
        right: 3.0,
        top: 3.0,
        bottom: 3.0,
    };
    let obstacle = |id: &str, min_x: f64, min_y: f64| FixedObstacleSpec {
        obstacle_id: id.to_string(),
        kind: FixedObstacleKind::SheetMark,
        outer: vec![
            pt(min_x, min_y),
            pt(min_x + 5.0, min_y),
            pt(min_x + 5.0, min_y + 5.0),
            pt(min_x, min_y + 5.0),
        ],
    };
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "c".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "d".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 2.0,
                y_mm: 2.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm::zero(),
            part_to_obstacle: SheetAxisClearanceMm {
                x_mm: 2.0,
                y_mm: 2.0,
            },
        },
        fixed_obstacles: vec![
            obstacle("oc-trai-duoi", 7.0, 7.0),
            obstacle("oc-phai-duoi", 308.0, 7.0),
            obstacle("oc-trai-tren", 7.0, 418.0),
            obstacle("oc-phai-tren", 308.0, 418.0),
        ],
    });
    let request = normalize_request(&raw).expect("fixture trang 7 phải hợp lệ");
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline lattice cùng hướng phải chạy");

    assert!(
        outcome.periodic_motif,
        "candidate exact sheet-axis phải giữ lattice rigid: {outcome:#?}"
    );
    // Rectangle sheet-axis chính xác thu hồi hai cell từng bị scalar hypot loại nhầm.
    assert_eq!(outcome.placements.len(), 61);
    assert!(outcome
        .placements
        .iter()
        .all(|record| record.pose.rotation_deg == 0.0));
    let first = &outcome.placements[0];
    let second = outcome
        .placements
        .iter()
        .skip(1)
        .find(|record| {
            (record.pose.translate_y_mm - first.pose.translate_y_mm).abs() <= tol().linear_mm
        })
        .expect("hàng đầu phải có nhịp ngang");
    let u = (
        second.pose.translate_x_mm - first.pose.translate_x_mm,
        second.pose.translate_y_mm - first.pose.translate_y_mm,
    );
    let next_row = outcome
        .placements
        .iter()
        .find(|record| record.pose.translate_y_mm > first.pose.translate_y_mm + tol().linear_mm)
        .expect("fixture phải có nhiều hàng");
    let v = (
        next_row.pose.translate_x_mm - first.pose.translate_x_mm,
        next_row.pose.translate_y_mm - first.pose.translate_y_mm,
    );
    assert!(u.0 > 0.0 && u.1.abs() <= tol().linear_mm && v.1 > 0.0);

    let mut max_row = 0i64;
    for record in &outcome.placements {
        let row = ((record.pose.translate_y_mm - first.pose.translate_y_mm) / v.1).round() as i64;
        let column = ((record.pose.translate_x_mm - first.pose.translate_x_mm - row as f64 * v.0)
            / u.0)
            .round() as i64;
        let expected_x = first.pose.translate_x_mm + row as f64 * v.0 + column as f64 * u.0;
        let expected_y = first.pose.translate_y_mm + row as f64 * v.1 + column as f64 * u.1;
        assert!((record.pose.translate_x_mm - expected_x).abs() <= tol().linear_mm);
        assert!((record.pose.translate_y_mm - expected_y).abs() <= tol().linear_mm);
        max_row = max_row.max(row);
    }
    assert!(max_row >= 10, "fixture phải khóa drift qua ít nhất 11 hàng");

    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn solve_giu_periodic_baseline_du_smart_co_score_tot_hon() {
    // Fixture nhỏ nhưng có cạnh tranh thật: lưới 0° chỉ lấp 3×3, còn smart được
    // xoay 90° để tận dụng dải dư 20 mm. Motif vẫn phải thắng theo intent chế bản.
    let mut item = part("tem-chu-nhat", 0, rect(30.0, 20.0));
    item.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0, 90.0],
    };
    let ordinary_request = normalized_autofill(vec![item.clone()], 131.0, 91.0, 0.0);
    let ordinary_baseline = run_baseline(
        &ordinary_request,
        &control(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline N-up autofill thường phải chạy");
    assert!(
        !ordinary_baseline.periodic_motif,
        "N-up một mẫu không được suy thành motif S&R"
    );

    let request = normalized_step_repeat(vec![item], 131.0, 91.0, 0.0);
    let baseline = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline periodic nhỏ phải chạy");
    assert!(
        baseline.periodic_motif,
        "baseline nhỏ chưa thành motif: {:?}",
        baseline.placements,
    );

    let effort = SearchEffort {
        trial_count: 1,
        orientation_proposals_per_part: 4,
        beam_width: 1,
        refinement_rounds: 1,
        multi_start_restarts: 1,
        evaluation_budget: 5_000,
    };
    let bounded_control = || {
        RunControl::new(
            StopCriterion::fixed_work_plan(effort.evaluation_budget),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        )
    };
    let smart = run_trial(
        &request,
        plan_trials(request.seed, effort)[0],
        effort,
        &bounded_control(),
    )
    .expect("smart competitor nhỏ phải chạy");
    assert_ne!(smart.interrupted, Some(Interrupt::Cancelled));
    assert!(smart.completed_sweeps > 0);
    let smart_report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &smart.placements,
            unplaced: &smart.unplaced,
            stats: None,
        },
    );
    assert!(smart_report.valid, "{:?}", smart_report.codes());
    let baseline_score = score_layout(&request, &baseline.placements, 0);
    assert!(
        smart.score.is_better_than(&baseline_score),
        "fixture phải có competitor tốt điểm hơn: smart={:?}, baseline={:?}",
        smart.score,
        baseline_score,
    );

    let ordinary_solved = solve(
        &ordinary_request,
        effort,
        &bounded_control(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("N-up autofill thường phải reduce bằng LayoutScore");
    assert!(
        matches!(ordinary_solved.source, SolutionSource::Trial { .. }),
        "candidate smart tốt điểm hơn phải thắng ngoài mode S&R"
    );

    let solved = solve(
        &request,
        effort,
        &bounded_control(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("solver phải giữ periodic baseline authoritative");
    assert_eq!(solved.source, SolutionSource::Baseline);
    assert_eq!(
        solved.portfolio_execution.planned_trials, 0,
        "motif S&R authoritative không được lập smart portfolio rồi bỏ kết quả"
    );
    assert_eq!(solved.portfolio_execution.dispatched_trials, 0);
    assert_eq!(solved.trials_run, 0);
    assert_eq!(solved.baseline_score.as_ref(), Some(&baseline_score));
    assert!(solved.validation.valid, "{:?}", solved.validation.codes());
    assert_eq!(solved.placements.len(), baseline.placements.len());

    let dx = solved.placements[0].pose.translate_x_mm - baseline.placements[0].pose.translate_x_mm;
    let dy = solved.placements[0].pose.translate_y_mm - baseline.placements[0].pose.translate_y_mm;
    for (published, original) in solved.placements.iter().zip(&baseline.placements) {
        assert_eq!(published.instance_id, original.instance_id);
        assert_eq!(published.part_id, original.part_id);
        assert_eq!(published.sheet_index, original.sheet_index);
        assert_eq!(published.pose.rotation_deg, original.pose.rotation_deg);
        assert!(
            (published.pose.translate_x_mm - original.pose.translate_x_mm - dx).abs()
                <= tol().linear_mm
        );
        assert!(
            (published.pose.translate_y_mm - original.pose.translate_y_mm - dy).abs()
                <= tol().linear_mm
        );
    }
}

#[test]
fn autofill_gang_identical_can_bang_va_co_du_moi_mau() {
    let request = normalized_autofill(
        vec![
            part("part-b", 7, rect(30.0, 20.0)),
            part("part-a", 4, rect(30.0, 20.0)),
        ],
        180.0,
        120.0,
        0.0,
    );
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let counts = placement_counts(&outcome.placements);
    let a = counts.get("part-a").copied().unwrap_or(0);
    let b = counts.get("part-b").copied().unwrap_or(0);
    assert!(
        a > 0 && b > 0,
        "gang autofill phải có đủ mọi mẫu: {counts:?}"
    );
    assert!(
        a.abs_diff(b) <= 1,
        "hai mẫu identical phải cân bằng: {counts:?}"
    );
    assert!(outcome.unplaced.is_empty());
}

#[test]
fn autofill_khong_phu_thuoc_thu_tu_part_dau_vao() {
    let first = normalized_autofill(
        vec![
            part("part-b", 1, rect(30.0, 20.0)),
            part("part-a", 1, rect(30.0, 20.0)),
        ],
        180.0,
        120.0,
        0.0,
    );
    let reversed = normalized_autofill(
        vec![
            part("part-a", 1, rect(30.0, 20.0)),
            part("part-b", 1, rect(30.0, 20.0)),
        ],
        180.0,
        120.0,
        0.0,
    );
    let a = run_baseline(&first, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let b = run_baseline(&reversed, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert_eq!(a, b, "base order phải tách khỏi thứ tự payload");
}

#[test]
fn autofill_no_fit_khong_tao_unplaced_gia() {
    let request = normalized_autofill(
        vec![part("part-huge", 1, rect(130.0, 130.0))],
        120.0,
        120.0,
        0.0,
    );
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert!(outcome.placements.is_empty());
    assert!(
        outcome.unplaced.is_empty(),
        "không có target thì không được tạo nợ sản xuất"
    );
    assert_eq!(outcome.sheet_count, 0);
}

#[test]
fn autofill_van_ton_trong_cancel_hop_tac() {
    let request = normalized_autofill(vec![part("part-a", 1, rect(30.0, 20.0))], 180.0, 120.0, 0.0);
    let token = CancelToken::new();
    token.cancel();
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        token,
        Arc::new(ProgressChannel::new()),
    );
    assert_eq!(
        run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed),
        Err(
            imposition_core::mixed_nesting::baseline::BaselineError::Interrupted(
                Interrupt::Cancelled
            )
        )
    );
}

#[test]
fn solve_autofill_bao_sheet_full_khong_bao_all_placed() {
    let request = normalized_autofill(vec![part("part-a", 1, rect(30.0, 20.0))], 180.0, 120.0, 0.0);
    let outcome = solve(
        &request,
        SearchEffort::for_profile(Profile::Fast),
        &control(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("autofill phải công bố được baseline đã validate");
    assert_eq!(
        outcome.stats.termination_reason,
        TerminationReason::SheetFull
    );
    assert!(outcome.unplaced.is_empty());
    assert!(outcome.validation.valid);
}

#[test]
fn diem_autofill_uu_tien_min_count_truoc_tong_placement() {
    let request = normalized_autofill(
        vec![
            part("part-a", 1, rect(10.0, 10.0)),
            part("part-b", 1, rect(10.0, 10.0)),
        ],
        500.0,
        500.0,
        0.0,
    );
    let make = |part_id: &str, count: u32| {
        (1..=count)
            .map(|ordinal| PlacementRecord {
                instance_id: format!("{part_id}#{ordinal:04}"),
                part_id: part_id.to_string(),
                sheet_index: 0,
                pose: Pose::new(0.0, f64::from(ordinal), 0.0),
                source_revision: None,
            })
            .collect::<Vec<_>>()
    };
    let mut balanced = make("part-a", 5);
    balanced.extend(make("part-b", 5));
    let lopsided = make("part-a", 100);
    let score_balanced = score_layout(&request, &balanced, 0);
    let score_lopsided = score_layout(&request, &lopsided, 0);
    assert!(
        score_balanced.is_better_than(&score_lopsided),
        "5A/5B phải thắng 100A/0B: {score_balanced:?} vs {score_lopsided:?}"
    );
    assert!(score_balanced.unplaced_count < score_lopsided.unplaced_count);
}

#[test]
fn baseline_xep_het_va_qua_validator() {
    let request = normalized(vec![part("part-a", 12, rect(80.0, 40.0))]);
    let (placements, unplaced, sheets) =
        baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(unplaced, 0, "tờ 700×1000 phải đủ chỗ cho 12 con 80×40");
    assert_eq!(placements.len(), 12);
    assert_eq!(sheets, 1, "12 con nhỏ phải vừa một tờ");
}

#[test]
fn baseline_nhieu_loai_chi_tiet_khac_nhau() {
    let request = normalized(vec![
        part("part-a", 6, rect(120.0, 80.0)),
        part("part-b", 8, rect(60.0, 40.0)),
        part("part-c", 4, shape_l()),
    ]);
    let (placements, unplaced, sheets) =
        baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(unplaced, 0, "phải xếp hết 18 con");
    assert_eq!(placements.len(), 18);
    assert!(sheets >= 1);
    // Chi tiết lớn phải được xử lý trước — thứ tự xác định theo diện tích giảm dần.
    assert_eq!(placements[0].part_id, "part-a");
}

#[test]
fn baseline_ton_trong_khoang_ho_va_le() {
    // gap lớn để dễ thấy nếu baseline bỏ qua.
    let request = normalize_request(&request_with(
        vec![part("part-a", 9, rect(100.0, 60.0))],
        700.0,
        1000.0,
        12.0,
        20,
    ))
    .unwrap();
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
    assert!(
        report.min_clearance_mm >= 12.0 - tol().linear_mm,
        "khoảng hở nhỏ nhất {} phải ≥ 12 mm",
        report.min_clearance_mm
    );
    assert!(
        report.min_margin_mm >= -tol().linear_mm,
        "không được tràn lề"
    );
}

#[test]
fn baseline_mo_them_to_khi_het_cho() {
    // Chi tiết to gần bằng vùng dùng được ⇒ mỗi tờ chỉ chứa một con.
    let request = normalize_request(&request_with(
        vec![part("part-big", 3, rect(600.0, 900.0))],
        700.0,
        1000.0,
        3.0,
        20,
    ))
    .unwrap();
    let (placements, unplaced, sheets) =
        baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(unplaced, 0);
    assert_eq!(placements.len(), 3);
    assert_eq!(sheets, 3, "mỗi tờ một con");
    // Mỗi con một tờ riêng, chỉ số tờ tăng dần.
    let mut indices: Vec<u32> = placements.iter().map(|p| p.sheet_index).collect();
    indices.sort_unstable();
    assert_eq!(indices, vec![0, 1, 2]);
}

#[test]
fn baseline_phan_biet_hai_ly_do_chua_xep() {
    // 1. Quá khổ ở mọi góc cho phép ⇒ NO_FEASIBLE_POSE.
    let request = normalize_request(&request_with(
        vec![part("part-huge", 2, rect(2_000.0, 1_500.0))],
        700.0,
        1000.0,
        3.0,
        20,
    ))
    .unwrap();
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert_eq!(outcome.placements.len(), 0);
    assert_eq!(outcome.unplaced.len(), 2);
    assert!(outcome
        .unplaced
        .iter()
        .all(|u| u.reason == UnplacedReason::NoFeasiblePose));

    // 2. Vừa tờ nhưng chạm trần số tờ ⇒ MAX_SHEETS_REACHED.
    let request = normalize_request(&request_with(
        vec![part("part-big", 3, rect(600.0, 900.0))],
        700.0,
        1000.0,
        3.0,
        1,
    ))
    .unwrap();
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert_eq!(outcome.placements.len(), 1, "trần 1 tờ ⇒ đặt được 1 con");
    assert_eq!(outcome.unplaced.len(), 2);
    assert!(
        outcome
            .unplaced
            .iter()
            .all(|u| u.reason == UnplacedReason::MaxSheetsReached),
        "phải là MAX_SHEETS_REACHED, không được báo sai là hình học không vừa: {:?}",
        outcome.unplaced
    );

    // Cả hai ca vẫn phải bảo toàn số lượng qua validator.
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn baseline_maximize_area_khong_dat_mau_ra_ngoai_zone() {
    let mut qua_cao = part("part-a", 1, rect(20.0, 60.0));
    qua_cao.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut vua_zone = part("part-b", 1, rect(20.0, 20.0));
    vua_zone.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let request = normalized_maximize_area(vec![qua_cao, vua_zone], false);

    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    assert_eq!(outcome.placements.len(), 1);
    assert_eq!(outcome.placements[0].part_id, "part-b");
    assert_eq!(outcome.unplaced.len(), 1);
    assert_eq!(outcome.unplaced[0].part_id, "part-a");
    assert_eq!(outcome.unplaced[0].reason, UnplacedReason::NoFeasiblePose);

    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "baseline vượt zone: {:?}", report.codes());
}

#[test]
fn baseline_autofill_maximize_area_lap_day_tung_zone() {
    let request = normalized_maximize_area(
        vec![
            part("part-a", 1, rect(20.0, 20.0)),
            part("part-b", 1, rect(20.0, 20.0)),
        ],
        true,
    );
    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let counts = placement_counts(&outcome.placements);
    assert!(counts.get("part-a").copied().unwrap_or(0) > 0);
    assert!(counts.get("part-b").copied().unwrap_or(0) > 0);

    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &outcome.placements,
            unplaced: &outcome.unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "autofill vượt zone: {:?}", report.codes());
}

#[test]
fn rotation_probe_khong_duoc_xoay_mau_xuyen_bien_zone() {
    let mut top = part("part-a", 0, rect(80.0, 20.0));
    top.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0, 90.0],
    };
    let mut bottom = part("part-b", 0, rect(90.0, 50.0));
    bottom.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let mut raw = request_with(vec![top, bottom], 180.0, 100.0, 0.0, 1);
    raw.layout_intent = LayoutIntent::AutofillSingleSheet;
    raw.sheet.margin_mm = SheetMarginMm {
        left: 0.0,
        right: 0.0,
        top: 0.0,
        bottom: 0.0,
    };
    raw.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "1".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "2".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::MaximizeArea,
        placement_zones: vec![
            PartPlacementZoneSpec {
                part_id: "part-b".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 0.0,
                    min_y_mm: 0.0,
                    max_x_mm: 180.0,
                    max_y_mm: 50.0,
                },
            },
            PartPlacementZoneSpec {
                part_id: "part-a".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 0.0,
                    min_y_mm: 50.0,
                    max_x_mm: 180.0,
                    max_y_mm: 100.0,
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
    let request = normalize_request(&raw).expect("fixture rotation probe phải hợp lệ");
    let baseline = BaselineOutcome {
        placements: vec![
            PlacementRecord {
                instance_id: "part-b#0001".to_string(),
                part_id: "part-b".to_string(),
                sheet_index: 0,
                pose: Pose::new(0.0, 0.0, 0.0),
                source_revision: None,
            },
            PlacementRecord {
                instance_id: "part-a#0001".to_string(),
                part_id: "part-a".to_string(),
                sheet_index: 0,
                pose: Pose::new(0.0, 100.0, 80.0),
                source_revision: None,
            },
        ],
        unplaced: Vec::new(),
        sheet_count: 1,
        attempts: 0,
        orientation_evaluations: 0,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    };
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &baseline.placements,
            unplaced: &baseline.unplaced,
            stats: None,
        },
    );
    assert!(
        report.valid,
        "fixture ban đầu phải hợp lệ: {:?}",
        report.codes()
    );
    let baseline_score = score_layout(&request, &baseline.placements, 0);

    let probe = run_rotation_probe_from_baseline(&request, &baseline, &baseline_score, &control())
        .expect("rotation probe phải chạy");
    assert!(probe.screen_bounds_evaluations > 0);
    assert!(
        probe.placements.is_none(),
        "không được nhận pose 90° giảm envelope bằng cách xuyên xuống zone dưới: {:?}",
        probe.placements
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. Deterministic
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn baseline_deterministic_tung_chu_so() {
    let request = normalized(vec![
        part("part-a", 5, rect(120.0, 80.0)),
        part("part-b", 7, rect(60.0, 40.0)),
        part("part-c", 3, shape_l()),
    ]);
    let run_control = control();
    let first = run_baseline(&request, &run_control, BaselineAnglePolicy::FirstAllowed).unwrap();
    let golden_poses = [
        ("part-a#0001", 0.0, 10.0, 10.0),
        ("part-a#0002", 0.0, 133.0, 10.0),
        ("part-a#0003", 0.0, 256.0, 10.0),
        ("part-a#0004", 0.0, 379.0, 10.0),
        ("part-a#0005", 0.0, 502.0, 10.0),
        ("part-b#0001", 0.0, 625.0, 10.0),
        ("part-b#0002", 0.0, 625.0, 53.0),
        ("part-b#0003", 0.0, 10.0, 93.0),
        ("part-b#0004", 0.0, 73.0, 93.0),
        ("part-b#0005", 0.0, 136.0, 93.0),
        ("part-b#0006", 0.0, 199.0, 93.0),
        ("part-b#0007", 0.0, 262.0, 93.0),
        ("part-c#0001", 0.0, 325.0, 93.0),
        ("part-c#0002", 0.0, 388.0, 93.0),
        ("part-c#0003", 0.0, 451.0, 93.0),
    ];
    let actual_poses: Vec<_> = first
        .placements
        .iter()
        .map(|placement| {
            (
                placement.instance_id.as_str(),
                placement.pose.rotation_deg,
                placement.pose.translate_x_mm,
                placement.pose.translate_y_mm,
            )
        })
        .collect();
    assert_eq!(
        actual_poses, golden_poses,
        "quick-win không được đổi pose baseline"
    );
    let telemetry = run_control.progress().snapshot().nfp_diagnostics;
    assert!(telemetry.baseline.feasible_region_calls > 0);
    assert!(telemetry.baseline.cache_hits > 0);
    assert!(telemetry.baseline.cache_misses > 0);
    assert_eq!(
        telemetry.baseline.cache_misses,
        telemetry.baseline.cache_entries_built
    );
    assert_eq!(telemetry.search.cache_hits, 0);
    for lan in 0..5 {
        let again = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
        assert_eq!(
            first, again,
            "lần {lan}: baseline phải xác định từng chữ số"
        );
    }
    // Và điểm chuẩn cũng xác định.
    let score_a = score_layout(&request, &first.placements, first.unplaced.len() as u64);
    let score_b = score_layout(&request, &first.placements, first.unplaced.len() as u64);
    assert_eq!(score_a, score_b);
}

#[test]
fn judge_pair_quick_win_giu_nguyen_phan_quyet_contour_long_nhau() {
    let subject = shape_l();
    let cases = [
        (translated(&rect(12.0, 8.0), 25.0, 22.0), 2.0),
        (translated(&rect(12.0, 8.0), 40.0, 22.0), 3.0),
        (translated(&rect(12.0, 8.0), 25.0, 35.0), 2.5),
        (translated(&rect(15.0, 10.0), 30.0, 25.0), 7.0),
        (translated(&rect(15.0, 10.0), 18.0, 20.0), 0.0),
    ];
    for (other, gap) in cases {
        assert_eq!(
            judge_pair(&subject, &other, gap, &tol()),
            judge_pair_reference(&subject, &other, gap, &tol()),
            "quick-win chỉ được bỏ phép overlap trùng, không đổi phán quyết"
        );
    }
}

#[test]
#[ignore = "micro-benchmark thủ công; không dùng thời gian làm test chặn build"]
fn benchmark_baseline_hot_path_exact_layout() {
    let request = normalized(vec![
        part("part-a", 5, rect(120.0, 80.0)),
        part("part-b", 7, rect(60.0, 40.0)),
        part("part-c", 3, shape_l()),
    ]);
    let expected = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline benchmark phải chạy");
    let started = std::time::Instant::now();
    const RUNS: u32 = 200;
    for _ in 0..RUNS {
        let outcome = std::hint::black_box(
            run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
                .expect("baseline benchmark phải chạy"),
        );
        assert_eq!(outcome.placements, expected.placements);
        assert_eq!(outcome.unplaced, expected.unplaced);
    }
    eprintln!(
        "BENCH_BASELINE_EXACT total_ms={:.3} runs={} us_per_run={:.3} placements={}",
        started.elapsed().as_secs_f64() * 1000.0,
        RUNS,
        started.elapsed().as_secs_f64() * 1_000_000.0 / f64::from(RUNS),
        expected.placements.len(),
    );
}

#[test]
#[ignore = "micro-benchmark thủ công; không dùng thời gian làm test chặn build"]
fn benchmark_judge_pair_bo_overlap_trung() {
    let subject = shape_l();
    let cases = [
        (translated(&rect(12.0, 8.0), 25.0, 22.0), 2.0),
        (translated(&rect(12.0, 8.0), 40.0, 22.0), 3.0),
        (translated(&rect(12.0, 8.0), 25.0, 35.0), 2.5),
        (translated(&rect(15.0, 10.0), 30.0, 25.0), 7.0),
    ];
    for (other, gap) in &cases {
        assert_eq!(
            judge_pair(&subject, other, *gap, &tol()),
            judge_pair_reference(&subject, other, *gap, &tol())
        );
    }

    const ROUNDS: usize = 8;
    const ITERATIONS: usize = 2_000;
    let mut reference = std::time::Duration::ZERO;
    let mut optimized = std::time::Duration::ZERO;
    let mut checksum = 0usize;
    for round in 0..ROUNDS {
        if round % 2 == 0 {
            let (elapsed, value) = measure_reference_pairs(&subject, &cases, ITERATIONS);
            reference += elapsed;
            checksum ^= value;
            let (elapsed, value) = measure_optimized_pairs(&subject, &cases, ITERATIONS);
            optimized += elapsed;
            checksum ^= value;
        } else {
            let (elapsed, value) = measure_optimized_pairs(&subject, &cases, ITERATIONS);
            optimized += elapsed;
            checksum ^= value;
            let (elapsed, value) = measure_reference_pairs(&subject, &cases, ITERATIONS);
            reference += elapsed;
            checksum ^= value;
        }
    }
    std::hint::black_box(checksum);
    eprintln!(
        "BENCH_JUDGE_PAIR reference_ms={:.3} optimized_ms={:.3} speedup={:.3}x",
        reference.as_secs_f64() * 1000.0,
        optimized.as_secs_f64() * 1000.0,
        reference.as_secs_f64() / optimized.as_secs_f64(),
    );
}

#[test]
fn baseline_khong_doc_dong_ho_o_che_do_work_plan_co_dinh() {
    // Work-plan cố định ⇒ không có deadline ⇒ kết quả không phụ thuộc máy nhanh chậm.
    let request = normalized(vec![part("part-a", 8, rect(90.0, 60.0))]);
    let stop = StopCriterion::fixed_work_plan(u64::MAX);
    assert!(stop.is_deterministic());
    let a = run_baseline(
        &request,
        &RunControl::new(stop, CancelToken::new(), Arc::new(ProgressChannel::new())),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    let b = run_baseline(
        &request,
        &RunControl::new(stop, CancelToken::new(), Arc::new(ProgressChannel::new())),
        BaselineAnglePolicy::FirstAllowed,
    )
    .unwrap();
    assert_eq!(a, b);
}

#[test]
fn baseline_ton_trong_cancel_hop_tac() {
    let request = normalized(vec![part("part-a", 40, rect(60.0, 40.0))]);
    let token = CancelToken::new();
    token.cancel();
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        token,
        Arc::new(ProgressChannel::new()),
    );
    let result = run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(
        result,
        Err(
            imposition_core::mixed_nesting::baseline::BaselineError::Interrupted(
                Interrupt::Cancelled
            )
        ),
        "hủy phải dừng baseline, không trả layout dở dang"
    );
}

#[test]
fn baseline_quantity_ton_trong_deadline_nhung_bo_qua_work_budget_trial() {
    // PERF (audit 2026-09-02 §PERF-NEST-04): deadline bao toàn solve. Quantity được
    // phép dừng baseline nhưng phải trả ledger đầy đủ; work budget vẫn chỉ dành cho
    // portfolio trial và không làm fixed-work phụ thuộc tốc độ máy.
    let request = normalized(vec![part("part-a", 40, rect(60.0, 40.0))]);
    let expected = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();

    let budget_control = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    budget_control.charge_evaluations(1);
    assert_eq!(
        budget_control.checkpoint(),
        Err(Interrupt::WorkBudgetExhausted)
    );
    let by_budget = run_baseline(&request, &budget_control, BaselineAnglePolicy::FirstAllowed)
        .expect("work budget không được cắt baseline");
    assert_eq!(by_budget, expected);

    let deadline_control = RunControl::new(
        StopCriterion::with_deadline(u64::MAX, 0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    assert_eq!(
        deadline_control.checkpoint(),
        Err(Interrupt::DeadlineReached)
    );
    let by_deadline = run_baseline(
        &request,
        &deadline_control,
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("quantity deadline phải trả best-so-far có ledger");
    assert!(by_deadline.placements.is_empty());
    assert_eq!(by_deadline.unplaced.len(), 40);
    assert!(by_deadline
        .unplaced
        .iter()
        .all(|record| record.reason == UnplacedReason::SearchBudgetExhausted));
    assert_eq!(
        by_deadline.placements.len() + by_deadline.unplaced.len(),
        40,
        "deadline không được làm mất instance khỏi ledger"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Tịnh tiến liên tục, không lưới
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn vi_tri_baseline_khong_nam_tren_luoi() {
    // Lề và gap lẻ ⇒ vị trí hợp lệ có phần lẻ mm. Nếu baseline snap về lưới thì mọi
    // toạ độ sẽ là bội của một bước nào đó.
    let mut spec = request_with(
        vec![part("part-a", 9, rect(83.7, 51.3))],
        700.0,
        1000.0,
        4.7,
        20,
    );
    spec.sheet.margin_mm = SheetMarginMm {
        left: 7.3,
        right: 11.9,
        top: 13.1,
        bottom: 9.7,
    };
    let request = normalize_request(&spec).unwrap();
    let (placements, unplaced, _) =
        baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(unplaced, 0);

    let co_phan_le = placements.iter().any(|p| {
        (p.pose.translate_x_mm - p.pose.translate_x_mm.round()).abs() > 1e-6
            || (p.pose.translate_y_mm - p.pose.translate_y_mm.round()).abs() > 1e-6
    });
    assert!(co_phan_le, "vị trí phải giữ phần lẻ mm: {placements:?}");

    // Và các bước dịch giữa hai con không phải bội của một hằng số nào.
    let mut ys: Vec<f64> = placements.iter().map(|p| p.pose.translate_y_mm).collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ys.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    assert!(ys.len() >= 2);
}

#[test]
fn baseline_dat_sat_le_duoc() {
    // Bottom-Left ⇒ con đầu tiên phải nằm sát góc trái dưới vùng dùng được.
    let request = normalized(vec![part("part-a", 1, rect(80.0, 40.0))]);
    let (placements, _, _) = baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    let pose = placements[0].pose;
    assert!(
        (pose.translate_x_mm - request.sheet.usable.min_x).abs() < 1e-6,
        "x = {} phải sát lề trái {}",
        pose.translate_x_mm,
        request.sheet.usable.min_x
    );
    assert!(
        (pose.translate_y_mm - request.sheet.usable.min_y).abs() < 1e-6,
        "y = {} phải sát lề dưới {}",
        pose.translate_y_mm,
        request.sheet.usable.min_y
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  4–5. Chính sách góc
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn chinh_sach_goc_la_tham_so_tuong_minh_khong_phai_hang_so_an() {
    // `free` ⇒ baseline chọn 0°, nhưng đó là lựa chọn của BASELINE.
    let free = RotationDomain::Full;
    assert_eq!(
        baseline_angles(&free, BaselineAnglePolicy::FirstAllowed, &tol()),
        vec![0.0]
    );
    // Chính sách cardinal chỉ dùng cho benchmark, và phải khai tường minh mới có.
    assert_eq!(
        baseline_angles(&free, BaselineAnglePolicy::CardinalForBenchmark, &tol()),
        vec![0.0, 90.0, 180.0, 270.0]
    );
    // Mặc định của enum KHÔNG phải cardinal.
    assert_eq!(
        BaselineAnglePolicy::default(),
        BaselineAnglePolicy::FirstAllowed
    );
    assert_ne!(
        BaselineAnglePolicy::default(),
        BaselineAnglePolicy::CardinalForBenchmark
    );
}

#[test]
fn baseline_khong_dat_goc_ma_nguoi_dung_da_cam() {
    // Chi tiết bị khoá đúng 17,3° ⇒ baseline phải dùng chính góc đó, không phải 0°.
    let khoa =
        resolve_rotation_domain(&RotationConstraint::Fixed { angle_deg: 17.3 }, &tol()).unwrap();
    let angles = baseline_angles(&khoa, BaselineAnglePolicy::FirstAllowed, &tol());
    assert_eq!(angles.len(), 1);
    assert!((angles[0] - 17.3).abs() < 1e-9);

    // Ngay cả chính sách cardinal cũng bị lọc theo miền: 0/90/180/270 đều bị cấm.
    assert!(baseline_angles(&khoa, BaselineAnglePolicy::CardinalForBenchmark, &tol()).is_empty());

    // Chạy thật: pose phải mang đúng góc bị khoá và vẫn qua validator.
    let mut spec = part("part-a", 3, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::Fixed { angle_deg: 17.3 };
    let request = normalized(vec![spec]);
    let (placements, unplaced, _) =
        baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    assert_eq!(unplaced, 0);
    for record in &placements {
        assert!(
            (record.pose.rotation_deg - 17.3).abs() < 1e-9,
            "góc {} phải đúng 17,3°",
            record.pose.rotation_deg
        );
    }

    // Chi tiết khoá 0/180 ⇒ chỉ được dùng 0° hoặc 180°.
    let mut spec = part("part-b", 4, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::preset_half_turn();
    let request = normalized(vec![spec]);
    let (placements, _, _) = baseline_and_validate(&request, BaselineAnglePolicy::FirstAllowed);
    for record in &placements {
        assert!(
            record.pose.rotation_deg == 0.0 || record.pose.rotation_deg == 180.0,
            "góc {} ngoài preset 0/180",
            record.pose.rotation_deg
        );
    }

    // Miền cung ⇒ baseline lấy đầu cung, vẫn thuộc miền.
    let cung = resolve_rotation_domain(
        &RotationConstraint::Ranges {
            arcs: vec![imposition_core::mixed_nesting::model::AngleArcDeg {
                start_deg: 33.7,
                sweep_deg: 20.0,
            }],
        },
        &tol(),
    )
    .unwrap();
    let angles = baseline_angles(&cung, BaselineAnglePolicy::FirstAllowed, &tol());
    assert_eq!(angles.len(), 1);
    assert!(cung.contains(angles[0], &tol()));
}

// ═════════════════════════════════════════════════════════════════════════════
//  6. Điểm chuẩn
// ═════════════════════════════════════════════════════════════════════════════

fn score_of(unplaced: u64, sheets: u32, last: i64, wasted: i64) -> LayoutScore {
    LayoutScore {
        invalid_count: 0,
        unplaced_count: unplaced,
        sheet_count: sheets,
        last_sheet_used_area_fixed: last,
        wasted_within_envelope_fixed: wasted,
        tie_break: Vec::new(),
        score_version: SCORE_VERSION,
    }
}

#[test]
fn diem_chuan_dung_thu_tu_lexicographic() {
    // 1. Ít unplaced luôn thắng, kể cả khi nhiều tờ hơn.
    assert!(score_of(0, 9, 999, 999).is_better_than(&score_of(1, 1, 0, 0)));
    // 2. Cùng unplaced ⇒ ít tờ thắng, kể cả khi tờ cuối chật hơn.
    assert!(score_of(0, 2, 999, 999).is_better_than(&score_of(0, 3, 0, 0)));
    // 3. Cùng tờ ⇒ tờ cuối dùng ít diện tích hơn thắng.
    assert!(score_of(0, 2, 100, 999).is_better_than(&score_of(0, 2, 200, 0)));
    // 4. Cùng cả ba ⇒ compactness tốt hơn thắng.
    assert!(score_of(0, 2, 100, 10).is_better_than(&score_of(0, 2, 100, 20)));
    // 5. Cùng cả bốn ⇒ tie-break theo khoá canonical.
    let mut a = score_of(0, 1, 100, 10);
    let mut b = score_of(0, 1, 100, 10);
    a.tie_break = vec![PlacementKey {
        sheet_index: 0,
        part_id: "part-a".to_string(),
        angle_fixed: 0,
        x_fixed: 1,
        y_fixed: 1,
    }];
    b.tie_break = vec![PlacementKey {
        sheet_index: 0,
        part_id: "part-a".to_string(),
        angle_fixed: 0,
        x_fixed: 2,
        y_fixed: 1,
    }];
    assert!(a.is_better_than(&b));
    assert!(!b.is_better_than(&a));
}

#[test]
fn diem_chuan_la_thu_tu_toan_phan_nen_reduce_song_song_on_dinh() {
    // Sinh nhiều điểm khác nhau rồi kiểm ba tính chất của thứ tự toàn phần.
    let mut scores: Vec<LayoutScore> = Vec::new();
    for u in 0..3u64 {
        for s in 1..4u32 {
            for l in [0i64, 100, 200] {
                for w in [0i64, 50] {
                    scores.push(score_of(u, s, l, w));
                }
            }
        }
    }
    // Phản xạ và bắc cầu: `sort` chỉ đúng khi Ord là thứ tự toàn phần thật.
    let mut sorted = scores.clone();
    sorted.sort();
    for window in sorted.windows(2) {
        assert!(window[0] <= window[1]);
    }
    // Gộp theo mọi thứ tự đều cho cùng phần tử tốt nhất.
    let best_forward = scores
        .iter()
        .fold(&scores[0], |acc, s| LayoutScore::better_of(acc, s));
    let best_backward = scores
        .iter()
        .rev()
        .fold(&scores[scores.len() - 1], |acc, s| {
            LayoutScore::better_of(acc, s)
        });
    assert_eq!(best_forward, best_backward);
    assert_eq!(best_forward, &sorted[0]);
}

#[test]
fn diem_chuan_dung_metric_fixed_point_nen_khong_lech_vi_nhieu_f64() {
    // Hai diện tích khác nhau dưới lượng tử phải cho cùng điểm ⇒ không đảo thứ tự tuỳ nhiễu.
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let base = vec![
        PlacementRecord {
            instance_id: "part-a#0001".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 50.0),
            source_revision: None,
        },
        PlacementRecord {
            instance_id: "part-a#0002".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 100.0),
            source_revision: None,
        },
    ];
    let mut nhieu = base.clone();
    // Dịch 1e-9 mm — dưới cả lượng tử toạ độ.
    nhieu[1].pose = Pose::new(0.0, 20.0, 100.0 + 1e-9);
    let a = score_layout(&request, &base, 0);
    let b = score_layout(&request, &nhieu, 0);
    assert_eq!(a, b, "lệch dưới lượng tử không được đổi điểm");

    // Dịch 1 mm — trên lượng tử ⇒ điểm phải đổi.
    let mut khac = base.clone();
    khac[1].pose = Pose::new(0.0, 20.0, 101.0);
    assert_ne!(a, score_layout(&request, &khac, 0));
}

#[test]
fn diem_chuan_khong_dung_material_utilization_lam_tie_break() {
    // Cùng tập chi tiết, cùng số tờ ⇒ utilization KHÔNG đổi theo cách sắp xếp.
    // Nếu điểm dùng nó làm tiêu chí thì hai layout khác nhau sẽ bằng điểm — đó là
    // tiêu chí giả mà §11.5 cấm.
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let chat = vec![
        PlacementRecord {
            instance_id: "part-a#0001".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 50.0),
            source_revision: None,
        },
        PlacementRecord {
            instance_id: "part-a#0002".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 93.0),
            source_revision: None,
        },
    ];
    let long = vec![
        chat[0].clone(),
        PlacementRecord {
            pose: Pose::new(0.0, 20.0, 500.0),
            ..chat[1].clone()
        },
    ];
    let stats_chat = recompute_stats(
        &request,
        &chat,
        &[],
        RunCounters::empty(TerminationReason::AllPlaced),
    );
    let stats_long = recompute_stats(
        &request,
        &long,
        &[],
        RunCounters::empty(TerminationReason::AllPlaced),
    );
    assert!(
        (stats_chat.material_utilization - stats_long.material_utilization).abs() < 1e-12,
        "utilization phải BẰNG nhau ⇒ không dùng được làm tie-break"
    );
    // Nhưng điểm chuẩn phải phân biệt được: xếp chặt hơn thì tốt hơn.
    let score_chat = score_layout(&request, &chat, 0);
    let score_long = score_layout(&request, &long, 0);
    assert!(
        score_chat.is_better_than(&score_long),
        "xếp chặt phải thắng: {score_chat:?} vs {score_long:?}"
    );
}

#[test]
fn diem_chuan_xep_layout_benh_vao_hang_te_nhat() {
    let request = normalized(vec![part("part-a", 1, rect(80.0, 40.0))]);
    let benh = vec![PlacementRecord {
        instance_id: "part-a#0001".to_string(),
        part_id: "part-a".to_string(),
        sheet_index: 0,
        pose: Pose::new(f64::NAN, 20.0, 50.0),
        source_revision: None,
    }];
    let score_benh = score_layout(&request, &benh, 0);
    assert_eq!(
        score_benh.invalid_count, 1,
        "placement khong dung lai duoc phai bi dem"
    );
    let tot = score_layout(
        &request,
        &[PlacementRecord {
            instance_id: "part-a#0001".to_string(),
            part_id: "part-a".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 50.0),
            source_revision: None,
        }],
        0,
    );
    assert!(
        tot.is_better_than(&score_benh),
        "layout bệnh không bao giờ được thắng layout hợp lệ"
    );
    // Mã chi tiết lạ cũng vào hạng tệ nhất.
    let la = score_layout(
        &request,
        &[PlacementRecord {
            instance_id: "x#0001".to_string(),
            part_id: "khong-ton-tai".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 20.0, 50.0),
            source_revision: None,
        }],
        0,
    );
    assert!(tot.is_better_than(&la));
}

#[test]
fn diem_cua_baseline_thap_hon_khi_it_to_hon() {
    // Cùng bộ chi tiết, hai trần số tờ khác nhau: trần rộng cho ít unplaced hơn.
    let hep = normalize_request(&request_with(
        vec![part("part-big", 3, rect(600.0, 900.0))],
        700.0,
        1000.0,
        3.0,
        1,
    ))
    .unwrap();
    let rong = normalize_request(&request_with(
        vec![part("part-big", 3, rect(600.0, 900.0))],
        700.0,
        1000.0,
        3.0,
        20,
    ))
    .unwrap();
    let a = run_baseline(&hep, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let b = run_baseline(&rong, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
    let score_a = score_layout(&hep, &a.placements, a.unplaced.len() as u64);
    let score_b = score_layout(&rong, &b.placements, b.unplaced.len() as u64);
    assert!(
        score_b.is_better_than(&score_a),
        "xếp hết 3 con phải tốt hơn xếp được 1 con"
    );
    assert_eq!(score_a.unplaced_count, 2);
    assert_eq!(score_b.unplaced_count, 0);
}

#[test]
fn diem_chuan_dung_o_goc_khong_cardinal() {
    // Điểm phải tính được cho pose lẻ, và giữ đủ độ phân giải để phân biệt.
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let make = |y2: f64| {
        vec![
            PlacementRecord {
                instance_id: "part-a#0001".to_string(),
                part_id: "part-a".to_string(),
                sheet_index: 0,
                pose: Pose::new(13.372_849, 123.456_789, 67.891_234),
                source_revision: None,
            },
            PlacementRecord {
                instance_id: "part-a#0002".to_string(),
                part_id: "part-a".to_string(),
                sheet_index: 0,
                pose: Pose::new(13.372_849, 123.456_789, y2),
                source_revision: None,
            },
        ]
    };
    let gan = score_layout(&request, &make(160.5), 0);
    let xa = score_layout(&request, &make(400.75), 0);
    assert!(gan.is_better_than(&xa), "xếp gần hơn phải tốt hơn");
    // Khoá tie-break giữ nguyên góc lẻ ở độ phân giải 1e-6°.
    assert_eq!(gan.tie_break.len(), 2);
    assert_eq!(gan.tie_break[0].angle_fixed, 13_372_849);
}

#[test]
fn baseline_cardinal_va_free_dung_de_do_loi_ich_khong_de_thay_the_nhau() {
    // Nan 130×10 trong vùng ~100×100: cardinal không vừa, nhưng 45° thì vừa.
    // Đây là bằng chứng free-angle có giá trị thật, và là lý do baseline cardinal
    // không được âm thầm thành fallback duy nhất.
    let mut spec = request_with(
        vec![part("part-nan", 1, rect(130.0, 10.0))],
        120.0,
        120.0,
        0.0,
        5,
    );
    spec.sheet.margin_mm = SheetMarginMm {
        left: 10.0,
        right: 10.0,
        top: 10.0,
        bottom: 10.0,
    };
    let request = normalize_request(&spec).unwrap();

    // Baseline cardinal: không đặt được con nào.
    let cardinal = run_baseline(
        &request,
        &control(),
        BaselineAnglePolicy::CardinalForBenchmark,
    )
    .unwrap();
    assert_eq!(
        cardinal.placements.len(),
        0,
        "bốn góc cardinal không đủ cho ca này"
    );
    assert_eq!(cardinal.unplaced.len(), 1);

    // Miền hợp lệ của chi tiết vẫn là toàn 360° — baseline không thu hẹp nó.
    assert_eq!(request.parts[0].rotation_domain, RotationDomain::Full);
    assert!(request.parts[0].rotation_domain.contains(45.0, &tol()));
    assert_eq!(request.parts[0].rotation_domain.total_span_deg(), 360.0);
}

#[test]
fn effort_khong_anh_huong_ket_qua_baseline() {
    // Baseline là sàn an toàn, không phải nơi tiêu work budget theo profile.
    let request = normalized(vec![part("part-a", 6, rect(90.0, 60.0))]);
    let mut results = Vec::new();
    for profile in [Profile::Fast, Profile::Balanced, Profile::Tight] {
        let effort = SearchEffort::for_profile(profile);
        let control = RunControl::new(
            effort.stop_criterion(None),
            CancelToken::new(),
            Arc::new(ProgressChannel::new()),
        );
        results.push(run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed).unwrap());
    }
    assert_eq!(results[0], results[1]);
    assert_eq!(results[1], results[2]);
}
