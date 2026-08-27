//! Sinh ứng viên góc và vị trí (P3b).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2, §11.3.
//!
//! ## Lấy mẫu là cơ chế tìm kiếm, KHÔNG phải miền hợp lệ
//!
//! Đây là chỗ dễ hiểu sai nhất của cả engine. Module này sinh ra một **tập hữu hạn** góc
//! và vị trí để thử. Điều đó **không** biến miền xoay thành một danh sách góc:
//!
//! - Miền hợp lệ vẫn là [`super::orientation::RotationDomain`], liên tục với `free`/`ranges`.
//! - Pose cuối cùng do [`super::refine`] tinh chỉnh **liên tục** quanh mẫu tốt nhất, nên
//!   kết quả thường KHÔNG phải một trong các mẫu ban đầu.
//! - `fast/balanced/tight` chỉ đổi **số lượng** mẫu, không đổi miền hợp lệ.
//!
//! ## Vì sao mẫu góc không nằm trên lưới
//!
//! Mẫu gồm hai loại. **Góc tới hạn** suy từ chính hình học: mỗi cạnh của chi tiết có một
//! góc làm cạnh đó song song với cạnh tờ, và hộp bao diện tích nhỏ nhất cho một góc nữa.
//! Đó là các góc mà layout thay đổi về chất, và chúng phụ thuộc hình dạng chứ không phải
//! một bước cố định. **Mẫu bổ sung** dùng dãy cộng dồn với bước vô tỉ (tỉ lệ vàng) nên
//! không bao giờ rơi vào một lưới góc; và vì nó đi từ seed, nó vẫn hoàn toàn xác định.

use std::cmp::Ordering;

use super::control::{derive_trial_seed, SearchEffort};
use super::model::{canonicalize_angle_deg, PointMm, Tolerance};
use super::normalize::NormalizedPart;
use super::orientation::{circular_distance_deg, RotationDomain};
use super::score::bottom_left_order;

/// Version của quy tắc sinh ứng viên. Đổi quy tắc là đổi layout.
pub const CANDIDATE_RULE_VERSION: u32 = 1;

/// Bước cộng dồn vô tỉ (phần lẻ của tỉ lệ vàng) cho dãy mẫu góc bổ sung.
///
/// Vì vô tỉ, dãy `frac(k · φ)` không tuần hoàn và không rơi vào bất kỳ lưới hữu hạn nào —
/// đó là điều phân biệt "lấy mẫu low-discrepancy" với "bước góc cố định".
const GOLDEN_INCREMENT: f64 = 0.618_033_988_749_894_9;

/// Thứ tự xử lý chi tiết. Nhiều thứ tự **ổn định** khác nhau để multi-start có cái để đổi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartOrder {
    /// Diện tích giảm dần — chi tiết to đặt trước.
    AreaDescending,
    /// Cạnh dài nhất giảm dần — tốt cho chi tiết dài mảnh.
    LongestExtentDescending,
    /// Độ lõm giảm dần (số đỉnh lõm) — chi tiết khó đặt trước.
    ConcavityDescending,
    /// Gom theo số lượng: loại nhiều con trước, để chúng lát nền đều.
    QuantityDescending,
}

impl PartOrder {
    /// Tất cả thứ tự, dùng cho multi-start.
    pub const ALL: [PartOrder; 4] = [
        Self::AreaDescending,
        Self::LongestExtentDescending,
        Self::ConcavityDescending,
        Self::QuantityDescending,
    ];
}

/// Sắp chi tiết theo một thứ tự ổn định.
///
/// Mọi thứ tự đều tie-break bằng `partId` nên kết quả **xác định** kể cả khi hai chi tiết
/// bằng nhau ở tiêu chí chính.
pub fn order_parts<'a>(
    parts: &'a [NormalizedPart],
    order: PartOrder,
    tol: &Tolerance,
) -> Vec<&'a NormalizedPart> {
    let mut out: Vec<&NormalizedPart> = parts.iter().collect();
    out.sort_by(|a, b| {
        let primary = match order {
            PartOrder::AreaDescending => cmp_desc(a.effective_area_mm2(), b.effective_area_mm2()),
            PartOrder::LongestExtentDescending => cmp_desc(
                a.bounds.width_mm().max(a.bounds.height_mm()),
                b.bounds.width_mm().max(b.bounds.height_mm()),
            ),
            PartOrder::ConcavityDescending => {
                let ca = super::geometry::reflex_vertex_indices(&a.outer, tol).len();
                let cb = super::geometry::reflex_vertex_indices(&b.outer, tol).len();
                cb.cmp(&ca)
            }
            PartOrder::QuantityDescending => b.quantity.cmp(&a.quantity),
        };
        primary.then(a.part_id.cmp(&b.part_id))
    });
    out
}

fn cmp_desc(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}

/// Góc ứng viên cho một chi tiết.
///
/// Thứ tự trả về: **góc tới hạn trước, mẫu bổ sung sau**. Nhờ vậy khi work budget cạn
/// giữa đường, phần đã thử là phần có nhiều thông tin hình học nhất.
///
/// Luôn lọc theo miền hợp lệ: hàm này không bao giờ đề xuất một góc mà người dùng đã cấm.
pub fn candidate_angles(
    part: &NormalizedPart,
    effort: SearchEffort,
    seed: u64,
    tol: &Tolerance,
) -> Vec<f64> {
    let domain = &part.rotation_domain;
    let budget = effort.orientation_proposals_per_part.max(1) as usize;
    let mut out: Vec<f64> = Vec::with_capacity(budget);

    let push = |angle: f64, out: &mut Vec<f64>| {
        let Some(canon) = canonicalize_angle_deg(angle, tol) else {
            return;
        };
        if !domain.contains(canon, tol) {
            return;
        }
        if out
            .iter()
            .any(|kept| circular_distance_deg(*kept, canon) <= tol.angular_deg)
        {
            return;
        }
        out.push(canon);
    };

    // ── 1. Biên của miền: với `fixed`/`discrete` đây là toàn bộ miền ──
    match domain {
        RotationDomain::Discrete(angles) => {
            for angle in angles {
                push(*angle, &mut out);
            }
        }
        RotationDomain::Arcs(arcs) => {
            for arc in arcs {
                push(arc.start_deg, &mut out);
                push(arc.end_deg, &mut out);
                push((arc.start_deg + arc.end_deg) / 2.0, &mut out);
            }
        }
        RotationDomain::Full => {}
    }

    // Miền rời rạc thì hết việc: không có gì để lấy mẫu thêm.
    if !domain.is_continuous() {
        out.truncate(budget);
        return out;
    }

    // ── 2. Góc tới hạn từ chính hình học ──
    // Mỗi cạnh có một góc xoay làm cạnh đó song song trục X, và một góc nữa cho trục Y.
    // Đây là các góc mà chi tiết "nằm phẳng" vào biên tờ hoặc vào cạnh chi tiết khác.
    for index in 0..part.outer.len() {
        if out.len() >= budget {
            break;
        }
        let from = part.outer[index];
        let to = part.outer[(index + 1) % part.outer.len()];
        let edge = (to.y - from.y).atan2(to.x - from.x).to_degrees();
        push(-edge, &mut out);
        push(-edge + 90.0, &mut out);
    }

    // ── 3. Góc của hộp bao diện tích nhỏ nhất ──
    if let Some(angle) = min_area_box_angle_deg(&part.outer) {
        push(angle, &mut out);
        push(angle + 90.0, &mut out);
    }

    // ── 4. Preset cardinal nếu còn hợp lệ ──
    for cardinal in [0.0, 90.0, 180.0, 270.0] {
        if out.len() >= budget {
            break;
        }
        push(cardinal, &mut out);
    }

    // ── 5. Mẫu bổ sung low-discrepancy, dẫn xuất từ seed ──
    // Không dùng bước cố định: bước là số vô tỉ nên mẫu không nằm trên lưới nào.
    let mut cursor = seed_fraction(seed, part.part_id.as_bytes());
    let mut guard = 0usize;
    while out.len() < budget && guard < budget * 16 {
        guard += 1;
        cursor = (cursor + GOLDEN_INCREMENT).fract();
        push(sample_domain(domain, cursor), &mut out);
    }

    out.truncate(budget);
    out
}

/// Lấy một góc trong miền theo tham số `t ∈ [0,1)`.
fn sample_domain(domain: &RotationDomain, t: f64) -> f64 {
    match domain {
        RotationDomain::Full => t * 360.0,
        RotationDomain::Arcs(arcs) => {
            let total: f64 = arcs.iter().map(|arc| arc.end_deg - arc.start_deg).sum();
            if total <= 0.0 {
                return arcs.first().map(|arc| arc.start_deg).unwrap_or(0.0);
            }
            let mut target = t * total;
            for arc in arcs {
                let span = arc.end_deg - arc.start_deg;
                if target <= span {
                    return arc.start_deg + target;
                }
                target -= span;
            }
            arcs.last().map(|arc| arc.end_deg).unwrap_or(0.0)
        }
        RotationDomain::Discrete(angles) => angles.first().copied().unwrap_or(0.0),
    }
}

/// Phần lẻ khởi đầu của dãy mẫu, dẫn xuất xác định từ seed và mã chi tiết.
///
/// Trộn mã chi tiết vào để hai chi tiết khác nhau không lấy cùng một dãy góc — nếu không,
/// multi-start mất một chiều đa dạng mà không ai thấy.
fn seed_fraction(seed: u64, part_id: &[u8]) -> f64 {
    let mut mixed = seed;
    for byte in part_id {
        mixed = derive_trial_seed(mixed, u64::from(*byte) + 1);
    }
    // 53 bit cao nhất cho một `f64` trong `[0,1)`.
    (mixed >> 11) as f64 / (1u64 << 53) as f64
}

/// Góc của hộp bao diện tích nhỏ nhất, degree.
///
/// Theo định lý rotating calipers, hộp bao nhỏ nhất của một đa giác lồi có một cạnh trùng
/// cạnh của đa giác. Ở đây quét mọi cạnh của contour (kể cả lõm) — không phải cực tiểu
/// toàn cục cho hình lõm, nhưng vẫn là một góc tới hạn tốt và chi phí `O(n²)` chấp nhận
/// được vì chỉ tính một lần cho mỗi chi tiết.
pub fn min_area_box_angle_deg(ring: &[PointMm]) -> Option<f64> {
    if ring.len() < 3 {
        return None;
    }
    let mut best: Option<(f64, f64)> = None; // (diện tích, góc)
    for index in 0..ring.len() {
        let from = ring[index];
        let to = ring[(index + 1) % ring.len()];
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let length = (dx * dx + dy * dy).sqrt();
        if length <= f64::EPSILON {
            continue;
        }
        let (ux, uy) = (dx / length, dy / length);
        let (mut lo_u, mut hi_u, mut lo_v, mut hi_v) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for point in ring {
            let u = point.x * ux + point.y * uy;
            let v = -point.x * uy + point.y * ux;
            lo_u = lo_u.min(u);
            hi_u = hi_u.max(u);
            lo_v = lo_v.min(v);
            hi_v = hi_v.max(v);
        }
        let area = (hi_u - lo_u) * (hi_v - lo_v);
        if best.is_none_or(|(current, _)| area < current) {
            // Xoay `-atan2(dy,dx)` làm cạnh này song song trục X.
            best = Some((area, -dy.atan2(dx).to_degrees()));
        }
    }
    best.map(|(_, angle)| angle)
}

/// Vị trí ứng viên lấy từ **đỉnh của miền vị trí hợp lệ**.
///
/// Đỉnh của `IFP \ ∪NFP` là điểm tiếp xúc thật: ở đó chi tiết chạm biên tờ hoặc chạm một
/// chi tiết đã đặt. Đó là các vị trí chặt nhất. Đây **không** phải lưới toạ độ — số ứng
/// viên tỉ lệ với độ phức tạp hình học, không tỉ lệ với diện tích tờ.
///
/// Sắp theo thứ tự Bottom-Left xác định rồi gộp các điểm cách nhau dưới dung sai.
pub fn translation_candidates(
    region: &[Vec<PointMm>],
    effort: SearchEffort,
    tol: &Tolerance,
) -> Vec<PointMm> {
    let mut out = super::nfp::region_vertices(region);
    out.sort_by(|a, b| bottom_left_order(*a, *b));
    out.dedup_by(|a, b| (a.x - b.x).abs() <= tol.linear_mm && (a.y - b.y).abs() <= tol.linear_mm);
    // Beam width điều tiết số vị trí xét cho mỗi góc; đây là work budget, không phải
    // giới hạn hình học.
    let budget = (effort.beam_width.max(1) as usize).saturating_mul(4);
    out.truncate(budget.max(1));
    out
}

/// Trung điểm các cạnh của miền hợp lệ — ứng viên bổ sung cho ca miền có cạnh dài.
///
/// Đỉnh miền là điểm tiếp xúc **hai** ràng buộc; trung điểm cạnh là nơi chỉ tiếp xúc
/// **một** ràng buộc, đôi khi cho phương án chặt hơn khi hình lõm cài vào nhau.
pub fn edge_midpoint_candidates(region: &[Vec<PointMm>], tol: &Tolerance) -> Vec<PointMm> {
    let mut out: Vec<PointMm> = Vec::new();
    for ring in region {
        for index in 0..ring.len() {
            let a = ring[index];
            let b = ring[(index + 1) % ring.len()];
            out.push(PointMm::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0));
        }
    }
    out.sort_by(|a, b| bottom_left_order(*a, *b));
    out.dedup_by(|a, b| (a.x - b.x).abs() <= tol.linear_mm && (a.y - b.y).abs() <= tol.linear_mm);
    out
}
