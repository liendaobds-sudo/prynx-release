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

use std::time::Instant;

use super::collision::bounds_may_touch;
use super::geometry::convex_decompose;
use super::kernel::{difference, intersection, minkowski_convex, union_many, KernelError};
use super::model::{PointMm, SheetAxisClearanceMm, Tolerance};
use super::normalize::BoundsMm;
use super::transform::signed_area_mm2;

/// Version của quy tắc dựng NFP/IFP. Đổi cách dựng là đổi ứng viên ⇒ đổi layout.
pub const NFP_RULE_VERSION: u32 = 2;

/// Trần số cặp mảnh lồi cho một phép NFP.
///
/// Chặn chi phí ở ca bệnh lý (contour hàng trăm đỉnh lõm). Vượt trần thì trả lỗi để
/// nơi gọi rơi về đường ứng viên khác, thay vì treo máy — mất ứng viên là chấp nhận
/// được, treo thì không.
pub const MAX_CONVEX_PAIRS: usize = 4_096;

/// Số vòng blocker xử lý mỗi barrier Boolean.
///
/// Đây là độ hạt kiểm deadline/cancel, không phải cap chất lượng: mọi batch đều được trừ
/// tuần tự và kết quả vẫn bằng trừ hợp toàn bộ blocker. Batch nhỏ tránh một lời gọi
/// Clipper khổng lồ giữ một lõi hàng chục giây sau khi deadline đã hết.
const DIFFERENCE_INTERRUPT_BATCH_SIZE: usize = 8;

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

/// Luật nở NFP. Không được nhập nhằng scalar Euclid legacy với rectangle theo trục tờ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NfpClearance {
    LegacyIsotropic { radius_mm: f64 },
    SheetAxis(SheetAxisClearanceMm),
}

impl NfpClearance {
    pub const fn legacy_isotropic(radius_mm: f64) -> Self {
        Self::LegacyIsotropic { radius_mm }
    }

    pub const fn sheet_axis(clearance: SheetAxisClearanceMm) -> Self {
        Self::SheetAxis(clearance)
    }

    pub fn reach_x_mm(self) -> f64 {
        match self {
            Self::LegacyIsotropic { radius_mm } => radius_mm.max(0.0),
            Self::SheetAxis(clearance) => clearance.x_mm.max(0.0),
        }
    }

    pub fn reach_y_mm(self) -> f64 {
        match self {
            Self::LegacyIsotropic { radius_mm } => radius_mm.max(0.0),
            Self::SheetAxis(clearance) => clearance.y_mm.max(0.0),
        }
    }
}

/// Bao lồi của một tập điểm bằng monotone chain, trả vòng CCW không lặp đỉnh đầu.
fn convex_hull(mut points: Vec<PointMm>) -> Vec<PointMm> {
    points.sort_by(|left, right| {
        left.x
            .total_cmp(&right.x)
            .then_with(|| left.y.total_cmp(&right.y))
    });
    points.dedup_by(|left, right| left.x == right.x && left.y == right.y);
    if points.len() <= 2 {
        return points;
    }

    let cross = |origin: PointMm, a: PointMm, b: PointMm| {
        (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
    };
    let mut lower: Vec<PointMm> = Vec::with_capacity(points.len());
    for point in &points {
        while lower.len() >= 2
            && cross(lower[lower.len() - 2], lower[lower.len() - 1], *point) <= 0.0
        {
            lower.pop();
        }
        lower.push(*point);
    }
    let mut upper: Vec<PointMm> = Vec::with_capacity(points.len());
    for point in points.iter().rev() {
        while upper.len() >= 2
            && cross(upper[upper.len() - 2], upper[upper.len() - 1], *point) <= 0.0
        {
            upper.pop();
        }
        upper.push(*point);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Nở một mảnh lồi bằng rectangle sheet-axis, kể cả rectangle suy biến thành segment.
fn grow_convex_sheet_axis(ring: &[PointMm], clearance: SheetAxisClearanceMm) -> Vec<PointMm> {
    let gap_x = clearance.x_mm.max(0.0);
    let gap_y = clearance.y_mm.max(0.0);
    if gap_x == 0.0 && gap_y == 0.0 {
        return ring.to_vec();
    }

    let mut points = Vec::with_capacity(ring.len().saturating_mul(4));
    for point in ring {
        for delta_x in [-gap_x, gap_x] {
            for delta_y in [-gap_y, gap_y] {
                points.push(PointMm::new(point.x + delta_x, point.y + delta_y));
            }
        }
    }
    convex_hull(points)
}

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

/// NFP đã nở bằng rectangle cố định theo trục tờ.
///
/// FIX/PARITY (audit 2026-08-29 §MAP-NEST-07): rectangle được cộng vào từng tổng
/// Minkowski lồi trước phép union. Cách này giữ đúng cả `gapX=0` hoặc `gapY=0`, không
/// dùng epsilon và không xoay clearance theo contour của chi tiết.
pub fn no_fit_polygon_sheet_axis(
    stationary: &[PointMm],
    moving: &[PointMm],
    clearance: SheetAxisClearanceMm,
    tol: &Tolerance,
) -> Result<RegionMm, NfpError> {
    if clearance.x_mm == 0.0 && clearance.y_mm == 0.0 {
        return no_fit_polygon(stationary, moving, tol);
    }

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
            let sum = minkowski_convex(piece_a, piece_b)?;
            sums.push(grow_convex_sheet_axis(&sum, clearance));
        }
    }
    if sums.len() == 1 {
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
    // Không có cache của caller ⇒ dùng cache tạm cho đúng một lượt. Vẫn có lợi vì
    // trong MỘT lượt cũng có nhiều chi tiết cùng hình cùng góc.
    let mut cache = super::nfp_cache::NfpCache::new();
    // `control = None` ⇒ không bao giờ bị ngắt ⇒ luôn `Some`.
    Ok(
        feasible_region_cached(usable, placed, moving, gap_mm, tol, &mut cache, None)?
            .unwrap_or_default(),
    )
}

pub fn feasible_region_sheet_axis(
    usable: &BoundsMm,
    placed: &[Vec<PointMm>],
    moving: &[PointMm],
    clearance: SheetAxisClearanceMm,
    tol: &Tolerance,
) -> Result<RegionMm, NfpError> {
    let mut cache = super::nfp_cache::NfpCache::new();
    Ok(feasible_region_cached_with_clearance(
        usable,
        placed,
        moving,
        NfpClearance::sheet_axis(clearance),
        tol,
        &mut cache,
        None,
    )?
    .unwrap_or_default())
}

/// Như [`feasible_region`] nhưng dùng cache NFP do caller sở hữu.
///
/// API scalar này giữ nguyên semantics isotropic của công cụ lab/legacy.
pub fn feasible_region_cached(
    usable: &BoundsMm,
    placed: &[Vec<PointMm>],
    moving: &[PointMm],
    gap_mm: f64,
    tol: &Tolerance,
    cache: &mut super::nfp_cache::NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    feasible_region_cached_with_clearance(
        usable,
        placed,
        moving,
        NfpClearance::legacy_isotropic(gap_mm),
        tol,
        cache,
        should_stop,
    )
}

/// Đường tổng quát giữ nguyên mode clearance tới NFP/cache.
///
/// PERF (audit 2026-08-28 §NFP-CACHE): đây là đường mà solver/baseline phải đi. Cache
/// sống qua nhiều lượt gọi nên NFP của một hình chỉ tính **một lần cho cả trial**, thay
/// vì tính lại cho từng chi tiết đã đặt ở từng góc.
pub fn feasible_region_cached_with_clearance(
    usable: &BoundsMm,
    placed: &[Vec<PointMm>],
    moving: &[PointMm],
    clearance: NfpClearance,
    tol: &Tolerance,
    cache: &mut super::nfp_cache::NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    cache.record_feasible_region_call();
    let Some(ifp) = inner_fit_rect(usable, moving, tol) else {
        return Ok(Some(Vec::new()));
    };
    let ifp_ring = bounds_to_ring(&ifp);
    if placed.is_empty() {
        return Ok(Some(vec![ifp_ring]));
    }

    let ifp_box = BoundsMm::from_ring(&ifp_ring);
    let moving_box = BoundsMm::from_ring(moving);
    let mut blockers: Vec<Vec<PointMm>> = Vec::new();
    let mut active_obstacles: Vec<&[PointMm]> = Vec::new();
    let mut blockers_considered = 0_u64;
    let mut bbox_rejects = 0_u64;
    let mut blocker_rings_generated = 0_u64;
    let use_parallel_batch = cache.allows_parallel_batch();
    for obstacle in placed {
        // FIX (audit 2026-08-28 §NFP-DEADLINE): `RunControl::checkpoint()` trước đây chỉ
        // được gọi GIỮA các góc, nên một lượt `feasible_region` nặng không cắt được giữa
        // dòng — đo thật: 13 mẫu với ngân sách 3000ms mất 17,85s, và bấm Hủy không dứt.
        // Vòng lặp này là chỗ tốn nhất (mỗi obstacle một NFP), nên deadline phải vào đây.
        //
        // Nhận **closure** chứ không nhận `RunControl`: solver và baseline có luật dừng
        // KHÁC nhau — baseline cố ý bỏ qua deadline/work budget và chỉ tôn trọng hủy
        // (test `baseline_bo_qua_deadline_va_work_budget_nhung_van_ton_trong_cancel` chốt
        // điều đó). Để mỗi caller tự khai luật thì `nfp` không phải biết ai là ai.
        if let Some(stop) = should_stop {
            if stop() {
                cache.record_blockers_considered(blockers_considered);
                cache.record_bbox_rejects(bbox_rejects);
                cache.record_blocker_rings_generated(blocker_rings_generated);
                cache.record_interrupted_call();
                return Ok(None);
            }
        }
        blockers_considered = blockers_considered.saturating_add(1);
        // Loại sớm: chi tiết đã đặt quá xa thì NFP của nó không cắt IFP.
        if let (Some(ib), Some(mb), Some(ob)) = (ifp_box, moving_box, BoundsMm::from_ring(obstacle))
        {
            let reach = BoundsMm {
                min_x: ob.min_x - mb.max_x - clearance.reach_x_mm(),
                min_y: ob.min_y - mb.max_y - clearance.reach_y_mm(),
                max_x: ob.max_x - mb.min_x + clearance.reach_x_mm(),
                max_y: ob.max_y - mb.min_y + clearance.reach_y_mm(),
            };
            if !bounds_may_touch(&ib, &reach, tol) {
                bbox_rejects = bbox_rejects.saturating_add(1);
                continue;
            }
        }
        if use_parallel_batch {
            // Chỉ các blocker thật sự có thể cắt IFP mới được đưa vào cold-miss batch.
            // Giữ reference theo đúng thứ tự `placed`; cache sẽ replay kết quả first-use
            // theo thứ tự này, không bao giờ theo thứ tự thread hoàn tất.
            active_obstacles.push(obstacle);
        } else {
            // Grant mặc định = 1 phải giữ nguyên đường tuần tự cũ: checkpoint ngay
            // trước đúng NFP tương ứng, không quét trước toàn bộ obstacle.
            let grown = cache.grown_nfp_with_clearance(obstacle, moving, clearance, tol)?;
            blocker_rings_generated = blocker_rings_generated
                .saturating_add(u64::try_from(grown.len()).unwrap_or(u64::MAX));
            blockers.extend(grown);
        }
    }
    if use_parallel_batch {
        let Some(grown_regions) = cache.grown_nfps_batch_with_clearance(
            &active_obstacles,
            moving,
            clearance,
            tol,
            should_stop,
        )?
        else {
            cache.record_blockers_considered(blockers_considered);
            cache.record_bbox_rejects(bbox_rejects);
            cache.record_blocker_rings_generated(blocker_rings_generated);
            cache.record_interrupted_call();
            return Ok(None);
        };
        for grown in grown_regions {
            blocker_rings_generated = blocker_rings_generated
                .saturating_add(u64::try_from(grown.len()).unwrap_or(u64::MAX));
            blockers.extend(grown);
        }
    }
    cache.record_blockers_considered(blockers_considered);
    cache.record_bbox_rejects(bbox_rejects);
    cache.record_blocker_rings_generated(blocker_rings_generated);
    if blockers.is_empty() {
        return Ok(Some(vec![ifp_ring]));
    }
    // PERF (audit 2026-08-29 §NFP-DIRECT-DIFFERENCE): hợp riêng toàn bộ blocker rồi
    // mới trừ là một phép Boolean dư thừa. Trừ theo batch giữ nguyên tập hợp hình học
    // và tạo barrier cancel/deadline giữa các lời gọi kernel; trước đây một difference
    // lớn có thể vượt ngân sách 3 giây thêm hơn 20 giây.
    let mut feasible = vec![ifp_ring];
    for batch in blockers.chunks(DIFFERENCE_INTERRUPT_BATCH_SIZE) {
        if let Some(stop) = should_stop {
            if stop() {
                cache.record_interrupted_call();
                return Ok(None);
            }
        }
        cache.record_difference_call();
        let difference_started = Instant::now();
        let difference_result = difference(&feasible, batch);
        cache.record_difference_time(difference_started);
        feasible = difference_result?;
        if feasible.is_empty() {
            break;
        }
    }
    Ok(Some(feasible))
}

/// PERF (audit 2026-08-30 §NEST-B9-INCREMENTAL): miền hợp lệ NỐI TIẾP — trừ THÊM các
/// obstacle mới khỏi `base_region` đã tính trước đó, thay vì dựng lại từ IFP mỗi lần.
///
/// Autofill gọi lặp cho CÙNG (mẫu, góc) khi `placed_rings` chỉ **mọc thêm** (append-only),
/// nên chỉ cần trừ phần mới:
///
/// ```text
/// base_region      = IFP \ ∪NFP(placed[:accounted])   // đã tính ở lần trước
/// kết quả          = base_region \ ∪NFP(new)          // = IFP \ ∪NFP(placed) toàn bộ
/// ```
///
/// Cùng tập trừ, cùng thứ tự đặt ⇒ cùng SET ⇒ Clipper số nguyên chuẩn tắc cho cùng đỉnh ⇒
/// **layout không đổi** (golden khóa). Độ phức tạp mỗi lần chỉ O(|new|) thay vì O(|placed|).
///
/// KHÔNG bbox-reject: `new` nhỏ (một vòng quét), và trừ một NFP rời `base_region` là no-op
/// nên bỏ reject vẫn cho kết quả Y HỆT (autofill đo được `bboxRejects = 0`). Dùng đúng
/// `NfpCache` + batch cancel/deadline như [`feasible_region_cached`].
pub fn feasible_region_after(
    base_region: RegionMm,
    new_obstacles: &[Vec<PointMm>],
    moving: &[PointMm],
    gap_mm: f64,
    tol: &Tolerance,
    cache: &mut super::nfp_cache::NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    feasible_region_after_with_clearance(
        base_region,
        new_obstacles,
        moving,
        NfpClearance::legacy_isotropic(gap_mm),
        tol,
        cache,
        should_stop,
    )
}

/// Biến thể incremental giữ mode clearance tới cache.
pub fn feasible_region_after_with_clearance(
    base_region: RegionMm,
    new_obstacles: &[Vec<PointMm>],
    moving: &[PointMm],
    clearance: NfpClearance,
    tol: &Tolerance,
    cache: &mut super::nfp_cache::NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    cache.record_feasible_region_call();
    // Miền rỗng chỉ co thêm khi trừ ⇒ giữ rỗng; không obstacle mới ⇒ trả nguyên miền cũ.
    if new_obstacles.is_empty() || base_region.is_empty() {
        return Ok(Some(base_region));
    }

    let mut blockers: Vec<Vec<PointMm>> = Vec::new();
    let mut active_obstacles: Vec<&[PointMm]> = Vec::new();
    let mut blockers_considered = 0_u64;
    let mut blocker_rings_generated = 0_u64;
    let use_parallel_batch = cache.allows_parallel_batch();
    for obstacle in new_obstacles {
        if let Some(stop) = should_stop {
            if stop() {
                cache.record_blockers_considered(blockers_considered);
                cache.record_blocker_rings_generated(blocker_rings_generated);
                cache.record_interrupted_call();
                return Ok(None);
            }
        }
        blockers_considered = blockers_considered.saturating_add(1);
        if use_parallel_batch {
            active_obstacles.push(obstacle);
        } else {
            let grown = cache.grown_nfp_with_clearance(obstacle, moving, clearance, tol)?;
            blocker_rings_generated = blocker_rings_generated
                .saturating_add(u64::try_from(grown.len()).unwrap_or(u64::MAX));
            blockers.extend(grown);
        }
    }
    if use_parallel_batch {
        let Some(grown_regions) = cache.grown_nfps_batch_with_clearance(
            &active_obstacles,
            moving,
            clearance,
            tol,
            should_stop,
        )?
        else {
            cache.record_blockers_considered(blockers_considered);
            cache.record_blocker_rings_generated(blocker_rings_generated);
            cache.record_interrupted_call();
            return Ok(None);
        };
        for grown in grown_regions {
            blocker_rings_generated = blocker_rings_generated
                .saturating_add(u64::try_from(grown.len()).unwrap_or(u64::MAX));
            blockers.extend(grown);
        }
    }
    cache.record_blockers_considered(blockers_considered);
    cache.record_blocker_rings_generated(blocker_rings_generated);
    if blockers.is_empty() {
        return Ok(Some(base_region));
    }
    let mut feasible = base_region;
    for batch in blockers.chunks(DIFFERENCE_INTERRUPT_BATCH_SIZE) {
        if let Some(stop) = should_stop {
            if stop() {
                cache.record_interrupted_call();
                return Ok(None);
            }
        }
        cache.record_difference_call();
        let difference_started = Instant::now();
        let difference_result = difference(&feasible, batch);
        cache.record_difference_time(difference_started);
        feasible = difference_result?;
        if feasible.is_empty() {
            break;
        }
    }
    Ok(Some(feasible))
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

#[cfg(test)]
mod parallel_cold_miss_tests {
    use super::*;
    use crate::mixed_nesting::control::{NfpTelemetryPhase, ProgressChannel};
    use crate::mixed_nesting::nfp_cache::{parallel_budget_probe, NfpCache};
    use std::cell::Cell;
    use std::sync::Arc;

    fn rectangle(x: f64, y: f64, width: f64, height: f64) -> Vec<PointMm> {
        vec![
            PointMm::new(x, y),
            PointMm::new(x + width, y),
            PointMm::new(x + width, y + height),
            PointMm::new(x, y + height),
        ]
    }

    fn scenario(worker_grant: usize) -> (RegionMm, super::super::control::NfpPhaseDiagnostics) {
        let usable = BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 240.0,
            max_y: 180.0,
        };
        // Ba shape lạnh duy nhất; shape đầu lặp lại sau first-use để khóa hit/miss.
        let placed = vec![
            rectangle(15.0, 15.0, 20.0, 10.0),
            rectangle(55.0, 20.0, 24.0, 12.0),
            rectangle(95.0, 25.0, 28.0, 14.0),
            rectangle(145.0, 35.0, 20.0, 10.0),
        ];
        let moving = rectangle(0.0, 0.0, 12.0, 8.0);
        let progress = Arc::new(ProgressChannel::new());
        let mut cache = NfpCache::with_telemetry_and_resources(
            progress.clone(),
            NfpTelemetryPhase::Baseline,
            worker_grant,
            u64::MAX,
        );
        let region = feasible_region_cached(
            &usable,
            &placed,
            &moving,
            2.0,
            &Tolerance::v1(),
            &mut cache,
            None,
        )
        .expect("NFP hợp lệ")
        .expect("không bị ngắt");
        (region, progress.snapshot().nfp_diagnostics.baseline)
    }

    #[test]
    fn cold_miss_1_2_4_worker_giu_exact_region_va_cache_counter() {
        let (one, one_diag) = scenario(1);
        let (two, two_diag) = scenario(2);
        let (four, four_diag) = scenario(4);

        assert_eq!(two, one);
        assert_eq!(four, one);
        for diagnostics in [one_diag, two_diag, four_diag] {
            assert_eq!(diagnostics.cache_misses, 3);
            assert_eq!(diagnostics.cache_hits, 1);
            assert_eq!(diagnostics.cache_entries_built, 3);
            assert_eq!(diagnostics.cache_insert_skipped, 0);
        }
        assert_eq!(one_diag.prewarm_batches, 0);
        assert_eq!(two_diag.prewarm_batches, 1);
        assert_eq!(two_diag.prewarm_tasks, 3);
        assert_eq!(two_diag.prewarm_peak_workers, 2);
        assert_eq!(four_diag.prewarm_batches, 1);
        assert_eq!(four_diag.prewarm_tasks, 3);
        assert_eq!(four_diag.prewarm_peak_workers, 3);
    }

    #[test]
    fn cancel_tai_barrier_truoc_dispatch_khong_publish_cache() {
        let usable = BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 240.0,
            max_y: 180.0,
        };
        let placed = vec![
            rectangle(15.0, 15.0, 20.0, 10.0),
            rectangle(55.0, 20.0, 24.0, 12.0),
        ];
        let moving = rectangle(0.0, 0.0, 12.0, 8.0);
        let progress = Arc::new(ProgressChannel::new());
        let mut cache = NfpCache::with_telemetry_and_resources(
            progress.clone(),
            NfpTelemetryPhase::Baseline,
            4,
            u64::MAX,
        );
        let checks = Cell::new(0_u32);
        let stop = || {
            checks.set(checks.get() + 1);
            // Hai checkpoint đầu thuộc vòng obstacle; checkpoint thứ ba là barrier
            // ngay trước dispatch cold-miss batch.
            checks.get() >= 3
        };
        let result = feasible_region_cached(
            &usable,
            &placed,
            &moving,
            2.0,
            &Tolerance::v1(),
            &mut cache,
            Some(&stop),
        )
        .expect("cancel không phải lỗi hình học");
        assert!(result.is_none());
        assert!(cache.is_empty());
        assert_eq!(cache.hits(), 0);
        assert_eq!(cache.misses(), 0);
        let diagnostics = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!(diagnostics.prewarm_batches, 0);
        assert_eq!(diagnostics.cache_entries_built, 0);
        assert_eq!(diagnostics.interrupted_calls, 1);
    }

    #[test]
    fn cancel_giua_hai_wave_khong_publish_region_worker_da_dung() {
        let usable = BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 260.0,
            max_y: 180.0,
        };
        let placed = vec![
            rectangle(15.0, 15.0, 20.0, 10.0),
            rectangle(55.0, 20.0, 24.0, 12.0),
            rectangle(95.0, 25.0, 28.0, 14.0),
        ];
        let moving = rectangle(0.0, 0.0, 12.0, 8.0);
        let progress = Arc::new(ProgressChannel::new());
        let mut cache = NfpCache::with_telemetry_and_resources(
            progress.clone(),
            NfpTelemetryPhase::Baseline,
            2,
            u64::MAX,
        );
        let checks = Cell::new(0_u32);
        let stop = || {
            checks.set(checks.get() + 1);
            // 3 obstacle + barrier trước batch + barrier wave 1 = 5 lần false;
            // lần 6 dừng trước wave 2 (task lạnh thứ ba).
            checks.get() >= 6
        };
        let result = feasible_region_cached(
            &usable,
            &placed,
            &moving,
            2.0,
            &Tolerance::v1(),
            &mut cache,
            Some(&stop),
        )
        .expect("cancel không phải lỗi hình học");
        assert!(result.is_none());
        assert!(
            cache.is_empty(),
            "region local của wave 1 không được publish"
        );
        assert_eq!(cache.hits(), 0);
        assert_eq!(cache.misses(), 0);
        let diagnostics = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!(diagnostics.prewarm_batches, 1);
        assert_eq!(diagnostics.prewarm_tasks, 2);
        assert_eq!(diagnostics.prewarm_peak_workers, 2);
        assert_eq!(diagnostics.cache_entries_built, 0);
        assert_eq!(diagnostics.interrupted_calls, 1);
    }

    #[test]
    fn byte_budget_nho_fallback_tuan_tu_va_khong_insert_qua_budget() {
        let usable = BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 240.0,
            max_y: 180.0,
        };
        let placed = vec![
            rectangle(15.0, 15.0, 20.0, 10.0),
            rectangle(55.0, 20.0, 24.0, 12.0),
        ];
        let moving = rectangle(0.0, 0.0, 12.0, 8.0);
        let progress = Arc::new(ProgressChannel::new());
        let mut cache = NfpCache::with_telemetry_and_resources(
            progress.clone(),
            NfpTelemetryPhase::Baseline,
            4,
            1,
        );
        let result = feasible_region_cached(
            &usable,
            &placed,
            &moving,
            2.0,
            &Tolerance::v1(),
            &mut cache,
            None,
        )
        .expect("NFP hợp lệ")
        .expect("không bị ngắt");
        assert!(!result.is_empty());
        assert_eq!(cache.estimated_payload_bytes(), 0);
        let diagnostics = progress.snapshot().nfp_diagnostics.baseline;
        assert_eq!(diagnostics.prewarm_batches, 0);
        assert_eq!(diagnostics.cache_misses, 2);
        assert_eq!(diagnostics.cache_entries_built, 0);
        assert_eq!(diagnostics.cache_insert_skipped, 2);
    }

    #[test]
    fn staging_wave_dau_vuot_budget_thi_khong_dispatch_wave_hai() {
        let usable = BoundsMm {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 260.0,
            max_y: 180.0,
        };
        let placed = vec![
            rectangle(15.0, 15.0, 20.0, 10.0),
            rectangle(55.0, 20.0, 24.0, 12.0),
            rectangle(95.0, 25.0, 28.0, 14.0),
        ];
        let moving = rectangle(0.0, 0.0, 12.0, 8.0);
        let obstacle_refs: Vec<&[PointMm]> = placed.iter().map(Vec::as_slice).collect();
        let (preflight_key_bytes, first_wave_payload_bytes) =
            parallel_budget_probe(&obstacle_refs, &moving, 2.0, &Tolerance::v1(), 2)
                .expect("probe budget phải dựng được NFP");
        assert!(
            preflight_key_bytes < first_wave_payload_bytes,
            "fixture phải qua preflight key nhưng vượt payload ngay wave đầu"
        );
        let budget = preflight_key_bytes;

        let run = |worker_grant| {
            let progress = Arc::new(ProgressChannel::new());
            let mut cache = NfpCache::with_telemetry_and_resources(
                progress.clone(),
                NfpTelemetryPhase::Baseline,
                worker_grant,
                budget,
            );
            let region = feasible_region_cached(
                &usable,
                &placed,
                &moving,
                2.0,
                &Tolerance::v1(),
                &mut cache,
                None,
            )
            .expect("NFP hợp lệ")
            .expect("không bị ngắt");
            (
                region,
                progress.snapshot().nfp_diagnostics.baseline,
                cache.len(),
                cache.estimated_payload_bytes(),
            )
        };

        let sequential = run(1);
        let wave_limited = run(2);
        assert_eq!(
            wave_limited.0, sequential.0,
            "fallback phải giữ exact region"
        );
        assert_eq!(wave_limited.1.cache_hits, sequential.1.cache_hits);
        assert_eq!(wave_limited.1.cache_misses, sequential.1.cache_misses);
        assert_eq!(
            wave_limited.1.cache_entries_built,
            sequential.1.cache_entries_built
        );
        assert_eq!(
            wave_limited.1.cache_insert_skipped,
            sequential.1.cache_insert_skipped
        );
        assert_eq!(wave_limited.2, sequential.2);
        assert_eq!(wave_limited.3, sequential.3);
        assert!(wave_limited.3 <= budget);
        assert_eq!(sequential.1.cache_misses, 3, "fixture phải có ba cold key");
        assert_eq!(wave_limited.1.prewarm_batches, 1);
        assert_eq!(wave_limited.1.prewarm_tasks, 2);
        assert_eq!(wave_limited.1.prewarm_peak_workers, 2);
    }
}
