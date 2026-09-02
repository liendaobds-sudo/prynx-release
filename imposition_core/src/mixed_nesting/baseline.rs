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

use std::collections::BTreeMap;

use super::candidates::candidate_angles;
use super::collision::{bounds_may_touch, judge_pair, judge_pair_sheet_axis, ring_within_bounds};
use super::control::{derive_trial_seed, Interrupt, NfpTelemetryPhase, RunControl, SearchEffort};
use super::model::{
    canonicalize_angle_deg, format_instance_id, LayoutAlignment, PlacementRecord, PointMm, Pose,
    Profile, Tolerance, UnplacedReason, UnplacedRecord, MAX_INSTANCES_TOTAL,
};
use super::nfp::{
    feasible_region_after, feasible_region_after_with_clearance, feasible_region_cached,
    feasible_region_cached_with_clearance, NfpClearance, NfpError, RegionMm,
};
use super::nfp_cache::NfpCache;
use super::normalize::{BoundsMm, NormalizedPart, NormalizedRequest};
use super::orientation::{circular_distance_deg, RotationDomain};
use super::score::{bottom_left_order, score_layout, LayoutScore};
use super::spatial::SpatialGrid;
use super::transform::place_ring_checked;

/// Version của chiến lược baseline. Đổi chiến lược là đổi sàn an toàn.
pub const BASELINE_VERSION: u32 = 12;

/// Số đỉnh miền hợp lệ thử tối đa cho mỗi (chi tiết, góc, tờ).
///
/// Đỉnh đã sắp theo Bottom-Left nên đỉnh đầu gần như luôn dùng được; trần này chỉ để
/// không quét vô hạn khi miền có hàng nghìn đỉnh do contour phức tạp.
pub const MAX_CANDIDATES_PER_ANGLE: usize = 64;

/// Baseline chỉ mở rộng miền góc khi bootstrap design còn thiếu trong autofill.
///
/// Đây là sàn rẻ, không phải phép chứng minh một design vô nghiệm. Nếu tập hữu hạn này
/// chưa tìm được pose, `multi_start` sẽ không công bố baseline thiếu design và cho smart
/// trial rescue bằng ngân sách/profile đầy đủ.
const MAX_AUTOFILL_BOOTSTRAP_ANGLES: usize = 16;

/// Ba hướng cardinal khác 0° cho probe hậu baseline.
///
/// PERF (audit 2026-08-29 §ROTATION-WARM-START): đây là prefix cố định của một
/// portfolio, không phải hard-cap worker/RAM/chất lượng theo phần cứng. Probe chỉ mua
/// tối đa ba hướng × năm anchor bbox với hậu kiểm va chạm trực tiếp; smart trial phía
/// sau vẫn giữ nguyên toàn bộ profile trên máy mạnh.
const ROTATION_PROBE_ANGLES_DEG: [f64; 3] = [90.0, 180.0, 270.0];

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
    /// Candidate đã được dựng bằng basis/motif tuần hoàn và phải được giữ nguyên khi
    /// qua các bước hậu tối ưu; không được xoay hoặc dịch riêng một cell.
    pub periodic_motif: bool,
    pub baseline_version: u32,
}

/// Candidate xoay rẻ, dựng từ một baseline autofill đã hoàn tất.
///
/// Candidate giữ nguyên instance/count và chỉ thay pose của đúng một placement. Nơi gọi
/// vẫn phải validate độc lập trước khi cho nó tranh điểm với baseline.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RotationProbeOutcome {
    pub placements: Option<Vec<PlacementRecord>>,
    /// Điểm đã tính cùng candidate, tránh dựng lại toàn bộ contour sau validator.
    pub score: Option<LayoutScore>,
    pub attempts: u64,
    pub orientation_evaluations: u64,
    /// Số lần thật sự dựng bbox local khi sàng target; cache hit không tính.
    pub screen_bounds_evaluations: u64,
}

/// Lỗi khi chạy baseline.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BaselineError {
    /// Người dùng hủy tại checkpoint.
    ///
    /// [LO0-5 FIX 2026-08-27] Baseline chỉ dùng checkpoint hủy; deadline/work budget
    /// không thể đi vào variant này. Hủy vẫn là lỗi vì không được tạo final manifest.
    Interrupted(Interrupt),
    /// Hình học không dựng được vùng lồng ghép.
    Nfp(NfpError),
    /// Autofill có thể đặt con thứ `MAX_INSTANCES_TOTAL + 1` dù contract diện tích đã đạt.
    ///
    /// [CHẶNG-A LÔ 2A 2026-08-27] Đây là lỗi invariant của engine/protocol, không phải
    /// `sheet_full`, deadline, work budget hay lỗi NFP.
    CapacityInvariantExceeded,
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

fn fixed_obstacle_rings(request: &NormalizedRequest) -> Vec<Vec<PointMm>> {
    request
        .fixed_obstacles()
        .iter()
        .map(|obstacle| obstacle.outer.clone())
        .collect()
}

/// Clearance dùng cho blocker theo đúng provenance của contract production.
///
/// FIX/PARITY (audit 2026-08-29 §MAP-NEST-07/08): legacy giữ offset tròn Euclidean;
/// production giữ nguyên hai trục và không cho `partToObstacle` làm nhiễu part↔part.
fn blocker_clearance_for_request(
    request: &NormalizedRequest,
    is_fixed_obstacle: bool,
) -> NfpClearance {
    request.production_contract.as_ref().map_or_else(
        || NfpClearance::legacy_isotropic(request.conservative_solver_gap_mm()),
        |contract| {
            let clearance = if is_fixed_obstacle {
                contract.clearance.part_to_obstacle
            } else {
                contract.clearance.part_to_part
            };
            NfpClearance::sheet_axis(clearance)
        },
    )
}

fn part_clearance_for_request(request: &NormalizedRequest) -> NfpClearance {
    blocker_clearance_for_request(request, false)
}

/// Scalar này chỉ phục vụ broad-phase; authority vẫn là NFP/narrow-phase theo mode.
fn broad_gap_mm(clearance: NfpClearance) -> f64 {
    clearance.reach_x_mm().max(clearance.reach_y_mm())
}

fn pair_clashes_for_request(
    request: &NormalizedRequest,
    moving: &[PointMm],
    blocker: &[PointMm],
    is_fixed_obstacle: bool,
) -> bool {
    match blocker_clearance_for_request(request, is_fixed_obstacle) {
        NfpClearance::LegacyIsotropic { radius_mm } => {
            !judge_pair(moving, blocker, radius_mm, &request.tolerance).is_ok()
        }
        NfpClearance::SheetAxis(clearance) => {
            !judge_pair_sheet_axis(moving, blocker, clearance, &request.tolerance).is_ok()
        }
    }
}

/// Dựng miền hợp lệ bằng hai lớp blocker riêng; prefix luôn là fixed obstacle.
#[allow(clippy::too_many_arguments)]
fn feasible_region_for_request(
    request: &NormalizedRequest,
    placement_bounds: &BoundsMm,
    existing: &[Vec<PointMm>],
    fixed_count: usize,
    moving: &[PointMm],
    cache: &mut NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    let Some(contract) = request.production_contract.as_ref() else {
        return feasible_region_cached(
            placement_bounds,
            existing,
            moving,
            request.conservative_solver_gap_mm(),
            &request.tolerance,
            cache,
            should_stop,
        );
    };

    debug_assert!(fixed_count <= existing.len());
    let (fixed_obstacles, placed_parts) = existing.split_at(fixed_count);
    let Some(base) = feasible_region_cached_with_clearance(
        placement_bounds,
        fixed_obstacles,
        moving,
        NfpClearance::sheet_axis(contract.clearance.part_to_obstacle),
        &request.tolerance,
        cache,
        should_stop,
    )?
    else {
        return Ok(None);
    };
    feasible_region_after_with_clearance(
        base,
        placed_parts,
        moving,
        NfpClearance::sheet_axis(contract.clearance.part_to_part),
        &request.tolerance,
        cache,
        should_stop,
    )
}

/// Cập nhật cache autofill: mọi blocker mới sau prefix đều là part đã đặt.
fn feasible_region_after_parts_for_request(
    request: &NormalizedRequest,
    base: RegionMm,
    new_parts: &[Vec<PointMm>],
    moving: &[PointMm],
    cache: &mut NfpCache,
    should_stop: Option<&dyn Fn() -> bool>,
) -> Result<Option<RegionMm>, NfpError> {
    let Some(contract) = request.production_contract.as_ref() else {
        return feasible_region_after(
            base,
            new_parts,
            moving,
            request.conservative_solver_gap_mm(),
            &request.tolerance,
            cache,
            should_stop,
        );
    };
    feasible_region_after_with_clearance(
        base,
        new_parts,
        moving,
        NfpClearance::sheet_axis(contract.clearance.part_to_part),
        &request.tolerance,
        cache,
        should_stop,
    )
}

/// Kiểm một contour đã đặt bằng đúng narrow-phase và clearance của final validator.
///
/// PERF (audit 2026-08-29 §SR-PREVIEW-1): bbox đã có sẵn chỉ làm broad-phase bảo thủ;
/// candidate gần vật cản vẫn bắt buộc qua contour CUT và phán quyết sheet-axis chính xác.
fn violates_fixed_obstacle_contract(
    request: &NormalizedRequest,
    ring: &[PointMm],
    bounds: &BoundsMm,
) -> bool {
    let Some(contract) = request.production_contract.as_ref() else {
        return false;
    };
    let clearance = contract.clearance.part_to_obstacle;
    let broad_margin = clearance.x_mm.hypot(clearance.y_mm);
    let widened = BoundsMm {
        min_x: bounds.min_x - broad_margin,
        min_y: bounds.min_y - broad_margin,
        max_x: bounds.max_x + broad_margin,
        max_y: bounds.max_y + broad_margin,
    };
    contract.fixed_obstacles.iter().any(|obstacle| {
        bounds_may_touch(&widened, &obstacle.bounds, &request.tolerance)
            && !judge_pair_sheet_axis(ring, &obstacle.outer, clearance, &request.tolerance).is_ok()
    })
}

/// Năm cách giữ một bbox xoay bám vào bbox cũ: hai góc cùng phía, tâm và hai góc chéo.
/// Đây chỉ là tập ứng viên hữu hạn cho probe rẻ, không phải lưới tìm kiếm.
fn rotation_probe_bbox_anchors(angle_deg: f64, target: BoundsMm, local: BoundsMm) -> [Pose; 5] {
    let target_center = target.center();
    let local_center = local.center();
    [
        Pose::new(
            angle_deg,
            target.min_x - local.min_x,
            target.min_y - local.min_y,
        ),
        Pose::new(
            angle_deg,
            target.max_x - local.max_x,
            target.max_y - local.max_y,
        ),
        Pose::new(
            angle_deg,
            target_center.x - local_center.x,
            target_center.y - local_center.y,
        ),
        Pose::new(
            angle_deg,
            target.max_x - local.max_x,
            target.min_y - local.min_y,
        ),
        Pose::new(
            angle_deg,
            target.min_x - local.min_x,
            target.max_y - local.max_y,
        ),
    ]
}

fn union_bounds(left: BoundsMm, right: BoundsMm) -> BoundsMm {
    BoundsMm {
        min_x: left.min_x.min(right.min_x),
        min_y: left.min_y.min(right.min_y),
        max_x: left.max_x.max(right.max_x),
        max_y: left.max_y.max(right.max_y),
    }
}

fn translated_bounds(local: BoundsMm, pose: &Pose) -> BoundsMm {
    BoundsMm {
        min_x: local.min_x + pose.translate_x_mm,
        min_y: local.min_y + pose.translate_y_mm,
        max_x: local.max_x + pose.translate_x_mm,
        max_y: local.max_y + pose.translate_y_mm,
    }
}

fn fits_blank_sheet_with_obstacles(
    request: &NormalizedRequest,
    part: &NormalizedPart,
    angles: &[f64],
    obstacles: &[Vec<PointMm>],
) -> Result<bool, NfpError> {
    let placement_bounds = request.placement_bounds_for(part);
    let mut cache = NfpCache::new();
    for angle in angles {
        let Some(local) = local_ring_at(part, *angle, &request.tolerance) else {
            continue;
        };
        let Some(region) = feasible_region_for_request(
            request,
            &placement_bounds,
            obstacles,
            obstacles.len(),
            &local,
            &mut cache,
            None,
        )?
        else {
            continue;
        };
        if !region.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Bốn góc cardinal — tập dự phòng thực dụng khi miền góc là liên tục.
const CARDINAL_FALLBACK_DEG: [f64; 4] = [0.0, 90.0, 180.0, 270.0];

/// Góc của baseline, **kèm góc dự phòng** dùng khi góc đầu không đặt được.
///
/// FIX (audit 2026-08-28 §NEST-BASELINE-ROTATE-ON-FAIL). Chủ dự án báo: "tem nào cũng giữ
/// nguyên hướng gốc". Truy ra đúng chỗ này.
///
/// [`baseline_angles`] với [`BaselineAnglePolicy::FirstAllowed`] trả **đúng một** góc — góc
/// đầu tiên của miền, tức 0° với miền cardinal `[0,90,180,270]` mà đường production dùng.
/// Bộ tối ưu là thứ duy nhất thử 90/180/270, nhưng nó chưa bao giờ hoàn tất nổi một lượt
/// (đắt gấp ~12 lần baseline — xem `BAO_CAO_NEST_BASELINE_UNBOUNDED_2026-08-28.md`), nên
/// phương án công bố **luôn** là baseline ⇒ mọi con nằm ở 0°.
///
/// Bản vá nối thêm phần còn lại của miền vào **cuối** danh sách. Vòng lặp đặt chi tiết
/// `break 'sheet` ngay khi đặt được, nên:
///
/// - Con vừa ở 0° ⇒ **không tốn thêm một lần NFP nào**. Đây là điều làm bản vá này rẻ.
/// - Con không vừa ở 0° ⇒ thử xoay **trên chính tờ đang mở** trước khi mở tờ mới, vì vòng
///   tờ là vòng ngoài. Đó vừa là chỗ có thêm con, vừa là chỗ tiết kiệm tờ.
///
/// `CardinalForBenchmark` giữ nguyên: nó vốn đã trả cả bốn góc, và thêm dự phòng vào đó sẽ
/// làm hỏng đúng cái sàn an toàn mà benchmark dùng để đo lợi ích free-angle.
///
/// Tập dự phòng **chỉ** là cardinal, không phải cả miền — xem lý do trong thân hàm.
pub fn baseline_angles_with_fallback(
    domain: &RotationDomain,
    policy: BaselineAnglePolicy,
    tol: &super::model::Tolerance,
) -> Vec<f64> {
    let mut angles = baseline_angles(domain, policy, tol);
    if policy != BaselineAnglePolicy::FirstAllowed {
        return angles;
    }

    // Tập dự phòng **chỉ** là bốn góc cardinal, lọc qua miền hợp lệ. Hai lý do, cả hai đã
    // trả giá:
    //
    // 1. **Bị chặn trên.** Miền `Discrete` do người dùng khai có thể tới hàng chục góc, mà
    //    baseline cố ý không có deadline — thử hết là tự làm chậm đúng chỗ đang bị phàn nàn.
    //    Bốn góc là trần cứng, không phụ thuộc người dùng khai bao nhiêu.
    // 2. **Giữ đúng vai của baseline là "sàn RẺ, có thể bỏ lỡ".** Bộ tối ưu mới là chỗ quét
    //    hết miền góc. Cho baseline quét hết miền `Discrete` làm đổ tiền đề của
    //    `autofill_smart_rescue_design_ngoai_tap_goc_baseline` — test đó dựng một nan chỉ
    //    vừa ở 60°, tức đúng ca "baseline bỏ lỡ, smart rescue phải gánh". Xoá được ca đó
    //    nghĩa là xoá luôn đường rescue khỏi phạm vi test.
    //
    // Với đường production (miền cardinal `[0,90,180,270]`) thì trần này **không cắt gì**:
    // dự phòng đúng bằng cả miền.
    for proposed in CARDINAL_FALLBACK_DEG {
        let Some(angle) = canonicalize_angle_deg(proposed, tol) else {
            continue;
        };
        if !domain.contains(angle, tol)
            || angles
                .iter()
                .any(|kept| circular_distance_deg(*kept, angle) <= tol.angular_deg)
        {
            continue;
        }
        angles.push(angle);
    }
    angles
}

/// Góc bootstrap deterministic cho một design chưa có placement trong autofill.
///
/// [CHẶNG-A LÔ 2B 2026-08-27] Baseline vẫn rẻ sau khi đã có đủ design. Riêng lần
/// đầu của mỗi design, thêm một tập nhỏ từ chính candidate generator free-angle và
/// bốn góc chéo phổ biến; mọi góc đều bị lọc lại qua rotation domain của part.
fn autofill_bootstrap_angles(
    request: &NormalizedRequest,
    part: &NormalizedPart,
    part_rank: usize,
    policy: BaselineAnglePolicy,
) -> Vec<f64> {
    let tol = request.tolerance;
    let mut angles = baseline_angles(&part.rotation_domain, policy, &tol);
    if policy != BaselineAnglePolicy::FirstAllowed {
        return angles;
    }

    let seed = derive_trial_seed(request.seed, part_rank as u64);
    let smart = candidate_angles(part, SearchEffort::for_profile(Profile::Fast), seed, &tol);
    for proposed in [45.0, 135.0, 225.0, 315.0].into_iter().chain(smart) {
        let Some(angle) = canonicalize_angle_deg(proposed, &tol) else {
            continue;
        };
        if !part.rotation_domain.contains(angle, &tol)
            || angles
                .iter()
                .any(|kept| circular_distance_deg(*kept, angle) <= tol.angular_deg)
        {
            continue;
        }
        angles.push(angle);
        if angles.len() >= MAX_AUTOFILL_BOOTSTRAP_ANGLES {
            break;
        }
    }
    angles
}

/// Chạy baseline. Kết quả **chưa** được công bố: nơi gọi phải cho qua
/// [`super::validator::validate_layout`] trước.
///
/// Thứ tự xử lý là xác định: chi tiết lớn trước (diện tích giảm dần), tie-break theo
/// `partId` rồi số thứ tự. Fixed-work không đọc đồng hồ; deadline mode chỉ dừng ở
/// publication barrier hợp lệ.
///
/// PERF (audit 2026-09-02 §PERF-NEST-04): quantity khai đủ ledger cho instance chưa
/// duyệt; autofill rollback về sweep hoàn chỉnh gần nhất và không dừng trước khi sweep
/// đầu tiên có đủ mọi design. Work budget trial không cắt baseline.
/// Tiền lọc broad-phase theo reach từng trục; không thay thế phán quyết contour.
///
/// PERF (audit 2026-08-30 §NEST-B7-CLASH-INDEX): nới bbox bằng đúng footprint của
/// clearance. Nếu bbox đã tách ngoài footprint thì trục X/Y tự nó là separating axis;
/// mọi cặp còn lại vẫn phải qua narrow-phase mode-aware.
fn bbox_may_clash(
    cand: &BoundsMm,
    other: &BoundsMm,
    clearance: NfpClearance,
    tol: &Tolerance,
) -> bool {
    let widened = BoundsMm {
        min_x: cand.min_x - clearance.reach_x_mm(),
        min_y: cand.min_y - clearance.reach_y_mm(),
        max_x: cand.max_x + clearance.reach_x_mm(),
        max_y: cand.max_y + clearance.reach_y_mm(),
    };
    bounds_may_touch(&widened, other, tol)
}

fn clashes_with_existing_for_request(
    request: &NormalizedRequest,
    moving: &[PointMm],
    moving_bounds: Option<BoundsMm>,
    existing: &[Vec<PointMm>],
    existing_bounds: &[Option<BoundsMm>],
    fixed_count: usize,
) -> bool {
    debug_assert_eq!(existing.len(), existing_bounds.len());
    debug_assert!(fixed_count <= existing.len());
    existing
        .iter()
        .zip(existing_bounds)
        .enumerate()
        .any(|(index, (blocker, blocker_bounds))| {
            let is_fixed_obstacle = index < fixed_count;
            let clearance = blocker_clearance_for_request(request, is_fixed_obstacle);
            if let (Some(moving_bounds), Some(blocker_bounds)) =
                (moving_bounds, blocker_bounds.as_ref())
            {
                if !bbox_may_clash(
                    &moving_bounds,
                    blocker_bounds,
                    clearance,
                    &request.tolerance,
                ) {
                    return false;
                }
            }
            pair_clashes_for_request(request, moving, blocker, is_fixed_obstacle)
        })
}

fn baseline_deadline_reached(
    control: &RunControl,
    allow_deadline: bool,
) -> Result<bool, BaselineError> {
    match control.checkpoint_deadline_only() {
        Ok(()) => Ok(false),
        Err(Interrupt::Cancelled) => Err(BaselineError::Interrupted(Interrupt::Cancelled)),
        Err(Interrupt::DeadlineReached) => Ok(allow_deadline),
        Err(Interrupt::WorkBudgetExhausted) => {
            unreachable!("checkpoint baseline không đọc work budget")
        }
    }
}

fn baseline_stop_requested(control: &RunControl, allow_deadline: bool) -> bool {
    if allow_deadline {
        control.checkpoint_deadline_only().is_err()
    } else {
        control.checkpoint_cancel_only().is_err()
    }
}

pub fn run_baseline(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
) -> Result<BaselineOutcome, BaselineError> {
    // PERF (audit 2026-08-29 §ROTATION-WARM-START): autofill tự dựng obstacle/cache
    // của nó; rẽ nhánh trước khi cấp phát để không clone và bỏ cache rỗng.
    if request.layout_intent.is_single_sheet_autofill() {
        return run_autofill_baseline(request, control, policy);
    }

    let tol = request.tolerance;
    let fixed_obstacles = fixed_obstacle_rings(request);
    let fixed_count = fixed_obstacles.len();
    // PERF (audit 2026-08-30 §NEST-B7-CLASH-INDEX): bbox tiền lọc clash, song hành obstacle.
    let fixed_bounds: Vec<Option<BoundsMm>> = fixed_obstacles
        .iter()
        .map(|r| BoundsMm::from_ring(r))
        .collect();
    // PERF (audit 2026-08-28 §NFP-CACHE): một cache cho cả lượt baseline.
    let mut nfp_cache = NfpCache::with_telemetry_and_resources(
        control.progress().clone(),
        NfpTelemetryPhase::Baseline,
        control.nfp_worker_grant(),
        control.nfp_cache_byte_budget(),
    );

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
    // bbox song hành `sheets` cho tiền lọc clash (§NEST-B7).
    let mut sheet_bounds: Vec<Vec<Option<BoundsMm>>> = Vec::new();
    let mut attempts: u64 = 0;
    let mut orientation_evaluations: u64 = 0;

    let mut deadline_from: Option<usize> = None;
    'instances: for (instance_index, instance) in instances.iter().enumerate() {
        if baseline_deadline_reached(control, true)? {
            deadline_from = Some(instance_index);
            break;
        }
        let primary = baseline_angles(&instance.part.rotation_domain, policy, &tol);
        let with_fallback =
            baseline_angles_with_fallback(&instance.part.rotation_domain, policy, &tol);
        let placement_bounds = request.placement_bounds_for(instance.part);
        let mut placed = false;

        // Thử các tờ đã mở trước, rồi mới mở tờ mới — đó là điều làm baseline không
        // bao giờ dùng nhiều tờ hơn cần thiết một cách vô lý.
        //
        // FIX (audit 2026-08-28 §NEST-BASELINE-ROTATE-ON-FAIL): góc dự phòng được thử ở
        // **lượt riêng**, không nối vào danh sách chính. Lý do là số đo:
        //
        // Bản đầu tôi chỉ nối cardinal vào cuối `angles`. Xoay xuất hiện thật
        // (`{0°: 62, 90°: 1, 180°: 2}` trên 65 con) nhưng `placedCount` **không đổi**, còn
        // thời gian autofill 13 mẫu đi từ 17,7s lên 50–66s. Trả 3× thời gian cho 0 con.
        //
        // Nguyên nhân: nối vào cuối thì mỗi con KHÔNG vừa ở 0° phải thử thêm 3 góc trên
        // **từng tờ**, mà ở cuối lượt lấp tờ thì gần như mọi con đều không vừa.
        //
        // Nên thứ tự đúng là ba lượt dưới đây: xoay chỉ được thử khi lựa chọn còn lại là
        // **mở thêm một tờ nữa**. Đó là chỗ xoay đáng tiền — tiết kiệm cả một tờ giấy — và
        // là chỗ duy nhất chi phí thêm được biện minh.
        let existing_sheets = sheets.len();
        let can_open_new = existing_sheets < request.sheet.max_sheets as usize;
        let mut plans: Vec<(usize, usize, &[f64])> = Vec::new();
        if existing_sheets > 0 {
            plans.push((0, existing_sheets, primary.as_slice()));
            if with_fallback.len() > primary.len() {
                plans.push((0, existing_sheets, &with_fallback[primary.len()..]));
            }
        }
        if can_open_new {
            // Tờ mới thì thử cả miền ngay: đã phải mở tờ thì không có gì để tiết kiệm nữa,
            // và một con chỉ vừa khi xoay vẫn phải vào được tờ trắng.
            plans.push((
                existing_sheets,
                existing_sheets + 1,
                with_fallback.as_slice(),
            ));
        }

        'plan: for (sheet_from, sheet_to, angles) in plans {
            for sheet_index in sheet_from..sheet_to {
                for angle in angles {
                    if baseline_deadline_reached(control, true)? {
                        deadline_from = Some(instance_index);
                        break 'instances;
                    }
                    orientation_evaluations += 1;
                    let Some(local) = local_ring_at(instance.part, *angle, &tol) else {
                        continue;
                    };
                    let existing: &[Vec<PointMm>] = sheets
                        .get(sheet_index)
                        .map_or(fixed_obstacles.as_slice(), |v| v.as_slice());
                    let existing_bounds: &[Option<BoundsMm>] = sheet_bounds
                        .get(sheet_index)
                        .map_or(fixed_bounds.as_slice(), |v| v.as_slice());
                    let Some(region) = feasible_region_for_request(
                        request,
                        &placement_bounds,
                        existing,
                        fixed_count,
                        &local,
                        &mut nfp_cache,
                        // Quantity có ledger đầy đủ cho phần chưa duyệt, nên deadline
                        // cooperative được phép cắt giữa difference mà vẫn công bố an toàn.
                        Some(&|| baseline_stop_requested(control, true)),
                    )?
                    else {
                        if baseline_deadline_reached(control, true)? {
                            deadline_from = Some(instance_index);
                            break 'instances;
                        }
                        continue;
                    };
                    if baseline_deadline_reached(control, true)? {
                        deadline_from = Some(instance_index);
                        break 'instances;
                    }
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
                        if baseline_deadline_reached(control, true)? {
                            deadline_from = Some(instance_index);
                            break 'instances;
                        }
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
                        if !ring_within_bounds(&ring, &placement_bounds, &tol) {
                            continue;
                        }
                        // Tiền lọc bbox trước judge_pair (§NEST-B7): cặp cách nhau quá gap
                        // chắc chắn Ok nên bỏ; kết quả `any` không đổi ⇒ byte-identical.
                        let cand_bounds = BoundsMm::from_ring(&ring);
                        let clash = clashes_with_existing_for_request(
                            request,
                            &ring,
                            cand_bounds,
                            existing,
                            existing_bounds,
                            fixed_count,
                        );
                        if clash {
                            continue;
                        }
                        while sheets.len() <= sheet_index {
                            sheets.push(fixed_obstacles.clone());
                            sheet_bounds.push(fixed_bounds.clone());
                        }
                        sheet_bounds[sheet_index].push(cand_bounds);
                        sheets[sheet_index].push(ring);
                        placements.push(PlacementRecord {
                            instance_id: instance.instance_id.clone(),
                            part_id: instance.part.part_id.clone(),
                            sheet_index: sheet_index as u32,
                            pose,
                            source_revision: instance.part.source_revision.clone(),
                        });
                        placed = true;
                        break 'plan;
                    }
                }
            }
        }

        if !placed {
            if baseline_deadline_reached(control, true)? {
                deadline_from = Some(instance_index);
                break;
            }
            // Phân biệt hai lý do khác nhau hẳn về nghiệp vụ: hình học không vừa, và
            // đã chạm trần số tờ. §11.4 cấm báo lẫn hai lý do này.
            // Dùng danh sách CÓ dự phòng: câu hỏi ở đây là "hình này có vừa tờ trắng nào
            // không", nên phải xét đủ miền góc. Trả lời `NoFeasiblePose` cho một hình chỉ
            // vừa khi xoay là nói sai với thợ.
            let fits_empty_sheet = fits_blank_sheet_with_obstacles(
                request,
                instance.part,
                &with_fallback,
                &fixed_obstacles,
            )?;
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

    if let Some(first_pending) = deadline_from {
        unplaced.extend(
            instances[first_pending..]
                .iter()
                .map(|instance| UnplacedRecord {
                    instance_id: instance.instance_id.clone(),
                    part_id: instance.part.part_id.clone(),
                    reason: UnplacedReason::SearchBudgetExhausted,
                }),
        );
    }

    Ok(BaselineOutcome {
        placements,
        unplaced,
        sheet_count: sheets.len() as u32,
        attempts,
        orientation_evaluations,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    })
}

/// Lấp đầy một tờ mà không tạo `quantity` giả.
///
/// [CHẶNG-A LÔ 2A 2026-08-27] Mỗi sweep thử đúng một instance của mỗi part. Part đang
/// có ít placement hơn được thử trước; khi bằng nhau dùng thứ tự nền diện tích giảm dần
/// rồi `partId`. Chỉ một sweep đầy đủ không đặt thêm được mới chứng minh baseline đã bão
/// hoà theo miền ứng viên của nó.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutofillAngleSchedule {
    Primary,
    AlternatingHalfTurn,
}

fn half_turn_angles(
    part: &NormalizedPart,
    policy: BaselineAnglePolicy,
    tol: &Tolerance,
) -> Option<(f64, f64)> {
    if policy != BaselineAnglePolicy::FirstAllowed {
        return None;
    }
    let primary = baseline_angles(&part.rotation_domain, policy, tol)
        .first()
        .copied()?;
    let half_turn = canonicalize_angle_deg(primary + 180.0, tol)?;
    if !part.rotation_domain.contains(half_turn, tol)
        || circular_distance_deg(primary, half_turn) <= tol.angular_deg
    {
        return None;
    }
    Some((primary, half_turn))
}

#[derive(Debug, Default)]
struct PeriodicMotifProbe {
    outcome: Option<BaselineOutcome>,
    attempts: u64,
    orientation_evaluations: u64,
}

/// Dựng lattice tuần hoàn một hướng từ hai hàng đầu mà greedy đã chứng minh.
///
/// MOTIF (audit 2026-08-31 §NEST-PERIODIC-LATTICE): greedy chọn lại đỉnh NFP sau mỗi
/// con nên sai số pha của một hàng truyền sang mọi hàng phía trên. Candidate này chỉ
/// nhận prefix khi cả hàng đầu lẫn hàng kế đã lặp cùng nhịp ngang `u`; từ đó mọi pose
/// được tính tuyệt đối bằng `origin + c·u + r·v`, không cộng dồn từ pose trước.
/// Bounds và dấu ốc chỉ bỏ đúng cell vi phạm. Va chạm part↔part chứng tỏ basis sai nên
/// loại cả candidate; tuyệt đối không đẩy riêng cell rồi làm quỹ đạo trôi trở lại.
fn run_periodic_primary_lattice_candidate(
    request: &NormalizedRequest,
    control: &RunControl,
    part: &NormalizedPart,
    primary: &BaselineOutcome,
    primary_angle: f64,
    minimum_placements: usize,
) -> Result<PeriodicMotifProbe, BaselineError> {
    let mut probe = PeriodicMotifProbe::default();
    if primary.placements.len() < 5 {
        return Ok(probe);
    }

    let tol = request.tolerance;
    let angle_is = |record: &PlacementRecord| {
        record.part_id == part.part_id
            && record.sheet_index == 0
            && circular_distance_deg(record.pose.rotation_deg, primary_angle) <= tol.angular_deg
    };
    let records: Vec<&PlacementRecord> = primary
        .placements
        .iter()
        .filter(|record| angle_is(record))
        .collect();
    let Some(first) = records.first().copied() else {
        return Ok(probe);
    };

    let second = records
        .iter()
        .copied()
        .filter(|record| {
            (record.pose.translate_y_mm - first.pose.translate_y_mm).abs() <= tol.linear_mm
                && record.pose.translate_x_mm > first.pose.translate_x_mm + tol.linear_mm
        })
        .min_by(|left, right| {
            left.pose
                .translate_x_mm
                .total_cmp(&right.pose.translate_x_mm)
        });
    let Some(second) = second else {
        return Ok(probe);
    };
    let column_step_x = second.pose.translate_x_mm - first.pose.translate_x_mm;
    let column_step_y = second.pose.translate_y_mm - first.pose.translate_y_mm;
    if column_step_x <= tol.linear_mm || column_step_y.abs() > tol.linear_mm {
        return Ok(probe);
    }

    let pose_is = |record: &PlacementRecord, x: f64, y: f64| {
        angle_is(record)
            && (record.pose.translate_x_mm - x).abs() <= tol.linear_mm
            && (record.pose.translate_y_mm - y).abs() <= tol.linear_mm
    };
    // Không suy một lattice từ đúng hai con tình cờ nằm ngang: hàng đầu phải lặp u.
    if !records.iter().copied().any(|record| {
        pose_is(
            record,
            first.pose.translate_x_mm + 2.0 * column_step_x,
            first.pose.translate_y_mm + 2.0 * column_step_y,
        )
    }) {
        return Ok(probe);
    }

    let row_start = records
        .iter()
        .copied()
        .filter(|record| record.pose.translate_y_mm > first.pose.translate_y_mm + tol.linear_mm)
        .min_by(|left, right| {
            left.pose
                .translate_y_mm
                .total_cmp(&right.pose.translate_y_mm)
                .then(
                    left.pose
                        .translate_x_mm
                        .total_cmp(&right.pose.translate_x_mm),
                )
        });
    let Some(row_start) = row_start else {
        return Ok(probe);
    };
    // Hàng thứ hai cũng phải chứng minh đúng u; nếu không, đó chỉ là một tiếp xúc rời.
    if !records.iter().copied().any(|record| {
        pose_is(
            record,
            row_start.pose.translate_x_mm + column_step_x,
            row_start.pose.translate_y_mm + column_step_y,
        )
    }) {
        return Ok(probe);
    }

    let row_step_x = row_start.pose.translate_x_mm - first.pose.translate_x_mm;
    let row_step_y = row_start.pose.translate_y_mm - first.pose.translate_y_mm;
    if row_step_y <= tol.linear_mm
        || (column_step_x * row_step_y - column_step_y * row_step_x).abs()
            <= tol.linear_mm * tol.linear_mm
    {
        return Ok(probe);
    }

    let local_pose = Pose::new(primary_angle, 0.0, 0.0);
    let Ok(local_ring) =
        place_ring_checked(&part.outer, &local_pose, part.reference_point_mm, &tol)
    else {
        return Ok(probe);
    };
    let Some(local_bounds) = BoundsMm::from_ring(&local_ring) else {
        return Ok(probe);
    };

    let usable = request.placement_bounds_for(part);
    let part_clearance = part_clearance_for_request(request);
    let part_broad_gap_mm = broad_gap_mm(part_clearance);
    let max_instances = usize::try_from(MAX_INSTANCES_TOTAL).unwrap_or(usize::MAX);
    let column_radius = (((usable.width_mm() + local_bounds.width_mm()) / column_step_x).ceil()
        as usize)
        .saturating_add(2)
        .min(max_instances);
    let max_rows = (((usable.height_mm() + local_bounds.height_mm()) / row_step_y).ceil() as usize)
        .saturating_add(2)
        .min(max_instances);
    if column_radius == 0 || max_rows == 0 {
        return Ok(probe);
    }

    let cell_hint = local_bounds
        .width_mm()
        .max(local_bounds.height_mm())
        .max(part_broad_gap_mm)
        .max(tol.linear_mm);
    // PERF/MOTIF (audit 2026-09-01 §PAGE4-TRAJECTORY): cùng một basis và góc thì
    // phán quyết part↔part chỉ phụ thuộc (Δrow, Δcolumn), không phụ thuộc origin.
    // Cache quan hệ cell để phase rescue không lặp convex decomposition hàng chục lần.
    let mut lattice_pair_cache: BTreeMap<(i64, i64), bool> = BTreeMap::new();
    let mut build_lattice = |origin_x: f64| -> Result<Option<Vec<PlacementRecord>>, BaselineError> {
        let mut spatial = SpatialGrid::new(&usable, cell_hint);
        let mut placed_rings: Vec<Vec<PointMm>> = Vec::new();
        let mut placed_cells: Vec<(usize, isize)> = Vec::new();
        let mut placements: Vec<PlacementRecord> = Vec::new();
        let mut basis_valid = true;

        'rows: for row in 0..max_rows {
            control.checkpoint_cancel_only()?;
            let row_x = origin_x + row as f64 * row_step_x;
            let row_y = first.pose.translate_y_mm + row as f64 * row_step_y;
            if local_bounds.min_y + row_y > usable.max_y + tol.linear_mm {
                break;
            }
            if local_bounds.max_y + row_y < usable.min_y - tol.linear_mm {
                continue;
            }

            let radius = isize::try_from(column_radius).unwrap_or(isize::MAX);
            for column in -radius..=radius {
                control.checkpoint_cancel_only()?;
                probe.attempts = probe.attempts.saturating_add(1);
                probe.orientation_evaluations = probe.orientation_evaluations.saturating_add(1);
                let pose = Pose::new(
                    primary_angle,
                    row_x + column as f64 * column_step_x,
                    row_y + column as f64 * column_step_y,
                );
                let Ok(ring) =
                    place_ring_checked(&part.outer, &pose, part.reference_point_mm, &tol)
                else {
                    basis_valid = false;
                    break 'rows;
                };
                let Some(bounds) = BoundsMm::from_ring(&ring) else {
                    basis_valid = false;
                    break 'rows;
                };
                if !ring_within_bounds(&ring, &usable, &tol) {
                    continue;
                }

                // Dấu ốc/vật cản chỉ làm rỗng cell này. Narrow-phase dùng contour CUT
                // thật và cùng clearance dị hướng với final validator.
                if violates_fixed_obstacle_contract(request, &ring, &bounds) {
                    continue;
                }

                // Nếu hai cell của chính lattice va nhau thì basis không hợp lệ. Không được
                // bỏ ngẫu nhiên một tem vì như vậy lại biến lattice thành greedy lộn xộn.
                if spatial
                    .query_within_gap(&bounds, part_broad_gap_mm, &tol)
                    .iter()
                    .any(|entry| {
                        let (other_row, other_column) = placed_cells[entry.id];
                        let mut delta_row = row as i64 - other_row as i64;
                        let mut delta_column = column as i64 - other_column as i64;
                        if delta_row < 0 || (delta_row == 0 && delta_column < 0) {
                            delta_row = -delta_row;
                            delta_column = -delta_column;
                        }
                        let key = (delta_row, delta_column);
                        if let Some(cached) = lattice_pair_cache.get(&key) {
                            *cached
                        } else {
                            let clashes = pair_clashes_for_request(
                                request,
                                &ring,
                                &placed_rings[entry.id],
                                false,
                            );
                            lattice_pair_cache.insert(key, clashes);
                            clashes
                        }
                    })
                {
                    basis_valid = false;
                    break 'rows;
                }
                if placements.len() as u64 >= MAX_INSTANCES_TOTAL {
                    return Err(BaselineError::CapacityInvariantExceeded);
                }
                let ring_id = placed_rings.len();
                if spatial.insert(ring_id, bounds).is_none() {
                    basis_valid = false;
                    break 'rows;
                }
                placed_rings.push(ring);
                placed_cells.push((row, column));
                let ordinal = u32::try_from(placements.len() + 1)
                    .map_err(|_| BaselineError::CapacityInvariantExceeded)?;
                placements.push(PlacementRecord {
                    instance_id: format_instance_id(&part.part_id, ordinal),
                    part_id: part.part_id.clone(),
                    sheet_index: 0,
                    pose,
                    source_revision: part.source_revision.clone(),
                });
            }
        }

        Ok(basis_valid.then_some(placements))
    };

    // Giữ nguyên đường neo cũ khi nó đã đạt sàn greedy: không đổi output của các mẫu
    // đang tốt (đặc biệt fixture trang 7) chỉ vì bổ sung rescue cho một ca hụt pha.
    let Some(anchored) = build_lattice(first.pose.translate_x_mm)? else {
        drop(build_lattice);
        return Ok(probe);
    };
    if anchored.len() >= minimum_placements {
        drop(build_lattice);
        probe.outcome = Some(BaselineOutcome {
            sheet_count: u32::from(!anchored.is_empty()),
            placements: anchored,
            unplaced: Vec::new(),
            attempts: probe.attempts,
            orientation_evaluations: probe.orientation_evaluations,
            periodic_motif: true,
            baseline_version: BASELINE_VERSION,
        });
        return Ok(probe);
    }

    // MOTIF/FIX (audit 2026-09-01 §PAGE4-TRAJECTORY): neo greedy của trang 4 chỉ
    // chứa 45 cell nên candidate rigid từng bị loại, trong khi một pha ngang khác chứa
    // 47 cell và qua final validator. Số cell chỉ có thể đổi khi biên bbox của một hàng
    // chạm biên usable; giữa hai sự kiện liên tiếp, tập cell là bất biến. Vì vậy thử mọi
    // sự kiện + midpoint là đầy đủ theo pha, không phải lưới lấy mẫu và không có hard-cap
    // chất lượng theo cấu hình máy.
    let pose_min_x = usable.min_x - local_bounds.min_x;
    let pose_max_x = usable.max_x - local_bounds.max_x;
    let normalize_phase = |value: f64| {
        let phase = value.rem_euclid(column_step_x);
        if phase <= tol.linear_mm || column_step_x - phase <= tol.linear_mm {
            0.0
        } else {
            phase
        }
    };
    let mut phase_events = vec![normalize_phase(first.pose.translate_x_mm)];
    for row in 0..max_rows {
        let row_y = first.pose.translate_y_mm + row as f64 * row_step_y;
        if local_bounds.min_y + row_y > usable.max_y + tol.linear_mm {
            break;
        }
        if local_bounds.max_y + row_y < usable.min_y - tol.linear_mm {
            continue;
        }
        let row_offset_x = row as f64 * row_step_x;
        phase_events.push(normalize_phase(pose_min_x - row_offset_x));
        phase_events.push(normalize_phase(pose_max_x - row_offset_x));
    }
    phase_events.sort_by(f64::total_cmp);
    phase_events.dedup_by(|left, right| (*left - *right).abs() <= tol.linear_mm);

    let mut phase_origins = phase_events.clone();
    for index in 0..phase_events.len() {
        let left = phase_events[index];
        let right = if index + 1 < phase_events.len() {
            phase_events[index + 1]
        } else {
            phase_events[0] + column_step_x
        };
        phase_origins.push(normalize_phase((left + right) * 0.5));
    }
    phase_origins.sort_by(f64::total_cmp);
    phase_origins.dedup_by(|left, right| (*left - *right).abs() <= tol.linear_mm);

    // PERF/MOTIF (audit 2026-09-01 §PAGE4-TRAJECTORY): bbox đã xoay cùng pose
    // cho một cận trên chính xác trước obstacle/collision. Loại pha không thể đạt sàn,
    // rồi thử theo (capacity giảm dần, envelope tăng dần). Khi một candidate giữ đủ
    // cận trên, mọi pha đứng sau đã bị dominance theo hai tiêu chí vật chất đầu tiên.
    let phase_bound = |origin_x: f64| -> (usize, f64) {
        let mut count = 0usize;
        let mut envelope: Option<BoundsMm> = None;
        let radius = isize::try_from(column_radius).unwrap_or(isize::MAX);
        for row in 0..max_rows {
            let row_x = origin_x + row as f64 * row_step_x;
            let row_y = first.pose.translate_y_mm + row as f64 * row_step_y;
            if local_bounds.min_y + row_y > usable.max_y + tol.linear_mm {
                break;
            }
            for column in -radius..=radius {
                let pose = Pose::new(
                    primary_angle,
                    row_x + column as f64 * column_step_x,
                    row_y + column as f64 * column_step_y,
                );
                let bounds = translated_bounds(local_bounds, &pose);
                if bounds.min_x < usable.min_x - tol.linear_mm
                    || bounds.max_x > usable.max_x + tol.linear_mm
                    || bounds.min_y < usable.min_y - tol.linear_mm
                    || bounds.max_y > usable.max_y + tol.linear_mm
                {
                    continue;
                }
                count = count.saturating_add(1);
                envelope = Some(match envelope {
                    Some(current) => union_bounds(current, bounds),
                    None => bounds,
                });
            }
        }
        let area = envelope
            .map(|bounds| bounds.width_mm() * bounds.height_mm())
            .unwrap_or(0.0);
        (count, area)
    };
    let mut ranked_phases: Vec<(usize, f64, f64)> = phase_origins
        .into_iter()
        .filter_map(|origin_x| {
            let (capacity, envelope_area) = phase_bound(origin_x);
            (capacity >= minimum_placements).then_some((capacity, envelope_area, origin_x))
        })
        .collect();
    ranked_phases.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then(left.1.total_cmp(&right.1))
            .then(left.2.total_cmp(&right.2))
    });

    let mut best: Option<(LayoutScore, Vec<PlacementRecord>)> = None;
    for (capacity_upper_bound, _, origin_x) in ranked_phases {
        control.checkpoint_cancel_only()?;
        if best
            .as_ref()
            .is_some_and(|(_, placements)| placements.len() > capacity_upper_bound)
        {
            break;
        }
        let Some(candidate) = build_lattice(origin_x)? else {
            continue;
        };
        if candidate.len() < minimum_placements {
            continue;
        }
        let kept_full_bound = candidate.len() == capacity_upper_bound;
        let candidate_score = score_layout(request, &candidate, 0);
        if best
            .as_ref()
            .is_none_or(|(current, _)| candidate_score.is_better_than(current))
        {
            best = Some((candidate_score, candidate));
        }
        if kept_full_bound {
            break;
        }
    }
    drop(build_lattice);

    if let Some((_, placements)) = best {
        probe.outcome = Some(BaselineOutcome {
            sheet_count: u32::from(!placements.is_empty()),
            placements,
            unplaced: Vec::new(),
            attempts: probe.attempts,
            orientation_evaluations: probe.orientation_evaluations,
            periodic_motif: true,
            baseline_version: BASELINE_VERSION,
        });
    }
    Ok(probe)
}

/// Độ lệch của envelope so với neo xuất bản yêu cầu, tính trong hệ trục tờ.
fn alignment_residual_mm(alignment: LayoutAlignment, bounds: &BoundsMm, usable: &BoundsMm) -> f64 {
    let dx = match alignment {
        LayoutAlignment::TopLeft | LayoutAlignment::CenterLeft | LayoutAlignment::BottomLeft => {
            bounds.min_x - usable.min_x
        }
        LayoutAlignment::TopRight | LayoutAlignment::CenterRight | LayoutAlignment::BottomRight => {
            bounds.max_x - usable.max_x
        }
        _ => bounds.center().x - usable.center().x,
    };
    let dy = match alignment {
        LayoutAlignment::BottomLeft
        | LayoutAlignment::BottomCenter
        | LayoutAlignment::BottomRight => bounds.min_y - usable.min_y,
        LayoutAlignment::TopLeft | LayoutAlignment::TopCenter | LayoutAlignment::TopRight => {
            bounds.max_y - usable.max_y
        }
        _ => bounds.center().y - usable.center().y,
    };
    dx.hypot(dy)
}

/// Năm trường trước canonical tie-break là chất lượng vật chất của LayoutScore.
fn periodic_material_scores_equal(left: &LayoutScore, right: &LayoutScore) -> bool {
    left.invalid_count == right.invalid_count
        && left.unplaced_count == right.unplaced_count
        && left.sheet_count == right.sheet_count
        && left.last_sheet_used_area_fixed == right.last_sheet_used_area_fixed
        && left.wasted_within_envelope_fixed == right.wasted_within_envelope_fixed
}

fn project_ring_onto_axis(ring: &[PointMm], axis_x: f64, axis_y: f64) -> (f64, f64) {
    ring.iter()
        .map(|point| point.x * axis_x + point.y * axis_y)
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), value| {
            (low.min(value), high.max(value))
        })
}

fn push_unique_edge_normal(
    axes: &mut Vec<(f64, f64)>,
    from: PointMm,
    to: PointMm,
    linear_tolerance: f64,
) {
    let edge_x = to.x - from.x;
    let edge_y = to.y - from.y;
    let length = edge_x.hypot(edge_y);
    if length <= linear_tolerance {
        return;
    }
    let mut axis_x = -edge_y / length;
    let mut axis_y = edge_x / length;
    const AXIS_EPSILON: f64 = 1e-9;
    if axis_x < -AXIS_EPSILON || (axis_x.abs() <= AXIS_EPSILON && axis_y < 0.0) {
        axis_x = -axis_x;
        axis_y = -axis_y;
    }
    if axes
        .iter()
        .any(|(kept_x, kept_y)| (kept_x * axis_y - kept_y * axis_x).abs() <= AXIS_EPSILON)
    {
        return;
    }
    axes.push((axis_x, axis_y));
}

/// Dựng một candidate tuần hoàn từ cặp 0°/180° đã được baseline chứng minh hợp lệ.
///
/// MOTIF (audit 2026-08-29 §NEST-PERIODIC-PAIR): lịch góc xen kẽ chỉ bảo đảm histogram,
/// không khóa quan hệ hình học giữa hai con. Hàm này lấy cặp đầu và nhịp ngang của hai
/// cặp đầu tiên, rồi nhân bản NGUYÊN KHỐI theo hàng. Khoảng cách hàng dùng envelope cặp
/// cộng gap bảo thủ, vì vậy hàng sau không thể làm trôi motif hàng trước. Đây là một
/// candidate trong portfolio baseline: greedy cũ vẫn còn nguyên và candidate chỉ được
/// công bố nếu thắng cùng `LayoutScore`, sau đó vẫn qua final validator độc lập.
fn run_periodic_half_turn_candidate(
    request: &NormalizedRequest,
    control: &RunControl,
    part: &NormalizedPart,
    alternating: &BaselineOutcome,
    primary_angle: f64,
    half_turn_angle: f64,
    minimum_placements: usize,
) -> Result<PeriodicMotifProbe, BaselineError> {
    let mut probe = PeriodicMotifProbe::default();
    if alternating.placements.len() < 4 {
        return Ok(probe);
    }

    let tol = request.tolerance;
    let first = &alternating.placements[0];
    let second = &alternating.placements[1];
    let third = &alternating.placements[2];
    let fourth = &alternating.placements[3];
    let angle_is = |record: &PlacementRecord, expected: f64| {
        record.part_id == part.part_id
            && record.sheet_index == 0
            && circular_distance_deg(record.pose.rotation_deg, expected) <= tol.angular_deg
    };
    if !angle_is(first, primary_angle)
        || !angle_is(second, half_turn_angle)
        || !angle_is(third, primary_angle)
        || !angle_is(fourth, half_turn_angle)
    {
        return Ok(probe);
    }

    let pair_dx = second.pose.translate_x_mm - first.pose.translate_x_mm;
    let pair_dy = second.pose.translate_y_mm - first.pose.translate_y_mm;
    let repeated_pair_dx = fourth.pose.translate_x_mm - third.pose.translate_x_mm;
    let repeated_pair_dy = fourth.pose.translate_y_mm - third.pose.translate_y_mm;
    if (pair_dx - repeated_pair_dx).abs() > tol.linear_mm
        || (pair_dy - repeated_pair_dy).abs() > tol.linear_mm
    {
        return Ok(probe);
    }

    // Hai cặp đầu phải đã tạo thành một nhịp ngang thật. Không suy diễn motif từ một
    // prefix đang bẻ hàng hoặc chạy chéo, vì làm vậy chỉ chuẩn hóa nhầm một tình cờ greedy.
    let column_step_x = third.pose.translate_x_mm - first.pose.translate_x_mm;
    let column_step_y = third.pose.translate_y_mm - first.pose.translate_y_mm;
    if column_step_x <= tol.linear_mm || column_step_y.abs() > tol.linear_mm {
        return Ok(probe);
    }

    let primary_pose = Pose::new(primary_angle, 0.0, 0.0);
    let half_turn_pose = Pose::new(half_turn_angle, pair_dx, pair_dy);
    let Ok(primary_ring) =
        place_ring_checked(&part.outer, &primary_pose, part.reference_point_mm, &tol)
    else {
        return Ok(probe);
    };
    let Ok(half_turn_ring) =
        place_ring_checked(&part.outer, &half_turn_pose, part.reference_point_mm, &tol)
    else {
        return Ok(probe);
    };
    let (Some(primary_bounds), Some(half_turn_bounds)) = (
        BoundsMm::from_ring(&primary_ring),
        BoundsMm::from_ring(&half_turn_ring),
    ) else {
        return Ok(probe);
    };
    let motif_bounds = union_bounds(primary_bounds, half_turn_bounds);
    let part_clearance = part_clearance_for_request(request);
    let part_broad_gap_mm = broad_gap_mm(part_clearance);
    if pair_clashes_for_request(request, &primary_ring, &half_turn_ring, false) {
        return Ok(probe);
    }

    // Hàng khác nhau tách bằng bbox: production cộng đúng clearance Y của trục tờ;
    // legacy vẫn giữ bán kính Euclidean cũ. Không cộng tolerance vào từng bước vì sai
    // số đó sẽ tích lũy và làm hụt hàng ở cụm exact-fit; narrow-phase đã tự dung sai.
    let row_step_y = motif_bounds.height_mm() + part_clearance.reach_y_mm();
    let usable = request.placement_bounds_for(part);
    let fit_count = |available: f64, span: f64, step: f64| -> usize {
        if !available.is_finite()
            || !span.is_finite()
            || !step.is_finite()
            || step <= tol.linear_mm
            || span > available + tol.linear_mm
        {
            return 0;
        }
        (((available - span + tol.linear_mm) / step).floor() as usize).saturating_add(1)
    };
    let max_pairs_by_protocol = usize::try_from(MAX_INSTANCES_TOTAL / 2).unwrap_or(usize::MAX);
    let max_columns = fit_count(usable.width_mm(), motif_bounds.width_mm(), column_step_x)
        .min(max_pairs_by_protocol);
    let max_rows = fit_count(usable.height_mm(), motif_bounds.height_mm(), row_step_y)
        .min(max_pairs_by_protocol);
    if max_columns == 0 || max_rows == 0 {
        return Ok(probe);
    }

    let minimum_pairs = minimum_placements.div_ceil(2);
    if max_columns
        .saturating_mul(max_rows)
        .min(max_pairs_by_protocol)
        < minimum_pairs
    {
        return Ok(probe);
    }

    // Liệt kê TOÀN BỘ factorization còn giữ được sàn số lượng greedy. Không cắt cứng
    // còn năm kích thước: tờ cao-hẹp và tờ rộng-thấp đều được quyền tranh như nhau.
    // Thứ tự count giảm dần cho phép dominance-prune ngay sau khi đã tìm được một count
    // hợp lệ; trong cùng count, envelope nhỏ hơn được thử trước theo đúng LayoutScore.
    let mut dimensions: Vec<(usize, usize)> = Vec::new();
    for columns in 1..=max_columns.min(max_pairs_by_protocol) {
        let minimum_rows = minimum_pairs.div_ceil(columns);
        let maximum_rows = max_rows.min(max_pairs_by_protocol / columns);
        if minimum_rows > maximum_rows {
            continue;
        }
        dimensions.extend((minimum_rows..=maximum_rows).map(|rows| (columns, rows)));
    }
    dimensions.sort_by(|left, right| {
        let left_count = left.0.saturating_mul(left.1);
        let right_count = right.0.saturating_mul(right.1);
        let left_area = (motif_bounds.width_mm() + left.0.saturating_sub(1) as f64 * column_step_x)
            * (motif_bounds.height_mm() + left.1.saturating_sub(1) as f64 * row_step_y);
        let right_area = (motif_bounds.width_mm()
            + right.0.saturating_sub(1) as f64 * column_step_x)
            * (motif_bounds.height_mm() + right.1.saturating_sub(1) as f64 * row_step_y);
        right_count
            .cmp(&left_count)
            .then(left_area.total_cmp(&right_area))
            .then(right.0.cmp(&left.0))
    });

    // PERF (audit 2026-08-29 §SR-PREVIEW-1): score của best chỉ tính một lần khi nhận;
    // không dựng lại toàn bộ contour của best ở mỗi origin periodic.
    let mut best_score: Option<LayoutScore> = None;
    let mut best_alignment_residual_mm: Option<f64> = None;

    for (columns, rows) in dimensions {
        control.checkpoint_cancel_only()?;
        let expected = columns.saturating_mul(rows).saturating_mul(2);
        if probe
            .outcome
            .as_ref()
            .is_some_and(|best| expected < best.placements.len())
        {
            // Dimensions đã sắp theo count giảm dần: mọi phần còn lại bị best hiện tại
            // dominate ở tiêu chí đầu tiên của LayoutScore, không cần dựng thêm pose.
            break;
        }
        let local_cluster = BoundsMm {
            min_x: motif_bounds.min_x,
            min_y: motif_bounds.min_y,
            max_x: motif_bounds.max_x + (columns.saturating_sub(1) as f64) * column_step_x,
            max_y: motif_bounds.max_y + (rows.saturating_sub(1) as f64) * row_step_y,
        };
        if local_cluster.width_mm() > usable.width_mm() + tol.linear_mm
            || local_cluster.height_mm() > usable.height_mm() + tol.linear_mm
        {
            continue;
        }

        let min_shift_x = usable.min_x - local_cluster.min_x;
        let center_shift_x = usable.center().x - local_cluster.center().x;
        let max_shift_x = usable.max_x - local_cluster.max_x;
        let min_shift_y = usable.min_y - local_cluster.min_y;
        let center_shift_y = usable.center().y - local_cluster.center().y;
        let max_shift_y = usable.max_y - local_cluster.max_y;
        let mut origins: Vec<(f64, f64)> = Vec::new();
        let mut add_origin = |x: f64, y: f64| {
            if x < min_shift_x - tol.linear_mm
                || x > max_shift_x + tol.linear_mm
                || y < min_shift_y - tol.linear_mm
                || y > max_shift_y + tol.linear_mm
                || origins.iter().any(|(kept_x, kept_y)| {
                    (*kept_x - x).abs() <= tol.linear_mm && (*kept_y - y).abs() <= tol.linear_mm
                })
            {
                return;
            }
            origins.push((x, y));
        };
        for x in [min_shift_x, center_shift_x, max_shift_x] {
            for y in [min_shift_y, center_shift_y, max_shift_y] {
                add_origin(x, y);
            }
        }
        // Các anchor primary mà greedy đã chứng minh hợp lệ là thêm candidate liên tục
        // hữu ích quanh fixed obstacle; không chỉ còn ba snap min/center/max mỗi trục.
        for record in &alternating.placements {
            if angle_is(record, primary_angle) {
                add_origin(record.pose.translate_x_mm, record.pose.translate_y_mm);
            }
        }

        // NEST (audit 2026-08-29 §SR-CENTER-2): từ origin đúng alignment, sinh
        // các điểm tiếp xúc theo pháp tuyến cạnh CUT của member/vật cản gần góc. Bbox
        // chỉ broad-phase chọn cặp/cạnh; vòng dưới vẫn dùng `judge_pair_sheet_axis`
        // và final validator làm authority. Không bisection vì miền khả thi theo các
        // obstacle rời rạc không đơn điệu.
        if let Some(production) = request.production_contract.as_ref() {
            let preferred_x = match production.alignment {
                LayoutAlignment::TopLeft
                | LayoutAlignment::CenterLeft
                | LayoutAlignment::BottomLeft => min_shift_x,
                LayoutAlignment::TopRight
                | LayoutAlignment::CenterRight
                | LayoutAlignment::BottomRight => max_shift_x,
                _ => center_shift_x,
            };
            let preferred_y = match production.alignment {
                LayoutAlignment::BottomLeft
                | LayoutAlignment::BottomCenter
                | LayoutAlignment::BottomRight => min_shift_y,
                LayoutAlignment::TopLeft
                | LayoutAlignment::TopCenter
                | LayoutAlignment::TopRight => max_shift_y,
                _ => center_shift_y,
            };
            let clearance = production.clearance.part_to_obstacle;
            let broad_margin = clearance.x_mm.hypot(clearance.y_mm);
            let escape = tol.linear_mm;
            for row in 0..rows {
                for column in 0..columns {
                    let offset_x = column as f64 * column_step_x;
                    let offset_y = row as f64 * row_step_y;
                    for (base_ring, base_bounds) in [
                        (&primary_ring, primary_bounds),
                        (&half_turn_ring, half_turn_bounds),
                    ] {
                        let at_preferred = BoundsMm {
                            min_x: base_bounds.min_x + offset_x + preferred_x,
                            min_y: base_bounds.min_y + offset_y + preferred_y,
                            max_x: base_bounds.max_x + offset_x + preferred_x,
                            max_y: base_bounds.max_y + offset_y + preferred_y,
                        };
                        let widened = BoundsMm {
                            min_x: at_preferred.min_x - broad_margin,
                            min_y: at_preferred.min_y - broad_margin,
                            max_x: at_preferred.max_x + broad_margin,
                            max_y: at_preferred.max_y + broad_margin,
                        };
                        let member_at_preferred: Vec<PointMm> = base_ring
                            .iter()
                            .map(|point| {
                                PointMm::new(
                                    point.x + offset_x + preferred_x,
                                    point.y + offset_y + preferred_y,
                                )
                            })
                            .collect();
                        for obstacle in &production.fixed_obstacles {
                            if !bounds_may_touch(&widened, &obstacle.bounds, &tol) {
                                continue;
                            }
                            let mut axes = vec![(1.0, 0.0), (0.0, 1.0)];
                            for index in 0..member_at_preferred.len() {
                                let from = member_at_preferred[index];
                                let to =
                                    member_at_preferred[(index + 1) % member_at_preferred.len()];
                                let edge_bounds = BoundsMm {
                                    min_x: from.x.min(to.x) - broad_margin,
                                    min_y: from.y.min(to.y) - broad_margin,
                                    max_x: from.x.max(to.x) + broad_margin,
                                    max_y: from.y.max(to.y) + broad_margin,
                                };
                                if bounds_may_touch(&edge_bounds, &obstacle.bounds, &tol) {
                                    push_unique_edge_normal(&mut axes, from, to, tol.linear_mm);
                                }
                            }
                            for index in 0..obstacle.outer.len() {
                                push_unique_edge_normal(
                                    &mut axes,
                                    obstacle.outer[index],
                                    obstacle.outer[(index + 1) % obstacle.outer.len()],
                                    tol.linear_mm,
                                );
                            }
                            for (axis_x, axis_y) in axes {
                                let (member_min, member_max) =
                                    project_ring_onto_axis(&member_at_preferred, axis_x, axis_y);
                                let (obstacle_min, obstacle_max) =
                                    project_ring_onto_axis(&obstacle.outer, axis_x, axis_y);
                                let required =
                                    clearance.x_mm * axis_x.abs() + clearance.y_mm * axis_y.abs();
                                let toward_low = obstacle_min - required - escape - member_max;
                                let toward_high = obstacle_max + required + escape - member_min;
                                add_origin(
                                    preferred_x + toward_low * axis_x,
                                    preferred_y + toward_low * axis_y,
                                );
                                add_origin(
                                    preferred_x + toward_high * axis_x,
                                    preferred_y + toward_high * axis_y,
                                );
                            }
                        }
                    }
                }
            }
        }

        // NEST (audit 2026-08-29 §SR-CENTER-1): thử neo đúng alignment trước. Nếu
        // obstacle tạo vacancy, các origin còn lại vẫn được duyệt đầy đủ ở vòng dưới.
        if let Some(production) = request.production_contract.as_ref() {
            let residual = |origin: &(f64, f64)| {
                let shifted = BoundsMm {
                    min_x: local_cluster.min_x + origin.0,
                    min_y: local_cluster.min_y + origin.1,
                    max_x: local_cluster.max_x + origin.0,
                    max_y: local_cluster.max_y + origin.1,
                };
                alignment_residual_mm(production.alignment, &shifted, &usable)
            };
            origins.sort_by(|left, right| {
                residual(left)
                    .total_cmp(&residual(right))
                    .then(left.0.total_cmp(&right.0))
                    .then(left.1.total_cmp(&right.1))
            });
        } else {
            origins
                .sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.total_cmp(&right.1)));
        }

        for (shift_x, shift_y) in origins {
            control.checkpoint_cancel_only()?;
            let cell_hint = motif_bounds
                .width_mm()
                .max(motif_bounds.height_mm())
                .max(part_broad_gap_mm)
                .max(tol.linear_mm);
            let mut spatial = SpatialGrid::new(&usable, cell_hint);
            let mut placed_rings: Vec<Vec<PointMm>> = Vec::new();

            let expected = columns.saturating_mul(rows).saturating_mul(2);
            let mut placements: Vec<PlacementRecord> = Vec::with_capacity(expected);
            let mut accepted_bounds: Option<BoundsMm> = None;
            let mut valid = true;
            'layout: for row in 0..rows {
                for column in 0..columns {
                    let anchor_x = shift_x + column as f64 * column_step_x;
                    let anchor_y = shift_y + row as f64 * row_step_y;
                    let mut cell_members = Vec::with_capacity(2);
                    for (angle, delta_x, delta_y) in [
                        (primary_angle, 0.0, 0.0),
                        (half_turn_angle, pair_dx, pair_dy),
                    ] {
                        control.checkpoint_cancel_only()?;
                        probe.attempts = probe.attempts.saturating_add(1);
                        probe.orientation_evaluations =
                            probe.orientation_evaluations.saturating_add(1);
                        let pose = Pose::new(angle, anchor_x + delta_x, anchor_y + delta_y);
                        let Ok(ring) =
                            place_ring_checked(&part.outer, &pose, part.reference_point_mm, &tol)
                        else {
                            valid = false;
                            break 'layout;
                        };
                        let Some(bounds) = BoundsMm::from_ring(&ring) else {
                            valid = false;
                            break 'layout;
                        };
                        // MOTIF (audit 2026-08-31 §NEST-PERIODIC-MEMBER-OBSTACLE):
                        // cluster đã fit trọn tờ, nên ra bounds là lỗi candidate chứ không
                        // phải vacancy. Riêng vật cản chỉ bỏ member có contour CUT thật sự
                        // vi phạm; member còn lại giữ nguyên pose tuyệt đối của lattice.
                        if !ring_within_bounds(&ring, &usable, &tol) {
                            valid = false;
                            break 'layout;
                        }
                        if violates_fixed_obstacle_contract(request, &ring, &bounds) {
                            continue;
                        }
                        if placements.len().saturating_add(cell_members.len()) as u64
                            >= MAX_INSTANCES_TOTAL
                        {
                            return Err(BaselineError::CapacityInvariantExceeded);
                        }
                        cell_members.push((pose, ring, bounds));
                    }
                    if cell_members.is_empty() {
                        continue;
                    }

                    // Va chạm part↔part chứng tỏ basis motif sai, nên phải loại cả
                    // candidate thay vì bỏ ngẫu nhiên một cell không phải do ốc.
                    if cell_members.iter().any(|(_, ring, bounds)| {
                        spatial
                            .query_within_gap(bounds, part_broad_gap_mm, &tol)
                            .iter()
                            .any(|entry| {
                                pair_clashes_for_request(
                                    request,
                                    ring,
                                    &placed_rings[entry.id],
                                    false,
                                )
                            })
                    }) {
                        valid = false;
                        break 'layout;
                    }

                    for (pose, ring, bounds) in cell_members {
                        let ring_id = placed_rings.len();
                        if spatial.insert(ring_id, bounds).is_none() {
                            valid = false;
                            break 'layout;
                        }
                        accepted_bounds = Some(match accepted_bounds {
                            Some(current) => union_bounds(current, bounds),
                            None => bounds,
                        });
                        placed_rings.push(ring);
                        let ordinal = u32::try_from(placements.len() + 1)
                            .map_err(|_| BaselineError::CapacityInvariantExceeded)?;
                        placements.push(PlacementRecord {
                            instance_id: format_instance_id(&part.part_id, ordinal),
                            part_id: part.part_id.clone(),
                            sheet_index: 0,
                            pose,
                            source_revision: part.source_revision.clone(),
                        });
                    }
                }
            }

            if valid && !placements.is_empty() && placements.len() >= minimum_placements {
                let kept_all_members = placements.len() == expected;
                let candidate = BaselineOutcome {
                    placements,
                    unplaced: Vec::new(),
                    sheet_count: 1,
                    attempts: 0,
                    orientation_evaluations: 0,
                    periodic_motif: true,
                    baseline_version: BASELINE_VERSION,
                };
                let candidate_score = score_layout(request, &candidate.placements, 0);
                let candidate_alignment_residual_mm =
                    request.production_contract.as_ref().and_then(|production| {
                        accepted_bounds.as_ref().map(|bounds| {
                            alignment_residual_mm(production.alignment, bounds, &usable)
                        })
                    });
                let should_replace = match best_score.as_ref() {
                    None => true,
                    Some(current_score)
                        if !periodic_material_scores_equal(&candidate_score, current_score) =>
                    {
                        candidate_score.is_better_than(current_score)
                    }
                    Some(current_score) => {
                        match (candidate_alignment_residual_mm, best_alignment_residual_mm) {
                            (Some(candidate_residual), Some(current_residual))
                                if candidate_residual + tol.linear_mm < current_residual =>
                            {
                                true
                            }
                            (Some(candidate_residual), Some(current_residual))
                                if current_residual + tol.linear_mm < candidate_residual =>
                            {
                                false
                            }
                            _ => candidate_score.is_better_than(current_score),
                        }
                    }
                };
                if should_replace {
                    best_score = Some(candidate_score);
                    best_alignment_residual_mm = candidate_alignment_residual_mm;
                    probe.outcome = Some(candidate);
                }
                // Khi không mất member, mọi origin của cùng dimension giữ nguyên năm
                // tiêu chí vật chất; origin khớp alignment đã được thử trước. Có vacancy
                // do ốc thì vẫn phải thử hết vì origin sau có thể giữ thêm tem.
                if kept_all_members {
                    break;
                }
            }
        }
    }

    let total_attempts = probe.attempts;
    let total_orientation_evaluations = probe.orientation_evaluations;
    if let Some(outcome) = probe.outcome.as_mut() {
        outcome.attempts = total_attempts;
        outcome.orientation_evaluations = total_orientation_evaluations;
    }
    Ok(probe)
}

fn run_autofill_baseline(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
) -> Result<BaselineOutcome, BaselineError> {
    let mut nfp_cache = NfpCache::with_telemetry_and_resources(
        control.progress().clone(),
        NfpTelemetryPhase::Baseline,
        control.nfp_worker_grant(),
        control.nfp_cache_byte_budget(),
    );
    let mut selected = run_autofill_candidate(
        request,
        control,
        policy,
        AutofillAngleSchedule::Primary,
        None,
        &mut nfp_cache,
    )?;
    let mut attempts = selected.attempts;
    let mut orientation_evaluations = selected.orientation_evaluations;
    if baseline_deadline_reached(control, true)? {
        return Ok(selected);
    }

    // MOTIF (audit 2026-08-31 §NEST-PERIODIC-LATTICE): single-design S&R phải giữ
    // một quỹ đạo cố định, không để greedy chọn lại pha ở từng hàng. Greedy vẫn là
    // nguồn chứng minh hai vector đầu và là sàn số lượng; lattice chỉ được chọn khi
    // không mất con. Khi cùng số lượng, ưu tiên lattice theo yêu cầu chế bản (đều pha)
    // trước envelope của greedy.
    if request.layout_intent.prefers_periodic_motif()
        && request.parts.len() == 1
        && selected.placements.len() >= 5
    {
        let part = &request.parts[0];
        if let Some(primary_angle) =
            baseline_angles(&part.rotation_domain, policy, &request.tolerance)
                .first()
                .copied()
        {
            let lattice = run_periodic_primary_lattice_candidate(
                request,
                control,
                part,
                &selected,
                primary_angle,
                selected.placements.len(),
            )?;
            attempts = attempts.saturating_add(lattice.attempts);
            orientation_evaluations =
                orientation_evaluations.saturating_add(lattice.orientation_evaluations);
            if let Some(periodic) = lattice.outcome {
                if periodic.placements.len() >= selected.placements.len() {
                    selected = periodic;
                }
            }
            if baseline_deadline_reached(control, true)? {
                selected.attempts = attempts;
                selected.orientation_evaluations = orientation_evaluations;
                return Ok(selected);
            }
        }
    }

    // FIX (audit 2026-08-29 §NEST-HALF-TURN): khuôn thuôn gần tam giác cần chuỗi
    // 0°/180° để hai cạnh xiên ăn vào nhau. Probe đúng hai con trước; chỉ khi envelope
    // cặp thật sự nhỏ hơn mới chạy candidate đầy tờ. Baseline 0° vẫn nằm trong portfolio;
    // alternate và motif chỉ thay nó khi thắng đúng total order của `LayoutScore`, nên không
    // hạ sàn chất lượng. Các lượt NFP dùng chung cache; motif chỉ hậu kiểm contour trực tiếp.
    if request.parts.len() == 1 && selected.placements.len() >= 2 {
        let part = &request.parts[0];
        if let Some((primary_angle, half_turn_angle)) =
            half_turn_angles(part, policy, &request.tolerance)
        {
            let first_is_primary = selected.placements.first().is_some_and(|placement| {
                circular_distance_deg(placement.pose.rotation_deg, primary_angle)
                    <= request.tolerance.angular_deg
            });
            if first_is_primary {
                let pair = run_autofill_candidate(
                    request,
                    control,
                    policy,
                    AutofillAngleSchedule::AlternatingHalfTurn,
                    Some(2),
                    &mut nfp_cache,
                )?;
                attempts = attempts.saturating_add(pair.attempts);
                orientation_evaluations =
                    orientation_evaluations.saturating_add(pair.orientation_evaluations);
                if baseline_deadline_reached(control, true)? {
                    selected.attempts = attempts;
                    selected.orientation_evaluations = orientation_evaluations;
                    return Ok(selected);
                }

                if pair.placements.len() == 2 {
                    let primary_pair_score = score_layout(request, &selected.placements[..2], 0);
                    let pair_score = score_layout(request, &pair.placements, 0);
                    if pair_score.last_sheet_used_area_fixed
                        < primary_pair_score.last_sheet_used_area_fixed
                    {
                        let alternate = run_autofill_candidate(
                            request,
                            control,
                            policy,
                            AutofillAngleSchedule::AlternatingHalfTurn,
                            None,
                            &mut nfp_cache,
                        )?;
                        attempts = attempts.saturating_add(alternate.attempts);
                        orientation_evaluations = orientation_evaluations
                            .saturating_add(alternate.orientation_evaluations);
                        if baseline_deadline_reached(control, true)? {
                            selected.attempts = attempts;
                            selected.orientation_evaluations = orientation_evaluations;
                            return Ok(selected);
                        }

                        let motif = if request.layout_intent.prefers_periodic_motif() {
                            let minimum_placements =
                                selected.placements.len().max(alternate.placements.len());
                            let motif = run_periodic_half_turn_candidate(
                                request,
                                control,
                                part,
                                &alternate,
                                primary_angle,
                                half_turn_angle,
                                minimum_placements,
                            )?;
                            attempts = attempts.saturating_add(motif.attempts);
                            orientation_evaluations = orientation_evaluations
                                .saturating_add(motif.orientation_evaluations);
                            if baseline_deadline_reached(control, true)? {
                                selected.attempts = attempts;
                                selected.orientation_evaluations = orientation_evaluations;
                                return Ok(selected);
                            }
                            Some(motif)
                        } else {
                            None
                        };

                        let alternate_score = score_layout(request, &alternate.placements, 0);
                        let selected_score = score_layout(request, &selected.placements, 0);
                        if alternate_score.is_better_than(&selected_score) {
                            selected = alternate;
                        }
                        if let Some(periodic) = motif.and_then(|probe| probe.outcome) {
                            // Chỉ intent S&R tường minh mới coi quỹ đạo rigid là điều
                            // kiện chế bản đứng trước envelope của candidate tự do.
                            if periodic.placements.len() >= selected.placements.len() {
                                selected = periodic;
                            }
                        }
                    }
                }
            }
        }
    }

    selected.attempts = attempts;
    selected.orientation_evaluations = orientation_evaluations;
    Ok(selected)
}

fn run_autofill_candidate(
    request: &NormalizedRequest,
    control: &RunControl,
    policy: BaselineAnglePolicy,
    angle_schedule: AutofillAngleSchedule,
    placement_limit: Option<usize>,
    nfp_cache: &mut NfpCache,
) -> Result<BaselineOutcome, BaselineError> {
    let tol = request.tolerance;
    let mut order: Vec<&NormalizedPart> = request.parts.iter().collect();
    order.sort_by(|a, b| {
        b.effective_area_mm2()
            .partial_cmp(&a.effective_area_mm2())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.part_id.cmp(&b.part_id))
    });

    let mut counts: Vec<u32> = vec![0; order.len()];
    let mut placements: Vec<PlacementRecord> = Vec::new();
    let unplaced: Vec<UnplacedRecord> = Vec::new();
    let mut placed_rings = fixed_obstacle_rings(request);
    // Prefix này không đổi suốt lượt chạy; mọi phần tử append sau nó đều là part.
    let fixed_count = placed_rings.len();
    // PERF (audit 2026-08-30 §NEST-B7-CLASH-INDEX): bbox song hành với `placed_rings` để
    // tiền lọc clash. `None` cho vòng suy biến (không xảy ra với ring hợp lệ) ⇒ luôn
    // judge_pair, giữ quyết định clash Y HỆT.
    let mut placed_bounds: Vec<Option<BoundsMm>> = placed_rings
        .iter()
        .map(|r| BoundsMm::from_ring(r))
        .collect();
    let mut attempts: u64 = 0;
    let mut orientation_evaluations: u64 = 0;
    // PERF (audit 2026-08-30 §NEST-B9-INCREMENTAL): miền hợp lệ theo (part_index, góc) + số
    // chi tiết đã tính. `placed_rings` chỉ mọc thêm nên lần sau chỉ trừ delta thay vì dựng
    // lại từ IFP — bỏ O(N²) của pha difference. Layout byte-identical (golden khóa).
    let mut feasible_cache: BTreeMap<(usize, i64), (Vec<Vec<PointMm>>, usize)> = BTreeMap::new();

    'sweeps: loop {
        if placement_limit.is_some_and(|limit| placements.len() >= limit) {
            break;
        }
        // Autofill chỉ được cắt khi đã có một sweep hoàn chỉnh chứa đủ mọi design.
        // Trước barrier đầu tiên, deadline là soft để không xuất tờ thiếu mẫu.
        let allow_deadline = control.stop_criterion().time_budget_ms.is_some()
            && counts.iter().all(|count| *count > 0);
        if baseline_deadline_reached(control, allow_deadline)? {
            break;
        }
        let barrier_placements_len = placements.len();
        let mut deadline_during_sweep = false;
        let mut sweep_order: Vec<usize> = (0..order.len()).collect();
        sweep_order.sort_by(|left, right| counts[*left].cmp(&counts[*right]).then(left.cmp(right)));
        let mut placed_in_sweep = false;

        'parts: for part_index in sweep_order {
            if baseline_deadline_reached(control, allow_deadline)? {
                deadline_during_sweep = true;
                break;
            }
            let part = order[part_index];
            let placement_bounds = request.placement_bounds_for(part);
            // KHÔNG dùng toàn bộ miền cardinal ở candidate primary. Đo trên file khách
            // 13 mẫu: thêm cardinal cho từng con không đặt thêm được con nào (46 cả trước
            // và sau) nhưng thời gian tăng 17,7s → 50–66s. Lịch half-turn chỉ thử đúng
            // cặp 0°/180° đã được probe chứng minh có envelope nhỏ hơn.
            let angles = match angle_schedule {
                AutofillAngleSchedule::Primary => {
                    if counts[part_index] == 0 {
                        autofill_bootstrap_angles(request, part, part_index, policy)
                    } else {
                        baseline_angles(&part.rotation_domain, policy, &tol)
                    }
                }
                AutofillAngleSchedule::AlternatingHalfTurn => {
                    match half_turn_angles(part, policy, &tol) {
                        Some((primary, half_turn)) if counts[part_index] % 2 == 0 => {
                            vec![primary, half_turn]
                        }
                        Some((primary, half_turn)) => vec![half_turn, primary],
                        None if counts[part_index] == 0 => {
                            autofill_bootstrap_angles(request, part, part_index, policy)
                        }
                        None => baseline_angles(&part.rotation_domain, policy, &tol),
                    }
                }
            };
            let mut chosen: Option<(Pose, Vec<PointMm>)> = None;

            'angle: for angle in &angles {
                if baseline_deadline_reached(control, allow_deadline)? {
                    deadline_during_sweep = true;
                    break;
                }
                orientation_evaluations += 1;
                let Some(local) = local_ring_at(part, *angle, &tol) else {
                    continue;
                };
                // §NEST-B9: tái dùng miền đã nhớ cho (part_index, góc) rồi chỉ trừ chi
                // tiết mới; lần đầu mỗi khoá dựng từ đầu (byte-identical với đường cũ).
                let angle_key = (*angle * 1_000_000.0).round() as i64;
                let cache_key = (part_index, angle_key);
                let region_opt = match feasible_cache.remove(&cache_key) {
                    Some((base, accounted))
                        if accounted >= fixed_count && accounted <= placed_rings.len() =>
                    {
                        feasible_region_after_parts_for_request(
                            request,
                            base,
                            &placed_rings[accounted..],
                            &local,
                            nfp_cache,
                            Some(&|| baseline_stop_requested(control, allow_deadline)),
                        )?
                    }
                    _ => feasible_region_for_request(
                        request,
                        &placement_bounds,
                        &placed_rings,
                        fixed_count,
                        &local,
                        nfp_cache,
                        Some(&|| baseline_stop_requested(control, allow_deadline)),
                    )?,
                };
                let Some(region) = region_opt else {
                    if baseline_deadline_reached(control, allow_deadline)? {
                        deadline_during_sweep = true;
                        break 'angle;
                    }
                    continue 'angle;
                };
                if baseline_deadline_reached(control, allow_deadline)? {
                    deadline_during_sweep = true;
                    break 'angle;
                }
                // Nhớ lại miền vừa tính (kể cả rỗng: rỗng chỉ co thêm nên giữ rỗng).
                feasible_cache.insert(cache_key, (region.clone(), placed_rings.len()));
                if region.is_empty() {
                    continue;
                }
                let mut candidates = super::nfp::region_vertices(&region);
                candidates.sort_by(|a, b| bottom_left_order(*a, *b));
                candidates.dedup_by(|a, b| {
                    (a.x - b.x).abs() <= tol.linear_mm && (a.y - b.y).abs() <= tol.linear_mm
                });

                for candidate in candidates.iter().take(MAX_CANDIDATES_PER_ANGLE) {
                    if baseline_deadline_reached(control, allow_deadline)? {
                        deadline_during_sweep = true;
                        break 'angle;
                    }
                    attempts += 1;
                    let pose = Pose::new(*angle, candidate.x, candidate.y);
                    let Ok(ring) =
                        place_ring_checked(&part.outer, &pose, part.reference_point_mm, &tol)
                    else {
                        continue;
                    };
                    if !ring_within_bounds(&ring, &placement_bounds, &tol) {
                        continue;
                    }
                    // Tiền lọc bbox trước judge_pair (§NEST-B7): cặp cách nhau quá gap chắc
                    // chắn Ok nên bỏ; kết quả `any` không đổi ⇒ layout byte-identical.
                    let cand_bounds = BoundsMm::from_ring(&ring);
                    let clash = clashes_with_existing_for_request(
                        request,
                        &ring,
                        cand_bounds,
                        &placed_rings,
                        &placed_bounds,
                        fixed_count,
                    );
                    if clash {
                        continue;
                    }
                    chosen = Some((pose, ring));
                    break 'angle;
                }
            }

            if deadline_during_sweep {
                break 'parts;
            }

            let Some((pose, ring)) = chosen else {
                continue;
            };
            if placements.len() as u64 >= MAX_INSTANCES_TOTAL {
                return Err(BaselineError::CapacityInvariantExceeded);
            }
            counts[part_index] += 1;
            let ordinal = counts[part_index];
            placed_bounds.push(BoundsMm::from_ring(&ring));
            placed_rings.push(ring);
            placements.push(PlacementRecord {
                instance_id: format_instance_id(&part.part_id, ordinal),
                part_id: part.part_id.clone(),
                sheet_index: 0,
                pose,
                source_revision: part.source_revision.clone(),
            });
            placed_in_sweep = true;
        }

        if deadline_during_sweep {
            debug_assert!(allow_deadline);
            placements.truncate(barrier_placements_len);
            break 'sweeps;
        }

        if !placed_in_sweep {
            break;
        }
    }

    let sheet_count = if placements.is_empty() { 0 } else { 1 };
    Ok(BaselineOutcome {
        placements,
        unplaced,
        sheet_count,
        attempts,
        orientation_evaluations,
        periodic_motif: false,
        baseline_version: BASELINE_VERSION,
    })
}

/// Thử thay đúng một pose của baseline autofill bằng một góc cardinal khác 0°.
///
/// PERF (audit 2026-08-29 §ROTATION-WARM-START): smart trial có thể hết deadline giữa
/// sweep đầu rồi rollback về barrier rỗng. Bản NFP đầu tiên của probe làm file thật tăng
/// 58s → 122s mà vẫn không xoay; bản hiện tại tuyệt đối không dựng/union NFP. Nó chỉ thử
/// một tập anchor hữu hạn rồi hậu kiểm contour trực tiếp. Baseline vẫn là candidate riêng
/// và nơi gọi chỉ công bố probe khi [`LayoutScore`] thắng.
///
/// Probe cố ý:
///
/// - chỉ áp dụng cho `autofill_single_sheet`;
/// - chọn placement có phần đóng góp envelope mà một góc xoay có thể loại bỏ nhiều nhất;
/// - thử tối đa ba góc cardinal khác 0° trong miền cho phép;
/// - chỉ dùng năm anchor bbox của pose cũ, không quét lưới và không nới cụm;
/// - chỉ kiểm hủy, không tiêu work budget và không đọc deadline.
pub fn run_rotation_probe_from_baseline(
    request: &NormalizedRequest,
    baseline: &BaselineOutcome,
    baseline_score: &LayoutScore,
    control: &RunControl,
) -> Result<RotationProbeOutcome, BaselineError> {
    // MOTIF (audit 2026-08-31 §NEST-PERIODIC-AUTHORITY): candidate tuần hoàn đã
    // chứng minh origin/u/v (hoặc rigid pair). Xoay riêng một pose dù điểm envelope tốt
    // hơn sẽ phá quỹ đạo; phải để nguyên candidate authoritative cho preview và export.
    if !request.layout_intent.is_single_sheet_autofill()
        || baseline.placements.is_empty()
        || (request.layout_intent.prefers_periodic_motif() && baseline.periodic_motif)
    {
        return Ok(RotationProbeOutcome::default());
    }
    control.checkpoint_cancel_only()?;

    let tol = request.tolerance;
    // PERF (audit 2026-08-29 §ROTATION-WARM-START): dựng contour, bbox và envelope
    // trong cùng một lượt. Trước đây `sheet_envelope` transform P contour rồi
    // vòng dưới transform lại đúng P contour đó.
    let mut placement_geometry: Vec<(&NormalizedPart, Vec<PointMm>, BoundsMm)> =
        Vec::with_capacity(baseline.placements.len());
    let mut envelope: Option<BoundsMm> = None;
    for placement in &baseline.placements {
        let Some(part) = request
            .parts
            .iter()
            .find(|part| part.part_id == placement.part_id)
        else {
            return Ok(RotationProbeOutcome::default());
        };
        let Ok(ring) =
            place_ring_checked(&part.outer, &placement.pose, part.reference_point_mm, &tol)
        else {
            return Ok(RotationProbeOutcome::default());
        };
        let Some(bounds) = BoundsMm::from_ring(&ring) else {
            return Ok(RotationProbeOutcome::default());
        };
        if placement.sheet_index == 0 {
            envelope = Some(envelope.map_or(bounds, |current| union_bounds(current, bounds)));
        }
        placement_geometry.push((part, ring, bounds));
    }
    let Some(envelope) = envelope else {
        return Ok(RotationProbeOutcome::default());
    };

    let envelope_area = envelope.width_mm() * envelope.height_mm();
    // Sai số đang so là diện tích, nên phải chuyển tolerance tuyến tính sang mm².
    let area_tolerance_mm2 =
        tol.linear_mm * (envelope.width_mm() + envelope.height_mm()).max(tol.linear_mm);
    let mut local_bounds_cache: BTreeMap<(&str, usize), Option<BoundsMm>> = BTreeMap::new();
    let mut screen_bounds_evaluations = 0u64;
    let mut target: Option<(usize, Vec<(f64, BoundsMm)>, f64, f64)> = None;
    for (index, (part, _, _)) in placement_geometry.iter().enumerate() {
        let placement_bounds = request.placement_bounds_for(part);
        let mut others = placement_geometry
            .iter()
            .enumerate()
            .filter(|(other_index, _)| *other_index != index)
            .map(|(_, (_, _, bounds))| *bounds);
        let without = if let Some(first) = others.next() {
            Some(others.fold(first, |aggregate, bounds| union_bounds(aggregate, bounds)))
        } else {
            None
        };
        let contribution = without.map_or(envelope_area, |bounds| {
            envelope_area - bounds.width_mm() * bounds.height_mm()
        });
        // Phần cải thiện không thể vượt phần envelope mà target hiện tại
        // đang đóng góp. Loại target chắc chắn không thắng trước khi xoay contour.
        if contribution <= area_tolerance_mm2 {
            continue;
        }
        if target.as_ref().is_some_and(|(_, _, best_potential, _)| {
            contribution + area_tolerance_mm2 < *best_potential
        }) {
            continue;
        }

        let placement = &baseline.placements[index];
        let mut angles: Vec<(f64, BoundsMm)> = Vec::with_capacity(3);
        for (angle_index, proposed) in ROTATION_PROBE_ANGLES_DEG.into_iter().enumerate() {
            let Some(angle) = canonicalize_angle_deg(proposed, &tol) else {
                continue;
            };
            if !part.rotation_domain.contains(angle, &tol)
                || circular_distance_deg(angle, placement.pose.rotation_deg) <= tol.angular_deg
            {
                continue;
            }

            // Cùng design + cùng cardinal có cùng bbox local. Cache theo design,
            // không theo placement, để file nhiều tem lặp không transform lại contour.
            let cache_key = (part.part_id.as_str(), angle_index);
            let local_bounds = if let Some(cached) = local_bounds_cache.get(&cache_key) {
                *cached
            } else {
                screen_bounds_evaluations += 1;
                let computed =
                    local_ring_at(part, angle, &tol).and_then(|local| BoundsMm::from_ring(&local));
                local_bounds_cache.insert(cache_key, computed);
                computed
            };
            if let Some(bounds) = local_bounds {
                angles.push((angle, bounds));
            }
        }
        if angles.is_empty() {
            continue;
        }

        // Xếp hạng target chỉ bằng bbox rẻ. Va chạm contour thật chỉ chạy cho đúng một
        // target đã chọn ở vòng dưới, nhờ vậy số pose đắt vẫn bị khóa ở 3 × 5.
        let mut best_theoretical_area = envelope_area;
        for (angle, local_bounds) in &angles {
            for pose in
                rotation_probe_bbox_anchors(*angle, placement_geometry[index].2, *local_bounds)
            {
                let moved = translated_bounds(*local_bounds, &pose);
                if !placement_bounds.contains_bounds(&moved, &tol) {
                    continue;
                }
                let candidate = without.map_or(moved, |bounds| union_bounds(bounds, moved));
                best_theoretical_area =
                    best_theoretical_area.min(candidate.width_mm() * candidate.height_mm());
            }
        }
        let potential_improvement = envelope_area - best_theoretical_area;
        if potential_improvement <= area_tolerance_mm2 {
            continue;
        }

        let should_replace =
            target
                .as_ref()
                .is_none_or(|(best_index, _, best_potential, best_contribution)| {
                    potential_improvement > *best_potential + area_tolerance_mm2
                        || ((potential_improvement - *best_potential).abs() <= area_tolerance_mm2
                            && (contribution > *best_contribution + area_tolerance_mm2
                                || ((contribution - *best_contribution).abs()
                                    <= area_tolerance_mm2
                                    && index > *best_index)))
                });
        if should_replace {
            target = Some((index, angles, potential_improvement, contribution));
        }
    }
    let Some((target_index, angles, _, _)) = target else {
        return Ok(RotationProbeOutcome {
            screen_bounds_evaluations,
            ..RotationProbeOutcome::default()
        });
    };
    let target_part = placement_geometry[target_index].0;
    let target_bounds = placement_geometry[target_index].2;
    let target_placement_bounds = request.placement_bounds_for(target_part);

    // PERF (audit 2026-08-29 §ROTATION-WARM-START): contour đã thuộc request/
    // placement_geometry và sống suốt probe; chỉ mượn slice thay vì clone toàn bộ.
    let fixed_count = request.fixed_obstacles().len();
    let mut placed_rings: Vec<(&[PointMm], BoundsMm)> =
        Vec::with_capacity(fixed_count + placement_geometry.len().saturating_sub(1));
    for obstacle in request.fixed_obstacles() {
        placed_rings.push((obstacle.outer.as_slice(), obstacle.bounds));
    }
    for (index, (_, ring, bounds)) in placement_geometry.iter().enumerate() {
        if index == target_index {
            continue;
        }
        placed_rings.push((ring.as_slice(), *bounds));
    }

    debug_assert_eq!(
        fixed_count + placement_geometry.len().saturating_sub(1),
        placed_rings.len()
    );
    let mut attempts = 0u64;
    let mut orientation_evaluations = 0u64;
    let mut best: Option<(LayoutScore, Vec<PlacementRecord>)> = None;
    let mut working_placements = baseline.placements.clone();

    for (angle, local_bounds) in angles {
        control.checkpoint_cancel_only()?;
        orientation_evaluations += 1;
        let proposed = rotation_probe_bbox_anchors(angle, target_bounds, local_bounds);
        let mut poses: Vec<Pose> = Vec::with_capacity(proposed.len());
        for pose in proposed {
            if poses.iter().any(|kept| {
                (kept.translate_x_mm - pose.translate_x_mm).abs() <= tol.linear_mm
                    && (kept.translate_y_mm - pose.translate_y_mm).abs() <= tol.linear_mm
            }) {
                continue;
            }
            poses.push(pose);
        }

        for pose in poses {
            control.checkpoint_cancel_only()?;
            attempts += 1;
            let Ok(ring) = place_ring_checked(
                &target_part.outer,
                &pose,
                target_part.reference_point_mm,
                &tol,
            ) else {
                continue;
            };
            if !ring_within_bounds(&ring, &envelope, &tol)
                || !ring_within_bounds(&ring, &target_placement_bounds, &tol)
            {
                continue;
            }
            let Some(bounds) = BoundsMm::from_ring(&ring) else {
                continue;
            };
            let clash = placed_rings
                .iter()
                .enumerate()
                .any(|(index, (other, other_bounds))| {
                    let is_fixed_obstacle = index < fixed_count;
                    let clearance = blocker_clearance_for_request(request, is_fixed_obstacle);
                    bbox_may_clash(&bounds, other_bounds, clearance, &tol)
                        && pair_clashes_for_request(request, &ring, other, is_fixed_obstacle)
                });
            if clash {
                continue;
            }

            working_placements[target_index].pose = pose;
            let score = score_layout(request, &working_placements, 0);
            if score.is_better_than(baseline_score)
                && best
                    .as_ref()
                    .is_none_or(|(current, _)| score.is_better_than(current))
            {
                // Chỉ clone khi candidate thực sự trở thành best; các pose thử dùng
                // chung một working buffer và chỉ thay pose của target.
                best = Some((score, working_placements.clone()));
            }
        }
    }

    let (score, placements) = best.map_or((None, None), |(score, placements)| {
        (Some(score), Some(placements))
    });
    Ok(RotationProbeOutcome {
        placements,
        score,
        attempts,
        orientation_evaluations,
        screen_bounds_evaluations,
    })
}
