//! Chuẩn hoá contour và dựng request nội bộ cho engine (P2a).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §9.1, §10.
//!
//! Đây là **biên enforcement cuối** cho hình học đầu vào. Sidecar Pydantic đã lọc một
//! lượt, nhưng Rust vẫn phải tự từ chối polygon xấu: nếu tin đầu vào, một contour tự
//! cắt sẽ làm NFP và validator ở phase sau cho kết luận sai mà không ai thấy.
//!
//! ## Chuỗi chuẩn hoá một vòng (quy tắc version [`NORMALIZE_RULE_VERSION`])
//!
//! 1. Bỏ đỉnh đóng vòng bị lặp (`points[last] == points[0]`).
//! 2. Bỏ đỉnh trùng liền kề trong dung sai tuyến tính.
//! 3. Bỏ đỉnh thẳng hàng (collinear noise) và mũi gai suy biến.
//! 4. Còn dưới 3 đỉnh ⇒ từ chối.
//! 5. Diện tích nhỏ hơn ngưỡng theo thang hình ⇒ từ chối.
//! 6. Chuẩn hoá chiều: contour ngoài **CCW** (diện tích có dấu dương), lỗ **CW**.
//! 7. Từ chối vòng tự cắt hoặc tự chạm ở cạnh không kề nhau.
//!
//! Bước 6 là **đổi tham số hoá của cùng một tập điểm**, không phải phép lật gương.
//! Phân biệt này quan trọng: chốt "bảo toàn hướng signed-area" ở
//! [`super::transform`] làm việc trên *phép biến đổi*, và luôn so với vòng đã chuẩn
//! hoá, nên việc đảo chiều ở đây không thể bị nhầm thành mirror.
//!
//! ## Điểm tham chiếu
//!
//! Pivot của pose là **trọng tâm diện tích** của contour ngoài
//! (quy tắc version [`REFERENCE_POINT_RULE_VERSION`]). Cố ý KHÔNG dùng góc bbox: kế
//! hoạch §9.1 cấm lấy góc trái bbox đã xoay làm pivot, và trọng tâm còn có hai tính
//! chất cần thiết — bất biến với chỉ số đỉnh bắt đầu, bất biến với chiều vòng, và
//! đồng biến với phép xoay (`centroid(R·p) = R·centroid(p)`).

use super::model::{
    ContractErrors, MixedNestingRequest, PartSpec, PointMm, Tolerance, MAX_RING_VERTICES,
};
use super::orientation::{resolve_part_domain, OrientationError, RotationDomain};
use super::transform::{perimeter_mm, signed_area_mm2};

/// Version của quy tắc chuẩn hoá contour. Đổi quy tắc là đổi hợp đồng.
pub const NORMALIZE_RULE_VERSION: u32 = 1;

/// Version của quy tắc suy ra điểm tham chiếu.
pub const REFERENCE_POINT_RULE_VERSION: u32 = 1;

/// Sàn tuyệt đối của ngưỡng diện tích, mm² — chặn cả trường hợp hình siêu nhỏ.
pub const MIN_RING_AREA_FLOOR_MM2: f64 = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
//  Hộp bao
// ─────────────────────────────────────────────────────────────────────────────

/// Hộp bao trục toạ độ, mm. Trục Y hướng lên, gốc ở góc trái dưới.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundsMm {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl BoundsMm {
    /// Hộp bao của một vòng. `None` khi vòng rỗng hoặc có toạ độ không hữu hạn.
    pub fn from_ring(ring: &[PointMm]) -> Option<Self> {
        let first = ring.first()?;
        if !first.is_finite() {
            return None;
        }
        let mut bounds = Self {
            min_x: first.x,
            min_y: first.y,
            max_x: first.x,
            max_y: first.y,
        };
        for point in &ring[1..] {
            if !point.is_finite() {
                return None;
            }
            bounds.min_x = bounds.min_x.min(point.x);
            bounds.min_y = bounds.min_y.min(point.y);
            bounds.max_x = bounds.max_x.max(point.x);
            bounds.max_y = bounds.max_y.max(point.y);
        }
        Some(bounds)
    }

    pub fn width_mm(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height_mm(&self) -> f64 {
        self.max_y - self.min_y
    }

    pub fn diagonal_mm(&self) -> f64 {
        (self.width_mm().powi(2) + self.height_mm().powi(2)).sqrt()
    }

    pub fn center(&self) -> PointMm {
        PointMm::new(
            (self.min_x + self.max_x) / 2.0,
            (self.min_y + self.max_y) / 2.0,
        )
    }

    /// Hộp này có chứa `other` (cho phép sai lệch trong dung sai) hay không.
    pub fn contains_bounds(&self, other: &Self, tol: &Tolerance) -> bool {
        other.min_x >= self.min_x - tol.linear_mm
            && other.min_y >= self.min_y - tol.linear_mm
            && other.max_x <= self.max_x + tol.linear_mm
            && other.max_y <= self.max_y + tol.linear_mm
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lỗi
// ─────────────────────────────────────────────────────────────────────────────

/// Mã lỗi hình học khi chuẩn hoá.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizeErrorCode {
    /// Có toạ độ không hữu hạn.
    RingNotFinite,
    /// Còn dưới 3 đỉnh sau khi làm sạch.
    RingDegenerate,
    /// Diện tích nhỏ hơn ngưỡng theo thang hình.
    RingZeroArea,
    /// Vòng tự cắt hoặc tự chạm ở hai cạnh không kề nhau.
    RingSelfIntersecting,
    /// Vượt trần số đỉnh.
    RingTooManyVertices,
    /// Không suy ra được điểm tham chiếu.
    ReferencePointUndefined,
    /// Ràng buộc xoay không phân giải được.
    RotationPolicyInvalid,
}

impl NormalizeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RingNotFinite => "RING_NOT_FINITE",
            Self::RingDegenerate => "RING_DEGENERATE",
            Self::RingZeroArea => "RING_ZERO_AREA",
            Self::RingSelfIntersecting => "RING_SELF_INTERSECTING",
            Self::RingTooManyVertices => "RING_TOO_MANY_VERTICES",
            Self::ReferencePointUndefined => "REFERENCE_POINT_UNDEFINED",
            Self::RotationPolicyInvalid => "ROTATION_POLICY_INVALID",
        }
    }
}

/// Một lỗi hình học. `message` là tiếng Việt và **không chứa toạ độ khách hàng**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizeError {
    pub code: NormalizeErrorCode,
    pub path: String,
    pub message: String,
}

impl NormalizeError {
    fn new(code: NormalizeErrorCode, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for NormalizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "[{}] {}: {}",
            self.code.as_str(),
            self.path,
            self.message
        )
    }
}

/// Hai lớp thất bại tách bạch: sai hợp đồng dữ liệu, hay sai hình học.
#[derive(Debug, Clone, PartialEq)]
pub enum NormalizeFailure {
    /// Không qua [`MixedNestingRequest::validate`].
    Contract(ContractErrors),
    /// Qua hợp đồng nhưng hình học không dùng được.
    Geometry(Vec<NormalizeError>),
}

impl NormalizeFailure {
    /// Danh sách mã lỗi dạng chuỗi, để test và backend map lỗi không phải xâu chuỗi text.
    pub fn codes(&self) -> Vec<&'static str> {
        match self {
            Self::Contract(errors) => errors.items().iter().map(|e| e.code.as_str()).collect(),
            Self::Geometry(errors) => errors.iter().map(|e| e.code.as_str()).collect(),
        }
    }

    /// Có lỗi hình học mang mã này hay không.
    pub fn has_geometry(&self, code: NormalizeErrorCode) -> bool {
        matches!(self, Self::Geometry(errors) if errors.iter().any(|e| e.code == code))
    }
}

impl std::fmt::Display for NormalizeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(errors) => write!(f, "{errors}"),
            Self::Geometry(errors) => {
                let joined = errors
                    .iter()
                    .map(NormalizeError::to_string)
                    .collect::<Vec<_>>()
                    .join("; ");
                f.write_str(&joined)
            }
        }
    }
}

impl std::error::Error for NormalizeFailure {}

// ─────────────────────────────────────────────────────────────────────────────
//  Kết quả chuẩn hoá
// ─────────────────────────────────────────────────────────────────────────────

/// Tờ vật liệu đã tính sẵn vùng dùng được.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizedSheet {
    pub width_mm: f64,
    pub height_mm: f64,
    /// Vùng dùng được sau khi trừ lề. Trục Y hướng lên nên lề dưới là `min_y` và lề
    /// trên trừ vào `max_y` — nhầm chiều này là đặt chi tiết lệch cả tờ.
    pub usable: BoundsMm,
    pub max_sheets: u32,
}

/// Một loại chi tiết đã chuẩn hoá, sẵn sàng cho solver.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedPart {
    pub part_id: String,
    pub quantity: u32,
    /// Contour ngoài, CCW, đã làm sạch.
    pub outer: Vec<PointMm>,
    /// Lỗ khoét, CW, đã làm sạch. MVP coi là vật liệu đặc khi collision/score.
    pub holes: Vec<Vec<PointMm>>,
    pub bounds: BoundsMm,
    /// Diện tích contour ngoài, mm², luôn dương.
    pub outer_area_mm2: f64,
    /// Tổng diện tích lỗ (trị tuyệt đối), mm².
    pub holes_area_mm2: f64,
    /// Pivot của pose, trong hệ local của chi tiết.
    pub reference_point_mm: PointMm,
    pub reference_point_rule_version: u32,
    /// Miền góc hợp lệ đã phân giải `inherit` và canonical hoá.
    pub rotation_domain: RotationDomain,
    pub geometry_hash: Option<String>,
    pub source_revision: Option<String>,
}

impl NormalizedPart {
    /// Diện tích dùng cho `materialUtilization` và score.
    ///
    /// MVP coi lỗ là vật liệu đặc (§5.3), nên đây là diện tích contour ngoài. Khi phase
    /// sau bật hole nesting thì đổi ở đúng một chỗ này.
    pub fn effective_area_mm2(&self) -> f64 {
        self.outer_area_mm2
    }

    /// Tổng diện tích của cả `quantity` con, mm².
    pub fn total_area_mm2(&self) -> f64 {
        self.effective_area_mm2() * f64::from(self.quantity)
    }
}

/// Request nội bộ bất biến — thứ mà baseline, solver và validator cùng đọc.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedRequest {
    pub protocol_version: u32,
    pub seed: u64,
    pub profile: super::model::Profile,
    pub time_budget_ms: Option<u64>,
    pub sheet: NormalizedSheet,
    pub gap_mm: f64,
    pub parts: Vec<NormalizedPart>,
    pub tolerance: Tolerance,
    pub normalize_rule_version: u32,
}

impl NormalizedRequest {
    /// Tổng số instance phải xếp.
    pub fn total_instances(&self) -> u64 {
        self.parts.iter().map(|p| u64::from(p.quantity)).sum()
    }

    /// Tổng diện tích chi tiết, mm² — tử số của `materialUtilization`.
    pub fn total_part_area_mm2(&self) -> f64 {
        self.parts.iter().map(NormalizedPart::total_area_mm2).sum()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Điểm vào
// ─────────────────────────────────────────────────────────────────────────────

/// Chuẩn hoá toàn bộ request: kiểm hợp đồng → làm sạch contour → suy pivot →
/// phân giải miền góc.
///
/// Lỗi hình học được **gom hết** để người dùng sửa một lượt, thay vì báo từng cái một.
pub fn normalize_request(
    request: &MixedNestingRequest,
) -> Result<NormalizedRequest, NormalizeFailure> {
    request.validate().map_err(NormalizeFailure::Contract)?;

    let tol = Tolerance::v1();
    let mut errors: Vec<NormalizeError> = Vec::new();
    let mut parts: Vec<NormalizedPart> = Vec::with_capacity(request.parts.len());

    for (index, part) in request.parts.iter().enumerate() {
        match normalize_part(request, part, index, &tol) {
            Ok(normalized) => parts.push(normalized),
            Err(mut part_errors) => errors.append(&mut part_errors),
        }
    }

    if !errors.is_empty() {
        return Err(NormalizeFailure::Geometry(errors));
    }

    let margin = request.sheet.margin_mm;
    let sheet = NormalizedSheet {
        width_mm: request.sheet.width_mm,
        height_mm: request.sheet.height_mm,
        usable: BoundsMm {
            min_x: margin.left,
            min_y: margin.bottom,
            max_x: request.sheet.width_mm - margin.right,
            max_y: request.sheet.height_mm - margin.top,
        },
        max_sheets: request.sheet.max_sheets,
    };

    Ok(NormalizedRequest {
        protocol_version: request.protocol_version,
        seed: request.seed,
        profile: request.profile,
        time_budget_ms: request.time_budget_ms,
        sheet,
        gap_mm: request.gap_mm,
        parts,
        tolerance: tol,
        normalize_rule_version: NORMALIZE_RULE_VERSION,
    })
}

fn normalize_part(
    request: &MixedNestingRequest,
    part: &PartSpec,
    index: usize,
    tol: &Tolerance,
) -> Result<NormalizedPart, Vec<NormalizeError>> {
    let base = format!("parts[{index}]");
    let mut errors: Vec<NormalizeError> = Vec::new();

    let outer = match normalize_ring(&part.outer, &format!("{base}.outer"), Winding::Ccw, tol) {
        Ok(ring) => Some(ring),
        Err(mut ring_errors) => {
            errors.append(&mut ring_errors);
            None
        }
    };

    let mut holes: Vec<Vec<PointMm>> = Vec::with_capacity(part.holes.len());
    let mut holes_area = 0.0;
    for (hole_index, hole) in part.holes.iter().enumerate() {
        match normalize_ring(
            hole,
            &format!("{base}.holes[{hole_index}]"),
            Winding::Cw,
            tol,
        ) {
            Ok(ring) => {
                holes_area += signed_area_mm2(&ring).abs();
                holes.push(ring);
            }
            Err(mut ring_errors) => errors.append(&mut ring_errors),
        }
    }

    let rotation_domain = match resolve_part_domain(request, part, tol) {
        Ok(domain) => Some(domain),
        Err(error) => {
            errors.push(NormalizeError::new(
                NormalizeErrorCode::RotationPolicyInvalid,
                format!("{base}.rotationConstraint"),
                rotation_message(error),
            ));
            None
        }
    };

    let Some(outer) = outer else {
        return Err(errors);
    };
    let Some(rotation_domain) = rotation_domain else {
        return Err(errors);
    };
    if !errors.is_empty() {
        return Err(errors);
    }

    let Some(bounds) = BoundsMm::from_ring(&outer) else {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingNotFinite,
            format!("{base}.outer"),
            "Nét cắt ngoài chứa toạ độ không hữu hạn.",
        )]);
    };

    // Pivot: dùng giá trị server-owned nếu backend đã canonicalize, nếu không thì suy
    // theo quy tắc có version.
    let reference_point_mm = match part.reference_point_mm {
        Some(point) if point.is_finite() => point,
        Some(_) => {
            return Err(vec![NormalizeError::new(
                NormalizeErrorCode::ReferencePointUndefined,
                format!("{base}.referencePointMm"),
                "Điểm tham chiếu không hữu hạn.",
            )])
        }
        None => match derive_reference_point(&outer) {
            Some(point) => point,
            None => {
                return Err(vec![NormalizeError::new(
                    NormalizeErrorCode::ReferencePointUndefined,
                    format!("{base}.outer"),
                    "Không suy được điểm tham chiếu từ nét cắt ngoài.",
                )])
            }
        },
    };

    Ok(NormalizedPart {
        part_id: part.part_id.clone(),
        quantity: part.quantity,
        outer_area_mm2: signed_area_mm2(&outer).abs(),
        outer,
        holes,
        bounds,
        holes_area_mm2: holes_area,
        reference_point_mm,
        reference_point_rule_version: REFERENCE_POINT_RULE_VERSION,
        rotation_domain,
        geometry_hash: part.geometry_hash.clone(),
        source_revision: part.source_revision.clone(),
    })
}

fn rotation_message(error: OrientationError) -> String {
    error.message_vi().to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
//  Chuẩn hoá một vòng
// ─────────────────────────────────────────────────────────────────────────────

/// Chiều mong muốn của vòng sau khi chuẩn hoá.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winding {
    /// Ngược chiều kim đồng hồ — diện tích có dấu dương. Dùng cho contour ngoài.
    Ccw,
    /// Cùng chiều kim đồng hồ — diện tích có dấu âm. Dùng cho lỗ.
    Cw,
}

/// Làm sạch và chuẩn hoá một vòng contour theo chuỗi bảy bước ở đầu file.
pub fn normalize_ring(
    ring: &[PointMm],
    path: &str,
    winding: Winding,
    tol: &Tolerance,
) -> Result<Vec<PointMm>, Vec<NormalizeError>> {
    if ring.len() > MAX_RING_VERTICES {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingTooManyVertices,
            path,
            format!("Nét cắt vượt trần {MAX_RING_VERTICES} đỉnh."),
        )]);
    }
    if ring.iter().any(|point| !point.is_finite()) {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingNotFinite,
            path,
            "Nét cắt chứa toạ độ không hữu hạn.",
        )]);
    }

    let mut points = ring.to_vec();
    drop_closing_duplicate(&mut points, tol);
    drop_adjacent_duplicates(&mut points, tol);
    let mut points = drop_collinear(points, tol);
    // Bỏ đỉnh thẳng hàng có thể tạo ra đỉnh trùng mới ở chỗ nối, nên làm sạch lần nữa.
    drop_adjacent_duplicates(&mut points, tol);

    if points.len() < 3 {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingDegenerate,
            path,
            "Nét cắt còn dưới 3 đỉnh sau khi loại đỉnh trùng và thẳng hàng.",
        )]);
    }

    let Some(bounds) = BoundsMm::from_ring(&points) else {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingNotFinite,
            path,
            "Nét cắt chứa toạ độ không hữu hạn.",
        )]);
    };
    let area = signed_area_mm2(&points);
    if area.abs() <= min_ring_area_mm2(&bounds, tol) {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingZeroArea,
            path,
            "Nét cắt gần như không có diện tích — kiểm lại đường dao của mẫu.",
        )]);
    }

    // Chuẩn hoá chiều. Đây là đổi tham số hoá, không phải lật gương.
    let want_positive = matches!(winding, Winding::Ccw);
    if (area > 0.0) != want_positive {
        points.reverse();
    }

    if let Some((first, second)) = find_self_intersection(&points, tol) {
        return Err(vec![NormalizeError::new(
            NormalizeErrorCode::RingSelfIntersecting,
            path,
            format!("Nét cắt tự cắt tại đoạn #{first} và #{second} — không bế được hình này."),
        )]);
    }

    Ok(points)
}

/// Ngưỡng diện tích tối thiểu, mm².
///
/// Không dùng hằng số tuyệt đối: một vòng "mỏng hơn dung sai ở mọi chỗ" có diện tích
/// cỡ `linear_mm × đường kính`. Lấy ngưỡng theo chính thang hình nên tem 5 mm và khuôn
/// 700 mm dùng cùng một quy tắc.
fn min_ring_area_mm2(bounds: &BoundsMm, tol: &Tolerance) -> f64 {
    (tol.linear_mm * bounds.diagonal_mm().max(1.0)).max(MIN_RING_AREA_FLOOR_MM2)
}

fn distance_mm(a: PointMm, b: PointMm) -> f64 {
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}

/// Tích có hướng `(a−o) × (b−o)`. Trị tuyệt đối bằng `khoảng cách × độ dài`.
fn cross_mm2(o: PointMm, a: PointMm, b: PointMm) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

fn drop_closing_duplicate(points: &mut Vec<PointMm>, tol: &Tolerance) {
    while points.len() >= 2 {
        let first = points[0];
        let last = points[points.len() - 1];
        if distance_mm(first, last) <= tol.linear_mm {
            points.pop();
        } else {
            break;
        }
    }
}

fn drop_adjacent_duplicates(points: &mut Vec<PointMm>, tol: &Tolerance) {
    let mut kept: Vec<PointMm> = Vec::with_capacity(points.len());
    for point in points.iter().copied() {
        match kept.last() {
            Some(last) if distance_mm(*last, point) <= tol.linear_mm => {}
            _ => kept.push(point),
        }
    }
    // Đóng vòng: đỉnh cuối có thể trùng đỉnh đầu sau khi lọc.
    while kept.len() >= 2 && distance_mm(kept[0], kept[kept.len() - 1]) <= tol.linear_mm {
        kept.pop();
    }
    *points = kept;
}

/// `b` có nằm trên đoạn thẳng `a→c` trong dung sai hay không.
///
/// Trường hợp `a ≈ c` là mũi gai suy biến (đường đi ra rồi quay lại đúng chỗ cũ) —
/// cũng coi là bỏ được, vì nó không tạo diện tích.
fn is_collinear(a: PointMm, b: PointMm, c: PointMm, tol: &Tolerance) -> bool {
    let span = distance_mm(a, c);
    if span <= tol.linear_mm {
        return true;
    }
    cross_mm2(a, b, c).abs() <= tol.linear_mm * span
}

fn drop_collinear(points: Vec<PointMm>, tol: &Tolerance) -> Vec<PointMm> {
    let mut kept: Vec<PointMm> = Vec::with_capacity(points.len());
    for point in points {
        while kept.len() >= 2 {
            let a = kept[kept.len() - 2];
            let b = kept[kept.len() - 1];
            if is_collinear(a, b, point, tol) {
                kept.pop();
            } else {
                break;
            }
        }
        kept.push(point);
    }
    // Hai chỗ nối của vòng cũng phải được xét, nếu không đỉnh đầu/cuối sẽ sót.
    while kept.len() >= 3 {
        let a = kept[kept.len() - 2];
        let b = kept[kept.len() - 1];
        let c = kept[0];
        if is_collinear(a, b, c, tol) {
            kept.pop();
        } else {
            break;
        }
    }
    while kept.len() >= 3 {
        let a = kept[kept.len() - 1];
        let b = kept[0];
        let c = kept[1];
        if is_collinear(a, b, c, tol) {
            kept.remove(0);
        } else {
            break;
        }
    }
    kept
}

/// Trọng tâm diện tích của vòng — pivot canonical của pose.
///
/// Bất biến với chỉ số đỉnh bắt đầu và với chiều vòng (cả tử và mẫu cùng đổi dấu).
pub fn derive_reference_point(ring: &[PointMm]) -> Option<PointMm> {
    if ring.len() < 3 {
        return None;
    }
    let mut double_area = 0.0;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    for index in 0..ring.len() {
        let current = ring[index];
        let next = ring[(index + 1) % ring.len()];
        let cross = current.x * next.y - next.x * current.y;
        double_area += cross;
        sum_x += (current.x + next.x) * cross;
        sum_y += (current.y + next.y) * cross;
    }
    if double_area.abs() < f64::MIN_POSITIVE {
        return None;
    }
    let centroid = PointMm::new(sum_x / (3.0 * double_area), sum_y / (3.0 * double_area));
    centroid.is_finite().then_some(centroid)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phát hiện tự cắt
// ─────────────────────────────────────────────────────────────────────────────

/// Tìm một cặp cạnh không kề nhau bị cắt hoặc chạm. `None` = vòng đơn (simple).
///
/// Quét theo trục X với danh sách cạnh đang hoạt động: cạnh nào có `maxX` nhỏ hơn
/// `minX` hiện tại thì loại khỏi danh sách. Với contour thực tế danh sách này rất
/// ngắn nên chi phí gần `O(n log n)`; trường hợp bệnh lý (mọi cạnh trải hết bề rộng)
/// suy biến về `O(n²)` và được chặn bởi trần `MAX_RING_VERTICES`.
pub fn find_self_intersection(ring: &[PointMm], tol: &Tolerance) -> Option<(usize, usize)> {
    let count = ring.len();
    // Tam giác không thể tự cắt sau khi đã loại đỉnh trùng và thẳng hàng.
    if count < 4 {
        return None;
    }
    let segment = |index: usize| (ring[index], ring[(index + 1) % count]);

    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by(|left, right| {
        let (l0, l1) = segment(*left);
        let (r0, r1) = segment(*right);
        l0.x.min(l1.x)
            .partial_cmp(&r0.x.min(r1.x))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut active: Vec<usize> = Vec::new();
    for index in order {
        let (start, end) = segment(index);
        let min_x = start.x.min(end.x);
        active.retain(|other| {
            let (o0, o1) = segment(*other);
            o0.x.max(o1.x) >= min_x - tol.linear_mm
        });
        for other in &active {
            if are_adjacent(index, *other, count) {
                continue;
            }
            let (o0, o1) = segment(*other);
            if segments_intersect(start, end, o0, o1, tol) {
                return Some((index.min(*other), index.max(*other)));
            }
        }
        active.push(index);
    }
    None
}

/// Hai cạnh chung một đỉnh của vòng — được phép chạm nhau tại đỉnh đó.
fn are_adjacent(left: usize, right: usize, count: usize) -> bool {
    (left + 1) % count == right || (right + 1) % count == left
}

/// Dấu của một tích có hướng, với dung sai quy về khoảng cách thật.
fn sign_with_tol(value: f64, tol_area: f64) -> i32 {
    if value > tol_area {
        1
    } else if value < -tol_area {
        -1
    } else {
        0
    }
}

/// `p` (đã gần thẳng hàng với `a→b`) có nằm trong đoạn `a→b` hay không.
fn on_segment(a: PointMm, b: PointMm, p: PointMm, tol: &Tolerance) -> bool {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let length_sq = dx * dx + dy * dy;
    if length_sq <= tol.linear_mm * tol.linear_mm {
        return distance_mm(a, p) <= tol.linear_mm;
    }
    let projection = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length_sq;
    let margin = tol.linear_mm / length_sq.sqrt();
    projection >= -margin && projection <= 1.0 + margin
}

/// Hai đoạn thẳng có cắt hoặc chạm nhau hay không.
///
/// Dung sai được quy về **khoảng cách mm** cho từng đường: `|cross| = khoảng cách ×
/// độ dài`, nên ngưỡng phải nhân với độ dài của đúng đoạn đang làm đường tham chiếu.
/// Nếu dùng một hằng số diện tích chung thì hình nhỏ bị kiểm quá lỏng và hình lớn bị
/// kiểm quá chặt.
pub fn segments_intersect(
    p1: PointMm,
    p2: PointMm,
    q1: PointMm,
    q2: PointMm,
    tol: &Tolerance,
) -> bool {
    let tol_p = tol.linear_mm * distance_mm(p1, p2).max(tol.linear_mm);
    let tol_q = tol.linear_mm * distance_mm(q1, q2).max(tol.linear_mm);

    let d1 = sign_with_tol(cross_mm2(q1, q2, p1), tol_q);
    let d2 = sign_with_tol(cross_mm2(q1, q2, p2), tol_q);
    let d3 = sign_with_tol(cross_mm2(p1, p2, q1), tol_p);
    let d4 = sign_with_tol(cross_mm2(p1, p2, q2), tol_p);

    // Cắt thật: mỗi đoạn nằm hai bên đường của đoạn kia.
    if d1 * d2 < 0 && d3 * d4 < 0 {
        return true;
    }
    // Chạm: một đầu mút nằm trên đoạn kia.
    (d1 == 0 && on_segment(q1, q2, p1, tol))
        || (d2 == 0 && on_segment(q1, q2, p2, tol))
        || (d3 == 0 && on_segment(p1, p2, q1, tol))
        || (d4 == 0 && on_segment(p1, p2, q2, tol))
}

/// Chu vi của vòng, mm — tiện cho report; giữ ở đây để nơi dùng không phải import
/// chéo sang `transform`.
pub fn ring_perimeter_mm(ring: &[PointMm]) -> f64 {
    perimeter_mm(ring)
}
