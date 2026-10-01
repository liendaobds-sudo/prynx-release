//! Regression tests cho chuẩn bị cạnh của collision narrow phase.
//!
//! Oracle trong file này cố ý lặp công thức cũ, không gọi helper đã tối ưu, để
//! kiểm chứng phép loại AABB không làm đổi kết quả phán quyết.

use super::*;

fn tol() -> Tolerance {
    Tolerance::v1()
}

fn rectangle(x: f64, y: f64, width: f64, height: f64) -> Vec<PointMm> {
    vec![
        PointMm::new(x, y),
        PointMm::new(x + width, y),
        PointMm::new(x + width, y + height),
        PointMm::new(x, y + height),
    ]
}

fn reference_segments_cross(
    p1: PointMm,
    p2: PointMm,
    q1: PointMm,
    q2: PointMm,
    tolerance: &Tolerance,
) -> bool {
    let tol_p = tolerance.linear_mm * distance_mm(p1, p2).max(tolerance.linear_mm);
    let tol_q = tolerance.linear_mm * distance_mm(q1, q2).max(tolerance.linear_mm);
    let sign = |value: f64, threshold: f64| -> i32 {
        if value > threshold {
            1
        } else if value < -threshold {
            -1
        } else {
            0
        }
    };
    let cross = |origin: PointMm, a: PointMm, b: PointMm| {
        (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
    };
    let d1 = sign(cross(q1, q2, p1), tol_q);
    let d2 = sign(cross(q1, q2, p2), tol_q);
    let d3 = sign(cross(p1, p2, q1), tol_p);
    let d4 = sign(cross(p1, p2, q2), tol_p);
    d1 * d2 < 0 && d3 * d4 < 0
}

fn reference_any_cross(a: &[PointMm], b: &[PointMm], tolerance: &Tolerance) -> bool {
    (0..a.len()).any(|i| {
        (0..b.len()).any(|j| {
            reference_segments_cross(
                a[i],
                a[(i + 1) % a.len()],
                b[j],
                b[(j + 1) % b.len()],
                tolerance,
            )
        })
    })
}

fn reference_rings_overlap(a: &[PointMm], b: &[PointMm], tolerance: &Tolerance) -> bool {
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    let (Some(bounds_a), Some(bounds_b)) = (BoundsMm::from_ring(a), BoundsMm::from_ring(b)) else {
        return false;
    };
    if !bounds_may_touch(&bounds_a, &bounds_b, tolerance) {
        return false;
    }
    if reference_any_cross(a, b, tolerance) {
        return true;
    }
    let convex_a = super::super::geometry::is_convex_ring(a, tolerance);
    let convex_b = super::super::geometry::is_convex_ring(b, tolerance);
    if convex_a && convex_b {
        return !separating_axis_exists(a, b, tolerance);
    }
    let pieces_a = convex_pieces(a, convex_a, tolerance);
    let pieces_b = convex_pieces(b, convex_b, tolerance);
    if pieces_a.is_empty() || pieces_b.is_empty() {
        return true;
    }
    pieces_a.iter().any(|piece_a| {
        let box_a = BoundsMm::from_ring(piece_a);
        pieces_b.iter().any(|piece_b| {
            if let (Some(ba), Some(bb)) = (box_a, BoundsMm::from_ring(piece_b)) {
                if !bounds_may_touch(&ba, &bb, tolerance) {
                    return false;
                }
            }
            !separating_axis_exists(piece_a, piece_b, tolerance)
        })
    })
}

#[test]
fn prepared_edge_cross_giu_nguyen_cong_thuc_cu() {
    let tolerance = tol();
    let cases = [
        (
            PointMm::new(0.0, 0.0),
            PointMm::new(10.0, 10.0),
            PointMm::new(0.0, 10.0),
            PointMm::new(10.0, 0.0),
        ),
        (
            PointMm::new(0.0, 0.0),
            PointMm::new(10.0, 0.0),
            PointMm::new(0.0, 1.0e-6),
            PointMm::new(10.0, 1.0e-6),
        ),
        (
            PointMm::new(-2.0, 4.0),
            PointMm::new(3.0, 4.0),
            PointMm::new(1.0, 3.0),
            PointMm::new(1.0, 8.0),
        ),
    ];
    for (p1, p2, q1, q2) in cases {
        assert_eq!(
            segments_properly_cross(p1, p2, q1, q2, &tolerance),
            reference_segments_cross(p1, p2, q1, q2, &tolerance),
        );
    }
}

#[test]
fn prepared_edge_aabb_chi_loai_canh_chac_chan_roi_va_giu_oracle() {
    let tolerance = tol();
    // Hai vòng lồng nhau có bbox giao nhau nhưng không có cặp cạnh cắt nhau.
    // Mỗi vòng được chia nhỏ để chứng minh broad phase loại phần lớn n×m cặp.
    let outer: Vec<_> = (0..64)
        .map(|index| PointMm::new(index as f64 * 100.0 / 64.0, 0.0))
        .chain((0..64).map(|index| PointMm::new(100.0, index as f64 * 100.0 / 64.0)))
        .chain((0..64).map(|index| PointMm::new(100.0 - index as f64 * 100.0 / 64.0, 100.0)))
        .chain((0..64).map(|index| PointMm::new(0.0, 100.0 - index as f64 * 100.0 / 64.0)))
        .collect();
    let inner = rectangle(40.0, 40.0, 20.0, 20.0);
    let mut narrow_calls = 0usize;
    let prepared = any_edges_properly_cross(&outer, &inner, &tolerance, || {
        narrow_calls += 1;
    });

    assert_eq!(prepared, reference_any_cross(&outer, &inner, &tolerance));
    assert!(!prepared);
    assert!(narrow_calls < outer.len() * inner.len() / 4);
    // Convex SAT vẫn phải nhận đúng quan hệ lồng nhau sau khi cạnh cross bị loại.
    assert_eq!(
        rings_overlap(&outer, &inner, &tolerance),
        reference_rings_overlap(&outer, &inner, &tolerance)
    );
}

#[test]
fn prepared_edge_aabb_khong_loai_canh_sat_sai_o_ranh_gioi_dung_sai() {
    let tolerance = tol();
    let a = rectangle(0.0, 0.0, 10.0, 10.0);
    // Cấu hình có cạnh cắt thực sự; hai cạnh song song chồng lên nhau không
    // được tính là `properly_cross` theo hợp đồng collision.
    let b = vec![
        PointMm::new(10.0 - tolerance.linear_mm * 0.5, 5.0),
        PointMm::new(15.0, 10.0),
        PointMm::new(5.0, 15.0),
        PointMm::new(0.0, 5.0),
    ];
    let mut narrow_calls = 0usize;
    let prepared = any_edges_properly_cross(&a, &b, &tolerance, || {
        narrow_calls += 1;
    });
    assert_eq!(prepared, reference_any_cross(&a, &b, &tolerance));
    // AABB sát biên không được loại sớm; công thức cross cũ vẫn nhận cạnh cắt.
    assert!(prepared);
    assert!(narrow_calls > 0);
    assert_eq!(
        rings_overlap(&a, &b, &tolerance),
        reference_rings_overlap(&a, &b, &tolerance)
    );
}

#[test]
fn prepared_edge_khong_doi_phat_quyet_vong_lom_va_vong_suy_bien() {
    let tolerance = tol();
    let concave = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(30.0, 0.0),
        PointMm::new(30.0, 10.0),
        PointMm::new(10.0, 10.0),
        PointMm::new(10.0, 30.0),
        PointMm::new(0.0, 30.0),
    ];
    let crossing = rectangle(8.0, 8.0, 10.0, 10.0);
    assert_eq!(
        rings_overlap(&concave, &crossing, &tolerance),
        reference_rings_overlap(&concave, &crossing, &tolerance)
    );

    let degenerate = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(1.0, 0.0),
        PointMm::new(2.0, 0.0),
    ];
    assert_eq!(
        rings_overlap(&degenerate, &crossing, &tolerance),
        reference_rings_overlap(&degenerate, &crossing, &tolerance)
    );
}

#[test]
fn prepared_ring_giu_nguyen_phat_quyet_pair_va_clearance() {
    let tolerance = tol();
    let concave = vec![
        PointMm::new(0.0, 0.0),
        PointMm::new(30.0, 0.0),
        PointMm::new(30.0, 10.0),
        PointMm::new(10.0, 10.0),
        PointMm::new(10.0, 30.0),
        PointMm::new(0.0, 30.0),
    ];
    let other = rectangle(40.0, 3.0, 8.0, 8.0);
    let prepared_a = PreparedRing::new(&concave);
    let prepared_b = PreparedRing::new(&other);
    assert_eq!(
        judge_pair_prepared(&prepared_a, &prepared_b, 2.0, &tolerance),
        judge_pair(&concave, &other, 2.0, &tolerance)
    );

    let clearance = SheetAxisClearanceMm {
        x_mm: 2.0,
        y_mm: 1.0,
    };
    assert_eq!(
        judge_pair_sheet_axis_prepared(&prepared_a, &prepared_b, clearance, &tolerance),
        judge_pair_sheet_axis(&concave, &other, clearance, &tolerance)
    );
}
