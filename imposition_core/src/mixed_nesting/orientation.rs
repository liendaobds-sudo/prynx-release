//! Chuẩn hoá rotation policy và cung góc (P2a).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9.2, §11.6.
//!
//! File này biến [`RotationConstraint`] (hợp đồng trên đường truyền) thành
//! [`RotationDomain`] (dạng canonical mà solver và validator dùng chung).
//!
//! ## Điều file này KHÔNG làm
//!
//! Nó **không** sinh danh sách góc để solver quét. `free` và `ranges` vẫn là miền
//! **vô hạn góc**: `RotationDomain` chỉ lưu biên của miền, còn việc lấy mẫu là cơ chế
//! tìm kiếm của `candidates.rs`/`refine.rs` (P3b) và không được ghi ngược thành giới
//! hạn hợp lệ. Không có `angle_step`, không có quantization, không có snap ở đây.

use super::model::{
    canonicalize_angle_deg, MixedNestingRequest, PartSpec, RotationConstraint, RotationDomainKind,
    Tolerance,
};

/// Một cung góc đã canonical: `0 ≤ start_deg ≤ end_deg ≤ 360`.
///
/// Cung vượt qua `0°` được **tách** thành hai cung tại `0°`/`360°` để biểu diễn là
/// duy nhất và so sánh không mơ hồ. Việc kiểm thuộc miền vẫn xử lý đúng chỗ nối
/// (xem [`RotationDomain::contains`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalArc {
    pub start_deg: f64,
    pub end_deg: f64,
}

impl CanonicalArc {
    /// Độ mở của cung, degree.
    pub fn span_deg(&self) -> f64 {
        self.end_deg - self.start_deg
    }
}

/// Miền góc hợp lệ ở dạng canonical.
#[derive(Debug, Clone, PartialEq)]
pub enum RotationDomain {
    /// Toàn miền liên tục `[0°, 360°)` — mặc định của engine.
    Full,
    /// Tập góc hữu hạn, đã canonical, tăng dần, đã gộp trùng trong dung sai.
    Discrete(Vec<f64>),
    /// Hợp các cung liên tục, đã tách tại `0°`, sắp xếp và gộp chồng lấn.
    Arcs(Vec<CanonicalArc>),
}

impl RotationDomain {
    /// Loại miền, dùng cho report và test.
    pub fn kind(&self) -> RotationDomainKind {
        match self {
            Self::Full => RotationDomainKind::Full,
            Self::Discrete(angles) if angles.len() == 1 => RotationDomainKind::SingleAngle,
            Self::Discrete(angles) => RotationDomainKind::DiscreteSet {
                count: angles.len(),
            },
            Self::Arcs(arcs) => RotationDomainKind::ContinuousArcs { count: arcs.len() },
        }
    }

    /// Miền có vô hạn góc hợp lệ hay không.
    pub fn is_continuous(&self) -> bool {
        matches!(self, Self::Full | Self::Arcs(_))
    }

    /// Tổng độ mở của miền, degree. `Full` ⇒ `360`, tập rời rạc ⇒ `0`.
    ///
    /// Dùng để chứng minh `fast/balanced/tight` không thu hẹp miền: cùng một
    /// constraint phải cho cùng một `total_span_deg` với mọi profile.
    pub fn total_span_deg(&self) -> f64 {
        match self {
            Self::Full => 360.0,
            Self::Discrete(_) => 0.0,
            Self::Arcs(arcs) => arcs.iter().map(CanonicalArc::span_deg).sum(),
        }
    }

    /// Danh sách góc rời rạc, nếu miền thuộc dạng đó.
    pub fn angles_deg(&self) -> Option<&[f64]> {
        match self {
            Self::Discrete(angles) => Some(angles),
            _ => None,
        }
    }

    /// Danh sách cung canonical, nếu miền thuộc dạng đó.
    pub fn arcs(&self) -> Option<&[CanonicalArc]> {
        match self {
            Self::Arcs(arcs) => Some(arcs),
            _ => None,
        }
    }

    /// Góc `deg` có thuộc miền hợp lệ hay không.
    ///
    /// Xử lý đúng chỗ nối `0°/360°`: một góc canonical về `0.0` vẫn được coi là thuộc
    /// cung `[350°, 360°]` nhờ so thêm `deg + 360`.
    pub fn contains(&self, deg: f64, tol: &Tolerance) -> bool {
        let Some(canon) = canonicalize_angle_deg(deg, tol) else {
            return false;
        };
        match self {
            Self::Full => true,
            Self::Discrete(angles) => angles
                .iter()
                .any(|angle| circular_distance_deg(canon, *angle) <= tol.angular_deg),
            Self::Arcs(arcs) => arcs.iter().any(|arc| {
                let low = arc.start_deg - tol.angular_deg;
                let high = arc.end_deg + tol.angular_deg;
                (canon >= low && canon <= high) || (canon + 360.0 >= low && canon + 360.0 <= high)
            }),
        }
    }
}

/// Khoảng cách góc trên đường tròn, degree — luôn thuộc `[0°, 180°]`.
///
/// Cần cho so sánh ở biên: `359.9999°` và `0.0001°` cách nhau `0.0002°`, không phải
/// `359.9998°`.
pub fn circular_distance_deg(a: f64, b: f64) -> f64 {
    let raw = (a - b).abs() % 360.0;
    raw.min(360.0 - raw)
}

/// Lỗi khi phân giải rotation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrientationError {
    /// `inherit` chưa được phân giải — gọi [`resolve_part_domain`] thay vì phân giải trực tiếp.
    InheritNotResolved,
    /// Miền góc rỗng sau khi chuẩn hoá.
    EmptyDomain,
    /// Có góc không hữu hạn.
    NonFiniteAngle,
    /// `sweepDeg` không thuộc `(0°, 360°]`.
    ArcSweepOutOfRange,
}

impl OrientationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InheritNotResolved => "ROTATION_INHERIT_NOT_RESOLVED",
            Self::EmptyDomain => "ROTATION_DOMAIN_EMPTY",
            Self::NonFiniteAngle => "ROTATION_ANGLE_NOT_FINITE",
            Self::ArcSweepOutOfRange => "ROTATION_ARC_SWEEP_OUT_OF_RANGE",
        }
    }

    pub fn message_vi(self) -> &'static str {
        match self {
            Self::InheritNotResolved => {
                "Ràng buộc xoay 'kế thừa' chưa được phân giải về chính sách cấp job."
            }
            Self::EmptyDomain => "Không còn góc xoay nào hợp lệ sau khi chuẩn hoá.",
            Self::NonFiniteAngle => "Góc xoay phải là số hữu hạn.",
            Self::ArcSweepOutOfRange => "Độ mở cung góc phải thuộc khoảng (0°, 360°].",
        }
    }
}

/// Chuẩn hoá một [`RotationConstraint`] đã phân giải thành [`RotationDomain`].
///
/// `Inherit` bị từ chối ở đây có chủ đích: nếu hàm này âm thầm coi `inherit` là `free`
/// thì một part bị khoá hướng có thể được xoay tự do mà không ai thấy.
pub fn resolve_rotation_domain(
    constraint: &RotationConstraint,
    tol: &Tolerance,
) -> Result<RotationDomain, OrientationError> {
    match constraint {
        RotationConstraint::Inherit => Err(OrientationError::InheritNotResolved),
        RotationConstraint::Free => Ok(RotationDomain::Full),
        RotationConstraint::Fixed { angle_deg } => {
            let canon =
                canonicalize_angle_deg(*angle_deg, tol).ok_or(OrientationError::NonFiniteAngle)?;
            Ok(RotationDomain::Discrete(vec![canon]))
        }
        RotationConstraint::Discrete { angles_deg } => {
            canonicalize_discrete(angles_deg, tol).map(RotationDomain::Discrete)
        }
        RotationConstraint::Ranges { arcs } => canonicalize_arcs(arcs, tol),
    }
}

/// Phân giải ràng buộc xoay có hiệu lực của một chi tiết rồi chuẩn hoá.
///
/// Thứ tự: `part.rotationConstraint` → nếu `inherit` thì lấy
/// `orientationPolicy.defaultRotation` → chuẩn hoá. Hàm **không** nhận `profile`, nên
/// `fast/balanced/tight` không có đường nào ảnh hưởng tới miền góc.
pub fn resolve_part_domain(
    request: &MixedNestingRequest,
    part: &PartSpec,
    tol: &Tolerance,
) -> Result<RotationDomain, OrientationError> {
    resolve_rotation_domain(request.effective_rotation(part), tol)
}

/// Chuẩn hoá tập góc rời rạc: canonical → tăng dần → gộp trùng trong dung sai.
fn canonicalize_discrete(
    angles_deg: &[f64],
    tol: &Tolerance,
) -> Result<Vec<f64>, OrientationError> {
    if angles_deg.is_empty() {
        return Err(OrientationError::EmptyDomain);
    }
    let mut canon: Vec<f64> = Vec::with_capacity(angles_deg.len());
    for angle in angles_deg {
        canon.push(canonicalize_angle_deg(*angle, tol).ok_or(OrientationError::NonFiniteAngle)?);
    }
    // Đã canonical nên mọi giá trị thuộc [0,360) và so sánh f64 là tổng thứ tự.
    canon.sort_by(|a, b| a.partial_cmp(b).expect("góc đã canonical nên không có NaN"));
    let mut unique: Vec<f64> = Vec::with_capacity(canon.len());
    for angle in canon {
        let trung = unique
            .iter()
            .any(|kept| circular_distance_deg(*kept, angle) <= tol.angular_deg);
        if !trung {
            unique.push(angle);
        }
    }
    if unique.is_empty() {
        return Err(OrientationError::EmptyDomain);
    }
    Ok(unique)
}

/// Chuẩn hoá danh sách cung: tách tại `0°`, sắp xếp, gộp chồng lấn, thu về `Full` khi
/// phủ kín vòng.
fn canonicalize_arcs(
    arcs: &[super::model::AngleArcDeg],
    tol: &Tolerance,
) -> Result<RotationDomain, OrientationError> {
    if arcs.is_empty() {
        return Err(OrientationError::EmptyDomain);
    }

    let mut pieces: Vec<CanonicalArc> = Vec::with_capacity(arcs.len() * 2);
    for arc in arcs {
        if !arc.start_deg.is_finite() || !arc.sweep_deg.is_finite() {
            return Err(OrientationError::NonFiniteAngle);
        }
        if arc.sweep_deg <= 0.0 || arc.sweep_deg > 360.0 {
            return Err(OrientationError::ArcSweepOutOfRange);
        }
        // Một cung mở gần trọn vòng thì miền chính là toàn bộ vòng.
        if arc.sweep_deg >= 360.0 - tol.angular_deg {
            return Ok(RotationDomain::Full);
        }
        let start =
            canonicalize_angle_deg(arc.start_deg, tol).ok_or(OrientationError::NonFiniteAngle)?;
        let end = start + arc.sweep_deg;
        if end <= 360.0 {
            pieces.push(CanonicalArc {
                start_deg: start,
                end_deg: end,
            });
        } else {
            // Tách tại 0°/360° để biểu diễn canonical là duy nhất.
            pieces.push(CanonicalArc {
                start_deg: start,
                end_deg: 360.0,
            });
            pieces.push(CanonicalArc {
                start_deg: 0.0,
                end_deg: end - 360.0,
            });
        }
    }

    pieces.sort_by(|a, b| {
        a.start_deg
            .partial_cmp(&b.start_deg)
            .expect("cung đã canonical nên không có NaN")
    });

    let mut merged: Vec<CanonicalArc> = Vec::with_capacity(pieces.len());
    for piece in pieces {
        match merged.last_mut() {
            Some(last) if piece.start_deg <= last.end_deg + tol.angular_deg => {
                if piece.end_deg > last.end_deg {
                    last.end_deg = piece.end_deg;
                }
            }
            _ => merged.push(piece),
        }
    }

    if merged.is_empty() {
        return Err(OrientationError::EmptyDomain);
    }
    // Phủ kín [0°, 360°] bằng các cung ghép lại ⇒ chính là miền tự do.
    if merged.len() == 1
        && merged[0].start_deg <= tol.angular_deg
        && merged[0].end_deg >= 360.0 - tol.angular_deg
    {
        return Ok(RotationDomain::Full);
    }
    Ok(RotationDomain::Arcs(merged))
}
