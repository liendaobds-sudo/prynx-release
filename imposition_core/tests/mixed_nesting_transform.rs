//! Test hình học nền của `mixed_nesting` — phase P2a.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §3.3, §9.1, §10, §16.1.
//!
//! Bộ test này phải chứng minh sáu điều của gate P2a:
//!
//! 1. Phép biến đổi hoạt động ở **góc thực bất kỳ**, không chỉ 0/90/180/270.
//! 2. X/Y là **mm liên tục** — không snap pixel, không lưới mm, không bước dịch.
//! 3. `referencePoint` là pivot ổn định và KHÔNG phải góc bbox.
//! 4. Canonical hoá góc và cung góc đúng, kể cả chỗ nối `0°/360°`.
//! 5. Ghép `sourceToLocal → placementPose` vẫn là phép cứng.
//! 6. **Không có đường phản chiếu**: mirror/scale/shear bị từ chối bằng đủ ba chốt
//!    (`Rᵀ R ≈ I`, `det ≈ +1`, bảo toàn hướng signed-area).

use imposition_core::mixed_nesting::model::{
    canonicalize_angle_deg, AngleArcDeg, AxisAlignedBoundsSpec, ClearanceSpec, GroupingIntent,
    LayoutAlignment, MixedNestingRequest, OrientationPolicy, PartPlacementZoneSpec, PartSpec,
    PointMm, Pose, ProductionContractV1, Profile, Reflection, RotationConstraint,
    RotationDomainKind, SheetAxisClearanceMm, SheetMarginMm, SheetSpec, Tolerance,
    MIXED_NESTING_PRODUCTION_SCHEMA_VERSION, MIXED_NESTING_PROTOCOL_VERSION,
};
use imposition_core::mixed_nesting::normalize::{
    derive_reference_point, find_self_intersection, normalize_request, normalize_ring, BoundsMm,
    NormalizeErrorCode, NormalizeFailure, Winding, NORMALIZE_RULE_VERSION,
    REFERENCE_POINT_RULE_VERSION,
};
use imposition_core::mixed_nesting::orientation::{
    circular_distance_deg, resolve_part_domain, resolve_rotation_domain, CanonicalArc,
    OrientationError, RotationDomain,
};
use imposition_core::mixed_nesting::transform::{
    check_ring_orientation_preserved, export_transform, place_ring_checked, signed_area_mm2,
    AffineMm, RigidTransform, RigidityViolation, MATRIX_TOL,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích dùng chung
// ─────────────────────────────────────────────────────────────────────────────

/// Các góc nghiệm thu bắt buộc theo §16.1 — cố ý không có góc cardinal nào ngoài 360°.
const GOC_NGHIEM_THU: [f64; 7] = [0.1, 13.372849, 44.999, 89.999, 179.5, 359.9, 360.0];

fn tol() -> Tolerance {
    Tolerance::v1()
}

/// Hình L bất đối xứng, CCW. Có đúng một góc lõm nên phân biệt được xoay với lật gương.
fn hinh_l_bat_doi_xung() -> Vec<PointMm> {
    vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(60.0, 0.0),
        PointMm::new(60.0, 18.0),
        PointMm::new(22.0, 18.0),
        PointMm::new(22.0, 47.0),
        PointMm::new(0.0, 47.0),
    ]
}

fn chu_nhat(w: f64, h: f64) -> Vec<PointMm> {
    vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(w, 0.0),
        PointMm::new(w, h),
        PointMm::new(0.0, h),
    ]
}

/// Dấu của góc quay tại từng đỉnh. Xoay giữ nguyên chuỗi này; lật gương đảo toàn bộ.
fn dau_goc_quay(ring: &[PointMm]) -> Vec<i32> {
    let count = ring.len();
    (0..count)
        .map(|index| {
            let previous = ring[(index + count - 1) % count];
            let current = ring[index];
            let next = ring[(index + 1) % count];
            let cross = (current.x - previous.x) * (next.y - current.y)
                - (current.y - previous.y) * (next.x - current.x);
            if cross > 1e-9 {
                1
            } else if cross < -1e-9 {
                -1
            } else {
                0
            }
        })
        .collect()
}

/// Lật gương qua trục Y — dùng làm ca đối chứng để test không bị rỗng nghĩa.
fn lat_guong(ring: &[PointMm]) -> Vec<PointMm> {
    ring.iter().map(|p| PointMm::new(-p.x, p.y)).collect()
}

/// Bộ sinh số giả ngẫu nhiên có seed, dùng chính bộ trộn của engine để test tái lập được.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }
}

/// Polygon đơn (không tự cắt) hình ngôi sao quanh gốc: góc tăng dần, bán kính dương.
fn polygon_don_ngau_nhien(rng: &mut Rng, vertices: usize) -> Vec<PointMm> {
    let mut angles: Vec<f64> = (0..vertices).map(|_| rng.range(0.0, 360.0)).collect();
    angles.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // Giãn góc để không có hai đỉnh chập nhau.
    for (index, angle) in angles.iter_mut().enumerate() {
        *angle += index as f64 * 1e-3;
    }
    angles
        .into_iter()
        .map(|deg| {
            let radius = rng.range(6.0, 24.0);
            let rad = deg.to_radians();
            PointMm::new(radius * rad.cos(), radius * rad.sin())
        })
        .collect()
}

fn request_mau(parts: Vec<PartSpec>, default_rotation: RotationConstraint) -> MixedNestingRequest {
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
                right: 20.0,
                top: 30.0,
                bottom: 40.0,
            },
            max_sheets: 20,
        },
        gap_mm: 3.0,
        layout_intent: Default::default(),
        orientation_policy: OrientationPolicy {
            default_rotation,
            reflection: Reflection::Forbidden,
        },
        parts,
        job_id: None,
        ..MixedNestingRequest::default()
    }
}

fn part_mau(part_id: &str, outer: Vec<PointMm>) -> PartSpec {
    PartSpec {
        part_id: part_id.to_string(),
        quantity: 2,
        outer,
        holes: Vec::new(),
        rotation_constraint: RotationConstraint::Inherit,
        reference_point_mm: None,
        geometry_hash: None,
        source_revision: None,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Phép biến đổi ở góc bất kỳ
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn xoay_goc_bat_ky_khop_cong_thuc_tay() {
    let tol = tol();
    let point = PointMm::new(37.418_2, -12.906_5);
    for deg in GOC_NGHIEM_THU {
        let transform = RigidTransform::from_rotation_deg(deg, &tol).expect("góc hữu hạn");
        let canon = canonicalize_angle_deg(deg, &tol).unwrap();
        let (sin, cos) = canon.to_radians().sin_cos();
        let mong_doi = PointMm::new(cos * point.x - sin * point.y, sin * point.x + cos * point.y);
        let thuc = transform.apply(point);
        assert!(
            (thuc.x - mong_doi.x).abs() < 1e-12 && (thuc.y - mong_doi.y).abs() < 1e-12,
            "góc {deg}°: {thuc:?} != {mong_doi:?}"
        );
    }
}

#[test]
fn goc_360_do_dong_nhat_voi_0_do() {
    let tol = tol();
    let a = RigidTransform::from_rotation_deg(0.0, &tol).unwrap();
    let b = RigidTransform::from_rotation_deg(360.0, &tol).unwrap();
    let c = RigidTransform::from_rotation_deg(-360.0, &tol).unwrap();
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(b.rotation_deg(&tol), 0.0);
}

#[test]
fn rotation_deg_round_trip_giu_goc_khong_cardinal() {
    let tol = tol();
    for deg in [0.1_f64, 13.372849, 17.3, 33.7, 44.999, 89.999, 179.5, 359.9] {
        let quay_ve = RigidTransform::from_rotation_deg(deg, &tol)
            .unwrap()
            .rotation_deg(&tol);
        assert!(
            (quay_ve - deg).abs() < 1e-9,
            "round-trip góc {deg}° ra {quay_ve}°"
        );
    }
    // Góc âm và góc vượt vòng quy về đúng miền canonical.
    let am = RigidTransform::from_rotation_deg(-13.372849, &tol)
        .unwrap()
        .rotation_deg(&tol);
    assert!((am - 346.627151).abs() < 1e-9, "{am}");
}

#[test]
fn pivot_dung_la_diem_tham_chieu() {
    let tol = tol();
    // Pivot và tịnh tiến đều có phần lẻ, góc không-cardinal.
    let reference = PointMm::new(23.456_789, -7.891_234);
    for deg in GOC_NGHIEM_THU {
        let pose = Pose::new(deg, 123.456_789, 67.891_234);
        let transform =
            RigidTransform::from_pose_about_reference(&pose, reference, &tol).expect("pose hợp lệ");
        let anh = transform.apply(reference);
        assert!(
            (anh.x - pose.translate_x_mm).abs() < 1e-9
                && (anh.y - pose.translate_y_mm).abs() < 1e-9,
            "góc {deg}°: điểm tham chiếu phải rơi đúng (tx, ty), thực tế {anh:?}"
        );
    }
}

#[test]
fn tinh_tien_lien_tuc_khong_bi_snap() {
    let tol = tol();
    // Toạ độ cố ý không nằm trên lưới mm/pixel nào; có cả giá trị âm (ứng viên tạm).
    let mau = [
        (0.000_001_f64, -0.000_001_f64),
        (123.456_789_012_345, -67.891_234_567_89),
        (-45.678_9, 1_000.123_456_7),
    ];
    for (tx, ty) in mau {
        let pose = Pose::new(13.372_849, tx, ty);
        let transform =
            RigidTransform::from_pose_about_reference(&pose, PointMm::new(0.0, 0.0), &tol).unwrap();
        let translation = transform.translation_mm();
        assert_eq!(translation.x, tx, "tx bị đổi");
        assert_eq!(translation.y, ty, "ty bị đổi");

        // Ảnh của một điểm bất kỳ vẫn có phần lẻ — không hề bị làm tròn về mm.
        let anh = transform.apply(PointMm::new(7.5, 3.25));
        assert!(
            (anh.x - anh.x.round()).abs() > 1e-9 || (anh.y - anh.y.round()).abs() > 1e-9,
            "kết quả bị snap về số nguyên: {anh:?}"
        );
    }
}

#[test]
fn compose_bang_ap_lien_tiep_va_cong_goc() {
    let tol = tol();
    let inner = RigidTransform::from_pose_about_reference(
        &Pose::new(13.372_849, 5.5, -2.25),
        PointMm::new(1.5, 2.5),
        &tol,
    )
    .unwrap();
    let outer = RigidTransform::from_pose_about_reference(
        &Pose::new(44.999, -11.125, 8.875),
        PointMm::new(-3.25, 0.75),
        &tol,
    )
    .unwrap();
    let ghep = outer.compose(&inner);

    for point in [
        PointMm::new(0.0, 0.0),
        PointMm::new(37.418_2, -12.906_5),
        PointMm::new(-8.5, 19.25),
    ] {
        let tung_buoc = outer.apply(inner.apply(point));
        let mot_lan = ghep.apply(point);
        assert!(
            (tung_buoc.x - mot_lan.x).abs() < 1e-9 && (tung_buoc.y - mot_lan.y).abs() < 1e-9,
            "ghép sai tại {point:?}: {mot_lan:?} != {tung_buoc:?}"
        );
    }

    // Góc cộng dồn theo mod 360.
    let mong_doi = canonicalize_angle_deg(13.372_849 + 44.999, &tol).unwrap();
    assert!((ghep.rotation_deg(&tol) - mong_doi).abs() < 1e-9);
    // Ghép hai phép cứng vẫn cứng.
    ghep.to_affine().check_rigid().expect("ghép phải còn cứng");
}

#[test]
fn inverse_tra_ve_dong_nhat() {
    let tol = tol();
    for deg in GOC_NGHIEM_THU {
        let transform = RigidTransform::from_pose_about_reference(
            &Pose::new(deg, 123.456_789, -67.891_234),
            PointMm::new(12.5, -3.75),
            &tol,
        )
        .unwrap();
        let nghich = transform.inverse();
        for point in [PointMm::new(0.0, 0.0), PointMm::new(-40.125, 88.875)] {
            let quay_ve = nghich.apply(transform.apply(point));
            assert!(
                (quay_ve.x - point.x).abs() < 1e-9 && (quay_ve.y - point.y).abs() < 1e-9,
                "góc {deg}°: nghịch đảo sai, {quay_ve:?} != {point:?}"
            );
        }
    }
}

#[test]
fn round_trip_degree_radian_khong_doi_contour_ngoai_tolerance() {
    let tol = tol();
    let ring = hinh_l_bat_doi_xung();
    for deg in GOC_NGHIEM_THU {
        let xuoi = RigidTransform::from_rotation_deg(deg, &tol).unwrap();
        let nguoc = RigidTransform::from_rotation_deg(-deg, &tol).unwrap();
        let quay_ve = nguoc.apply_ring(&xuoi.apply_ring(&ring));
        for (goc, moi) in ring.iter().zip(quay_ve.iter()) {
            assert!(
                (goc.x - moi.x).abs() <= tol.linear_mm && (goc.y - moi.y).abs() <= tol.linear_mm,
                "góc {deg}°: contour lệch quá dung sai"
            );
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. Không có đường phản chiếu
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn moi_goc_tu_do_van_la_phep_xoay_khong_phai_lat_guong() {
    let tol = tol();
    let ring = hinh_l_bat_doi_xung();
    let dau_goc = dau_goc_quay(&ring);
    let dien_tich = signed_area_mm2(&ring);
    assert!(dien_tich > 0.0, "hình mẫu phải là CCW");
    assert!(
        dau_goc.contains(&-1),
        "hình mẫu phải có góc lõm, nếu không test không phân biệt được lật gương"
    );

    for deg in GOC_NGHIEM_THU {
        let pose = Pose::new(deg, 200.0, 300.5);
        let dat = place_ring_checked(&ring, &pose, PointMm::new(11.0, 13.0), &tol)
            .unwrap_or_else(|error| panic!("góc {deg}° bị từ chối: {error:?}"));

        // Chốt 1+2: ma trận trực chuẩn, det = +1.
        let affine =
            RigidTransform::from_pose_about_reference(&pose, PointMm::new(11.0, 13.0), &tol)
                .unwrap()
                .to_affine();
        affine.check_rigid().expect("phải là phép cứng");
        assert!((affine.determinant() - 1.0).abs() <= MATRIX_TOL);

        // Chốt 3: hướng và độ lớn signed-area giữ nguyên.
        check_ring_orientation_preserved(&ring, &dat).expect("phải bảo toàn hướng");
        assert!((signed_area_mm2(&dat) - dien_tich).abs() < 1e-9);
        assert_eq!(
            dau_goc_quay(&dat),
            dau_goc,
            "góc {deg}°: chuỗi lồi/lõm bị đổi"
        );
    }
}

#[test]
fn ca_doi_chung_lat_guong_bi_bat() {
    // Nếu ba chốt ở test trên là rỗng nghĩa thì test này sẽ đỏ.
    let ring = hinh_l_bat_doi_xung();
    let guong = lat_guong(&ring);
    assert_eq!(
        dau_goc_quay(&guong),
        dau_goc_quay(&ring)
            .into_iter()
            .map(|dau| -dau)
            .collect::<Vec<_>>(),
        "lật gương phải đảo toàn bộ chuỗi lồi/lõm"
    );
    let loi =
        check_ring_orientation_preserved(&ring, &guong).expect_err("lật gương phải bị từ chối");
    assert_eq!(loi.code(), "TRANSFORM_SIGNED_AREA_REVERSED");
}

#[test]
fn mirror_scale_shear_va_so_benh_bi_tu_choi() {
    // Lật gương qua trục Y: det = -1.
    let guong = AffineMm {
        m00: -1.0,
        m01: 0.0,
        m10: 0.0,
        m11: 1.0,
        tx: 0.0,
        ty: 0.0,
    };
    assert_eq!(
        guong
            .check_rigid()
            .expect_err("mirror phải bị từ chối")
            .code(),
        "TRANSFORM_REFLECTED"
    );
    assert!(guong.try_into_rigid().is_err());

    // Lật gương qua trục X.
    let guong_x = AffineMm {
        m11: -1.0,
        m00: 1.0,
        ..guong
    };
    assert_eq!(
        guong_x
            .check_rigid()
            .expect_err("mirror X phải bị từ chối")
            .code(),
        "TRANSFORM_REFLECTED"
    );

    // Phóng đều 2%: det > 0 nhưng chuẩn cột khác 1.
    let phong = AffineMm {
        m00: 1.02,
        m01: 0.0,
        m10: 0.0,
        m11: 1.02,
        tx: 0.0,
        ty: 0.0,
    };
    assert_eq!(
        phong
            .check_rigid()
            .expect_err("scale phải bị từ chối")
            .code(),
        "TRANSFORM_SCALE"
    );

    // Kéo xiên: det = 1 nhưng hai cột không vuông góc — bằng chứng "det > 0 là chưa đủ".
    let xien = AffineMm {
        m00: 1.0,
        m01: 0.1,
        m10: 0.0,
        m11: 1.0,
        tx: 0.0,
        ty: 0.0,
    };
    assert!(
        (xien.determinant() - 1.0).abs() < 1e-12,
        "ca này phải có det = 1"
    );
    assert_eq!(
        xien.check_rigid()
            .expect_err("shear phải bị từ chối")
            .code(),
        "TRANSFORM_SHEAR"
    );

    // Số không hữu hạn.
    let benh = AffineMm {
        m00: f64::NAN,
        ..phong
    };
    assert_eq!(
        benh.check_rigid().expect_err("NaN phải bị từ chối").code(),
        "TRANSFORM_NOT_FINITE"
    );

    // Ma trận suy biến (det = 0) cũng không phải phép cứng.
    let suy_bien = AffineMm {
        m00: 1.0,
        m01: 0.0,
        m10: 1.0,
        m11: 0.0,
        tx: 0.0,
        ty: 0.0,
    };
    assert_eq!(
        suy_bien
            .check_rigid()
            .expect_err("det = 0 phải bị từ chối")
            .code(),
        "TRANSFORM_REFLECTED"
    );
}

#[test]
fn matrix_ngoai_phai_dung_lai_tu_theta_va_kiem_parity() {
    let tol = tol();
    let pose = Pose::new(13.372_849, 123.456_789, 67.891_234);
    let reference = PointMm::new(9.5, -4.25);
    let dung_tu_theta = RigidTransform::from_pose_about_reference(&pose, reference, &tol)
        .unwrap()
        .to_affine();

    // Ma trận "artifact" khớp trong dung sai ⇒ parity đạt, và dựng lại được pose.
    let artifact = AffineMm {
        m00: dung_tu_theta.m00,
        m01: dung_tu_theta.m01,
        m10: dung_tu_theta.m10,
        m11: dung_tu_theta.m11,
        tx: dung_tu_theta.tx,
        ty: dung_tu_theta.ty,
    };
    assert!(artifact.matches(&dung_tu_theta));
    let quay_ve = artifact.try_into_rigid().expect("phải dựng lại được");
    assert!((quay_ve.rotation_deg(&tol) - 13.372_849).abs() < 1e-9);

    // Drift vượt dung sai ⇒ parity trượt, không được âm thầm nhận.
    let lech = AffineMm {
        tx: dung_tu_theta.tx + 1e-3,
        ..dung_tu_theta
    };
    assert!(!lech.matches(&dung_tu_theta), "drift phải bị phát hiện");
}

#[test]
fn place_ring_checked_tu_choi_du_lieu_benh() {
    let tol = tol();
    let ring = chu_nhat(10.0, 5.0);
    for pose in [
        Pose::new(f64::NAN, 0.0, 0.0),
        Pose::new(0.0, f64::INFINITY, 0.0),
        Pose::new(0.0, 0.0, f64::NEG_INFINITY),
    ] {
        assert_eq!(
            place_ring_checked(&ring, &pose, PointMm::new(0.0, 0.0), &tol),
            Err(RigidityViolation::NotFinite)
        );
    }
    assert_eq!(
        place_ring_checked(
            &ring,
            &Pose::new(0.0, 0.0, 0.0),
            PointMm::new(f64::NAN, 0.0),
            &tol
        ),
        Err(RigidityViolation::NotFinite)
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Ghép sourceToLocal → placementPose
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn export_ghep_source_to_local_va_van_la_phep_cung() {
    let tol = tol();
    let source_to_local = RigidTransform::from_pose_about_reference(
        &Pose::new(30.5, -12.375, 4.625),
        PointMm::new(2.5, 1.25),
        &tol,
    )
    .unwrap();
    let pose = Pose::new(13.372_849, 200.125, 305.875);
    let reference = PointMm::new(11.0, 13.0);

    let ghep = export_transform(&pose, reference, &source_to_local, &tol).expect("phải hợp lệ");
    let placement = RigidTransform::from_pose_about_reference(&pose, reference, &tol).unwrap();

    // Đúng thứ tự: sourceToLocal áp trước, placementPose áp sau.
    for point in [PointMm::new(0.0, 0.0), PointMm::new(41.25, -17.5)] {
        let tung_buoc = placement.apply(source_to_local.apply(point));
        let mot_lan = ghep.apply(point);
        assert!(
            (tung_buoc.x - mot_lan.x).abs() < 1e-9 && (tung_buoc.y - mot_lan.y).abs() < 1e-9,
            "ghép sai thứ tự tại {point:?}"
        );
    }
    ghep.to_affine().check_rigid().expect("ghép phải còn cứng");

    // Nội dung nguồn qua cả hai chặng vẫn giữ hướng và diện tích.
    let ring = hinh_l_bat_doi_xung();
    let ket_qua = ghep.apply_ring(&ring);
    check_ring_orientation_preserved(&ring, &ket_qua).expect("không được lật/phóng");

    // sourceToLocal chỉ có thể lấy từ cửa đã kiểm: ma trận phóng/lật không qua được.
    for benh in [
        AffineMm {
            m00: 1.02,
            m01: 0.0,
            m10: 0.0,
            m11: 1.02,
            tx: 0.0,
            ty: 0.0,
        },
        AffineMm {
            m00: -1.0,
            m01: 0.0,
            m10: 0.0,
            m11: 1.0,
            tx: 0.0,
            ty: 0.0,
        },
    ] {
        assert!(
            benh.try_into_rigid().is_err(),
            "matrix không cứng không được trở thành sourceToLocal"
        );
    }

    // Pose bệnh vẫn bị chặn ở đường export.
    assert_eq!(
        export_transform(
            &Pose::new(f64::NAN, 0.0, 0.0),
            reference,
            &source_to_local,
            &tol
        ),
        Err(RigidityViolation::NotFinite)
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  4. Canonical hoá miền góc
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn free_ra_mien_full_span_360() {
    let domain = resolve_rotation_domain(&RotationConstraint::Free, &tol()).unwrap();
    assert_eq!(domain, RotationDomain::Full);
    assert_eq!(domain.kind(), RotationDomainKind::Full);
    assert!(domain.is_continuous());
    assert_eq!(domain.total_span_deg(), 360.0);
    // Miền tự do KHÔNG có danh sách góc để quét — đó là bằng chứng không có angle step.
    assert!(domain.angles_deg().is_none());
    assert!(domain.arcs().is_none());
    // Và nó nhận mọi góc thực, kể cả góc không-cardinal lẻ tới 6 chữ số.
    for deg in [
        0.0,
        0.000_001,
        13.372_849,
        44.999,
        179.5,
        359.999_999,
        360.0,
        -77.7,
    ] {
        assert!(domain.contains(deg, &tol()), "miền tự do phải nhận {deg}°");
    }
    assert!(!domain.contains(f64::NAN, &tol()));
}

#[test]
fn fixed_ra_dung_mot_goc_canonical() {
    let domain = resolve_rotation_domain(
        &RotationConstraint::Fixed {
            angle_deg: 373.372_849,
        },
        &tol(),
    )
    .unwrap();
    assert_eq!(domain.kind(), RotationDomainKind::SingleAngle);
    assert!(!domain.is_continuous());
    assert_eq!(domain.total_span_deg(), 0.0);
    let angles = domain.angles_deg().unwrap();
    assert_eq!(angles.len(), 1);
    assert!((angles[0] - 13.372_849).abs() < 1e-9, "{}", angles[0]);
    assert!(domain.contains(13.372_849, &tol()));
    assert!(domain.contains(373.372_849, &tol()));
    assert!(!domain.contains(13.373, &tol()));
}

#[test]
fn discrete_canonical_sap_xep_va_gop_trung() {
    let domain = resolve_rotation_domain(
        &RotationConstraint::Discrete {
            angles_deg: vec![360.0, 90.0, 0.0, 450.0, -270.0, 90.000_000_000_1],
        },
        &tol(),
    )
    .unwrap();
    // 360→0, 450→90, -270→90, và góc lệch 1e-10 bị gộp vì trong dung sai.
    assert_eq!(domain.angles_deg().unwrap(), &[0.0, 90.0]);
    assert_eq!(domain.kind(), RotationDomainKind::DiscreteSet { count: 2 });
    assert!(!domain.is_continuous());
}

#[test]
fn discrete_nhan_dien_goc_o_cho_noi_0_360() {
    let domain = resolve_rotation_domain(
        &RotationConstraint::Discrete {
            angles_deg: vec![0.0],
        },
        &tol(),
    )
    .unwrap();
    assert!(domain.contains(0.0, &tol()));
    assert!(domain.contains(360.0, &tol()));
    assert!(domain.contains(359.999_999_999_9, &tol()));
    assert!(!domain.contains(359.9, &tol()));
    assert!(!domain.contains(0.5, &tol()));
}

#[test]
fn ranges_tach_tai_0_do_khi_wrap() {
    let domain = resolve_rotation_domain(
        &RotationConstraint::Ranges {
            arcs: vec![AngleArcDeg {
                start_deg: 350.0,
                sweep_deg: 20.0,
            }],
        },
        &tol(),
    )
    .unwrap();
    let arcs = domain.arcs().expect("phải là miền cung");
    assert_eq!(
        arcs,
        &[
            CanonicalArc {
                start_deg: 0.0,
                end_deg: 10.0
            },
            CanonicalArc {
                start_deg: 350.0,
                end_deg: 360.0
            },
        ]
    );
    assert!(domain.is_continuous());
    assert!((domain.total_span_deg() - 20.0).abs() < 1e-12);

    // Thuộc miền ở cả hai nhánh và ở đúng chỗ nối.
    for deg in [350.0, 355.5, 359.999_999_999_9, 360.0, 0.0, 5.25, 10.0] {
        assert!(domain.contains(deg, &tol()), "{deg}° phải thuộc miền");
    }
    for deg in [10.5, 180.0, 349.5] {
        assert!(
            !domain.contains(deg, &tol()),
            "{deg}° không được thuộc miền"
        );
    }
}

#[test]
fn ranges_gop_cung_chong_lan() {
    let domain = resolve_rotation_domain(
        &RotationConstraint::Ranges {
            arcs: vec![
                AngleArcDeg {
                    start_deg: 50.0,
                    sweep_deg: 100.0,
                },
                AngleArcDeg {
                    start_deg: 0.0,
                    sweep_deg: 100.0,
                },
            ],
        },
        &tol(),
    )
    .unwrap();
    assert_eq!(
        domain.arcs().unwrap(),
        &[CanonicalArc {
            start_deg: 0.0,
            end_deg: 150.0
        }]
    );
    assert!((domain.total_span_deg() - 150.0).abs() < 1e-12);
}

#[test]
fn ranges_phu_kin_vong_thu_ve_full() {
    // Hai nửa vòng ghép lại.
    let hai_nua = resolve_rotation_domain(
        &RotationConstraint::Ranges {
            arcs: vec![
                AngleArcDeg {
                    start_deg: 0.0,
                    sweep_deg: 180.0,
                },
                AngleArcDeg {
                    start_deg: 180.0,
                    sweep_deg: 180.0,
                },
            ],
        },
        &tol(),
    )
    .unwrap();
    assert_eq!(hai_nua, RotationDomain::Full);

    // Một cung trọn vòng, bắt đầu ở góc bất kỳ.
    let tron_vong = resolve_rotation_domain(
        &RotationConstraint::Ranges {
            arcs: vec![AngleArcDeg {
                start_deg: 45.0,
                sweep_deg: 360.0,
            }],
        },
        &tol(),
    )
    .unwrap();
    assert_eq!(tron_vong, RotationDomain::Full);
    assert_eq!(tron_vong.total_span_deg(), 360.0);
}

#[test]
fn mien_rong_sweep_sai_va_inherit_bi_tu_choi() {
    assert_eq!(
        resolve_rotation_domain(&RotationConstraint::Inherit, &tol()),
        Err(OrientationError::InheritNotResolved)
    );
    assert_eq!(
        resolve_rotation_domain(
            &RotationConstraint::Discrete {
                angles_deg: Vec::new()
            },
            &tol()
        ),
        Err(OrientationError::EmptyDomain)
    );
    assert_eq!(
        resolve_rotation_domain(&RotationConstraint::Ranges { arcs: Vec::new() }, &tol()),
        Err(OrientationError::EmptyDomain)
    );
    for sweep in [0.0, -5.0, 360.5, 720.0] {
        assert_eq!(
            resolve_rotation_domain(
                &RotationConstraint::Ranges {
                    arcs: vec![AngleArcDeg {
                        start_deg: 10.0,
                        sweep_deg: sweep
                    }]
                },
                &tol()
            ),
            Err(OrientationError::ArcSweepOutOfRange),
            "sweep {sweep} phải bị từ chối"
        );
    }
    assert_eq!(
        resolve_rotation_domain(
            &RotationConstraint::Fixed {
                angle_deg: f64::NAN
            },
            &tol()
        ),
        Err(OrientationError::NonFiniteAngle)
    );
    // Mã lỗi ổn định cho backend map 422.
    assert_eq!(
        OrientationError::EmptyDomain.code(),
        "ROTATION_DOMAIN_EMPTY"
    );
}

#[test]
fn phan_giai_theo_tung_part_va_khong_phu_thuoc_profile() {
    let mut request = request_mau(
        vec![
            part_mau("part-a", chu_nhat(80.0, 40.0)),
            part_mau("part-b", chu_nhat(30.0, 30.0)),
            part_mau("part-c", chu_nhat(20.0, 60.0)),
        ],
        RotationConstraint::preset_half_turn(),
    );
    request.parts[1].rotation_constraint = RotationConstraint::Free;
    request.parts[2].rotation_constraint = RotationConstraint::Fixed { angle_deg: 17.3 };

    for profile in [Profile::Fast, Profile::Balanced, Profile::Tight] {
        request.profile = profile;
        // part-a kế thừa preset 0/180 của job.
        let a = resolve_part_domain(&request, &request.parts[0], &tol()).unwrap();
        assert_eq!(a.angles_deg().unwrap(), &[0.0, 180.0]);
        // part-b override về tự do — profile nào cũng vẫn full 360°.
        let b = resolve_part_domain(&request, &request.parts[1], &tol()).unwrap();
        assert_eq!(b, RotationDomain::Full);
        assert_eq!(b.total_span_deg(), 360.0);
        // part-c khoá đúng một góc không-cardinal.
        let c = resolve_part_domain(&request, &request.parts[2], &tol()).unwrap();
        assert!((c.angles_deg().unwrap()[0] - 17.3).abs() < 1e-9);
    }
}

#[test]
fn khoang_cach_goc_tren_duong_tron() {
    assert!((circular_distance_deg(359.9999, 0.0001) - 0.0002).abs() < 1e-9);
    assert!((circular_distance_deg(0.0, 180.0) - 180.0).abs() < 1e-9);
    assert!((circular_distance_deg(10.0, 350.0) - 20.0).abs() < 1e-9);
    assert!(circular_distance_deg(45.0, 45.0) < 1e-12);
    // Luôn thuộc [0, 180].
    for (a, b) in [(0.0, 359.0), (271.0, 13.0), (100.0, 280.0)] {
        let d = circular_distance_deg(a, b);
        assert!((0.0..=180.0).contains(&d), "{a},{b} → {d}");
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  5. Chuẩn hoá contour
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn chuan_hoa_chieu_vong_ve_ccw_va_lo_ve_cw() {
    let tol = tol();
    // Đầu vào CW.
    let cw = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(0.0, 40.0),
        PointMm::new(80.0, 40.0),
        PointMm::new(80.0, 0.0),
    ];
    assert!(signed_area_mm2(&cw) < 0.0, "fixture phải là CW");
    let ngoai = normalize_ring(&cw, "outer", Winding::Ccw, &tol).unwrap();
    assert!(
        signed_area_mm2(&ngoai) > 0.0,
        "contour ngoài phải thành CCW"
    );
    assert!((signed_area_mm2(&ngoai) - 3_200.0).abs() < 1e-9);

    let lo = normalize_ring(&chu_nhat(10.0, 10.0), "hole", Winding::Cw, &tol).unwrap();
    assert!(signed_area_mm2(&lo) < 0.0, "lỗ phải thành CW");

    // Đảo chiều là đổi tham số hoá: cùng tập điểm, không phải lật gương.
    let mut tap_goc: Vec<(u64, u64)> = cw.iter().map(|p| (p.x.to_bits(), p.y.to_bits())).collect();
    let mut tap_moi: Vec<(u64, u64)> = ngoai
        .iter()
        .map(|p| (p.x.to_bits(), p.y.to_bits()))
        .collect();
    tap_goc.sort_unstable();
    tap_moi.sort_unstable();
    assert_eq!(tap_goc, tap_moi, "đảo chiều không được đổi toạ độ đỉnh nào");
}

#[test]
fn bo_dinh_dong_vong_trung_lap_va_thang_hang() {
    let tol = tol();
    let ban = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(0.0, 0.0),  // trùng liền kề
        PointMm::new(40.0, 0.0), // thẳng hàng với đỉnh sau
        PointMm::new(80.0, 0.0),
        PointMm::new(80.0, 40.0),
        PointMm::new(40.0, 40.0), // thẳng hàng
        PointMm::new(0.0, 40.0),
        PointMm::new(0.0, 0.0), // đóng vòng lặp lại đỉnh đầu
    ];
    let sach = normalize_ring(&ban, "outer", Winding::Ccw, &tol).unwrap();
    assert_eq!(sach.len(), 4, "phải còn đúng 4 góc: {sach:?}");
    assert!((signed_area_mm2(&sach) - 3_200.0).abs() < 1e-9);
}

#[test]
fn bo_mui_gai_suy_bien() {
    let tol = tol();
    // Mũi gai: đi ra (90,20) rồi quay đúng về chỗ cũ — không tạo diện tích.
    let co_gai = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(80.0, 0.0),
        PointMm::new(80.0, 20.0),
        PointMm::new(90.0, 20.0),
        PointMm::new(80.0, 20.0),
        PointMm::new(80.0, 40.0),
        PointMm::new(0.0, 40.0),
    ];
    let sach = normalize_ring(&co_gai, "outer", Winding::Ccw, &tol).unwrap();
    assert!(
        sach.iter().all(|p| p.x <= 80.0 + tol.linear_mm),
        "mũi gai phải bị loại: {sach:?}"
    );
    assert!((signed_area_mm2(&sach) - 3_200.0).abs() < 1e-6);
}

#[test]
fn tu_choi_vong_suy_bien_va_dien_tich_gan_0() {
    let tol = tol();
    // Dưới 3 đỉnh.
    let hai_dinh = vec![PointMm::new(0.0, 0.0), PointMm::new(10.0, 0.0)];
    assert_eq!(
        normalize_ring(&hai_dinh, "outer", Winding::Ccw, &tol).unwrap_err()[0].code,
        NormalizeErrorCode::RingDegenerate
    );

    // Ba đỉnh nhưng thẳng hàng ⇒ sau khi làm sạch còn dưới 3.
    let thang_hang = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(5.0, 0.0),
        PointMm::new(10.0, 0.0),
    ];
    assert_eq!(
        normalize_ring(&thang_hang, "outer", Winding::Ccw, &tol).unwrap_err()[0].code,
        NormalizeErrorCode::RingDegenerate
    );

    // Tam giác mỏng hơn dung sai ở mọi chỗ ⇒ diện tích dưới ngưỡng.
    let sliver = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(100.0, 0.0),
        PointMm::new(50.0, 1e-9),
    ];
    let loi = normalize_ring(&sliver, "outer", Winding::Ccw, &tol).unwrap_err();
    assert!(
        matches!(
            loi[0].code,
            NormalizeErrorCode::RingZeroArea | NormalizeErrorCode::RingDegenerate
        ),
        "sliver phải bị từ chối, thực tế {:?}",
        loi[0].code
    );

    // Toạ độ không hữu hạn.
    let benh = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(f64::NAN, 0.0),
        PointMm::new(10.0, 10.0),
    ];
    assert_eq!(
        normalize_ring(&benh, "outer", Winding::Ccw, &tol).unwrap_err()[0].code,
        NormalizeErrorCode::RingNotFinite
    );
}

#[test]
fn tu_choi_vong_tu_cat() {
    let tol = tol();
    // Nơ (bowtie) lệch để diện tích KHÔNG triệt tiêu — nếu không, test sẽ xanh vì lý do sai.
    let no = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(10.0, 0.0),
        PointMm::new(0.0, 10.0),
        PointMm::new(20.0, 20.0),
    ];
    assert!(
        signed_area_mm2(&no).abs() > 1.0,
        "fixture phải có diện tích khác 0 để không bị chặn vì lý do khác"
    );
    assert!(find_self_intersection(&no, &tol).is_some());
    assert_eq!(
        normalize_ring(&no, "outer", Winding::Ccw, &tol).unwrap_err()[0].code,
        NormalizeErrorCode::RingSelfIntersecting
    );

    // Tự chạm: một đỉnh nằm trên cạnh không kề nó.
    let tu_cham = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(10.0, 0.0),
        PointMm::new(10.0, 10.0),
        PointMm::new(5.0, 0.0),
        PointMm::new(0.0, 10.0),
    ];
    assert!(find_self_intersection(&tu_cham, &tol).is_some());
    assert_eq!(
        normalize_ring(&tu_cham, "outer", Winding::Ccw, &tol).unwrap_err()[0].code,
        NormalizeErrorCode::RingSelfIntersecting
    );
}

#[test]
fn nhan_polygon_lom_l_t_u_va_moi_chieu() {
    let tol = tol();
    let hinh_t = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(60.0, 0.0),
        PointMm::new(60.0, 20.0),
        PointMm::new(40.0, 20.0),
        PointMm::new(40.0, 50.0),
        PointMm::new(20.0, 50.0),
        PointMm::new(20.0, 20.0),
        PointMm::new(0.0, 20.0),
    ];
    let hinh_u = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(60.0, 0.0),
        PointMm::new(60.0, 50.0),
        PointMm::new(45.0, 50.0),
        PointMm::new(45.0, 18.0),
        PointMm::new(15.0, 18.0),
        PointMm::new(15.0, 50.0),
        PointMm::new(0.0, 50.0),
    ];
    for (ten, ring) in [("L", hinh_l_bat_doi_xung()), ("T", hinh_t), ("U", hinh_u)] {
        assert!(
            find_self_intersection(&ring, &tol).is_none(),
            "hình {ten} phải là polygon đơn"
        );
        let ccw = normalize_ring(&ring, "outer", Winding::Ccw, &tol)
            .unwrap_or_else(|e| panic!("hình {ten} bị từ chối: {e:?}"));
        assert!(signed_area_mm2(&ccw) > 0.0);
        // Đảo chiều đầu vào phải cho cùng diện tích và cùng số đỉnh.
        let mut nguoc = ring.clone();
        nguoc.reverse();
        let ccw2 = normalize_ring(&nguoc, "outer", Winding::Ccw, &tol).unwrap();
        assert_eq!(ccw.len(), ccw2.len(), "hình {ten}");
        assert!((signed_area_mm2(&ccw) - signed_area_mm2(&ccw2)).abs() < 1e-9);
    }
}

#[test]
fn diem_tham_chieu_on_dinh_va_khong_phai_goc_bbox() {
    let ring = hinh_l_bat_doi_xung();
    let pivot = derive_reference_point(&ring).expect("phải suy được pivot");
    let bounds = BoundsMm::from_ring(&ring).unwrap();

    // Không phải góc trái dưới bbox, cũng không phải tâm bbox.
    assert!(
        (pivot.x - bounds.min_x).abs() > 1.0 && (pivot.y - bounds.min_y).abs() > 1.0,
        "pivot không được là góc bbox: {pivot:?}"
    );
    let tam = bounds.center();
    assert!(
        (pivot.x - tam.x).abs() > 0.5 || (pivot.y - tam.y).abs() > 0.5,
        "với hình lõm, trọng tâm phải khác tâm bbox: {pivot:?} vs {tam:?}"
    );

    // Bất biến với chỉ số đỉnh bắt đầu.
    for xoay_vong in 1..ring.len() {
        let mut khac = ring[xoay_vong..].to_vec();
        khac.extend_from_slice(&ring[..xoay_vong]);
        let pivot2 = derive_reference_point(&khac).unwrap();
        assert!(
            (pivot.x - pivot2.x).abs() < 1e-9 && (pivot.y - pivot2.y).abs() < 1e-9,
            "pivot đổi khi xoay chỉ số đỉnh {xoay_vong}"
        );
    }

    // Bất biến với chiều vòng.
    let mut nguoc = ring.clone();
    nguoc.reverse();
    let pivot3 = derive_reference_point(&nguoc).unwrap();
    assert!((pivot.x - pivot3.x).abs() < 1e-9 && (pivot.y - pivot3.y).abs() < 1e-9);

    assert_eq!(REFERENCE_POINT_RULE_VERSION, 1);
}

#[test]
fn diem_tham_chieu_dong_bien_voi_phep_xoay() {
    let tol = tol();
    let ring = hinh_l_bat_doi_xung();
    let pivot = derive_reference_point(&ring).unwrap();
    for deg in GOC_NGHIEM_THU {
        let transform = RigidTransform::from_rotation_deg(deg, &tol).unwrap();
        let pivot_sau = derive_reference_point(&transform.apply_ring(&ring)).unwrap();
        let mong_doi = transform.apply(pivot);
        assert!(
            (pivot_sau.x - mong_doi.x).abs() < 1e-9 && (pivot_sau.y - mong_doi.y).abs() < 1e-9,
            "góc {deg}°: centroid(R·p) phải bằng R·centroid(p)"
        );
    }
}

#[test]
fn pivot_server_owned_duoc_uu_tien_hon_suy_dien() {
    let pivot_backend = PointMm::new(12.345_678, -9.876_543);
    let mut part = part_mau("part-a", hinh_l_bat_doi_xung());
    part.reference_point_mm = Some(pivot_backend);
    let request = request_mau(vec![part], RotationConstraint::Free);
    let normalized = normalize_request(&request).expect("phải hợp lệ");
    assert_eq!(normalized.parts[0].reference_point_mm, pivot_backend);

    // Pivot server-owned bệnh thì bị từ chối, không âm thầm suy lại. Ở đường
    // `normalize_request`, lớp hợp đồng bắt trước lớp hình học — nên đây là lỗi
    // Contract/NOT_FINITE, không phải lỗi hình học.
    let mut part_benh = part_mau("part-a", hinh_l_bat_doi_xung());
    part_benh.reference_point_mm = Some(PointMm::new(0.0, f64::INFINITY));
    let loi = normalize_request(&request_mau(vec![part_benh], RotationConstraint::Free))
        .expect_err("phải bị từ chối");
    match &loi {
        NormalizeFailure::Contract(errors) => {
            assert!(errors
                .items()
                .iter()
                .any(|e| e.code.as_str() == "NOT_FINITE"));
            assert!(errors
                .items()
                .iter()
                .any(|e| e.path.contains("referencePointMm")));
        }
        khac => panic!("phải là lỗi hợp đồng, thực tế {khac:?}"),
    }
    // Không tồn tại đường nào để pivot bệnh lọt vào kết quả đã chuẩn hoá.
    assert!(!matches!(loi, NormalizeFailure::Geometry(_)));
}

#[test]
fn khong_suy_duoc_pivot_tu_vong_suy_bien() {
    // Đường suy pivot tự bảo vệ: dưới 3 đỉnh hoặc diện tích triệt tiêu ⇒ None,
    // không trả về một điểm bừa.
    assert!(derive_reference_point(&[]).is_none());
    assert!(derive_reference_point(&[PointMm::new(0.0, 0.0)]).is_none());
    assert!(derive_reference_point(&[PointMm::new(0.0, 0.0), PointMm::new(1.0, 1.0)]).is_none());
    // Vòng "nơ" cân đối có diện tích có dấu triệt tiêu đúng bằng 0.
    let no_can = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(10.0, 0.0),
        PointMm::new(0.0, 10.0),
        PointMm::new(10.0, 10.0),
    ];
    assert_eq!(signed_area_mm2(&no_can), 0.0, "fixture phải có diện tích 0");
    assert!(derive_reference_point(&no_can).is_none());
}

// ═════════════════════════════════════════════════════════════════════════════
//  6. normalize_request — ghép ba module
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn vung_dung_duoc_tru_le_dung_chieu_truc_y() {
    let request = request_mau(
        vec![part_mau("part-a", chu_nhat(80.0, 40.0))],
        RotationConstraint::Free,
    );
    let normalized = normalize_request(&request).expect("phải hợp lệ");
    let usable = normalized.sheet.usable;
    // Lề: left 10, right 20, top 30, bottom 40 — cố ý bất đối xứng để bắt lỗi đảo chiều.
    assert_eq!(usable.min_x, 10.0);
    assert_eq!(usable.max_x, 680.0);
    assert_eq!(
        usable.min_y, 40.0,
        "lề DƯỚI phải là min_y (trục Y hướng lên)"
    );
    assert_eq!(usable.max_y, 970.0, "lề TRÊN phải trừ vào max_y");
    assert_eq!(usable.width_mm(), 670.0);
    assert_eq!(usable.height_mm(), 930.0);
    assert_eq!(normalized.normalize_rule_version, NORMALIZE_RULE_VERSION);
    assert_eq!(normalized.gap_mm, 3.0);
    assert!(normalized.time_budget_ms.is_none());
    assert!(normalized.parts[0].placement_zone.is_none());
    assert_eq!(
        normalized.placement_bounds_for(&normalized.parts[0]),
        normalized.sheet.usable,
        "free gang phải dùng toàn vùng đặt hữu hiệu của tờ"
    );
}

#[test]
fn normalize_request_gan_zone_theo_part_id_va_giu_clearance_mep_to() {
    let mut request = request_mau(
        vec![
            part_mau("part-a", chu_nhat(80.0, 40.0)),
            part_mau("part-b", hinh_l_bat_doi_xung()),
        ],
        RotationConstraint::Free,
    );
    request.gap_mm = 0.0;
    request.production_contract = Some(ProductionContractV1 {
        schema_version: MIXED_NESTING_PRODUCTION_SCHEMA_VERSION,
        request_revision: 1,
        input_hash: format!("sha256:{}", "a".repeat(64)),
        layout_fingerprint: format!("sha256:{}", "b".repeat(64)),
        alignment: LayoutAlignment::Center,
        grouping_intent: GroupingIntent::MaximizeArea,
        // Cố ý ngược thứ tự parts để bắt implementation map theo index.
        placement_zones: vec![
            PartPlacementZoneSpec {
                part_id: "part-b".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 10.0,
                    min_y_mm: 40.0,
                    max_x_mm: 680.0,
                    max_y_mm: 505.0,
                },
            },
            PartPlacementZoneSpec {
                part_id: "part-a".to_string(),
                bounds: AxisAlignedBoundsSpec {
                    min_x_mm: 10.0,
                    min_y_mm: 505.0,
                    max_x_mm: 680.0,
                    max_y_mm: 970.0,
                },
            },
        ],
        clearance: ClearanceSpec {
            part_to_part: SheetAxisClearanceMm {
                x_mm: 3.0,
                y_mm: 4.0,
            },
            part_to_sheet_edge: SheetAxisClearanceMm {
                x_mm: 4.0,
                y_mm: 5.0,
            },
            part_to_obstacle: SheetAxisClearanceMm::zero(),
        },
        fixed_obstacles: Vec::new(),
    });

    let normalized = normalize_request(&request).expect("partition production phải chuẩn hoá được");
    let production = normalized.production_contract.as_ref().unwrap();
    assert_eq!(production.grouping_intent, GroupingIntent::MaximizeArea);
    assert_eq!(normalized.gap_mm, 5.0, "gap bảo thủ phải giữ hypot(3, 4)");

    let part_a = &normalized.parts[0];
    let part_b = &normalized.parts[1];
    assert_eq!(
        part_a.placement_zone,
        Some(BoundsMm {
            min_x: 10.0,
            min_y: 505.0,
            max_x: 680.0,
            max_y: 970.0,
        })
    );
    assert_eq!(
        part_b.placement_zone,
        Some(BoundsMm {
            min_x: 10.0,
            min_y: 40.0,
            max_x: 680.0,
            max_y: 505.0,
        })
    );
    assert_eq!(
        normalized.placement_bounds_for(part_a),
        BoundsMm {
            min_x: 14.0,
            min_y: 505.0,
            max_x: 676.0,
            max_y: 965.0,
        },
        "dải trên chỉ trừ clearance ở các mép ngoài"
    );
    assert_eq!(
        normalized.placement_bounds_for(part_b),
        BoundsMm {
            min_x: 14.0,
            min_y: 45.0,
            max_x: 676.0,
            max_y: 505.0,
        },
        "biên chung y=505 không được tạo khe giả"
    );
}

#[test]
fn normalize_request_dung_dien_tich_va_mien_goc_cho_tung_part() {
    let mut request = request_mau(
        vec![
            part_mau("part-a", chu_nhat(80.0, 40.0)),
            part_mau("part-b", hinh_l_bat_doi_xung()),
        ],
        RotationConstraint::Free,
    );
    request.parts[0].quantity = 12;
    request.parts[1].quantity = 3;
    request.parts[1].rotation_constraint = RotationConstraint::preset_cardinal();
    // Lỗ khoét: MVP coi là vật liệu đặc nên không trừ khỏi diện tích hiệu dụng.
    request.parts[0].holes = vec![chu_nhat(10.0, 10.0)];

    let normalized = normalize_request(&request).expect("phải hợp lệ");
    assert_eq!(normalized.total_instances(), 15);

    let a = &normalized.parts[0];
    assert!((a.outer_area_mm2 - 3_200.0).abs() < 1e-9);
    assert!((a.holes_area_mm2 - 100.0).abs() < 1e-9);
    assert_eq!(a.effective_area_mm2(), a.outer_area_mm2, "MVP: lỗ là đặc");
    assert!((a.total_area_mm2() - 38_400.0).abs() < 1e-6);
    assert_eq!(a.rotation_domain, RotationDomain::Full);
    assert!(signed_area_mm2(&a.holes[0]) < 0.0, "lỗ phải là CW");

    let b = &normalized.parts[1];
    assert_eq!(
        b.rotation_domain.angles_deg().unwrap(),
        &[0.0, 90.0, 180.0, 270.0]
    );
    // Hình L: 60×18 + 22×29 = 1080 + 638 = 1718 mm².
    assert!(
        (b.outer_area_mm2 - 1_718.0).abs() < 1e-9,
        "{}",
        b.outer_area_mm2
    );
    assert_eq!(b.reference_point_rule_version, REFERENCE_POINT_RULE_VERSION);

    assert!((normalized.total_part_area_mm2() - (38_400.0 + 5_154.0)).abs() < 1e-6);
}

#[test]
fn normalize_request_tach_bach_loi_hop_dong_va_loi_hinh_hoc() {
    // Sai hợp đồng ⇒ nhánh Contract, chưa cần chạm hình học.
    let mut sai_hop_dong = request_mau(
        vec![part_mau("part-a", chu_nhat(80.0, 40.0))],
        RotationConstraint::Free,
    );
    sai_hop_dong.protocol_version = 9;
    match normalize_request(&sai_hop_dong) {
        Err(NormalizeFailure::Contract(errors)) => {
            assert!(errors
                .items()
                .iter()
                .any(|e| e.code.as_str() == "PROTOCOL_VERSION_UNSUPPORTED"));
        }
        khac => panic!("phải là lỗi hợp đồng, thực tế {khac:?}"),
    }

    // Đúng hợp đồng nhưng hình học xấu ⇒ nhánh Geometry, gom hết lỗi của mọi part.
    let no = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(10.0, 0.0),
        PointMm::new(0.0, 10.0),
        PointMm::new(20.0, 20.0),
    ];
    let sai_hinh_hoc = request_mau(
        vec![
            part_mau("part-a", no.clone()),
            part_mau("part-b", chu_nhat(80.0, 40.0)),
            part_mau("part-c", no),
        ],
        RotationConstraint::Free,
    );
    match normalize_request(&sai_hinh_hoc) {
        Err(NormalizeFailure::Geometry(errors)) => {
            assert_eq!(
                errors.len(),
                2,
                "phải gom lỗi của cả hai part xấu: {errors:?}"
            );
            assert!(errors[0].path.starts_with("parts[0]"));
            assert!(errors[1].path.starts_with("parts[2]"));
            assert!(errors
                .iter()
                .all(|e| e.code == NormalizeErrorCode::RingSelfIntersecting));
        }
        khac => panic!("phải là lỗi hình học, thực tế {khac:?}"),
    }
}

#[test]
fn thong_bao_loi_khong_lo_toa_do_khach_hang() {
    // Toạ độ "nhận dạng được" — nếu nó xuất hiện trong thông báo là đã rò dữ liệu mẫu.
    let no = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(1_234.567_89, 0.0),
        PointMm::new(0.0, 987.654_32),
        PointMm::new(2_468.0, 1_975.0),
    ];
    let loi = normalize_request(&request_mau(
        vec![part_mau("part-a", no)],
        RotationConstraint::Free,
    ))
    .expect_err("phải bị từ chối");
    let text = loi.to_string();
    for dau_vet in ["1234.5", "987.65", "2468", "1975"] {
        assert!(
            !text.contains(dau_vet),
            "thông báo lỗi rò toạ độ '{dau_vet}': {text}"
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  7. Bằng chứng free-angle không phải trang trí
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn co_hinh_chi_vua_to_o_goc_khong_cardinal() {
    let tol = tol();
    // Vùng dùng được vuông 100×100; nan giấy 130×10.
    // Cardinal: bbox 130×10 hoặc 10×130 ⇒ KHÔNG vừa.
    // Quanh 45°: bbox (130+10)/√2 ≈ 98.99 ⇒ VỪA.
    let usable_w = 100.0;
    let usable_h = 100.0;
    let ring = chu_nhat(130.0, 10.0);

    let vua_o_goc = |deg: f64| -> bool {
        let placed = RigidTransform::from_rotation_deg(deg, &tol)
            .unwrap()
            .apply_ring(&ring);
        let bounds = BoundsMm::from_ring(&placed).unwrap();
        bounds.width_mm() <= usable_w + tol.linear_mm
            && bounds.height_mm() <= usable_h + tol.linear_mm
    };

    // Bốn góc cardinal đều KHÔNG vừa — nếu một góc vừa thì fixture vô nghĩa.
    for cardinal in [0.0, 90.0, 180.0, 270.0, 360.0] {
        assert!(!vua_o_goc(cardinal), "{cardinal}° không được vừa");
    }
    // Quanh 45° thì vừa, kể cả các góc lẻ.
    for deg in [44.5, 45.0, 45.5, 134.6, 225.2, 315.4] {
        assert!(vua_o_goc(deg), "{deg}° phải vừa");
    }
    // Ra khỏi cửa sổ hẹp quanh 45° là hết vừa — bề rộng bbox của hình chữ nhật đạt
    // cực tiểu đúng ở 45°, nên đây là ca chỉ giải được bằng góc không-cardinal.
    for deg in [30.0, 40.0, 44.0, 46.0, 50.0, 60.0] {
        assert!(!vua_o_goc(deg), "{deg}° không được vừa");
    }

    // Miền tự do chấp nhận đúng những góc đó; preset cardinal thì không.
    let tu_do = resolve_rotation_domain(&RotationConstraint::Free, &tol).unwrap();
    let cardinal = resolve_rotation_domain(&RotationConstraint::preset_cardinal(), &tol).unwrap();
    assert!(tu_do.contains(45.0, &tol));
    assert!(!cardinal.contains(45.0, &tol));
    assert!(!cardinal.contains(44.5, &tol));
}

#[test]
fn cua_so_goc_kha_thi_qua_hep_cho_buoc_goc_co_dinh() {
    let tol = tol();
    // Cùng fixture 130×10 trong vùng 100×100. Ở đây ta ĐO độ rộng miền góc khả thi.
    // Việc quét mịn dưới đây là phép ĐO của test, không phải cách solver làm việc —
    // solver dùng critical-angle proposal rồi refine liên tục (P3b).
    let usable = 100.0;
    let ring = chu_nhat(130.0, 10.0);
    let vua_o_goc = |deg: f64| -> bool {
        let placed = RigidTransform::from_rotation_deg(deg, &tol)
            .unwrap()
            .apply_ring(&ring);
        let bounds = BoundsMm::from_ring(&placed).unwrap();
        bounds.width_mm() <= usable + tol.linear_mm && bounds.height_mm() <= usable + tol.linear_mm
    };

    let buoc = 0.005_f64;
    let so_buoc = (360.0 / buoc) as usize;
    let mut tong_do_rong = 0.0_f64;
    let mut dai_nhat = 0.0_f64;
    let mut dang_chay = 0.0_f64;
    for index in 0..so_buoc {
        if vua_o_goc(index as f64 * buoc) {
            tong_do_rong += buoc;
            dang_chay += buoc;
            dai_nhat = dai_nhat.max(dang_chay);
        } else {
            dang_chay = 0.0;
        }
    }

    assert!(
        tong_do_rong > 0.0,
        "phải có miền khả thi, nếu không fixture sai"
    );
    assert!(
        tong_do_rong < 8.0,
        "miền khả thi phải rất hẹp, đo được {tong_do_rong}°"
    );
    assert!(
        dai_nhat < 2.0,
        "mỗi dải khả thi phải hẹp hơn 2°, đo được {dai_nhat}°"
    );

    // Hệ quả thật: một lưới góc cố định chỉ trúng khi PHA của nó tình cờ khớp dải khả
    // thi. Lưới 4° và lưới 5° lệch pha nửa bước đều không tìm ra gì; lưới 5° pha 0
    // trúng chỉ vì 45 chia hết cho 5 — không ai bảo đảm được sự trùng hợp đó.
    let dem_tren_luoi = |buoc: f64, pha: f64| -> usize {
        let so_goc = (360.0 / buoc) as usize;
        (0..so_goc)
            .filter(|k| vua_o_goc(pha + *k as f64 * buoc))
            .count()
    };
    assert_eq!(dem_tren_luoi(4.0, 0.0), 0, "lưới 4° bỏ sót hoàn toàn");
    assert_eq!(
        dem_tren_luoi(5.0, 2.5),
        0,
        "lưới 5° lệch pha bỏ sót hoàn toàn"
    );
    assert_eq!(dem_tren_luoi(10.0, 0.0), 0, "lưới 10° bỏ sót hoàn toàn");

    // Miền liên tục thì luôn chứa nghiệm, và góc đó lẻ tới nhiều chữ số.
    assert!(vua_o_goc(45.123_456));
    assert!(resolve_rotation_domain(&RotationConstraint::Free, &tol)
        .unwrap()
        .contains(45.123_456, &tol));
}

// ═════════════════════════════════════════════════════════════════════════════
//  8. Property test có seed
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn property_pose_ngau_nhien_luon_la_phep_cung() {
    let tol = tol();
    let mut rng = Rng::new(20_260_826);
    let mut so_ca_khong_cardinal = 0;

    for lan in 0..400 {
        let vertices = 3 + (rng.next_u64() % 10) as usize;
        let ring = polygon_don_ngau_nhien(&mut rng, vertices);
        let Ok(sach) = normalize_ring(&ring, "outer", Winding::Ccw, &tol) else {
            // Polygon ngẫu nhiên có thể suy biến; đó là hành vi đúng, bỏ qua ca này.
            continue;
        };

        let deg = rng.range(-1_000.0, 1_000.0);
        let pose = Pose::new(deg, rng.range(-500.0, 500.0), rng.range(-500.0, 500.0));
        let pivot = derive_reference_point(&sach).expect("polygon sạch phải có pivot");

        let dat = place_ring_checked(&sach, &pose, pivot, &tol)
            .unwrap_or_else(|e| panic!("lần {lan} góc {deg}° bị từ chối: {e:?}"));

        let transform = RigidTransform::from_pose_about_reference(&pose, pivot, &tol).unwrap();
        let affine = transform.to_affine();

        // Rᵀ R ≈ I, det ≈ +1.
        affine.check_rigid().expect("phải là phép cứng");
        assert!((affine.determinant() - 1.0).abs() <= MATRIX_TOL);
        assert!(affine.column_dot().abs() <= MATRIX_TOL);
        let (norm0, norm1) = affine.column_norms();
        assert!((norm0 - 1.0).abs() <= MATRIX_TOL && (norm1 - 1.0).abs() <= MATRIX_TOL);

        // Bảo toàn hướng và độ lớn diện tích.
        check_ring_orientation_preserved(&sach, &dat).expect("phải bảo toàn hướng");
        assert_eq!(dau_goc_quay(&dat), dau_goc_quay(&sach), "lần {lan}");

        // Góc canonical thuộc [0, 360) và miền tự do luôn nhận nó.
        let canon = transform.rotation_deg(&tol);
        assert!((0.0..360.0).contains(&canon), "lần {lan}: {canon}");
        assert!(RotationDomain::Full.contains(canon, &tol));
        if (canon % 90.0).abs() > 1e-6 {
            so_ca_khong_cardinal += 1;
        }

        // Pivot rơi đúng vào (tx, ty), và nghịch đảo quay về chỗ cũ.
        let anh_pivot = transform.apply(pivot);
        assert!(
            (anh_pivot.x - pose.translate_x_mm).abs() < 1e-9
                && (anh_pivot.y - pose.translate_y_mm).abs() < 1e-9
        );
        let nghich = transform.inverse();
        for (goc, moi) in sach.iter().zip(dat.iter()) {
            let quay_ve = nghich.apply(*moi);
            assert!(
                (quay_ve.x - goc.x).abs() < 1e-6 && (quay_ve.y - goc.y).abs() < 1e-6,
                "lần {lan}: nghịch đảo lệch"
            );
        }
    }

    assert!(
        so_ca_khong_cardinal > 300,
        "property test phải phủ chủ yếu góc không-cardinal, chỉ có {so_ca_khong_cardinal}"
    );
}

#[test]
fn property_mien_cung_ngau_nhien_contains_dung_o_bien() {
    let tol = tol();
    let mut rng = Rng::new(0xC0FF_EE12_3456_789A);
    for lan in 0..300 {
        let start = rng.range(0.0, 360.0);
        let sweep = rng.range(0.5, 359.0);
        let domain = resolve_rotation_domain(
            &RotationConstraint::Ranges {
                arcs: vec![AngleArcDeg {
                    start_deg: start,
                    sweep_deg: sweep,
                }],
            },
            &tol,
        )
        .unwrap_or_else(|e| panic!("lần {lan}: {e:?}"));

        // Tổng độ mở giữ nguyên sau khi tách tại 0°.
        assert!(
            (domain.total_span_deg() - sweep).abs() < 1e-9,
            "lần {lan}: span {} != {sweep}",
            domain.total_span_deg()
        );

        // Trong cung: đầu, giữa, cuối đều thuộc miền.
        for phan in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let deg = start + sweep * phan;
            assert!(
                domain.contains(deg, &tol),
                "lần {lan}: {deg}° phải thuộc [{start}, {start}+{sweep}]"
            );
        }
        // Ngoài cung: lùi/vượt một khoảng rõ rệt thì không thuộc.
        let ngoai = sweep.min(360.0 - sweep) / 4.0;
        if ngoai > 1e-3 {
            assert!(!domain.contains(start - ngoai, &tol), "lần {lan}");
            assert!(!domain.contains(start + sweep + ngoai, &tol), "lần {lan}");
        }
    }
}

#[test]
fn property_chuan_hoa_giu_dien_tich_va_polygon_don() {
    let tol = tol();
    let mut rng = Rng::new(0x5EED_0000_1111_2222);
    let mut so_ca_nhan = 0;
    for _ in 0..300 {
        let vertices = 4 + (rng.next_u64() % 12) as usize;
        let ring = polygon_don_ngau_nhien(&mut rng, vertices);
        let dien_tich_goc = signed_area_mm2(&ring).abs();
        let Ok(sach) = normalize_ring(&ring, "outer", Winding::Ccw, &tol) else {
            continue;
        };
        so_ca_nhan += 1;
        // Làm sạch chỉ bỏ đỉnh không mang thông tin ⇒ diện tích không đổi đáng kể.
        assert!(
            (signed_area_mm2(&sach).abs() - dien_tich_goc).abs() <= 1e-6 * dien_tich_goc.max(1.0),
            "diện tích đổi sau chuẩn hoá"
        );
        assert!(signed_area_mm2(&sach) > 0.0, "phải là CCW");
        assert!(sach.len() >= 3);
        assert!(sach.len() <= ring.len());
        assert!(find_self_intersection(&sach, &tol).is_none());
    }
    assert!(
        so_ca_nhan > 200,
        "property test nhận quá ít ca: {so_ca_nhan}"
    );
}
