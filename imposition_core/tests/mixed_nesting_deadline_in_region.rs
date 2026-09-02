//! Hồi quy §NFP-DEADLINE: deadline phải cắt được **giữa lúc dựng miền hợp lệ**.
//!
//! ## Lỗi gốc
//!
//! `RunControl::checkpoint()` chỉ được gọi GIỮA các góc. `feasible_region` dựng NFP cho
//! **từng** chi tiết đã đặt rồi thực hiện phép Boolean cho toàn bộ blocker — với contour
//! thật (127–733 đỉnh) một NFP tốn 0,5–1,7s, nên một lượt gọi duy nhất có thể chạy hàng
//! chục giây mà không có điểm dừng nào. Đo trên file khách: ngân sách 3000ms mà mất
//! **17,85s**, và bấm Hủy không dứt.
//!
//! ## Bất biến
//!
//! 1. Solver tôn trọng deadline **trong** vòng lặp obstacle.
//! 2. Baseline **cố ý bỏ qua** deadline/work budget và chỉ tôn trọng hủy — vì nó phải
//!    luôn cho ra phương án nền để so. Đó là lý do `feasible_region_cached` nhận
//!    **closure** luật dừng chứ không nhận `RunControl`.
//! 3. Ngắt giữa lúc dựng miền **không** được báo thành "hình học không vừa" (§11.4).

use imposition_core::mixed_nesting::{
    difference, feasible_region, feasible_region_cached, inner_fit_rect, region_contains,
    union_many, BoundsMm, NfpCache, PointMm, Tolerance,
};

fn p(x: f64, y: f64) -> PointMm {
    PointMm { x, y }
}

fn square(size: f64) -> Vec<PointMm> {
    vec![p(0.0, 0.0), p(size, 0.0), p(size, size), p(0.0, size)]
}

fn usable() -> BoundsMm {
    BoundsMm {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 400.0,
        max_y: 300.0,
    }
}

/// Nhiều chi tiết đã đặt, để vòng lặp obstacle có nhiều lượt cho closure chạy.
fn placed_grid(count: usize) -> Vec<Vec<PointMm>> {
    (0..count)
        .map(|index| {
            let x = 20.0 + ((index % 8) as f64) * 30.0;
            let y = 20.0 + ((index / 8) as f64) * 30.0;
            vec![
                p(x, y),
                p(x + 20.0, y),
                p(x + 20.0, y + 20.0),
                p(x, y + 20.0),
            ]
        })
        .collect()
}

#[test]
fn khong_co_luat_dung_thi_hanh_vi_khong_doi() {
    let tol = Tolerance::default();
    let placed = placed_grid(12);
    let moving = square(15.0);

    let wrapper = feasible_region(&usable(), &placed, &moving, 2.0, &tol).unwrap();
    let mut cache = NfpCache::new();
    let cached =
        feasible_region_cached(&usable(), &placed, &moving, 2.0, &tol, &mut cache, None).unwrap();

    assert!(
        cached.is_some(),
        "không có luật dừng thì không bao giờ ngắt"
    );
    assert_eq!(cached.unwrap().len(), wrapper.len());
}

#[test]
fn tru_truc_tiep_nhieu_blocker_tuong_duong_hop_roi_tru() {
    let tol = Tolerance::default();
    let placed = placed_grid(12);
    let moving = square(15.0);
    let gap_mm = 2.0;

    let mut direct_cache = NfpCache::new();
    let direct = feasible_region_cached(
        &usable(),
        &placed,
        &moving,
        gap_mm,
        &tol,
        &mut direct_cache,
        None,
    )
    .unwrap()
    .expect("không có luật dừng");

    // Dựng lại chính đường cũ: hợp mọi NFP đã nở rồi mới trừ khỏi IFP.
    let ifp = inner_fit_rect(&usable(), &moving, &tol).expect("chi tiết vừa tờ");
    let ifp_ring = imposition_core::mixed_nesting::nfp::bounds_to_ring(&ifp);
    let mut legacy_cache = NfpCache::new();
    let mut blockers = Vec::new();
    for obstacle in &placed {
        blockers.extend(
            legacy_cache
                .grown_nfp(obstacle, &moving, gap_mm, &tol)
                .unwrap(),
        );
    }
    let blocked = union_many(&blockers).unwrap();
    let legacy = difference(&[ifp_ring], &blocked).unwrap();

    let direct_area = imposition_core::mixed_nesting::nfp::region_area_mm2(&direct);
    let legacy_area = imposition_core::mixed_nesting::nfp::region_area_mm2(&legacy);
    assert!((direct_area - legacy_area).abs() <= 1e-6);

    // So tập hợp ở cả lưới trong/ngoài và trên những điểm tiếp xúc sinh bởi hai đường.
    let mut probes: Vec<PointMm> = (0..=20)
        .flat_map(|ix| (0..=15).map(move |iy| p(ix as f64 * 20.0, iy as f64 * 20.0)))
        .collect();
    probes.extend(direct.iter().flatten().copied());
    probes.extend(legacy.iter().flatten().copied());
    for probe in probes {
        assert_eq!(
            region_contains(&direct, probe),
            region_contains(&legacy, probe),
            "hai phép Boolean lệch tại ({}, {})",
            probe.x,
            probe.y
        );
    }
}

#[test]
fn cache_khong_alias_hai_moving_cung_outline_khac_pivot() {
    let tol = Tolerance::default();
    let obstacle = vec![p(40.0, 30.0), p(70.0, 30.0), p(70.0, 50.0), p(40.0, 50.0)];
    let moving_at_origin = square(15.0);
    let moving_shifted_from_pivot = vec![p(-5.0, -7.0), p(10.0, -7.0), p(10.0, 8.0), p(-5.0, 8.0)];
    let mut cache = NfpCache::new();

    let first = cache
        .grown_nfp(&obstacle, &moving_at_origin, 2.0, &tol)
        .unwrap();
    let cached_second = cache
        .grown_nfp(&obstacle, &moving_shifted_from_pivot, 2.0, &tol)
        .unwrap();
    let mut fresh_cache = NfpCache::new();
    let fresh_second = fresh_cache
        .grown_nfp(&obstacle, &moving_shifted_from_pivot, 2.0, &tol)
        .unwrap();

    assert_eq!(cached_second, fresh_second);
    assert_ne!(
        first, fresh_second,
        "dịch outline quanh pivot phải dịch NFP"
    );
    assert_eq!(
        cache.misses(),
        2,
        "hai pivot phải là hai cache key khác nhau"
    );
}

#[test]
fn luat_dung_bat_ngay_lan_dau_thi_tra_none() {
    let tol = Tolerance::default();
    let mut cache = NfpCache::new();

    let region = feasible_region_cached(
        &usable(),
        &placed_grid(12),
        &square(15.0),
        2.0,
        &tol,
        &mut cache,
        Some(&|| true),
    )
    .unwrap();

    assert!(region.is_none(), "ngắt phải trả None, không trả miền rỗng");
}

#[test]
fn none_khac_mien_rong_de_caller_bao_dung_ly_do() {
    let tol = Tolerance::default();
    let mut cache = NfpCache::new();

    // Chi tiết to hơn cả tờ ⇒ THẬT SỰ không vừa ⇒ miền rỗng, KHÔNG phải None.
    let too_big = feasible_region_cached(
        &usable(),
        &[],
        &square(10_000.0),
        0.0,
        &tol,
        &mut cache,
        Some(&|| false),
    )
    .unwrap();

    assert_eq!(
        too_big,
        Some(Vec::new()),
        "không vừa là miền RỖNG; None chỉ dành cho ngắt"
    );
}

#[test]
fn luat_dung_duoc_goi_nhieu_lan_theo_so_obstacle() {
    use std::cell::Cell;

    let tol = Tolerance::default();
    let mut cache = NfpCache::new();
    let calls = Cell::new(0usize);

    let region = feasible_region_cached(
        &usable(),
        &placed_grid(12),
        &square(15.0),
        2.0,
        &tol,
        &mut cache,
        Some(&|| {
            calls.set(calls.get() + 1);
            false
        }),
    )
    .unwrap();

    assert!(region.is_some());
    // Mỗi obstacle một lượt, cộng ít nhất một barrier trước phép difference.
    assert!(
        calls.get() >= 12,
        "luật dừng phải được kiểm trong vòng lặp obstacle, đếm được {}",
        calls.get()
    );
}

#[test]
fn deadline_cat_duoc_giua_cac_batch_difference() {
    use std::cell::Cell;

    let tol = Tolerance::default();
    let placed = placed_grid(40);
    let mut cache = NfpCache::new();
    let calls = Cell::new(0usize);

    let region = feasible_region_cached(
        &usable(),
        &placed,
        &square(15.0),
        2.0,
        &tol,
        &mut cache,
        Some(&|| {
            calls.set(calls.get() + 1);
            // 40 checkpoint dựng blocker + barrier batch thứ nhất; dừng trước batch sau.
            calls.get() > placed.len() + 1
        }),
    )
    .unwrap();

    assert!(region.is_none());
    assert!(calls.get() > placed.len() + 1);
}

#[test]
fn ngat_o_giua_van_khong_lam_hong_cache() {
    let tol = Tolerance::default();
    let mut cache = NfpCache::new();
    let placed = placed_grid(12);
    let moving = square(15.0);

    // Lượt đầu ngắt sau 3 obstacle.
    let seen = std::cell::Cell::new(0usize);
    let interrupted = feasible_region_cached(
        &usable(),
        &placed,
        &moving,
        2.0,
        &tol,
        &mut cache,
        Some(&|| {
            seen.set(seen.get() + 1);
            seen.get() > 3
        }),
    )
    .unwrap();
    assert!(interrupted.is_none());

    // Lượt sau không ngắt: phải ra đúng miền như chưa từng bị ngắt.
    let full =
        feasible_region_cached(&usable(), &placed, &moving, 2.0, &tol, &mut cache, None).unwrap();
    let reference = feasible_region(&usable(), &placed, &moving, 2.0, &tol).unwrap();

    assert_eq!(full, Some(reference));
}
