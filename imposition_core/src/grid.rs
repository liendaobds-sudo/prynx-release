//! Grid solver N-up / guillotine (cắt xén) — port thuần Rust từ
//! `native/src/imposition/grid_solver.rs`. Logic giữ NGUYÊN VẸN để bảo toàn parity
//! với bản PyO3 và bản Python `_py_solve_optimal_layout` (Task 5 / Req 1.1, 2.1).
//!
//! Đơn vị: caller truyền cùng đơn vị (pt hoặc mm); solver thuần số học.

use serde::{Deserialize, Serialize};

const EPS: f64 = 0.01;

/// Một ô trong lưới (toạ độ tương đối trong khối lưới).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    pub c: usize,
    pub r: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_rotated: bool,
    /// 0 = khối chính; 1 = fill phải; 2 = fill đáy. Dùng để vẽ dấu xén RIÊNG
    /// cho từng cụm (mỗi cụm có bộ dấu xén riêng, kể cả trong gap giữa 2 cụm).
    #[serde(default)]
    pub block_id: i64,
}

/// Kết quả lưới cơ bản.
#[derive(Clone, Debug, PartialEq)]
pub struct GridResult {
    pub cols: usize,
    pub rows: usize,
    pub width: f64,
    pub height: f64,
    pub cells: Vec<GridCell>,
    pub is_rotated: bool,
}

/// Kết quả layout tối ưu (tương đương `solve_optimal_layout`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimalResult {
    pub total_items: usize,
    pub overall_width: f64,
    pub overall_height: f64,
    pub cells: Vec<GridCell>,
    pub is_rotated: bool,
    pub cols: usize,
    pub rows: usize,
}

/// Lưới cơ bản cols × rows. Tương đương `solve_grid_core`.
pub fn solve_grid(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    is_rotated: bool,
) -> GridResult {
    let step_x = item_w + gap_x;
    let step_y = item_h + gap_y;

    let mut cols: usize = 0;
    if usable_w + EPS >= item_w {
        cols = ((usable_w - item_w + EPS) / step_x) as usize + 1;
    }

    let mut rows: usize = 0;
    if usable_h + EPS >= item_h {
        rows = ((usable_h - item_h + EPS) / step_y) as usize + 1;
    }

    // An toàn: chặn lưới khổng lồ (item quá nhỏ) gây OOM khi Vec::with_capacity.
    if cols > 2000 {
        cols = 2000;
    }
    if rows > 2000 {
        rows = 2000;
    }

    let mut block_w = cols as f64 * item_w + (cols.saturating_sub(1) as f64 * gap_x);
    while cols > 0 && block_w > usable_w + EPS {
        cols -= 1;
        block_w = cols as f64 * item_w + (cols.saturating_sub(1) as f64 * gap_x);
    }

    let mut block_h = rows as f64 * item_h + (rows.saturating_sub(1) as f64 * gap_y);
    while rows > 0 && block_h > usable_h + EPS {
        rows -= 1;
        block_h = rows as f64 * item_h + (rows.saturating_sub(1) as f64 * gap_y);
    }

    let mut cells = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            cells.push(GridCell {
                c,
                r,
                x: c as f64 * step_x,
                y: r as f64 * step_y,
                width: item_w,
                height: item_h,
                is_rotated,
                block_id: 0,
            });
        }
    }

    GridResult {
        cols,
        rows,
        width: block_w,
        height: block_h,
        cells,
        is_rotated,
    }
}

/// Layout tối ưu với L-shape fill. Tương đương `solve_optimal_layout`.
pub fn solve_optimal_layout(
    usable_w: f64,
    usable_h: f64,
    orig_w: f64,
    orig_h: f64,
    gap_x: f64,
    gap_y: f64,
    strategy: &str,
    secondary_gap: Option<f64>,
) -> OptimalResult {
    if strategy == "simple_auto" {
        let p1 = solve_grid(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, false);
        let p2 = solve_grid(usable_w, usable_h, orig_h, orig_w, gap_x, gap_y, true);
        let best = if p1.cells.len() >= p2.cells.len() {
            p1
        } else {
            p2
        };
        return OptimalResult {
            total_items: best.cells.len(),
            overall_width: best.width,
            overall_height: best.height,
            cells: best.cells,
            is_rotated: best.is_rotated,
            cols: best.cols,
            rows: best.rows,
        };
    }

    // optimal_auto: L-shape fill
    let (y1, c1, w1, h1) = try_config(
        usable_w,
        usable_h,
        orig_w,
        orig_h,
        orig_h,
        orig_w,
        gap_x,
        gap_y,
        false,
        secondary_gap,
    );
    let (y2, c2, w2, h2) = try_config(
        usable_w,
        usable_h,
        orig_h,
        orig_w,
        orig_w,
        orig_h,
        gap_x,
        gap_y,
        true,
        secondary_gap,
    );
    let (l_yield, l_cells, l_w, l_h, l_rot) = if y1 >= y2 {
        (y1, c1, w1, h1, false)
    } else {
        (y2, c2, w2, h2, true)
    };

    // Ưu tiên LƯỚI ĐƠN GIẢN khi hòa số lượng (sạch, dễ cắt) — yêu cầu người dùng.
    // L-shape chỉ thắng khi cho NHIỀU tem hơn hẳn lưới thường.
    let g1 = solve_grid(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, false);
    let g2 = solve_grid(usable_w, usable_h, orig_h, orig_w, gap_x, gap_y, true);
    let grid_best = if g1.cells.len() >= g2.cells.len() {
        g1
    } else {
        g2
    };

    if grid_best.cells.len() >= l_yield {
        return OptimalResult {
            total_items: grid_best.cells.len(),
            overall_width: grid_best.width,
            overall_height: grid_best.height,
            cells: grid_best.cells,
            is_rotated: grid_best.is_rotated,
            cols: grid_best.cols,
            rows: grid_best.rows,
        };
    }

    OptimalResult {
        total_items: l_yield,
        overall_width: l_w,
        overall_height: l_h,
        cells: l_cells,
        is_rotated: l_rot,
        cols: 0,
        rows: 0,
    }
}

/// L-shape fill: main block + right fill + bottom fill. Tương đương `try_config`.
fn try_config(
    usable_w: f64,
    usable_h: f64,
    main_w: f64,
    main_h: f64,
    fill_w: f64,
    fill_h: f64,
    gap_x: f64,
    gap_y: f64,
    primary_rotated: bool,
    secondary_gap: Option<f64>,
) -> (usize, Vec<GridCell>, f64, f64) {
    let split_gap = secondary_gap.unwrap_or(gap_x.max(gap_y));
    let max_grid = solve_grid(
        usable_w,
        usable_h,
        main_w,
        main_h,
        gap_x,
        gap_y,
        primary_rotated,
    );

    let mut best_yield = 0usize;
    let mut best_cells: Vec<GridCell> = Vec::new();
    let mut best_w = 0.0f64;
    let mut best_h = 0.0f64;

    let max_reduce_c = std::cmp::min(2, max_grid.cols);
    let max_reduce_r = std::cmp::min(2, max_grid.rows);

    for reduce_c in 0..max_reduce_c {
        for reduce_r in 0..max_reduce_r {
            if reduce_c > 0 && reduce_r > 0 {
                continue;
            }
            let tc = max_grid.cols.saturating_sub(reduce_c);
            let tr = max_grid.rows.saturating_sub(reduce_r);
            if tc == 0 || tr == 0 {
                continue;
            }

            let tbw = tc as f64 * main_w + tc.saturating_sub(1) as f64 * gap_x;
            let tbh = tr as f64 * main_h + tr.saturating_sub(1) as f64 * gap_y;

            let main_block = solve_grid(tbw, tbh, main_w, main_h, gap_x, gap_y, primary_rotated);
            let mut all_cells: Vec<GridCell> = main_block.cells;

            // Right fill
            let right_x = tbw + split_gap;
            let right_w = usable_w - right_x;
            // Khởi tạo = tbh (KHỚP bản Python `_py_solve_optimal_layout`): khi cụm fill
            // phải RỖNG, overall_h phải GIỮ = chiều cao khối chính, KHÔNG lấy theo
            // solve_grid.height (vốn vẫn > 0 dù 0 cột) — nếu không sẽ thổi phồng overall_h
            // và TRIỆT TIÊU cụm fill đáy → "Xếp tối ưu" kém hơn (bug parity).
            let mut fill_r_actual_h = tbh;
            if right_w > 0.01 {
                let fill_r = solve_grid(
                    right_w,
                    usable_h,
                    fill_w,
                    fill_h,
                    gap_x,
                    gap_y,
                    !primary_rotated,
                );
                if !fill_r.cells.is_empty() {
                    fill_r_actual_h = fill_r.height;
                    for mut cc in fill_r.cells {
                        cc.x += right_x;
                        cc.block_id = 1; // cụm fill phải — bộ dấu xén riêng
                        all_cells.push(cc);
                    }
                }
            }

            // Bottom fill
            let overall_h = tbh.max(fill_r_actual_h);
            let bottom_y = overall_h + split_gap;
            let bottom_h = usable_h - bottom_y;
            if bottom_h > 0.01 {
                let fill_b = solve_grid(
                    usable_w,
                    bottom_h,
                    fill_w,
                    fill_h,
                    gap_x,
                    gap_y,
                    !primary_rotated,
                );
                for mut cc in fill_b.cells {
                    cc.y += bottom_y;
                    cc.block_id = 2; // cụm fill đáy — bộ dấu xén riêng
                    all_cells.push(cc);
                }
            }

            if all_cells.len() > best_yield {
                best_yield = all_cells.len();
                best_w = all_cells
                    .iter()
                    .map(|c| c.x + c.width)
                    .fold(0.0f64, f64::max);
                best_h = all_cells
                    .iter()
                    .map(|c| c.y + c.height)
                    .fold(0.0f64, f64::max);
                best_cells = all_cells;
            }
        }
    }

    (best_yield, best_cells, best_w, best_h)
}

/// Lưới thủ công: dựng đúng `cols`×`rows` ô (Req 4.3). Không tự co.
pub fn solve_manual(
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    cols: usize,
    rows: usize,
) -> OptimalResult {
    let cols = cols.min(2000);
    let rows = rows.min(2000);
    let step_x = item_w + gap_x;
    let step_y = item_h + gap_y;
    let mut cells = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            cells.push(GridCell {
                c,
                r,
                x: c as f64 * step_x,
                y: r as f64 * step_y,
                width: item_w,
                height: item_h,
                is_rotated: false,
                block_id: 0,
            });
        }
    }
    let overall_width = if cols > 0 {
        cols as f64 * item_w + (cols - 1) as f64 * gap_x
    } else {
        0.0
    };
    let overall_height = if rows > 0 {
        rows as f64 * item_h + (rows - 1) as f64 * gap_y
    } else {
        0.0
    };
    OptimalResult {
        total_items: cells.len(),
        overall_width,
        overall_height,
        cells,
        is_rotated: false,
        cols,
        rows,
    }
}

/// Ánh xạ ô trên tờ → trang nguồn. Tương đương `get_src_page_idx`.
pub fn get_src_page_idx(
    sheet_idx: usize,
    cell_on_sheet_idx: usize,
    layout_type: &str,
    total_capacity: usize,
    page_count: usize,
) -> usize {
    match layout_type {
        "repeat" => sheet_idx,
        "cut_stacks" => {
            // ceil(page_count / total_capacity)
            let stack_depth = if total_capacity == 0 {
                0
            } else {
                (page_count + total_capacity - 1) / total_capacity
            };
            cell_on_sheet_idx * stack_depth + sheet_idx
        }
        _ => sheet_idx * total_capacity + cell_on_sheet_idx, // sequential
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Đối chiếu các con số ĐÃ KHÓA trong golden_baseline.json ──
    // (backend/tests/golden) — bảo đảm port Rust khớp hành vi hiện tại.

    #[test]
    fn golden_nup_capacities() {
        // nup_lshape_card16 = 16
        assert_eq!(
            solve_optimal_layout(
                779.52875,
                1128.190699,
                260.7919,
                158.7417,
                5.6693,
                5.6693,
                "optimal_auto",
                Some(34.0158)
            )
            .total_items,
            16
        );
        // nup_grid_no_secondary = 13
        assert_eq!(
            solve_optimal_layout(
                1000.0,
                1000.0,
                200.0,
                300.0,
                10.0,
                10.0,
                "optimal_auto",
                None
            )
            .total_items,
            13
        );
        // nup_lshape_extreme_gap = 21
        assert_eq!(
            solve_optimal_layout(
                800.0,
                800.0,
                250.0,
                100.0,
                5.0,
                5.0,
                "optimal_auto",
                Some(150.0)
            )
            .total_items,
            21
        );
        // nup_simple_auto = 21
        assert_eq!(
            solve_optimal_layout(
                800.0,
                800.0,
                250.0,
                100.0,
                5.0,
                5.0,
                "simple_auto",
                Some(10.0)
            )
            .total_items,
            21
        );
        // nup_sra3_business_card = 24
        assert_eq!(
            solve_optimal_layout(
                907.09,
                1275.59,
                255.12,
                153.07,
                0.0,
                0.0,
                "optimal_auto",
                None
            )
            .total_items,
            24
        );
    }

    #[test]
    fn optimal_lshape_beats_simple_when_fill_possible() {
        // Ledger 279x432 (lề ~5mm/bên → usable 269x422mm), item 90x50mm, gap 2mm.
        // Lưới đều = 20; xếp hình-L lấp thêm cụm đáy = 22.
        // "Xếp tối ưu" PHẢI nhiều hơn "Lưới đơn giản" (chống bug parity fill_r_actual_h).
        let mm = 2.83465;
        let (uw, uh) = (269.0 * mm, 422.0 * mm);
        let (iw, ih, g) = (90.0 * mm, 50.0 * mm, 2.0 * mm);
        let simple = solve_optimal_layout(uw, uh, iw, ih, g, g, "simple_auto", None).total_items;
        let opt = solve_optimal_layout(uw, uh, iw, ih, g, g, "optimal_auto", None).total_items;
        assert_eq!(simple, 20, "lưới đơn giản");
        assert_eq!(opt, 22, "xếp tối ưu (L-shape) phải lấp thêm cụm đáy");
        assert!(opt > simple, "tối ưu phải hơn lưới đơn giản");
    }

    #[test]
    fn golden_solve_grid_basic() {
        // nup_solve_grid_basic = 48 (320x450, item 50x50, gap 2)
        let g = solve_grid(320.0, 450.0, 50.0, 50.0, 2.0, 2.0, false);
        assert_eq!(g.cells.len(), 48);
        assert_eq!(g.cols, 6);
        assert_eq!(g.rows, 8);
    }

    #[test]
    fn src_page_idx_modes() {
        // sequential
        assert_eq!(get_src_page_idx(1, 2, "sequential", 6, 20), 1 * 6 + 2);
        // repeat
        assert_eq!(get_src_page_idx(2, 5, "repeat", 6, 20), 2);
        // cut_stacks: stack_depth = ceil(20/6) = 4 → 5*4 + 1
        assert_eq!(get_src_page_idx(1, 5, "cut_stacks", 6, 20), 5 * 4 + 1);
    }

    #[test]
    fn optimal_prefers_simple_grid_on_tie() {
        // Item vuông 100x100 trên 400x400, gap 0 → lưới 4x4=16; L-shape không hơn.
        // optimal_auto phải trả LƯỚI sạch (mọi ô cùng hướng), không trộn xoay.
        let r = solve_optimal_layout(400.0, 400.0, 100.0, 100.0, 0.0, 0.0, "optimal_auto", None);
        assert_eq!(r.total_items, 16);
        let first_rot = r.cells[0].is_rotated;
        assert!(
            r.cells.iter().all(|c| c.is_rotated == first_rot),
            "hòa với lưới đơn giản → phải là lưới đồng nhất, không trộn xoay (L-shape)"
        );
    }

    #[test]
    fn manual_builds_exact_grid() {
        let r = solve_manual(50.0, 60.0, 2.0, 3.0, 4, 5);
        assert_eq!(r.total_items, 20);
        assert_eq!(r.cols, 4);
        assert_eq!(r.rows, 5);
        // overall = 4*50 + 3*2 = 206 ; 5*60 + 4*3 = 312
        assert!((r.overall_width - 206.0).abs() < 1e-9);
        assert!((r.overall_height - 312.0).abs() < 1e-9);
    }

    #[test]
    fn zero_capacity_no_panic() {
        // Bẫy chia 0 ở bản Rust gốc (usize underflow) — bản port chặn an toàn.
        assert_eq!(get_src_page_idx(0, 0, "cut_stacks", 0, 10), 0);
    }
}
