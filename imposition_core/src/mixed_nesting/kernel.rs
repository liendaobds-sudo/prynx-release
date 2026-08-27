//! Kernel polygon fixed-point cho `mixed_nesting` (P2b).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.1, §11.2
//! và quyết định đo được ở `docs/BAO_CAO_SPIKE_MIXED_NESTING_KERNEL.md`.
//!
//! Đây là **lớp duy nhất** trong engine biết tới số học fixed-point và tới crate
//! `clipper2-rust`. Mọi module khác làm việc bằng mm (`f64`) theo hợp đồng ở P1.
//!
//! ## Ba quyết định đã trả giá bằng phép đo — đừng đổi mà không đo lại
//!
//! 1. **Không dùng `minkowski_sum`/`minkowski_diff` của crate.** Spike §4 đo được nó
//!    sai trên 5/6 ca lồi (sinh lỗ không tồn tại) ở **cả** bản Rust lẫn bản C++ gốc,
//!    và chậm 12–84 ms mỗi phép. Thay bằng [`minkowski_convex`] — hợp nhất vector cạnh
//!    theo góc, `O(m+n)`, chính xác, đã kiểm bằng hai oracle độc lập.
//!    Test `khong_goi_minkowski_cua_crate` trong `tests/mixed_nesting_kernel.rs` chặn
//!    cứng việc gọi lại.
//! 2. **Kiểu bo góc offset phải khai tường minh**, không dùng mặc định thư viện. Spike
//!    §3.1 đo hai engine chênh 0,3% chỉ vì mặc định khác nhau. Vì vậy [`offset`] bắt
//!    buộc nhận [`OffsetStyle`] có version — không có overload "tiện tay".
//! 3. **Thang fixed-point và trần toạ độ có version.** Đổi hai số này là đổi hình học,
//!    phải tăng [`KERNEL_VERSION`] và đo lại.
//!
//! ## Vai trò trong kiến trúc
//!
//! Kernel là **bộ sinh hình học phụ trợ**: clearance geometry, IFP/NFP, coverage.
//! Nó **không** phải quan toà cuối. Phán quyết chồng lấn và khoảng hở thuộc
//! [`super::collision`] — làm việc trực tiếp trên contour `f64`, độc lập hoàn toàn với
//! kernel này (§11.6).

use clipper2_rust::{
    difference_64, inflate_paths_64, intersect_64, union_64, union_subjects_64,
    EndType as CEndType, FillRule as CFillRule, JoinType as CJoinType, Path64, Paths64, Point64,
};

use super::model::PointMm;
use super::transform::signed_area_mm2;

/// Version của kernel: gồm thang fixed-point, trần toạ độ và quy tắc fill.
pub const KERNEL_VERSION: u32 = 1;

/// Thang fixed-point: `1 mm = 1e6` đơn vị nguyên ⇒ độ phân giải `1e-6 mm`.
///
/// Khớp đúng `Tolerance::v1().linear_mm` của P1 nên việc chuyển sang kernel **không**
/// làm mất độ phân giải mà hợp đồng đã hứa.
pub const KERNEL_FIXED_POINT_SCALE: f64 = 1e6;

/// Trần trị tuyệt đối của toạ độ mà kernel nhận, mm.
///
/// Ở thang `1e6`, `8000 mm` ứng với `8e9` đơn vị. Kernel dùng số học rộng hơn `i64`
/// cho tích có hướng nên vẫn đúng ở biên này — có test
/// `boolean_va_offset_dung_o_bien_toa_do` chứng minh, thay vì tin vào giả định.
/// Trần này phủ cả NFP của khổ tờ lớn nhất (NFP rộng nhất bằng tổng hai bbox part).
pub const KERNEL_MAX_ABS_MM: f64 = 8_000.0;

/// Kiểu bo góc khi offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffsetJoin {
    /// Bo tròn — **đúng định nghĩa toán học** của offset: Minkowski với đĩa bán kính
    /// `|delta|`. Là mặc định cho clearance `gap/2`.
    Round,
    /// Vát nhọn. Ở góc lồi nhọn, miter **nở ra nhiều hơn** hình bo tròn nên vùng
    /// clearance bị phóng đại và layout hợp lệ có thể bị loại oan. Chỉ dùng khi
    /// nơi gọi thực sự cần biên đa giác thẳng.
    Miter,
    /// Vát phẳng góc.
    Bevel,
}

/// Tham số bo góc offset, có version. Không có `Default`: nơi gọi **buộc** phải chọn.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffsetStyle {
    pub version: u32,
    pub join: OffsetJoin,
    /// Chỉ có nghĩa với [`OffsetJoin::Miter`].
    pub miter_limit: f64,
    /// Sai số cho phép khi làm phẳng cung, mm. Chỉ có nghĩa với [`OffsetJoin::Round`].
    pub arc_tolerance_mm: f64,
}

impl OffsetStyle {
    /// Bộ tham số v1 cho clearance `gap/2` — bo tròn, sai số cung `5 µm`.
    ///
    /// `5 µm` nhỏ hơn mọi dung sai dao bế thật vài bậc nhưng vẫn giữ số đỉnh ở mức
    /// dùng được (nếu lấy quá nhỏ thì mỗi góc sinh hàng trăm đỉnh, kéo chậm NFP).
    pub const fn v1_round() -> Self {
        Self {
            version: KERNEL_VERSION,
            join: OffsetJoin::Round,
            miter_limit: 2.0,
            arc_tolerance_mm: 0.005,
        }
    }

    /// Bộ tham số v1 dạng vát nhọn, `miterLimit = 2.0`.
    pub const fn v1_miter() -> Self {
        Self {
            version: KERNEL_VERSION,
            join: OffsetJoin::Miter,
            miter_limit: 2.0,
            arc_tolerance_mm: 0.0,
        }
    }

    fn to_clipper_join(self) -> CJoinType {
        match self.join {
            OffsetJoin::Round => CJoinType::Round,
            OffsetJoin::Miter => CJoinType::Miter,
            OffsetJoin::Bevel => CJoinType::Bevel,
        }
    }
}

/// Lỗi của kernel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KernelError {
    /// Có toạ độ không hữu hạn.
    NotFinite,
    /// Toạ độ vượt [`KERNEL_MAX_ABS_MM`] — kernel không bảo đảm đúng ngoài trần đã đo.
    CoordinateOutOfRange,
    /// Đầu vào rỗng hoặc vòng dưới 3 đỉnh.
    DegenerateInput,
    /// Tham số offset không hữu hạn hoặc sai miền.
    InvalidOffsetStyle,
    /// [`minkowski_convex`] nhận đầu vào không lồi.
    NotConvex,
}

impl KernelError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFinite => "KERNEL_NOT_FINITE",
            Self::CoordinateOutOfRange => "KERNEL_COORDINATE_OUT_OF_RANGE",
            Self::DegenerateInput => "KERNEL_DEGENERATE_INPUT",
            Self::InvalidOffsetStyle => "KERNEL_INVALID_OFFSET_STYLE",
            Self::NotConvex => "KERNEL_NOT_CONVEX",
        }
    }

    pub fn message_vi(self) -> &'static str {
        match self {
            Self::NotFinite => "Hình học đưa vào kernel có toạ độ không hữu hạn.",
            Self::CoordinateOutOfRange => {
                "Toạ độ vượt khổ tối đa mà kernel bảo đảm chính xác (8.000 mm)."
            }
            Self::DegenerateInput => "Hình học đưa vào kernel suy biến (dưới 3 đỉnh).",
            Self::InvalidOffsetStyle => "Tham số bo góc offset không hợp lệ.",
            Self::NotConvex => "Phép Minkowski nhanh chỉ nhận đa giác lồi.",
        }
    }
}

/// Nhiều vòng, đơn vị mm. Vòng có diện tích **dương** là biên ngoài, **âm** là lỗ.
pub type RingsMm = Vec<Vec<PointMm>>;

// ─────────────────────────────────────────────────────────────────────────────
//  Chuyển đổi mm ↔ fixed-point
// ─────────────────────────────────────────────────────────────────────────────

fn check_point(point: PointMm) -> Result<(), KernelError> {
    if !point.is_finite() {
        return Err(KernelError::NotFinite);
    }
    if point.x.abs() > KERNEL_MAX_ABS_MM || point.y.abs() > KERNEL_MAX_ABS_MM {
        return Err(KernelError::CoordinateOutOfRange);
    }
    Ok(())
}

fn to_fixed(ring: &[PointMm]) -> Result<Path64, KernelError> {
    if ring.len() < 3 {
        return Err(KernelError::DegenerateInput);
    }
    let mut path = Path64::with_capacity(ring.len());
    for point in ring {
        check_point(*point)?;
        path.push(Point64::new(
            (point.x * KERNEL_FIXED_POINT_SCALE).round() as i64,
            (point.y * KERNEL_FIXED_POINT_SCALE).round() as i64,
        ));
    }
    Ok(path)
}

fn to_fixed_many(rings: &[Vec<PointMm>]) -> Result<Paths64, KernelError> {
    if rings.is_empty() {
        return Err(KernelError::DegenerateInput);
    }
    rings.iter().map(|ring| to_fixed(ring)).collect()
}

fn from_fixed(path: &Path64) -> Vec<PointMm> {
    path.iter()
        .map(|point| {
            PointMm::new(
                point.x as f64 / KERNEL_FIXED_POINT_SCALE,
                point.y as f64 / KERNEL_FIXED_POINT_SCALE,
            )
        })
        .collect()
}

/// Đưa kết quả về mm và **bỏ vòng suy biến** (dưới 3 đỉnh).
///
/// Không sắp xếp lại và không đổi chiều vòng: dấu diện tích chính là thông tin
/// ngoài/lỗ mà nơi gọi cần.
fn from_fixed_many(paths: &Paths64) -> RingsMm {
    paths
        .iter()
        .map(from_fixed)
        .filter(|ring| ring.len() >= 3)
        .collect()
}

/// Tổng diện tích có dấu của một tập vòng, mm² — dương trừ lỗ.
pub fn net_area_mm2(rings: &[Vec<PointMm>]) -> f64 {
    rings.iter().map(|ring| signed_area_mm2(ring)).sum()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Boolean
// ─────────────────────────────────────────────────────────────────────────────
//
// Dùng `NonZero` cho mọi phép: đầu vào của engine luôn đã chuẩn hoá chiều ở
// `normalize.rs` (ngoài CCW, lỗ CW), nên NonZero diễn giải lỗ đúng ý nghĩa hình học.
// `EvenOdd` sẽ hiểu sai hai vòng ngoài lồng nhau thành một vòng có lỗ.

/// Hợp của hai tập vòng.
pub fn union(subjects: &[Vec<PointMm>], clips: &[Vec<PointMm>]) -> Result<RingsMm, KernelError> {
    let s = to_fixed_many(subjects)?;
    let c = to_fixed_many(clips)?;
    Ok(from_fixed_many(&union_64(&s, &c, CFillRule::NonZero)))
}

/// Hợp của nhiều tập vòng trong cùng một lời gọi.
///
/// Đây là phép mà `nfp.rs` (P2c) dùng để gộp các cặp Minkowski lồi.
pub fn union_many(subjects: &[Vec<PointMm>]) -> Result<RingsMm, KernelError> {
    let s = to_fixed_many(subjects)?;
    Ok(from_fixed_many(&union_subjects_64(&s, CFillRule::NonZero)))
}

/// Giao của hai tập vòng.
pub fn intersection(
    subjects: &[Vec<PointMm>],
    clips: &[Vec<PointMm>],
) -> Result<RingsMm, KernelError> {
    let s = to_fixed_many(subjects)?;
    let c = to_fixed_many(clips)?;
    Ok(from_fixed_many(&intersect_64(&s, &c, CFillRule::NonZero)))
}

/// Hiệu `subjects \ clips`.
pub fn difference(
    subjects: &[Vec<PointMm>],
    clips: &[Vec<PointMm>],
) -> Result<RingsMm, KernelError> {
    let s = to_fixed_many(subjects)?;
    let c = to_fixed_many(clips)?;
    Ok(from_fixed_many(&difference_64(&s, &c, CFillRule::NonZero)))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Offset
// ─────────────────────────────────────────────────────────────────────────────

/// Nở (`delta > 0`) hoặc co (`delta < 0`) tập vòng một lượng mm.
///
/// `delta = 0` trả lại chính đầu vào đã làm sạch. Co quá mức làm hình **tách** thành
/// nhiều vòng hoặc **sập** về rỗng — đó là hành vi đúng và nơi gọi phải xử lý cả hai
/// (spike §3.2 đo được ngưỡng tách/sập trùng đúng lý thuyết).
pub fn offset(
    rings: &[Vec<PointMm>],
    delta_mm: f64,
    style: OffsetStyle,
) -> Result<RingsMm, KernelError> {
    if !delta_mm.is_finite() {
        return Err(KernelError::NotFinite);
    }
    if delta_mm.abs() > KERNEL_MAX_ABS_MM {
        return Err(KernelError::CoordinateOutOfRange);
    }
    if !style.miter_limit.is_finite()
        || style.miter_limit < 1.0
        || !style.arc_tolerance_mm.is_finite()
        || style.arc_tolerance_mm < 0.0
    {
        return Err(KernelError::InvalidOffsetStyle);
    }

    let paths = to_fixed_many(rings)?;
    if delta_mm == 0.0 {
        return Ok(from_fixed_many(&paths));
    }
    let out = inflate_paths_64(
        &paths,
        delta_mm * KERNEL_FIXED_POINT_SCALE,
        style.to_clipper_join(),
        CEndType::Polygon,
        style.miter_limit,
        style.arc_tolerance_mm * KERNEL_FIXED_POINT_SCALE,
    );
    Ok(from_fixed_many(&out))
}

// ─────────────────────────────────────────────────────────────────────────────
//  Minkowski lồi — thay thế cho phép Minkowski sai của crate
// ─────────────────────────────────────────────────────────────────────────────

/// Tổng Minkowski của **hai đa giác lồi**: `A ⊕ B`.
///
/// Thuật toán hợp nhất vector cạnh theo góc: đi từ đỉnh thấp nhất của mỗi hình rồi
/// lấy cạnh theo thứ tự góc tăng dần. Chi phí `O(m+n)`, kết quả **chính xác** (tổng
/// Minkowski của hai hình lồi là hình lồi có tập cạnh là hợp hai tập cạnh).
///
/// Đây là phép thay cho `minkowski_sum` của crate. Spike §11.1 đo: 7/7 ca khớp oracle
/// bao lồi tới `1e-9` tương đối, và nhanh hơn phép của crate khoảng `10.000×`.
///
/// Trả [`KernelError::NotConvex`] nếu đầu vào không lồi — cố ý không tự chữa, vì
/// dùng phép này cho hình lõm sẽ cho kết quả sai âm thầm.
pub fn minkowski_convex(a: &[PointMm], b: &[PointMm]) -> Result<Vec<PointMm>, KernelError> {
    if a.len() < 3 || b.len() < 3 {
        return Err(KernelError::DegenerateInput);
    }
    for point in a.iter().chain(b.iter()) {
        check_point(*point)?;
    }
    let a = as_ccw(a);
    let b = as_ccw(b);
    if !is_convex_ccw(&a) || !is_convex_ccw(&b) {
        return Err(KernelError::NotConvex);
    }

    let start_a = lowest_vertex(&a);
    let start_b = lowest_vertex(&b);
    let mut out: Vec<PointMm> = Vec::with_capacity(a.len() + b.len());
    let mut current = PointMm::new(a[start_a].x + b[start_b].x, a[start_a].y + b[start_b].y);
    out.push(current);

    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() || j < b.len() {
        let edge_a = edge_angle(&a, start_a + i);
        let edge_b = edge_angle(&b, start_b + j);
        let take_a = i < a.len() && (j >= b.len() || edge_a <= edge_b);
        let take_b = j < b.len() && (i >= a.len() || edge_b <= edge_a);

        let mut delta = PointMm::new(0.0, 0.0);
        if take_a {
            let (from, to) = edge_points(&a, start_a + i);
            delta.x += to.x - from.x;
            delta.y += to.y - from.y;
            i += 1;
        }
        if take_b {
            let (from, to) = edge_points(&b, start_b + j);
            delta.x += to.x - from.x;
            delta.y += to.y - from.y;
            j += 1;
        }
        current = PointMm::new(current.x + delta.x, current.y + delta.y);
        out.push(current);
    }
    // Đỉnh cuối trùng đỉnh đầu vì đã đi hết một vòng kín.
    out.pop();
    if out.len() < 3 {
        return Err(KernelError::DegenerateInput);
    }
    Ok(out)
}

fn edge_points(ring: &[PointMm], index: usize) -> (PointMm, PointMm) {
    let n = ring.len();
    (ring[index % n], ring[(index + 1) % n])
}

/// Góc của cạnh thứ `index`, chuẩn về `[0, 2π)` để so thứ tự.
fn edge_angle(ring: &[PointMm], index: usize) -> f64 {
    let (from, to) = edge_points(ring, index);
    let angle = (to.y - from.y).atan2(to.x - from.x);
    if angle < 0.0 {
        angle + std::f64::consts::TAU
    } else {
        angle
    }
}

fn lowest_vertex(ring: &[PointMm]) -> usize {
    let mut best = 0usize;
    for index in 1..ring.len() {
        let candidate = ring[index];
        let current = ring[best];
        if candidate.y < current.y || (candidate.y == current.y && candidate.x < current.x) {
            best = index;
        }
    }
    best
}

fn as_ccw(ring: &[PointMm]) -> Vec<PointMm> {
    let mut out = ring.to_vec();
    if signed_area_mm2(&out) < 0.0 {
        out.reverse();
    }
    out
}

/// Kiểm lồi cho vòng **đã** là CCW. Cho phép đỉnh thẳng hàng.
fn is_convex_ccw(ring: &[PointMm]) -> bool {
    let n = ring.len();
    // Dung sai theo thang hình: tích có hướng có đơn vị mm², nên ngưỡng phải nhân
    // với chu vi để hình 5 mm và hình 700 mm dùng cùng một quy tắc.
    let scale = super::transform::perimeter_mm(ring).max(1.0);
    let tol = 1e-9 * scale;
    for index in 0..n {
        let a = ring[index];
        let b = ring[(index + 1) % n];
        let c = ring[(index + 2) % n];
        let cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if cross < -tol {
            return false;
        }
    }
    true
}
