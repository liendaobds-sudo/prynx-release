//! Test NFP/IFP, broad phase và final validator — phase P2c.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2, §11.6, §16.1.
//!
//! Bộ test này phải chứng minh:
//!
//! 1. `NFP(A, R(theta)B)` và `IFP` **so parity với oracle va chạm độc lập** — không tự
//!    kiểm bằng chính đường đã dùng để dựng.
//! 2. Broad phase chỉ sai theo hướng an toàn: bỏ sót cặp rời, không bỏ sót cặp chạm.
//! 3. Validator chặn overlap / ngoài tờ / thiếu khoảng hở / scale / shear / mirror.
//! 4. Validator **không** áp angle step hay lưới toạ độ.

use imposition_core::mixed_nesting::collision::{
    judge_pair, judge_pair_sheet_axis, min_distance_mm, rings_overlap, PairVerdict,
};
use imposition_core::mixed_nesting::model::{
    AxisAlignedBoundsSpec, ClearanceSpec, FixedObstacleKind, FixedObstacleSpec, GroupingIntent,
    LayoutAlignment, LayoutIntent, ManifestStatus, MixedNestingRequest, OrientationPolicy,
    PartPlacementZoneSpec, PartSpec, PlacementRecord, PointMm, Pose, ProductionContractV1, Profile,
    Reflection, RotationConstraint, SheetAxisClearanceMm, SheetMarginMm, SheetSpec,
    TerminationReason, Tolerance, UnplacedReason, UnplacedRecord,
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION, MIXED_NESTING_PROTOCOL_VERSION,
    MIXED_NESTING_VALIDATOR_VERSION,
};
use imposition_core::mixed_nesting::nfp::{
    feasible_region, feasible_region_after_with_clearance, feasible_region_cached_with_clearance,
    feasible_region_sheet_axis, inner_fit_rect, no_fit_polygon, no_fit_polygon_sheet_axis,
    region_area_mm2, region_contains, region_vertices, NfpClearance, NfpError, NFP_RULE_VERSION,
};
use imposition_core::mixed_nesting::nfp_cache::NfpCache;
use imposition_core::mixed_nesting::normalize::{normalize_request, BoundsMm, NormalizedRequest};
use imposition_core::mixed_nesting::spatial::SpatialGrid;
use imposition_core::mixed_nesting::transform::{place_ring_checked, signed_area_mm2};
use imposition_core::mixed_nesting::validator::{
    instance_ids_for, recompute_stats, validate_layout, LayoutUnderReview, RunCounters,
    ValidationCode,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích
// ─────────────────────────────────────────────────────────────────────────────

fn tol() -> Tolerance {
    Tolerance::v1()
}
fn pt(x: f64, y: f64) -> PointMm {
    PointMm::new(x, y)
}
fn rect_at(x: f64, y: f64, w: f64, h: f64) -> Vec<PointMm> {
    vec![pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
}
fn rect(w: f64, h: f64) -> Vec<PointMm> {
    rect_at(0.0, 0.0, w, h)
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
fn shape_c() -> Vec<PointMm> {
    vec![
        pt(0.0, 0.0),
        pt(60.0, 0.0),
        pt(60.0, 12.0),
        pt(14.0, 12.0),
        pt(14.0, 38.0),
        pt(60.0, 38.0),
        pt(60.0, 50.0),
        pt(0.0, 50.0),
    ]
}
fn rotate(ring: &[PointMm], deg: f64) -> Vec<PointMm> {
    place_ring_checked(ring, &Pose::new(deg, 0.0, 0.0), pt(0.0, 0.0), &tol()).expect("xoay hợp lệ")
}
fn translate(ring: &[PointMm], dx: f64, dy: f64) -> Vec<PointMm> {
    ring.iter().map(|p| pt(p.x + dx, p.y + dy)).collect()
}

/// Oracle va chạm độc lập cho NFP: `t ∈ NFP(A,B)` khi và chỉ khi `A` và `t+B` chạm/chồng.
///
/// Dùng `collision` (quan toà, độc lập với kernel và NFP) làm sự thật.
fn nfp_truth(a: &[PointMm], b: &[PointMm], t: PointMm) -> bool {
    let moved = translate(b, t.x, t.y);
    rings_overlap(a, &moved, &tol()) || min_distance_mm(a, &moved, &tol()) <= tol().linear_mm
}

/// Quét lưới so NFP đã dựng với oracle. Bỏ qua điểm sát biên NFP vì ở đó hai cách kết
/// luận đều đúng trong dung sai.
fn nfp_parity(
    a: &[PointMm],
    b: &[PointMm],
    region: &[Vec<PointMm>],
    span: f64,
    steps: usize,
) -> usize {
    use imposition_core::mixed_nesting::collision::point_to_segment_mm;
    let mut lech = 0;
    for gx in 0..steps {
        for gy in 0..steps {
            let t = pt(
                -span + 2.0 * span * (gx as f64 + 0.5) / steps as f64,
                -span + 2.0 * span * (gy as f64 + 0.5) / steps as f64,
            );
            let truth = nfp_truth(a, b, t);
            let got = region_contains(region, t);
            if truth == got {
                continue;
            }
            let mut sat_bien = false;
            for ring in region {
                for i in 0..ring.len() {
                    if point_to_segment_mm(t, ring[i], ring[(i + 1) % ring.len()]) < 0.6 {
                        sat_bien = true;
                    }
                }
            }
            if !sat_bien {
                lech += 1;
            }
        }
    }
    lech
}

fn base_request(parts: Vec<PartSpec>) -> MixedNestingRequest {
    MixedNestingRequest {
        protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
        seed: 20_260_826,
        profile: Profile::Balanced,
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
        layout_intent: Default::default(),
        orientation_policy: OrientationPolicy {
            default_rotation: RotationConstraint::Free,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        production_contract: None,
    }
}

fn production_request(
    parts: Vec<PartSpec>,
    clearance: ClearanceSpec,
    fixed_obstacles: Vec<FixedObstacleSpec>,
) -> MixedNestingRequest {
    let mut request = base_request(parts);
    request.gap_mm = 0.0;
    request.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "a".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "b".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::FreeGang,
        placement_zones: Vec::new(),
        clearance,
        fixed_obstacles,
    });
    request
}

fn axis_clearance(x_mm: f64, y_mm: f64) -> SheetAxisClearanceMm {
    SheetAxisClearanceMm { x_mm, y_mm }
}

fn production_clearance(
    part_x: f64,
    part_y: f64,
    edge_x: f64,
    edge_y: f64,
    obstacle_x: f64,
    obstacle_y: f64,
) -> ClearanceSpec {
    ClearanceSpec {
        part_to_part: axis_clearance(part_x, part_y),
        part_to_sheet_edge: axis_clearance(edge_x, edge_y),
        part_to_obstacle: axis_clearance(obstacle_x, obstacle_y),
    }
}

fn normalized_maximize_area() -> NormalizedRequest {
    let mut request = production_request(
        vec![
            part("part-a", 1, rect(10.0, 10.0)),
            part("part-b", 1, rect(10.0, 10.0)),
        ],
        production_clearance(0.0, 0.0, 0.0, 0.0, 0.0, 0.0),
        Vec::new(),
    );
    let production = request.production_contract.as_mut().unwrap();
    production.grouping_intent = GroupingIntent::MaximizeArea;
    // Cố ý đảo thứ tự để final validator phải tra zone bằng partId.
    production.placement_zones = vec![
        PartPlacementZoneSpec {
            part_id: "part-b".to_string(),
            bounds: AxisAlignedBoundsSpec {
                min_x_mm: 10.0,
                min_y_mm: 10.0,
                max_x_mm: 690.0,
                max_y_mm: 500.0,
            },
        },
        PartPlacementZoneSpec {
            part_id: "part-a".to_string(),
            bounds: AxisAlignedBoundsSpec {
                min_x_mm: 10.0,
                min_y_mm: 500.0,
                max_x_mm: 690.0,
                max_y_mm: 990.0,
            },
        },
    ];
    normalize_request(&request).expect("partition maximize_area phải hợp lệ")
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
    normalize_request(&base_request(parts)).expect("request phải hợp lệ")
}

fn normalized_autofill(mut parts: Vec<PartSpec>) -> NormalizedRequest {
    for part in &mut parts {
        // Representation chuyển tiếp của field quantity vắng mặt; không phải cap.
        part.quantity = 0;
    }
    let mut request = base_request(parts);
    request.layout_intent = LayoutIntent::AutofillSingleSheet;
    request.sheet.max_sheets = 1;
    normalize_request(&request).expect("request autofill phải hợp lệ")
}

fn placement(instance: &str, part_id: &str, sheet: u32, pose: Pose) -> PlacementRecord {
    PlacementRecord {
        instance_id: instance.to_string(),
        part_id: part_id.to_string(),
        sheet_index: sheet,
        pose,
        source_revision: None,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. NFP — parity với oracle va chạm độc lập
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn version_quy_tac_nfp() {
    assert_eq!(NFP_RULE_VERSION, 2);
    assert_eq!(
        NfpError::TooManyConvexPairs { pairs: 9_999 }.code(),
        "NFP_TOO_MANY_CONVEX_PAIRS"
    );
}

#[test]
fn nfp_hai_chu_nhat_co_dang_dong() {
    // NFP của hai chữ nhật là chữ nhật tổng kích thước, đặt quanh gốc theo −B.
    let a = rect(80.0, 40.0);
    let b = rect(30.0, 20.0);
    let region = no_fit_polygon(&a, &b, &tol()).unwrap();
    assert_eq!(region.len(), 1, "cả hai lồi ⇒ đúng một vòng, không lỗ");
    assert!((region_area_mm2(&region).abs() - 6_600.0).abs() < 1e-6);
    let bounds = BoundsMm::from_ring(&region[0]).unwrap();
    assert!((bounds.min_x + 30.0).abs() < 1e-9);
    assert!((bounds.min_y + 20.0).abs() < 1e-9);
    assert!((bounds.max_x - 80.0).abs() < 1e-9);
    assert!((bounds.max_y - 40.0).abs() < 1e-9);
}

#[test]
fn nfp_parity_voi_oracle_va_cham() {
    let cases: Vec<(&str, Vec<PointMm>, Vec<PointMm>, f64)> = vec![
        ("lồi ⊕ lồi", rect(40.0, 25.0), rect(15.0, 10.0), 70.0),
        ("lõm L ⊕ lồi", shape_l(), rect(12.0, 8.0), 90.0),
        ("lõm C ⊕ lồi", shape_c(), rect(8.0, 8.0), 90.0),
        ("lõm C ⊕ lõm L", shape_c(), shape_l(), 130.0),
    ];
    for (name, a, b, span) in &cases {
        let region = no_fit_polygon(a, b, &tol()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(!region.is_empty(), "{name}: NFP không được rỗng");
        let lech = nfp_parity(a, b, &region, *span, 70);
        assert_eq!(lech, 0, "{name}: lệch oracle ở {lech} điểm lưới");
    }
}

#[test]
fn nfp_dung_o_goc_khong_cardinal() {
    // NFP phụ thuộc góc, nên phải đúng ở mọi góc chứ không chỉ 0/90/180/270.
    let a = shape_l();
    for goc in [13.372_849_f64, 44.999, 89.999, 179.5, 359.9] {
        let b = rotate(&rect(12.0, 8.0), goc);
        let region = no_fit_polygon(&a, &b, &tol()).unwrap_or_else(|e| panic!("góc {goc}: {e:?}"));
        assert!(!region.is_empty());
        let lech = nfp_parity(&a, &b, &region, 95.0, 60);
        assert_eq!(lech, 0, "góc {goc}°: lệch oracle ở {lech} điểm");
    }
}

#[test]
fn nfp_khong_phu_thuoc_chieu_vong_dau_vao() {
    let a = shape_l();
    let b = rect(12.0, 8.0);
    let mut a_rev = a.clone();
    a_rev.reverse();
    let mut b_rev = b.clone();
    b_rev.reverse();
    let base = region_area_mm2(&no_fit_polygon(&a, &b, &tol()).unwrap()).abs();
    for (name, x, y) in [
        ("A đảo", a_rev.clone(), b.clone()),
        ("B đảo", a.clone(), b_rev.clone()),
        ("cả hai đảo", a_rev, b_rev),
    ] {
        let got = region_area_mm2(&no_fit_polygon(&x, &y, &tol()).unwrap()).abs();
        assert!((got - base).abs() < 1e-6, "{name}: {got} != {base}");
    }
}

#[test]
fn nfp_tu_choi_dau_vao_khong_dung_duoc() {
    // Contour tự cắt: ear clipping vẫn "cắt ra tam giác", nên chốt toàn vẹn của
    // `no_fit_polygon` là so tổng diện tích mảnh với diện tích vòng.
    let no = vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(0.0, 10.0), pt(20.0, 20.0)];
    assert_eq!(
        no_fit_polygon(&no, &rect(5.0, 5.0), &tol()),
        Err(NfpError::DecompositionFailed)
    );
    assert_eq!(
        no_fit_polygon(&rect(5.0, 5.0), &no, &tol()),
        Err(NfpError::DecompositionFailed)
    );
    // Vòng suy biến và vòng dưới 3 đỉnh cũng bị chặn.
    assert!(no_fit_polygon(&[pt(0.0, 0.0), pt(1.0, 0.0)], &rect(5.0, 5.0), &tol()).is_err());
    let thang = vec![pt(0.0, 0.0), pt(5.0, 0.0), pt(10.0, 0.0)];
    assert!(no_fit_polygon(&thang, &rect(5.0, 5.0), &tol()).is_err());
    // Mã lỗi ổn định cho backend.
    assert_eq!(
        NfpError::DecompositionFailed.code(),
        "NFP_DECOMPOSITION_FAILED"
    );
    // Và đường chính quy vẫn là `normalize.rs` chặn từ đầu.
    let mut spec = part("part-a", 1, no);
    spec.reference_point_mm = None;
    assert!(
        normalize_request(&base_request(vec![spec])).is_err(),
        "normalize phải chặn contour tự cắt trước khi tới NFP"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. IFP và miền vị trí hợp lệ
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn ifp_chu_nhat_co_dang_dong() {
    let usable = BoundsMm {
        min_x: 10.0,
        min_y: 40.0,
        max_x: 690.0,
        max_y: 960.0,
    };
    // Chi tiết 80×40 với pivot ở gốc, bbox [0,80]×[0,40].
    let ifp = inner_fit_rect(&usable, &rect(80.0, 40.0), &tol()).expect("phải vừa");
    assert!((ifp.min_x - 10.0).abs() < 1e-9);
    assert!((ifp.max_x - 610.0).abs() < 1e-9);
    assert!((ifp.min_y - 40.0).abs() < 1e-9);
    assert!((ifp.max_y - 920.0).abs() < 1e-9);

    // Đặt ở góc IFP ⇒ contour vẫn nằm hẳn trong vùng dùng được.
    for corner in [
        pt(ifp.min_x, ifp.min_y),
        pt(ifp.max_x, ifp.min_y),
        pt(ifp.min_x, ifp.max_y),
        pt(ifp.max_x, ifp.max_y),
    ] {
        let placed = translate(&rect(80.0, 40.0), corner.x, corner.y);
        let b = BoundsMm::from_ring(&placed).unwrap();
        assert!(
            usable.contains_bounds(&b, &tol()),
            "góc IFP {corner:?} phải vừa"
        );
    }
    // Ra ngoài IFP một chút ⇒ tràn.
    let ngoai = translate(&rect(80.0, 40.0), ifp.max_x + 0.01, ifp.min_y);
    let b = BoundsMm::from_ring(&ngoai).unwrap();
    assert!(!usable.contains_bounds(&b, &tol()));
}

#[test]
fn ifp_tra_none_khi_qua_kho() {
    let usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 100.0,
        max_y: 100.0,
    };
    // 130×10 không vừa ở 0° (rộng hơn 100).
    assert!(inner_fit_rect(&usable, &rect(130.0, 10.0), &tol()).is_none());
    // Nhưng vừa quanh 45° — đúng bằng chứng free-angle của P2a.
    assert!(inner_fit_rect(&usable, &rotate(&rect(130.0, 10.0), 45.0), &tol()).is_some());
    for cardinal in [0.0_f64, 90.0, 180.0, 270.0] {
        assert!(
            inner_fit_rect(&usable, &rotate(&rect(130.0, 10.0), cardinal), &tol()).is_none(),
            "{cardinal}° không được vừa"
        );
    }
}

#[test]
fn mien_hop_le_tru_dung_chi_tiet_da_dat() {
    let usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 200.0,
        max_y: 200.0,
    };
    let moving = rect(20.0, 20.0);

    // Tờ trống ⇒ miền là chính IFP.
    let trong = feasible_region(&usable, &[], &moving, 0.0, &tol()).unwrap();
    assert_eq!(trong.len(), 1);
    assert!((region_area_mm2(&trong).abs() - 180.0 * 180.0).abs() < 1e-6);

    // Đặt một chi tiết giữa tờ ⇒ miền bị khoét.
    let placed = vec![rect_at(80.0, 80.0, 40.0, 40.0)];
    let sau = feasible_region(&usable, &placed, &moving, 0.0, &tol()).unwrap();
    let dien_tich = region_area_mm2(&sau).abs();
    assert!(
        dien_tich < 180.0 * 180.0,
        "miền phải nhỏ hơn khi đã có chi tiết"
    );
    assert!(dien_tich > 0.0);

    // Mọi vị trí trong miền phải cho layout KHÔNG chồng — kiểm bằng quan toà độc lập.
    let mut kiem = 0;
    for gx in 0..40 {
        for gy in 0..40 {
            let t = pt(
                usable.min_x + 180.0 * (f64::from(gx) + 0.5) / 40.0,
                usable.min_y + 180.0 * (f64::from(gy) + 0.5) / 40.0,
            );
            if !region_contains(&sau, t) {
                continue;
            }
            kiem += 1;
            let candidate = translate(&moving, t.x, t.y);
            assert!(
                !rings_overlap(&placed[0], &candidate, &tol()),
                "vị trí {t:?} trong miền hợp lệ mà lại chồng"
            );
        }
    }
    assert!(kiem > 100, "phải kiểm được nhiều vị trí, chỉ có {kiem}");
}

#[test]
fn mien_hop_le_ton_trong_gap() {
    let usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 200.0,
        max_y: 200.0,
    };
    let moving = rect(20.0, 20.0);
    let placed = vec![rect_at(80.0, 80.0, 40.0, 40.0)];
    let gap = 5.0;
    let region = feasible_region(&usable, &placed, &moving, gap, &tol()).unwrap();

    let mut kiem = 0;
    for gx in 0..50 {
        for gy in 0..50 {
            let t = pt(
                180.0 * (f64::from(gx) + 0.5) / 50.0,
                180.0 * (f64::from(gy) + 0.5) / 50.0,
            );
            if !region_contains(&region, t) {
                continue;
            }
            kiem += 1;
            let candidate = translate(&moving, t.x, t.y);
            let verdict = judge_pair(&placed[0], &candidate, gap, &tol());
            assert!(
                verdict.is_ok(),
                "vị trí {t:?} trong miền mà quan toà loại: {verdict:?}"
            );
        }
    }
    assert!(kiem > 50, "chỉ kiểm được {kiem} vị trí");

    // Và miền phải nhỏ hơn khi gap lớn hơn — không được bỏ qua gap.
    let khong_gap =
        region_area_mm2(&feasible_region(&usable, &placed, &moving, 0.0, &tol()).unwrap()).abs();
    assert!(region_area_mm2(&region).abs() < khong_gap);
}

#[test]
fn nfp_clearance_di_huong_giu_dung_truc_va_ca_zero() {
    let stationary = rect(10.0, 10.0);
    let moving = rect(10.0, 10.0);

    let vertical =
        no_fit_polygon_sheet_axis(&stationary, &moving, axis_clearance(0.0, 10.0), &tol()).unwrap();
    let vertical_bounds = BoundsMm::from_ring(&vertical[0]).unwrap();
    assert_eq!(
        (
            vertical_bounds.min_x,
            vertical_bounds.min_y,
            vertical_bounds.max_x,
            vertical_bounds.max_y,
        ),
        (-10.0, -20.0, 10.0, 20.0)
    );

    let horizontal =
        no_fit_polygon_sheet_axis(&stationary, &moving, axis_clearance(10.0, 0.0), &tol()).unwrap();
    let horizontal_bounds = BoundsMm::from_ring(&horizontal[0]).unwrap();
    assert_eq!(
        (
            horizontal_bounds.min_x,
            horizontal_bounds.min_y,
            horizontal_bounds.max_x,
            horizontal_bounds.max_y,
        ),
        (-20.0, -10.0, 20.0, 10.0)
    );
}

#[test]
fn mien_hop_le_di_huong_khong_xoa_pose_theo_truc_gap_bang_zero() {
    let moving = rect(10.0, 10.0);
    let horizontal_usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 31.0,
        max_y: 11.0,
    };
    let horizontal_placed = vec![
        rect_at(0.0, 0.0, 10.0, 10.0),
        rect_at(10.0, 0.0, 10.0, 10.0),
    ];
    let horizontal = feasible_region_sheet_axis(
        &horizontal_usable,
        &horizontal_placed,
        &moving,
        axis_clearance(0.0, 10.0),
        &tol(),
    )
    .unwrap();
    assert!(
        region_contains(&horizontal, pt(20.5, 0.5)),
        "gapY không được xoá pose tách nhau theo X"
    );

    let vertical_usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 11.0,
        max_y: 31.0,
    };
    let vertical_placed = vec![
        rect_at(0.0, 0.0, 10.0, 10.0),
        rect_at(0.0, 10.0, 10.0, 10.0),
    ];
    let vertical = feasible_region_sheet_axis(
        &vertical_usable,
        &vertical_placed,
        &moving,
        axis_clearance(10.0, 0.0),
        &tol(),
    )
    .unwrap();
    assert!(
        region_contains(&vertical, pt(0.5, 20.5)),
        "gapX không được xoá pose tách nhau theo Y"
    );
}

#[test]
fn cache_va_incremental_phan_biet_hai_truc_clearance() {
    let obstacle = rect(10.0, 10.0);
    let moving = rect(10.0, 10.0);
    let mut key_cache = NfpCache::new();
    key_cache
        .grown_nfp_with_clearance(
            &obstacle,
            &moving,
            NfpClearance::sheet_axis(axis_clearance(0.0, 10.0)),
            &tol(),
        )
        .unwrap();
    key_cache
        .grown_nfp_with_clearance(
            &obstacle,
            &moving,
            NfpClearance::sheet_axis(axis_clearance(10.0, 0.0)),
            &tol(),
        )
        .unwrap();
    key_cache
        .grown_nfp_with_clearance(
            &obstacle,
            &moving,
            NfpClearance::sheet_axis(axis_clearance(0.0, 10.0)),
            &tol(),
        )
        .unwrap();
    key_cache
        .grown_nfp(&obstacle, &moving, 10.0, &tol())
        .unwrap();
    assert_eq!(
        (key_cache.misses(), key_cache.hits(), key_cache.len()),
        (3, 1, 3)
    );

    let usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 80.0,
        max_y: 40.0,
    };
    let placed = vec![
        rect_at(0.0, 0.0, 10.0, 10.0),
        rect_at(20.0, 0.0, 10.0, 10.0),
    ];
    let clearance = NfpClearance::sheet_axis(axis_clearance(2.0, 7.0));
    let mut cache = NfpCache::new();
    let base = feasible_region_cached_with_clearance(
        &usable,
        &placed[..1],
        &moving,
        clearance,
        &tol(),
        &mut cache,
        None,
    )
    .unwrap()
    .unwrap();
    let incremental = feasible_region_after_with_clearance(
        base,
        &placed[1..],
        &moving,
        clearance,
        &tol(),
        &mut cache,
        None,
    )
    .unwrap()
    .unwrap();
    let full = feasible_region_cached_with_clearance(
        &usable,
        &placed,
        &moving,
        clearance,
        &tol(),
        &mut cache,
        None,
    )
    .unwrap()
    .unwrap();
    assert!((region_area_mm2(&incremental) - region_area_mm2(&full)).abs() < 1e-9);
    for x in 0..70 {
        for y in 0..30 {
            let sample = pt(f64::from(x) + 0.5, f64::from(y) + 0.5);
            assert_eq!(
                region_contains(&incremental, sample),
                region_contains(&full, sample),
                "incremental lệch full tại {sample:?}"
            );
        }
    }
}

#[test]
fn dinh_cua_mien_la_ung_vien_tiep_xuc_khong_phai_luoi() {
    let usable = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 200.0,
        max_y: 200.0,
    };
    let placed = vec![rect_at(70.0, 70.0, 40.0, 40.0)];
    let region = feasible_region(&usable, &placed, &rect(20.0, 20.0), 0.0, &tol()).unwrap();
    let dinh = region_vertices(&region);
    assert!(
        dinh.len() >= 8,
        "phải có đỉnh IFP và đỉnh NFP: {}",
        dinh.len()
    );
    // Số đỉnh phải nhỏ — nếu là lưới toạ độ thì sẽ có hàng nghìn điểm.
    assert!(
        dinh.len() < 64,
        "ứng viên là điểm tiếp xúc, không phải lưới: {} điểm",
        dinh.len()
    );
    // Toạ độ đỉnh không bị làm tròn về bội của bước nào.
    let region_le = feasible_region(
        &usable,
        &[rect_at(70.123_456, 70.987_654, 40.0, 40.0)],
        &rect(20.0, 20.0),
        0.0,
        &tol(),
    )
    .unwrap();
    let co_phan_le = region_vertices(&region_le)
        .iter()
        .any(|p| (p.x - p.x.round()).abs() > 1e-6 || (p.y - p.y.round()).abs() > 1e-6);
    assert!(co_phan_le, "đỉnh miền phải giữ phần lẻ mm");
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Broad phase — chỉ sai theo hướng an toàn
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn luoi_khong_bao_gio_bo_sot_cap_co_the_cham() {
    let area = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 300.0,
        max_y: 300.0,
    };
    let mut grid = SpatialGrid::new(&area, 25.0);
    let mut boxes: Vec<BoundsMm> = Vec::new();
    // Rải 60 hộp theo công thức xác định, có cả cặp chạm và cặp rời.
    for k in 0..60usize {
        let x = ((k * 37) % 280) as f64;
        let y = ((k * 53) % 270) as f64;
        let b = BoundsMm {
            min_x: x,
            min_y: y,
            max_x: x + 18.0,
            max_y: y + 12.0,
        };
        grid.insert(k, b);
        boxes.push(b);
    }
    assert_eq!(grid.len(), 60);

    // So với brute force: mọi cặp mà bbox chạm nhau đều phải xuất hiện trong query.
    for (i, bi) in boxes.iter().enumerate() {
        let tra = grid.query(bi, 0.0, &tol());
        let found: Vec<usize> = tra.iter().map(|e| e.id).collect();
        for (j, bj) in boxes.iter().enumerate() {
            let cham = bi.min_x <= bj.max_x
                && bj.min_x <= bi.max_x
                && bi.min_y <= bj.max_y
                && bj.min_y <= bi.max_y;
            if cham {
                assert!(
                    found.contains(&j),
                    "hộp {i} và {j} chạm nhau mà lưới bỏ sót"
                );
            }
        }
        // Kết quả xác định: gọi lại cho đúng danh sách.
        let lai: Vec<usize> = grid.query(bi, 0.0, &tol()).iter().map(|e| e.id).collect();
        assert_eq!(found, lai, "query phải xác định");
        // Và đã sắp theo thứ tự chèn.
        let mut sorted = found.clone();
        sorted.sort_unstable();
        assert_eq!(found, sorted);
    }
}

#[test]
fn luoi_ton_trong_margin_va_loai_duoc_cap_xa() {
    let area = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 200.0,
        max_y: 200.0,
    };
    let mut grid = SpatialGrid::new(&area, 20.0);
    grid.insert(
        0,
        BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 10.0,
            max_y: 10.0,
        },
    );
    grid.insert(
        1,
        BoundsMm {
            min_x: 15.0,
            min_y: 0.0,
            max_x: 25.0,
            max_y: 10.0,
        },
    );
    grid.insert(
        2,
        BoundsMm {
            min_x: 150.0,
            min_y: 150.0,
            max_x: 160.0,
            max_y: 160.0,
        },
    );

    let q = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 10.0,
        max_y: 10.0,
    };
    // margin 0: chỉ thấy chính nó.
    let ids: Vec<usize> = grid.query(&q, 0.0, &tol()).iter().map(|e| e.id).collect();
    assert_eq!(ids, vec![0]);
    // margin 5: kéo thêm hộp cách 5 mm.
    let ids: Vec<usize> = grid.query(&q, 5.0, &tol()).iter().map(|e| e.id).collect();
    assert_eq!(ids, vec![0, 1]);
    // Hộp ở góc xa không bao giờ lọt vào.
    let ids: Vec<usize> = grid.query(&q, 20.0, &tol()).iter().map(|e| e.id).collect();
    assert!(!ids.contains(&2));

    // Toạ độ bệnh bị từ chối, không làm hỏng truy vấn sau đó.
    assert!(grid
        .insert(
            9,
            BoundsMm {
                min_x: f64::NAN,
                min_y: 0.0,
                max_x: 1.0,
                max_y: 1.0
            }
        )
        .is_none());
    assert_eq!(grid.len(), 3);

    grid.clear();
    assert!(grid.is_empty());
}

// ═════════════════════════════════════════════════════════════════════════════
//  4. Validator
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn clearance_di_huong_duoc_do_trong_sheet_space_sau_pose() {
    let a = rect(10.0, 10.0);
    let clearance = axis_clearance(2.0, 0.5);

    // Chỉ hở 1,5 mm theo X, trong khi projection Y còn chồng nhau.
    let sat_x = rect_at(11.5, 0.0, 10.0, 10.0);
    assert!(matches!(
        judge_pair_sheet_axis(&a, &sat_x, clearance, &tol()),
        PairVerdict::ClearanceTooSmall { .. }
    ));

    // X chỉ hở 0,5 mm nhưng Y đã hở 0,75 mm (> gapY 0,5): rectangle expansion
    // theo trục tờ có một trục phân cách hợp lệ nên phải đạt.
    let tach_y = rect_at(10.5, 10.75, 10.0, 10.0);
    assert!(matches!(
        judge_pair_sheet_axis(&a, &tach_y, clearance, &tol()),
        PairVerdict::Ok { .. }
    ));

    // Cùng bất biến trên contour đã xoay 17°; hàm không hề biết local axes nữa.
    let rotated = translate(&rotate(&rect(10.0, 4.0), 17.0), 0.0, 11.0);
    assert!(matches!(
        judge_pair_sheet_axis(&a, &rotated, axis_clearance(0.5, 2.0), &tol()),
        PairVerdict::ClearanceTooSmall { .. }
    ));
}

#[test]
fn normalize_production_giu_identity_obstacle_va_inset_edge_clearance() {
    let obstacle = FixedObstacleSpec {
        obstacle_id: "boong-a".to_string(),
        kind: FixedObstacleKind::Gripper,
        outer: rect_at(100.0, 100.0, 30.0, 15.0),
    };
    let request = production_request(
        vec![part("part-a", 1, rect(10.0, 10.0))],
        production_clearance(3.0, 4.0, 5.0, 6.0, 7.0, 8.0),
        vec![obstacle],
    );
    let normalized = normalize_request(&request).expect("production request phải chuẩn hoá được");

    assert_eq!(normalized.sheet.material_usable.min_x, 10.0);
    assert_eq!(normalized.sheet.material_usable.min_y, 10.0);
    assert_eq!(normalized.sheet.usable.min_x, 15.0);
    assert_eq!(normalized.sheet.usable.min_y, 16.0);
    assert!((normalized.gap_mm - 5.0).abs() < 1e-12); // hypot(3,4), broad-phase bảo thủ
    let production = normalized.production_contract.as_ref().unwrap();
    assert_eq!(production.request_revision, 1);
    assert_eq!(production.fixed_obstacles[0].obstacle_id, "boong-a");
    assert_eq!(
        production.fixed_obstacles[0].kind,
        FixedObstacleKind::Gripper
    );
}

#[test]
fn validator_phan_biet_tran_to_edge_clearance_va_obstacle() {
    let obstacle = FixedObstacleSpec {
        obstacle_id: "dau-canh-01".to_string(),
        kind: FixedObstacleKind::SheetMark,
        outer: rect_at(100.0, 100.0, 20.0, 20.0),
    };
    let request = normalize_request(&production_request(
        vec![part("part-a", 1, rect(10.0, 10.0))],
        production_clearance(0.0, 0.0, 5.0, 5.0, 3.0, 3.0),
        vec![obstacle],
    ))
    .unwrap();

    // Vẫn trong material usable (x>=10), nhưng thiếu edge clearance (x phải >=15).
    let near_edge = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 12.0, 30.0),
    )];
    let edge_report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &near_edge,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(edge_report.has(ValidationCode::SheetEdgeClearanceTooSmall));
    assert!(!edge_report.has(ValidationCode::OutsideUsableArea));

    let on_obstacle = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 105.0, 105.0),
    )];
    let overlap_report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &on_obstacle,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(overlap_report.has(ValidationCode::FixedObstacleOverlap));
    assert!(overlap_report.obstacle_pairs_checked > 0);

    // Không chồng nhưng chỉ hở 2 mm theo X, thấp hơn obstacle gap 3 mm.
    let near_obstacle = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 88.0, 100.0),
    )];
    let clearance_report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &near_obstacle,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(clearance_report.has(ValidationCode::ObstacleClearanceTooSmall));
}

#[test]
fn validator_khoa_bien_zone_doc_lap_va_dung_tolerance() {
    assert_eq!(
        ValidationCode::OutsidePlacementZone.as_str(),
        "OUTSIDE_PLACEMENT_ZONE"
    );
    let request = normalized_maximize_area();
    let tolerance = request.tolerance.linear_mm;
    let cases = [
        ("đúng biên", 500.0, false),
        ("trong tolerance", 500.0 - 0.5 * tolerance, false),
        ("vượt tolerance", 500.0 - 2.0 * tolerance, true),
    ];

    for (name, part_a_y, should_reject) in cases {
        let placements = vec![
            placement("part-a#0001", "part-a", 0, Pose::new(0.0, 100.0, part_a_y)),
            placement("part-b#0001", "part-b", 0, Pose::new(0.0, 200.0, 100.0)),
        ];
        let report = validate_layout(
            &request,
            &LayoutUnderReview {
                placements: &placements,
                unplaced: &[],
                stats: None,
            },
        );

        assert_eq!(
            report.has(ValidationCode::OutsidePlacementZone),
            should_reject,
            "ca {name}: {:?}",
            report.codes()
        );
        assert!(
            !report.has(ValidationCode::OutsideUsableArea)
                && !report.has(ValidationCode::SheetEdgeClearanceTooSmall),
            "biên zone nội bộ không được nhập nhằng với mép tờ: {:?}",
            report.codes()
        );
        if should_reject {
            let issue = report
                .issues
                .iter()
                .find(|issue| issue.code == ValidationCode::OutsidePlacementZone)
                .unwrap();
            assert_eq!(issue.instance_id, "part-a#0001");
            assert!(issue.measured < -tolerance, "mức tràn: {}", issue.measured);
        } else {
            assert!(report.valid, "ca {name} phải hợp lệ: {:?}", report.codes());
        }
    }
}

#[test]
fn layout_hop_le_di_qua_validator() {
    let request = normalized(vec![part("part-a", 3, rect(80.0, 40.0))]);
    // Ba con xếp dọc, hở đúng 3 mm — bằng `gapMm` nên narrow phase thực sự phải đo.
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 20.0, 93.0)),
        placement("part-a#0003", "part-a", 0, Pose::new(0.0, 20.0, 136.0)),
    ];
    let layout = LayoutUnderReview {
        placements: &placements,
        unplaced: &[],
        stats: None,
    };
    let report = validate_layout(&request, &layout);
    assert!(report.valid, "phải đạt, lỗi: {:?}", report.codes());
    assert_eq!(report.validator_version, MIXED_NESTING_VALIDATOR_VERSION);
    assert!(
        (report.min_clearance_mm - 3.0).abs() < 1e-6,
        "khoảng hở nhỏ nhất phải đúng 3 mm, đo được {}",
        report.min_clearance_mm
    );
    assert!(report.min_margin_mm > 0.0);
    assert!(report.pairs_checked > 0, "broad phase phải sinh cặp để đo");
}

#[test]
fn validator_autofill_chan_gang_thieu_bat_ky_mau_nao() {
    let request = normalized_autofill(vec![
        part("part-a", 1, rect(80.0, 40.0)),
        part("part-b", 1, rect(60.0, 30.0)),
    ]);
    let placements = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 20.0, 50.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(!report.valid);
    assert!(
        report.has(ValidationCode::MissingAutofillPart),
        "không được công bố tờ gang thiếu part-b: {:?}",
        report.codes()
    );
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == ValidationCode::MissingAutofillPart
            && issue.instance_id == "part-b"));
}

#[test]
fn validator_autofill_nhan_gang_co_du_moi_mau() {
    let request = normalized_autofill(vec![
        part("part-a", 1, rect(80.0, 40.0)),
        part("part-b", 1, rect(60.0, 30.0)),
    ]);
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-b#0001", "part-b", 0, Pose::new(0.0, 120.0, 50.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(report.valid, "gang đủ mẫu phải đạt: {:?}", report.codes());
}

#[test]
fn validator_autofill_khong_nhan_unplaced_gia_lam_no_san_xuat() {
    let request = normalized_autofill(vec![part("part-a", 1, rect(80.0, 40.0))]);
    let placements = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 20.0, 50.0),
    )];
    let unplaced = vec![UnplacedRecord {
        instance_id: "part-a#0002".to_string(),
        part_id: "part-a".to_string(),
        reason: UnplacedReason::MaxSheetsReached,
    }];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &unplaced,
            stats: None,
        },
    );
    assert!(!report.valid);
    assert!(
        report.has(ValidationCode::QuantityMismatch),
        "autofill không được công bố unplaced: {:?}",
        report.codes()
    );
}

#[test]
fn validator_chan_chong_lan() {
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 40.0, 60.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(!report.valid);
    assert!(report.has(ValidationCode::Overlap), "{:?}", report.codes());
}

#[test]
fn validator_chan_thieu_khoang_ho() {
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    // Cách nhau 1 mm theo Y, nhưng gap khai là 3 mm.
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 20.0, 91.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(!report.valid);
    assert!(
        report.has(ValidationCode::ClearanceTooSmall),
        "{:?}",
        report.codes()
    );
    let issue = report
        .issues
        .iter()
        .find(|i| i.code == ValidationCode::ClearanceTooSmall)
        .unwrap();
    assert!(
        (issue.measured - 1.0).abs() < 1e-6,
        "đo được {}",
        issue.measured
    );
    assert!((issue.required - 3.0).abs() < 1e-9);
}

#[test]
fn validator_chan_tran_ra_ngoai_to() {
    let request = normalized(vec![part("part-a", 1, rect(80.0, 40.0))]);
    // Lề trái là 10 mm, đặt ở x = 5 ⇒ tràn 5 mm.
    let placements = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(0.0, 5.0, 50.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(!report.valid);
    assert!(
        report.has(ValidationCode::OutsideUsableArea),
        "{:?}",
        report.codes()
    );
    assert!(
        !report.has(ValidationCode::OutsidePlacementZone),
        "free gang không được sinh lỗi zone: {:?}",
        report.codes()
    );
    assert!(report.min_margin_mm < 0.0, "lề phải âm khi đã tràn");
}

#[test]
fn validator_chan_goc_ngoai_mien_va_goc_chua_canonical() {
    // Chi tiết bị khoá 0/180 nhưng solver trả 90° ⇒ phải bị chặn.
    let mut spec = part("part-a", 1, rect(80.0, 40.0));
    spec.rotation_constraint = RotationConstraint::preset_half_turn();
    let request = normalized(vec![spec]);

    let ngoai_mien = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(90.0, 60.0, 50.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &ngoai_mien,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::AngleOutsideDomain),
        "{:?}",
        report.codes()
    );

    // 180° thì hợp lệ.
    let trong_mien = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(180.0, 100.0, 60.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &trong_mien,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        !report.has(ValidationCode::AngleOutsideDomain),
        "{:?}",
        report.codes()
    );

    // Góc chưa canonical (450°) bị chặn — validator KHÔNG tự chuẩn hoá hộ.
    let chua_canonical = vec![placement(
        "part-a#0001",
        "part-a",
        0,
        Pose::new(450.0, 100.0, 60.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &chua_canonical,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::AngleNotCanonical),
        "{:?}",
        report.codes()
    );
}

#[test]
fn validator_nhan_goc_khong_cardinal_va_toa_do_phan_le() {
    // Chốt "không áp angle step, không áp lưới toạ độ": pose lẻ tới 6 chữ số phải ĐẠT.
    let request = normalized(vec![part("part-a", 2, rect(40.0, 20.0))]);
    let placements = vec![
        placement(
            "part-a#0001",
            "part-a",
            0,
            Pose::new(13.372_849, 123.456_789, 67.891_234),
        ),
        placement(
            "part-a#0002",
            "part-a",
            0,
            Pose::new(44.999, 300.123_456_7, 400.987_654_3),
        ),
    ];
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
        "góc lẻ và X/Y phần lẻ phải đạt: {:?}",
        report.codes()
    );
}

#[test]
fn validator_chan_pose_benh() {
    let request = normalized(vec![part("part-a", 1, rect(40.0, 20.0))]);
    for pose in [
        Pose::new(f64::NAN, 100.0, 100.0),
        Pose::new(0.0, f64::INFINITY, 100.0),
        Pose::new(0.0, 100.0, f64::NEG_INFINITY),
    ] {
        let placements = vec![placement("part-a#0001", "part-a", 0, pose)];
        let report = validate_layout(
            &request,
            &LayoutUnderReview {
                placements: &placements,
                unplaced: &[],
                stats: None,
            },
        );
        assert!(
            report.has(ValidationCode::PoseNotFinite),
            "{:?}",
            report.codes()
        );
    }
}

#[test]
fn validator_bao_toan_so_luong_va_dinh_danh() {
    let request = normalized(vec![part("part-a", 3, rect(40.0, 20.0))]);

    // Thiếu một con ⇒ QuantityMismatch.
    let thieu = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 20.0, 100.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &thieu,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::QuantityMismatch),
        "{:?}",
        report.codes()
    );

    // Đặt 2 + chưa đặt 1 = 3 ⇒ đạt.
    let unplaced = vec![UnplacedRecord {
        instance_id: "part-a#0003".to_string(),
        part_id: "part-a".to_string(),
        reason: UnplacedReason::NoFeasiblePose,
    }];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &thieu,
            unplaced: &unplaced,
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());

    // Trùng định danh.
    let trung = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 100.0)),
        placement("part-a#0003", "part-a", 0, Pose::new(0.0, 20.0, 150.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &trung,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::DuplicateInstanceId),
        "{:?}",
        report.codes()
    );

    // Mã chi tiết lạ.
    let la = vec![placement(
        "part-x#0001",
        "part-x",
        0,
        Pose::new(0.0, 20.0, 50.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &la,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::UnknownPartId),
        "{:?}",
        report.codes()
    );
}

#[test]
fn validator_chan_source_revision_lech() {
    let mut spec = part("part-a", 1, rect(40.0, 20.0));
    spec.source_revision = Some("sha256:aaa".to_string());
    let request = normalized(vec![spec]);

    let mut record = placement("part-a#0001", "part-a", 0, Pose::new(0.0, 30.0, 60.0));
    record.source_revision = Some("sha256:bbb".to_string());
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &[record],
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::SourceRevisionMismatch),
        "{:?}",
        report.codes()
    );

    // Khớp thì đạt.
    let mut record = placement("part-a#0001", "part-a", 0, Pose::new(0.0, 30.0, 60.0));
    record.source_revision = Some("sha256:aaa".to_string());
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &[record],
            unplaced: &[],
            stats: None,
        },
    );
    assert!(report.valid, "{:?}", report.codes());
}

#[test]
fn validator_chan_thong_ke_tu_bao_sai() {
    let request = normalized(vec![part("part-a", 2, rect(40.0, 20.0))]);
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 20.0, 100.0)),
    ];
    // Thống kê tính lại ⇒ đạt.
    let dung = recompute_stats(
        &request,
        &placements,
        &[],
        RunCounters {
            elapsed_ms: 1_000,
            attempts: 5,
            orientation_evaluations: 20,
            pose_refinements: 3,
            termination_reason: TerminationReason::AllPlaced,
        },
    );
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: Some(&dung),
        },
    );
    assert!(report.valid, "{:?}", report.codes());
    assert_eq!(dung.sheet_count, 1);
    assert_eq!(dung.placed_count, 2);
    // 2 × 800 mm² / (700 × 1000) = 0.0022857…
    assert!((dung.material_utilization - 1_600.0 / 700_000.0).abs() < 1e-12);

    // Solver tự báo utilization đẹp hơn thực tế ⇒ bị chặn.
    let khai_gian = imposition_core::mixed_nesting::model::RunStats {
        material_utilization: dung.material_utilization + 0.25,
        ..dung
    };
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: Some(&khai_gian),
        },
    );
    assert!(
        report.has(ValidationCode::StatsMismatch),
        "{:?}",
        report.codes()
    );
}

#[test]
fn validator_dem_dung_so_to_va_tach_theo_to() {
    let request = normalized(vec![part("part-a", 4, rect(80.0, 40.0))]);
    // Hai con trên tờ 0, hai con trên tờ 1, ở CÙNG vị trí — khác tờ thì không chồng.
    let placements = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 20.0, 100.0)),
        placement("part-a#0003", "part-a", 1, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0004", "part-a", 1, Pose::new(0.0, 20.0, 100.0)),
    ];
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
        "cùng vị trí nhưng khác tờ thì không chồng: {:?}",
        report.codes()
    );
    let stats = recompute_stats(
        &request,
        &placements,
        &[],
        RunCounters::empty(TerminationReason::AllPlaced),
    );
    assert_eq!(stats.sheet_count, 2);
}

#[test]
fn validator_chan_so_to_vuot_tran() {
    let request = normalized(vec![part("part-a", 1, rect(40.0, 20.0))]);
    let placements = vec![placement(
        "part-a#0001",
        "part-a",
        999,
        Pose::new(0.0, 30.0, 60.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::SheetIndexOutOfRange),
        "{:?}",
        report.codes()
    );
}

#[test]
fn dinh_danh_instance_dung_hop_dong() {
    let request = normalized(vec![part("part-a", 3, rect(40.0, 20.0))]);
    let ids = instance_ids_for(&request.parts[0]);
    assert_eq!(ids, vec!["part-a#0001", "part-a#0002", "part-a#0003"]);
    // Định danh không đúng tiền tố bị chặn.
    let placements = vec![placement(
        "khac#0001",
        "part-a",
        0,
        Pose::new(0.0, 30.0, 60.0),
    )];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &placements,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(
        report.has(ValidationCode::UnknownInstanceId),
        "{:?}",
        report.codes()
    );
}

#[test]
fn validator_khong_import_bo_sinh_ung_vien() {
    // §11.6: validator không được gọi lại logic quyết định của solver.
    let source = include_str!("../src/mixed_nesting/validator.rs");
    for line in source.lines() {
        let code = line.trim_start();
        if code.starts_with("//") || !code.starts_with("use ") {
            continue;
        }
        for forbidden in [
            "nfp",
            "candidates",
            "refine",
            "solver",
            "multi_start",
            "kernel",
        ] {
            assert!(
                !code.contains(forbidden),
                "validator.rs không được import '{forbidden}': {code}"
            );
        }
    }
}

#[test]
fn manifest_status_khong_bi_dung_lam_ket_luan_validate() {
    // Trạng thái manifest và kết luận validator là hai việc khác nhau: một layout
    // `completed` vẫn có thể invalid, và khi đó phải fail job.
    let request = normalized(vec![part("part-a", 2, rect(80.0, 40.0))]);
    let chong = vec![
        placement("part-a#0001", "part-a", 0, Pose::new(0.0, 20.0, 50.0)),
        placement("part-a#0002", "part-a", 0, Pose::new(0.0, 30.0, 55.0)),
    ];
    let report = validate_layout(
        &request,
        &LayoutUnderReview {
            placements: &chong,
            unplaced: &[],
            stats: None,
        },
    );
    assert!(!report.valid);
    assert_ne!(ManifestStatus::Completed, ManifestStatus::Failed);
}

#[test]
fn dien_tich_hinh_lom_dung_sau_khi_dat() {
    // Chốt chống trôi: contour lõm sau khi đặt vẫn giữ nguyên diện tích.
    let request = normalized(vec![part("part-l", 1, shape_l())]);
    let goc = signed_area_mm2(&request.parts[0].outer).abs();
    assert!((goc - 1_718.0).abs() < 1e-9);
    for deg in [0.0_f64, 13.372_849, 179.5] {
        let placed = place_ring_checked(
            &request.parts[0].outer,
            &Pose::new(deg, 200.0, 300.0),
            request.parts[0].reference_point_mm,
            &tol(),
        )
        .unwrap();
        assert!((signed_area_mm2(&placed).abs() - goc).abs() < 1e-9);
    }
}
