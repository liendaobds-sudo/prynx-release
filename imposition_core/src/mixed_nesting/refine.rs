//! Tinh chỉnh pose liên tục theo `(theta, tx, ty)` (P3b).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2, §11.3.
//!
//! ## Đây là chỗ free-angle trở thành thật
//!
//! [`super::candidates`] chỉ đưa ra một tập mẫu hữu hạn. Module này đẩy pose ra khỏi tập
//! mẫu đó bằng hai cơ chế **liên tục**:
//!
//! 1. [`slide_to_contact`] — trượt chi tiết theo một hướng cho tới **tiếp xúc đầu tiên**,
//!    bằng chia đôi trên khoảng cách. Kết quả là một số thực bất kỳ, không phải bội của
//!    bước nào.
//! 2. [`refine_pose`] — tìm kiếm mẫu (pattern search) không dùng đạo hàm trên cả ba biến,
//!    với bước **co dần**. Bước co dần là cơ chế tìm kiếm được §11.3 điểm 3 cho phép; nó
//!    khác hoàn toàn với "bước góc cố định" bị cấm, vì bước tiến tới 0 và pose cuối là số
//!    thực liên tục.
//!
//! ## Đổi góc thì phải giải lại vị trí
//!
//! §11.3 điểm 4: "Mỗi lần đổi `theta` phải giải lại `tx/ty`; không xoay part tại chỗ rồi
//! giữ nguyên location." [`try_rotate_and_relocate`] thực thi đúng điều đó: sau khi xoay,
//! nó **luôn** trượt lại về tiếp xúc thay vì giữ nguyên vị trí cũ.

use std::cmp::Ordering;

use super::collision::{judge_pair, judge_pair_sheet_axis, min_distance_mm, ring_within_bounds};
use super::control::{Interrupt, RunControl, SearchEffort};
use super::model::{canonicalize_angle_deg, PointMm, Pose, SheetAxisClearanceMm, Tolerance};
use super::normalize::{BoundsMm, NormalizedPart};
use super::score::SCORE_LENGTH_QUANTUM_MM;
use super::transform::place_ring_checked;

/// Version của quy tắc tinh chỉnh.
pub const REFINE_RULE_VERSION: u32 = 2;

/// Trần số bước tiến an toàn khi trượt tới tiếp xúc.
///
/// Ca thường gặp (trượt thẳng vào một vật cản, hoặc trượt tới biên tờ) chỉ tốn **1–2 bước**
/// vì khoảng tiến an toàn khi đó đúng bằng khoảng hở theo hướng trượt. Trần này chỉ để chặn
/// ca trượt song song sát vật cản, nơi mỗi bước tiến rất ít; khi chạm trần, kết quả vẫn
/// **hợp lệ** — chỉ là chưa chặt nhất.
pub const SLIDE_ADVANCE_STEPS: u32 = 64;

/// Bước góc khởi đầu của pattern search, degree. **Co dần về 0**, không phải bước cố định.
pub const REFINE_INITIAL_ANGLE_STEP_DEG: f64 = 8.0;

/// Bước tịnh tiến khởi đầu của pattern search, mm. Co dần về 0.
pub const REFINE_INITIAL_TRANSLATION_STEP_MM: f64 = 8.0;

/// Ngữ cảnh legacy dùng clearance Euclid vô hướng.
pub struct RefineContext<'a> {
    pub part: &'a NormalizedPart,
    /// Contour của các chi tiết **đã đặt trên cùng tờ**, đã transform.
    pub placed: &'a [Vec<PointMm>],
    pub usable: &'a BoundsMm,
    pub gap_mm: f64,
    pub tol: Tolerance,
}

/// Ngữ cảnh production giữ riêng part↔part và part↔obstacle theo trục tờ.
pub struct ProductionRefineContext<'a> {
    pub part: &'a NormalizedPart,
    pub placed_parts: &'a [Vec<PointMm>],
    pub fixed_obstacles: &'a [Vec<PointMm>],
    pub usable: &'a BoundsMm,
    pub part_clearance: SheetAxisClearanceMm,
    pub obstacle_clearance: SheetAxisClearanceMm,
    pub tol: Tolerance,
}

trait RefineGeometryContext {
    fn part(&self) -> &NormalizedPart;
    fn usable(&self) -> &BoundsMm;
    fn tolerance(&self) -> Tolerance;
    fn is_valid_ring(&self, ring: &[PointMm]) -> bool;
    fn safe_advance_mm(&self, ring: &[PointMm]) -> f64;
    fn lift_clearance_mm(&self) -> f64;

    fn ring_at(&self, pose: &Pose) -> Option<Vec<PointMm>> {
        let part = self.part();
        place_ring_checked(
            &part.outer,
            pose,
            part.reference_point_mm,
            &self.tolerance(),
        )
        .ok()
    }

    fn valid_ring_at(&self, pose: &Pose) -> Option<Vec<PointMm>> {
        let ring = self.ring_at(pose)?;
        self.is_valid_ring(&ring).then_some(ring)
    }
}

impl RefineGeometryContext for RefineContext<'_> {
    fn part(&self) -> &NormalizedPart {
        self.part
    }

    fn usable(&self) -> &BoundsMm {
        self.usable
    }

    fn tolerance(&self) -> Tolerance {
        self.tol
    }

    fn is_valid_ring(&self, ring: &[PointMm]) -> bool {
        ring_within_bounds(ring, self.usable, &self.tol)
            && !self
                .placed
                .iter()
                .any(|other| !judge_pair(ring, other, self.gap_mm, &self.tol).is_ok())
    }

    fn safe_advance_mm(&self, ring: &[PointMm]) -> f64 {
        self.placed.iter().fold(f64::MAX, |safe, other| {
            safe.min((min_distance_mm(ring, other, &self.tol) - self.gap_mm).max(0.0))
        })
    }

    fn lift_clearance_mm(&self) -> f64 {
        self.gap_mm
    }
}

impl RefineGeometryContext for ProductionRefineContext<'_> {
    fn part(&self) -> &NormalizedPart {
        self.part
    }

    fn usable(&self) -> &BoundsMm {
        self.usable
    }

    fn tolerance(&self) -> Tolerance {
        self.tol
    }

    fn is_valid_ring(&self, ring: &[PointMm]) -> bool {
        ring_within_bounds(ring, self.usable, &self.tol)
            && !self.placed_parts.iter().any(|other| {
                !judge_pair_sheet_axis(ring, other, self.part_clearance, &self.tol).is_ok()
            })
            && !self.fixed_obstacles.iter().any(|obstacle| {
                !judge_pair_sheet_axis(ring, obstacle, self.obstacle_clearance, &self.tol).is_ok()
            })
    }

    fn safe_advance_mm(&self, ring: &[PointMm]) -> f64 {
        let part_radius = self.part_clearance.x_mm.hypot(self.part_clearance.y_mm);
        let obstacle_radius = self
            .obstacle_clearance
            .x_mm
            .hypot(self.obstacle_clearance.y_mm);
        let part_safe = self.placed_parts.iter().fold(f64::MAX, |safe, other| {
            safe.min((min_distance_mm(ring, other, &self.tol) - part_radius).max(0.0))
        });
        self.fixed_obstacles
            .iter()
            .fold(part_safe, |safe, obstacle| {
                safe.min((min_distance_mm(ring, obstacle, &self.tol) - obstacle_radius).max(0.0))
            })
    }

    fn lift_clearance_mm(&self) -> f64 {
        self.part_clearance
            .x_mm
            .hypot(self.part_clearance.y_mm)
            .max(
                self.obstacle_clearance
                    .x_mm
                    .hypot(self.obstacle_clearance.y_mm),
            )
    }
}

impl RefineContext<'_> {
    pub fn ring_at(&self, pose: &Pose) -> Option<Vec<PointMm>> {
        RefineGeometryContext::ring_at(self, pose)
    }

    pub fn is_valid(&self, ring: &[PointMm]) -> bool {
        self.is_valid_ring(ring)
    }
}

impl ProductionRefineContext<'_> {
    pub fn ring_at(&self, pose: &Pose) -> Option<Vec<PointMm>> {
        RefineGeometryContext::ring_at(self, pose)
    }

    pub fn is_valid(&self, ring: &[PointMm]) -> bool {
        self.is_valid_ring(ring)
    }
}

/// Mục tiêu cục bộ: đẩy chi tiết về góc trái dưới càng sâu càng tốt.
///
/// Lượng tử hoá về `i64` trước khi so nên quan hệ là **thứ tự toàn phần**; hai pose lệch
/// nhau dưới dung sai không đảo thứ tự tuỳ nhiễu `f64`. Cùng lý do như
/// [`super::score`]: mất tính bắc cầu là mất tính xác định.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LocalObjective {
    min_y_fixed: i64,
    min_x_fixed: i64,
}

impl LocalObjective {
    /// Tính mục tiêu từ contour đã đặt. Nhỏ hơn là tốt hơn.
    pub fn of(ring: &[PointMm]) -> Option<Self> {
        let bounds = BoundsMm::from_ring(ring)?;
        Some(Self {
            min_y_fixed: quantize(bounds.min_y),
            min_x_fixed: quantize(bounds.min_x),
        })
    }
}

fn quantize(value: f64) -> i64 {
    if !value.is_finite() {
        return i64::MAX;
    }
    let scaled = value / SCORE_LENGTH_QUANTUM_MM;
    if scaled >= i64::MAX as f64 {
        i64::MAX
    } else if scaled <= i64::MIN as f64 {
        i64::MIN
    } else {
        scaled.round() as i64
    }
}

/// Trượt chi tiết theo hướng `(dx, dy)` tới **tiếp xúc đầu tiên**.
///
/// Trả `None` nếu ngay pose khởi đầu đã không hợp lệ — nơi gọi phải xử lý riêng, không
/// được coi là "trượt 0". Kết quả là **số thực liên tục**: đây chính là cơ chế mà §11.2
/// gọi là "slide/push liên tục theo X/Y và tiếp tuyến tới first contact".
///
/// ## Vì sao KHÔNG chia đôi trên khoảng cách
///
/// Bản đầu của lượt P3b dùng chia đôi và **sai**. Chia đôi đòi vị từ "còn hợp lệ" phải
/// đơn điệu dọc tia, nhưng khi tia **xuyên qua** một vật cản thì tập hợp lệ bị tách thành
/// hai khoảng rời: trước vật cản và sau vật cản. Chia đôi hội tụ về mép của khoảng xa,
/// tức trượt **vượt qua** vật cản rồi dừng ở đâu đó bên kia. Test
/// `truot_toi_tiep_xuc_cho_so_thuc_lien_tuc` bắt đúng lỗi này: nó trượt tới lề dưới thay
/// vì dừng trên nóc vật cản.
///
/// ## Cách đúng: tiến từng bước an toàn (conservative advancement)
///
/// Di chuyển một quãng `t` chỉ có thể **giảm** khoảng cách tới vật cản nhiều nhất là `t`.
/// Vì vậy tiến đúng bằng khoảng hở hiện tại thì **không thể** va vào gì. Lặp lại cho tới
/// khi khoảng hở về 0. Cách này không bao giờ nhảy qua vật cản, dù mỏng đến đâu.
///
/// Kèm theo là khoảng chạy tới biên vùng dùng được, tính **chính xác** cho hộp bao theo
/// hướng đang trượt — nhờ đó ca không có vật cản chỉ tốn một bước.
///
/// Giới hạn đã biết: khi trượt **song song sát** một vật cản, khoảng hở giữ nguyên nhỏ nên
/// mỗi bước tiến rất ít và trần vòng lặp có thể chặn trước khi tới tiếp xúc. Khi đó kết quả
/// vẫn **hợp lệ**, chỉ là chưa chặt nhất — mất một tối ưu, không sai correctness. Quan toà
/// độc lập vẫn là chốt cuối.
pub fn slide_to_contact(
    context: &RefineContext<'_>,
    start: &Pose,
    direction: (f64, f64),
    max_distance_mm: f64,
) -> Option<Pose> {
    slide_to_contact_impl(context, start, direction, max_distance_mm)
}

fn slide_to_contact_impl<C: RefineGeometryContext>(
    context: &C,
    start: &Pose,
    direction: (f64, f64),
    max_distance_mm: f64,
) -> Option<Pose> {
    let tol = context.tolerance();
    let start_ring = context.ring_at(start)?;
    if !context.is_valid_ring(&start_ring) {
        return None;
    }
    let length = (direction.0 * direction.0 + direction.1 * direction.1).sqrt();
    if !length.is_finite() || length <= tol.linear_mm || !max_distance_mm.is_finite() {
        return Some(*start);
    }
    let (ux, uy) = (direction.0 / length, direction.1 / length);
    let at = |distance: f64| -> Pose {
        Pose::new(
            start.rotation_deg,
            start.translate_x_mm + ux * distance,
            start.translate_y_mm + uy * distance,
        )
    };

    let mut travelled = 0.0f64;
    let mut ring = start_ring;
    for _ in 0..SLIDE_ADVANCE_STEPS {
        let remaining = max_distance_mm - travelled;
        if remaining <= tol.linear_mm {
            break;
        }
        // Với production, hypot chỉ là bước tiến bảo thủ; validity vẫn dùng rectangle
        // sheet-axis riêng cho part và obstacle, nên bound này không loại pose hợp lệ.
        let mut safe = remaining.min(context.safe_advance_mm(&ring));
        if let Some(bounds) = BoundsMm::from_ring(&ring) {
            safe = safe.min(boundary_slack_mm(&bounds, context.usable(), ux, uy));
        }
        if safe <= tol.linear_mm {
            break;
        }
        let next = travelled + safe;
        let Some(next_ring) = context.valid_ring_at(&at(next)) else {
            // Không thể xảy ra theo lập luận trên; nếu xảy ra thì dừng ở vị trí hợp lệ
            // cuối cùng thay vì nhận một pose chưa kiểm.
            break;
        };
        travelled = next;
        ring = next_ring;
    }
    Some(at(travelled))
}

/// Khoảng cách còn chạy được theo hướng `(ux, uy)` trước khi hộp bao ra khỏi `usable`, mm.
///
/// Tính đóng, không lặp: mỗi cạnh của vùng cho một chặn trên, lấy min các chặn có hiệu lực.
fn boundary_slack_mm(bounds: &BoundsMm, usable: &BoundsMm, ux: f64, uy: f64) -> f64 {
    let mut slack = f64::MAX;
    if ux > 0.0 {
        slack = slack.min((usable.max_x - bounds.max_x) / ux);
    } else if ux < 0.0 {
        slack = slack.min((usable.min_x - bounds.min_x) / ux);
    }
    if uy > 0.0 {
        slack = slack.min((usable.max_y - bounds.max_y) / uy);
    } else if uy < 0.0 {
        slack = slack.min((usable.min_y - bounds.min_y) / uy);
    }
    slack.max(0.0)
}

/// Ép chi tiết về góc trái dưới: trượt xuống tới tiếp xúc, rồi trượt sang trái, lặp lại.
///
/// Lặp vì sau khi sang trái có thể lại tụt xuống được — đó là cách "compact" thật, khác
/// với việc đặt vào một ô lưới.
pub fn compact_bottom_left(context: &RefineContext<'_>, start: &Pose, rounds: u32) -> Option<Pose> {
    compact_bottom_left_impl(context, start, rounds)
}

fn compact_bottom_left_impl<C: RefineGeometryContext>(
    context: &C,
    start: &Pose,
    rounds: u32,
) -> Option<Pose> {
    let tol = context.tolerance();
    let mut current = *start;
    context.valid_ring_at(&current)?;
    let span = (context.usable().width_mm() + context.usable().height_mm()).max(1.0);
    for _ in 0..rounds.max(1) {
        let before = (current.translate_x_mm, current.translate_y_mm);
        if let Some(next) = slide_to_contact_impl(context, &current, (0.0, -1.0), span) {
            current = next;
        }
        if let Some(next) = slide_to_contact_impl(context, &current, (-1.0, 0.0), span) {
            current = next;
        }
        let moved =
            (current.translate_x_mm - before.0).abs() + (current.translate_y_mm - before.1).abs();
        if moved <= tol.linear_mm {
            break;
        }
    }
    Some(current)
}

/// Xoay rồi **giải lại vị trí** — không bao giờ xoay tại chỗ.
///
/// Sau khi đổi góc, hình dạng chiếm chỗ đổi hẳn, nên vị trí cũ gần như luôn hoặc phạm
/// luật hoặc bỏ trống chỗ. Vì vậy hàm này ép nén lại về góc trái dưới từ chính vị trí
/// hiện tại; nếu vị trí đó không còn hợp lệ thì thử nhấc lên rồi nén lại.
pub fn try_rotate_and_relocate(
    context: &RefineContext<'_>,
    current: &Pose,
    delta_deg: f64,
) -> Option<Pose> {
    try_rotate_and_relocate_impl(context, current, delta_deg)
}

fn try_rotate_and_relocate_impl<C: RefineGeometryContext>(
    context: &C,
    current: &Pose,
    delta_deg: f64,
) -> Option<Pose> {
    let tol = context.tolerance();
    let angle = canonicalize_angle_deg(current.rotation_deg + delta_deg, &tol)?;
    if !context.part().rotation_domain.contains(angle, &tol) {
        return None;
    }
    let rotated = Pose::new(angle, current.translate_x_mm, current.translate_y_mm);
    if context.valid_ring_at(&rotated).is_some() {
        return compact_bottom_left_impl(context, &rotated, 4);
    }
    // Vị trí cũ không còn dùng được sau khi xoay: nhấc lên và sang phải một quãng bằng
    // đường kính chi tiết, rồi nén lại. Quãng nhấc suy từ hình học, không phải hằng số.
    let lift = context
        .part()
        .bounds
        .diagonal_mm()
        .max(context.lift_clearance_mm() * 2.0)
        .max(1.0);
    for offset in [(0.0, lift), (lift, 0.0), (lift, lift)] {
        let lifted = Pose::new(
            angle,
            current.translate_x_mm + offset.0,
            current.translate_y_mm + offset.1,
        );
        if context.valid_ring_at(&lifted).is_some() {
            return compact_bottom_left_impl(context, &lifted, 4);
        }
    }
    None
}

/// Kết quả tinh chỉnh.
#[derive(Debug, Clone, PartialEq)]
pub struct RefinedPose {
    pub pose: Pose,
    pub ring: Vec<PointMm>,
    pub objective: LocalObjective,
    /// Số lần thử pose trong quá trình tinh chỉnh — vào `stats.poseRefinements`.
    pub evaluations: u64,
}

/// Tinh chỉnh đồng thời `(theta, tx, ty)` quanh một pose khởi đầu hợp lệ.
///
/// Pattern search không dùng đạo hàm. Mỗi vòng thử một tập nước đi; vòng nào không cải
/// thiện thì **giảm một nửa cả bước góc lẫn bước tịnh tiến**. Vì bước tiến tới 0, pose
/// cuối cùng là số thực liên tục và thường không nằm trong tập mẫu ban đầu.
///
/// Có checkpoint hủy trong vòng lặp: §11.3 yêu cầu mỗi batch refinement phải hủy được.
pub fn refine_pose(
    context: &RefineContext<'_>,
    start: &Pose,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<Option<RefinedPose>, Interrupt> {
    refine_pose_impl(context, start, effort, control)
}

pub fn refine_pose_production(
    context: &ProductionRefineContext<'_>,
    start: &Pose,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<Option<RefinedPose>, Interrupt> {
    refine_pose_impl(context, start, effort, control)
}

fn refine_pose_impl<C: RefineGeometryContext>(
    context: &C,
    start: &Pose,
    effort: SearchEffort,
    control: &RunControl,
) -> Result<Option<RefinedPose>, Interrupt> {
    let tol = context.tolerance();
    let Some(start_ring) = context.valid_ring_at(start) else {
        return Ok(None);
    };
    let Some(start_objective) = LocalObjective::of(&start_ring) else {
        return Ok(None);
    };

    let mut best = RefinedPose {
        pose: *start,
        ring: start_ring,
        objective: start_objective,
        evaluations: 0,
    };

    // Nén ngay từ đầu: đó là nước đi rẻ nhất và gần như luôn cải thiện.
    if let Some(compacted) = compact_bottom_left_impl(context, &best.pose, 6) {
        charge_evaluation(&mut best, control);
        accept_if_better(context, &mut best, compacted);
    }

    let can_rotate = context.part().rotation_domain.is_continuous();
    let mut angle_step = REFINE_INITIAL_ANGLE_STEP_DEG;
    let mut translation_step = REFINE_INITIAL_TRANSLATION_STEP_MM;

    for _ in 0..effort.refinement_rounds.max(1) {
        control.checkpoint()?;
        let mut improved = false;

        // ── Nước đi xoay: mỗi lần đổi góc đều giải lại vị trí ──
        if can_rotate {
            for delta in [angle_step, -angle_step] {
                if let Some(candidate) = try_rotate_and_relocate_impl(context, &best.pose, delta) {
                    charge_evaluation(&mut best, control);
                    if accept_if_better(context, &mut best, candidate) {
                        improved = true;
                    }
                }
            }
        }

        // ── Nước đi tịnh tiến: bốn trục chính cộng hai tiếp tuyến của cạnh hiện tại ──
        let mut directions: Vec<(f64, f64)> = vec![
            (1.0, 0.0),
            (-1.0, 0.0),
            (0.0, 1.0),
            (0.0, -1.0),
            (-1.0, -1.0),
        ];
        // Tiếp tuyến theo góc hiện tại: cho chi tiết trượt dọc cạnh của chính nó, là
        // hướng duy nhất lồng được hai hình lõm vào nhau ở góc không-cardinal.
        let radians = best.pose.rotation_deg.to_radians();
        directions.push((radians.cos(), radians.sin()));
        directions.push((-radians.cos(), -radians.sin()));
        directions.push((-radians.sin(), radians.cos()));
        directions.push((radians.sin(), -radians.cos()));

        for direction in directions {
            let stepped = Pose::new(
                best.pose.rotation_deg,
                best.pose.translate_x_mm + direction.0 * translation_step,
                best.pose.translate_y_mm + direction.1 * translation_step,
            );
            charge_evaluation(&mut best, control);
            if context.valid_ring_at(&stepped).is_some() {
                if let Some(compacted) = compact_bottom_left_impl(context, &stepped, 4) {
                    if accept_if_better(context, &mut best, compacted) {
                        improved = true;
                    }
                }
            } else if let Some(slid) =
                slide_to_contact_impl(context, &best.pose, direction, translation_step)
            {
                if let Some(compacted) = compact_bottom_left_impl(context, &slid, 4) {
                    if accept_if_better(context, &mut best, compacted) {
                        improved = true;
                    }
                }
            }
        }

        if !improved {
            // Không cải thiện ⇒ soi kỹ hơn. Bước tiến tới 0 nên pose cuối là liên tục.
            angle_step *= 0.5;
            translation_step *= 0.5;
            if angle_step <= tol.angular_deg && translation_step <= tol.linear_mm {
                break;
            }
        }
    }

    Ok(Some(best))
}

/// Ghi một lần đánh giá pose vào **cả hai** nơi: thống kê của lượt tinh chỉnh và ngân
/// sách work-plan của [`RunControl`].
///
/// PERF (sửa 2026-08-26): trước bản này `refine_pose` chỉ tăng `best.evaluations` mà
/// **không** gọi [`RunControl::charge_evaluations`]. Hệ quả đo được: ca `S20` của corpus
/// báo `attempts = 7.155` và `orientationEvaluations = 260` (đều đã nạp) nhưng
/// `poseRefinements = 467.277` (không nạp) — tức 98,4% công việc thật nằm ngoài ngân sách.
/// Vì vậy `evaluation_budget` không bao giờ bít và work-plan cố định vẫn xác định nhưng
/// **không chặn được thời gian chạy** (44,2 giây ở `balanced` cho 20 con hình chữ nhật).
///
/// Dùng một hàm duy nhất cho cả hai bộ đếm để chúng không thể lệch nhau về sau.
fn charge_evaluation(best: &mut RefinedPose, control: &RunControl) {
    best.evaluations += 1;
    control.charge_evaluations(1);
}

/// Nhận nước đi nếu nó **hợp lệ** và **tốt hơn**. Trả `true` khi đã nhận.
fn accept_if_better<C: RefineGeometryContext>(
    context: &C,
    best: &mut RefinedPose,
    candidate: Pose,
) -> bool {
    let Some(ring) = context.valid_ring_at(&candidate) else {
        return false;
    };
    let Some(objective) = LocalObjective::of(&ring) else {
        return false;
    };
    if objective.cmp(&best.objective) != Ordering::Less {
        return false;
    }
    best.pose = candidate;
    best.ring = ring;
    best.objective = objective;
    true
}
