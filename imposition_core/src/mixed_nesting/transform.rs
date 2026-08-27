//! Pose cứng SE(2) — **nguồn chân lý duy nhất** của phép đặt chi tiết lên tờ (P2a).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §3.3, §9.1.
//!
//! ## Hợp đồng
//!
//! ```text
//! p_sheet = R(theta) * (p_source_local - referencePoint) + (tx, ty)
//! ```
//!
//! - `theta` là số thực bất kỳ trong miền liên tục `[0°, 360°)`; file này KHÔNG có
//!   bước góc, không có bảng góc và không snap.
//! - `tx`/`ty` là mm liên tục; file này KHÔNG có lưới toạ độ và không làm tròn.
//! - Mọi phép biến đổi mà engine tự dựng đều là [`RigidTransform`], biểu diễn bằng
//!   `(cos, sin, tx, ty)`. Vì phần tuyến tính chỉ được dựng từ một góc duy nhất,
//!   **mirror/scale/shear không biểu diễn được** — đó là bằng chứng cấu trúc, không
//!   phải một lời kiểm tra ở runtime.
//! - Matrix đến từ bên ngoài (artifact, client) đi qua [`AffineMm`] và **bắt buộc**
//!   qua [`AffineMm::check_rigid`]. Kiểm đủ ba việc: `Rᵀ R ≈ I`, `det(R) ≈ +1` và
//!   bảo toàn hướng signed-area. Chỉ kiểm determinant dương là chưa đủ vì scale đều
//!   cũng cho determinant dương.
//!
//! ## Hệ quy chiếu
//!
//! Trục X sang phải, trục Y **lên trên**, góc dương ngược chiều kim đồng hồ, gốc ở
//! góc trái dưới vùng MediaBox logic. Việc đảo trục Y chỉ xảy ra ở adapter render
//! Canvas/SVG phía desktop — không bao giờ ghi ngược vào core.

use super::model::{canonicalize_angle_deg, PointMm, Pose, Tolerance};

/// Dung sai **không đơn vị** khi kiểm ma trận (trực chuẩn, determinant, shear).
///
/// Thuộc bộ tolerance version 1. Nới hơn nhiễu `f64` thuần (~2.2e-16) vài bậc để
/// việc ghép vài phép biến đổi liên tiếp không bị báo drift oan, nhưng vẫn chặt hơn
/// mọi sai lệch hình học có ý nghĩa trong ngành in nhiều bậc.
pub const MATRIX_TOL: f64 = 1e-9;

/// Dung sai **tương đối** khi so diện tích trước/sau biến đổi. Cùng version 1.
pub const AREA_REL_TOL: f64 = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
//  RigidTransform — thứ duy nhất engine tự dựng
// ─────────────────────────────────────────────────────────────────────────────

/// Phép biến đổi cứng trong `SE(2)`: `p ↦ R(theta) · p + (tx, ty)`.
///
/// Lưu `cos`/`sin` thay vì bốn ô ma trận. Hệ quả: không có chỗ nào để nhét scale,
/// shear hay mirror vào.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RigidTransform {
    cos: f64,
    sin: f64,
    tx: f64,
    ty: f64,
}

impl RigidTransform {
    /// Phép đồng nhất.
    pub const fn identity() -> Self {
        Self {
            cos: 1.0,
            sin: 0.0,
            tx: 0.0,
            ty: 0.0,
        }
    }

    /// Xoay quanh gốc toạ độ một góc **bất kỳ** (degree). `None` nếu góc không hữu hạn.
    pub fn from_rotation_deg(deg: f64, tol: &Tolerance) -> Option<Self> {
        let canon = canonicalize_angle_deg(deg, tol)?;
        let rad = canon.to_radians();
        Some(Self {
            cos: rad.cos(),
            sin: rad.sin(),
            tx: 0.0,
            ty: 0.0,
        })
    }

    /// Tịnh tiến thuần, mm liên tục.
    pub fn from_translation_mm(dx: f64, dy: f64) -> Option<Self> {
        (dx.is_finite() && dy.is_finite()).then_some(Self {
            cos: 1.0,
            sin: 0.0,
            tx: dx,
            ty: dy,
        })
    }

    /// Dựng đúng hợp đồng pose: xoay quanh `reference` rồi đưa `reference` tới
    /// `(pose.translateXmm, pose.translateYmm)`.
    ///
    /// Khai triển: `R·(p − ref) + t = R·p + (t − R·ref)`, nên pivot được nạp thẳng
    /// vào phần tịnh tiến — không cần ghép ba phép rời rạc và không tích lũy sai số.
    pub fn from_pose_about_reference(
        pose: &Pose,
        reference: PointMm,
        tol: &Tolerance,
    ) -> Option<Self> {
        if !pose.is_finite() || !reference.is_finite() {
            return None;
        }
        let canon = canonicalize_angle_deg(pose.rotation_deg, tol)?;
        let rad = canon.to_radians();
        let (sin, cos) = rad.sin_cos();
        let rotated_ref_x = cos * reference.x - sin * reference.y;
        let rotated_ref_y = sin * reference.x + cos * reference.y;
        Some(Self {
            cos,
            sin,
            tx: pose.translate_x_mm - rotated_ref_x,
            ty: pose.translate_y_mm - rotated_ref_y,
        })
    }

    /// Áp lên một điểm.
    pub fn apply(&self, point: PointMm) -> PointMm {
        PointMm::new(
            self.cos * point.x - self.sin * point.y + self.tx,
            self.sin * point.x + self.cos * point.y + self.ty,
        )
    }

    /// Áp lên cả một vòng contour. Giữ nguyên thứ tự đỉnh ⇒ không đảo hướng.
    pub fn apply_ring(&self, ring: &[PointMm]) -> Vec<PointMm> {
        ring.iter().map(|point| self.apply(*point)).collect()
    }

    /// Ghép: `self ∘ inner` — áp `inner` trước, rồi `self`.
    ///
    /// Đây là phép dùng cho `placementPose ∘ sourceToLocal` ở §9.1.
    pub fn compose(&self, inner: &Self) -> Self {
        Self {
            cos: self.cos * inner.cos - self.sin * inner.sin,
            sin: self.sin * inner.cos + self.cos * inner.sin,
            tx: self.cos * inner.tx - self.sin * inner.ty + self.tx,
            ty: self.sin * inner.tx + self.cos * inner.ty + self.ty,
        }
    }

    /// Nghịch đảo. Với phép cứng, `R⁻¹ = Rᵀ = R(−theta)`.
    pub fn inverse(&self) -> Self {
        Self {
            cos: self.cos,
            sin: -self.sin,
            tx: -(self.cos * self.tx + self.sin * self.ty),
            ty: -(-self.sin * self.tx + self.cos * self.ty),
        }
    }

    /// Góc xoay, degree, đã canonical về `[0°, 360°)`.
    pub fn rotation_deg(&self, tol: &Tolerance) -> f64 {
        canonicalize_angle_deg(self.sin.atan2(self.cos).to_degrees(), tol).unwrap_or(0.0)
    }

    /// Thành phần tịnh tiến, mm.
    pub const fn translation_mm(&self) -> PointMm {
        PointMm {
            x: self.tx,
            y: self.ty,
        }
    }

    /// Chuyển sang dạng ma trận để kiểm parity với artifact bên ngoài.
    pub const fn to_affine(&self) -> AffineMm {
        AffineMm {
            m00: self.cos,
            m01: -self.sin,
            m10: self.sin,
            m11: self.cos,
            tx: self.tx,
            ty: self.ty,
        }
    }

    pub fn is_finite(&self) -> bool {
        self.cos.is_finite() && self.sin.is_finite() && self.tx.is_finite() && self.ty.is_finite()
    }
}

impl Default for RigidTransform {
    fn default() -> Self {
        Self::identity()
    }
}

/// Phép đưa nội dung nguồn về hệ local mm của chi tiết.
///
/// Giá trị do backend sở hữu (§9.1). Trong thế giới mm nó là phép **cứng**; việc đổi
/// đơn vị pt↔mm chỉ xảy ra ở lớp dựng PDF, không nằm ở đây.
pub type SourceToLocal = RigidTransform;

/// Ghép phép biến đổi dùng cho export: `placementPose ∘ sourceToLocal`.
///
/// Kết quả được kiểm cứng ngay tại đây, nên không có đường nào để một
/// `sourceToLocal` bị hỏng lọt vào artifact giao sản xuất.
pub fn export_transform(
    pose: &Pose,
    reference: PointMm,
    source_to_local: &SourceToLocal,
    tol: &Tolerance,
) -> Result<RigidTransform, RigidityViolation> {
    let placement = RigidTransform::from_pose_about_reference(pose, reference, tol)
        .ok_or(RigidityViolation::NotFinite)?;
    source_to_local
        .to_affine()
        .check_rigid()
        .map_err(|_| RigidityViolation::NotFinite)?;
    let composed = placement.compose(source_to_local);
    composed.to_affine().check_rigid()?;
    Ok(composed)
}

// ─────────────────────────────────────────────────────────────────────────────
//  AffineMm — cửa kiểm cho ma trận đến từ bên ngoài
// ─────────────────────────────────────────────────────────────────────────────

/// Ma trận affine 2×3 dạng tường minh:
///
/// ```text
/// x' = m00·x + m01·y + tx
/// y' = m10·x + m11·y + ty
/// ```
///
/// Cố ý **không** dùng thứ tự `[a b c d e f]` của PDF để khỏi nhầm nghĩa cột/hàng.
/// Kiểu này chỉ tồn tại để *kiểm* ma trận từ artifact hoặc payload; engine không bao
/// giờ tính pose bằng nó.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AffineMm {
    pub m00: f64,
    pub m01: f64,
    pub m10: f64,
    pub m11: f64,
    pub tx: f64,
    pub ty: f64,
}

/// Vi phạm tính cứng của một ma trận.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RigidityViolation {
    /// Có phần tử không hữu hạn.
    NotFinite,
    /// `det < 0` — phản chiếu (mirror). Luôn bị cấm trong bình mặt trước.
    Reflected { determinant: f64 },
    /// Hai cột không vuông góc — shear.
    Shear { column_dot: f64 },
    /// Chuẩn cột khác 1 — scale.
    ScaleDrift { column_norm: f64 },
    /// `det` lệch khỏi `+1` ngoài dung sai (drift tích lũy).
    DeterminantDrift { determinant: f64 },
    /// Hướng signed-area của contour bị đảo sau biến đổi.
    SignedAreaReversed { before_mm2: f64, after_mm2: f64 },
    /// Độ lớn diện tích đổi ngoài dung sai tương đối (scale ẩn).
    AreaMagnitudeDrift { before_mm2: f64, after_mm2: f64 },
}

impl RigidityViolation {
    /// Mã ổn định để backend/frontend map lỗi.
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFinite => "TRANSFORM_NOT_FINITE",
            Self::Reflected { .. } => "TRANSFORM_REFLECTED",
            Self::Shear { .. } => "TRANSFORM_SHEAR",
            Self::ScaleDrift { .. } => "TRANSFORM_SCALE",
            Self::DeterminantDrift { .. } => "TRANSFORM_DETERMINANT_DRIFT",
            Self::SignedAreaReversed { .. } => "TRANSFORM_SIGNED_AREA_REVERSED",
            Self::AreaMagnitudeDrift { .. } => "TRANSFORM_AREA_DRIFT",
        }
    }

    /// Thông báo tiếng Việt cho người dùng cuối.
    pub fn message_vi(self) -> &'static str {
        match self {
            Self::NotFinite => "Phép biến đổi chứa số không hữu hạn.",
            Self::Reflected { .. } => {
                "Phép biến đổi có lật gương — bình mặt trước không cho phép lật khuôn."
            }
            Self::Shear { .. } => "Phép biến đổi có kéo xiên — chỉ được xoay và dịch.",
            Self::ScaleDrift { .. } => {
                "Phép biến đổi có phóng/thu tỉ lệ — kích thước chi tiết phải giữ nguyên."
            }
            Self::DeterminantDrift { .. } => "Phép biến đổi sai lệch khỏi phép xoay thuần.",
            Self::SignedAreaReversed { .. } => {
                "Nét cắt bị đảo hướng sau biến đổi — dấu hiệu lật gương."
            }
            Self::AreaMagnitudeDrift { .. } => {
                "Diện tích chi tiết đổi sau biến đổi — dấu hiệu phóng/thu tỉ lệ."
            }
        }
    }
}

impl AffineMm {
    /// Determinant của phần tuyến tính.
    pub fn determinant(&self) -> f64 {
        self.m00 * self.m11 - self.m01 * self.m10
    }

    /// Tích vô hướng hai cột — bằng 0 khi hai cột vuông góc.
    pub fn column_dot(&self) -> f64 {
        self.m00 * self.m01 + self.m10 * self.m11
    }

    /// Chuẩn của hai cột.
    pub fn column_norms(&self) -> (f64, f64) {
        (
            (self.m00 * self.m00 + self.m10 * self.m10).sqrt(),
            (self.m01 * self.m01 + self.m11 * self.m11).sqrt(),
        )
    }

    /// Kiểm `Rᵀ R ≈ I` và `det ≈ +1`.
    ///
    /// Thứ tự kiểm có chủ đích để mã lỗi nói đúng bệnh: hữu hạn → phản chiếu →
    /// kéo xiên → phóng/thu → drift determinant.
    pub fn check_rigid(&self) -> Result<(), RigidityViolation> {
        for value in [self.m00, self.m01, self.m10, self.m11, self.tx, self.ty] {
            if !value.is_finite() {
                return Err(RigidityViolation::NotFinite);
            }
        }

        let det = self.determinant();
        if det <= 0.0 {
            return Err(RigidityViolation::Reflected { determinant: det });
        }

        let dot = self.column_dot();
        if dot.abs() > MATRIX_TOL {
            return Err(RigidityViolation::Shear { column_dot: dot });
        }

        let (norm0, norm1) = self.column_norms();
        for norm in [norm0, norm1] {
            if (norm - 1.0).abs() > MATRIX_TOL {
                return Err(RigidityViolation::ScaleDrift { column_norm: norm });
            }
        }

        if (det - 1.0).abs() > MATRIX_TOL {
            return Err(RigidityViolation::DeterminantDrift { determinant: det });
        }

        Ok(())
    }

    /// Dựng lại [`RigidTransform`] từ ma trận **sau khi** đã qua [`Self::check_rigid`].
    ///
    /// Đây là đường duy nhất để một matrix bên ngoài trở thành pose của engine —
    /// nhờ vậy không tồn tại hai nguồn chân lý (theta và matrix) lệch nhau.
    pub fn try_into_rigid(&self) -> Result<RigidTransform, RigidityViolation> {
        self.check_rigid()?;
        Ok(RigidTransform {
            cos: self.m00,
            sin: self.m10,
            tx: self.tx,
            ty: self.ty,
        })
    }

    /// So parity với ma trận dựng lại từ `theta` — chống matrix drift trong artifact.
    pub fn matches(&self, other: &Self) -> bool {
        [
            self.m00 - other.m00,
            self.m01 - other.m01,
            self.m10 - other.m10,
            self.m11 - other.m11,
        ]
        .iter()
        .all(|delta| delta.abs() <= MATRIX_TOL)
            && (self.tx - other.tx).abs() <= MATRIX_TOL
            && (self.ty - other.ty).abs() <= MATRIX_TOL
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Diện tích có dấu — chốt thứ ba của kiểm không-phản-chiếu
// ─────────────────────────────────────────────────────────────────────────────

/// Diện tích có dấu (shoelace), mm². CCW dương, CW âm.
///
/// Vòng được coi là kín ngầm định: đỉnh cuối nối về đỉnh đầu.
pub fn signed_area_mm2(ring: &[PointMm]) -> f64 {
    if ring.len() < 3 {
        return 0.0;
    }
    let mut total = 0.0;
    for index in 0..ring.len() {
        let current = ring[index];
        let next = ring[(index + 1) % ring.len()];
        total += current.x * next.y - next.x * current.y;
    }
    total / 2.0
}

/// Chu vi của vòng, mm — dùng để chuẩn hoá dung sai theo thang hình.
pub fn perimeter_mm(ring: &[PointMm]) -> f64 {
    if ring.len() < 2 {
        return 0.0;
    }
    let mut total = 0.0;
    for index in 0..ring.len() {
        let current = ring[index];
        let next = ring[(index + 1) % ring.len()];
        total += ((next.x - current.x).powi(2) + (next.y - current.y).powi(2)).sqrt();
    }
    total
}

/// Kiểm phép biến đổi bảo toàn **hướng** và **độ lớn** diện tích của một contour.
///
/// Đây là chốt thứ ba mà kế hoạch §3.3 đòi, độc lập với hai chốt ma trận: nó làm
/// việc trên chính contour đã transform nên bắt được cả lật gương lẫn scale ẩn dù
/// ma trận có được khai báo thế nào.
pub fn check_ring_orientation_preserved(
    original: &[PointMm],
    transformed: &[PointMm],
) -> Result<(), RigidityViolation> {
    let before = signed_area_mm2(original);
    let after = signed_area_mm2(transformed);
    if !before.is_finite() || !after.is_finite() {
        return Err(RigidityViolation::NotFinite);
    }
    if before * after < 0.0 {
        return Err(RigidityViolation::SignedAreaReversed {
            before_mm2: before,
            after_mm2: after,
        });
    }
    let scale = before.abs().max(after.abs()).max(1.0);
    if (before.abs() - after.abs()).abs() > AREA_REL_TOL * scale {
        return Err(RigidityViolation::AreaMagnitudeDrift {
            before_mm2: before,
            after_mm2: after,
        });
    }
    Ok(())
}

/// Áp pose lên contour rồi kiểm đủ ba chốt không-phản-chiếu.
///
/// Hàm này là đường được khuyến nghị cho mọi nơi cần "đặt chi tiết lên tờ": nó
/// không thể trả về một contour đã bị lật, phóng hay kéo xiên.
pub fn place_ring_checked(
    ring: &[PointMm],
    pose: &Pose,
    reference: PointMm,
    tol: &Tolerance,
) -> Result<Vec<PointMm>, RigidityViolation> {
    let transform = RigidTransform::from_pose_about_reference(pose, reference, tol)
        .ok_or(RigidityViolation::NotFinite)?;
    transform.to_affine().check_rigid()?;
    let placed = transform.apply_ring(ring);
    if placed.iter().any(|point| !point.is_finite()) {
        return Err(RigidityViolation::NotFinite);
    }
    check_ring_orientation_preserved(ring, &placed)?;
    Ok(placed)
}
