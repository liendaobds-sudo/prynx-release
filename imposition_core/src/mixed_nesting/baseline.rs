//! Phương án nền an toàn (P3a).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.1.
//!
//! ## Vai trò: sàn an toàn, không phải đối thủ
//!
//! Baseline dùng chiến lược đơn giản, **deterministic** và **constraint-safe**. Nó tồn tại
//! để bảo đảm bốn điều:
//!
//! 1. Smart solver không được dùng nhiều tờ hơn baseline khi cùng tập chi tiết được đặt.
//! 2. Nếu kết quả smart invalid hoặc tệ hơn theo điểm chuẩn, công bố baseline **đã validate**.
//! 3. Baseline cũng phải qua final validator độc lập — không có ngoại lệ.
//! 4. Người dùng luôn có một phương án dùng được, kể cả khi hết ngân sách tìm kiếm.
//!
//! ## Baseline KHÔNG định nghĩa miền xoay của engine
//!
//! §11.1 ghi rõ: "Baseline cardinal có thể dùng để đo lợi ích free-angle, nhưng không được
//! âm thầm trở thành fallback duy nhất cho mọi profile."
//!
//! Vì vậy chính sách góc của baseline là một tham số **tường minh**
//! ([`BaselineAnglePolicy`]), không phải hằng số ẩn. Mặc định
//! [`BaselineAnglePolicy::FirstAllowed`] lấy góc đầu tiên trong miền hợp lệ của **chính
//! chi tiết đó** — với `free` là `0°`. Đó là lựa chọn của *baseline*, và nó không thu hẹp
//! miền hợp lệ mà solver được dùng.
//!
//! ## Tịnh tiến vẫn liên tục
//!
//! Vị trí không lấy từ lưới. Ứng viên là **đỉnh của miền vị trí hợp lệ**
//! `IFP \ ∪NFP` — tức các điểm tiếp xúc thật, toạ độ số thực. Baseline chọn đỉnh
//! Bottom-Left nhất rồi **hậu kiểm bằng contour thật** qua [`super::collision`].

use super::collision::{judge_pair, ring_within_bounds};
use super::control::{Interrupt, RunControl};
use super::model::{
    format_instance_id, PlacementRecord, PointMm, Pose, UnplacedReason, UnplacedRecord,
};
use super::nfp::{feasible_region, NfpError};
use super::normalize::{NormalizedPart, NormalizedRequest};
use super::orientation::RotationDomain;
use super::score::bottom_left_order;
use super::transform::place_ring_checked;

/// Version của chiến lược baseline. Đổi chiến lược là đổi sàn an toàn.
pub const BASELINE_VERSION: u32 = 1;

/// Số đỉnh miền hợp lệ thử tối đa cho mỗi (chi tiết, góc, tờ).
///
/// Đỉnh đã sắp theo Bottom-Left nên đỉnh đầu gần như luôn dùng được; trần này chỉ để
/// không quét vô hạn khi miền có hàng nghìn đỉnh do contour phức tạp.
pub const MAX_CANDIDATES_PER_ANGLE: usize = 64;

/// Chính sách chọn góc của baseline. **Tường minh**, không phải hằng số ẩn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BaselineAnglePolicy {
    /// Góc đầu tiên trong miền hợp lệ của chi tiết. `free` ⇒ `0°`.
    #[default]
    FirstAllowed,
    /// Bốn góc cardinal, lọc theo miền hợp lệ.
    ///
    /// Chỉ dùng để **đo lợi ích của free-angle** trong benchmark. Không được đặt làm
    /// mặc định cho đường sản xuất.
    CardinalForBenchmark,
}

/// Kết quả một lần chạy baseline.
#[derive(Debug, Clone, PartialEq)]
pub struct BaselineOutcome {
    pub placements: Vec<PlacementRecord>,
    pub unplaced: Vec<UnplacedRecord>,
    /// Số tờ đã mở.
    pub sheet_count: u32,
    /// Số lần thử đặt (mỗi cặp góc × đỉnh ứng viên tính một lần).
    pub attempts: u64,
    /// Số lần đánh giá hướng.
    pub orientation_evaluations: u64,
    pub baseline_version: u32,
}

/// Lỗi khi chạy baseline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BaselineError {
    /// Bị hủy hoặc hết ngân sách tại checkpoint.
    Interrupted(Interrupt),
    /// Hình học không dựng được vùng lồng ghép.
    Nfp(NfpError),
}

impl From<Interrupt> for BaselineError {
    fn from(value: Interrupt) -> Self {
        Self::Interrupted(value)
    }
}
impl From<NfpError> for BaselineError {
    fn from(value: NfpError) -> Self {
        Self::Nfp(value)
    }
}

/// Một con cần xếp, đã sắp theo thứ tự xác định.
struct Instance<'a> {
    part: &'a NormalizedPart,
    instance_id: String,
}

/// Contour của một chi tiết trong hệ local, đã xoay quanh điểm tham chiếu.
///
/// `place_ring_checked` với tịnh tiến `(0,0)` cho `R(theta)·(O − P)` — đúng dạng mà
/// [`feasible_region`] cần, vì ở đó điểm tham chiếu nằm tại gốc.
fn local_ring_at(
    part: &NormalizedPart,
    angle_deg: f64,
    tol: &super::model::Tolerance,
) -> Option<Vec<PointMm>> {
    place_ring_checked(
        &part.outer,
        &Pose::new(angle_deg, 0.0, 0.0),
        part.reference_point_mm,
        tol,
    )
    .ok()
}

/// Danh sách góc mà baseline sẽ thử cho một chi tiết, theo chính sách đã chọn.
///
/// Luôn lọc qua miền hợp lệ của chi tiết: baseline **không được** đặt một góc mà người
/// dùng đã cấm, dù chính sách có gợi ý góc đó.
pub fn baseline_angles(
    domain: &RotationDomain,
    policy: BaselineAnglePolicy,
    tol: &super::model::Tolerance,
) -> Vec<f64> {
    match policy {
        BaselineAnglePolicy::FirstAllowed => match domain {
            RotationDomain::Full => vec![0.0],
            RotationDomain::Discrete(angles) => angles.first().copied().into_iter().collect(),
            RotationDomain::Arcs(arcs) => {
                arcs.first().map(|arc| arc.start_deg).into_iter().collect()
            }
        },
        BaselineAnglePolicy::CardinalForBenchmark => [0.0, 90.0, 180.0, 270.0]
            .into_iter()
            .filter(|angle| domain.contains(*angle, tol))
            .collect(),
    }
}

/// Chạy baseline. Kết quả **chưa** được công bố: nơi gọi phải cho qua
/// [`super::validator::validate_layout`] trước.
///
/// Thứ tự xử lý là xác định: chi tiết lớn trước (diện tích giảm dần), tie-break theo
/// `partId` rồi số thứ tự. Không có randomness, không đọc đồng hồ.
pub fn run_baseline(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
) -> Result<BaselineOutcome, BaselineError> {
    let tol = request.tolerance;

    // ── Thứ tự xác định: diện tích giảm dần, rồi partId, rồi số thứ tự ──
    let mut order: Vec<&NormalizedPart> = request.parts.iter().collect();
    order.sort_by(|a, b| {
        b.effective_area_mm2()
            .partial_cmp(&a.effective_area_mm2())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.part_id.cmp(&b.part_id))
    });
    let mut instances: Vec<Instance<'_>> = Vec::new();
    for part in order {
        for ordinal in 1..=part.quantity {
            instances.push(Instance {
                part,
                instance_id: format_instance_id(&part.part_id, ordinal),
            });
        }
    }

    let mut placements: Vec<PlacementRecord> = Vec::new();
    let mut unplaced: Vec<UnplacedRecord> = Vec::new();
    // Contour đã đặt, theo từng tờ — nguồn dữ liệu cho NFP và cho hậu kiểm.
    let mut sheets: Vec<Vec<Vec<PointMm>>> = Vec::new();
    let mut attempts: u64 = 0;
    let mut orientation_evaluations: u64 = 0;

    for instance in &instances {
        control.checkpoint()?;
        let angles = baseline_angles(&instance.part.rotation_domain, policy, &tol);
        let mut placed = false;

        // Thử các tờ đã mở trước, rồi mới mở tờ mới — đó là điều làm baseline không
        // bao giờ dùng nhiều tờ hơn cần thiết một cách vô lý.
        let sheet_limit = (sheets.len() + 1).min(request.sheet.max_sheets as usize);
        'sheet: for sheet_index in 0..sheet_limit {
            for angle in &angles {
                control.checkpoint()?;
                orientation_evaluations += 1;
                let Some(local) = local_ring_at(instance.part, *angle, &tol) else {
                    continue;
                };
                let existing: &[Vec<PointMm>] =
                    sheets.get(sheet_index).map_or(&[], |v| v.as_slice());
                let region = feasible_region(
                    &request.sheet.usable,
                    existing,
                    &local,
                    request.gap_mm,
                    &tol,
                )?;
                if region.is_empty() {
                    continue;
                }
                // Ứng viên là ĐỈNH của miền hợp lệ — điểm tiếp xúc thật, toạ độ số thực.
                let mut candidates = super::nfp::region_vertices(&region);
                candidates.sort_by(|a, b| bottom_left_order(*a, *b));
                candidates.dedup_by(|a, b| {
                    (a.x - b.x).abs() <= tol.linear_mm && (a.y - b.y).abs() <= tol.linear_mm
                });

                for candidate in candidates.iter().take(MAX_CANDIDATES_PER_ANGLE) {
                    attempts += 1;
                    let pose = Pose::new(*angle, candidate.x, candidate.y);
                    let Ok(ring) = place_ring_checked(
                        &instance.part.outer,
                        &pose,
                        instance.part.reference_point_mm,
                        &tol,
                    ) else {
                        continue;
                    };
                    // Hậu kiểm bằng contour THẬT, không tin miền hợp lệ.
                    if !ring_within_bounds(&ring, &request.sheet.usable, &tol) {
                        continue;
                    }
                    let clash = existing
                        .iter()
                        .any(|other| !judge_pair(&ring, other, request.gap_mm, &tol).is_ok());
                    if clash {
                        continue;
                    }
                    while sheets.len() <= sheet_index {
                        sheets.push(Vec::new());
                    }
                    sheets[sheet_index].push(ring);
                    placements.push(PlacementRecord {
                        instance_id: instance.instance_id.clone(),
                        part_id: instance.part.part_id.clone(),
                        sheet_index: sheet_index as u32,
                        pose,
                        source_revision: instance.part.source_revision.clone(),
                    });
                    placed = true;
                    break 'sheet;
                }
            }
        }

        if !placed {
            // Phân biệt hai lý do khác nhau hẳn về nghiệp vụ: hình học không vừa, và
            // đã chạm trần số tờ. §11.4 cấm báo lẫn hai lý do này.
            let fits_empty_sheet = angles.iter().any(|angle| {
                local_ring_at(instance.part, *angle, &tol)
                    .and_then(|local| {
                        super::nfp::inner_fit_rect(&request.sheet.usable, &local, &tol)
                    })
                    .is_some()
            });
            let reason = if !fits_empty_sheet {
                UnplacedReason::NoFeasiblePose
            } else if sheets.len() >= request.sheet.max_sheets as usize {
                UnplacedReason::MaxSheetsReached
            } else {
                UnplacedReason::NoFeasiblePose
            };
            unplaced.push(UnplacedRecord {
                instance_id: instance.instance_id.clone(),
                part_id: instance.part.part_id.clone(),
                reason,
            });
        }
    }

    Ok(BaselineOutcome {
        placements,
        unplaced,
        sheet_count: sheets.len() as u32,
        attempts,
        orientation_evaluations,
        baseline_version: BASELINE_VERSION,
    })
}
