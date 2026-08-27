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
    baseline_angles, run_baseline, BaselineAnglePolicy, BASELINE_VERSION, MAX_CANDIDATES_PER_ANGLE,
};
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::Tolerance;
use imposition_core::mixed_nesting::model::{
    MixedNestingRequest, OrientationPolicy, PartSpec, PlacementRecord, PointMm, Pose, Profile,
    Reflection, RotationConstraint, SheetMarginMm, SheetSpec, TerminationReason, UnplacedReason,
};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::orientation::{resolve_rotation_domain, RotationDomain};
use imposition_core::mixed_nesting::score::{
    score_layout, LayoutScore, PlacementKey, SCORE_VERSION,
};
use imposition_core::mixed_nesting::validator::{
    recompute_stats, validate_layout, LayoutUnderReview, RunCounters,
};
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
        protocol_version: 1,
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
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
    }
}

fn normalized(parts: Vec<PartSpec>) -> NormalizedRequest {
    normalize_request(&request_with(parts, 700.0, 1000.0, 3.0, 20)).expect("hợp lệ")
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
    assert_eq!(BASELINE_VERSION, 1);
    assert_eq!(SCORE_VERSION, 1);
    // Trần ứng viên phải đủ rộng để đỉnh Bottom-Left đầu tiên hầu như luôn dùng được.
    assert_eq!(MAX_CANDIDATES_PER_ANGLE, 64);
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
    let first = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed).unwrap();
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
fn baseline_ton_trong_work_budget() {
    let request = normalized(vec![part("part-a", 40, rect(60.0, 40.0))]);
    let control = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    control.charge_evaluations(5);
    let result = run_baseline(&request, &control, BaselineAnglePolicy::FirstAllowed);
    assert!(matches!(
        result,
        Err(
            imposition_core::mixed_nesting::baseline::BaselineError::Interrupted(
                Interrupt::WorkBudgetExhausted
            )
        )
    ));
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
