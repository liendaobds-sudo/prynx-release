//! Test sinh ứng viên và tinh chỉnh pose liên tục — phase P3b.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2, §11.3, §16.1.
//!
//! Bộ test này phải chứng minh:
//!
//! 1. Góc ứng viên gồm **góc tới hạn từ hình học** và mẫu bổ sung **không nằm trên lưới**.
//! 2. Ứng viên vị trí là **điểm tiếp xúc**, không phải lưới toạ độ.
//! 3. Trượt tới tiếp xúc cho **số thực liên tục**, không phải bội của bước nào.
//! 4. Tinh chỉnh đổi **cả ba** biến `(theta, tx, ty)`; đổi góc thì **giải lại** vị trí.
//! 5. Có ca chỉ chặt hơn khi trượt một quãng X/Y **không nguyên** hoặc xoay **dưới 1°**.
//! 6. Vòng tinh chỉnh dài có **checkpoint hủy**.
//! 7. `fast/balanced/tight` đổi số lượng mẫu, **không** đổi miền hợp lệ.

use std::sync::Arc;

use imposition_core::mixed_nesting::candidates::{
    candidate_angles, edge_midpoint_candidates, min_area_box_angle_deg, order_parts,
    translation_candidates, PartOrder, CANDIDATE_RULE_VERSION,
};
use imposition_core::mixed_nesting::control::{
    CancelToken, Interrupt, ProgressChannel, RunControl, SearchEffort, StopCriterion,
};
use imposition_core::mixed_nesting::model::{
    AngleArcDeg, MixedNestingRequest, OrientationPolicy, PartSpec, PointMm, Pose, Profile,
    Reflection, RotationConstraint, SheetMarginMm, SheetSpec, Tolerance,
    MIXED_NESTING_PROTOCOL_VERSION,
};
use imposition_core::mixed_nesting::nfp::feasible_region;
use imposition_core::mixed_nesting::normalize::{normalize_request, BoundsMm, NormalizedRequest};
use imposition_core::mixed_nesting::refine::{
    compact_bottom_left, refine_pose, slide_to_contact, try_rotate_and_relocate, LocalObjective,
    RefineContext, REFINE_INITIAL_ANGLE_STEP_DEG, REFINE_RULE_VERSION, SLIDE_ADVANCE_STEPS,
};
use imposition_core::mixed_nesting::transform::place_ring_checked;

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

fn request_of(parts: Vec<PartSpec>, w: f64, h: f64, margin: f64, gap: f64) -> MixedNestingRequest {
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
            max_sheets: 20,
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
    normalize_request(&request_of(parts, 700.0, 1000.0, 10.0, 3.0)).expect("hợp lệ")
}

fn control() -> RunControl {
    RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    )
}

fn local_ring(request: &NormalizedRequest, index: usize, angle: f64) -> Vec<PointMm> {
    let part = &request.parts[index];
    place_ring_checked(
        &part.outer,
        &Pose::new(angle, 0.0, 0.0),
        part.reference_point_mm,
        &request.tolerance,
    )
    .expect("xoay hợp lệ")
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Góc ứng viên
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn version_quy_tac_ung_vien_va_tinh_chinh() {
    assert_eq!(CANDIDATE_RULE_VERSION, 1);
    assert_eq!(REFINE_RULE_VERSION, 2);
    // Chia đôi đủ sâu để "tiếp xúc" mịn hơn dung sai nhiều bậc.
    assert_eq!(SLIDE_ADVANCE_STEPS, 64);
}

#[test]
fn goc_ung_vien_gom_goc_toi_han_tu_hinh_hoc() {
    // Hình L có cạnh nghiêng 0° và 90°, nên góc tới hạn phải chứa 0 và 90.
    let request = normalized(vec![part("part-l", 1, shape_l())]);
    let effort = SearchEffort::for_profile(Profile::Balanced);
    let angles = candidate_angles(&request.parts[0], effort, request.seed, &tol());
    assert!(!angles.is_empty());
    for expected in [0.0_f64, 90.0, 180.0, 270.0] {
        assert!(
            angles.iter().any(|a| (a - expected).abs() < 1e-6),
            "phải có góc tới hạn {expected}°: {angles:?}"
        );
    }
    // Hình nghiêng: góc tới hạn phải chứa góc làm cạnh nghiêng nằm ngang.
    let nghieng = vec![pt(0.0, 0.0), pt(40.0, 12.0), pt(28.0, 40.0)];
    let request = normalized(vec![part("part-n", 1, nghieng)]);
    let angles = candidate_angles(&request.parts[0], effort, request.seed, &tol());
    let canh = -(12.0f64).atan2(40.0).to_degrees();
    let mong_doi = (canh + 360.0) % 360.0;
    assert!(
        angles.iter().any(|a| (a - mong_doi).abs() < 1e-6),
        "phải có góc {mong_doi}° làm cạnh nghiêng nằm ngang: {angles:?}"
    );
}

#[test]
fn goc_ung_vien_khong_nam_tren_luoi() {
    // Với miền tự do, phần lớn mẫu phải là góc lẻ — nếu nằm trên lưới thì mọi góc sẽ là
    // bội của một hằng số.
    let request = normalized(vec![part("part-a", 1, rect(83.7, 51.3))]);
    let effort = SearchEffort::for_profile(Profile::Tight);
    let angles = candidate_angles(&request.parts[0], effort, request.seed, &tol());
    assert!(
        angles.len() >= 16,
        "tight phải cho nhiều mẫu: {}",
        angles.len()
    );

    // Không có bước chung: thử mọi bước "tròn" thường gặp, phải có góc không chia hết.
    for step in [1.0_f64, 5.0, 10.0, 15.0, 22.5, 45.0, 90.0] {
        let het_chia = angles
            .iter()
            .all(|a| ((a / step) - (a / step).round()).abs() < 1e-6);
        assert!(
            !het_chia,
            "mọi góc chia hết cho {step}° ⇒ đó là lưới góc, không phải miền liên tục"
        );
    }
    // Và có ít nhất một góc lẻ tới nhiều chữ số.
    assert!(
        angles
            .iter()
            .any(|a| (a - (a * 10.0).round() / 10.0).abs() > 1e-6),
        "phải có góc lẻ hơn 0,1°: {angles:?}"
    );
}

#[test]
fn goc_ung_vien_xac_dinh_va_phu_thuoc_seed() {
    let request = normalized(vec![part("part-a", 1, rect(83.7, 51.3))]);
    let effort = SearchEffort::for_profile(Profile::Balanced);
    let a = candidate_angles(&request.parts[0], effort, 20_260_826, &tol());
    let b = candidate_angles(&request.parts[0], effort, 20_260_826, &tol());
    assert_eq!(a, b, "cùng seed phải cho cùng danh sách");
    let c = candidate_angles(&request.parts[0], effort, 20_260_827, &tol());
    assert_ne!(a, c, "seed khác phải cho dãy mẫu khác");
    // Nhưng phần góc tới hạn thì giống nhau — nó suy từ hình học, không từ seed.
    for expected in [0.0_f64, 90.0] {
        assert!(a.iter().any(|x| (x - expected).abs() < 1e-6));
        assert!(c.iter().any(|x| (x - expected).abs() < 1e-6));
    }
}

#[test]
fn goc_ung_vien_luon_thuoc_mien_hop_le() {
    // fixed: đúng một góc.
    let mut spec = part("part-a", 1, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::Fixed { angle_deg: 17.3 };
    let request = normalized(vec![spec]);
    let angles = candidate_angles(
        &request.parts[0],
        SearchEffort::for_profile(Profile::Tight),
        request.seed,
        &tol(),
    );
    assert_eq!(angles.len(), 1);
    assert!((angles[0] - 17.3).abs() < 1e-9);

    // discrete 0/180.
    let mut spec = part("part-b", 1, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::preset_half_turn();
    let request = normalized(vec![spec]);
    let angles = candidate_angles(
        &request.parts[0],
        SearchEffort::for_profile(Profile::Tight),
        request.seed,
        &tol(),
    );
    assert_eq!(angles.len(), 2);
    assert!(angles.contains(&0.0) && angles.contains(&180.0));

    // ranges: mọi mẫu phải thuộc cung.
    let mut spec = part("part-c", 1, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::Ranges {
        arcs: vec![AngleArcDeg {
            start_deg: 33.7,
            sweep_deg: 20.0,
        }],
    };
    let request = normalized(vec![spec]);
    let angles = candidate_angles(
        &request.parts[0],
        SearchEffort::for_profile(Profile::Tight),
        request.seed,
        &tol(),
    );
    assert!(!angles.is_empty());
    for angle in &angles {
        assert!(
            request.parts[0].rotation_domain.contains(*angle, &tol()),
            "mẫu {angle}° ngoài cung cho phép"
        );
    }
    // Và có mẫu thực sự nằm TRONG cung, không chỉ ở hai đầu.
    assert!(
        angles.iter().any(|a| *a > 34.0 && *a < 53.0),
        "phải lấy mẫu bên trong cung: {angles:?}"
    );
}

#[test]
fn profile_doi_so_luong_mau_khong_doi_mien() {
    let request = normalized(vec![part("part-a", 1, rect(83.7, 51.3))]);
    let mut counts = Vec::new();
    for profile in [Profile::Fast, Profile::Balanced, Profile::Tight] {
        let effort = SearchEffort::for_profile(profile);
        let angles = candidate_angles(&request.parts[0], effort, request.seed, &tol());
        assert!(angles.len() <= effort.orientation_proposals_per_part as usize);
        // Mọi mẫu vẫn thuộc cùng một miền — profile không thu hẹp nó.
        for angle in &angles {
            assert!(request.parts[0].rotation_domain.contains(*angle, &tol()));
        }
        counts.push(angles.len());
    }
    assert!(counts[0] < counts[1], "balanced phải nhiều mẫu hơn fast");
    assert!(counts[1] < counts[2], "tight phải nhiều mẫu hơn balanced");
    // Miền không đổi theo profile.
    assert_eq!(request.parts[0].rotation_domain.total_span_deg(), 360.0);
}

#[test]
fn thu_tu_chi_tiet_on_dinh_va_co_nhieu_lua_chon() {
    let request = normalized(vec![
        part("part-small", 9, rect(30.0, 20.0)),
        part("part-big", 2, rect(200.0, 100.0)),
        part("part-long", 3, rect(400.0, 15.0)),
        part("part-lom", 4, shape_l()),
    ]);
    // Diện tích giảm dần.
    let by_area = order_parts(&request.parts, PartOrder::AreaDescending, &tol());
    assert_eq!(by_area[0].part_id, "part-big");
    // Cạnh dài nhất giảm dần.
    let by_extent = order_parts(&request.parts, PartOrder::LongestExtentDescending, &tol());
    assert_eq!(by_extent[0].part_id, "part-long");
    // Độ lõm giảm dần.
    let by_concavity = order_parts(&request.parts, PartOrder::ConcavityDescending, &tol());
    assert_eq!(by_concavity[0].part_id, "part-lom");
    // Số lượng giảm dần.
    let by_quantity = order_parts(&request.parts, PartOrder::QuantityDescending, &tol());
    assert_eq!(by_quantity[0].part_id, "part-small");

    // Mọi thứ tự đều xác định và giữ đủ chi tiết.
    for order in PartOrder::ALL {
        let a = order_parts(&request.parts, order, &tol());
        let b = order_parts(&request.parts, order, &tol());
        assert_eq!(a.len(), 4);
        assert_eq!(
            a.iter().map(|p| &p.part_id).collect::<Vec<_>>(),
            b.iter().map(|p| &p.part_id).collect::<Vec<_>>()
        );
    }
}

#[test]
fn goc_hop_bao_dien_tich_nho_nhat() {
    // Chữ nhật đã thẳng trục ⇒ góc 0 (hoặc bội 90).
    let angle = min_area_box_angle_deg(&rect(80.0, 40.0)).unwrap();
    assert!(
        (angle % 90.0).abs() < 1e-9 || ((angle % 90.0).abs() - 90.0).abs() < 1e-9,
        "góc {angle} phải là bội 90 cho chữ nhật thẳng trục"
    );
    // Chữ nhật đã xoay 30° ⇒ góc trả về phải đưa nó về thẳng trục.
    let xoay = place_ring_checked(
        &rect(80.0, 40.0),
        &Pose::new(30.0, 0.0, 0.0),
        pt(0.0, 0.0),
        &tol(),
    )
    .unwrap();
    let angle = min_area_box_angle_deg(&xoay).unwrap();
    let ve_thang =
        place_ring_checked(&xoay, &Pose::new(angle, 0.0, 0.0), pt(0.0, 0.0), &tol()).unwrap();
    let bounds = BoundsMm::from_ring(&ve_thang).unwrap();
    let dien_tich_bao = bounds.width_mm() * bounds.height_mm();
    assert!(
        (dien_tich_bao - 3_200.0).abs() < 1e-6,
        "hộp bao sau khi chỉnh phải bằng 80×40 = 3200, thực tế {dien_tich_bao}"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. Ứng viên vị trí
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn ung_vien_vi_tri_la_diem_tiep_xuc_khong_phai_luoi() {
    let request = normalized(vec![part("part-a", 4, rect(80.0, 40.0))]);
    let moving = local_ring(&request, 0, 0.0);
    let placed = vec![place_ring_checked(
        &request.parts[0].outer,
        &Pose::new(0.0, 200.0, 300.0),
        pt(0.0, 0.0),
        &tol(),
    )
    .unwrap()];
    let region = feasible_region(
        &request.sheet.usable,
        &placed,
        &moving,
        request.gap_mm,
        &tol(),
    )
    .unwrap();
    let effort = SearchEffort::for_profile(Profile::Balanced);
    let candidates = translation_candidates(&region, effort, &tol());
    assert!(!candidates.is_empty());
    // Số ứng viên tỉ lệ với độ phức tạp hình học, KHÔNG với diện tích tờ.
    // Tờ 700×1000 mm: một lưới 1 mm sẽ cho 700 000 điểm.
    assert!(
        candidates.len() < 100,
        "ứng viên là điểm tiếp xúc, không phải lưới: {} điểm",
        candidates.len()
    );
    // Đã sắp theo Bottom-Left.
    for window in candidates.windows(2) {
        assert!(
            window[0].y < window[1].y + tol().linear_mm
                || ((window[0].y - window[1].y).abs() <= tol().linear_mm
                    && window[0].x <= window[1].x + tol().linear_mm),
            "phải sắp theo Bottom-Left"
        );
    }
    // Trung điểm cạnh là nguồn ứng viên bổ sung, khác tập đỉnh.
    let midpoints = edge_midpoint_candidates(&region, &tol());
    assert!(!midpoints.is_empty());
}

#[test]
fn ung_vien_vi_tri_giu_phan_le_mm() {
    // Chi tiết đã đặt ở toạ độ lẻ ⇒ đỉnh miền hợp lệ cũng lẻ.
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let moving = local_ring(&request, 0, 0.0);
    let placed = vec![place_ring_checked(
        &request.parts[0].outer,
        &Pose::new(0.0, 213.456_789, 317.987_654),
        pt(0.0, 0.0),
        &tol(),
    )
    .unwrap()];
    let region = feasible_region(&request.sheet.usable, &placed, &moving, 4.7, &tol()).unwrap();
    let candidates =
        translation_candidates(&region, SearchEffort::for_profile(Profile::Tight), &tol());
    assert!(candidates
        .iter()
        .any(|p| (p.x - p.x.round()).abs() > 1e-6 || (p.y - p.y.round()).abs() > 1e-6));
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Trượt tới tiếp xúc
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn truot_toi_tiep_xuc_cho_so_thuc_lien_tuc() {
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    // Vật cản ở toạ độ lẻ ⇒ điểm tiếp xúc cũng lẻ.
    let blocker = place_ring_checked(
        &request.parts[0].outer,
        &Pose::new(0.0, 100.0, 213.456_789),
        pt(0.0, 0.0),
        &tol(),
    )
    .unwrap();
    let placed = vec![blocker];
    let context = RefineContext {
        part: &request.parts[0],
        placed: &placed,
        usable: &request.sheet.usable,
        gap_mm: 4.7,
        tol: tol(),
    };
    // Bắt đầu phía trên vật cản, trượt xuống.
    let start = Pose::new(0.0, 100.0, 600.0);
    let landed = slide_to_contact(&context, &start, (0.0, -1.0), 900.0).expect("phải trượt được");
    // Tiếp xúc lý thuyết: y = 213.456789 + 40 + 4.7 = 258.156789
    let mong_doi = 213.456_789 + 40.0 + 4.7;
    assert!(
        (landed.translate_y_mm - mong_doi).abs() < 1e-4,
        "trượt tới {} , kỳ vọng {mong_doi}",
        landed.translate_y_mm
    );
    // Không phải số nguyên, không phải bội của bước nào.
    assert!((landed.translate_y_mm - landed.translate_y_mm.round()).abs() > 1e-6);
    // Và pose kết quả vẫn hợp lệ.
    assert!(context.is_valid(&context.ring_at(&landed).unwrap()));
    // Đi thêm một chút nữa là phạm luật ⇒ đúng là "tiếp xúc đầu tiên".
    let qua = Pose::new(0.0, 100.0, landed.translate_y_mm - 0.01);
    assert!(!context.is_valid(&context.ring_at(&qua).unwrap()));
}

#[test]
fn truot_khong_co_vat_can_thi_di_het_khoang() {
    let request = normalized(vec![part("part-a", 1, rect(80.0, 40.0))]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let start = Pose::new(0.0, 300.0, 500.0);
    // Trượt xuống: chặn bởi lề dưới của vùng dùng được.
    let landed = slide_to_contact(&context, &start, (0.0, -1.0), 900.0).unwrap();
    assert!(
        (landed.translate_y_mm - request.sheet.usable.min_y).abs() < 1e-4,
        "phải dừng ở lề dưới {}, thực tế {}",
        request.sheet.usable.min_y,
        landed.translate_y_mm
    );
    // Pose khởi đầu không hợp lệ ⇒ None, không được coi là "trượt 0".
    let ngoai = Pose::new(0.0, -500.0, -500.0);
    assert!(slide_to_contact(&context, &ngoai, (0.0, -1.0), 100.0).is_none());
}

#[test]
fn nen_ve_goc_trai_duoi() {
    let request = normalized(vec![part("part-a", 1, rect(80.0, 40.0))]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let nen = compact_bottom_left(&context, &Pose::new(0.0, 400.0, 700.0), 6).unwrap();
    assert!((nen.translate_x_mm - request.sheet.usable.min_x).abs() < 1e-4);
    assert!((nen.translate_y_mm - request.sheet.usable.min_y).abs() < 1e-4);
}

// ═════════════════════════════════════════════════════════════════════════════
//  4–5. Tinh chỉnh đồng thời ba biến
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn tinh_chinh_cai_thien_muc_tieu_va_giu_hop_le() {
    let request = normalized(vec![part("part-a", 1, shape_l())]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let start = Pose::new(0.0, 350.0, 600.0);
    let before = LocalObjective::of(&context.ring_at(&start).unwrap()).unwrap();
    let refined = refine_pose(
        &context,
        &start,
        SearchEffort::for_profile(Profile::Balanced),
        &control(),
    )
    .unwrap()
    .expect("phải tinh chỉnh được");
    assert!(refined.objective < before, "mục tiêu phải tốt hơn");
    assert!(context.is_valid(&refined.ring), "kết quả phải hợp lệ");
    assert!(refined.evaluations > 0, "phải đếm số lần thử");
    // Đã nén về sát góc trái dưới.
    let bounds = BoundsMm::from_ring(&refined.ring).unwrap();
    assert!((bounds.min_x - request.sheet.usable.min_x).abs() < 0.5);
    assert!((bounds.min_y - request.sheet.usable.min_y).abs() < 0.5);
}

#[test]
fn doi_goc_thi_giai_lai_vi_tri_khong_xoay_tai_cho() {
    let request = normalized(vec![part("part-a", 1, shape_l())]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    // Đặt ở giữa tờ rồi xoay: vị trí PHẢI đổi, không được giữ nguyên.
    let start = Pose::new(0.0, 300.0, 500.0);
    let rotated = try_rotate_and_relocate(&context, &start, 13.372_849).unwrap();
    assert!(
        (rotated.rotation_deg - 13.372_849).abs() < 1e-9,
        "góc phải đổi"
    );
    assert!(
        (rotated.translate_x_mm - start.translate_x_mm).abs() > 1.0
            || (rotated.translate_y_mm - start.translate_y_mm).abs() > 1.0,
        "vị trí phải được giải lại, không xoay tại chỗ: {rotated:?}"
    );
    assert!(context.is_valid(&context.ring_at(&rotated).unwrap()));

    // Góc ngoài miền hợp lệ thì bị từ chối.
    let mut spec = part("part-b", 1, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::preset_half_turn();
    let request = normalized(vec![spec]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    assert!(
        try_rotate_and_relocate(&context, &Pose::new(0.0, 300.0, 500.0), 13.0).is_none(),
        "0/180 không cho xoay 13°"
    );
    assert!(try_rotate_and_relocate(&context, &Pose::new(0.0, 300.0, 500.0), 180.0).is_some());
}

#[test]
fn tinh_chinh_doi_ca_ba_bien() {
    // Chi tiết dài mảnh trong vùng hẹp: nghiêng nhẹ mới nén sâu được.
    let mut spec = request_of(
        vec![part("part-a", 1, rect(120.0, 22.0))],
        200.0,
        160.0,
        5.0,
        0.0,
    );
    spec.parts[0].reference_point_mm = Some(pt(0.0, 0.0));
    let request = normalize_request(&spec).unwrap();
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let start = Pose::new(31.7, 80.0, 60.0);
    let refined = refine_pose(
        &context,
        &start,
        SearchEffort::for_profile(Profile::Tight),
        &control(),
    )
    .unwrap()
    .unwrap();
    // Cả ba biến đều được phép đổi, và ít nhất hai biến thực sự đổi.
    let doi_goc = (refined.pose.rotation_deg - start.rotation_deg).abs() > 1e-9;
    let doi_x = (refined.pose.translate_x_mm - start.translate_x_mm).abs() > 1e-9;
    let doi_y = (refined.pose.translate_y_mm - start.translate_y_mm).abs() > 1e-9;
    assert!(doi_x && doi_y, "X và Y phải được tinh chỉnh");
    assert!(
        doi_goc
            || refined.objective < LocalObjective::of(&context.ring_at(&start).unwrap()).unwrap(),
        "hoặc đổi góc, hoặc phải cải thiện mục tiêu"
    );
    assert!(context.is_valid(&refined.ring));
}

#[test]
fn tinh_chinh_tra_ve_toa_do_khong_nguyen() {
    // Lề lẻ ⇒ vị trí nén tới cũng lẻ. Nếu có snap thì kết quả sẽ tròn.
    let mut spec = request_of(vec![part("part-a", 1, shape_l())], 300.0, 300.0, 7.3, 0.0);
    spec.sheet.margin_mm = SheetMarginMm {
        left: 7.3,
        right: 11.9,
        top: 13.1,
        bottom: 9.7,
    };
    let request = normalize_request(&spec).unwrap();
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let refined = refine_pose(
        &context,
        &Pose::new(0.0, 150.0, 200.0),
        SearchEffort::for_profile(Profile::Balanced),
        &control(),
    )
    .unwrap()
    .unwrap();
    assert!(
        (refined.pose.translate_x_mm - refined.pose.translate_x_mm.round()).abs() > 1e-6
            || (refined.pose.translate_y_mm - refined.pose.translate_y_mm.round()).abs() > 1e-6,
        "pose sau tinh chỉnh phải giữ phần lẻ: {:?}",
        refined.pose
    );
}

#[test]
fn co_ca_chi_chat_hon_khi_truot_quang_khong_nguyen() {
    // Vật cản ở toạ độ lẻ: vị trí chặt nhất bắt buộc là số lẻ, không thể là bội của mm.
    let request = normalized(vec![part("part-a", 2, rect(60.0, 40.0))]);
    let blocker = place_ring_checked(
        &request.parts[0].outer,
        &Pose::new(0.0, 10.0, 137.913_57),
        pt(0.0, 0.0),
        &tol(),
    )
    .unwrap();
    let placed = vec![blocker];
    let context = RefineContext {
        part: &request.parts[0],
        placed: &placed,
        usable: &request.sheet.usable,
        gap_mm: 2.5,
        tol: tol(),
    };
    let refined = refine_pose(
        &context,
        &Pose::new(0.0, 10.0, 500.0),
        SearchEffort::for_profile(Profile::Balanced),
        &control(),
    )
    .unwrap()
    .unwrap();
    // Nén xuống sát vật cản: y = 137.91357 + 40 + 2.5 = 180.41357 hoặc xuống sát lề dưới.
    let sat_vat_can = (refined.pose.translate_y_mm - (137.913_57 + 40.0 + 2.5)).abs() < 0.01;
    let sat_le_duoi = (refined.pose.translate_y_mm - request.sheet.usable.min_y).abs() < 0.01;
    assert!(
        sat_vat_can || sat_le_duoi,
        "phải nén tới tiếp xúc, thực tế y = {}",
        refined.pose.translate_y_mm
    );
    if sat_vat_can {
        assert!(
            (refined.pose.translate_y_mm - refined.pose.translate_y_mm.round()).abs() > 1e-6,
            "tiếp xúc với vật cản lẻ phải cho toạ độ lẻ"
        );
    }
}

#[test]
fn tinh_chinh_khong_bao_gio_tra_pose_khong_hop_le() {
    // Bao quanh bằng vật cản: dù thử nước đi nào, kết quả vẫn phải hợp lệ.
    let request = normalized(vec![part("part-a", 5, rect(60.0, 40.0))]);
    let mut placed = Vec::new();
    for (x, y) in [(10.0, 10.0), (80.0, 10.0), (10.0, 60.0), (150.0, 10.0)] {
        placed.push(
            place_ring_checked(
                &request.parts[0].outer,
                &Pose::new(0.0, x, y),
                pt(0.0, 0.0),
                &tol(),
            )
            .unwrap(),
        );
    }
    let context = RefineContext {
        part: &request.parts[0],
        placed: &placed,
        usable: &request.sheet.usable,
        gap_mm: 3.0,
        tol: tol(),
    };
    for start_y in [200.0_f64, 300.0, 450.0] {
        let refined = refine_pose(
            &context,
            &Pose::new(0.0, 100.0, start_y),
            SearchEffort::for_profile(Profile::Tight),
            &control(),
        )
        .unwrap()
        .unwrap();
        assert!(
            context.is_valid(&refined.ring),
            "kết quả tinh chỉnh phải hợp lệ với start_y = {start_y}"
        );
    }
    // Pose khởi đầu không hợp lệ ⇒ trả None, không "sửa nhẹ" rồi nhận.
    let chong = Pose::new(0.0, 10.0, 10.0);
    assert!(refine_pose(
        &context,
        &chong,
        SearchEffort::for_profile(Profile::Fast),
        &control()
    )
    .unwrap()
    .is_none());
}

#[test]
fn tinh_chinh_xac_dinh() {
    let request = normalized(vec![part("part-a", 1, shape_l())]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let start = Pose::new(23.456, 300.0, 500.0);
    let effort = SearchEffort::for_profile(Profile::Balanced);
    let first = refine_pose(&context, &start, effort, &control())
        .unwrap()
        .unwrap();
    for lan in 0..4 {
        let again = refine_pose(&context, &start, effort, &control())
            .unwrap()
            .unwrap();
        assert_eq!(first.pose, again.pose, "lần {lan}: phải xác định");
        assert_eq!(first.evaluations, again.evaluations);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  6. Checkpoint hủy
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn vong_tinh_chinh_co_checkpoint_huy() {
    let request = normalized(vec![part("part-a", 1, shape_l())]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let token = CancelToken::new();
    token.cancel();
    let cancelled = RunControl::new(
        StopCriterion::fixed_work_plan(u64::MAX),
        token,
        Arc::new(ProgressChannel::new()),
    );
    assert_eq!(
        refine_pose(
            &context,
            &Pose::new(0.0, 300.0, 500.0),
            SearchEffort::for_profile(Profile::Tight),
            &cancelled
        ),
        Err(Interrupt::Cancelled)
    );

    // Hết work budget cũng dừng.
    let budget = RunControl::new(
        StopCriterion::fixed_work_plan(1),
        CancelToken::new(),
        Arc::new(ProgressChannel::new()),
    );
    budget.charge_evaluations(10);
    assert_eq!(
        refine_pose(
            &context,
            &Pose::new(0.0, 300.0, 500.0),
            SearchEffort::for_profile(Profile::Tight),
            &budget
        ),
        Err(Interrupt::WorkBudgetExhausted)
    );
}

#[test]
fn buoc_tinh_chinh_co_dan_khong_phai_buoc_co_dinh() {
    // Bước khởi đầu là hằng số, nhưng nó CO DẦN — đó là cơ chế §11.3 cho phép.
    // Bằng chứng: tight (nhiều vòng hơn) phải đạt mục tiêu không tệ hơn fast.
    assert_eq!(REFINE_INITIAL_ANGLE_STEP_DEG, 8.0);
    let request = normalized(vec![part("part-a", 1, shape_l())]);
    let context = RefineContext {
        part: &request.parts[0],
        placed: &[],
        usable: &request.sheet.usable,
        gap_mm: 0.0,
        tol: tol(),
    };
    let start = Pose::new(19.7, 400.0, 700.0);
    let fast = refine_pose(
        &context,
        &start,
        SearchEffort::for_profile(Profile::Fast),
        &control(),
    )
    .unwrap()
    .unwrap();
    let tight = refine_pose(
        &context,
        &start,
        SearchEffort::for_profile(Profile::Tight),
        &control(),
    )
    .unwrap()
    .unwrap();
    assert!(
        tight.objective <= fast.objective,
        "nhiều vòng hơn không được cho kết quả tệ hơn: {:?} vs {:?}",
        tight.objective,
        fast.objective
    );
    assert!(
        tight.evaluations > fast.evaluations,
        "tight phải thử nhiều hơn"
    );
    // Cả hai đều hợp lệ.
    assert!(context.is_valid(&fast.ring));
    assert!(context.is_valid(&tight.ring));
}
