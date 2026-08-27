//! Test kernel, hình học và va chạm của `mixed_nesting` — phase P2b.
//!
//! Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.1, §11.2, §16.1.
//! Bằng chứng chọn kernel: `docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md`.
//!
//! Bộ test này phải chứng minh:
//!
//! 1. Boolean và offset đúng ở **góc không-cardinal**, trên polygon lõm/sliver/near-contact.
//! 2. Offset **tách** và **sập** đúng ngưỡng lý thuyết.
//! 3. Minkowski lồi thay thế là **chính xác**, kiểm bằng oracle bao lồi độc lập.
//! 4. Phân rã lồi cho số mảnh theo số đỉnh lõm, **không** phải `n−2` như tam giác hoá.
//! 5. Va chạm và khoảng hở phân biệt được chồng / chạm biên / gần chạm.
//! 6. **Không tồn tại lời gọi** `minkowski_sum`/`minkowski_diff` của crate trong code.

use imposition_core::mixed_nesting::collision::{
    bounds_gap_mm, bounds_may_touch, judge_pair, min_distance_mm, point_to_segment_mm,
    ring_within_bounds, rings_overlap, segment_distance_mm, segments_properly_cross,
    signed_margin_to_bounds_mm, PairVerdict,
};
use imposition_core::mixed_nesting::geometry::{
    convex_decompose, is_convex_ring, point_in_ring, reflex_vertex_indices, triangulate_indices,
};
use imposition_core::mixed_nesting::kernel::{
    difference, intersection, minkowski_convex, net_area_mm2, offset, union, union_many,
    KernelError, OffsetJoin, OffsetStyle, KERNEL_FIXED_POINT_SCALE, KERNEL_MAX_ABS_MM,
    KERNEL_VERSION,
};
use imposition_core::mixed_nesting::model::{PointMm, Pose, Tolerance};
use imposition_core::mixed_nesting::normalize::BoundsMm;
use imposition_core::mixed_nesting::transform::{place_ring_checked, signed_area_mm2};

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

fn tri(side: f64) -> Vec<PointMm> {
    vec![pt(0.0, 0.0), pt(side, 0.0), pt(side * 0.5, side * 0.866)]
}

fn regular(n: usize, r: f64) -> Vec<PointMm> {
    (0..n)
        .map(|k| {
            let t = k as f64 / n as f64 * std::f64::consts::TAU;
            pt(r * t.cos(), r * t.sin())
        })
        .collect()
}

/// Hình L lõm, 1 đỉnh lõm, diện tích 1718 mm².
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

/// Chữ C hõm sâu, 2 đỉnh lõm.
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

/// Quả tạ: hai đầu 30×30 nối bằng cổ rộng đúng 2 mm, 4 đỉnh lõm.
fn dumbbell() -> Vec<PointMm> {
    vec![
        pt(0.0, 0.0),
        pt(30.0, 0.0),
        pt(30.0, 14.0),
        pt(50.0, 14.0),
        pt(50.0, 0.0),
        pt(80.0, 0.0),
        pt(80.0, 30.0),
        pt(50.0, 30.0),
        pt(50.0, 16.0),
        pt(30.0, 16.0),
        pt(30.0, 30.0),
        pt(0.0, 30.0),
    ]
}

/// Oracle độc lập: tổng Minkowski của hai hình LỒI là bao lồi của mọi tổng cặp đỉnh.
fn hull_area_mm2(a: &[PointMm], b: &[PointMm]) -> f64 {
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(a.len() * b.len());
    for pa in a {
        for pb in b {
            pts.push((pa.x + pb.x, pa.y + pb.y));
        }
    }
    pts.sort_by(|p, q| p.partial_cmp(q).unwrap());
    pts.dedup();
    let cross = |o: (f64, f64), x: (f64, f64), y: (f64, f64)| {
        (x.0 - o.0) * (y.1 - o.1) - (x.1 - o.1) * (y.0 - o.0)
    };
    let mut lower: Vec<(f64, f64)> = Vec::new();
    for p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], *p) <= 0.0 {
            lower.pop();
        }
        lower.push(*p);
    }
    let mut upper: Vec<(f64, f64)> = Vec::new();
    for p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], *p) <= 0.0 {
            upper.pop();
        }
        upper.push(*p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    let ring: Vec<PointMm> = lower.into_iter().map(|(x, y)| pt(x, y)).collect();
    signed_area_mm2(&ring).abs()
}

/// Xoay contour quanh gốc một góc bất kỳ, dùng chính đường pose đã kiểm ở P2a.
fn rotate(ring: &[PointMm], deg: f64) -> Vec<PointMm> {
    place_ring_checked(ring, &Pose::new(deg, 0.0, 0.0), pt(0.0, 0.0), &tol())
        .expect("xoay phải hợp lệ")
}

fn total_abs_area(rings: &[Vec<PointMm>]) -> f64 {
    rings.iter().map(|r| signed_area_mm2(r).abs()).sum()
}

/// Một vòng dưới dạng slice cho các API kernel nhận nhiều vòng — không nhân bản dữ liệu.
fn one(ring: &Vec<PointMm>) -> &[Vec<PointMm>] {
    std::slice::from_ref(ring)
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Chốt cứng: không gọi Minkowski của crate
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn khong_goi_minkowski_cua_crate() {
    // Spike đo được `minkowski_sum`/`minkowski_diff` của clipper2-rust SAI trên 5/6 ca
    // lồi ở cả bản Rust lẫn bản C++ gốc. Chốt này chặn việc người sau "tiện tay" dùng
    // lại. Nguồn được nhúng lúc biên dịch nên không thể lách bằng cách sửa file khác.
    const SOURCES: [(&str, &str); 8] = [
        ("mod.rs", include_str!("../src/mixed_nesting/mod.rs")),
        ("model.rs", include_str!("../src/mixed_nesting/model.rs")),
        (
            "control.rs",
            include_str!("../src/mixed_nesting/control.rs"),
        ),
        (
            "transform.rs",
            include_str!("../src/mixed_nesting/transform.rs"),
        ),
        (
            "orientation.rs",
            include_str!("../src/mixed_nesting/orientation.rs"),
        ),
        (
            "normalize.rs",
            include_str!("../src/mixed_nesting/normalize.rs"),
        ),
        ("kernel.rs", include_str!("../src/mixed_nesting/kernel.rs")),
        (
            "geometry.rs",
            include_str!("../src/mixed_nesting/geometry.rs"),
        ),
    ];
    for (name, source) in SOURCES {
        for (line_number, line) in source.lines().enumerate() {
            let code = line.trim_start();
            // Bỏ dòng chú thích: tài liệu được phép nhắc tên phép đã cấm.
            if code.starts_with("//") {
                continue;
            }
            for forbidden in ["minkowski_sum", "minkowski_diff"] {
                assert!(
                    !code.contains(forbidden),
                    "{name}:{}: cấm gọi '{forbidden}' của clipper2-rust — phép này đã đo là SAI, \
                     dùng kernel::minkowski_convex thay thế",
                    line_number + 1
                );
            }
        }
    }
}

#[test]
fn collision_khong_phu_thuoc_kernel_hay_nfp() {
    // §11.6: quan toà phải độc lập với NFP và với cache của solver. Nếu collision.rs
    // import kernel thì một lỗi trong kernel có thể tự bào chữa ở bước validate.
    let source = include_str!("../src/mixed_nesting/collision.rs");
    for line in source.lines() {
        let code = line.trim_start();
        if code.starts_with("//") {
            continue;
        }
        if code.starts_with("use ") {
            for forbidden in ["kernel", "clipper2", "nfp", "spatial"] {
                assert!(
                    !code.contains(forbidden),
                    "collision.rs không được import '{forbidden}': {code}"
                );
            }
        }
    }
}

#[test]
fn khong_import_solver_cu_bi_cam() {
    const SOURCES: [(&str, &str); 3] = [
        ("kernel.rs", include_str!("../src/mixed_nesting/kernel.rs")),
        (
            "geometry.rs",
            include_str!("../src/mixed_nesting/geometry.rs"),
        ),
        (
            "collision.rs",
            include_str!("../src/mixed_nesting/collision.rs"),
        ),
    ];
    for (name, source) in SOURCES {
        for line in source.lines() {
            let code = line.trim_start();
            if code.starts_with("//") || !code.starts_with("use ") {
                continue;
            }
            for forbidden in [
                "crate::nfp",
                "crate::sticker",
                "crate::shape",
                "crate::orchestrator",
                "crate::grid",
                "crate::assembler",
                "super::super",
            ] {
                assert!(
                    !code.contains(forbidden),
                    "{name} không được import '{forbidden}': {code}"
                );
            }
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. Kernel: version, thang, trần toạ độ
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn thang_fixed_point_khop_dung_sai_hop_dong() {
    assert_eq!(KERNEL_VERSION, 1);
    // Thang phải đủ mịn để không mất độ phân giải mà P1 đã hứa.
    assert_eq!(1.0 / KERNEL_FIXED_POINT_SCALE, tol().linear_mm);
    assert_eq!(KERNEL_MAX_ABS_MM, 8_000.0);
}

#[test]
fn reject_toa_do_ngoai_tran_va_khong_huu_han() {
    let style = OffsetStyle::v1_round();
    let qua_xa = rect_at(KERNEL_MAX_ABS_MM + 1.0, 0.0, 10.0, 10.0);
    assert_eq!(
        offset(one(&qua_xa), 1.0, style),
        Err(KernelError::CoordinateOutOfRange)
    );
    assert_eq!(
        union(&[qua_xa], &[rect(10.0, 10.0)]),
        Err(KernelError::CoordinateOutOfRange)
    );

    let benh = vec![pt(0.0, 0.0), pt(f64::NAN, 0.0), pt(10.0, 10.0)];
    assert_eq!(offset(one(&benh), 1.0, style), Err(KernelError::NotFinite));
    assert_eq!(
        union(&[benh], &[rect(10.0, 10.0)]),
        Err(KernelError::NotFinite)
    );

    // Vòng suy biến.
    assert_eq!(
        offset(&[vec![pt(0.0, 0.0), pt(1.0, 0.0)]], 1.0, style),
        Err(KernelError::DegenerateInput)
    );
    assert_eq!(offset(&[], 1.0, style), Err(KernelError::DegenerateInput));

    // Tham số bo góc sai miền.
    let xau = OffsetStyle {
        miter_limit: 0.5,
        ..OffsetStyle::v1_miter()
    };
    assert_eq!(
        offset(&[rect(10.0, 10.0)], 1.0, xau),
        Err(KernelError::InvalidOffsetStyle)
    );

    // Delta không hữu hạn.
    assert_eq!(
        offset(&[rect(10.0, 10.0)], f64::INFINITY, style),
        Err(KernelError::NotFinite)
    );
}

#[test]
fn boolean_va_offset_dung_o_bien_toa_do() {
    // Chứng minh trần 8.000 mm là trần ĐÃ ĐO, không phải giả định: nếu số học tràn thì
    // diện tích sẽ lệch.
    let far = KERNEL_MAX_ABS_MM - 50.0;
    for goc in [0.0_f64, 13.372_849, 44.999] {
        let a = rotate(&rect(40.0, 30.0), goc)
            .into_iter()
            .map(|p| pt(p.x + far, p.y - far))
            .collect::<Vec<_>>();
        let mong_doi = 1_200.0;

        let u = union(one(&a), one(&a)).expect("union ở biên phải chạy");
        assert!(
            (total_abs_area(&u) - mong_doi).abs() < 1e-3,
            "góc {goc}°: union ở biên toạ độ lệch, {} != {mong_doi}",
            total_abs_area(&u)
        );

        let o = offset(one(&a), 1.5, OffsetStyle::v1_round()).expect("offset ở biên");
        assert!(
            total_abs_area(&o) > mong_doi,
            "góc {goc}°: offset ra phải làm hình lớn hơn"
        );

        let i = intersection(one(&a), one(&a)).expect("giao ở biên");
        assert!((total_abs_area(&i) - mong_doi).abs() < 1e-3);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. Boolean trên fixture khó, ở góc không-cardinal
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn boolean_dung_tren_fixture_kho() {
    let cases: Vec<(&str, Vec<PointMm>, Vec<PointMm>, f64)> = vec![
        (
            "rời nhau",
            rect(10.0, 10.0),
            rect_at(20.0, 0.0, 10.0, 10.0),
            200.0,
        ),
        (
            "chồng một nửa",
            rect(10.0, 10.0),
            rect_at(5.0, 0.0, 10.0, 10.0),
            150.0,
        ),
        (
            "tangency cạnh-cạnh",
            rect(10.0, 10.0),
            rect_at(10.0, 0.0, 10.0, 10.0),
            200.0,
        ),
        (
            "tangency đỉnh-đỉnh",
            rect(10.0, 10.0),
            rect_at(10.0, 10.0, 10.0, 10.0),
            200.0,
        ),
        (
            "near-overlap hở 1e-5",
            rect(10.0, 10.0),
            rect_at(10.000_01, 0.0, 10.0, 10.0),
            200.0,
        ),
        (
            "near-overlap chồng 1e-5",
            rect(10.0, 10.0),
            rect_at(9.999_99, 0.0, 10.0, 10.0),
            199.999_9,
        ),
        (
            "lõm L + lấp ô lõm",
            shape_l(),
            rect_at(22.0, 18.0, 38.0, 29.0),
            2820.0,
        ),
        (
            "sliver 100×0,002",
            vec![
                pt(0.0, 0.0),
                pt(100.0, 0.0),
                pt(100.0, 0.002),
                pt(0.0, 0.002),
            ],
            rect(100.0, 10.0),
            1000.0,
        ),
    ];
    for (name, a, b, mong_doi) in &cases {
        let u = union(one(a), one(b)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let dien_tich = net_area_mm2(&u).abs();
        assert!(
            (dien_tich - mong_doi).abs() < 1e-3 * mong_doi.max(1.0),
            "{name}: union = {dien_tich}, kỳ vọng {mong_doi}"
        );
    }
}

#[test]
fn boolean_dung_o_goc_khong_cardinal() {
    // Xoay cả hai hình cùng một góc lẻ: hợp/giao/hiệu phải bất biến về diện tích.
    let a = shape_l();
    let b = rect_at(22.0, 18.0, 38.0, 29.0);
    let u0 = net_area_mm2(&union(one(&a), one(&b)).unwrap()).abs();
    let i0 = net_area_mm2(&intersection(one(&a), one(&b)).unwrap()).abs();
    let d0 = net_area_mm2(&difference(one(&a), one(&b)).unwrap()).abs();

    for goc in [0.1_f64, 13.372_849, 44.999, 89.999, 179.5, 359.9] {
        let ra = rotate(&a, goc);
        let rb = rotate(&b, goc);
        let u = net_area_mm2(&union(one(&ra), one(&rb)).unwrap()).abs();
        let i = net_area_mm2(&intersection(one(&ra), one(&rb)).unwrap()).abs();
        let d = net_area_mm2(&difference(&[ra], &[rb]).unwrap()).abs();
        // Dung sai theo lượng tử fixed-point nhân chu vi hình: xoay làm đỉnh rơi vào ô
        // lưới 1e-6 mm khác, nên diện tích lệch cỡ đó là đúng, không phải lỗi.
        assert!((u - u0).abs() < 1e-3, "góc {goc}°: union {u} != {u0}");
        assert!((i - i0).abs() < 1e-3, "góc {goc}°: giao {i} != {i0}");
        assert!((d - d0).abs() < 1e-3, "góc {goc}°: hiệu {d} != {d0}");
    }
}

#[test]
fn hieu_sinh_lo_dung_dau_dien_tich() {
    // Chữ nhật lớn trừ ô nhỏ nằm hẳn bên trong ⇒ 1 vòng ngoài + 1 lỗ.
    let out = difference(&[rect(100.0, 100.0)], &[rect_at(30.0, 30.0, 20.0, 20.0)]).unwrap();
    assert_eq!(out.len(), 2, "phải có vòng ngoài và lỗ: {out:?}");
    let duong: Vec<f64> = out
        .iter()
        .map(|r| signed_area_mm2(r))
        .filter(|a| *a > 0.0)
        .collect();
    let am: Vec<f64> = out
        .iter()
        .map(|r| signed_area_mm2(r))
        .filter(|a| *a < 0.0)
        .collect();
    assert_eq!(duong.len(), 1, "đúng một vòng ngoài");
    assert_eq!(am.len(), 1, "đúng một lỗ");
    assert!((duong[0] - 10_000.0).abs() < 1e-6);
    assert!((am[0] + 400.0).abs() < 1e-6);
    // Diện tích thực = ngoài trừ lỗ.
    assert!((net_area_mm2(&out) - 9_600.0).abs() < 1e-6);
}

#[test]
fn union_many_gop_nhieu_manh() {
    // Đây là phép mà nfp.rs (P2c) dùng để gộp các cặp Minkowski lồi.
    let manh = vec![
        rect_at(0.0, 0.0, 10.0, 10.0),
        rect_at(9.0, 0.0, 10.0, 10.0),
        rect_at(18.0, 0.0, 10.0, 10.0),
    ];
    let out = union_many(&manh).unwrap();
    assert_eq!(out.len(), 1, "ba mảnh chồng nhau phải gộp thành một");
    assert!((net_area_mm2(&out).abs() - 280.0).abs() < 1e-6);
}

// ═════════════════════════════════════════════════════════════════════════════
//  4. Offset: tách, sập, và bo góc tường minh
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn offset_tach_dung_nua_be_rong_co() {
    // Cổ quả tạ rộng đúng 2 mm ⇒ ngưỡng tách lý thuyết là 1,0 mm.
    let style = OffsetStyle::v1_round();
    let db = vec![dumbbell()];
    for (delta, so_vong_mong_doi) in [
        (-0.5_f64, 1usize),
        (-0.9, 1),
        (-1.0, 2),
        (-1.1, 2),
        (-2.0, 2),
        (-8.0, 2),
    ] {
        let out = offset(&db, delta, style).unwrap();
        assert_eq!(
            out.len(),
            so_vong_mong_doi,
            "delta {delta} mm: số vòng {} != {so_vong_mong_doi}",
            out.len()
        );
    }
    // Co quá mức ⇒ sập về rỗng, không trả vòng rác.
    assert!(offset(&db, -20.0, style).unwrap().is_empty());
}

#[test]
fn offset_sap_dung_ban_kinh_noi_tiep() {
    let style = OffsetStyle::v1_round();
    let small = vec![rect(4.0, 4.0)]; // bán kính nội tiếp đúng 2 mm
    assert_eq!(offset(&small, -1.0, style).unwrap().len(), 1);
    assert_eq!(offset(&small, -1.9, style).unwrap().len(), 1);
    assert!(
        offset(&small, -2.0, style).unwrap().is_empty(),
        "sập đúng tại bán kính nội tiếp"
    );
    assert!(offset(&small, -2.1, style).unwrap().is_empty());
    assert!(offset(&small, -3.0, style).unwrap().is_empty());
}

#[test]
fn offset_ra_lam_lon_offset_vao_lam_nho_va_don_dieu() {
    let style = OffsetStyle::v1_round();
    let base = vec![shape_l()];
    let goc = 1_718.0;
    let mut truoc = 0.0;
    for delta in [-1.5_f64, -0.5, 0.5, 1.5, 3.0] {
        let dien_tich = total_abs_area(&offset(&base, delta, style).unwrap());
        assert!(
            dien_tich > truoc,
            "delta {delta}: diện tích phải tăng đơn điệu theo delta"
        );
        truoc = dien_tich;
        if delta < 0.0 {
            assert!(dien_tich < goc, "delta {delta}: co vào phải nhỏ hơn gốc");
        } else {
            assert!(dien_tich > goc, "delta {delta}: nở ra phải lớn hơn gốc");
        }
    }
    // delta = 0 giữ nguyên.
    let zero = offset(&base, 0.0, style).unwrap();
    assert!((total_abs_area(&zero) - goc).abs() < 1e-6);
}

#[test]
fn bo_goc_phai_khai_tuong_minh_va_co_version() {
    // Chốt rủi ro §9.1 của spike: không có đường nào gọi offset bằng mặc định thư viện.
    let round = OffsetStyle::v1_round();
    let miter = OffsetStyle::v1_miter();
    assert_eq!(round.version, KERNEL_VERSION);
    assert_eq!(miter.version, KERNEL_VERSION);
    assert_eq!(round.join, OffsetJoin::Round);
    assert_eq!(miter.join, OffsetJoin::Miter);
    assert!(round.arc_tolerance_mm > 0.0 && round.arc_tolerance_mm <= 0.01);

    // Hai kiểu bo góc cho kết quả KHÁC nhau ở góc lồi nhọn — đó là lý do phải khai rõ.
    let nhon = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(2.0, 6.0)]];
    let a = total_abs_area(&offset(&nhon, 2.0, round).unwrap());
    let b = total_abs_area(&offset(&nhon, 2.0, miter).unwrap());
    assert!(
        (a - b).abs() > 1e-3,
        "bo tròn và vát nhọn phải khác nhau ở góc nhọn: {a} vs {b}"
    );
    // Miter nở nhiều hơn ⇒ nếu dùng làm clearance thì loại oan layout hợp lệ.
    assert!(b > a, "vát nhọn phải nở nhiều hơn bo tròn: {b} vs {a}");
}

#[test]
fn offset_gap_nua_la_duong_dung_cho_clearance() {
    // Nở mỗi part gap/2 rồi kiểm chồng, tương đương kiểm khoảng cách >= gap.
    let gap = 3.0_f64;
    let style = OffsetStyle::v1_round();
    let a = rect(20.0, 20.0);
    for (dx, chong_mong_doi) in [(21.0_f64, true), (23.0, false), (25.0, false)] {
        let b = rect_at(dx, 0.0, 20.0, 20.0);
        let ea = offset(one(&a), gap / 2.0, style).unwrap();
        let eb = offset(one(&b), gap / 2.0, style).unwrap();
        let chong = rings_overlap(&ea[0], &eb[0], &tol());
        assert_eq!(
            chong, chong_mong_doi,
            "dx {dx}: nở gap/2 rồi kiểm chồng phải cho {chong_mong_doi}"
        );
        // Và quan toà độc lập phải đồng ý.
        let phan_quyet = judge_pair(&a, &b, gap, &tol());
        assert_eq!(
            !phan_quyet.is_ok(),
            chong_mong_doi,
            "dx {dx}: quan toà phải khớp với đường offset"
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  5. Minkowski lồi thay thế
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn minkowski_loi_chinh_xac_so_voi_oracle_bao_loi() {
    let cases: Vec<(&str, Vec<PointMm>, Vec<PointMm>)> = vec![
        ("rect80×40 ⊕ rect30×20", rect(80.0, 40.0), rect(30.0, 20.0)),
        ("rect10×10 ⊕ rect10×10", rect(10.0, 10.0), rect(10.0, 10.0)),
        ("rect80×40 ⊕ tri20", rect(80.0, 40.0), tri(20.0)),
        ("tri30 ⊕ tri20", tri(30.0), tri(20.0)),
        ("bát giác r20 ⊕ rect10×6", regular(8, 20.0), rect(10.0, 6.0)),
        ("poly16 r30 ⊕ poly8 r5", regular(16, 30.0), regular(8, 5.0)),
        ("poly32 r25 ⊕ tri8", regular(32, 25.0), tri(8.0)),
    ];
    for (name, a, b) in &cases {
        let m = minkowski_convex(a, b).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let tinh = signed_area_mm2(&m).abs();
        let oracle = hull_area_mm2(a, b);
        assert!(
            (tinh - oracle).abs() < 1e-9 * oracle.max(1.0),
            "{name}: {tinh} != oracle {oracle}"
        );
        // Kết quả phải lồi và số đỉnh tối giản (không phình như phép của crate).
        assert!(is_convex_ring(&m, &tol()), "{name}: kết quả phải lồi");
        assert!(
            m.len() <= a.len() + b.len(),
            "{name}: {} đỉnh, không được vượt m+n = {}",
            m.len(),
            a.len() + b.len()
        );
        // Không có lỗ: một vòng duy nhất, diện tích dương sau khi chuẩn chiều.
        assert!(tinh > 0.0);
    }
}

#[test]
fn minkowski_loi_dung_o_goc_khong_cardinal() {
    // NFP phụ thuộc góc xoay của part động, nên phép này phải đúng ở mọi góc.
    let a = rect(80.0, 40.0);
    for goc in [0.1_f64, 13.372_849, 44.999, 89.999, 179.5, 359.9] {
        let b = rotate(&rect(30.0, 20.0), goc);
        let m = minkowski_convex(&a, &b).unwrap();
        let oracle = hull_area_mm2(&a, &b);
        assert!(
            (signed_area_mm2(&m).abs() - oracle).abs() < 1e-6 * oracle,
            "góc {goc}°: lệch oracle"
        );
        assert!(is_convex_ring(&m, &tol()));
    }
}

#[test]
fn minkowski_loi_tu_choi_hinh_lom() {
    // Cố ý không tự chữa: dùng phép lồi cho hình lõm sẽ cho kết quả sai âm thầm.
    assert_eq!(
        minkowski_convex(&shape_l(), &rect(10.0, 10.0)),
        Err(KernelError::NotConvex)
    );
    assert_eq!(
        minkowski_convex(&rect(10.0, 10.0), &shape_c()),
        Err(KernelError::NotConvex)
    );
    assert_eq!(
        minkowski_convex(&[pt(0.0, 0.0), pt(1.0, 0.0)], &rect(10.0, 10.0)),
        Err(KernelError::DegenerateInput)
    );
}

#[test]
fn nfp_loi_bang_minkowski_voi_hinh_am() {
    // NFP(A,B) = A ⊕ (−B). Hai chữ nhật ⇒ chữ nhật tổng kích thước.
    let a = rect(80.0, 40.0);
    let b = rect(30.0, 20.0);
    let neg_b: Vec<PointMm> = b.iter().map(|p| pt(-p.x, -p.y)).collect();
    let nfp = minkowski_convex(&a, &neg_b).unwrap();
    assert!((signed_area_mm2(&nfp).abs() - 6_600.0).abs() < 1e-9);
    let bounds = BoundsMm::from_ring(&nfp).unwrap();
    assert!((bounds.width_mm() - 110.0).abs() < 1e-9);
    assert!((bounds.height_mm() - 60.0).abs() < 1e-9);
    assert!((bounds.min_x + 30.0).abs() < 1e-9);
    assert!((bounds.min_y + 20.0).abs() < 1e-9);
}

// ═════════════════════════════════════════════════════════════════════════════
//  6. Phân rã lồi — ràng buộc §11.4 của spike
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn nhan_dien_loi_va_dinh_lom() {
    assert!(is_convex_ring(&rect(10.0, 5.0), &tol()));
    assert!(is_convex_ring(&tri(10.0), &tol()));
    assert!(is_convex_ring(&regular(16, 20.0), &tol()));
    assert!(!is_convex_ring(&shape_l(), &tol()));
    assert!(!is_convex_ring(&shape_c(), &tol()));
    assert!(!is_convex_ring(&dumbbell(), &tol()));

    assert_eq!(reflex_vertex_indices(&rect(10.0, 5.0), &tol()).len(), 0);
    assert_eq!(reflex_vertex_indices(&shape_l(), &tol()).len(), 1);
    assert_eq!(reflex_vertex_indices(&shape_c(), &tol()).len(), 2);
    assert_eq!(reflex_vertex_indices(&dumbbell(), &tol()).len(), 4);

    // Chiều vòng không được đổi kết luận.
    let mut nguoc = shape_c();
    nguoc.reverse();
    assert_eq!(reflex_vertex_indices(&nguoc, &tol()).len(), 2);
    assert!(!is_convex_ring(&nguoc, &tol()));
}

#[test]
fn phan_ra_loi_theo_so_dinh_lom_khong_phai_n_tru_2() {
    // Đây là ràng buộc chặn từ spike §11.4: tam giác hoá cho n−2 mảnh và làm NFP
    // lõm–lõm 50×50 mất 298 ms; phân rã lồi phải cho ~r+1 mảnh.
    for (name, ring) in [
        ("L (1 lõm)", shape_l()),
        ("C (2 lõm)", shape_c()),
        ("quả tạ (4 lõm)", dumbbell()),
    ] {
        let reflex = reflex_vertex_indices(&ring, &tol()).len();
        let tam_giac = triangulate_indices(&ring, &tol()).len();
        let manh = convex_decompose(&ring, &tol());

        assert_eq!(
            tam_giac,
            ring.len() - 2,
            "{name}: tam giác hoá phải cho n−2"
        );
        assert!(
            manh.len() <= reflex + 1,
            "{name}: phân rã lồi cho {} mảnh, phải ≤ r+1 = {}",
            manh.len(),
            reflex + 1
        );
        assert!(
            manh.len() < tam_giac,
            "{name}: phân rã lồi ({}) phải ít mảnh hơn tam giác hoá ({tam_giac})",
            manh.len()
        );

        // Mọi mảnh phải lồi, CCW, diện tích dương.
        for (index, piece) in manh.iter().enumerate() {
            assert!(piece.len() >= 3, "{name} mảnh {index}: dưới 3 đỉnh");
            assert!(
                is_convex_ring(piece, &tol()),
                "{name} mảnh {index}: không lồi"
            );
            assert!(
                signed_area_mm2(piece) > 0.0,
                "{name} mảnh {index}: phải CCW"
            );
        }
        // Tổng diện tích các mảnh phải bằng diện tích hình gốc — không mất, không nhân.
        let tong: f64 = manh.iter().map(|p| signed_area_mm2(p)).sum();
        assert!(
            (tong - signed_area_mm2(&ring).abs()).abs() < 1e-6,
            "{name}: tổng mảnh {tong} != gốc {}",
            signed_area_mm2(&ring).abs()
        );
    }
}

#[test]
fn phan_ra_hinh_loi_khong_tam_giac_hoa_vo_ich() {
    for ring in [rect(80.0, 40.0), tri(20.0), regular(32, 25.0)] {
        let manh = convex_decompose(&ring, &tol());
        assert_eq!(manh.len(), 1, "hình đã lồi phải trả về một mảnh");
        assert_eq!(manh[0].len(), ring.len(), "không được thêm/bớt đỉnh");
    }
}

#[test]
fn phan_ra_loi_dung_o_goc_khong_cardinal() {
    for goc in [13.372_849_f64, 44.999, 179.5, 359.9] {
        let ring = rotate(&shape_c(), goc);
        let manh = convex_decompose(&ring, &tol());
        assert!(!manh.is_empty(), "góc {goc}°: phải phân rã được");
        assert!(manh.len() <= 3, "góc {goc}°: {} mảnh", manh.len());
        for piece in &manh {
            assert!(is_convex_ring(piece, &tol()), "góc {goc}°: mảnh không lồi");
        }
        let tong: f64 = manh.iter().map(|p| signed_area_mm2(p)).sum();
        assert!((tong - signed_area_mm2(&ring).abs()).abs() < 1e-6);
    }
}

#[test]
fn nfp_lom_dung_bang_phan_ra_cong_union() {
    // Đường đầy đủ của Amendment A, ghép ba module: geometry → kernel → kernel.
    // Đối chiếu bằng oracle raster độc lập: NFP = { t : A giao (t+B) khác rỗng }.
    let a = shape_c();
    let b = rect(8.0, 8.0);
    let neg_b: Vec<PointMm> = b.iter().map(|p| pt(-p.x, -p.y)).collect();

    let manh_a = convex_decompose(&a, &tol());
    let manh_b = convex_decompose(&neg_b, &tol());
    let mut cap: Vec<Vec<PointMm>> = Vec::new();
    for pa in &manh_a {
        for pb in &manh_b {
            cap.push(minkowski_convex(pa, pb).expect("mảnh đã lồi"));
        }
    }
    let nfp = union_many(&cap).expect("gộp NFP");
    assert!(!nfp.is_empty());

    // Oracle raster.
    let mut lech = 0;
    let mut tong = 0;
    let steps = 60;
    for gx in 0..steps {
        for gy in 0..steps {
            let t = pt(
                -60.0 + 160.0 * (f64::from(gx) + 0.5) / f64::from(steps),
                -60.0 + 170.0 * (f64::from(gy) + 0.5) / f64::from(steps),
            );
            let moved: Vec<PointMm> = b.iter().map(|p| pt(p.x + t.x, p.y + t.y)).collect();
            let su_that = rings_overlap(&a, &moved, &tol());
            // Điểm thuộc NFP: nằm trong vòng ngoài và không nằm trong lỗ nào.
            let mut trong = false;
            for ring in &nfp {
                if point_in_ring(ring, t) {
                    trong = !trong;
                }
            }
            tong += 1;
            if su_that != trong {
                // Điểm sát biên NFP thì hai cách kết luận có thể khác nhau hợp lệ.
                let mut sat_bien = false;
                for ring in &nfp {
                    for i in 0..ring.len() {
                        if point_to_segment_mm(t, ring[i], ring[(i + 1) % ring.len()]) < 0.5 {
                            sat_bien = true;
                        }
                    }
                }
                if !sat_bien {
                    lech += 1;
                }
            }
        }
    }
    assert_eq!(
        lech, 0,
        "NFP lệch oracle raster ở {lech}/{tong} điểm lưới không sát biên"
    );
}

// ═════════════════════════════════════════════════════════════════════════════
//  7. Va chạm và khoảng hở
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn broad_phase_loai_dung_cap_roi() {
    let a = BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 10.0,
        max_y: 10.0,
    };
    let ke = BoundsMm {
        min_x: 10.0,
        min_y: 0.0,
        max_x: 20.0,
        max_y: 10.0,
    };
    let xa = BoundsMm {
        min_x: 13.0,
        min_y: 0.0,
        max_x: 20.0,
        max_y: 10.0,
    };
    assert!(bounds_may_touch(&a, &ke, &tol()));
    assert!(!bounds_may_touch(&a, &xa, &tol()));
    assert_eq!(bounds_gap_mm(&a, &ke), 0.0);
    assert!((bounds_gap_mm(&a, &xa) - 3.0).abs() < 1e-12);
    // Chéo góc: khoảng hở bbox là đường chéo.
    let cheo = BoundsMm {
        min_x: 13.0,
        min_y: 14.0,
        max_x: 20.0,
        max_y: 20.0,
    };
    assert!((bounds_gap_mm(&a, &cheo) - 5.0).abs() < 1e-12);
}

#[test]
fn chong_lan_phan_biet_duoc_ba_truong_hop() {
    let a = rect(10.0, 10.0);
    // 1. Cắt nhau thực sự.
    assert!(rings_overlap(&a, &rect_at(5.0, 0.0, 10.0, 10.0), &tol()));
    // 2. Một hình nằm hẳn trong hình kia (không cạnh nào cắt).
    assert!(rings_overlap(&a, &rect_at(2.0, 2.0, 6.0, 6.0), &tol()));
    assert!(rings_overlap(&rect_at(2.0, 2.0, 6.0, 6.0), &a, &tol()));
    // 3. Chạm biên KHÔNG phải chồng — gap 0 dùng common cut-line là hợp lệ.
    assert!(!rings_overlap(&a, &rect_at(10.0, 0.0, 10.0, 10.0), &tol()));
    assert!(!rings_overlap(&a, &rect_at(10.0, 10.0, 10.0, 10.0), &tol()));
    // 4. Rời hẳn.
    assert!(!rings_overlap(&a, &rect_at(20.0, 0.0, 10.0, 10.0), &tol()));
    // 5. Trùng khít nhau là lỗi thật.
    assert!(rings_overlap(&a, &a, &tol()));
}

#[test]
fn chong_lan_khi_bien_chi_cham_chu_khong_cat() {
    // HỒI QUY cho lỗi đã mắc trong lượt P2b: hai chữ nhật CÙNG chiều cao đặt lệch nhau
    // chồng lên nhau thật, nhưng biên chỉ CHẠM chứ không cắt ngang — mọi giao điểm rơi
    // đúng vào đỉnh nằm trên cạnh đối phương. Cách kết luận theo "đỉnh nào nằm trong
    // hình kia" báo sai là "không chồng", tức bỏ qua một layout hỏng.
    let a = rect(10.0, 10.0);
    for dx in [1.0_f64, 5.0, 9.0, 9.999] {
        assert!(
            rings_overlap(&a, &rect_at(dx, 0.0, 10.0, 10.0), &tol()),
            "dx {dx}: cùng chiều cao, chồng {} mm mà báo không chồng",
            10.0 - dx
        );
    }
    // Cùng chiều rộng, chồng theo trục Y.
    for dy in [1.0_f64, 5.0, 9.0] {
        assert!(
            rings_overlap(&a, &rect_at(0.0, dy, 10.0, 10.0), &tol()),
            "dy {dy}"
        );
    }
    // Đúng biên thì không chồng — ranh giới giữa hai kết luận phải sắc.
    assert!(!rings_overlap(&a, &rect_at(10.0, 0.0, 10.0, 10.0), &tol()));
    assert!(!rings_overlap(&a, &rect_at(0.0, 10.0, 10.0, 10.0), &tol()));

    // Cùng cấu hình ở góc không-cardinal: xoay cả hai cùng một góc thì kết luận không đổi.
    for goc in [13.372_849_f64, 44.999, 179.5] {
        let rad = goc.to_radians();
        let ra = rotate(&a, goc);
        for (dx, mong_doi) in [(5.0_f64, true), (10.0, false), (12.0, false)] {
            let rb: Vec<PointMm> = rotate(&a, goc)
                .iter()
                .map(|p| pt(p.x + dx * rad.cos(), p.y + dx * rad.sin()))
                .collect();
            assert_eq!(
                rings_overlap(&ra, &rb, &tol()),
                mong_doi,
                "góc {goc}°, dịch {dx} mm dọc trục đã xoay"
            );
        }
    }

    // Hai hình LÕM chung một cạnh nhưng chồng nhau: cũng phải bắt được.
    let l = shape_l();
    let l_lech = rect_at(10.0, 5.0, 30.0, 8.0); // nằm trong dải đặc y∈[0,18] của L
    assert!(rings_overlap(&l, &l_lech, &tol()));
}

#[test]
fn chong_lan_dung_voi_hinh_lom_long_vao_nhau() {
    // Chữ C: thân đặc ở x∈[0,14] với mọi y, hai nhánh ở y∈[0,12] và y∈[38,50].
    // HÕM rỗng là x∈[14,60], y∈[12,38].
    let a = shape_c();
    // Chi tiết nằm gọn trong hõm ⇒ KHÔNG chồng, dù bbox chồng nhiều.
    let trong_hom = rect_at(20.0, 18.0, 8.0, 12.0);
    // Chi tiết đè lên nhánh dưới ⇒ chồng.
    let lech = rect_at(20.0, 6.0, 8.0, 12.0);
    assert!(
        !rings_overlap(&a, &trong_hom, &tol()),
        "chi tiết nằm gọn trong hõm chữ C không được coi là chồng"
    );
    // bbox thì lại chồng — chứng minh broad phase một mình là không đủ.
    let ba = BoundsMm::from_ring(&a).unwrap();
    let bt = BoundsMm::from_ring(&trong_hom).unwrap();
    assert!(
        bounds_may_touch(&ba, &bt, &tol()),
        "bbox phải chồng, nếu không thì test này vô nghĩa"
    );
    // Và mảnh đè lên thân chữ C thì phải báo chồng.
    assert!(rings_overlap(&a, &lech, &tol()));
}

#[test]
fn khoang_cach_va_phan_quyet_khoang_ho() {
    let a = rect(10.0, 10.0);
    // Rời 3 mm.
    let b = rect_at(13.0, 0.0, 10.0, 10.0);
    assert!((min_distance_mm(&a, &b, &tol()) - 3.0).abs() < 1e-9);
    // Chạm nhau ⇒ 0.
    assert_eq!(
        min_distance_mm(&a, &rect_at(10.0, 0.0, 10.0, 10.0), &tol()),
        0.0
    );
    // Chồng ⇒ 0.
    assert_eq!(
        min_distance_mm(&a, &rect_at(5.0, 0.0, 10.0, 10.0), &tol()),
        0.0
    );

    // Phán quyết theo gap.
    assert!(matches!(
        judge_pair(&a, &b, 3.0, &tol()),
        PairVerdict::Ok { .. }
    ));
    assert!(matches!(
        judge_pair(&a, &b, 2.0, &tol()),
        PairVerdict::Ok { .. }
    ));
    assert!(matches!(
        judge_pair(&a, &b, 3.5, &tol()),
        PairVerdict::ClearanceTooSmall { .. }
    ));
    assert_eq!(
        judge_pair(&a, &rect_at(5.0, 0.0, 10.0, 10.0), 3.0, &tol()),
        PairVerdict::Overlap
    );
    // gap = 0: chạm biên vẫn đạt.
    assert!(judge_pair(&a, &rect_at(10.0, 0.0, 10.0, 10.0), 0.0, &tol()).is_ok());
}

#[test]
fn near_contact_sat_dung_sai() {
    let a = rect(10.0, 10.0);
    let gap = 3.0_f64;
    // Đúng bằng gap ⇒ đạt.
    assert!(judge_pair(&a, &rect_at(13.0, 0.0, 10.0, 10.0), gap, &tol()).is_ok());
    // Thiếu 1e-9 mm (dưới dung sai) ⇒ vẫn đạt, không loại vì nhiễu f64.
    assert!(judge_pair(&a, &rect_at(13.0 - 1e-9, 0.0, 10.0, 10.0), gap, &tol()).is_ok());
    // Thiếu 1e-3 mm (trên dung sai) ⇒ bị loại.
    assert!(matches!(
        judge_pair(&a, &rect_at(13.0 - 1e-3, 0.0, 10.0, 10.0), gap, &tol()),
        PairVerdict::ClearanceTooSmall { .. }
    ));
    // Chồng 1e-6 mm ⇒ khoảng cách 0, và với gap > 0 thì bị loại.
    assert!(!judge_pair(&a, &rect_at(10.0 - 1e-6, 0.0, 10.0, 10.0), gap, &tol()).is_ok());
}

#[test]
fn khoang_cach_dung_o_goc_khong_cardinal() {
    // Hai chữ nhật cùng xoay một góc lẻ, dịch dọc theo trục đã xoay đúng 4 mm.
    let base = rect(20.0, 10.0);
    for goc in [13.372_849_f64, 44.999, 179.5, 359.9] {
        let rad = goc.to_radians();
        let a = rotate(&base, goc);
        let dich = 24.0; // 20 mm chiều dài + 4 mm hở
        let b: Vec<PointMm> = rotate(&base, goc)
            .iter()
            .map(|p| pt(p.x + dich * rad.cos(), p.y + dich * rad.sin()))
            .collect();
        let d = min_distance_mm(&a, &b, &tol());
        assert!((d - 4.0).abs() < 1e-9, "góc {goc}°: khoảng cách {d} != 4.0");
        assert!(judge_pair(&a, &b, 4.0, &tol()).is_ok());
        assert!(!judge_pair(&a, &b, 4.001, &tol()).is_ok());
    }
}

#[test]
fn trong_vung_dung_duoc_va_muc_tran_le() {
    let bounds = BoundsMm {
        min_x: 10.0,
        min_y: 40.0,
        max_x: 680.0,
        max_y: 970.0,
    };
    let trong = rect_at(20.0, 50.0, 100.0, 60.0);
    assert!(ring_within_bounds(&trong, &bounds, &tol()));
    assert!((signed_margin_to_bounds_mm(&trong, &bounds) - 10.0).abs() < 1e-9);

    // Tràn ra ngoài lề dưới 5 mm ⇒ lề có dấu âm 5.
    let tran = rect_at(20.0, 35.0, 100.0, 60.0);
    assert!(!ring_within_bounds(&tran, &bounds, &tol()));
    assert!((signed_margin_to_bounds_mm(&tran, &bounds) + 5.0).abs() < 1e-9);

    // Đặt sát đúng biên ⇒ vẫn hợp lệ.
    let sat = rect_at(10.0, 40.0, 670.0, 930.0);
    assert!(ring_within_bounds(&sat, &bounds, &tol()));
    // Vượt biên 1e-3 mm ⇒ bị loại.
    let vuot = rect_at(10.0 - 1e-3, 40.0, 670.0, 930.0);
    assert!(!ring_within_bounds(&vuot, &bounds, &tol()));
}

#[test]
fn phep_do_doan_thang_co_ban() {
    // Điểm tới đoạn: chân vuông góc trong đoạn, và ngoài đoạn.
    assert!((point_to_segment_mm(pt(5.0, 3.0), pt(0.0, 0.0), pt(10.0, 0.0)) - 3.0).abs() < 1e-12);
    assert!((point_to_segment_mm(pt(-4.0, 0.0), pt(0.0, 0.0), pt(10.0, 0.0)) - 4.0).abs() < 1e-12);
    assert!((point_to_segment_mm(pt(14.0, 0.0), pt(0.0, 0.0), pt(10.0, 0.0)) - 4.0).abs() < 1e-12);

    // Hai đoạn song song.
    assert!(
        (segment_distance_mm(pt(0.0, 0.0), pt(10.0, 0.0), pt(0.0, 2.0), pt(10.0, 2.0)) - 2.0).abs()
            < 1e-12
    );
    // Hai đoạn cắt nhau ⇒ 0.
    assert_eq!(
        segment_distance_mm(pt(0.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0), pt(10.0, 0.0)),
        0.0
    );
    // Chạm đầu mút ⇒ 0.
    assert_eq!(
        segment_distance_mm(pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 0.0), pt(20.0, 0.0)),
        0.0
    );

    // Cắt thực sự vs chỉ chạm.
    assert!(segments_properly_cross(
        pt(0.0, 0.0),
        pt(10.0, 10.0),
        pt(0.0, 10.0),
        pt(10.0, 0.0),
        &tol()
    ));
    assert!(!segments_properly_cross(
        pt(0.0, 0.0),
        pt(10.0, 0.0),
        pt(10.0, 0.0),
        pt(20.0, 0.0),
        &tol()
    ));
    // Chạm hình chữ T: đầu mút nằm giữa đoạn kia — không phải cắt thực sự.
    assert!(!segments_properly_cross(
        pt(0.0, 0.0),
        pt(10.0, 0.0),
        pt(5.0, 0.0),
        pt(5.0, 10.0),
        &tol()
    ));
}

#[test]
fn point_in_ring_dung_voi_hinh_lom() {
    let c = shape_c();
    assert!(point_in_ring(&c, pt(5.0, 25.0)), "trong thân trái");
    assert!(point_in_ring(&c, pt(30.0, 6.0)), "trong nhánh dưới");
    assert!(point_in_ring(&c, pt(30.0, 44.0)), "trong nhánh trên");
    assert!(
        !point_in_ring(&c, pt(30.0, 25.0)),
        "trong HÕM, phải là ngoài"
    );
    assert!(!point_in_ring(&c, pt(-5.0, 25.0)), "ngoài hẳn");
    assert!(!point_in_ring(&c, pt(100.0, 100.0)), "xa hẳn");
}

// ═════════════════════════════════════════════════════════════════════════════
//  8. Polygon xấu không làm kernel hoặc quan toà hỏng
// ═════════════════════════════════════════════════════════════════════════════

#[test]
fn polygon_xau_khong_lam_sap_kernel() {
    let style = OffsetStyle::v1_round();
    // Sliver cực mỏng.
    let sliver = vec![
        pt(0.0, 0.0),
        pt(100.0, 0.0),
        pt(100.0, 0.001),
        pt(0.0, 0.001),
    ];
    assert!(offset(one(&sliver), 0.5, style).is_ok());
    assert!(union(one(&sliver), &[rect(10.0, 10.0)]).is_ok());
    // Co vào quá bề dày ⇒ sập, không panic.
    assert!(offset(one(&sliver), -1.0, style).unwrap().is_empty());

    // Nhiều đỉnh thẳng hàng.
    let thang: Vec<PointMm> = (0..50)
        .map(|k| pt(f64::from(k) * 2.0, 0.0))
        .chain((0..50).map(|k| pt(98.0 - f64::from(k) * 2.0, 10.0)))
        .collect();
    assert!(union(one(&thang), &[rect(10.0, 10.0)]).is_ok());
    assert!(offset(&[thang], 1.0, style).is_ok());

    // Contour 500 đỉnh lượn sóng.
    let song: Vec<PointMm> = (0..500)
        .map(|k| {
            let t = f64::from(k) / 500.0 * std::f64::consts::TAU;
            let r = 40.0 + 8.0 * (7.0 * t).sin();
            pt(r * t.cos(), r * t.sin())
        })
        .collect();
    let o = offset(one(&song), 1.5, style).unwrap();
    assert!(!o.is_empty());
    assert!(total_abs_area(&o) > signed_area_mm2(&song).abs());
}

#[test]
fn quan_toa_khong_sap_voi_dau_vao_suy_bien() {
    let a = rect(10.0, 10.0);
    let hai_dinh = vec![pt(0.0, 0.0), pt(1.0, 1.0)];
    assert!(!rings_overlap(&a, &hai_dinh, &tol()));
    assert!(!rings_overlap(&hai_dinh, &a, &tol()));
    assert_eq!(min_distance_mm(&a, &hai_dinh, &tol()), f64::INFINITY);
    assert!(!ring_within_bounds(
        &hai_dinh,
        &BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 100.0,
            max_y: 100.0
        },
        &tol()
    ));
    assert!(!point_in_ring(&hai_dinh, pt(0.5, 0.5)));
}
