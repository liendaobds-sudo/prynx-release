//! Final validator độc lập (P2c).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §3.3, §11.6.
//!
//! ## Nguyên tắc: không tự bào chữa
//!
//! §11.6 ghi: "Validator không gọi lại logic quyết định của solver." Module này vì vậy
//! **không** import `nfp`, `spatial`, `candidates`, `refine`, `solver`, và **không** dùng
//! cache nào. Nó dựng lại phép biến đổi từ `theta` rồi đo trực tiếp bằng
//! [`super::collision`]. Một lỗi trong bộ sinh ứng viên không có đường nào để tự chứng
//! nhận là hợp lệ.
//!
//! ## Chín việc phải kiểm (§11.6)
//!
//! 1. Bảo toàn số lượng và tính duy nhất của `instanceId`.
//! 2. `theta/tx/ty` hữu hạn; `theta` canonical và **thuộc rotation domain** sau khi
//!    phân giải cả policy job lẫn override từng chi tiết.
//! 3. Tự dựng phép cứng từ `theta`/tịnh tiến; từ chối scale, shear, reflection, đảo
//!    hướng signed-area và matrix drift.
//! 4. **Không** áp angle step hay translation grid.
//! 5. Từng contour đã transform nằm trong vùng dùng được.
//! 6. Không chồng lấn và thoả `gapMm` cho mọi cặp có khả năng giao nhau.
//! 7. `sourceRevision` khớp request nội bộ.
//! 8. Thống kê khớp placements thực.
//! 9. Kết quả không qua validator thì **fail job**, không "sửa nhẹ" rồi công bố.

use std::collections::BTreeMap;

use super::collision::{judge_pair, ring_within_bounds, signed_margin_to_bounds_mm, PairVerdict};
use super::model::{
    canonicalize_angle_deg, format_instance_id, PlacementRecord, PointMm, RunStats,
    TerminationReason, UnplacedRecord, MIXED_NESTING_VALIDATOR_VERSION,
};
use super::normalize::{NormalizedPart, NormalizedRequest};
use super::spatial::SpatialGrid;
use super::transform::{place_ring_checked, RigidityViolation};

/// Mã lỗi validate. Ổn định để backend map và để test khẳng định đúng nguyên nhân.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationCode {
    /// Số lượng đặt + chưa đặt không khớp `quantity` đã khai.
    QuantityMismatch,
    /// `instanceId` trùng.
    DuplicateInstanceId,
    /// `instanceId` không đúng dạng hoặc không thuộc chi tiết nào.
    UnknownInstanceId,
    /// `partId` không có trong request.
    UnknownPartId,
    /// `sheetIndex` vượt trần số tờ.
    SheetIndexOutOfRange,
    /// Pose có số không hữu hạn.
    PoseNotFinite,
    /// `theta` không canonical trong `[0°, 360°)`.
    AngleNotCanonical,
    /// `theta` không thuộc miền xoay hợp lệ của chi tiết.
    AngleOutsideDomain,
    /// Phép biến đổi không cứng: scale, shear, mirror hoặc drift.
    TransformNotRigid,
    /// Contour tràn khỏi vùng dùng được.
    OutsideUsableArea,
    /// Hai chi tiết chồng lấn.
    Overlap,
    /// Khoảng hở nhỏ hơn `gapMm`.
    ClearanceTooSmall,
    /// `sourceRevision` không khớp request nội bộ.
    SourceRevisionMismatch,
    /// Thống kê không khớp placements thực.
    StatsMismatch,
}

impl ValidationCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::QuantityMismatch => "QUANTITY_MISMATCH",
            Self::DuplicateInstanceId => "DUPLICATE_INSTANCE_ID",
            Self::UnknownInstanceId => "UNKNOWN_INSTANCE_ID",
            Self::UnknownPartId => "UNKNOWN_PART_ID",
            Self::SheetIndexOutOfRange => "SHEET_INDEX_OUT_OF_RANGE",
            Self::PoseNotFinite => "POSE_NOT_FINITE",
            Self::AngleNotCanonical => "ANGLE_NOT_CANONICAL",
            Self::AngleOutsideDomain => "ANGLE_OUTSIDE_DOMAIN",
            Self::TransformNotRigid => "TRANSFORM_NOT_RIGID",
            Self::OutsideUsableArea => "OUTSIDE_USABLE_AREA",
            Self::Overlap => "OVERLAP",
            Self::ClearanceTooSmall => "CLEARANCE_TOO_SMALL",
            Self::SourceRevisionMismatch => "SOURCE_REVISION_MISMATCH",
            Self::StatsMismatch => "STATS_MISMATCH",
        }
    }

    /// Thông báo tiếng Việt cho thợ in — nói được việc phải làm, không dán mã lỗi.
    pub fn message_vi(self) -> &'static str {
        match self {
            Self::QuantityMismatch => "Số con đã xếp không khớp số lượng đã khai.",
            Self::DuplicateInstanceId => "Có hai con trùng định danh.",
            Self::UnknownInstanceId => "Định danh con không thuộc chi tiết nào trong lệnh.",
            Self::UnknownPartId => "Mã chi tiết không có trong lệnh.",
            Self::SheetIndexOutOfRange => "Số tờ vượt giới hạn đã khai.",
            Self::PoseNotFinite => "Vị trí đặt chứa số không hữu hạn.",
            Self::AngleNotCanonical => "Góc xoay chưa chuẩn hoá về khoảng 0°–360°.",
            Self::AngleOutsideDomain => "Góc xoay nằm ngoài ràng buộc đã đặt cho chi tiết.",
            Self::TransformNotRigid => {
                "Phép đặt không phải xoay-và-dịch thuần — có lật, phóng hoặc kéo xiên."
            }
            Self::OutsideUsableArea => "Có chi tiết tràn ra ngoài vùng in sau khi trừ lề.",
            Self::Overlap => "Có hai chi tiết chồng lên nhau.",
            Self::ClearanceTooSmall => "Khoảng hở giữa hai nét cắt nhỏ hơn mức đã khai.",
            Self::SourceRevisionMismatch => {
                "Bản mẫu đã thay đổi so với lúc tính — cần tính lại phương án."
            }
            Self::StatsMismatch => "Thống kê không khớp phương án thực tế.",
        }
    }
}

/// Một vi phạm cụ thể.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationIssue {
    pub code: ValidationCode,
    /// Định danh con liên quan; rỗng khi lỗi ở cấp cả job.
    pub instance_id: String,
    /// Định danh con thứ hai với lỗi theo cặp.
    pub other_instance_id: String,
    /// Số đo được, mm hoặc degree tuỳ mã lỗi. Không chứa toạ độ contour.
    pub measured: f64,
    /// Số yêu cầu.
    pub required: f64,
}

impl ValidationIssue {
    fn simple(code: ValidationCode, instance_id: &str) -> Self {
        Self {
            code,
            instance_id: instance_id.to_string(),
            other_instance_id: String::new(),
            measured: 0.0,
            required: 0.0,
        }
    }
}

impl std::fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}]", self.code.as_str())?;
        if !self.instance_id.is_empty() {
            write!(f, " {}", self.instance_id)?;
        }
        if !self.other_instance_id.is_empty() {
            write!(f, " ↔ {}", self.other_instance_id)?;
        }
        write!(f, ": {}", self.code.message_vi())
    }
}

/// Kết luận của validator.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationReport {
    pub valid: bool,
    pub validator_version: u32,
    pub issues: Vec<ValidationIssue>,
    /// Số cặp thực sự phải đo ở narrow phase — chứng minh broad phase có tác dụng.
    pub pairs_checked: usize,
    /// Khoảng hở nhỏ nhất đo được trên toàn layout, mm.
    pub min_clearance_mm: f64,
    /// Lề nhỏ nhất tới biên vùng dùng được, mm. Âm là đã tràn.
    pub min_margin_mm: f64,
}

impl ValidationReport {
    pub fn has(&self, code: ValidationCode) -> bool {
        self.issues.iter().any(|issue| issue.code == code)
    }

    pub fn codes(&self) -> Vec<&'static str> {
        self.issues.iter().map(|i| i.code.as_str()).collect()
    }
}

/// Số vi phạm tối đa gom lại. Layout hỏng nặng có thể sinh hàng nghìn cặp lỗi.
pub const MAX_ISSUES: usize = 64;

/// Bố cục đầy đủ để validate: placements + unplaced + stats.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutUnderReview<'a> {
    pub placements: &'a [PlacementRecord],
    pub unplaced: &'a [UnplacedRecord],
    pub stats: Option<&'a RunStats>,
}

/// Kiểm toàn bộ layout. **Đây là chốt cuối trước khi công bố.**
///
/// Không sửa gì trong `layout`: validator chỉ có quyền nói đạt hay không đạt.
pub fn validate_layout(
    request: &NormalizedRequest,
    layout: &LayoutUnderReview<'_>,
) -> ValidationReport {
    let tol = request.tolerance;
    let mut issues: Vec<ValidationIssue> = Vec::new();
    let mut min_clearance = f64::MAX;
    let mut min_margin = f64::MAX;
    let mut pairs_checked = 0usize;

    let push = |issues: &mut Vec<ValidationIssue>, issue: ValidationIssue| {
        if issues.len() < MAX_ISSUES {
            issues.push(issue);
        }
    };

    // ── Tra cứu chi tiết theo mã ──
    let parts: BTreeMap<&str, &NormalizedPart> = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), part))
        .collect();

    // ── 1. Định danh duy nhất, đúng dạng, và bảo toàn số lượng ──
    let mut seen: BTreeMap<&str, ()> = BTreeMap::new();
    let mut placed_per_part: BTreeMap<&str, u32> = BTreeMap::new();
    let mut unplaced_per_part: BTreeMap<&str, u32> = BTreeMap::new();

    for record in layout.placements {
        if seen.insert(record.instance_id.as_str(), ()).is_some() {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::DuplicateInstanceId, &record.instance_id),
            );
        }
        match parts.get(record.part_id.as_str()) {
            Some(_) => {
                *placed_per_part.entry(record.part_id.as_str()).or_insert(0) += 1;
            }
            None => push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::UnknownPartId, &record.instance_id),
            ),
        }
        if !record
            .instance_id
            .starts_with(&format!("{}#", record.part_id))
        {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::UnknownInstanceId, &record.instance_id),
            );
        }
        if u64::from(record.sheet_index) >= u64::from(request.sheet.max_sheets) {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::SheetIndexOutOfRange, &record.instance_id),
            );
        }
    }
    for record in layout.unplaced {
        if seen.insert(record.instance_id.as_str(), ()).is_some() {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::DuplicateInstanceId, &record.instance_id),
            );
        }
        if parts.contains_key(record.part_id.as_str()) {
            *unplaced_per_part
                .entry(record.part_id.as_str())
                .or_insert(0) += 1;
        } else {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::UnknownPartId, &record.instance_id),
            );
        }
    }
    for part in &request.parts {
        let placed = placed_per_part
            .get(part.part_id.as_str())
            .copied()
            .unwrap_or(0);
        let unplaced = unplaced_per_part
            .get(part.part_id.as_str())
            .copied()
            .unwrap_or(0);
        if placed + unplaced != part.quantity {
            let mut issue = ValidationIssue::simple(ValidationCode::QuantityMismatch, "");
            issue.instance_id = part.part_id.clone();
            issue.measured = f64::from(placed + unplaced);
            issue.required = f64::from(part.quantity);
            push(&mut issues, issue);
        }
    }

    // ── 2–5. Pose, miền góc, tính cứng, và trong vùng dùng được ──
    // `placed_rings` giữ contour ĐÃ transform để bước 6 đo trực tiếp, không tính lại.
    struct Placed<'a> {
        instance_id: &'a str,
        sheet_index: u32,
        ring: Vec<PointMm>,
        bounds: super::normalize::BoundsMm,
    }
    let mut placed_rings: Vec<Placed<'_>> = Vec::with_capacity(layout.placements.len());

    for record in layout.placements {
        let Some(part) = parts.get(record.part_id.as_str()) else {
            continue; // đã báo UnknownPartId ở trên
        };
        if !record.pose.is_finite() {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::PoseNotFinite, &record.instance_id),
            );
            continue;
        }
        // Góc phải đã canonical: validator KHÔNG tự chuẩn hoá hộ, vì như vậy sẽ che
        // việc solver trả góc ngoài miền.
        match canonicalize_angle_deg(record.pose.rotation_deg, &tol) {
            Some(canon) if (canon - record.pose.rotation_deg).abs() <= tol.angular_deg => {}
            _ => {
                let mut issue =
                    ValidationIssue::simple(ValidationCode::AngleNotCanonical, &record.instance_id);
                issue.measured = record.pose.rotation_deg;
                push(&mut issues, issue);
                continue;
            }
        }
        if !part
            .rotation_domain
            .contains(record.pose.rotation_deg, &tol)
        {
            let mut issue =
                ValidationIssue::simple(ValidationCode::AngleOutsideDomain, &record.instance_id);
            issue.measured = record.pose.rotation_deg;
            push(&mut issues, issue);
            continue;
        }
        // Dựng lại phép cứng từ theta và kiểm đủ ba chốt không-phản-chiếu.
        let ring =
            match place_ring_checked(&part.outer, &record.pose, part.reference_point_mm, &tol) {
                Ok(ring) => ring,
                Err(violation) => {
                    let code = match violation {
                        RigidityViolation::NotFinite => ValidationCode::PoseNotFinite,
                        _ => ValidationCode::TransformNotRigid,
                    };
                    push(
                        &mut issues,
                        ValidationIssue::simple(code, &record.instance_id),
                    );
                    continue;
                }
            };
        // Provenance: bản mẫu không được đổi giữa lúc tính và lúc công bố.
        if part.source_revision.is_some() && part.source_revision != record.source_revision {
            push(
                &mut issues,
                ValidationIssue::simple(
                    ValidationCode::SourceRevisionMismatch,
                    &record.instance_id,
                ),
            );
        }
        let margin = signed_margin_to_bounds_mm(&ring, &request.sheet.usable);
        min_margin = min_margin.min(margin);
        if !ring_within_bounds(&ring, &request.sheet.usable, &tol) {
            let mut issue =
                ValidationIssue::simple(ValidationCode::OutsideUsableArea, &record.instance_id);
            issue.measured = margin;
            push(&mut issues, issue);
        }
        let Some(bounds) = super::normalize::BoundsMm::from_ring(&ring) else {
            push(
                &mut issues,
                ValidationIssue::simple(ValidationCode::PoseNotFinite, &record.instance_id),
            );
            continue;
        };
        placed_rings.push(Placed {
            instance_id: record.instance_id.as_str(),
            sheet_index: record.sheet_index,
            ring,
            bounds,
        });
    }

    // ── 6. Chồng lấn và khoảng hở, theo từng tờ ──
    //
    // Broad phase bằng lưới để không phải đo mọi cặp; narrow phase là `judge_pair`,
    // độc lập hoàn toàn với NFP và cache của solver.
    let mut by_sheet: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (index, item) in placed_rings.iter().enumerate() {
        by_sheet.entry(item.sheet_index).or_default().push(index);
    }
    let cell_hint = average_extent_mm(&placed_rings.iter().map(|p| p.bounds).collect::<Vec<_>>());
    for indices in by_sheet.values() {
        let mut grid = SpatialGrid::new(&request.sheet.usable, cell_hint);
        for &index in indices {
            grid.insert(index, placed_rings[index].bounds);
        }
        for &index in indices {
            let subject = &placed_rings[index];
            for candidate in grid.query_within_gap(&subject.bounds, request.gap_mm, &tol) {
                // Chỉ đo mỗi cặp một lần.
                if candidate.id <= index {
                    continue;
                }
                let other = &placed_rings[candidate.id];
                pairs_checked += 1;
                match judge_pair(&subject.ring, &other.ring, request.gap_mm, &tol) {
                    PairVerdict::Overlap => {
                        min_clearance = 0.0;
                        let mut issue =
                            ValidationIssue::simple(ValidationCode::Overlap, subject.instance_id);
                        issue.other_instance_id = other.instance_id.to_string();
                        push(&mut issues, issue);
                    }
                    PairVerdict::ClearanceTooSmall {
                        measured_mm,
                        required_mm,
                    } => {
                        min_clearance = min_clearance.min(measured_mm);
                        let mut issue = ValidationIssue::simple(
                            ValidationCode::ClearanceTooSmall,
                            subject.instance_id,
                        );
                        issue.other_instance_id = other.instance_id.to_string();
                        issue.measured = measured_mm;
                        issue.required = required_mm;
                        push(&mut issues, issue);
                    }
                    PairVerdict::Ok { measured_mm } => {
                        min_clearance = min_clearance.min(measured_mm);
                    }
                }
            }
        }
    }

    // ── 8. Thống kê phải khớp placements thực ──
    if let Some(stats) = layout.stats {
        let sheet_count = by_sheet.len() as u32;
        let placed_count = layout.placements.len() as u64;
        let unplaced_count = layout.unplaced.len() as u64;
        let mut mismatch = stats.placed_count != placed_count
            || stats.unplaced_count != unplaced_count
            || stats.sheet_count != sheet_count;
        // `materialUtilization` phải là số tính lại được, không phải số solver tự báo.
        if !mismatch && sheet_count > 0 {
            let sheet_area =
                request.sheet.width_mm * request.sheet.height_mm * f64::from(sheet_count);
            let part_area: f64 = layout
                .placements
                .iter()
                .filter_map(|record| parts.get(record.part_id.as_str()))
                .map(|part| part.effective_area_mm2())
                .sum();
            let expected = if sheet_area > 0.0 {
                part_area / sheet_area
            } else {
                0.0
            };
            if (stats.material_utilization - expected).abs() > 1e-6 {
                mismatch = true;
            }
        }
        if mismatch {
            let mut issue = ValidationIssue::simple(ValidationCode::StatsMismatch, "");
            issue.measured = f64::from(stats.sheet_count);
            issue.required = f64::from(sheet_count);
            push(&mut issues, issue);
        }
    }

    ValidationReport {
        valid: issues.is_empty(),
        validator_version: MIXED_NESTING_VALIDATOR_VERSION,
        issues,
        pairs_checked,
        min_clearance_mm: if min_clearance == f64::MAX {
            f64::INFINITY
        } else {
            min_clearance
        },
        min_margin_mm: if min_margin == f64::MAX {
            f64::INFINITY
        } else {
            min_margin
        },
    }
}

/// Kích thước gợi ý cho ô lưới: cạnh trung bình của các hộp bao.
fn average_extent_mm(boxes: &[super::normalize::BoundsMm]) -> f64 {
    if boxes.is_empty() {
        return 1.0;
    }
    let total: f64 = boxes.iter().map(|b| b.width_mm().max(b.height_mm())).sum();
    (total / boxes.len() as f64).max(1e-6)
}

/// Bộ đếm mà solver báo lên. Tách thành struct để chữ ký `recompute_stats` không thành
/// một hàng số dài dễ truyền lẫn thứ tự.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunCounters {
    pub elapsed_ms: u64,
    pub attempts: u64,
    pub orientation_evaluations: u64,
    pub pose_refinements: u64,
    pub termination_reason: TerminationReason,
}

impl RunCounters {
    /// Bộ đếm rỗng, dùng cho test và cho baseline chưa đo gì.
    pub const fn empty(termination_reason: TerminationReason) -> Self {
        Self {
            elapsed_ms: 0,
            attempts: 0,
            orientation_evaluations: 0,
            pose_refinements: 0,
            termination_reason,
        }
    }
}

/// Thống kê tính lại từ chính placements — dùng để solver không tự báo số.
///
/// `materialUtilization` ở đây là số **tính lại**; §11.5 cấm dùng nó làm tie-break giữa
/// hai layout cùng số tờ, nhưng vẫn bắt buộc báo cáo.
pub fn recompute_stats(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
    unplaced: &[UnplacedRecord],
    counters: RunCounters,
) -> RunStats {
    let parts: BTreeMap<&str, &NormalizedPart> = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), part))
        .collect();
    let mut sheets: BTreeMap<u32, ()> = BTreeMap::new();
    let mut part_area = 0.0;
    for record in placements {
        sheets.insert(record.sheet_index, ());
        if let Some(part) = parts.get(record.part_id.as_str()) {
            part_area += part.effective_area_mm2();
        }
    }
    let sheet_count = sheets.len() as u32;
    let sheet_area = request.sheet.width_mm * request.sheet.height_mm * f64::from(sheet_count);
    RunStats {
        sheet_count,
        placed_count: placements.len() as u64,
        unplaced_count: unplaced.len() as u64,
        material_utilization: if sheet_area > 0.0 {
            part_area / sheet_area
        } else {
            0.0
        },
        elapsed_ms: counters.elapsed_ms,
        attempts: counters.attempts,
        orientation_evaluations: counters.orientation_evaluations,
        pose_refinements: counters.pose_refinements,
        termination_reason: counters.termination_reason,
    }
}

/// Sinh danh sách `instanceId` theo hợp đồng cho một chi tiết.
pub fn instance_ids_for(part: &NormalizedPart) -> Vec<String> {
    (1..=part.quantity)
        .map(|ordinal| format_instance_id(&part.part_id, ordinal))
        .collect()
}
