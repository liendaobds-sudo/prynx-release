//! Phép hình học thuần trên contour mm (P2b).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.1
//! và ràng buộc rút ra từ spike `docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md` §11.4.
//!
//! Module này **không** phụ thuộc kernel fixed-point và **không** phụ thuộc solver.
//! Nó chỉ làm ba việc: nhận diện hình dạng, tam giác hoá, và **phân rã lồi**.
//!
//! ## Vì sao phân rã lồi là điều kiện chặn, không phải tối ưu tùy chọn
//!
//! NFP của hai đa giác dựng bằng `∪(i,j) (A_i ⊕ B_j)` với `A_i`, `B_j` lồi. Số phép
//! Minkowski và số vòng phải hợp nhất bằng **tích** số mảnh, nên số mảnh quyết định
//! chi phí:
//!
//! | Cách phân rã | 50 ⊕ 50 đỉnh lõm | Đo được |
//! |---|---|---|
//! | Tam giác hoá thuần (`n−2` mảnh) | 48 × 48 = 2304 cặp | 298 ms |
//! | Phân rã lồi ([`convex_decompose`]) | theo số đỉnh lõm | xem dưới |
//!
//! Khuôn bế thật có rất ít đỉnh lõm: hình L có 1, chữ C có 2. Phân rã lồi cho tối đa
//! `r+1` mảnh với `r` là số đỉnh lõm, nên hình L ra 2 mảnh thay vì 4 và chữ C ra 3
//! mảnh thay vì 6.

use super::model::{PointMm, Tolerance};
use super::transform::{perimeter_mm, signed_area_mm2};

/// Tích có hướng `(b−a) × (c−b)`. Trị tuyệt đối bằng `khoảng cách × độ dài`.
pub fn turn_cross_mm2(a: PointMm, b: PointMm, c: PointMm) -> f64 {
    (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
}

/// Dung sai cho tích có hướng, quy về thang hình.
///
/// Tích có hướng có đơn vị mm², nên một hằng số diện tích chung sẽ kiểm tem 5 mm quá
/// lỏng và kiểm khuôn 700 mm quá chặt. Nhân với chu vi để cùng một quy tắc dùng được
/// cho mọi cỡ hình.
pub fn cross_tolerance_mm2(ring: &[PointMm], tol: &Tolerance) -> f64 {
    tol.linear_mm * perimeter_mm(ring).max(1.0)
}

/// Vòng có lồi hay không. Đỉnh thẳng hàng được coi là lồi.
pub fn is_convex_ring(ring: &[PointMm], tol: &Tolerance) -> bool {
    if ring.len() < 3 {
        return false;
    }
    reflex_vertex_indices(ring, tol).is_empty()
}

/// Chỉ số các đỉnh **lõm** của vòng, tính theo chiều CCW.
///
/// Vòng đầu vào có chiều nào cũng được: hàm tự quy về CCW trước khi xét, và trả chỉ số
/// theo vòng gốc.
pub fn reflex_vertex_indices(ring: &[PointMm], tol: &Tolerance) -> Vec<usize> {
    let count = ring.len();
    if count < 3 {
        return Vec::new();
    }
    let flipped = signed_area_mm2(ring) < 0.0;
    let threshold = cross_tolerance_mm2(ring, tol);
    let mut out = Vec::new();
    for index in 0..count {
        // Xét đỉnh `index` với hai đỉnh kề của nó.
        let previous = ring[(index + count - 1) % count];
        let current = ring[index];
        let next = ring[(index + 1) % count];
        let mut cross = turn_cross_mm2(previous, current, next);
        if flipped {
            cross = -cross;
        }
        if cross < -threshold {
            out.push(index);
        }
    }
    out
}

/// Vòng đã chuẩn về CCW (bản sao).
fn as_ccw(ring: &[PointMm]) -> Vec<PointMm> {
    let mut out = ring.to_vec();
    if signed_area_mm2(&out) < 0.0 {
        out.reverse();
    }
    out
}

/// Điểm có nằm trong vòng hay không, bằng ray casting.
///
/// Điểm nằm **đúng trên biên** cho kết quả không xác định — nơi gọi phải tự loại ca đó
/// (xem `collision::rings_overlap`, nó chỉ dùng đỉnh cách biên hơn dung sai).
pub fn point_in_ring(ring: &[PointMm], point: PointMm) -> bool {
    let count = ring.len();
    if count < 3 {
        return false;
    }
    let mut inside = false;
    for index in 0..count {
        let a = ring[index];
        let b = ring[(index + 1) % count];
        if (a.y > point.y) != (b.y > point.y) {
            let x_cross = (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
            if point.x < x_cross {
                inside = !inside;
            }
        }
    }
    inside
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tam giác hoá
// ─────────────────────────────────────────────────────────────────────────────

/// Tam giác hoá vòng đơn bằng ear clipping. Trả danh sách **chỉ số** vào vòng đã CCW.
///
/// Vòng phải là polygon đơn (không tự cắt) — `normalize.rs` đã bảo đảm điều đó.
/// Trả rỗng nếu không tam giác hoá được (dấu hiệu vòng chưa được làm sạch).
pub fn triangulate_indices(ring: &[PointMm], tol: &Tolerance) -> Vec<[usize; 3]> {
    let count = ring.len();
    if count < 3 {
        return Vec::new();
    }
    let ccw = as_ccw(ring);
    let threshold = cross_tolerance_mm2(&ccw, tol);
    let mut remaining: Vec<usize> = (0..count).collect();
    let mut triangles: Vec<[usize; 3]> = Vec::with_capacity(count.saturating_sub(2));

    // Mỗi vòng lặp cắt đúng một tai, nên số vòng lặp bị chặn bởi số đỉnh.
    let mut guard = count * 2;
    while remaining.len() > 3 && guard > 0 {
        guard -= 1;
        let size = remaining.len();
        let mut cut = None;
        for slot in 0..size {
            let ia = remaining[(slot + size - 1) % size];
            let ib = remaining[slot];
            let ic = remaining[(slot + 1) % size];
            if turn_cross_mm2(ccw[ia], ccw[ib], ccw[ic]) <= threshold {
                continue; // đỉnh lõm hoặc thẳng hàng, không phải tai
            }
            let mut clear = true;
            for &other in &remaining {
                if other == ia || other == ib || other == ic {
                    continue;
                }
                if point_in_triangle(ccw[ia], ccw[ib], ccw[ic], ccw[other], threshold) {
                    clear = false;
                    break;
                }
            }
            if clear {
                cut = Some((slot, [ia, ib, ic]));
                break;
            }
        }
        match cut {
            Some((slot, tri)) => {
                triangles.push(tri);
                remaining.remove(slot);
            }
            None => return Vec::new(), // không cắt được tai nào ⇒ vòng không hợp lệ
        }
    }
    if remaining.len() == 3 {
        triangles.push([remaining[0], remaining[1], remaining[2]]);
    }
    triangles
}

fn point_in_triangle(a: PointMm, b: PointMm, c: PointMm, p: PointMm, tol: f64) -> bool {
    let d1 = turn_cross_mm2(a, b, p);
    let d2 = turn_cross_mm2(b, c, p);
    let d3 = turn_cross_mm2(c, a, p);
    (d1 >= -tol && d2 >= -tol && d3 >= -tol) || (d1 <= tol && d2 <= tol && d3 <= tol)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phân rã lồi
// ─────────────────────────────────────────────────────────────────────────────

/// Phân rã một vòng đơn thành các mảnh **lồi**, chiều CCW.
///
/// Cách làm (Hertel–Mehlhorn): tam giác hoá trước, rồi **gộp** hai mảnh kề nhau bất cứ
/// khi nào bỏ đường chéo chung vẫn cho mảnh lồi. Cách này cho số mảnh không quá 4 lần
/// tối ưu, và với khuôn bế thật (ít đỉnh lõm) thường đạt đúng `r+1`.
///
/// Vòng đã lồi ⇒ trả về chính nó, một mảnh, không tam giác hoá vô ích.
pub fn convex_decompose(ring: &[PointMm], tol: &Tolerance) -> Vec<Vec<PointMm>> {
    if ring.len() < 3 {
        return Vec::new();
    }
    let ccw = as_ccw(ring);
    if is_convex_ring(&ccw, tol) {
        return vec![ccw];
    }
    let triangles = triangulate_indices(&ccw, tol);
    if triangles.is_empty() {
        return Vec::new();
    }

    let mut pieces: Vec<Vec<usize>> = triangles.iter().map(|t| t.to_vec()).collect();

    // Gộp tham lam cho tới khi không còn cặp nào gộp được mà vẫn lồi.
    loop {
        let mut merged_any = false;
        'outer: for left in 0..pieces.len() {
            for right in (left + 1)..pieces.len() {
                if let Some(candidate) = merge_if_convex(&pieces[left], &pieces[right], &ccw, tol) {
                    pieces[left] = candidate;
                    pieces.remove(right);
                    merged_any = true;
                    break 'outer;
                }
            }
        }
        if !merged_any {
            break;
        }
    }

    pieces
        .into_iter()
        .map(|indices| indices.into_iter().map(|i| ccw[i]).collect())
        .collect()
}

/// Gộp hai mảnh dọc cạnh chung nếu kết quả còn lồi.
///
/// Hai mảnh CCW kề nhau chia sẻ một cạnh theo **hai chiều ngược nhau**: mảnh trái có
/// cạnh có hướng `u→v`, mảnh phải có `v→u`. Ghép bằng cách đi hết biên mảnh trái từ `v`
/// về `u`, rồi đi hết biên mảnh phải từ `u` về `v`, bỏ hai đỉnh lặp ở chỗ nối.
fn merge_if_convex(
    left: &[usize],
    right: &[usize],
    ring: &[PointMm],
    tol: &Tolerance,
) -> Option<Vec<usize>> {
    let (ln, rn) = (left.len(), right.len());
    for li in 0..ln {
        let u = left[li];
        let v = left[(li + 1) % ln];
        for ri in 0..rn {
            if right[ri] != v || right[(ri + 1) % rn] != u {
                continue;
            }
            // Biên mảnh trái: v → … → u (đủ ln đỉnh, bắt đầu ở v).
            let mut merged: Vec<usize> = (0..ln).map(|k| left[(li + 1 + k) % ln]).collect();
            // Biên mảnh phải: u → … → v; bỏ đỉnh đầu (u, đã có) và đỉnh cuối (v, đã có).
            for k in 1..rn.saturating_sub(1) {
                merged.push(right[(ri + 1 + k) % rn]);
            }
            if merged.len() < 3 {
                return None;
            }
            let points: Vec<PointMm> = merged.iter().map(|i| ring[*i]).collect();
            if is_convex_ring(&points, tol) && signed_area_mm2(&points) > 0.0 {
                return Some(merged);
            }
            return None;
        }
    }
    None
}
