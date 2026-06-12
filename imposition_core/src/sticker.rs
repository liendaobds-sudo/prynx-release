//! Sticker layout solvers — grid, stagger, hex tiling, cluster/alternating.
//! Port thuần Rust từ `native/src/imposition/sticker_layouts.rs`,
//! giữ NGUYÊN logic để bảo toàn parity (Task 5 / Req 1.1).

const TOL: f64 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StickerItem {
    pub c: usize,
    pub r: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_rotated: bool,
    pub is_rotated_180: bool,
    pub block_id: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StickerResult {
    pub total_items: usize,
    pub items: Vec<StickerItem>,
    pub width_used: f64,
    pub height_used: f64,
    pub cols: Option<usize>,
    pub rows: Option<usize>,
}

fn items_bounding_box(items: &[StickerItem]) -> (f64, f64, f64, f64) {
    if items.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let min_x = items.iter().map(|i| i.x).fold(f64::INFINITY, f64::min);
    let min_y = items.iter().map(|i| i.y).fold(f64::INFINITY, f64::min);
    let max_x = items.iter().map(|i| i.x + i.width).fold(f64::NEG_INFINITY, f64::max);
    let max_y = items.iter().map(|i| i.y + i.height).fold(f64::NEG_INFINITY, f64::max);
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

fn normalize_items(items: &mut [StickerItem]) {
    if items.is_empty() {
        return;
    }
    let min_x = items.iter().map(|i| i.x).fold(f64::INFINITY, f64::min);
    let min_y = items.iter().map(|i| i.y).fold(f64::INFINITY, f64::min);
    for it in items.iter_mut() {
        it.x -= min_x;
        it.y -= min_y;
    }
}

fn build(items: Vec<StickerItem>) -> StickerResult {
    let (_, _, w, h) = items_bounding_box(&items);
    StickerResult { total_items: items.len(), items, width_used: w, height_used: h, cols: None, rows: None }
}

fn empty() -> StickerResult {
    StickerResult { total_items: 0, items: Vec::new(), width_used: 0.0, height_used: 0.0, cols: None, rows: None }
}

// ─── Grid ───────────────────────────────────────────────────────────
pub fn solve_grid(usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> StickerResult {
    let step_x = (item_w * 0.05).max(item_w + gap_x);
    let step_y = (item_h * 0.05).max(item_h + gap_y);

    let mut cols: usize = 0;
    if usable_w + TOL >= item_w {
        cols = ((usable_w - item_w + TOL) / step_x) as usize + 1;
    }
    let mut rows: usize = 0;
    if usable_h + TOL >= item_h {
        rows = ((usable_h - item_h + TOL) / step_y) as usize + 1;
    }

    let mut block_w = cols as f64 * item_w + cols.saturating_sub(1) as f64 * gap_x;
    while cols > 0 && block_w > usable_w + TOL {
        cols -= 1;
        block_w = cols as f64 * item_w + cols.saturating_sub(1) as f64 * gap_x;
    }
    let mut block_h = rows as f64 * item_h + rows.saturating_sub(1) as f64 * gap_y;
    while rows > 0 && block_h > usable_h + TOL {
        rows -= 1;
        block_h = rows as f64 * item_h + rows.saturating_sub(1) as f64 * gap_y;
    }

    let mut items = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            items.push(StickerItem {
                c, r, x: c as f64 * step_x, y: r as f64 * step_y,
                width: item_w, height: item_h, is_rotated: false, is_rotated_180: false, block_id: 0,
            });
        }
    }
    let n = items.len();
    StickerResult { total_items: n, items, width_used: block_w, height_used: block_h, cols: Some(cols), rows: Some(rows) }
}

// ─── Staggered hex (horizontal stagger) ─────────────────────────────
pub fn staggered_hex(usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> StickerResult {
    if item_w <= TOL || item_h <= TOL { return empty(); }
    if usable_w < item_w - TOL || usable_h < item_h - TOL { return empty(); }

    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let step_x = (item_w * 0.05).max(item_w + gap_x);
    let step_y = (3.0_f64).sqrt() * (ry + gap_y / 2.0);

    if step_y <= TOL && usable_h < item_h - TOL { return empty(); }

    let max_rows = if usable_h >= item_h - TOL {
        if step_y > TOL { ((usable_h - item_h + TOL) / step_y).floor() as usize + 1 } else { 1 }
    } else { 0 };

    let mut items = Vec::new();
    for row in 0..max_rows {
        let cy = ry + row as f64 * step_y;
        if cy + ry > usable_h + TOL { break; }

        let is_odd = row % 2 != 0;
        let row_start = if is_odd { rx + item_w / 2.0 + gap_x / 2.0 } else { rx };
        let first_right = row_start + rx;

        let mut n = 0usize;
        if is_odd {
            if usable_w >= row_start - rx + item_w - TOL {
                n = 1;
                if step_x > TOL {
                    let rem = usable_w - (row_start - rx + item_w);
                    if rem >= -TOL { n += ((rem + TOL) / step_x).floor() as usize; }
                }
            }
        } else if first_right <= usable_w + TOL {
            n = 1;
            if step_x > TOL {
                let rem = usable_w - item_w;
                if rem >= -TOL { n += ((rem + TOL) / step_x).floor() as usize; }
            }
        }

        for col in 0..n {
            let cx = row_start + col as f64 * step_x;
            if cx + rx > usable_w + TOL { break; }
            items.push(StickerItem {
                c: col, r: row, x: cx - rx, y: cy - ry,
                width: item_w, height: item_h, is_rotated: false, is_rotated_180: false, block_id: 0,
            });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Staggered vertical ─────────────────────────────────────────────
pub fn staggered_vertical(usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> StickerResult {
    if item_w <= TOL || item_h <= TOL { return empty(); }
    if usable_w < item_w - TOL || usable_h < item_h - TOL { return empty(); }

    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let step_y = (item_h * 0.05).max(item_h + gap_y);
    let step_x = (3.0_f64).sqrt() * (rx + gap_x / 2.0);

    if step_x <= TOL && usable_w < item_w - TOL { return empty(); }

    let max_cols = if usable_w >= item_w - TOL {
        if step_x > TOL { ((usable_w - item_w + TOL) / step_x).floor() as usize + 1 } else { 1 }
    } else { 0 };

    let mut items = Vec::new();
    for col in 0..max_cols {
        let cx = rx + col as f64 * step_x;
        if cx + rx > usable_w + TOL { break; }

        let is_odd = col % 2 != 0;
        let col_start = if is_odd { ry + item_h / 2.0 + gap_y / 2.0 } else { ry };

        let mut n = 0usize;
        if is_odd {
            if usable_h >= col_start - ry + item_h - TOL {
                n = 1;
                if step_y > TOL {
                    let rem = usable_h - (col_start - ry + item_h);
                    if rem >= -TOL { n += ((rem + TOL) / step_y).floor() as usize; }
                }
            }
        } else if usable_h >= item_h - TOL {
            n = 1;
            if step_y > TOL {
                let rem = usable_h - item_h;
                if rem >= -TOL { n += ((rem + TOL) / step_y).floor() as usize; }
            }
        }

        for row in 0..n {
            let cy = col_start + row as f64 * step_y;
            if cy + ry > usable_h + TOL { break; }
            items.push(StickerItem {
                c: col, r: row, x: cx - rx, y: cy - ry,
                width: item_w, height: item_h, is_rotated: false, is_rotated_180: false, block_id: 0,
            });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Hex tiling row stagger (pointy-top) ────────────────────────────
pub fn hex_tiling_row(usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> StickerResult {
    if item_w <= TOL || item_h <= TOL { return empty(); }
    if usable_w < item_w - TOL || usable_h < item_h - TOL { return empty(); }

    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let step_x = item_w + gap_x;
    let step_y = 0.75 * item_h + gap_y;
    if step_y <= TOL { return empty(); }

    let max_rows = if usable_h >= item_h - TOL {
        ((usable_h - item_h + TOL) / step_y).floor() as usize + 1
    } else { 0 };

    let mut items = Vec::new();
    for row in 0..max_rows {
        let cy = ry + row as f64 * step_y;
        if cy + ry > usable_h + TOL { break; }

        let is_odd = row % 2 != 0;
        let row_start = if is_odd { rx + step_x / 2.0 } else { rx };
        let first_right = row_start + rx;

        let mut n = 0usize;
        if first_right <= usable_w + TOL {
            n = 1;
            if step_x > TOL {
                let rem = usable_w - first_right;
                if rem >= -TOL { n += ((rem + TOL) / step_x).floor() as usize; }
            }
        }

        for col in 0..n {
            let cx = row_start + col as f64 * step_x;
            if cx + rx > usable_w + TOL { break; }
            items.push(StickerItem {
                c: col, r: row, x: cx - rx, y: cy - ry,
                width: item_w, height: item_h, is_rotated: false, is_rotated_180: false, block_id: 0,
            });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Hex tiling col stagger (flat-top) ──────────────────────────────
pub fn hex_tiling_col(usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64) -> StickerResult {
    if item_w <= TOL || item_h <= TOL { return empty(); }
    if usable_w < item_w - TOL || usable_h < item_h - TOL { return empty(); }

    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let step_x = 0.75 * item_w + gap_x;
    let step_y = item_h + gap_y;
    if step_x <= TOL { return empty(); }

    let max_cols = if usable_w >= item_w - TOL {
        ((usable_w - item_w + TOL) / step_x).floor() as usize + 1
    } else { 0 };

    let mut items = Vec::new();
    for col in 0..max_cols {
        let cx = rx + col as f64 * step_x;
        if cx + rx > usable_w + TOL { break; }

        let is_odd = col % 2 != 0;
        let col_start = if is_odd { ry + step_y / 2.0 } else { ry };
        let first_bottom = col_start + ry;

        let mut n = 0usize;
        if first_bottom <= usable_h + TOL {
            n = 1;
            if step_y > TOL {
                let rem = usable_h - first_bottom;
                if rem >= -TOL { n += ((rem + TOL) / step_y).floor() as usize; }
            }
        }

        for row in 0..n {
            let cy = col_start + row as f64 * step_y;
            if cy + ry > usable_h + TOL { break; }
            items.push(StickerItem {
                c: col, r: row, x: cx - rx, y: cy - ry,
                width: item_w, height: item_h, is_rotated: false, is_rotated_180: false, block_id: 0,
            });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Cluster grid (head-to-tail) ────────────────────────────────────
#[derive(Clone, Copy, Debug, Default)]
pub struct ClusterParams {
    pub dx: Option<f64>,
    pub dy: Option<f64>,
    pub dx_outer: Option<f64>,
    pub dy_outer: Option<f64>,
}

pub fn cluster_grid(
    usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64,
    params: Option<ClusterParams>, rotated: bool,
) -> StickerResult {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };

    let p = params.unwrap_or_default();
    let dx = p.dx.unwrap_or(0.0);
    let dy = p.dy.unwrap_or(0.0);
    let dx_outer = p.dx_outer.unwrap_or(w + gap_x);
    let dy_outer = p.dy_outer.unwrap_or(h + gap_y);

    if dx_outer <= TOL || dy_outer <= TOL { return empty(); }

    let cluster_w = dx.abs() + w;
    let cluster_h = dy.abs() + h;

    let cols = if usable_w >= cluster_w - TOL { ((usable_w - cluster_w + TOL) / dx_outer).floor() as usize + 1 } else { 0 };
    let rows = if usable_h >= cluster_h - TOL { ((usable_h - cluster_h + TOL) / dy_outer).floor() as usize + 1 } else { 0 };

    let mut items = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let base_x = c as f64 * dx_outer;
            let base_y = r as f64 * dy_outer;

            let (ax, ay) = if dy < 0.0 { (base_x, base_y + dy.abs()) } else { (base_x, base_y) };
            if ax + w <= usable_w + TOL && ay + h <= usable_h + TOL {
                items.push(StickerItem { c, r, x: ax, y: ay, width: w, height: h, is_rotated: rotated, is_rotated_180: false, block_id: 0 });
            }

            let (bx, by) = if dy < 0.0 { (base_x + dx, base_y) } else { (base_x + dx, base_y + dy) };
            if bx >= -TOL && bx + w <= usable_w + TOL && by >= -TOL && by + h <= usable_h + TOL {
                items.push(StickerItem { c, r, x: bx, y: by, width: w, height: h, is_rotated: rotated, is_rotated_180: true, block_id: 0 });
            }
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Row alternating ────────────────────────────────────────────────
#[derive(Clone, Copy, Debug, Default)]
pub struct RowAltParams {
    pub offset_x: Option<f64>,
    pub row_h: Option<f64>,
    pub step_x: Option<f64>,
}

pub fn row_alternating(
    usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64,
    params: Option<RowAltParams>, rotated: bool,
) -> StickerResult {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };

    let p = params.unwrap_or_default();
    let offset_x = p.offset_x.unwrap_or(0.0);
    let row_h = p.row_h.unwrap_or(h + gap_y);
    let step_x = p.step_x.unwrap_or(w + gap_x);

    if step_x <= TOL || row_h <= TOL { return empty(); }

    let max_rows = if usable_h >= h - TOL { ((usable_h - h + TOL) / row_h).floor() as usize + 1 } else { 0 };

    let mut items = Vec::new();
    for r in 0..max_rows {
        let y = r as f64 * row_h;
        if y + h > usable_h + TOL { break; }

        let is_odd = r % 2 != 0;
        let x_start = if is_odd { offset_x } else { 0.0 };
        let cols = if usable_w >= x_start + w - TOL { ((usable_w - x_start - w + TOL) / step_x).floor() as usize + 1 } else { 0 };

        for c in 0..cols {
            let x = x_start + c as f64 * step_x;
            if x + w > usable_w + TOL { break; }
            items.push(StickerItem { c, r, x, y, width: w, height: h, is_rotated: rotated, is_rotated_180: false, block_id: 0 });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

// ─── Col alternating ────────────────────────────────────────────────
#[derive(Clone, Copy, Debug, Default)]
pub struct ColAltParams {
    pub offset_y: Option<f64>,
    pub col_w: Option<f64>,
    pub step_y: Option<f64>,
}

pub fn col_alternating(
    usable_w: f64, usable_h: f64, item_w: f64, item_h: f64, gap_x: f64, gap_y: f64,
    params: Option<ColAltParams>, rotated: bool,
) -> StickerResult {
    let (w, h) = if rotated { (item_h, item_w) } else { (item_w, item_h) };

    let p = params.unwrap_or_default();
    let offset_y = p.offset_y.unwrap_or(0.0);
    let col_w = p.col_w.unwrap_or(w + gap_x);
    let step_y = p.step_y.unwrap_or(h + gap_y);

    if col_w <= TOL || step_y <= TOL { return empty(); }

    let max_cols = if usable_w >= w - TOL { ((usable_w - w + TOL) / col_w).floor() as usize + 1 } else { 0 };

    let mut items = Vec::new();
    for c in 0..max_cols {
        let x = c as f64 * col_w;
        if x + w > usable_w + TOL { break; }

        let is_odd = c % 2 != 0;
        let y_start = if is_odd { offset_y } else { 0.0 };
        let rows = if usable_h >= y_start + h - TOL { ((usable_h - y_start - h + TOL) / step_y).floor() as usize + 1 } else { 0 };

        for r in 0..rows {
            let y = y_start + r as f64 * step_y;
            if y + h > usable_h + TOL { break; }
            items.push(StickerItem { c, r, x, y, width: w, height: h, is_rotated: rotated, is_rotated_180: false, block_id: 0 });
        }
    }

    if items.is_empty() { return empty(); }
    normalize_items(&mut items);
    build(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn within_bounds(res: &StickerResult, uw: f64, uh: f64) {
        for it in &res.items {
            assert!(it.x >= -TOL && it.y >= -TOL, "item toạ độ âm: {:?}", it);
            assert!(it.x + it.width <= uw + TOL, "tràn ngang: {:?}", it);
            assert!(it.y + it.height <= uh + TOL, "tràn dọc: {:?}", it);
        }
    }

    #[test]
    fn grid_matches_golden_48() {
        // stk_grid_50 trong golden = 48 (320x450, item 50x50, gap 2)
        let r = solve_grid(320.0, 450.0, 50.0, 50.0, 2.0, 2.0);
        assert_eq!(r.total_items, 48);
        assert_eq!(r.cols, Some(6));
        assert_eq!(r.rows, Some(8));
        within_bounds(&r, 320.0, 450.0);
    }

    #[test]
    fn hex_at_least_grid_and_in_bounds() {
        // Với item vuông/tròn nhỏ, hex nesting >= grid.
        let g = solve_grid(320.0, 450.0, 40.0, 40.0, 2.0, 2.0);
        let h = staggered_hex(320.0, 450.0, 40.0, 40.0, 2.0, 2.0);
        assert!(h.total_items >= g.total_items, "hex={} < grid={}", h.total_items, g.total_items);
        within_bounds(&h, 320.0, 450.0);
    }

    #[test]
    fn cluster_has_rotated_180() {
        let r = cluster_grid(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, None, false);
        assert!(r.total_items > 0);
        assert!(r.items.iter().any(|it| it.is_rotated_180), "cluster phải có item xoay 180");
        within_bounds(&r, 320.0, 450.0);
    }

    #[test]
    fn empty_when_item_too_large() {
        assert_eq!(staggered_hex(30.0, 30.0, 50.0, 50.0, 0.0, 0.0).total_items, 0);
        assert_eq!(solve_grid(100.0, 100.0, 200.0, 200.0, 0.0, 0.0).total_items, 0);
    }

    #[test]
    fn alternating_in_bounds() {
        let ra = row_alternating(320.0, 450.0, 60.0, 40.0, 3.0, 3.0, None, false);
        let ca = col_alternating(320.0, 450.0, 60.0, 40.0, 3.0, 3.0, None, false);
        assert!(ra.total_items > 0 && ca.total_items > 0);
        within_bounds(&ra, 320.0, 450.0);
        within_bounds(&ca, 320.0, 450.0);
    }
}
