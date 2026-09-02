//! Hồi quy §NFP-CONVEX: khuôn **gần lồi** không được bị `KERNEL_NOT_CONVEX`.
//!
//! ## Lỗi gốc
//!
//! Hai vị từ lồi dùng liền nhau trong cùng một chuỗi gọi nhưng **lệch dung sai 1000×**:
//!
//! | Nơi | Ngưỡng |
//! |---|---|
//! | `geometry::convex_decompose` (qua `cross_tolerance_mm2`) | `Tolerance::linear_mm × P` = `1e-6 × P` |
//! | `kernel::minkowski_convex` (qua `is_convex_ccw`) | `1e-9 × P` viết cứng |
//!
//! Mảnh có đỉnh lõm trong dải `[1e-9·P, 1e-6·P]` được phân rã nhận là lồi, trả về **một
//! mảnh duy nhất**, rồi kernel chặn bằng `KERNEL_NOT_CONVEX`. Người dùng thấy "Không
//! bình được trang" trên khuôn **gần lồi** — trong khi khuôn lõm rõ ràng lại chạy tốt,
//! vì hình lõm rõ mới được tam giác hoá đúng.
//!
//! Đo thật trước bản vá (độ võng của đỉnh giữa, mm):
//!
//! ```text
//! sag=1e-8  is_convex_ring(loose)=true   pieces=1  nfp=Kernel(NotConvex)
//! sag=1e-7  is_convex_ring(loose)=true   pieces=1  nfp=Kernel(NotConvex)
//! sag=1e-6  is_convex_ring(loose)=true   pieces=1  nfp=Kernel(NotConvex)
//! sag=1e-5  is_convex_ring(loose)=false  pieces=2  nfp=Ok            ← lõm HƠN lại chạy
//! ```
//!
//! ## Bản vá
//!
//! 1. Hằng tỉ lệ luật nghiêm về `model::CONVEX_STRICT_TOL_RATIO`, dùng chung cho cả
//!    kernel và geometry — `geometry` cố ý không phụ thuộc `kernel` nên `model` là nơi
//!    duy nhất hai bên gặp nhau.
//! 2. `convex_decompose` bỏ đỉnh trùng và đỉnh gần thẳng trước, rồi xét lồi theo luật
//!    **nghiêm**. Bước 1 làm bước 2 an toàn: đỉnh còn lại có `|cross|` vượt dung sai
//!    lỏng, nên hai luật đồng ý.

use imposition_core::mixed_nesting::{
    convex_decompose, no_fit_polygon, PointMm, Tolerance, CONVEX_STRICT_TOL_RATIO,
    DEFAULT_LINEAR_TOL_MM,
};

fn p(x: f64, y: f64) -> PointMm {
    PointMm { x, y }
}

fn square(size: f64) -> Vec<PointMm> {
    vec![p(0.0, 0.0), p(size, 0.0), p(size, size), p(0.0, size)]
}

/// Vòng gần lồi: đỉnh giữa cạnh dưới lõm vào `sag` mm.
fn almost_convex_ring(sag_mm: f64) -> Vec<PointMm> {
    vec![
        p(0.0, 0.0),
        p(50.0, 0.0),
        p(100.0, sag_mm),
        p(150.0, 0.0),
        p(150.0, 80.0),
        p(0.0, 80.0),
    ]
}

#[test]
fn hai_luat_loi_phai_dung_cung_ti_le_dung_sai() {
    // Chốt chính lỗi gốc: luật nghiêm phải nghiêm hơn luật lỏng, và cả hai phải là
    // hằng khai báo tường minh chứ không phải số viết cứng rải rác.
    assert!(
        CONVEX_STRICT_TOL_RATIO < DEFAULT_LINEAR_TOL_MM,
        "luật Minkowski phải nghiêm hơn dung sai nghiệp vụ"
    );
}

#[test]
fn khuon_gan_loi_moi_do_vong_deu_dung_nfp_duoc() {
    let tol = Tolerance::default();
    let moving = square(10.0);

    // Quét cả dải từng gây lỗi, cộng hai biên ngoài dải.
    for sag in [0.0, 1e-12, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-3] {
        let ring = almost_convex_ring(sag);
        let result = no_fit_polygon(&ring, &moving, &tol);
        assert!(
            result.is_ok(),
            "sag={sag:e} phải dựng được NFP, nhận: {:?}",
            result.err()
        );
    }
}

#[test]
fn dinh_gan_thang_bi_bo_nen_vong_thanh_mot_manh() {
    let tol = Tolerance::default();

    // Độ võng dưới dung sai không mang thông tin cơ khí ⇒ bỏ đỉnh ⇒ hình lồi thật ⇒
    // một mảnh, tức đường Minkowski nhanh nhất.
    let pieces = convex_decompose(&almost_convex_ring(1e-8), &tol);
    assert_eq!(pieces.len(), 1, "khuôn gần lồi phải cho đúng một mảnh");
}

#[test]
fn dinh_lom_that_van_duoc_phan_ra_dung() {
    let tol = Tolerance::default();

    // Lõm 5mm là hình học THẬT, tuyệt đối không được bỏ đỉnh.
    let ring = almost_convex_ring(5.0);
    let pieces = convex_decompose(&ring, &tol);

    assert!(pieces.len() >= 2, "đỉnh lõm thật phải được phân rã");
    let total: f64 = pieces.iter().map(|piece| area_abs(piece)).sum();
    assert!(
        (total - area_abs(&ring)).abs() <= 1e-6 * area_abs(&ring).max(1.0),
        "phân rã phải phủ đúng diện tích vòng gốc"
    );
}

#[test]
fn dinh_trung_lien_ke_khong_lam_vo_phan_ra() {
    let tol = Tolerance::default();

    // Bộ trích nét PDF sinh ra đỉnh trùng (đo được: hình chữ nhật 4 góc ra 8 đỉnh).
    // Từ §A4b-2 contour giữ nguyên các đỉnh đó nên đường nesting gặp chúng thật.
    let ring = vec![
        p(0.0, 0.0),
        p(0.0, 0.0),
        p(60.0, 0.0),
        p(60.0, 0.0),
        p(60.0, 40.0),
        p(60.0, 40.0),
        p(0.0, 40.0),
        p(0.0, 40.0),
    ];

    let pieces = convex_decompose(&ring, &tol);
    assert_eq!(
        pieces.len(),
        1,
        "chữ nhật có đỉnh trùng vẫn là một mảnh lồi"
    );
    assert_eq!(pieces[0].len(), 4, "đỉnh trùng phải bị gộp về 4 góc");

    let result = no_fit_polygon(&ring, &square(5.0), &tol);
    assert!(result.is_ok(), "nhận: {:?}", result.err());
}

#[test]
fn hinh_l_van_ra_hai_manh() {
    let tol = Tolerance::default();

    // Bất biến hiệu năng của phân rã lồi: hình L có 1 đỉnh lõm ⇒ 2 mảnh, không phải 4
    // tam giác. Bản vá không được làm hồi quy điều này.
    let l_shape = vec![
        p(0.0, 0.0),
        p(60.0, 0.0),
        p(60.0, 20.0),
        p(20.0, 20.0),
        p(20.0, 60.0),
        p(0.0, 60.0),
    ];

    let pieces = convex_decompose(&l_shape, &tol);
    assert_eq!(pieces.len(), 2, "hình L phải ra đúng 2 mảnh");
    assert!(no_fit_polygon(&l_shape, &square(5.0), &tol).is_ok());
}

#[test]
fn vong_tron_sample_nhieu_dinh_van_la_mot_manh() {
    let tol = Tolerance::default();

    // Contour thật từ PDF là bezier đã sample. Đỉnh của đường tròn có độ võng LỚN hơn
    // dung sai nhiều nên không được bỏ; hình phải vẫn lồi và ra một mảnh.
    let mut circle = Vec::new();
    let steps = 72;
    for index in 0..steps {
        let angle = (index as f64) * std::f64::consts::TAU / (steps as f64);
        circle.push(p(20.0 * angle.cos(), 20.0 * angle.sin()));
    }

    let pieces = convex_decompose(&circle, &tol);
    assert_eq!(pieces.len(), 1, "đường tròn sample phải là một mảnh lồi");
    assert_eq!(
        pieces[0].len(),
        steps,
        "không được bỏ đỉnh thật của đường tròn"
    );
    assert!(no_fit_polygon(&circle, &square(5.0), &tol).is_ok());
}

fn area_abs(ring: &[PointMm]) -> f64 {
    let count = ring.len();
    let mut sum = 0.0;
    for index in 0..count {
        let a = ring[index];
        let b = ring[(index + 1) % count];
        sum += a.x * b.y - b.x * a.y;
    }
    (sum / 2.0).abs()
}
