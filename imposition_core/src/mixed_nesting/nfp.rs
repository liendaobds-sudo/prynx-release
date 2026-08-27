//! No-Fit Polygon và Inner-Fit Polygon cho `mixed_nesting` (P2c).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.1 (kèm
//! AMENDMENT sau spike P2b0), §11.2.
//!
//! **Không liên quan tới `imposition_core/src/nfp.rs` cũ.** File cũ là phép toán cặp
//! polygon của solver bình tem, thuộc danh sách cấm sửa; module này không import và
//! không gọi nó.
//!
//! ## Hợp đồng
//!
//! ```text
//! NFP(A, B) = { t : A ∩ (t + B) ≠ ∅ }   = A ⊕ (−B)
//! IFP(S, B) = { t : (t + B) ⊆ S }
//! ```
//!
//! Trong đó `t` là vị trí đặt **điểm tham chiếu** của `B`. Vì `B` đã được xoay trước
//! khi vào đây, `NFP` phụ thuộc góc — nên mỗi góc là một NFP khác.
//!
//! Miền đặt hợp lệ của một chi tiết:
//!
//! ```text
//! feasibleXY(theta) = IFP(usable, R(theta)B) \ ∪ NFP(A_i, R(theta)B)
//! ```
//!
//! ## Đây là bộ sinh ứng viên, KHÔNG phải quan toà
//!
//! §11.2 ghi rõ: "NFP/IFP là bộ sinh candidate và broad-phase accelerator; final
//! validator không gọi lại NFP làm authority." Vì vậy sai số của module này chỉ làm
//! **mất** ứng viên tốt, không thể làm một layout xấu được công bố —
//! [`super::validator`] và [`super::collision`] mới là chốt cuối.
//!
//! ## Cách dựng, và vì sao không dùng Minkowski của kernel
//!
//! Spike P2b0 đo được `minkowski_sum`/`minkowski_diff` của Clipper2 sai trên 5/6 ca
//! lồi ở cả bản Rust lẫn bản C++ gốc. Đường đúng:
//!
//! 1. Phân rã lồi cả `A` và `−B` ([`super::geometry::convex_decompose`]).
//! 2. Minkowski từng cặp mảnh lồi ([`super::kernel::minkowski_convex`]) — chính xác.
//! 3. Hợp nhất mọi cặp bằng boolean union của kernel.
//!
//! Minkowski phân phối trên phép hợp ở cả hai đối số, nên
//! `(∪A_i) ⊕ (∪B_j) = ∪(i,j) (A_i ⊕ B_j)` — bước 3 là đúng, không phải xấp xỉ.

use super::collision::bounds_may_touch;
use super::geometry::convex_decompose;
use super::kernel::{difference, intersection, minkowski_convex, union_many, KernelError};
use super::model::{PointMm, Tolerance};
use super::normalize::BoundsMm;
use super::transform::signed_area_mm2;

/// Version của quy tắc dựng NFP/IFP. Đổi cách dựng là đổi ứng viên ⇒ đổi layout.
pub const NFP_RULE_VERSION: u32 = 1;

/// Trần số cặp mảnh lồi cho một phép NFP.
///
/// Chặn chi phí ở ca bệnh lý (contour hàng trăm đỉnh lõm). Vượt trần thì trả lỗi để
/// nơi gọi rơi về đường ứng viên khác, thay vì treo máy — mất ứng viên là chấp nhận
/// được, treo thì không.
pub const MAX_CONVEX_PAIRS: usize = 4_096;

/// Lỗi khi dựng NFP/IFP.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NfpError {
    /// Không phân rã lồi được (contour chưa qua `normalize.rs`).
    DecompositionFailed,
    /// Số cặp mảnh lồi vượt [`MAX_CONVEX_PAIRS`].
    TooManyConvexPairs { pairs: usize },
    /// Lỗi từ kernel.
    Kernel(KernelError),
}

impl NfpError {
    pub fn code(self) -> &'static str {
        match self {
            Self::DecompositionFailed => "NFP_DECOMPOSITION_FAILED",
            Self::TooManyConvexPairs { .. } => "NFP_TOO_MANY_CONVEX_PAIRS",
            Self::Kernel(inner) => inner.code(),
        }
    }

    pub fn message_vi(self) -> &'static str {
        match self {
            Self::DecompositionFailed => "Không phân rã được nét cắt thành các mảnh lồi.",
            Self::TooManyConvexPairs { .. } => {
                "Nét cắt quá phức tạp để dựng vùng lồng ghép — hãy giản lược contour."
            }
            Self::Kernel(inner) => inner.message_vi(),
        }
    }
}

impl From<KernelError> for NfpError {
    fn from(value: KernelError) -> Self {
        Self::Kernel(value)
    }
}

/// Vòng của một vùng, mm. Vòng dương là biên ngoài, âm là lỗ.
pub type RegionMm = Vec<Vec<PointMm>>;

/// Lật dấu contour: `−B`. Giữ nguyên thứ tự đỉnh nên chiều vòng bị đảo — đó là hệ quả
/// đúng của phép đối xứng tâm, không phải lật gương của một chi tiết thật.
fn negate(ring: &[PointMm]) -> Vec<PointMm> {
    ring.iter().map(|p| PointMm::new(-p.x, -p.y)).collect()
}

/// Phân rã có phủ đúng hình gốc hay không: tổng diện tích mảnh phải bằng diện tích vòng.
///
/// Đây là **chốt toàn vẹn rẻ** (chỉ tốn một lượt qua các đỉnh, và các mảnh đã có sẵn).
/// Nó bắt được đúng loại rác quan trọng nhất: `normalize.rs` bảo đảm contour là polygon
/// đơn, nhưng `no_fit_polygon` là API công khai và ear clipping vẫn "cắt ra tam giác"
/// cho một vòng tự cắt — khi đó tổng diện tích mảnh lệch hẳn khỏi diện tích vòng. Không
/// chạy lại phép dò tự cắt `O(n log n)` ở đây vì NFP nằm trong vòng nóng của solver.
fn decomposition_covers(ring: &[PointMm], pieces: &[Vec<PointMm>], tol: &Tolerance) -> bool {
    if pieces.is_empty() {
        return false;
    }
    let expected = signed_area_mm2(ring).abs();
    if expected <= 0.0 {
        return false;
    }
    let total: f64 = pieces
        .iter()
        .map(|piece| signed_area_mm2(piece).abs())
        .sum();
    (total - expected).abs() <= tol.linear_mm * expected.max(1.0)
}

/// `NFP(A, B) = A ⊕ (−B)` — tập vị trí đặt điểm tham chiếu của `B` làm `B` **chạm hoặc
/// chồng** `A`.
///
/// `B` phải đã được xoay về góc đang thử trước khi gọi.
pub fn no_fit_polygon(
    stationary: &[PointMm],
    moving: &[PointMm],
    tol: &Tolerance,
) -> Result<RegionMm, NfpError> {
    let negated = negate(moving);
    let pieces_a = convex_decompose(stationary, tol);
    let pieces_b = convex_decompose(&negated, tol);
    if !decomposition_covers(stationary, &pieces_a, tol)
        || !decomposition_covers(&negated, &pieces_b, tol)
    {
        return Err(NfpError::DecompositionFailed);
    }
    let pairs = pieces_a.len() * pieces_b.len();
    if pairs > MAX_CONVEX_PAIRS {
        return Err(NfpError::TooManyConvexPairs { pairs });
    }

    let mut sums: Vec<Vec<PointMm>> = Vec::with_capacity(pairs);
    for piece_a in &pieces_a {
        for piece_b in &pieces_b {
            // Mảnh đã lồi nên đây là phép chính xác; lỗi chỉ xảy ra khi dữ liệu bệnh.
            sums.push(minkowski_convex(piece_a, piece_b)?);
        }
    }
    if sums.len() == 1 {
        // Một cặp duy nhất (cả hai đều lồi) ⇒ không cần union, tiết kiệm cả một vòng
        // fixed-point. Đây là ca phổ biến nhất với tem và nhãn.
        return Ok(sums);
    }
    Ok(union_many(&sums)?)
}

/// `IFP(usable, B)` — tập vị trí đặt điểm tham chiếu của `B` làm `B` **nằm hẳn trong**
/// vùng dùng được hình chữ nhật.
///
/// Với vùng chứa là chữ nhật, IFP có dạng đóng: nó chính là chữ nhật co lại theo
/// khoảng cách từ điểm tham chiếu tới bốn cực trị của `B`. Không cần boolean nào.
///
/// Trả `None` khi `B` không vừa vùng dùng được ở góc hiện tại — nơi gọi phải hiểu đó
/// là "không có pose hợp lệ ở góc này", chưa phải `NO_FEASIBLE_POSE` của cả job.
pub fn inner_fit_rect(usable: &BoundsMm, moving: &[PointMm], tol: &Tolerance) -> Option<BoundsMm> {
    let box_b = BoundsMm::from_ring(moving)?;
    // Điểm tham chiếu của `moving` là gốc toạ độ của chính nó (contour đã được đưa về
    // hệ local quanh pivot trước khi vào đây).
    let low_x = usable.min_x - box_b.min_x;
    let high_x = usable.max_x - box_b.max_x;
    let low_y = usable.min_y - box_b.min_y;
    let high_y = usable.max_y - box_b.max_y;
    if high_x < low_x - tol.linear_mm || high_y < low_y - tol.linear_mm {
        return None;
    }
    Some(BoundsMm {
        min_x: low_x,
        min_y: low_y,
        max_x: high_x.max(low_x),
        max_y: high_y.max(low_y),
    })
}

/// Miền vị trí hợp lệ cho `moving` trên tờ, sau khi trừ mọi chi tiết đã đặt.
///
/// `placed` là các contour **đã đặt trên tờ** (đã transform). `gap_mm` được xử lý bằng
/// cách nở NFP thêm `gap_mm` — tương đương yêu cầu khoảng cách contour ≥ `gap_mm`.
///
/// Trả miền rỗng (`Vec` rỗng) khi không còn chỗ. Đây là **ứng viên**: nơi gọi vẫn phải
/// kiểm bằng [`super::collision`] trước khi công bố.
pub fn feasible_region(
    usable: &BoundsMm,
    placed: &[Vec<PointMm>],
    moving: &[PointMm],
    gap_mm: f64,
    tol: &Tolerance,
) -> Result<RegionMm, NfpError> {
    let Some(ifp) = inner_fit_rect(usable, moving, tol) else {
        return Ok(Vec::new());
    };
    let ifp_ring = bounds_to_ring(&ifp);
    if placed.is_empty() {
        return Ok(vec![ifp_ring]);
    }

    let ifp_box = BoundsMm::from_ring(&ifp_ring);
    let moving_box = BoundsMm::from_ring(moving);
    let mut blockers: Vec<Vec<PointMm>> = Vec::new();
    for obstacle in placed {
        // Loại sớm: chi tiết đã đặt quá xa thì NFP của nó không cắt IFP.
        if let (Some(ib), Some(mb), Some(ob)) = (ifp_box, moving_box, BoundsMm::from_ring(obstacle))
        {
            let reach = BoundsMm {
                min_x: ob.min_x - mb.max_x - gap_mm,
                min_y: ob.min_y - mb.max_y - gap_mm,
                max_x: ob.max_x - mb.min_x + gap_mm,
                max_y: ob.max_y - mb.min_y + gap_mm,
            };
            if !bounds_may_touch(&ib, &reach, tol) {
                continue;
            }
        }
        let nfp = no_fit_polygon(obstacle, moving, tol)?;
        if gap_mm > 0.0 {
            // Nở NFP thêm `gap`: vị trí cách biên NFP dưới `gap` cũng vi phạm khoảng hở.
            let grown =
                super::kernel::offset(&nfp, gap_mm, super::kernel::OffsetStyle::v1_round())?;
            blockers.extend(grown);
        } else {
            blockers.extend(nfp);
        }
    }
    if blockers.is_empty() {
        return Ok(vec![ifp_ring]);
    }
    let blocked = union_many(&blockers)?;
    if blocked.is_empty() {
        return Ok(vec![ifp_ring]);
    }
    Ok(difference(&[ifp_ring], &blocked)?)
}

/// Chữ nhật thành vòng CCW.
pub fn bounds_to_ring(bounds: &BoundsMm) -> Vec<PointMm> {
    vec![
        PointMm::new(bounds.min_x, bounds.min_y),
        PointMm::new(bounds.max_x, bounds.min_y),
        PointMm::new(bounds.max_x, bounds.max_y),
        PointMm::new(bounds.min_x, bounds.max_y),
    ]
}

/// Giao hai miền vị trí hợp lệ.
pub fn intersect_regions(a: &[Vec<PointMm>], b: &[Vec<PointMm>]) -> Result<RegionMm, NfpError> {
    if a.is_empty() || b.is_empty() {
        return Ok(Vec::new());
    }
    Ok(intersection(a, b)?)
}

/// Tổng diện tích có dấu của một miền, mm² — dương trừ lỗ.
pub fn region_area_mm2(region: &[Vec<PointMm>]) -> f64 {
    region.iter().map(|ring| signed_area_mm2(ring)).sum()
}

/// Miền có chứa vị trí `t` hay không.
///
/// Đếm số vòng chứa `t`: lẻ là trong, chẵn là ngoài. Cách này đúng cho cả vùng có lỗ
/// mà không cần biết vòng nào là lỗ của vòng nào.
pub fn region_contains(region: &[Vec<PointMm>], point: PointMm) -> bool {
    let mut inside = false;
    for ring in region {
        if super::geometry::point_in_ring(ring, point) {
            inside = !inside;
        }
    }
    inside
}

/// Mọi đỉnh của miền — nguồn ứng viên vị trí đầu tiên.
///
/// Đỉnh của `IFP \ ∪NFP` là các điểm **tiếp xúc**: ở đó chi tiết chạm biên tờ hoặc chạm
/// một chi tiết đã đặt. Đó chính là các vị trí chặt nhất, nên đây là tập ứng viên tự
/// nhiên cho solver — không phải một lưới toạ độ.
pub fn region_vertices(region: &[Vec<PointMm>]) -> Vec<PointMm> {
    region.iter().flatten().copied().collect()
}
