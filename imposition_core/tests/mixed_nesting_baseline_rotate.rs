//! Hồi quy §NEST-BASELINE-ROTATE-ON-FAIL: baseline phải xoay khi 0° không đặt được.
//!
//! ## Lỗi gốc
//!
//! Chủ dự án báo: "tem nào cũng giữ nguyên hướng gốc". Truy ra: `baseline_angles` với
//! [`BaselineAnglePolicy::FirstAllowed`] trả **đúng một** góc — góc đầu của miền, tức 0° với
//! miền cardinal `[0,90,180,270]` mà đường production dùng. Bộ tối ưu là thứ duy nhất thử
//! 90/180/270, nhưng nó chưa hoàn tất nổi một lượt (đắt gấp ~12 lần baseline), nên phương án
//! công bố **luôn** là baseline ⇒ mọi con nằm ở 0°.
//!
//! ## Bất biến khoá ở đây
//!
//! 1. Tập dự phòng **chỉ** là cardinal, không phải cả miền — trần cứng cho chi phí.
//! 2. Góc dự phòng thử ở **lượt riêng**, chỉ khi lựa chọn còn lại là mở thêm tờ.
//! 3. Con vừa ở góc đầu **không** tốn thêm lần đánh giá hướng nào.
//! 4. `CardinalForBenchmark` không đổi — nó là sàn an toàn của benchmark.
//! 5. Miền góc người dùng cấm vẫn được tôn trọng: dự phòng bị lọc qua domain.
//!
//! ## Số đo đã trả giá (file khách 13 mẫu, tờ 320×430)
//!
//! Bản đầu tôi nối cardinal vào **cuối danh sách góc**. Xoay xuất hiện thật, nhưng:
//!
//! | ca | placed | orientEval |
//! |---|---|---|
//! | autofill, nối vào cuối | 46 | 3× cao hơn (17,7s → 50–66s) |
//! | autofill, không dự phòng | 46 | nền |
//!
//! Trả 3× thời gian cho 0 con. Nguyên nhân: nối vào cuối thì mỗi con không vừa ở 0° phải
//! thử thêm 3 góc trên **từng tờ**, mà ở cuối lượt lấp tờ gần như mọi con đều không vừa.
//!
//! Bản hiện tại (lượt riêng, chỉ trước khi mở tờ mới), cùng máy, số tất định:
//!
//! | ca | dự phòng | placed | sheets | orientEval | xoay |
//! |---|---|---|---|---|---|
//! | 13 mẫu autofill | tắt | 46 | 1 | 67 | 0 |
//! | 13 mẫu autofill | bật | 46 | 1 | **67** | 0 |
//! | 13×5 con | tắt | 65 | 2 | 92 | 0 |
//! | 13×5 con | bật | 65 | 2 | 100 | **3** |
//! | 13×20 con | tắt | 260 | 6 | 979 | 0 |
//! | 13×20 con | bật | 260 | 6 | 1070 | **9** |
//!
//! Đọc trung thực: autofill **không đổi một đơn vị nào**. Quantity tốn thêm ~9% và xoay
//! được 3 và 9 con — tức 9 con vừa được vào tờ đang mở thay vì đẩy sang tờ sau. Nhưng tổng
//! số tờ **không giảm** trên file này: lợi ích là thật nhưng chưa đủ để vượt ranh giới một
//! tờ. Với khuôn dài hoặc tờ chật thì đó là chỗ tiết kiệm cả tờ giấy.

use std::sync::Arc;

use imposition_core::mixed_nesting::baseline::{
    baseline_angles, baseline_angles_with_fallback, run_baseline, run_rotation_probe_from_baseline,
    BaselineAnglePolicy, BaselineOutcome, BASELINE_VERSION,
};
use imposition_core::mixed_nesting::control::{
    CancelToken, ProgressChannel, RunControl, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    LayoutIntent, MixedNestingRequest, OrientationPolicy, PartSpec, PlacementRecord, PointMm, Pose,
    Profile, Reflection, RotationConstraint, SheetMarginMm, SheetSpec, Tolerance,
};
use imposition_core::mixed_nesting::normalize::{normalize_request, NormalizedRequest};
use imposition_core::mixed_nesting::orientation::RotationDomain;
use imposition_core::mixed_nesting::score::score_layout;
use imposition_core::mixed_nesting::validator::{validate_layout, LayoutUnderReview};

const CARDINAL: [f64; 4] = [0.0, 90.0, 180.0, 270.0];

fn tol() -> Tolerance {
    Tolerance::v1()
}

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

fn control() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    )
}

/// Miền cardinal — đúng thứ `_CARDINAL_ROTATION_POLICY` của adapter cấp cho production.
fn cardinal_request(
    parts: Vec<PartSpec>,
    sheet_w: f64,
    sheet_h: f64,
    max_sheets: u32,
) -> NormalizedRequest {
    let request = MixedNestingRequest {
        seed: 20_260_828,
        profile: Profile::Fast,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: sheet_w,
            height_mm: sheet_h,
            margin_mm: SheetMarginMm {
                left: 0.0,
                right: 0.0,
                top: 0.0,
                bottom: 0.0,
            },
            max_sheets,
        },
        gap_mm: 0.0,
        layout_intent: LayoutIntent::QuantityFulfillment,
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Discrete {
                angles_deg: CARDINAL.to_vec(),
            },
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    };
    normalize_request(&request).expect("request hợp lệ")
}

fn cardinal_autofill_request(
    parts: Vec<PartSpec>,
    sheet_w: f64,
    sheet_h: f64,
) -> NormalizedRequest {
    let mut request = MixedNestingRequest {
        seed: 20_260_829,
        profile: Profile::Fast,
        time_budget_ms: None,
        sheet: SheetSpec {
            width_mm: sheet_w,
            height_mm: sheet_h,
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
            default_rotation: RotationConstraint::Discrete {
                angles_deg: CARDINAL.to_vec(),
            },
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    };
    for item in &mut request.parts {
        item.quantity = 0;
    }
    normalize_request(&request).expect("autofill hợp lệ")
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Hợp đồng của danh sách góc
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn mien_cardinal_cho_du_phong_dung_ba_goc_con_lai() {
    let domain = RotationDomain::Discrete(CARDINAL.to_vec());

    let chinh = baseline_angles(&domain, BaselineAnglePolicy::FirstAllowed, &tol());
    let day_du = baseline_angles_with_fallback(&domain, BaselineAnglePolicy::FirstAllowed, &tol());

    assert_eq!(chinh, vec![0.0], "góc chính vẫn phải là MỘT góc — sàn rẻ");
    assert_eq!(day_du, vec![0.0, 90.0, 180.0, 270.0]);
    assert_eq!(
        &day_du[..chinh.len()],
        chinh.as_slice(),
        "góc chính phải đứng trước"
    );
}

#[test]
fn du_phong_bi_chan_o_bon_goc_du_mien_co_hang_chuc_goc() {
    // Trần cứng: baseline không có deadline nên không được phép quét cả miền người dùng khai.
    let nhieu_goc: Vec<f64> = (0..36).map(|index| f64::from(index) * 10.0).collect();
    let domain = RotationDomain::Discrete(nhieu_goc);

    let day_du = baseline_angles_with_fallback(&domain, BaselineAnglePolicy::FirstAllowed, &tol());

    assert_eq!(
        day_du.len(),
        4,
        "dự phòng phải bị chặn ở bốn góc: {day_du:?}"
    );
    assert_eq!(day_du, vec![0.0, 90.0, 180.0, 270.0]);
}

#[test]
fn du_phong_ton_trong_goc_nguoi_dung_da_cam() {
    // Chỉ cho 0 và 90 ⇒ dự phòng không được bịa ra 180/270.
    let domain = RotationDomain::Discrete(vec![0.0, 90.0]);

    let day_du = baseline_angles_with_fallback(&domain, BaselineAnglePolicy::FirstAllowed, &tol());

    assert_eq!(day_du, vec![0.0, 90.0]);
}

#[test]
fn mien_lien_tuc_dung_cardinal_lam_du_phong() {
    let day_du = baseline_angles_with_fallback(
        &RotationDomain::Full,
        BaselineAnglePolicy::FirstAllowed,
        &tol(),
    );

    assert_eq!(day_du, vec![0.0, 90.0, 180.0, 270.0]);
}

#[test]
fn benchmark_cardinal_khong_bi_doi() {
    // Sàn an toàn của benchmark phải bất biến, nếu không mọi số so free-angle đều vô nghĩa.
    let domain = RotationDomain::Discrete(CARDINAL.to_vec());

    let goc = baseline_angles(&domain, BaselineAnglePolicy::CardinalForBenchmark, &tol());
    let day_du =
        baseline_angles_with_fallback(&domain, BaselineAnglePolicy::CardinalForBenchmark, &tol());

    assert_eq!(goc, day_du);
}

#[test]
fn khong_bao_gio_tra_goc_trung_nhau() {
    for domain in [
        RotationDomain::Full,
        RotationDomain::Discrete(CARDINAL.to_vec()),
        RotationDomain::Discrete(vec![90.0, 0.0]),
    ] {
        let goc = baseline_angles_with_fallback(&domain, BaselineAnglePolicy::FirstAllowed, &tol());
        let mut sap = goc.clone();
        sap.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sap.dedup();
        assert_eq!(sap.len(), goc.len(), "có góc trùng: {goc:?}");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Hành vi đầu-cuối
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn xoay_tren_to_dang_mo_thay_vi_mo_to_moi() {
    // Fixture được tính tay để **chỉ** lượt xoay-trên-tờ-đang-mở giải được:
    //
    //   Tờ 135 rộng × 100 cao, khuôn 90×40, ba con.
    //   - Con 1 và 2 vào 0° ở (0,0) và (0,40) ⇒ chiếm khối 90×80.
    //   - Chỗ còn lại: dải 135×20 phía trên, và cột x∈[90,135] tức 45 rộng × 100 cao.
    //   - Con 3 ở 0° là 90×40: KHÔNG chỗ nào vừa ⇒ không xoay thì phải mở tờ thứ hai.
    //   - Con 3 xoay 90° là 40 rộng × 90 cao: vừa cột 45×100.
    //
    // Cột rộng 45 cho khuôn 40 là **có chủ đích**: bản đầu tôi để tờ 130 nên cột khít đúng
    // 40 = 40, và khe hở bảo toàn của solver (`conservative_solver_gap_mm`) ăn hết chỗ dư
    // ⇒ test đỏ dù code đúng. Fixture khít tới từng milimet là fixture giòn.
    //
    // Nên "đúng một tờ + có một con xoay" là bằng chứng không thể đến từ đường nào khác.
    let request = cardinal_request(vec![part("dai", 3, rect(90.0, 40.0))], 135.0, 100.0, 4);

    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline phải chạy");

    assert!(outcome.unplaced.is_empty(), "{:?}", outcome.unplaced);
    let so_to = outcome
        .placements
        .iter()
        .map(|item| item.sheet_index)
        .max()
        .map(|value| value + 1)
        .unwrap_or(0);
    assert_eq!(
        so_to, 1,
        "phải gói đủ 3 con vào MỘT tờ nhờ xoay, không mở tờ mới"
    );
    assert!(
        outcome
            .placements
            .iter()
            .any(|item| (item.pose.rotation_deg - 90.0).abs() < 1e-9),
        "phải có con xoay 90°: {:?}",
        outcome
            .placements
            .iter()
            .map(|item| item.pose.rotation_deg)
            .collect::<Vec<_>>()
    );
}

#[test]
fn con_vua_o_goc_dau_khong_ton_them_danh_gia_huong() {
    // Đây là điều làm bản vá RẺ: hình vuông nhỏ luôn vừa ở 0°, nên số lần đánh giá hướng
    // phải đúng bằng số con — không một lần thử 90/180/270 nào.
    let request = cardinal_request(vec![part("vuong", 6, rect(20.0, 20.0))], 200.0, 200.0, 2);

    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline phải chạy");

    assert_eq!(outcome.placements.len(), 6);
    assert_eq!(
        outcome.orientation_evaluations, 6,
        "mỗi con đúng MỘT lần đánh giá hướng; nhiều hơn nghĩa là đang trả tiền cho \
         góc dự phòng mà không cần"
    );
    assert!(outcome
        .placements
        .iter()
        .all(|item| item.pose.rotation_deg == 0.0));
}

#[test]
fn goc_cam_thi_khong_xoay_du_co_loi() {
    // Chỉ cho 0°: dù xoay sẽ tiết kiệm tờ, baseline KHÔNG được xoay. Miền góc là ràng buộc
    // của người dùng, không phải gợi ý.
    let mut dai = part("dai", 8, rect(90.0, 40.0));
    dai.rotation_constraint = RotationConstraint::Discrete {
        angles_deg: vec![0.0],
    };
    let request = cardinal_request(vec![dai], 100.0, 300.0, 8);

    let outcome = run_baseline(&request, &control(), BaselineAnglePolicy::FirstAllowed)
        .expect("baseline phải chạy");

    assert!(outcome
        .placements
        .iter()
        .all(|item| item.pose.rotation_deg == 0.0));
}

#[test]
fn autofill_khong_dung_goc_du_phong() {
    // Autofill chỉ có MỘT tờ nên không có "tiết kiệm một tờ" để biện minh chi phí; đo được
    // là 0 con thêm mà 3× thời gian. Test này chốt việc autofill không bị kéo vào.
    let request_autofill = {
        let mut request = MixedNestingRequest {
            seed: 20_260_828,
            profile: Profile::Fast,
            time_budget_ms: None,
            sheet: SheetSpec {
                width_mm: 100.0,
                height_mm: 300.0,
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
                default_rotation: RotationConstraint::Discrete {
                    angles_deg: CARDINAL.to_vec(),
                },
                reflection: Reflection::Forbidden,
            },
            parts: vec![part("dai", 0, rect(90.0, 40.0))],
            job_id: None,
            ..MixedNestingRequest::default()
        };
        request.parts[0].quantity = 0;
        normalize_request(&request).expect("autofill hợp lệ")
    };

    let outcome = run_baseline(
        &request_autofill,
        &control(),
        BaselineAnglePolicy::FirstAllowed,
    )
    .expect("baseline autofill phải chạy");

    // Tờ 100×300 với khuôn 90×40 ở 0°: đúng 7 con xếp dọc. Có xoay thì chỗ dư 100×20 vẫn
    // không nhận thêm được gì, nên số con là bằng chứng cho việc không xoay.
    assert!(
        outcome
            .placements
            .iter()
            .all(|item| item.pose.rotation_deg == 0.0),
        "autofill không được dùng góc dự phòng: {:?}",
        outcome
            .placements
            .iter()
            .map(|item| item.pose.rotation_deg)
            .collect::<Vec<_>>()
    );
}

#[test]
fn probe_xoay_thu_toi_da_ba_huong_va_thu_nho_envelope() {
    // Baseline giả lập có một khối 100×100 và tem 80×20 nằm bên phải. Xoay tem 90°
    // cho phép tái chèn vào cột hẹp 20×80, nên giữ đủ hai con nhưng giảm bề rộng cụm.
    let mut khoi = part("khoi", 0, rect(100.0, 100.0));
    khoi.source_revision = Some("rev-khoi".to_string());
    let mut tem = part("tem", 0, rect(80.0, 20.0));
    tem.source_revision = Some("rev-tem".to_string());
    let request = cardinal_autofill_request(vec![khoi, tem], 200.0, 120.0);
    let baseline = BaselineOutcome {
        placements: vec![
            PlacementRecord {
                instance_id: "khoi#0001".to_string(),
                part_id: "khoi".to_string(),
                sheet_index: 0,
                pose: Pose::new(0.0, 0.0, 0.0),
                source_revision: Some("rev-khoi".to_string()),
            },
            PlacementRecord {
                instance_id: "tem#0001".to_string(),
                part_id: "tem".to_string(),
                sheet_index: 0,
                pose: Pose::new(0.0, 101.0, 0.0),
                source_revision: Some("rev-tem".to_string()),
            },
        ],
        unplaced: Vec::new(),
        sheet_count: 1,
        attempts: 0,
        orientation_evaluations: 0,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    };

    // Work budget bằng 0 chứng minh probe không bị deadline/budget của smart trial cắt dở.
    let exhausted_control = RunControl::new(
        StopCriterion::fixed_work_plan(0),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    let baseline_score = score_layout(&request, &baseline.placements, 0);
    let probe =
        run_rotation_probe_from_baseline(&request, &baseline, &baseline_score, &exhausted_control)
            .expect("probe xoay phải hoàn tất");
    let probe_score = probe.score.clone().expect("candidate phải mang sẵn điểm");
    let placements = probe
        .placements
        .expect("phải tìm được candidate xoay tốt hơn");

    assert!(probe.orientation_evaluations <= 3);
    assert!(probe.attempts <= 15);
    assert_eq!(placements.len(), baseline.placements.len());
    assert!(placements
        .iter()
        .any(|item| item.part_id == "tem" && item.pose.rotation_deg != 0.0));
    for (before, after) in baseline.placements.iter().zip(&placements) {
        assert_eq!(after.instance_id, before.instance_id);
        assert_eq!(after.part_id, before.part_id);
        assert_eq!(after.sheet_index, before.sheet_index);
        assert_eq!(after.source_revision, before.source_revision);
    }
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.valid,
        "candidate phải qua validator: {:?}",
        report.issues
    );
    assert!(
        score_layout(&request, &placements, 0).is_better_than(&score_layout(
            &request,
            &baseline.placements,
            0
        ))
    );
    assert_eq!(probe_score, score_layout(&request, &placements, 0));

    // MOTIF (audit 2026-08-31 §NEST-PERIODIC-AUTHORITY): flag nội bộ không được
    // biến N-up thường thành S&R. Cùng candidate vẫn phải được probe khi intent wire là
    // `autofill_single_sheet`; đây là chốt chống suy mode từ hình học/flag ngầm.
    let mut ordinary_with_flag = baseline.clone();
    ordinary_with_flag.periodic_motif = true;
    let ordinary_with_flag_score = score_layout(&request, &ordinary_with_flag.placements, 0);
    let not_blocked = run_rotation_probe_from_baseline(
        &request,
        &ordinary_with_flag,
        &ordinary_with_flag_score,
        &exhausted_control,
    )
    .expect("N-up thường không được khóa probe bằng flag motif");
    assert!(not_blocked.placements.is_some());

    // Chỉ explicit intent S&R + motif đã validate mới khóa rotation probe. Fixture một
    // part giữ đúng contract `step_repeat_single_sheet`.
    let mut step_repeat_request =
        cardinal_autofill_request(vec![part("tem", 0, rect(80.0, 20.0))], 200.0, 120.0);
    step_repeat_request.layout_intent = LayoutIntent::StepRepeatSingleSheet;
    let step_repeat_baseline = BaselineOutcome {
        placements: vec![PlacementRecord {
            instance_id: "tem#0001".to_string(),
            part_id: "tem".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 101.0, 0.0),
            source_revision: None,
        }],
        unplaced: Vec::new(),
        sheet_count: 1,
        attempts: 0,
        orientation_evaluations: 0,
        periodic_motif: true,
        baseline_version: BASELINE_VERSION,
    };
    let periodic_score = score_layout(&step_repeat_request, &step_repeat_baseline.placements, 0);
    let blocked = run_rotation_probe_from_baseline(
        &step_repeat_request,
        &step_repeat_baseline,
        &periodic_score,
        &exhausted_control,
    )
    .expect("probe phải giữ nguyên motif S&R authoritative");
    assert!(blocked.placements.is_none());
    assert!(blocked.score.is_none());
    assert_eq!(blocked.attempts, 0);
    assert_eq!(blocked.orientation_evaluations, 0);
}

#[test]
fn probe_xoay_khong_tao_candidate_khi_envelope_khong_tot_hon() {
    let request = cardinal_autofill_request(vec![part("tem", 0, rect(80.0, 20.0))], 100.0, 100.0);
    let baseline = BaselineOutcome {
        placements: vec![PlacementRecord {
            instance_id: "tem#0001".to_string(),
            part_id: "tem".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 0.0, 0.0),
            source_revision: None,
        }],
        unplaced: Vec::new(),
        sheet_count: 1,
        attempts: 0,
        orientation_evaluations: 0,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    };

    let baseline_score = score_layout(&request, &baseline.placements, 0);
    let probe = run_rotation_probe_from_baseline(&request, &baseline, &baseline_score, &control())
        .expect("probe không cải thiện phải trả no-op an toàn");
    assert!(probe.placements.is_none());
    assert!(probe.score.is_none());
    assert!(probe.attempts <= 15);
}

#[test]
fn probe_xoay_ton_trong_mien_fixed() {
    let mut tem = part("tem", 0, rect(80.0, 20.0));
    tem.rotation_constraint = RotationConstraint::Fixed { angle_deg: 0.0 };
    let request =
        cardinal_autofill_request(vec![part("khoi", 0, rect(100.0, 100.0)), tem], 200.0, 120.0);
    let baseline = BaselineOutcome {
        placements: vec![PlacementRecord {
            instance_id: "tem#0001".to_string(),
            part_id: "tem".to_string(),
            sheet_index: 0,
            pose: Pose::new(0.0, 0.0, 0.0),
            source_revision: None,
        }],
        unplaced: Vec::new(),
        sheet_count: 1,
        attempts: 0,
        orientation_evaluations: 0,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    };

    let baseline_score = score_layout(&request, &baseline.placements, 0);
    let probe = run_rotation_probe_from_baseline(&request, &baseline, &baseline_score, &control())
        .expect("miền fixed phải trả no-op an toàn");
    assert!(probe.placements.is_none());
    assert!(probe.score.is_none());
    assert_eq!(probe.orientation_evaluations, 0);
}
