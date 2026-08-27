//! Chỉ mục không gian cho broad phase (P2c).
//!
//! Nguồn: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §11.2:
//! "Dùng AABB + spatial index để loại nhanh cặp chắc chắn không va chạm; robust
//! fixed-point collision/clearance mới quyết định hợp lệ."
//!
//! ## Chỉ được sai theo một hướng
//!
//! Chỉ mục này chỉ có quyền nói **"chắc chắn không thể chạm"**. Nó không bao giờ được
//! nói "chắc chắn chạm" — mọi ứng viên nó trả về đều phải qua
//! [`super::collision::judge_pair`]. Nhờ tính bất đối xứng đó, một lỗi trong chỉ mục
//! làm chậm chương trình chứ không làm ra layout hỏng.
//!
//! ## Vì sao lưới đều, không phải R-tree
//!
//! Chi tiết trên một tờ in phân bố khá đều và có kích thước cùng bậc, nên lưới đều cho
//! hiệu quả tương đương R-tree với chi phí dựng gần bằng không và không cấp phát lại
//! khi thêm phần tử. Quan trọng hơn: lưới đều **deterministic** — thứ tự trả về chỉ phụ
//! thuộc thứ tự chèn, không phụ thuộc cấu trúc cây cân bằng lại. Kế hoạch §11.3 yêu cầu
//! cùng seed cho cùng kết quả bất kể số worker, nên tính xác định của mọi bước trung
//! gian là ràng buộc, không phải tiện lợi.
//!
//! **Lưới ở đây là cấu trúc dữ liệu, không phải lưới toạ độ đặt chi tiết.** Vị trí đặt
//! vẫn là số thực liên tục; ô lưới chỉ dùng để tra cứu.

use super::model::{PointMm, Tolerance};
use super::normalize::BoundsMm;

/// Số ô tối đa mỗi chiều. Chặn bộ nhớ khi vùng rất lớn mà chi tiết rất nhỏ.
pub const MAX_CELLS_PER_AXIS: usize = 512;

/// Một phần tử đã chèn: hộp bao và định danh do nơi gọi tự đặt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpatialEntry {
    pub id: usize,
    pub bounds: BoundsMm,
}

/// Lưới đều băm theo ô, dùng cho broad phase trên **một** tờ.
#[derive(Debug, Clone)]
pub struct SpatialGrid {
    origin_x: f64,
    origin_y: f64,
    cell_mm: f64,
    cols: usize,
    rows: usize,
    /// `cells[row * cols + col]` là danh sách chỉ số vào `entries`.
    cells: Vec<Vec<usize>>,
    entries: Vec<SpatialEntry>,
}

impl SpatialGrid {
    /// Dựng lưới phủ `area`, với ô cạnh khoảng `cell_hint_mm`.
    ///
    /// `cell_hint_mm` nên lấy cỡ kích thước chi tiết trung bình: ô quá nhỏ thì một chi
    /// tiết trải trên nhiều ô, ô quá lớn thì mọi thứ vào cùng một ô và mất tác dụng.
    pub fn new(area: &BoundsMm, cell_hint_mm: f64) -> Self {
        let width = (area.max_x - area.min_x).max(1e-9);
        let height = (area.max_y - area.min_y).max(1e-9);
        let hint = if cell_hint_mm.is_finite() && cell_hint_mm > 0.0 {
            cell_hint_mm
        } else {
            width.max(height)
        };
        // Chặn hai đầu: ít nhất 1 ô, nhiều nhất MAX_CELLS_PER_AXIS ô mỗi chiều.
        let cols = ((width / hint).ceil() as usize).clamp(1, MAX_CELLS_PER_AXIS);
        let rows = ((height / hint).ceil() as usize).clamp(1, MAX_CELLS_PER_AXIS);
        let cell_mm = (width / cols as f64).max(height / rows as f64);
        Self {
            origin_x: area.min_x,
            origin_y: area.min_y,
            cell_mm,
            cols,
            rows,
            cells: vec![Vec::new(); cols * rows],
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn cell_size_mm(&self) -> f64 {
        self.cell_mm
    }

    pub fn grid_size(&self) -> (usize, usize) {
        (self.cols, self.rows)
    }

    pub fn entries(&self) -> &[SpatialEntry] {
        &self.entries
    }

    /// Khoảng ô mà một hộp bao trải qua, đã kẹp về trong lưới.
    fn cell_span(&self, bounds: &BoundsMm) -> (usize, usize, usize, usize) {
        let to_col = |x: f64| -> usize {
            let raw = ((x - self.origin_x) / self.cell_mm).floor();
            if raw < 0.0 {
                0
            } else {
                (raw as usize).min(self.cols - 1)
            }
        };
        let to_row = |y: f64| -> usize {
            let raw = ((y - self.origin_y) / self.cell_mm).floor();
            if raw < 0.0 {
                0
            } else {
                (raw as usize).min(self.rows - 1)
            }
        };
        (
            to_col(bounds.min_x),
            to_row(bounds.min_y),
            to_col(bounds.max_x),
            to_row(bounds.max_y),
        )
    }

    /// Chèn một hộp bao. Trả chỉ số nội bộ của phần tử.
    ///
    /// Toạ độ không hữu hạn bị từ chối: một `NaN` lọt vào chỉ mục sẽ làm mọi truy vấn
    /// sau đó trả kết quả tuỳ ý.
    pub fn insert(&mut self, id: usize, bounds: BoundsMm) -> Option<usize> {
        if !bounds.min_x.is_finite()
            || !bounds.min_y.is_finite()
            || !bounds.max_x.is_finite()
            || !bounds.max_y.is_finite()
        {
            return None;
        }
        let index = self.entries.len();
        self.entries.push(SpatialEntry { id, bounds });
        let (c0, r0, c1, r1) = self.cell_span(&bounds);
        for row in r0..=r1 {
            for col in c0..=c1 {
                self.cells[row * self.cols + col].push(index);
            }
        }
        Some(index)
    }

    /// Các phần tử **có thể** chạm `query` (nới thêm `margin_mm`).
    ///
    /// Kết quả theo **thứ tự chèn tăng dần** và không trùng lặp, nên hai lần chạy cho
    /// cùng danh sách — điều kiện cần cho tính xác định của solver.
    pub fn query(&self, query: &BoundsMm, margin_mm: f64, tol: &Tolerance) -> Vec<SpatialEntry> {
        let margin = if margin_mm.is_finite() && margin_mm > 0.0 {
            margin_mm
        } else {
            0.0
        };
        let widened = BoundsMm {
            min_x: query.min_x - margin,
            min_y: query.min_y - margin,
            max_x: query.max_x + margin,
            max_y: query.max_y + margin,
        };
        let (c0, r0, c1, r1) = self.cell_span(&widened);
        let mut seen = vec![false; self.entries.len()];
        let mut out: Vec<usize> = Vec::new();
        for row in r0..=r1 {
            for col in c0..=c1 {
                for &index in &self.cells[row * self.cols + col] {
                    if seen[index] {
                        continue;
                    }
                    seen[index] = true;
                    if super::collision::bounds_may_touch(
                        &widened,
                        &self.entries[index].bounds,
                        tol,
                    ) {
                        out.push(index);
                    }
                }
            }
        }
        // Sắp theo thứ tự chèn: ô được quét theo hàng nên thứ tự thô phụ thuộc hình
        // học, không phụ thuộc thứ tự chèn. Chuẩn hoá lại để kết quả xác định.
        out.sort_unstable();
        out.into_iter().map(|index| self.entries[index]).collect()
    }

    /// Các phần tử có thể nằm trong `gap_mm` quanh `query` — tiện cho kiểm khoảng hở.
    pub fn query_within_gap(
        &self,
        query: &BoundsMm,
        gap_mm: f64,
        tol: &Tolerance,
    ) -> Vec<SpatialEntry> {
        self.query(query, gap_mm, tol)
    }

    /// Xoá toàn bộ, giữ nguyên hình lưới để dùng lại cho tờ kế tiếp.
    pub fn clear(&mut self) {
        for cell in &mut self.cells {
            cell.clear();
        }
        self.entries.clear();
    }

    /// Ô chứa một điểm — dùng cho debug và report, không dùng để đặt chi tiết.
    pub fn cell_of(&self, point: PointMm) -> Option<(usize, usize)> {
        if !point.is_finite() {
            return None;
        }
        let bounds = BoundsMm {
            min_x: point.x,
            min_y: point.y,
            max_x: point.x,
            max_y: point.y,
        };
        let (col, row, _, _) = self.cell_span(&bounds);
        Some((col, row))
    }
}
