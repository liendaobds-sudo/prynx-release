//! Va chạm và khoảng hở theo contour thật (P2b).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §3.3, §11.2, §11.6.
//!
//! ## Đây là quan toà, không phải bộ tăng tốc
//!
//! Kế hoạch §11.2 ghi: "NFP/IFP là bộ sinh candidate và broad-phase accelerator; final
//! validator không gọi lại NFP làm authority." Module này là **authority** đó.
//!
//! Vì vậy nó cố ý **không** import [`super::kernel`], **không** import `nfp`, và không
//! dùng bất kỳ cache nào của solver. Toàn bộ phán quyết dựa trên phép đo trực tiếp
//! giữa các đoạn thẳng của contour đã transform. Nhờ độc lập như vậy, một lỗi trong
//! kernel hay trong NFP không thể tự bào chữa cho chính nó ở bước validate.
//!
//! ## Quy ước dung sai
//!
//! Mọi ngưỡng đều quy về **khoảng cách mm**, không dùng hằng số diện tích. Tích có
//! hướng có đơn vị mm² và bằng `khoảng cách × độ dài`, nên ngưỡng phải nhân với độ dài
//! của đúng đoạn đang làm đường tham chiếu. Dùng một hằng số chung sẽ kiểm tem 5 mm
//! quá lỏng và kiểm khuôn 700 mm quá chặt.
//!
//! ## Chạm biên được phép
//!
//! `gap = 0` là hợp lệ và có thật trong ngành in (§4.1: gutter 0 dùng common cut-line).
//! Vì vậy **chạm biên không phải chồng lấn**: [`rings_overlap`] chỉ báo `true` khi phần
//! *trong* của hai hình giao nhau.

use super::model::{PointMm, SheetAxisClearanceMm, Tolerance};
use super::normalize::BoundsMm;

/// Khoảng cách hai điểm, mm.
pub fn distance_mm(a: PointMm, b: PointMm) -> f64 {
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}

fn cross_mm2(o: PointMm, a: PointMm, b: PointMm) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/// Khoảng cách từ điểm tới đoạn thẳng, mm.
pub fn point_to_segment_mm(point: PointMm, a: PointMm, b: PointMm) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length_sq = dx * dx + dy * dy;
    if length_sq <= 0.0 {
        return distance_mm(point, a);
    }
    let t = (((point.x - a.x) * dx + (point.y - a.y) * dy) / length_sq).clamp(0.0, 1.0);
    distance_mm(point, PointMm::new(a.x + t * dx, a.y + t * dy))
}

/// Hai đoạn thẳng có cắt nhau **thực sự** (mỗi đoạn nằm hai bên đường của đoạn kia).
///
/// Chạm đầu mút hoặc trùng một phần **không** tính là cắt — hai việc đó do
/// [`segment_distance_mm`] và [`rings_overlap`] xử lý riêng.
pub fn segments_properly_cross(
    p1: PointMm,
    p2: PointMm,
    q1: PointMm,
    q2: PointMm,
    tol: &Tolerance,
) -> bool {
    let tol_p = tol.linear_mm * distance_mm(p1, p2).max(tol.linear_mm);
    let tol_q = tol.linear_mm * distance_mm(q1, q2).max(tol.linear_mm);
    let sign = |value: f64, threshold: f64| -> i32 {
        if value > threshold {
            1
        } else if value < -threshold {
            -1
        } else {
            0
        }
    };
    let d1 = sign(cross_mm2(q1, q2, p1), tol_q);
    let d2 = sign(cross_mm2(q1, q2, p2), tol_q);
    let d3 = sign(cross_mm2(p1, p2, q1), tol_p);
    let d4 = sign(cross_mm2(p1, p2, q2), tol_p);
    d1 * d2 < 0 && d3 * d4 < 0
}

/// Khoảng cách nhỏ nhất giữa hai đoạn thẳng, mm. `0` khi chúng cắt hoặc chạm nhau.
pub fn segment_distance_mm(p1: PointMm, p2: PointMm, q1: PointMm, q2: PointMm) -> f64 {
    // Cắt nhau thì khoảng cách bằng 0; kiểm bằng dấu tích có hướng không cần dung sai
    // vì ở đây chỉ cần biết có giao hay không.
    let d1 = cross_mm2(q1, q2, p1);
    let d2 = cross_mm2(q1, q2, p2);
    let d3 = cross_mm2(p1, p2, q1);
    let d4 = cross_mm2(p1, p2, q2);
    if ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0)) {
        return 0.0;
    }
    point_to_segment_mm(p1, q1, q2)
        .min(point_to_segment_mm(p2, q1, q2))
        .min(point_to_segment_mm(q1, p1, p2))
        .min(point_to_segment_mm(q2, p1, p2))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Broad phase
// ─────────────────────────────────────────────────────────────────────────────

/// Hai hộp bao có thể giao nhau hay không. Dùng để loại nhanh cặp chắc chắn rời.
///
/// Chỉ là **broad phase**: `true` không có nghĩa là hai contour chồng nhau.
pub fn bounds_may_touch(a: &BoundsMm, b: &BoundsMm, tol: &Tolerance) -> bool {
    a.min_x <= b.max_x + tol.linear_mm
        && b.min_x <= a.max_x + tol.linear_mm
        && a.min_y <= b.max_y + tol.linear_mm
        && b.min_y <= a.max_y + tol.linear_mm
}

/// Khoảng hở giữa hai hộp bao, mm. `0` khi chúng giao nhau.
///
/// Đây là **chặn dưới** của khoảng cách contour thật, nên dùng được để loại sớm:
/// nếu khoảng hở bbox đã lớn hơn `gap` thì khỏi cần đo contour.
pub fn bounds_gap_mm(a: &BoundsMm, b: &BoundsMm) -> f64 {
    let dx = (b.min_x - a.max_x).max(a.min_x - b.max_x).max(0.0);
    let dy = (b.min_y - a.max_y).max(a.min_y - b.max_y).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Narrow phase — phán quyết
// ─────────────────────────────────────────────────────────────────────────────

/// Phần **trong** của hai vòng có giao nhau hay không.
///
/// Chạm biên **không** tính là chồng: `gap = 0` với common cut-line là hợp lệ.
///
/// ## Vì sao không dùng "đỉnh nào nằm trong hình kia"
///
/// Cách đó sai ở cấu hình rất phổ biến trong ngành in: hai chữ nhật **cùng chiều cao**
/// đặt lệch nhau chồng lên nhau thật, nhưng biên của chúng chỉ **chạm** chứ không cắt
/// ngang (mọi giao điểm rơi đúng vào đỉnh nằm trên cạnh đối phương), và mọi đỉnh của
/// hình này đều nằm ngoài hoặc nằm đúng trên biên hình kia. Kết luận theo đỉnh sẽ báo
/// "không chồng" — tức bỏ qua một layout hỏng. Đã mắc đúng lỗi này một lần trong lượt
/// P2b, test `chong_lan_phan_biet_duoc_ba_truong_hop` là chốt chống lặp lại.
///
/// ## Cách làm đúng
///
/// Phán quyết bằng **trục phân cách** trên các mảnh lồi:
/// 1. Loại nhanh bằng hộp bao.
/// 2. Có cạnh cắt ngang thực sự ⇒ chồng (đường tắt, không cần phân rã).
/// 3. Còn lại: phân rã lồi hai hình rồi tìm trục phân cách cho từng cặp mảnh. Hai tập
///    lồi giao nhau ở phần trong **khi và chỉ khi** không tồn tại trục phân cách — kết
///    luận này đúng ở mọi cấu hình suy biến, kể cả trùng cạnh và chạm đỉnh.
///
/// Hình đã lồi thì bỏ hẳn bước phân rã (chi phí `O(n+m)`), nên ca phổ biến nhất cũng
/// là ca nhanh nhất.
pub fn rings_overlap(a: &[PointMm], b: &[PointMm], tol: &Tolerance) -> bool {
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    // Bước 1 — loại nhanh bằng hộp bao.
    match (BoundsMm::from_ring(a), BoundsMm::from_ring(b)) {
        (Some(ba), Some(bb)) => {
            if !bounds_may_touch(&ba, &bb, tol) {
                return false;
            }
        }
        _ => return false, // toạ độ không hữu hạn
    }

    // Bước 2 — cạnh cắt ngang thực sự thì chắc chắn chồng.
    for i in 0..a.len() {
        let (a1, a2) = (a[i], a[(i + 1) % a.len()]);
        for j in 0..b.len() {
            let (b1, b2) = (b[j], b[(j + 1) % b.len()]);
            if segments_properly_cross(a1, a2, b1, b2, tol) {
                return true;
            }
        }
    }

    // Bước 3 — trục phân cách trên các mảnh lồi.
    let convex_a = super::geometry::is_convex_ring(a, tol);
    let convex_b = super::geometry::is_convex_ring(b, tol);
    if convex_a && convex_b {
        return !separating_axis_exists(a, b, tol);
    }

    let pieces_a = convex_pieces(a, convex_a, tol);
    let pieces_b = convex_pieces(b, convex_b, tol);
    // Không phân rã được nghĩa là contour chưa qua `normalize.rs`. Quan toà không được
    // "tha" khi không chứng minh được an toàn, nên báo chồng.
    if pieces_a.is_empty() || pieces_b.is_empty() {
        return true;
    }
    for piece_a in &pieces_a {
        let box_a = BoundsMm::from_ring(piece_a);
        for piece_b in &pieces_b {
            if let (Some(ba), Some(bb)) = (box_a, BoundsMm::from_ring(piece_b)) {
                if !bounds_may_touch(&ba, &bb, tol) {
                    continue;
                }
            }
            if !separating_axis_exists(piece_a, piece_b, tol) {
                return true;
            }
        }
    }
    false
}

fn convex_pieces(ring: &[PointMm], already_convex: bool, tol: &Tolerance) -> Vec<Vec<PointMm>> {
    if already_convex {
        vec![ring.to_vec()]
    } else {
        super::geometry::convex_decompose(ring, tol)
    }
}

/// Có tồn tại trục phân cách giữa hai đa giác **lồi** hay không.
///
/// Chỉ cần thử pháp tuyến của các cạnh của cả hai hình (định lý trục phân cách cho đa
/// giác lồi). Pháp tuyến được chuẩn hoá về độ dài 1 nên dung sai chiếu là **khoảng cách
/// mm** thật, không phụ thuộc độ dài cạnh.
///
/// Hai hình **chạm** nhau (hình chiếu kề nhau) được coi là **có** trục phân cách, đúng
/// với quy ước "chạm biên không phải chồng".
fn separating_axis_exists(a: &[PointMm], b: &[PointMm], tol: &Tolerance) -> bool {
    for ring in [a, b] {
        for index in 0..ring.len() {
            let from = ring[index];
            let to = ring[(index + 1) % ring.len()];
            let edge_x = to.x - from.x;
            let edge_y = to.y - from.y;
            let length = (edge_x * edge_x + edge_y * edge_y).sqrt();
            if length <= tol.linear_mm {
                continue; // cạnh suy biến, không cho trục nào
            }
            let axis_x = -edge_y / length;
            let axis_y = edge_x / length;
            let (a_min, a_max) = project_onto(a, axis_x, axis_y);
            let (b_min, b_max) = project_onto(b, axis_x, axis_y);
            if a_max <= b_min + tol.linear_mm || b_max <= a_min + tol.linear_mm {
                return true;
            }
        }
    }
    false
}

fn project_onto(ring: &[PointMm], axis_x: f64, axis_y: f64) -> (f64, f64) {
    let mut low = f64::MAX;
    let mut high = f64::MIN;
    for point in ring {
        let value = point.x * axis_x + point.y * axis_y;
        low = low.min(value);
        high = high.max(value);
    }
    (low, high)
}

/// Khoảng cách nhỏ nhất giữa hai contour, mm. `0` khi chồng hoặc chạm nhau.
pub fn min_distance_mm(a: &[PointMm], b: &[PointMm], tol: &Tolerance) -> f64 {
    min_distance_disjoint_mm(a, b, tol, false)
}

/// Khoảng cách nhỏ nhất khi caller đã biết hai vòng không chồng nhau.
///
/// PERF (audit 2026-08-30 §NEST-D1-A): `judge_pair` vừa gọi `rings_overlap`; gọi
/// lại qua `min_distance_mm` làm lặp toàn bộ phép cạnh-cạnh/SAT của đúng một cặp.
/// Helper private này chỉ bỏ lần phán quyết trùng; API công khai vẫn tự kiểm đầy đủ.
fn min_distance_disjoint_mm(
    a: &[PointMm],
    b: &[PointMm],
    tol: &Tolerance,
    known_disjoint: bool,
) -> f64 {
    if a.len() < 3 || b.len() < 3 {
        return f64::INFINITY;
    }
    if !known_disjoint && rings_overlap(a, b, tol) {
        return 0.0;
    }
    let mut best = f64::MAX;
    for i in 0..a.len() {
        let (a1, a2) = (a[i], a[(i + 1) % a.len()]);
        for j in 0..b.len() {
            let (b1, b2) = (b[j], b[(j + 1) % b.len()]);
            best = best.min(segment_distance_mm(a1, a2, b1, b2));
            if best <= 0.0 {
                return 0.0;
            }
        }
    }
    best
}

/// Kết luận về một cặp chi tiết.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PairVerdict {
    /// Phần trong giao nhau — luôn là lỗi.
    Overlap,
    /// Không chồng nhưng khoảng hở nhỏ hơn `gapMm` đã khai.
    ClearanceTooSmall { measured_mm: f64, required_mm: f64 },
    /// Đạt.
    Ok { measured_mm: f64 },
}

impl PairVerdict {
    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

/// Phán quyết một cặp contour theo khoảng hở tối thiểu đã khai.
///
/// `gap_mm = 0` ⇒ chạm biên vẫn đạt (common cut-line). Với `gap_mm > 0`, sai lệch
/// trong đúng một dung sai tuyến tính được tha, để hai chi tiết đặt sát đúng `gap`
/// không bị loại vì nhiễu `f64`.
pub fn judge_pair(a: &[PointMm], b: &[PointMm], gap_mm: f64, tol: &Tolerance) -> PairVerdict {
    if rings_overlap(a, b, tol) {
        return PairVerdict::Overlap;
    }
    let measured = min_distance_disjoint_mm(a, b, tol, true);
    if measured + tol.linear_mm < gap_mm {
        return PairVerdict::ClearanceTooSmall {
            measured_mm: measured,
            required_mm: gap_mm,
        };
    }
    PairVerdict::Ok {
        measured_mm: measured,
    }
}

/// Phán quyết clearance dị hướng theo trục tờ bằng Minkowski rectangle.
///
/// Với mỗi trục phân cách `n`, support của rectangle clearance là
/// `gapX*|n.x| + gapY*|n.y|`. Các trục được xét sau khi pose đã áp vào contour, nên
/// không có lỗi xoay một footprint đã nở theo local-space. Hình lõm được phân rã và
/// mọi cặp mảnh lồi đều phải đạt; phân rã lỗi thì fail-closed.
pub fn judge_pair_sheet_axis(
    a: &[PointMm],
    b: &[PointMm],
    clearance: SheetAxisClearanceMm,
    tol: &Tolerance,
) -> PairVerdict {
    if rings_overlap(a, b, tol) {
        return PairVerdict::Overlap;
    }
    let measured = min_distance_mm(a, b, tol);
    if clearance.x_mm <= tol.linear_mm && clearance.y_mm <= tol.linear_mm {
        return PairVerdict::Ok {
            measured_mm: measured,
        };
    }

    let convex_a = super::geometry::is_convex_ring(a, tol);
    let convex_b = super::geometry::is_convex_ring(b, tol);
    let pieces_a = convex_pieces(a, convex_a, tol);
    let pieces_b = convex_pieces(b, convex_b, tol);
    let safe = !pieces_a.is_empty()
        && !pieces_b.is_empty()
        && pieces_a.iter().all(|piece_a| {
            pieces_b
                .iter()
                .all(|piece_b| clearance_separating_axis_exists(piece_a, piece_b, clearance, tol))
        });
    if safe {
        PairVerdict::Ok {
            measured_mm: measured,
        }
    } else {
        PairVerdict::ClearanceTooSmall {
            measured_mm: measured,
            required_mm: clearance.max_axis_mm(),
        }
    }
}

fn clearance_separating_axis_exists(
    a: &[PointMm],
    b: &[PointMm],
    clearance: SheetAxisClearanceMm,
    tol: &Tolerance,
) -> bool {
    if axis_has_required_separation(a, b, 1.0, 0.0, clearance, tol)
        || axis_has_required_separation(a, b, 0.0, 1.0, clearance, tol)
    {
        return true;
    }
    for ring in [a, b] {
        for index in 0..ring.len() {
            let from = ring[index];
            let to = ring[(index + 1) % ring.len()];
            let edge_x = to.x - from.x;
            let edge_y = to.y - from.y;
            let length = edge_x.hypot(edge_y);
            if length <= tol.linear_mm {
                continue;
            }
            if axis_has_required_separation(a, b, -edge_y / length, edge_x / length, clearance, tol)
            {
                return true;
            }
        }
    }
    false
}

fn axis_has_required_separation(
    a: &[PointMm],
    b: &[PointMm],
    axis_x: f64,
    axis_y: f64,
    clearance: SheetAxisClearanceMm,
    tol: &Tolerance,
) -> bool {
    let (a_min, a_max) = project_onto(a, axis_x, axis_y);
    let (b_min, b_max) = project_onto(b, axis_x, axis_y);
    let separation = if a_max <= b_min + tol.linear_mm {
        b_min - a_max
    } else if b_max <= a_min + tol.linear_mm {
        a_min - b_max
    } else {
        return false;
    };
    let required = clearance.x_mm * axis_x.abs() + clearance.y_mm * axis_y.abs();
    separation + tol.linear_mm >= required
}

/// Contour có nằm hẳn trong vùng dùng được của tờ hay không.
///
/// Chỉ cần kiểm từng đỉnh: vùng dùng được là hình chữ nhật lồi, nên nếu mọi đỉnh nằm
/// trong thì mọi cạnh cũng nằm trong.
pub fn ring_within_bounds(ring: &[PointMm], bounds: &BoundsMm, tol: &Tolerance) -> bool {
    if ring.len() < 3 {
        return false;
    }
    ring.iter().all(|point| {
        point.is_finite()
            && point.x >= bounds.min_x - tol.linear_mm
            && point.x <= bounds.max_x + tol.linear_mm
            && point.y >= bounds.min_y - tol.linear_mm
            && point.y <= bounds.max_y + tol.linear_mm
    })
}

/// Khoảng cách nhỏ nhất từ contour ra ngoài vùng dùng được, mm.
///
/// Số **âm** nghĩa là đã tràn ra ngoài, và trị tuyệt đối là mức tràn sâu nhất — dùng
/// cho thông báo lỗi nói được "tràn lề bao nhiêu" thay vì chỉ "sai".
pub fn signed_margin_to_bounds_mm(ring: &[PointMm], bounds: &BoundsMm) -> f64 {
    let mut worst = f64::MAX;
    for point in ring {
        worst = worst
            .min(point.x - bounds.min_x)
            .min(bounds.max_x - point.x)
            .min(point.y - bounds.min_y)
            .min(bounds.max_y - point.y);
    }
    if worst == f64::MAX {
        0.0
    } else {
        worst
    }
}
