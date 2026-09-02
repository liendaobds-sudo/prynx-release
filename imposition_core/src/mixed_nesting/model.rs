//! Hợp đồng dữ liệu của `mixed_nesting` — công cụ "Bình lồng ghép tự do" (phase P1).
//!
//! Nguồn chân lý: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9.
//!
//! ## Bất biến hình học được khóa ở đây
//!
//! 1. Placement là **pose cứng trong SE(2)**:
//!    `p_sheet = R(theta) * (p_source_local - referencePoint) + (tx, ty)`.
//! 2. `theta` mặc định **tự do trong miền liên tục `[0°, 360°)`**. Các preset "giữ
//!    hướng", "0/180", "0/90/180/270" chỉ là *rotation constraint* tùy chọn, không
//!    phải miền xoay của engine.
//! 3. `tx`/`ty` là **toạ độ mm liên tục**. Hợp đồng KHÔNG có `translationStepMm`,
//!    không có snap grid, không có bước dịch cố định.
//! 4. Reflection (mirror), scale và shear **luôn bị cấm**: [`Reflection`] chỉ có đúng
//!    một biến thể `forbidden`, nên không tồn tại đường bật mirror ở cấp dữ liệu.
//! 5. Client không được gửi matrix tùy ý. Mọi struct request đều
//!    `deny_unknown_fields`, nên `matrix`/`transform`/`scale`/`shear`/`mirror`/
//!    `translationStepMm`/`allowedRotationsDeg` bị từ chối ngay khi deserialize.
//!
//! ## Đơn vị
//!
//! Toàn bộ hình học dùng **mm**; góc trong API dùng **degree** (dương ngược chiều kim
//! đồng hồ, trục X sang phải, trục Y lên trên, gốc ở góc trái dưới vùng MediaBox
//! logic của tờ). Nội bộ Rust có thể đổi sang radian ở các phase sau.
//!
//! ## Phạm vi P1
//!
//! File này chỉ chốt *hợp đồng* + *validation dữ liệu*. Chuẩn hoá contour (loại điểm
//! lặp, collinear noise, tự cắt, diện tích gần 0) thuộc `normalize.rs` ở P2a; solver,
//! NFP và validator hình học thuộc các phase sau. Không import và không gọi solver
//! N-Up / Sticker / Dieline / NFP hiện tại.

use std::collections::BTreeSet;
use std::fmt;
use std::num::NonZeroU32;

use serde::de::{Deserializer, Error as DeError};
use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
//  Hằng số hợp đồng có version
// ─────────────────────────────────────────────────────────────────────────────

/// Phiên bản protocol JSON giữa sidecar và engine. Request khai báo version khác
/// giá trị này bị từ chối — không có nhánh "đoán ý" theo hình dạng payload.
pub const MIXED_NESTING_PROTOCOL_VERSION: u32 = 2;

/// Phiên bản engine lồng ghép. Cố ý TÁCH khỏi version crate `imposition_core`:
/// đây là hợp đồng của riêng `mixed_nesting`, dùng để so provenance của manifest.
pub const MIXED_NESTING_ENGINE_VERSION: &str = "0.3.0";

/// Phiên bản final validator (ghi vào `manifest.validation.validatorVersion`).
pub const MIXED_NESTING_VALIDATOR_VERSION: u32 = 2;

/// Phiên bản bộ tolerance tuyến tính/góc. Đổi số dung sai là đổi hợp đồng ⇒ phải
/// tăng version này để manifest cũ không bị đọc sai.
pub const MIXED_NESTING_TOLERANCE_VERSION: u32 = 1;

/// Phiên bản quy tắc canonicalization góc (xem [`canonicalize_angle_deg`]).
pub const MIXED_NESTING_CANONICALIZATION_VERSION: u32 = 1;

// ── Ngưỡng admission của protocol ────────────────────────────────────────────
//
// Đây là *chốt an toàn của giao thức* (chống payload phi lý hoặc độc hại), KHÔNG
// phải cap hiệu năng theo phần cứng. Số worker và ngân sách RAM do backend quyết
// bằng `plan_worker_count` (chỉ máy <8 GB và <16 GB mới giảm; máy ≥16 GB giữ full).
// Tuyệt đối không chép cap phần cứng xuống Rust.

/// Số loại chi tiết tối đa trong một job.
pub const MAX_PARTS: usize = 2_000;
/// Số lượng tối đa của một loại chi tiết.
pub const MAX_QUANTITY_PER_PART: u32 = 100_000;
/// Tổng số instance tối đa của cả job.
pub const MAX_INSTANCES_TOTAL: u64 = 100_000;
/// Số đỉnh tối đa của một vòng (contour ngoài hoặc một lỗ).
pub const MAX_RING_VERTICES: usize = 20_000;
/// Tổng số đỉnh tối đa của cả request.
pub const MAX_TOTAL_VERTICES: usize = 2_000_000;
/// Số lỗ tối đa của một chi tiết.
pub const MAX_HOLES_PER_PART: usize = 1_000;
/// Trần `sheet.maxSheets`.
pub const MAX_SHEETS_LIMIT: u32 = 10_000;
/// Độ dài tối đa của `partId`.
pub const MAX_PART_ID_LEN: usize = 128;
/// Số góc tối đa trong `discrete { anglesDeg }`.
pub const MAX_ROTATION_ANGLES: usize = 4_096;
/// Số cung tối đa trong `ranges { arcs }`.
pub const MAX_ROTATION_ARCS: usize = 1_024;
/// Số vùng cấm cố định tối đa trong production contract.
pub const MAX_FIXED_OBSTACLES: usize = 4_096;
/// Độ dài tối đa của `obstacleId`.
pub const MAX_OBSTACLE_ID_LEN: usize = 128;
/// Độ dài tối đa của job ID server-owned.
pub const MAX_JOB_ID_LEN: usize = 128;
/// Trần `timeBudgetMs` (24 giờ) — chặn deadline vô hạn thực tế.
pub const MAX_TIME_BUDGET_MS: u64 = 24 * 60 * 60 * 1_000;
/// Số lỗi tối đa gom lại trong một lần validate (tránh phình bộ nhớ khi payload xấu).
pub const MAX_REPORTED_ERRORS: usize = 64;

// ─────────────────────────────────────────────────────────────────────────────
//  Tolerance có version
// ─────────────────────────────────────────────────────────────────────────────

/// Dung sai tuyến tính mặc định (mm). Nhỏ hơn mọi sai số cơ khí của dao bế nhưng
/// vẫn cao hơn nhiễu biểu diễn `f64` ở thang mm của tờ in.
pub const DEFAULT_LINEAR_TOL_MM: f64 = 1e-6;

/// Tỉ lệ dung sai của luật lồi **nghiêm** mà phép Minkowski nhanh yêu cầu.
///
/// FIX (audit 2026-08-28 §NFP-CONVEX): trước đây `kernel::minkowski_convex` viết cứng
/// `1e-9` còn `geometry::convex_decompose` nhận lồi theo `Tolerance::linear_mm` (mặc
/// định `1e-6`). Chênh **1000×** nên mảnh có đỉnh lõm trong dải `[1e-9·P, 1e-6·P]` qua
/// được phân rã rồi bị kernel chặn bằng `KERNEL_NOT_CONVEX` — người dùng thấy "không
/// bình được trang" trên khuôn **gần lồi**, trong khi khuôn lõm rõ lại chạy tốt.
///
/// Hằng này là luật duy nhất cho câu hỏi "lồi đủ để Minkowski chưa". Đặt ở `model` vì
/// `geometry` cố ý **không** phụ thuộc `kernel` (xem doc đầu `geometry.rs`), nên hai bên
/// chỉ có thể dùng chung qua module nền này.
pub const CONVEX_STRICT_TOL_RATIO: f64 = 1e-9;

/// Dung sai góc mặc định (degree). Cao hơn sai số round-trip degree↔radian (~1e-12°)
/// vài bậc, nên canonicalization ổn định mà không "ăn" góc thật.
pub const DEFAULT_ANGULAR_TOL_DEG: f64 = 1e-9;

/// Bộ dung sai dùng cho canonicalization và (ở phase sau) cho collision/clearance.
///
/// Cố ý KHÔNG nằm trong request: nếu client đặt được tolerance thì `tight` có thể bị
/// nới correctness, đúng điều kế hoạch cấm. Đây là hằng số của engine, có version.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tolerance {
    /// Version của bộ dung sai — ghi kèm mọi artifact để truy vết.
    pub version: u32,
    /// Dung sai tuyến tính, mm.
    pub linear_mm: f64,
    /// Dung sai góc, degree.
    pub angular_deg: f64,
}

impl Tolerance {
    /// Bộ dung sai v1 — nguồn chân lý hiện hành.
    pub const fn v1() -> Self {
        Self {
            version: MIXED_NESTING_TOLERANCE_VERSION,
            linear_mm: DEFAULT_LINEAR_TOL_MM,
            angular_deg: DEFAULT_ANGULAR_TOL_DEG,
        }
    }
}

impl Default for Tolerance {
    fn default() -> Self {
        Self::v1()
    }
}

/// Chuẩn hoá góc về `[0°, 360°)` theo quy tắc version
/// [`MIXED_NESTING_CANONICALIZATION_VERSION`].
///
/// Quy tắc v1:
/// 1. Góc không hữu hạn ⇒ `None` (không tự chữa thành 0°).
/// 2. `deg % 360` rồi cộng 360 nếu âm.
/// 3. Kết quả cách 0° hoặc 360° trong `tol.angular_deg` ⇒ trả về `0.0` — nhờ vậy
///    `360°`, `-0.0` và `359.999999999°` cùng canonical về `0.0`.
/// 4. KHÔNG snap về bội của bất kỳ bước góc nào. Góc không-cardinal như
///    `13.372849°` được giữ nguyên từng chữ số.
pub fn canonicalize_angle_deg(deg: f64, tol: &Tolerance) -> Option<f64> {
    if !deg.is_finite() {
        return None;
    }
    let mut angle = deg % 360.0;
    if angle < 0.0 {
        angle += 360.0;
    }
    // Gộp hai biên 0°/360° về đúng một đại diện; cũng loại bỏ `-0.0`.
    if angle <= tol.angular_deg || angle >= 360.0 - tol.angular_deg {
        return Some(0.0);
    }
    Some(angle)
}

/// Góc đã ở dạng canonical chưa (thuộc `[0°, 360°)` và trùng chính canonical form).
pub fn is_canonical_angle_deg(deg: f64, tol: &Tolerance) -> bool {
    match canonicalize_angle_deg(deg, tol) {
        Some(canon) => (canon - deg).abs() <= tol.angular_deg,
        None => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểu hình học cơ bản
// ─────────────────────────────────────────────────────────────────────────────

/// Một điểm trên tờ hoặc trong hệ local của chi tiết, đơn vị mm.
///
/// Serialize thành mảng `[x, y]` đúng hình dạng JSON trong kế hoạch §9.2.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 2]", into = "[f64; 2]")]
pub struct PointMm {
    pub x: f64,
    pub y: f64,
}

impl PointMm {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn is_finite(&self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl From<[f64; 2]> for PointMm {
    fn from(value: [f64; 2]) -> Self {
        Self {
            x: value[0],
            y: value[1],
        }
    }
}

impl From<PointMm> for [f64; 2] {
    fn from(value: PointMm) -> Self {
        [value.x, value.y]
    }
}

/// Lề bốn cạnh của tờ vật liệu, mm.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetMarginMm {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// Khổ tờ vật liệu. MVP dùng một khổ duy nhất, tự mở thêm tờ cùng khổ khi cần.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetSpec {
    pub width_mm: f64,
    pub height_mm: f64,
    pub margin_mm: SheetMarginMm,
    pub max_sheets: u32,
}

impl SheetSpec {
    /// Bề rộng vùng dùng được sau khi trừ lề, mm.
    pub fn usable_width_mm(&self) -> f64 {
        self.width_mm - self.margin_mm.left - self.margin_mm.right
    }

    /// Bề cao vùng dùng được sau khi trừ lề, mm.
    pub fn usable_height_mm(&self) -> f64 {
        self.height_mm - self.margin_mm.top - self.margin_mm.bottom
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rotation constraint — discriminated union
// ─────────────────────────────────────────────────────────────────────────────

/// Một cung góc liên tục, degree. `sweepDeg` trong `(0, 360]` nên miền đi qua 0°
/// không mơ hồ (ví dụ `{ startDeg: 350, sweepDeg: 20 }` = `[350°,360°) ∪ [0°,10°]`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AngleArcDeg {
    pub start_deg: f64,
    pub sweep_deg: f64,
}

/// Ràng buộc xoay, dạng discriminated union theo khoá `mode`.
///
/// **`Free` là mặc định của engine.** Bốn mode còn lại chỉ là lựa chọn *thu hẹp*
/// do người dùng đặt ở cấp job hoặc từng chi tiết. `fast/balanced/tight` KHÔNG được
/// đổi miền này — chúng chỉ đổi search effort (xem `control::SearchEffort`).
///
/// `Deserialize` được viết tay qua [`RotationConstraintWire`], KHÔNG dùng derive.
/// Lý do: `deny_unknown_fields` của serde **không có tác dụng** trên internally
/// tagged enum, nên bản derive sẽ *âm thầm bỏ qua* các khoá lạ như `angleStepDeg`
/// hay `translationStepMm`. Kế hoạch cấm đúng hành vi bỏ qua im lặng đó.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RotationConstraint {
    /// Kế thừa policy cấp job. Chỉ hợp lệ ở cấp chi tiết.
    Inherit,
    /// Mọi góc trong miền liên tục `[0°, 360°)` — mặc định.
    Free,
    /// Khóa đúng một góc, có thể là góc không-cardinal (ví dụ `13.372849°`).
    Fixed {
        #[serde(rename = "angleDeg")]
        angle_deg: f64,
    },
    /// Tập góc hữu hạn. Các preset 0/180 và 0/90/180/270 compile về mode này.
    Discrete {
        #[serde(rename = "anglesDeg")]
        angles_deg: Vec<f64>,
    },
    /// Hợp của các cung liên tục — vẫn là miền vô hạn góc, không phải angle grid.
    Ranges { arcs: Vec<AngleArcDeg> },
}

impl Default for RotationConstraint {
    /// Chi tiết không khai `rotationConstraint` ⇒ `inherit` ⇒ (mặc định job) `free`.
    fn default() -> Self {
        Self::Inherit
    }
}

/// Dạng "trên đường truyền" của [`RotationConstraint`].
///
/// Là struct thường nên `deny_unknown_fields` hoạt động thật: mọi khoá ngoài
/// `mode`/`angleDeg`/`anglesDeg`/`arcs` đều bị từ chối. Sau khi deserialize, cặp
/// mode ↔ tham số còn được kiểm chéo để `{"mode":"free","anglesDeg":[0]}` cũng bị
/// chặn thay vì lặng lẽ thành `free`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationConstraintWire {
    mode: String,
    #[serde(default)]
    angle_deg: Option<f64>,
    #[serde(default)]
    angles_deg: Option<Vec<f64>>,
    #[serde(default)]
    arcs: Option<Vec<AngleArcDeg>>,
}

impl RotationConstraintWire {
    /// Tên các trường tham số đang có mặt — dùng để báo lỗi "tham số không thuộc mode".
    fn present_params(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.angle_deg.is_some() {
            names.push("angleDeg");
        }
        if self.angles_deg.is_some() {
            names.push("anglesDeg");
        }
        if self.arcs.is_some() {
            names.push("arcs");
        }
        names
    }

    /// Chỉ cho phép đúng tập tham số của mode; thừa một trường là lỗi.
    fn require_only(&self, allowed: &[&str]) -> Result<(), String> {
        let thua: Vec<&str> = self
            .present_params()
            .into_iter()
            .filter(|name| !allowed.contains(name))
            .collect();
        if thua.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "mode '{}' không nhận tham số {}",
                self.mode,
                thua.join(", ")
            ))
        }
    }
}

impl TryFrom<RotationConstraintWire> for RotationConstraint {
    type Error = String;

    fn try_from(wire: RotationConstraintWire) -> Result<Self, Self::Error> {
        match wire.mode.as_str() {
            "inherit" => {
                wire.require_only(&[])?;
                Ok(Self::Inherit)
            }
            "free" => {
                wire.require_only(&[])?;
                Ok(Self::Free)
            }
            "fixed" => {
                wire.require_only(&["angleDeg"])?;
                let angle_deg = wire
                    .angle_deg
                    .ok_or_else(|| "mode 'fixed' thiếu 'angleDeg'".to_string())?;
                Ok(Self::Fixed { angle_deg })
            }
            "discrete" => {
                wire.require_only(&["anglesDeg"])?;
                let angles_deg = wire
                    .angles_deg
                    .ok_or_else(|| "mode 'discrete' thiếu 'anglesDeg'".to_string())?;
                Ok(Self::Discrete { angles_deg })
            }
            "ranges" => {
                wire.require_only(&["arcs"])?;
                let arcs = wire
                    .arcs
                    .ok_or_else(|| "mode 'ranges' thiếu 'arcs'".to_string())?;
                Ok(Self::Ranges { arcs })
            }
            khac => Err(format!(
                "mode xoay '{khac}' không hợp lệ; chỉ nhận inherit, free, fixed, discrete, ranges"
            )),
        }
    }
}

impl<'de> Deserialize<'de> for RotationConstraint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = RotationConstraintWire::deserialize(deserializer)?;
        Self::try_from(wire).map_err(DeError::custom)
    }
}

impl RotationConstraint {
    /// Preset "Giữ hướng" — khóa 0°.
    pub fn preset_keep_orientation() -> Self {
        Self::Fixed { angle_deg: 0.0 }
    }

    /// Preset "0/180".
    pub fn preset_half_turn() -> Self {
        Self::Discrete {
            angles_deg: vec![0.0, 180.0],
        }
    }

    /// Preset "0/90/180/270". Đây là *preset*, không phải miền xoay của engine.
    pub fn preset_cardinal() -> Self {
        Self::Discrete {
            angles_deg: vec![0.0, 90.0, 180.0, 270.0],
        }
    }

    /// Loại miền góc sau khi đã phân giải `inherit`. `None` = chưa phân giải.
    pub fn domain_kind(&self) -> Option<RotationDomainKind> {
        match self {
            Self::Inherit => None,
            Self::Free => Some(RotationDomainKind::Full),
            Self::Fixed { .. } => Some(RotationDomainKind::SingleAngle),
            Self::Discrete { angles_deg } => Some(RotationDomainKind::DiscreteSet {
                count: angles_deg.len(),
            }),
            Self::Ranges { arcs } => Some(RotationDomainKind::ContinuousArcs { count: arcs.len() }),
        }
    }

    /// Miền có vô hạn góc hợp lệ hay không. `free` và `ranges` ⇒ `true`.
    pub fn allows_continuous_rotation(&self) -> bool {
        self.domain_kind()
            .map(RotationDomainKind::is_continuous)
            .unwrap_or(false)
    }
}

/// Mô tả loại miền góc — dùng để test/report, không phải để solver lấy mẫu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationDomainKind {
    /// Toàn miền liên tục `[0°, 360°)`.
    Full,
    /// Đúng một góc.
    SingleAngle,
    /// Tập góc hữu hạn.
    DiscreteSet { count: usize },
    /// Hợp các cung liên tục.
    ContinuousArcs { count: usize },
}

impl RotationDomainKind {
    /// Miền chứa vô hạn góc hợp lệ.
    pub fn is_continuous(self) -> bool {
        matches!(self, Self::Full | Self::ContinuousArcs { .. })
    }
}

/// Chính sách phản chiếu. Chỉ có đúng một giá trị hợp lệ ⇒ ở cấp kiểu dữ liệu
/// **không tồn tại đường bật mirror**. Payload gửi `"allowed"`/`"mirror"` bị
/// deserialize lỗi, không bị "âm thầm bỏ qua".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reflection {
    #[default]
    Forbidden,
}

/// Chính sách hướng cấp job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrientationPolicy {
    /// Mặc định cho mọi chi tiết không override. Không nhận `inherit` ở cấp này.
    pub default_rotation: RotationConstraint,
    /// Vắng mặt ⇒ `forbidden` (fail-safe).
    #[serde(default)]
    pub reflection: Reflection,
}

/// Ý định bố cục — quyết định request có mang **số lượng cần giao** hay không.
///
/// Đây là hai bài toán khác nhau về nghiệp vụ, không phải hai tuỳ chọn của một bài toán:
///
/// - `QuantityFulfillment`: thợ in đặt N con. `PartSpec.quantity` là **yêu cầu**. Thiếu
///   một con là lỗi sản xuất, nên nó phải vào `unplaced` kèm lý do.
/// - `AutofillSingleSheet`: thợ in muốn "lấp đầy một tờ", chưa có số lượng. Trường
///   `quantity` phải **vắng mặt** trên wire; core biểu diễn sự vắng mặt tạm thời bằng
///   `0`, tuyệt đối không được dùng số này làm trần tìm kiếm.
///
/// [CHẶNG-A LÔ 1 2026-08-27] Vì sao phải có trường này: đo ở Lô 0 cho thấy engine không
/// phân biệt được hai ý định, nên đường sản xuất buộc phải bơm một `quantity` bịa cho ca
/// autofill — đúng thứ kế hoạch §5 cấm ("Không tạo quantity giả cho autofill"). Và
/// `terminationReason` trả về `max_sheets_reached` cho một ca autofill hoàn toàn thành
/// công, đọc như thất bại.
///
/// Mặc định là `QuantityFulfillment` để payload cũ (công cụ Bình lồng ghép tự do
/// standalone) giữ nguyên hành vi từng chữ số.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutIntent {
    /// Phủ đủ số lượng, rồi giảm số tờ. `quantity` là yêu cầu.
    #[default]
    QuantityFulfillment,
    /// Lấp đầy đúng một tờ, không có quantity đích.
    ///
    /// Bắt buộc `sheet.maxSheets == 1`; engine từ chối payload khai khác đi thay vì tự
    /// sửa, để không có hai nguồn chân lý về "một tờ".
    AutofillSingleSheet,
    /// Bình trang một mẫu trên đúng một tờ; ưu tiên quỹ đạo tuần hoàn khi dựng được.
    ///
    /// Đây là intent production tường minh, không được suy từ số part hoặc hình học.
    StepRepeatSingleSheet,
}

impl LayoutIntent {
    /// Ý định này có coi `quantity` là yêu cầu phải phủ đủ hay không.
    pub const fn quantity_la_yeu_cau(self) -> bool {
        matches!(self, Self::QuantityFulfillment)
    }

    /// Hai intent không có quantity và cùng chạy solver lấp đầy một tờ.
    pub const fn is_single_sheet_autofill(self) -> bool {
        matches!(
            self,
            Self::AutofillSingleSheet | Self::StepRepeatSingleSheet
        )
    }

    /// Chỉ S&R tường minh mới cho motif tuần hoàn quyền ưu tiên chế bản.
    pub const fn prefers_periodic_motif(self) -> bool {
        matches!(self, Self::StepRepeatSingleSheet)
    }
}

/// Mức nỗ lực tìm kiếm. **Chỉ đổi work budget**, không đổi miền góc hợp lệ.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Fast,
    /// Mặc định — cân bằng giữa thời gian tìm kiếm và độ chặt của phương án.
    #[default]
    Balanced,
    Tight,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Production contract — identity + clearance + fixed obstacles
// ─────────────────────────────────────────────────────────────────────────────

/// Phiên bản envelope production nằm trong request protocol hiện hành.
pub const MIXED_NESTING_PRODUCTION_SCHEMA_VERSION: u32 = 3;

/// Phiên bản schema của placement manifest production.
///
/// Tăng hằng số này khi đổi nghĩa hoặc xoá trường. Thêm trường tương thích ngược vẫn
/// phải được cân nhắc cùng protocol vì frontend/backend cùng đọc manifest này.
pub const MIXED_NESTING_MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Cách đặt **toàn bộ cụm** sau khi solver đã chốt tương quan giữa các chi tiết.
///
/// Trục Y của engine hướng lên: `top-*` neo `maxY`, `bottom-*` neo `minY`. Đây là
/// field server-owned của production contract vì nó đổi pose authoritative, không
/// phải tuỳ chọn riêng của preview/writer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutAlignment {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    #[default]
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

/// Khoảng hở theo hai trục **của tờ** sau khi đã áp pose.
///
/// Đây không phải khoảng hở theo trục local của chi tiết. Với góc tự do, validator
/// phải đo/nở dị hướng trong sheet-space; xoay một footprint đã nở trước là sai nghĩa.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetAxisClearanceMm {
    pub x_mm: f64,
    pub y_mm: f64,
}

impl SheetAxisClearanceMm {
    pub const fn zero() -> Self {
        Self {
            x_mm: 0.0,
            y_mm: 0.0,
        }
    }

    pub fn max_axis_mm(self) -> f64 {
        self.x_mm.max(self.y_mm)
    }
}

/// Ba lớp khoảng hở không được nhập nhằng với nhau trong đường production.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearanceSpec {
    pub part_to_part: SheetAxisClearanceMm,
    pub part_to_sheet_edge: SheetAxisClearanceMm,
    pub part_to_obstacle: SheetAxisClearanceMm,
}

/// Nguồn nghiệp vụ của một vùng cấm cố định — giữ provenance để artifact giải thích
/// vì sao một vùng trên tờ không được dùng.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixedObstacleKind {
    Gripper,
    SheetMark,
    CncExcludeZone,
    KeepOut,
}

/// Vùng cấm đã materialize trong hệ toạ độ tờ, trước khi solver chạy.
///
/// Mỗi thành phần multipolygon là một record riêng. V1 coi contour này là vật liệu
/// đặc; không có đường đặt chi tiết vào lỗ của obstacle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixedObstacleSpec {
    pub obstacle_id: String,
    pub kind: FixedObstacleKind,
    pub outer: Vec<PointMm>,
}

/// Envelope server-owned bắt buộc trên đường Tem bế/CNC production.
///
/// `None` chỉ giữ tương thích cho công cụ lab cũ. Adapter production phải dựng đầy đủ
/// envelope này; nhờ vậy identity và hình học không thể được cập nhật lệch nửa chừng.
/// Ý định chia vùng độc lập với `layoutIntent` số lượng/autofill.
///
/// PARITY (audit 2026-08-29 MAP-NEST-04): `maximize_area` bắt buộc có partition
/// server-owned; không được tái diễn giải thành free gang.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupingIntent {
    #[default]
    FreeGang,
    MaximizeArea,
}

/// Hình chữ nhật axis-aligned trong hệ tờ (mm, gốc trái-dưới).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AxisAlignedBoundsSpec {
    #[serde(rename = "minXmm")]
    pub min_x_mm: f64,
    #[serde(rename = "minYmm")]
    pub min_y_mm: f64,
    #[serde(rename = "maxXmm")]
    pub max_x_mm: f64,
    #[serde(rename = "maxYmm")]
    pub max_y_mm: f64,
}

/// Vùng đặt server-owned gắn tường minh với một `partId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartPlacementZoneSpec {
    pub part_id: String,
    pub bounds: AxisAlignedBoundsSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionContractV1 {
    pub schema_version: u32,
    pub request_revision: u64,
    /// Chuỗi canonical `sha256:` + 64 ký tự hex thường.
    pub input_hash: String,
    /// Khoá cả input identity, strategy, solver config và version hình học.
    pub layout_fingerprint: String,
    /// Căn cụm là một phần của output pose đã ký; Rust áp đúng một lần trước final
    /// validation, writer không được dịch lại.
    pub alignment: LayoutAlignment,
    pub grouping_intent: GroupingIntent,
    /// Rỗng khi free gang; maximize_area yêu cầu đúng một vùng cho mỗi part.
    pub placement_zones: Vec<PartPlacementZoneSpec>,
    pub clearance: ClearanceSpec,
    #[serde(default)]
    pub fixed_obstacles: Vec<FixedObstacleSpec>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Request
// ─────────────────────────────────────────────────────────────────────────────

/// Một loại chi tiết cần xếp.
///
/// Ba trường cuối là **server-owned**: route công khai không nhận chúng từ client;
/// backend canonicalize contour rồi tự tính/ký. Engine chỉ echo lại để validator và
/// artifact so provenance (xem kế hoạch §9.1 và §9.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PartSpec {
    pub part_id: String,
    /// Số lượng cần giao của `quantity_fulfillment`.
    ///
    /// [CHẶNG-A LÔ 1 2026-08-27] `0` chỉ là biểu diễn chuyển tiếp trong raw core cho
    /// field **vắng mặt** của `autofill_single_sheet`; serialize sẽ bỏ field này. Nó
    /// không phải số lượng, probe hay cap. Dùng [`Self::requested_quantity`] khi cần đọc
    /// ngữ nghĩa số lượng.
    #[serde(
        default,
        deserialize_with = "deserialize_quantity_if_present",
        skip_serializing_if = "quantity_is_absent"
    )]
    pub quantity: u32,
    /// Contour CUT ngoài, mm. Vòng kín ngầm định (không lặp lại đỉnh đầu ở cuối).
    pub outer: Vec<PointMm>,
    /// Lỗ khoét. MVP ghi nhận nhưng coi là vật liệu đặc khi collision/score.
    #[serde(default)]
    pub holes: Vec<Vec<PointMm>>,
    #[serde(default)]
    pub rotation_constraint: RotationConstraint,
    /// Pivot ổn định của pose, do backend canonicalize. **Không** phải góc trái của
    /// bbox sau khi xoay. `None` ⇒ `normalize.rs` (P2a) tính theo quy tắc có version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_point_mm: Option<PointMm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

impl PartSpec {
    /// Số lượng được yêu cầu thật sự; `None` nghĩa là request autofill không có target.
    pub fn requested_quantity(&self) -> Option<NonZeroU32> {
        NonZeroU32::new(self.quantity)
    }

    /// Tổng số đỉnh của chi tiết (contour ngoài + mọi lỗ).
    pub fn vertex_count(&self) -> usize {
        self.outer.len() + self.holes.iter().map(Vec::len).sum::<usize>()
    }
}

fn quantity_is_absent(quantity: &u32) -> bool {
    *quantity == 0
}

fn deserialize_quantity_if_present<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let quantity = u32::deserialize(deserializer)?;
    if quantity == 0 {
        return Err(D::Error::custom(
            "quantity có mặt thì phải lớn hơn 0; autofill phải bỏ hẳn trường này",
        ));
    }
    Ok(quantity)
}

/// Request đầy đủ mà engine nhận từ sidecar.
///
/// Sidecar chịu trách nhiệm dựng struct này từ `CreateJobRequest` công khai: sinh
/// `jobId` bằng CSPRNG, canonicalize polygon, tự tính `geometryHash`/`sourceRevision`.
/// Không có trường `translationStepMm`, không có matrix — và `deny_unknown_fields`
/// khiến mọi payload cố ép pose vào grid bị từ chối thay vì bị bỏ qua im lặng.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MixedNestingRequest {
    pub protocol_version: u32,
    /// Seed gốc. Cùng canonical input + engine version + seed + work-plan cố định ⇒
    /// cùng kết quả, bất kể số worker.
    pub seed: u64,
    #[serde(default)]
    pub profile: Profile,
    /// `None` ⇒ chạy theo **work-plan cố định** (deterministic, dùng cho test/benchmark).
    /// `Some(ms)` ⇒ thêm deadline wall-clock; khi đó chỉ cam kết best-so-far hợp lệ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_budget_ms: Option<u64>,
    pub sheet: SheetSpec,
    /// Khoảng cách tối thiểu giữa hai contour CUT, mm. `0` được phép.
    pub gap_mm: f64,
    pub orientation_policy: OrientationPolicy,
    /// Vắng mặt ⇒ `quantity_fulfillment` (giữ hành vi payload cũ).
    #[serde(default)]
    pub layout_intent: LayoutIntent,
    pub parts: Vec<PartSpec>,
    /// Server-owned. Route công khai KHÔNG nhận từ client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Server-owned. Vắng mặt chỉ hợp lệ cho đường lab/legacy; production adapter
    /// Tem bế/CNC phải gắn envelope này trước khi gọi native.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_contract: Option<ProductionContractV1>,
}

impl Default for MixedNestingRequest {
    /// Giá trị nền chỉ dành cho struct-update/builder nội bộ khi hợp đồng được mở rộng.
    ///
    /// Request này cố ý **không hợp lệ** vì `parts` rỗng; `Default` không được dùng để
    /// bỏ qua admission. Lợi ích của nó là các fixture khai rõ toàn bộ trường nghiệp vụ
    /// hiện tại vẫn tự nhận giá trị an toàn cho extension server-owned thêm về sau.
    fn default() -> Self {
        Self {
            protocol_version: MIXED_NESTING_PROTOCOL_VERSION,
            seed: 0,
            profile: Profile::default(),
            time_budget_ms: None,
            sheet: SheetSpec {
                width_mm: 1.0,
                height_mm: 1.0,
                margin_mm: SheetMarginMm {
                    left: 0.0,
                    right: 0.0,
                    top: 0.0,
                    bottom: 0.0,
                },
                max_sheets: 1,
            },
            gap_mm: 0.0,
            orientation_policy: OrientationPolicy {
                default_rotation: RotationConstraint::Free,
                reflection: Reflection::Forbidden,
            },
            layout_intent: LayoutIntent::default(),
            parts: Vec::new(),
            job_id: None,
            production_contract: None,
        }
    }
}

impl MixedNestingRequest {
    /// Tổng số instance được yêu cầu thật sự.
    ///
    /// Autofill không có target nên luôn trả `0`, kể cả một payload autofill sai có
    /// nhét quantity vào. Validation sẽ báo lỗi riêng cho payload đó.
    ///
    /// Vì vậy `MAX_INSTANCES_TOTAL` đếm trực tiếp bài quantity-driven; bài autofill
    /// được bảo vệ bằng cận sức chứa hình học trong [`Self::validate`]. `0` ở đây
    /// không phải tuyên bố rằng autofill không tốn tài nguyên.
    pub fn total_instances(&self) -> u64 {
        if self.layout_intent.quantity_la_yeu_cau() {
            self.parts.iter().map(|p| u64::from(p.quantity)).sum()
        } else {
            0
        }
    }

    /// Ràng buộc xoay có hiệu lực cho một chi tiết: phân giải `inherit` về policy job.
    ///
    /// Không nhận tham số `profile` — đó là bằng chứng cấu trúc rằng
    /// `fast/balanced/tight` không thể thu hẹp miền góc.
    pub fn effective_rotation<'a>(&'a self, part: &'a PartSpec) -> &'a RotationConstraint {
        match part.rotation_constraint {
            RotationConstraint::Inherit => &self.orientation_policy.default_rotation,
            _ => &part.rotation_constraint,
        }
    }

    /// Kiểm tra toàn bộ hợp đồng dữ liệu. Gom nhiều lỗi để backend trả 422 đủ thông tin.
    ///
    /// Thông báo lỗi **không bao giờ chứa toạ độ contour của khách hàng** — chỉ chứa
    /// đường dẫn trường và chỉ số (kế hoạch §16.3: không log polygon khách hàng).
    pub fn validate(&self) -> Result<(), ContractErrors> {
        let tol = Tolerance::v1();
        let mut errors = ContractErrors::default();

        // ── Protocol ──
        if self.protocol_version != MIXED_NESTING_PROTOCOL_VERSION {
            errors.push(ContractError::new(
                ContractErrorCode::ProtocolVersionUnsupported,
                "protocolVersion",
                format!(
                    "Phiên bản protocol {} không được hỗ trợ (engine yêu cầu {}).",
                    self.protocol_version, MIXED_NESTING_PROTOCOL_VERSION
                ),
            ));
        }

        // ── Ngân sách thời gian ──
        if let Some(budget) = self.time_budget_ms {
            if budget == 0 || budget > MAX_TIME_BUDGET_MS {
                errors.push(ContractError::new(
                    ContractErrorCode::TimeBudgetOutOfRange,
                    "timeBudgetMs",
                    format!(
                        "Ngân sách thời gian phải trong khoảng 1..={} ms.",
                        MAX_TIME_BUDGET_MS
                    ),
                ));
            }
        }

        // ── Tờ vật liệu ──
        validate_sheet(&self.sheet, &tol, &mut errors);

        // ── Ý định bố cục ──
        // "Một tờ" phải được khai ở ĐÚNG MỘT chỗ. Nếu engine tự ép `maxSheets = 1` thì
        // request và hành vi lệch nhau, và người đọc manifest không biết trần nào có
        // hiệu lực. Từ chối rõ ràng còn hơn tự sửa im lặng.
        if self.layout_intent.is_single_sheet_autofill() && self.sheet.max_sheets != 1 {
            errors.push(ContractError::new(
                ContractErrorCode::AutofillRequiresSingleSheet,
                "sheet.maxSheets",
                format!(
                    "layoutIntent 'autofill_single_sheet' yêu cầu sheet.maxSheets = 1 \
                     (đang khai {}).",
                    self.sheet.max_sheets
                ),
            ));
        }

        // ── Khoảng hở giữa các contour ──
        if !self.gap_mm.is_finite() {
            errors.push(ContractError::new(
                ContractErrorCode::NotFinite,
                "gapMm",
                "Khoảng cách giữa các nét cắt phải là số hữu hạn.".to_string(),
            ));
        } else if self.gap_mm < 0.0 {
            errors.push(ContractError::new(
                ContractErrorCode::GapOutOfRange,
                "gapMm",
                "Khoảng cách giữa các nét cắt không được âm.".to_string(),
            ));
        }

        if let Some(contract) = &self.production_contract {
            // Không cho hai nguồn chân lý. `gapMm` là contract legacy; production dùng
            // ba lớp clearance tường minh trong envelope.
            if self.gap_mm != 0.0 {
                errors.push(ContractError::new(
                    ContractErrorCode::LegacyGapWithProductionContract,
                    "gapMm",
                    "Production contract đã khai clearance tường minh nên gapMm phải bằng 0."
                        .to_string(),
                ));
            }
            validate_production_contract(
                contract,
                &self.sheet,
                &self.parts,
                self.layout_intent,
                &tol,
                &mut errors,
            );
        }

        // ── Chính sách hướng cấp job ──
        if matches!(
            self.orientation_policy.default_rotation,
            RotationConstraint::Inherit
        ) {
            errors.push(ContractError::new(
                ContractErrorCode::RotationInheritNotAllowedAtJobLevel,
                "orientationPolicy.defaultRotation",
                "Mặc định cấp job không được là 'inherit' vì không có cấp trên để kế thừa."
                    .to_string(),
            ));
        }
        validate_rotation_constraint(
            &self.orientation_policy.default_rotation,
            "orientationPolicy.defaultRotation",
            &tol,
            &mut errors,
        );

        // ── Danh sách chi tiết ──
        if self.parts.is_empty() {
            errors.push(ContractError::new(
                ContractErrorCode::EmptyParts,
                "parts",
                "Job phải có ít nhất một loại chi tiết.".to_string(),
            ));
        }
        if self.parts.len() > MAX_PARTS {
            errors.push(ContractError::new(
                ContractErrorCode::TooManyParts,
                "parts",
                format!("Số loại chi tiết vượt giới hạn {MAX_PARTS}."),
            ));
        }
        if self.layout_intent.prefers_periodic_motif() && self.parts.len() != 1 {
            errors.push(ContractError::new(
                ContractErrorCode::StepRepeatRequiresSinglePart,
                "parts",
                "Bình trang một tờ yêu cầu đúng một mẫu trong mỗi job.".to_string(),
            ));
        }

        let mut seen_ids: BTreeSet<&str> = BTreeSet::new();
        let mut total_vertices: usize = 0;
        for (index, part) in self.parts.iter().enumerate() {
            let base = format!("parts[{index}]");
            if !seen_ids.insert(part.part_id.as_str()) {
                errors.push(ContractError::new(
                    ContractErrorCode::DuplicatePartId,
                    format!("{base}.partId"),
                    "Mã chi tiết bị trùng — mỗi loại chi tiết phải có mã riêng.".to_string(),
                ));
            }
            validate_part(part, self.layout_intent, &base, &tol, &mut errors);
            total_vertices = total_vertices.saturating_add(part.vertex_count());
        }
        if let Some(contract) = &self.production_contract {
            total_vertices = contract
                .fixed_obstacles
                .iter()
                .fold(total_vertices, |sum, item| {
                    sum.saturating_add(item.outer.len())
                });
        }

        if total_vertices > MAX_TOTAL_VERTICES {
            errors.push(ContractError::new(
                ContractErrorCode::TooManyVertices,
                "parts",
                format!("Tổng số đỉnh của request vượt giới hạn {MAX_TOTAL_VERTICES}."),
            ));
        }

        if self.layout_intent.is_single_sheet_autofill() {
            // Chốt protocol/security, không phải cap worker: autofill không có quantity
            // để MAX_INSTANCES_TOTAL đếm trực tiếp, nên dùng cận trên sức chứa theo diện
            // tích. Outer area được coi là vật liệu đặc (không trừ hole), khớp MVP.
            let usable_area_mm2 = self.sheet.usable_width_mm() * self.sheet.usable_height_mm();
            let min_outer_area_mm2 = self
                .parts
                .iter()
                .map(|part| super::transform::signed_area_mm2(&part.outer).abs())
                .filter(|area| area.is_finite() && *area > 0.0)
                .min_by(|left, right| {
                    left.partial_cmp(right)
                        .expect("diện tích đã hữu hạn nên có thứ tự")
                });
            if usable_area_mm2.is_finite() && usable_area_mm2 > 0.0 {
                if let Some(min_area) = min_outer_area_mm2 {
                    let capacity_upper_bound = (usable_area_mm2 / min_area).ceil();
                    if !capacity_upper_bound.is_finite()
                        || capacity_upper_bound > MAX_INSTANCES_TOTAL as f64
                    {
                        errors.push(ContractError::new(
                            ContractErrorCode::AutofillCapacityBoundTooLarge,
                            "parts",
                            format!(
                                "Cận trên sức chứa autofill vượt giới hạn protocol: {MAX_INSTANCES_TOTAL} con."
                            ),
                        ));
                    }
                }
            }
        }

        let total_instances = self.total_instances();
        if total_instances > MAX_INSTANCES_TOTAL {
            errors.push(ContractError::new(
                ContractErrorCode::TooManyInstances,
                "parts",
                format!("Tổng số con cần xếp vượt giới hạn {MAX_INSTANCES_TOTAL}."),
            ));
        }

        errors.into_result()
    }

    /// Kiểm các field chỉ tồn tại sau khi backend đã nhận request công khai.
    ///
    /// Core geometry test có thể dựng `ProductionContractV1` mà không cần giả một job
    /// lifecycle; bridge native production thì bắt buộc gọi preflight này trước solve.
    pub fn validate_server_owned_fields(&self) -> Result<(), ContractErrors> {
        let mut errors = ContractErrors::default();
        if self.production_contract.is_some() {
            let job_id_hop_le = self.job_id.as_deref().is_some_and(|job_id| {
                !job_id.is_empty()
                    && job_id.len() <= MAX_JOB_ID_LEN
                    && !job_id.chars().any(char::is_control)
            });
            if !job_id_hop_le {
                errors.push(ContractError::new(
                    ContractErrorCode::ProductionJobIdRequired,
                    "jobId",
                    "Production contract yêu cầu jobId server-owned hợp lệ.".to_string(),
                ));
            }
        }
        errors.into_result()
    }
}

fn validate_production_contract(
    contract: &ProductionContractV1,
    sheet: &SheetSpec,
    parts: &[PartSpec],
    layout_intent: LayoutIntent,
    tol: &Tolerance,
    errors: &mut ContractErrors,
) {
    let base = "productionContract";
    if contract.schema_version != MIXED_NESTING_PRODUCTION_SCHEMA_VERSION {
        errors.push(ContractError::new(
            ContractErrorCode::ProductionSchemaUnsupported,
            format!("{base}.schemaVersion"),
            format!(
                "Production schema {} không được hỗ trợ (engine yêu cầu {}).",
                contract.schema_version, MIXED_NESTING_PRODUCTION_SCHEMA_VERSION
            ),
        ));
    }
    if contract.request_revision == 0 {
        errors.push(ContractError::new(
            ContractErrorCode::RequestRevisionOutOfRange,
            format!("{base}.requestRevision"),
            "Revision của request production phải bắt đầu từ 1.".to_string(),
        ));
    }
    for (value, field) in [
        (&contract.input_hash, "inputHash"),
        (&contract.layout_fingerprint, "layoutFingerprint"),
    ] {
        if !is_canonical_sha256(value) {
            errors.push(ContractError::new(
                ContractErrorCode::IdentityHashInvalid,
                format!("{base}.{field}"),
                "Identity phải ở dạng canonical sha256: + 64 ký tự hex thường.".to_string(),
            ));
        }
    }

    for (clearance, field) in [
        (contract.clearance.part_to_part, "partToPart"),
        (contract.clearance.part_to_sheet_edge, "partToSheetEdge"),
        (contract.clearance.part_to_obstacle, "partToObstacle"),
    ] {
        for (value, axis) in [(clearance.x_mm, "xMm"), (clearance.y_mm, "yMm")] {
            let path = format!("{base}.clearance.{field}.{axis}");
            if !value.is_finite() {
                errors.push(ContractError::new(
                    ContractErrorCode::NotFinite,
                    path,
                    "Khoảng hở phải là số hữu hạn.".to_string(),
                ));
            } else if value < 0.0 {
                errors.push(ContractError::new(
                    ContractErrorCode::ClearanceOutOfRange,
                    path,
                    "Khoảng hở không được âm.".to_string(),
                ));
            }
        }
    }

    let edge = contract.clearance.part_to_sheet_edge;
    if edge.x_mm.is_finite()
        && edge.y_mm.is_finite()
        && (2.0 * edge.x_mm >= sheet.usable_width_mm() - tol.linear_mm
            || 2.0 * edge.y_mm >= sheet.usable_height_mm() - tol.linear_mm)
    {
        errors.push(ContractError::new(
            ContractErrorCode::ClearanceConsumesUsableArea,
            format!("{base}.clearance.partToSheetEdge"),
            "Khoảng hở tới mép làm vùng xếp không còn diện tích dương.".to_string(),
        ));
    }

    // PARITY (audit 2026-08-29 MAP-NEST-04): free gang và chia đều diện tích
    // là hai contract khác nhau. Zone là server-owned, không clamp hay suy đoán.
    let zone_base = format!("{base}.placementZones");
    match contract.grouping_intent {
        GroupingIntent::FreeGang => {
            if !contract.placement_zones.is_empty() {
                errors.push(ContractError::new(
                    ContractErrorCode::PlacementZonesForbidden,
                    zone_base.clone(),
                    "Xếp tự do không được mang vùng đặt riêng theo mẫu.".to_string(),
                ));
            }
        }
        GroupingIntent::MaximizeArea => {
            if layout_intent.prefers_periodic_motif() {
                errors.push(ContractError::new(
                    ContractErrorCode::GroupingIntentNotAllowed,
                    format!("{base}.groupingIntent"),
                    "Bình trang một mẫu không dùng chia đều diện tích nhiều mẫu.".to_string(),
                ));
            }

            let part_ids: BTreeSet<&str> = parts.iter().map(|part| part.part_id.as_str()).collect();
            let mut seen_zones: BTreeSet<&str> = BTreeSet::new();
            let mut valid_zones: Vec<&PartPlacementZoneSpec> = Vec::new();
            let usable_min_x = sheet.margin_mm.left;
            let usable_min_y = sheet.margin_mm.bottom;
            let usable_max_x = sheet.width_mm - sheet.margin_mm.right;
            let usable_max_y = sheet.height_mm - sheet.margin_mm.top;

            for (index, zone) in contract.placement_zones.iter().enumerate() {
                let item_base = format!("{zone_base}[{index}]");
                if !part_ids.contains(zone.part_id.as_str()) {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZoneUnknownPart,
                        format!("{item_base}.partId"),
                        "Vùng đặt tham chiếu partId không có trong request.".to_string(),
                    ));
                    continue;
                }
                if !seen_zones.insert(zone.part_id.as_str()) {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZoneDuplicatePart,
                        format!("{item_base}.partId"),
                        "Một mẫu chỉ được có đúng một vùng đặt.".to_string(),
                    ));
                    continue;
                }

                let bounds = zone.bounds;
                let coordinates = [
                    (bounds.min_x_mm, "minXmm"),
                    (bounds.min_y_mm, "minYmm"),
                    (bounds.max_x_mm, "maxXmm"),
                    (bounds.max_y_mm, "maxYmm"),
                ];
                let mut finite = true;
                for (value, field) in coordinates {
                    if !value.is_finite() {
                        finite = false;
                        errors.push(ContractError::new(
                            ContractErrorCode::NotFinite,
                            format!("{item_base}.bounds.{field}"),
                            "Biên vùng đặt phải là số hữu hạn.".to_string(),
                        ));
                    }
                }
                if !finite {
                    continue;
                }
                if bounds.max_x_mm - bounds.min_x_mm <= tol.linear_mm
                    || bounds.max_y_mm - bounds.min_y_mm <= tol.linear_mm
                {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZoneInvalidBounds,
                        format!("{item_base}.bounds"),
                        "Vùng đặt phải có chiều rộng và chiều cao dương.".to_string(),
                    ));
                    continue;
                }
                if bounds.min_x_mm < usable_min_x - tol.linear_mm
                    || bounds.min_y_mm < usable_min_y - tol.linear_mm
                    || bounds.max_x_mm > usable_max_x + tol.linear_mm
                    || bounds.max_y_mm > usable_max_y + tol.linear_mm
                {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZoneOutsideUsableArea,
                        format!("{item_base}.bounds"),
                        "Vùng đặt nằm ngoài vùng xếp hữu hiệu của tờ.".to_string(),
                    ));
                    continue;
                }
                valid_zones.push(zone);
            }

            for part in parts {
                if !seen_zones.contains(part.part_id.as_str()) {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZoneMissingPart,
                        zone_base.clone(),
                        format!("Thiếu vùng đặt cho mẫu '{}'.", part.part_id),
                    ));
                }
            }

            // Maximize-area v1 là các dải ngang phủ kín vùng dùng được, cùng diện tích.
            // Backend quyết thứ tự mẫu; core chỉ khóa partition hình học canonical.
            if valid_zones.len() == parts.len()
                && seen_zones.len() == parts.len()
                && !parts.is_empty()
            {
                valid_zones.sort_by(|left, right| {
                    right
                        .bounds
                        .max_y_mm
                        .total_cmp(&left.bounds.max_y_mm)
                        .then(left.part_id.cmp(&right.part_id))
                });
                let expected_height = (usable_max_y - usable_min_y) / parts.len() as f64;
                let partition_tol = tol.linear_mm * 2.0;
                let mut partition_valid = true;
                for (index, zone) in valid_zones.iter().enumerate() {
                    let bounds = zone.bounds;
                    partition_valid &= (bounds.min_x_mm - usable_min_x).abs() <= partition_tol;
                    partition_valid &= (bounds.max_x_mm - usable_max_x).abs() <= partition_tol;
                    partition_valid &= ((bounds.max_y_mm - bounds.min_y_mm) - expected_height)
                        .abs()
                        <= partition_tol;
                    if index == 0 {
                        partition_valid &= (bounds.max_y_mm - usable_max_y).abs() <= partition_tol;
                    } else {
                        partition_valid &=
                            (valid_zones[index - 1].bounds.min_y_mm - bounds.max_y_mm).abs()
                                <= partition_tol;
                    }
                }
                if let Some(last) = valid_zones.last() {
                    partition_valid &= (last.bounds.min_y_mm - usable_min_y).abs() <= partition_tol;
                }
                if !partition_valid {
                    errors.push(ContractError::new(
                        ContractErrorCode::PlacementZonePartitionInvalid,
                        zone_base,
                        "Các vùng chia đều diện tích phải là dải ngang bằng nhau và phủ kín vùng xếp."
                            .to_string(),
                    ));
                }
            }
        }
    }

    if contract.fixed_obstacles.len() > MAX_FIXED_OBSTACLES {
        errors.push(ContractError::new(
            ContractErrorCode::TooManyFixedObstacles,
            format!("{base}.fixedObstacles"),
            format!("Số vùng cấm vượt giới hạn {MAX_FIXED_OBSTACLES}."),
        ));
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (index, obstacle) in contract.fixed_obstacles.iter().enumerate() {
        let obstacle_base = format!("{base}.fixedObstacles[{index}]");
        let id = obstacle.obstacle_id.as_str();
        if id.is_empty() || id.len() > MAX_OBSTACLE_ID_LEN || id.chars().any(char::is_control) {
            errors.push(ContractError::new(
                ContractErrorCode::InvalidObstacleId,
                format!("{obstacle_base}.obstacleId"),
                "Mã vùng cấm rỗng, quá dài hoặc chứa ký tự điều khiển.".to_string(),
            ));
        } else if !seen.insert(id) {
            errors.push(ContractError::new(
                ContractErrorCode::DuplicateObstacleId,
                format!("{obstacle_base}.obstacleId"),
                "Mã vùng cấm bị trùng.".to_string(),
            ));
        }
        validate_ring(&obstacle.outer, &format!("{obstacle_base}.outer"), errors);
    }
}

fn is_canonical_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_sheet(sheet: &SheetSpec, tol: &Tolerance, errors: &mut ContractErrors) {
    for (value, path) in [
        (sheet.width_mm, "sheet.widthMm"),
        (sheet.height_mm, "sheet.heightMm"),
    ] {
        if !value.is_finite() {
            errors.push(ContractError::new(
                ContractErrorCode::NotFinite,
                path,
                "Kích thước tờ phải là số hữu hạn.".to_string(),
            ));
        } else if value <= 0.0 {
            errors.push(ContractError::new(
                ContractErrorCode::SheetDimensionOutOfRange,
                path,
                "Kích thước tờ phải lớn hơn 0 mm.".to_string(),
            ));
        }
    }

    for (value, path) in [
        (sheet.margin_mm.left, "sheet.marginMm.left"),
        (sheet.margin_mm.right, "sheet.marginMm.right"),
        (sheet.margin_mm.top, "sheet.marginMm.top"),
        (sheet.margin_mm.bottom, "sheet.marginMm.bottom"),
    ] {
        if !value.is_finite() {
            errors.push(ContractError::new(
                ContractErrorCode::NotFinite,
                path,
                "Lề tờ phải là số hữu hạn.".to_string(),
            ));
        } else if value < 0.0 {
            errors.push(ContractError::new(
                ContractErrorCode::MarginOutOfRange,
                path,
                "Lề tờ không được âm.".to_string(),
            ));
        }
    }

    if sheet.max_sheets == 0 || sheet.max_sheets > MAX_SHEETS_LIMIT {
        errors.push(ContractError::new(
            ContractErrorCode::MaxSheetsOutOfRange,
            "sheet.maxSheets",
            format!("Số tờ tối đa phải trong khoảng 1..={MAX_SHEETS_LIMIT}."),
        ));
    }

    // Chỉ kết luận vùng dùng được khi mọi số đã hữu hạn, tránh báo lỗi kép vô nghĩa.
    let dims_finite = sheet.width_mm.is_finite()
        && sheet.height_mm.is_finite()
        && sheet.margin_mm.left.is_finite()
        && sheet.margin_mm.right.is_finite()
        && sheet.margin_mm.top.is_finite()
        && sheet.margin_mm.bottom.is_finite();
    if dims_finite
        && (sheet.usable_width_mm() <= tol.linear_mm || sheet.usable_height_mm() <= tol.linear_mm)
    {
        errors.push(ContractError::new(
            ContractErrorCode::UsableAreaEmpty,
            "sheet",
            "Vùng dùng được sau khi trừ lề không còn diện tích.".to_string(),
        ));
    }
}

fn validate_part(
    part: &PartSpec,
    layout_intent: LayoutIntent,
    base: &str,
    tol: &Tolerance,
    errors: &mut ContractErrors,
) {
    // ── Mã chi tiết ──
    if part.part_id.trim().is_empty() {
        errors.push(ContractError::new(
            ContractErrorCode::InvalidPartId,
            format!("{base}.partId"),
            "Mã chi tiết không được để trống.".to_string(),
        ));
    } else if part.part_id.len() > MAX_PART_ID_LEN {
        errors.push(ContractError::new(
            ContractErrorCode::InvalidPartId,
            format!("{base}.partId"),
            format!("Mã chi tiết dài quá {MAX_PART_ID_LEN} ký tự."),
        ));
    } else if part.part_id.chars().any(char::is_control) {
        errors.push(ContractError::new(
            ContractErrorCode::InvalidPartId,
            format!("{base}.partId"),
            "Mã chi tiết chứa ký tự điều khiển.".to_string(),
        ));
    }

    // ── Số lượng theo intent ──
    match layout_intent {
        LayoutIntent::QuantityFulfillment
            if part.quantity == 0 || part.quantity > MAX_QUANTITY_PER_PART =>
        {
            errors.push(ContractError::new(
                ContractErrorCode::QuantityOutOfRange,
                format!("{base}.quantity"),
                format!(
                    "Bình theo số lượng yêu cầu quantity trong khoảng 1..={MAX_QUANTITY_PER_PART}."
                ),
            ));
        }
        intent if intent.is_single_sheet_autofill() && part.requested_quantity().is_some() => {
            errors.push(ContractError::new(
                ContractErrorCode::AutofillQuantityMustBeAbsent,
                format!("{base}.quantity"),
                "Bình tự lấp đầy không nhận số lượng; hãy bỏ trường quantity.".to_string(),
            ));
        }
        _ => {}
    }

    // ── Contour ngoài và lỗ ──
    validate_ring(&part.outer, &format!("{base}.outer"), errors);
    if part.holes.len() > MAX_HOLES_PER_PART {
        errors.push(ContractError::new(
            ContractErrorCode::TooManyHoles,
            format!("{base}.holes"),
            format!("Số lỗ khoét vượt giới hạn {MAX_HOLES_PER_PART}."),
        ));
    }
    for (hole_index, hole) in part.holes.iter().enumerate() {
        validate_ring(hole, &format!("{base}.holes[{hole_index}]"), errors);
    }

    // ── Pivot server-owned ──
    if let Some(reference) = part.reference_point_mm {
        if !reference.is_finite() {
            errors.push(ContractError::new(
                ContractErrorCode::NotFinite,
                format!("{base}.referencePointMm"),
                "Điểm tham chiếu phải là số hữu hạn.".to_string(),
            ));
        }
    }
    for (value, field) in [
        (part.geometry_hash.as_deref(), "geometryHash"),
        (part.source_revision.as_deref(), "sourceRevision"),
    ] {
        if let Some(text) = value {
            if text.trim().is_empty() {
                errors.push(ContractError::new(
                    ContractErrorCode::ProvenanceFieldEmpty,
                    format!("{base}.{field}"),
                    "Trường provenance có mặt thì không được để trống.".to_string(),
                ));
            }
        }
    }

    // ── Ràng buộc xoay ──
    validate_rotation_constraint(
        &part.rotation_constraint,
        &format!("{base}.rotationConstraint"),
        tol,
        errors,
    );
}

fn validate_ring(ring: &[PointMm], path: &str, errors: &mut ContractErrors) {
    if ring.len() < 3 {
        errors.push(ContractError::new(
            ContractErrorCode::RingTooFewVertices,
            path,
            "Contour phải có ít nhất 3 đỉnh.".to_string(),
        ));
    }
    if ring.len() > MAX_RING_VERTICES {
        errors.push(ContractError::new(
            ContractErrorCode::RingTooManyVertices,
            path,
            format!("Contour vượt giới hạn {MAX_RING_VERTICES} đỉnh."),
        ));
    }
    for (vertex_index, point) in ring.iter().enumerate() {
        if !point.is_finite() {
            // Chỉ ghi chỉ số đỉnh — không ghi giá trị toạ độ của khách hàng.
            errors.push(ContractError::new(
                ContractErrorCode::NotFinite,
                format!("{path}[{vertex_index}]"),
                "Toạ độ đỉnh phải là số hữu hạn.".to_string(),
            ));
            if errors.is_saturated() {
                return;
            }
        }
    }
}

fn validate_rotation_constraint(
    constraint: &RotationConstraint,
    path: &str,
    tol: &Tolerance,
    errors: &mut ContractErrors,
) {
    match constraint {
        // `inherit`/`free` không mang tham số nên không có gì để kiểm ở đây.
        RotationConstraint::Inherit | RotationConstraint::Free => {}
        RotationConstraint::Fixed { angle_deg } => {
            if canonicalize_angle_deg(*angle_deg, tol).is_none() {
                errors.push(ContractError::new(
                    ContractErrorCode::NotFinite,
                    format!("{path}.angleDeg"),
                    "Góc khóa phải là số hữu hạn.".to_string(),
                ));
            }
        }
        RotationConstraint::Discrete { angles_deg } => {
            if angles_deg.is_empty() {
                errors.push(ContractError::new(
                    ContractErrorCode::RotationDomainEmpty,
                    format!("{path}.anglesDeg"),
                    "Tập góc cho phép không được rỗng.".to_string(),
                ));
            }
            if angles_deg.len() > MAX_ROTATION_ANGLES {
                errors.push(ContractError::new(
                    ContractErrorCode::TooManyRotationAngles,
                    format!("{path}.anglesDeg"),
                    format!("Tập góc vượt giới hạn {MAX_ROTATION_ANGLES} phần tử."),
                ));
            }
            for (angle_index, angle) in angles_deg.iter().enumerate() {
                if canonicalize_angle_deg(*angle, tol).is_none() {
                    errors.push(ContractError::new(
                        ContractErrorCode::NotFinite,
                        format!("{path}.anglesDeg[{angle_index}]"),
                        "Góc cho phép phải là số hữu hạn.".to_string(),
                    ));
                    if errors.is_saturated() {
                        return;
                    }
                }
            }
        }
        RotationConstraint::Ranges { arcs } => {
            if arcs.is_empty() {
                errors.push(ContractError::new(
                    ContractErrorCode::RotationDomainEmpty,
                    format!("{path}.arcs"),
                    "Danh sách cung góc không được rỗng.".to_string(),
                ));
            }
            if arcs.len() > MAX_ROTATION_ARCS {
                errors.push(ContractError::new(
                    ContractErrorCode::TooManyRotationArcs,
                    format!("{path}.arcs"),
                    format!("Danh sách cung góc vượt giới hạn {MAX_ROTATION_ARCS} phần tử."),
                ));
            }
            for (arc_index, arc) in arcs.iter().enumerate() {
                let arc_path = format!("{path}.arcs[{arc_index}]");
                if !arc.start_deg.is_finite() {
                    errors.push(ContractError::new(
                        ContractErrorCode::NotFinite,
                        format!("{arc_path}.startDeg"),
                        "Góc đầu cung phải là số hữu hạn.".to_string(),
                    ));
                }
                if !arc.sweep_deg.is_finite() {
                    errors.push(ContractError::new(
                        ContractErrorCode::NotFinite,
                        format!("{arc_path}.sweepDeg"),
                        "Độ mở cung phải là số hữu hạn.".to_string(),
                    ));
                } else if arc.sweep_deg <= 0.0 || arc.sweep_deg > 360.0 {
                    errors.push(ContractError::new(
                        ContractErrorCode::RotationArcSweepOutOfRange,
                        format!("{arc_path}.sweepDeg"),
                        "Độ mở cung phải thuộc khoảng (0°, 360°].".to_string(),
                    ));
                }
                if errors.is_saturated() {
                    return;
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lỗi hợp đồng
// ─────────────────────────────────────────────────────────────────────────────

/// Mã lỗi ổn định để backend map sang 422 và để frontend hiển thị đúng chỗ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractErrorCode {
    ProtocolVersionUnsupported,
    NotFinite,
    EmptyParts,
    TooManyParts,
    /// Bình trang production phải được tách thành đúng một mẫu mỗi job.
    StepRepeatRequiresSinglePart,
    DuplicatePartId,
    InvalidPartId,
    QuantityOutOfRange,
    /// Autofill nhận một quantity thật thay vì field vắng mặt.
    AutofillQuantityMustBeAbsent,
    /// Cận trên sức chứa một tờ autofill vượt giới hạn protocol.
    AutofillCapacityBoundTooLarge,
    TooManyInstances,
    RingTooFewVertices,
    RingTooManyVertices,
    TooManyVertices,
    TooManyHoles,
    RotationInheritNotAllowedAtJobLevel,
    RotationDomainEmpty,
    RotationArcSweepOutOfRange,
    TooManyRotationAngles,
    TooManyRotationArcs,
    GapOutOfRange,
    SheetDimensionOutOfRange,
    MarginOutOfRange,
    UsableAreaEmpty,
    MaxSheetsOutOfRange,
    TimeBudgetOutOfRange,
    ProvenanceFieldEmpty,
    /// `layoutIntent = autofill_single_sheet` mà `sheet.maxSheets != 1`.
    AutofillRequiresSingleSheet,
    ProductionSchemaUnsupported,
    RequestRevisionOutOfRange,
    IdentityHashInvalid,
    LegacyGapWithProductionContract,
    ClearanceOutOfRange,
    ClearanceConsumesUsableArea,
    TooManyFixedObstacles,
    InvalidObstacleId,
    DuplicateObstacleId,
    /// Free gang không được mang zone server-owned.
    PlacementZonesForbidden,
    /// S&R không nhận grouping nhiều mẫu.
    GroupingIntentNotAllowed,
    PlacementZoneUnknownPart,
    PlacementZoneDuplicatePart,
    PlacementZoneMissingPart,
    PlacementZoneInvalidBounds,
    PlacementZoneOutsideUsableArea,
    PlacementZonePartitionInvalid,
    /// Production contract thiếu job ID server-owned hợp lệ.
    ProductionJobIdRequired,
}

impl ContractErrorCode {
    /// Mã dạng chuỗi ổn định — hợp đồng với backend/frontend, đổi là breaking change.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProtocolVersionUnsupported => "PROTOCOL_VERSION_UNSUPPORTED",
            Self::NotFinite => "NOT_FINITE",
            Self::EmptyParts => "EMPTY_PARTS",
            Self::TooManyParts => "TOO_MANY_PARTS",
            Self::StepRepeatRequiresSinglePart => "STEP_REPEAT_REQUIRES_SINGLE_PART",
            Self::DuplicatePartId => "DUPLICATE_PART_ID",
            Self::InvalidPartId => "INVALID_PART_ID",
            Self::QuantityOutOfRange => "QUANTITY_OUT_OF_RANGE",
            Self::AutofillQuantityMustBeAbsent => "AUTOFILL_QUANTITY_MUST_BE_ABSENT",
            Self::AutofillCapacityBoundTooLarge => "AUTOFILL_CAPACITY_BOUND_TOO_LARGE",
            Self::TooManyInstances => "TOO_MANY_INSTANCES",
            Self::RingTooFewVertices => "RING_TOO_FEW_VERTICES",
            Self::RingTooManyVertices => "RING_TOO_MANY_VERTICES",
            Self::TooManyVertices => "TOO_MANY_VERTICES",
            Self::TooManyHoles => "TOO_MANY_HOLES",
            Self::RotationInheritNotAllowedAtJobLevel => {
                "ROTATION_INHERIT_NOT_ALLOWED_AT_JOB_LEVEL"
            }
            Self::RotationDomainEmpty => "ROTATION_DOMAIN_EMPTY",
            Self::RotationArcSweepOutOfRange => "ROTATION_ARC_SWEEP_OUT_OF_RANGE",
            Self::TooManyRotationAngles => "TOO_MANY_ROTATION_ANGLES",
            Self::TooManyRotationArcs => "TOO_MANY_ROTATION_ARCS",
            Self::GapOutOfRange => "GAP_OUT_OF_RANGE",
            Self::SheetDimensionOutOfRange => "SHEET_DIMENSION_OUT_OF_RANGE",
            Self::MarginOutOfRange => "MARGIN_OUT_OF_RANGE",
            Self::UsableAreaEmpty => "USABLE_AREA_EMPTY",
            Self::MaxSheetsOutOfRange => "MAX_SHEETS_OUT_OF_RANGE",
            Self::TimeBudgetOutOfRange => "TIME_BUDGET_OUT_OF_RANGE",
            Self::ProvenanceFieldEmpty => "PROVENANCE_FIELD_EMPTY",
            Self::AutofillRequiresSingleSheet => "AUTOFILL_REQUIRES_SINGLE_SHEET",
            Self::ProductionSchemaUnsupported => "PRODUCTION_SCHEMA_UNSUPPORTED",
            Self::RequestRevisionOutOfRange => "REQUEST_REVISION_OUT_OF_RANGE",
            Self::IdentityHashInvalid => "IDENTITY_HASH_INVALID",
            Self::LegacyGapWithProductionContract => "LEGACY_GAP_WITH_PRODUCTION_CONTRACT",
            Self::ClearanceOutOfRange => "CLEARANCE_OUT_OF_RANGE",
            Self::ClearanceConsumesUsableArea => "CLEARANCE_CONSUMES_USABLE_AREA",
            Self::TooManyFixedObstacles => "TOO_MANY_FIXED_OBSTACLES",
            Self::InvalidObstacleId => "INVALID_OBSTACLE_ID",
            Self::DuplicateObstacleId => "DUPLICATE_OBSTACLE_ID",
            Self::PlacementZonesForbidden => "PLACEMENT_ZONES_FORBIDDEN",
            Self::GroupingIntentNotAllowed => "GROUPING_INTENT_NOT_ALLOWED",
            Self::PlacementZoneUnknownPart => "PLACEMENT_ZONE_UNKNOWN_PART",
            Self::PlacementZoneDuplicatePart => "PLACEMENT_ZONE_DUPLICATE_PART",
            Self::PlacementZoneMissingPart => "PLACEMENT_ZONE_MISSING_PART",
            Self::PlacementZoneInvalidBounds => "PLACEMENT_ZONE_INVALID_BOUNDS",
            Self::PlacementZoneOutsideUsableArea => "PLACEMENT_ZONE_OUTSIDE_USABLE_AREA",
            Self::PlacementZonePartitionInvalid => "PLACEMENT_ZONE_PARTITION_INVALID",
            Self::ProductionJobIdRequired => "PRODUCTION_JOB_ID_REQUIRED",
        }
    }
}

impl fmt::Display for ContractErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Một lỗi hợp đồng. `message` là tiếng Việt cho người dùng cuối và **không chứa
/// toạ độ contour**; `path` là đường dẫn trường trong request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError {
    pub code: ContractErrorCode,
    pub path: String,
    pub message: String,
}

impl ContractError {
    pub fn new(code: ContractErrorCode, path: impl Into<String>, message: String) -> Self {
        Self {
            code,
            path: path.into(),
            message,
        }
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.code, self.path, self.message)
    }
}

/// Tập lỗi hợp đồng, giữ thứ tự phát hiện (ổn định giữa các lần chạy).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContractErrors {
    items: Vec<ContractError>,
    /// Số lỗi đã bỏ qua vì vượt [`MAX_REPORTED_ERRORS`].
    truncated: usize,
}

impl ContractErrors {
    pub fn push(&mut self, error: ContractError) {
        if self.items.len() >= MAX_REPORTED_ERRORS {
            self.truncated = self.truncated.saturating_add(1);
            return;
        }
        self.items.push(error);
    }

    /// Đã đầy quota báo lỗi — nơi gọi nên dừng quét sớm.
    pub fn is_saturated(&self) -> bool {
        self.items.len() >= MAX_REPORTED_ERRORS
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn items(&self) -> &[ContractError] {
        &self.items
    }

    pub fn truncated(&self) -> usize {
        self.truncated
    }

    /// Có lỗi mang mã này hay không.
    pub fn has(&self, code: ContractErrorCode) -> bool {
        self.items.iter().any(|error| error.code == code)
    }

    fn into_result(self) -> Result<(), Self> {
        if self.items.is_empty() {
            Ok(())
        } else {
            Err(self)
        }
    }
}

impl fmt::Display for ContractErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let joined = self
            .items
            .iter()
            .map(ContractError::to_string)
            .collect::<Vec<_>>()
            .join("; ");
        f.write_str(&joined)?;
        if self.truncated > 0 {
            write!(f, " (+{} lỗi nữa bị lược)", self.truncated)?;
        }
        Ok(())
    }
}

impl std::error::Error for ContractErrors {}

// ─────────────────────────────────────────────────────────────────────────────
//  Placement manifest — nguồn chân lý duy nhất cho preview và export
// ─────────────────────────────────────────────────────────────────────────────

/// Pose cứng SE(2) của một instance trên tờ.
///
/// `p_sheet = R(rotationDeg) * (p_source_local - referencePoint) + (translateXmm, translateYmm)`.
///
/// Không lưu kèm matrix: nếu artifact cần matrix thì validator phải **dựng lại** từ
/// `rotationDeg` rồi kiểm parity, tránh hai nguồn chân lý lệch nhau.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pose {
    /// Góc xoay, degree, canonical trong `[0°, 360°)`. Số thực liên tục.
    pub rotation_deg: f64,
    /// Tịnh tiến theo X, mm. Số thực liên tục — không snap grid.
    #[serde(rename = "translateXmm")]
    pub translate_x_mm: f64,
    /// Tịnh tiến theo Y, mm. Số thực liên tục — không snap grid.
    #[serde(rename = "translateYmm")]
    pub translate_y_mm: f64,
}

impl Pose {
    pub const fn new(rotation_deg: f64, translate_x_mm: f64, translate_y_mm: f64) -> Self {
        Self {
            rotation_deg,
            translate_x_mm,
            translate_y_mm,
        }
    }

    pub fn is_finite(&self) -> bool {
        self.rotation_deg.is_finite()
            && self.translate_x_mm.is_finite()
            && self.translate_y_mm.is_finite()
    }
}

/// Một instance đã được đặt trên tờ.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementRecord {
    /// Định danh duy nhất, dạng `"<partId>#<ordinal>"` (xem [`format_instance_id`]).
    pub instance_id: String,
    pub part_id: String,
    pub sheet_index: u32,
    pub pose: Pose,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

/// Lý do một instance không xếp được. Serialize dạng `SCREAMING_SNAKE_CASE` đúng như
/// kế hoạch §11.4 (`NO_FEASIBLE_POSE`, `SEARCH_BUDGET_EXHAUSTED`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UnplacedReason {
    /// Không có pose hợp lệ ở mọi hướng cho phép — hình học thật không vừa.
    NoFeasiblePose,
    /// Hết ngân sách tìm kiếm trước khi phủ work-plan. KHÔNG được dùng thay cho
    /// `NoFeasiblePose`: hai lý do này nói hai chuyện khác nhau với thợ in.
    SearchBudgetExhausted,
    /// Chạm trần `sheet.maxSheets`.
    MaxSheetsReached,
    /// Người dùng hủy trước khi xếp tới instance này.
    Cancelled,
}

/// Một instance chưa xếp được kèm lý do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnplacedRecord {
    pub instance_id: String,
    pub part_id: String,
    pub reason: UnplacedReason,
}

/// Lý do vòng chạy kết thúc. Serialize `snake_case` đúng ví dụ manifest §9.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminationReason {
    /// Đã xếp hết mọi instance và phủ xong work-plan.
    AllPlaced,
    /// Tờ đã đầy — chỉ dùng cho `layoutIntent = autofill_single_sheet`.
    ///
    /// [CHẶNG-A LÔ 1 2026-08-27] Tách khỏi [`Self::MaxSheetsReached`] có chủ đích. Ca
    /// autofill chạm trần một tờ là **thành công**; báo `max_sheets_reached` cho nó thì
    /// thợ in và log đều đọc thành thất bại.
    SheetFull,
    /// Hết ngân sách work-plan cố định (deterministic).
    WorkBudgetExhausted,
    /// Hết deadline wall-clock — chỉ cam kết best-so-far hợp lệ.
    Deadline,
    /// Chạm trần số tờ.
    MaxSheetsReached,
    /// Người dùng hủy.
    Cancelled,
}

/// Thống kê vòng chạy.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunStats {
    pub sheet_count: u32,
    pub placed_count: u64,
    pub unplaced_count: u64,
    /// Tổng diện tích chi tiết / tổng diện tích tờ đã dùng. Là **thống kê**, không
    /// được dùng làm tie-break giữa hai layout cùng số tờ.
    pub material_utilization: f64,
    pub elapsed_ms: u64,
    pub attempts: u64,
    pub orientation_evaluations: u64,
    pub pose_refinements: u64,
    pub termination_reason: TerminationReason,
}

/// Kết luận của final validator độc lập.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationSummary {
    pub valid: bool,
    pub validator_version: u32,
}

/// Toàn bộ version hình học/search ảnh hưởng tới phương án được công bố.
///
/// Engine version một mình không đủ để giải thích vì sao hai lần chạy khác kết quả:
/// thay normalize, NFP, score hay baseline đều có thể đổi layout. Manifest ghi tách
/// từng version để backend quyết định chính xác khi nào cache/artifact đã stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestAlgorithmVersions {
    /// SHA-256 build identity do `native/build.rs` nhúng. Hai file .pyd dựng từ source
    /// khác nhau không được nhận là cùng build chỉ vì trùng crate version.
    pub native_build_identity: String,
    pub production_schema_version: u32,
    pub tolerance_version: u32,
    pub canonicalization_version: u32,
    pub normalize_rule_version: u32,
    pub reference_point_rule_version: u32,
    pub kernel_version: u32,
    pub nfp_rule_version: u32,
    pub score_version: u32,
    pub solver_version: u32,
    pub multi_start_version: u32,
    pub baseline_version: u32,
    pub candidate_rule_version: u32,
    pub refine_rule_version: u32,
}

/// Nguồn của phương án cuối. Không dùng boolean `fallback`: trial thông minh và
/// baseline là hai nguồn có provenance khác nhau, còn trial phải giữ đúng ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ManifestCandidateSource {
    Baseline,
    SmartTrial {
        #[serde(rename = "trialId")]
        trial_id: u64,
    },
}

/// Ảnh chụp gọn của điểm lexicographic.
///
/// `primaryPenalty` là `unplaced_count` đối với quantity fulfillment và penalty cân
/// bằng/số lượng đối với autofill. Tie-break cuối được dựng lại từ placements, nên
/// không nhân đôi cả vector khoá vào manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestScore {
    pub invalid_count: u64,
    pub primary_penalty: u64,
    pub sheet_count: u32,
    pub last_sheet_used_area_fixed: i64,
    pub wasted_within_envelope_fixed: i64,
    pub score_version: u32,
}

/// Ngân sách thực tế đã cấp cho solver. Đây là work budget, không phải cap phần cứng.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestSearchBudget {
    pub trial_count: u32,
    pub orientation_proposals_per_part: u32,
    pub beam_width: u32,
    pub refinement_rounds: u32,
    pub multi_start_restarts: u32,
    pub evaluation_budget: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_budget_ms: Option<u64>,
}

/// Provenance của vòng tìm kiếm và quyết định chọn phương án cuối.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestSearchSummary {
    pub budget: ManifestSearchBudget,
    pub trials_run: u32,
    pub trials_rejected: u32,
    pub selected_candidate: ManifestCandidateSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_score: Option<ManifestScore>,
    pub selected_score: ManifestScore,
}

/// Trạng thái cuối của job trong manifest. Manifest chỉ tồn tại ở trạng thái terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestStatus {
    Completed,
    Failed,
    Cancelled,
}

/// Placement manifest — **nguồn chân lý duy nhất** cho preview và export.
///
/// Preview và export đọc nguyên giá trị `f64` của `pose`; không bên nào được làm
/// tròn, snap hay tính lại layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlacementManifest {
    pub schema_version: u32,
    /// V1 dùng một lifecycle đơn giản: một job chỉ được công bố tối đa một manifest
    /// terminal, vì vậy `manifestId == jobId`. Backend sở hữu cả hai ID; engine không
    /// tự sinh UUID/RNG và chỉ echo đúng ID đã được cấp.
    pub manifest_id: String,
    pub protocol_version: u32,
    pub engine_version: String,
    pub job_id: String,
    /// Ba trường identity chỉ `None` trên đường lab/legacy. Adapter Tem bế/CNC
    /// production bắt buộc gắn `ProductionContractV1`; tầng persist phải fail-closed
    /// nếu một trong ba trường này vắng mặt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_fingerprint: Option<String>,
    pub layout_intent: LayoutIntent,
    pub seed: u64,
    pub status: ManifestStatus,
    pub provenance: ManifestAlgorithmVersions,
    pub search: ManifestSearchSummary,
    pub placements: Vec<PlacementRecord>,
    pub unplaced: Vec<UnplacedRecord>,
    pub stats: RunStats,
    pub validation: ValidationSummary,
}

/// Dựng `instanceId` theo hợp đồng: `"<partId>#<ordinal 4 chữ số, đếm từ 1>"`.
///
/// Số lượng vượt 9.999 sẽ tràn sang 5 chữ số (`part-a#10000`) — vẫn duy nhất vì
/// `ordinal` là số nguyên tăng dần trong cùng một `partId`.
pub fn format_instance_id(part_id: &str, ordinal_one_based: u32) -> String {
    format!("{part_id}#{ordinal_one_based:04}")
}
