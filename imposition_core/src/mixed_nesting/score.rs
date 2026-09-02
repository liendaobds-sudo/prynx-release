//! Điểm chuẩn để so hai phương án lồng ghép (P3a).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.5.
//!
//! ## Một định nghĩa duy nhất, dùng ở mọi nơi
//!
//! §11.5 yêu cầu điểm dùng cho solver, so với baseline, benchmark và báo cáo UI phải là
//! **cùng một định nghĩa**. Vì vậy module này là nơi duy nhất định nghĩa thứ tự so sánh;
//! không nơi nào khác được tự nghĩ ra tiêu chí "tốt hơn".
//!
//! ## Thứ tự lexicographic
//!
//! 1. Ít `unplaced` hơn.
//! 2. Ít tờ hơn.
//! 3. Vùng bao đã dùng của **tờ cuối** nhỏ hơn — để phần vật liệu dư còn hữu dụng.
//! 4. Compactness tốt hơn: tổng diện tích **bỏ không trong vùng bao đã dùng** nhỏ hơn.
//! 5. Tie-break xác định theo canonical placement key
//!    `(sheetIndex, partId, angleCanonical, xFixed, yFixed)`.
//!
//! ## Vì sao mọi thứ là số nguyên
//!
//! §11.5 ghi: "So sánh số thực phải epsilon-aware hoặc dùng metric fixed-point; parallel
//! reduction không được phụ thuộc thứ tự thread hoàn tất." Cách chắc chắn nhất là **lượng
//! tử hoá về `i64`** rồi so bằng [`Ord`] dẫn xuất: quan hệ trở thành **thứ tự toàn phần
//! thực sự**, nên `reduce` song song cho cùng kết quả bất kể thứ tự gộp. So `f64` với
//! epsilon không cho tính bắc cầu, và mất bắc cầu là mất tính xác định.
//!
//! ## `materialUtilization` KHÔNG nằm trong thứ tự
//!
//! Với cùng tập chi tiết và cùng số tờ, `materialUtilization` **không đổi** theo cách sắp
//! xếp (tử số và mẫu số đều cố định). Dùng nó làm tie-break là tự tạo một tiêu chí giả.
//! Nó vẫn là thống kê bắt buộc báo cáo, nhưng do [`super::validator`] tính lại.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use super::model::{
    canonicalize_angle_deg, PlacementRecord, PointMm, Tolerance, MAX_INSTANCES_TOTAL,
};
use super::normalize::{BoundsMm, NormalizedPart, NormalizedRequest};
use super::transform::place_ring_checked;

/// Version của định nghĩa điểm. Đổi tiêu chí là đổi layout ⇒ phải tăng số này.
pub const SCORE_VERSION: u32 = 2;

/// Lượng tử diện tích khi lượng tử hoá về `i64`, mm².
///
/// `1e-3 mm²` mịn hơn mọi khác biệt có ý nghĩa sản xuất vài bậc, và ở khổ tờ lớn nhất
/// (`8000 × 8000 mm`) vẫn chỉ tới `6.4e10` đơn vị — còn cách `i64::MAX` rất xa.
pub const SCORE_AREA_QUANTUM_MM2: f64 = 1e-3;

/// Lượng tử toạ độ khi dựng tie-break key, mm.
///
/// Bằng đúng `Tolerance::v1().linear_mm`: hai pose cách nhau dưới dung sai được coi là
/// một trong tie-break, đúng ngữ nghĩa "cùng một phương án".
pub const SCORE_LENGTH_QUANTUM_MM: f64 = 1e-6;

/// Lượng tử góc khi dựng tie-break key, degree.
pub const SCORE_ANGLE_QUANTUM_DEG: f64 = 1e-6;

fn quantize(value: f64, quantum: f64) -> i64 {
    if !value.is_finite() {
        // Giá trị bệnh phải xếp **tệ nhất** để không bao giờ thắng một phương án hợp lệ.
        return i64::MAX;
    }
    let scaled = value / quantum;
    if scaled >= i64::MAX as f64 {
        i64::MAX
    } else if scaled <= i64::MIN as f64 {
        i64::MIN
    } else {
        scaled.round() as i64
    }
}

/// Khoá canonical của một placement — dùng cho tie-break xác định.
///
/// Thứ tự dẫn xuất theo đúng thứ tự trường, khớp §11.5 điểm 5.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PlacementKey {
    pub sheet_index: u32,
    pub part_id: String,
    pub angle_fixed: i64,
    pub x_fixed: i64,
    pub y_fixed: i64,
}

impl PlacementKey {
    /// Dựng khoá từ một placement. Góc được canonical hoá trước khi lượng tử.
    pub fn from_placement(record: &PlacementRecord, tol: &Tolerance) -> Self {
        let angle = canonicalize_angle_deg(record.pose.rotation_deg, tol).unwrap_or(f64::INFINITY);
        Self {
            sheet_index: record.sheet_index,
            part_id: record.part_id.clone(),
            angle_fixed: quantize(angle, SCORE_ANGLE_QUANTUM_DEG),
            x_fixed: quantize(record.pose.translate_x_mm, SCORE_LENGTH_QUANTUM_MM),
            y_fixed: quantize(record.pose.translate_y_mm, SCORE_LENGTH_QUANTUM_MM),
        }
    }
}

/// Điểm của một phương án. So sánh bằng [`Ord`]: **nhỏ hơn là tốt hơn**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutScore {
    /// Số placement **không dựng lại được** (mã chi tiết lạ, pose bệnh, phép không cứng).
    ///
    /// Đây là **chốt an toàn nằm NGOÀI thứ tự §11.5**, so trước mọi tiêu chí khác. Lý do
    /// đã trả giá trong lượt P3a: bản đầu chỉ đánh dấu hai trường diện tích là "tệ nhất",
    /// nhưng một layout toàn placement hỏng lại báo `sheet_count = 0` (không dựng được
    /// tờ nào) và **thắng** ở tiêu chí 2. Một phương án không dựng lại được thì không
    /// phải phương án, nên nó phải bị loại trước khi đếm tờ.
    pub invalid_count: u64,
    /// Tiêu chí 1.
    ///
    /// Với `quantity_fulfillment`, đây vẫn là số con chưa xếp, bit-identical với v1.
    /// Với `autofill_single_sheet`, đây là penalty tổng hợp: ưu tiên tăng số placement
    /// ít nhất của mọi part, rồi tăng tổng placement. Xem [`autofill_penalty`].
    pub unplaced_count: u64,
    /// Tiêu chí 2 — số tờ đã dùng.
    pub sheet_count: u32,
    /// Tiêu chí 3 — diện tích vùng bao đã dùng của tờ cuối, lượng tử hoá.
    pub last_sheet_used_area_fixed: i64,
    /// Tiêu chí 4 — tổng diện tích bỏ không trong vùng bao đã dùng, lượng tử hoá.
    pub wasted_within_envelope_fixed: i64,
    /// Tiêu chí 5 — khoá canonical đã sắp, quyết định khi bốn tiêu chí trên bằng nhau.
    pub tie_break: Vec<PlacementKey>,
    pub score_version: u32,
}

/// Mã hoá hai tiêu chí autofill đầu tiên vào một số nguyên "nhỏ hơn là tốt hơn".
///
/// `MAX_INSTANCES_TOTAL + 1` là cơ số an toàn: cải thiện `min(count mỗi part)` đúng một
/// đơn vị luôn thắng mọi chênh lệch có thể có của tổng placement. Contract và baseline
/// cùng chặn tổng placement ở `MAX_INSTANCES_TOTAL`.
fn autofill_penalty(placed_per_part: &BTreeMap<&str, u64>) -> u64 {
    let minimum = placed_per_part
        .values()
        .copied()
        .min()
        .unwrap_or(0)
        .min(MAX_INSTANCES_TOTAL);
    let total = placed_per_part
        .values()
        .copied()
        .fold(0u64, u64::saturating_add)
        .min(MAX_INSTANCES_TOTAL);
    let radix = MAX_INSTANCES_TOTAL.saturating_add(1);
    MAX_INSTANCES_TOTAL
        .saturating_sub(minimum)
        .saturating_mul(radix)
        .saturating_add(MAX_INSTANCES_TOTAL.saturating_sub(total))
}

impl LayoutScore {
    /// Phương án này tốt hơn `other` hay không.
    pub fn is_better_than(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Less
    }

    /// Trả về phương án tốt hơn trong hai phương án.
    ///
    /// Vì thứ tự là **toàn phần**, phép gộp này có tính kết hợp và giao hoán về kết quả:
    /// `reduce` song song cho cùng đáp án bất kể thứ tự thread hoàn tất.
    pub fn better_of<'a>(left: &'a Self, right: &'a Self) -> &'a Self {
        if right.is_better_than(left) {
            right
        } else {
            left
        }
    }
}

impl PartialOrd for LayoutScore {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LayoutScore {
    fn cmp(&self, other: &Self) -> Ordering {
        // Không so `score_version` trong thứ tự: hai phiên bản điểm khác nhau không được
        // so với nhau, việc đó do nơi gọi chặn.
        self.invalid_count
            .cmp(&other.invalid_count)
            .then(self.unplaced_count.cmp(&other.unplaced_count))
            .then(self.sheet_count.cmp(&other.sheet_count))
            .then(
                self.last_sheet_used_area_fixed
                    .cmp(&other.last_sheet_used_area_fixed),
            )
            .then(
                self.wasted_within_envelope_fixed
                    .cmp(&other.wasted_within_envelope_fixed),
            )
            .then(self.tie_break.cmp(&other.tie_break))
    }
}

/// Tính điểm của một phương án.
///
/// Cần dựng lại contour đã transform để lấy vùng bao thật, nên hàm này gọi
/// [`place_ring_checked`] — cũng là đường đã kiểm không-phản-chiếu. Placement không dựng
/// được sẽ bị tính là **xấu nhất** thay vì bị bỏ qua im lặng.
pub fn score_layout(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
    unplaced_count: u64,
) -> LayoutScore {
    let tol = request.tolerance;
    let parts: BTreeMap<&str, &NormalizedPart> = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), part))
        .collect();
    let mut placed_per_part: BTreeMap<&str, u64> = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), 0))
        .collect();

    // Gộp theo tờ: vùng bao đã dùng và tổng diện tích chi tiết.
    struct SheetUse {
        envelope: Option<BoundsMm>,
        part_area_mm2: f64,
    }
    let mut sheets: BTreeMap<u32, SheetUse> = BTreeMap::new();
    let mut invalid_count: u64 = 0;

    for record in placements {
        let Some(part) = parts.get(record.part_id.as_str()) else {
            invalid_count += 1;
            continue;
        };
        let Ok(ring) = place_ring_checked(&part.outer, &record.pose, part.reference_point_mm, &tol)
        else {
            invalid_count += 1;
            continue;
        };
        let Some(bounds) = BoundsMm::from_ring(&ring) else {
            invalid_count += 1;
            continue;
        };
        *placed_per_part
            .get_mut(part.part_id.as_str())
            .expect("part hợp lệ phải có bộ đếm autofill") += 1;
        let entry = sheets.entry(record.sheet_index).or_insert(SheetUse {
            envelope: None,
            part_area_mm2: 0.0,
        });
        entry.envelope = Some(match entry.envelope {
            None => bounds,
            Some(current) => BoundsMm {
                min_x: current.min_x.min(bounds.min_x),
                min_y: current.min_y.min(bounds.min_y),
                max_x: current.max_x.max(bounds.max_x),
                max_y: current.max_y.max(bounds.max_y),
            },
        });
        entry.part_area_mm2 += part.effective_area_mm2();
    }

    let sheet_count = sheets.len() as u32;
    // "Tờ cuối" là tờ có chỉ số lớn nhất — chính là tờ còn dư vật liệu dùng được.
    let last_sheet_area = sheets
        .values()
        .next_back()
        .and_then(|use_| use_.envelope)
        .map(|envelope| envelope.width_mm() * envelope.height_mm())
        .unwrap_or(0.0);
    let wasted: f64 = sheets
        .values()
        .map(|use_| {
            let envelope = use_
                .envelope
                .map(|b| b.width_mm() * b.height_mm())
                .unwrap_or(0.0);
            (envelope - use_.part_area_mm2).max(0.0)
        })
        .sum();

    let mut tie_break: Vec<PlacementKey> = placements
        .iter()
        .map(|record| PlacementKey::from_placement(record, &tol))
        .collect();
    tie_break.sort();

    let objective_penalty = if request.layout_intent.is_single_sheet_autofill() {
        autofill_penalty(&placed_per_part)
    } else {
        unplaced_count
    };

    LayoutScore {
        invalid_count,
        unplaced_count: objective_penalty,
        sheet_count,
        last_sheet_used_area_fixed: quantize(last_sheet_area, SCORE_AREA_QUANTUM_MM2),
        wasted_within_envelope_fixed: quantize(wasted, SCORE_AREA_QUANTUM_MM2),
        tie_break,
        score_version: SCORE_VERSION,
    }
}

/// Vùng bao đã dùng theo từng tờ, mm².
///
/// Duyệt placements đúng một lần để job nhiều tờ không biến thành O(số_tờ × số_con).
/// Đây cũng là nguồn hình học dùng cho phép căn cụm trước publication.
pub fn sheet_envelopes(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
) -> Option<BTreeMap<u32, BoundsMm>> {
    let tol = request.tolerance;
    let parts: BTreeMap<&str, &NormalizedPart> = request
        .parts
        .iter()
        .map(|part| (part.part_id.as_str(), part))
        .collect();
    let mut envelopes: BTreeMap<u32, BoundsMm> = BTreeMap::new();
    for record in placements {
        let part = parts.get(record.part_id.as_str())?;
        let ring =
            place_ring_checked(&part.outer, &record.pose, part.reference_point_mm, &tol).ok()?;
        let bounds = BoundsMm::from_ring(&ring)?;
        envelopes
            .entry(record.sheet_index)
            .and_modify(|current| {
                *current = BoundsMm {
                    min_x: current.min_x.min(bounds.min_x),
                    min_y: current.min_y.min(bounds.min_y),
                    max_x: current.max_x.max(bounds.max_x),
                    max_y: current.max_y.max(bounds.max_y),
                };
            })
            .or_insert(bounds);
    }
    Some(envelopes)
}

/// Vùng bao đã dùng của một tờ, mm² — tiện cho report.
pub fn sheet_envelope(
    request: &NormalizedRequest,
    placements: &[PlacementRecord],
    sheet_index: u32,
) -> Option<BoundsMm> {
    sheet_envelopes(request, placements)?.remove(&sheet_index)
}

/// So hai vị trí theo thứ tự Bottom-Left xác định: `y` trước, rồi `x`.
///
/// Dùng để baseline chọn vị trí và để mọi nơi khác cùng một quy tắc chọn. Lượng tử hoá
/// trước khi so nên hai vị trí cách nhau dưới dung sai không đảo thứ tự tuỳ nhiễu `f64`.
pub fn bottom_left_order(left: PointMm, right: PointMm) -> Ordering {
    quantize(left.y, SCORE_LENGTH_QUANTUM_MM)
        .cmp(&quantize(right.y, SCORE_LENGTH_QUANTUM_MM))
        .then(
            quantize(left.x, SCORE_LENGTH_QUANTUM_MM)
                .cmp(&quantize(right.x, SCORE_LENGTH_QUANTUM_MM)),
        )
}
