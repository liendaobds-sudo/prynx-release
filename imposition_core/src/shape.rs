//! Shape-specific solvers (hex/trapezoid/triangle/pentagon/parallelogram/
//! l-shape/hammer/dumbbell). Port thuần Rust từ `native/src/imposition/shape_solvers.rs`,
//! giữ NGUYÊN logic để bảo toàn parity (Task 5 / Req 1.1).

use crate::sticker::StickerItem;

const TOL: f64 = 0.01;

/// Thuộc tính hình (thay cho PyDict). Mọi field optional; default tra ở call site.
#[derive(Clone, Debug, Default)]
pub struct ShapeProps {
    pub is_horizontal: Option<f64>,
    pub left_oh: Option<f64>,
    pub right_oh: Option<f64>,
    pub triangle_apex: Option<String>,
    pub delta_w: Option<f64>,
    pub gap_multiplier_h: Option<f64>,
    pub peak_height_ratio: Option<f64>,
    pub pentagon_orientation: Option<String>,
    pub overhang_x: Option<f64>,
    pub overhang_y: Option<f64>,
    pub big_end_first: Option<f64>,
    pub body_w: Option<f64>,
    pub small_d: Option<f64>,
    pub small_asymm_offset: Option<f64>,
    pub asymm_offset: Option<f64>,
    pub safe_interlock_pitch: Option<f64>,
    pub hex_orientation: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShapeResult {
    pub total_items: usize,
    pub items: Vec<StickerItem>,
    pub width_used: f64,
    pub height_used: f64,
    pub strategy_used: String,
    pub main_rotated: Option<bool>,
}

// ─── Helpers cục bộ ─────────────────────────────────────────────────
fn bbox(items: &[StickerItem]) -> (f64, f64, f64, f64) {
    if items.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let min_x = items.iter().map(|i| i.x).fold(f64::INFINITY, f64::min);
    let min_y = items.iter().map(|i| i.y).fold(f64::INFINITY, f64::min);
    let max_x = items
        .iter()
        .map(|i| i.x + i.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = items
        .iter()
        .map(|i| i.y + i.height)
        .fold(f64::NEG_INFINITY, f64::max);
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

fn normalize(items: &mut [StickerItem]) {
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

fn finish(mut items: Vec<StickerItem>, strategy: &str) -> ShapeResult {
    if items.is_empty() {
        return empty(strategy);
    }
    normalize(&mut items);
    let (_, _, w, h) = bbox(&items);
    let n = items.len();
    ShapeResult {
        total_items: n,
        items,
        width_used: w,
        height_used: h,
        strategy_used: strategy.to_string(),
        main_rotated: None,
    }
}

fn empty(strategy: &str) -> ShapeResult {
    ShapeResult {
        total_items: 0,
        items: Vec::new(),
        width_used: 0.0,
        height_used: 0.0,
        strategy_used: strategy.to_string(),
        main_rotated: None,
    }
}

fn item(
    c: usize,
    r: usize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rot: bool,
    rot180: bool,
) -> StickerItem {
    StickerItem {
        c,
        r,
        x,
        y,
        width: w,
        height: h,
        is_rotated: rot,
        is_rotated_180: rot180,
        block_id: 0,
    }
}

/// Grid nội bộ trả Vec<StickerItem> (tương đương solve_grid_internal).
fn solve_grid_internal(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    rotated: bool,
) -> Vec<StickerItem> {
    let step_x = (item_w * 0.05).max(item_w + gap_x);
    let step_y = (item_h * 0.05).max(item_h + gap_y);
    let mut cols = if usable_w + TOL >= item_w {
        ((usable_w - item_w + TOL) / step_x) as usize + 1
    } else {
        0
    };
    let mut rows = if usable_h + TOL >= item_h {
        ((usable_h - item_h + TOL) / step_y) as usize + 1
    } else {
        0
    };

    let mut bw = cols as f64 * item_w + cols.saturating_sub(1) as f64 * gap_x;
    while cols > 0 && bw > usable_w + TOL {
        cols -= 1;
        bw = cols as f64 * item_w + cols.saturating_sub(1) as f64 * gap_x;
    }
    let mut bh = rows as f64 * item_h + rows.saturating_sub(1) as f64 * gap_y;
    while rows > 0 && bh > usable_h + TOL {
        rows -= 1;
        bh = rows as f64 * item_h + rows.saturating_sub(1) as f64 * gap_y;
    }

    let mut items = Vec::with_capacity(cols * rows);
    for r in 0..rows {
        for c in 0..cols {
            items.push(item(
                c,
                r,
                c as f64 * step_x,
                r as f64 * step_y,
                item_w,
                item_h,
                rotated,
                false,
            ));
        }
    }
    items
}

// ─── Pointy-top hex ─────────────────────────────────────────────────
pub fn pointy_hex(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    is_rotated: bool,
) -> ShapeResult {
    if item_w <= 0.05 || item_h <= 0.05 {
        return empty("hex_pointy");
    }
    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let h_step = item_w + gap_x;
    let v_step = item_h * 0.75 + gap_y;
    let mut items = Vec::new();
    let mut r = 0usize;
    loop {
        let cy = ry + r as f64 * v_step;
        if cy - ry > usable_h + 0.001 {
            break;
        }
        let h_off = if r % 2 != 0 { h_step / 2.0 } else { 0.0 };
        let mut c = 0usize;
        loop {
            let cx = rx + h_off + c as f64 * h_step;
            if cx - rx > usable_w + 0.001 {
                break;
            }
            if cx + rx <= usable_w + 0.001 && cy + ry <= usable_h + 0.001 {
                items.push(item(
                    c,
                    r,
                    cx - rx,
                    cy - ry,
                    item_w,
                    item_h,
                    is_rotated,
                    false,
                ));
            }
            c += 1;
        }
        r += 1;
    }
    finish(items, "hex_pointy")
}

// ─── Flat-top hex ───────────────────────────────────────────────────
pub fn flat_hex(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    is_rotated: bool,
) -> ShapeResult {
    if item_w <= 0.05 || item_h <= 0.05 {
        return empty("hex_flat");
    }
    let rx = item_w / 2.0;
    let ry = item_h / 2.0;
    let v_step = item_h + gap_y;
    let h_step = item_w * 0.75 + gap_x;
    let mut items = Vec::new();
    let mut c = 0usize;
    loop {
        let cx = rx + c as f64 * h_step;
        if cx - rx > usable_w + 0.001 {
            break;
        }
        let v_off = if c % 2 != 0 { v_step / 2.0 } else { 0.0 };
        let mut r = 0usize;
        loop {
            let cy = ry + v_off + r as f64 * v_step;
            if cy - ry > usable_h + 0.001 {
                break;
            }
            if cx + rx <= usable_w + 0.001 && cy + ry <= usable_h + 0.001 {
                items.push(item(
                    c,
                    r,
                    cx - rx,
                    cy - ry,
                    item_w,
                    item_h,
                    is_rotated,
                    false,
                ));
            }
            r += 1;
        }
        c += 1;
    }
    finish(items, "hex_flat")
}

// ─── Advanced trapezoid ─────────────────────────────────────────────
pub fn trapezoid(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    sp: &ShapeProps,
    is_rotated_90: bool,
) -> ShapeResult {
    let (eiw, eih, egx, egy) = if is_rotated_90 {
        (item_h, item_w, gap_y, gap_x)
    } else {
        (item_w, item_h, gap_x, gap_y)
    };
    let is_h_base = (sp.is_horizontal.unwrap_or(1.0)).round() == 1.0;
    let is_horizontal = if is_rotated_90 { !is_h_base } else { is_h_base };
    let (left_oh, right_oh) = if is_rotated_90 {
        (sp.right_oh.unwrap_or(0.0), sp.left_oh.unwrap_or(0.0))
    } else {
        (sp.left_oh.unwrap_or(0.0), sp.right_oh.unwrap_or(0.0))
    };

    let half_w = eiw / 2.0;
    let half_h = eih / 2.0;
    let mut items = Vec::new();

    if is_horizontal {
        let step_a = eiw - right_oh + egx;
        let step_b = eiw - left_oh + egx;
        let step_y = eih + egy;
        let num_rows = if step_y > 0.0 {
            1 + ((usable_h - eih + TOL) / step_y) as usize
        } else {
            1
        };
        for row in 0..num_rows {
            let cy = half_h + row as f64 * step_y;
            if cy + half_h > usable_h + TOL {
                break;
            }
            let mut cx = half_w;
            let mut col = 0usize;
            while cx + half_w <= usable_w + TOL {
                items.push(item(
                    col,
                    row,
                    cx - half_w,
                    cy - half_h,
                    eiw,
                    eih,
                    is_rotated_90,
                    col % 2 != 0,
                ));
                cx += if col % 2 == 0 { step_a } else { step_b };
                col += 1;
            }
        }
    } else {
        let step_a = eih - right_oh + egy;
        let step_b = eih - left_oh + egy;
        let step_x = eiw + egx;
        let num_cols = if step_x > 0.0 {
            1 + ((usable_w - eiw + TOL) / step_x) as usize
        } else {
            1
        };
        for col in 0..num_cols {
            let cx = half_w + col as f64 * step_x;
            if cx + half_w > usable_w + TOL {
                break;
            }
            let mut cy = half_h;
            let mut row = 0usize;
            while cy + half_h <= usable_h + TOL {
                items.push(item(
                    col,
                    row,
                    cx - half_w,
                    cy - half_h,
                    eiw,
                    eih,
                    is_rotated_90,
                    row % 2 != 0,
                ));
                cy += if row % 2 == 0 { step_a } else { step_b };
                row += 1;
            }
        }
    }
    finish(items, "trapezoid_advanced")
}

// ─── Advanced triangle ──────────────────────────────────────────────
pub fn triangle(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    sp: &ShapeProps,
    is_rotated_90: bool,
) -> ShapeResult {
    let apex_str = sp.triangle_apex.clone().unwrap_or_else(|| "up".to_string());
    let (w_orig, h_orig) = if is_rotated_90 {
        (item_h, item_w)
    } else {
        (item_w, item_h)
    };
    if w_orig <= 0.0 || h_orig <= 0.0 || usable_w < w_orig - TOL || usable_h < h_orig - TOL {
        return empty("triangle_advanced");
    }

    let effective_apex = if is_rotated_90 {
        match apex_str.as_str() {
            "up" => "right",
            "right" => "down",
            "down" => "left",
            "left" => "up",
            _ => "up",
        }
    } else {
        apex_str.as_str()
    };

    let delta_w = sp.delta_w.unwrap_or(0.0);
    let gap_mult = sp.gap_multiplier_h.unwrap_or(1.0);
    let mut items = Vec::new();
    let is_horizontal = effective_apex == "left" || effective_apex == "right";

    if is_horizontal {
        let h_step = w_orig + gap_x;
        let v_step = h_orig + gap_y * gap_mult + delta_w * 2.0;
        let mut current_x = 0.0;
        let mut c_idx = 0usize;
        while current_x + w_orig <= usable_w + TOL {
            let mut r = 0usize;
            loop {
                let cy = r as f64 * v_step;
                if cy + h_orig > usable_h + TOL {
                    break;
                }
                let is180 = effective_apex == "left";
                items.push(item(
                    c_idx,
                    r,
                    current_x,
                    cy,
                    w_orig,
                    h_orig,
                    is_rotated_90,
                    is180,
                ));
                r += 1;
            }
            let mut r = 0usize;
            loop {
                let cy = v_step / 2.0 + r as f64 * v_step;
                if cy + h_orig > usable_h + TOL {
                    break;
                }
                let is180 = effective_apex == "right";
                items.push(item(
                    c_idx,
                    r,
                    current_x,
                    cy,
                    w_orig,
                    h_orig,
                    is_rotated_90,
                    is180,
                ));
                r += 1;
            }
            current_x += h_step;
            c_idx += 1;
        }
    } else {
        let v_step = h_orig + gap_y;
        let h_step = w_orig + gap_x * gap_mult + delta_w * 2.0;
        let mut current_y = 0.0;
        let mut r_idx = 0usize;
        while current_y + h_orig <= usable_h + TOL {
            let mut c = 0usize;
            loop {
                let cx = c as f64 * h_step;
                if cx + w_orig > usable_w + TOL {
                    break;
                }
                let is180 = effective_apex == "up";
                items.push(item(
                    c,
                    r_idx,
                    cx,
                    current_y,
                    w_orig,
                    h_orig,
                    is_rotated_90,
                    is180,
                ));
                c += 1;
            }
            let mut c = 0usize;
            loop {
                let cx = h_step / 2.0 + c as f64 * h_step;
                if cx + w_orig > usable_w + TOL {
                    break;
                }
                let is180 = effective_apex == "down";
                items.push(item(
                    c,
                    r_idx,
                    cx,
                    current_y,
                    w_orig,
                    h_orig,
                    is_rotated_90,
                    is180,
                ));
                c += 1;
            }
            current_y += v_step;
            r_idx += 1;
        }
    }
    finish(items, "triangle_advanced")
}

// ─── Advanced pentagon ──────────────────────────────────────────────
pub fn pentagon(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    sp: &ShapeProps,
    is_rotated_90: bool,
    start_with_down: bool,
) -> ShapeResult {
    let (w_orig, h_orig) = if is_rotated_90 {
        (item_h, item_w)
    } else {
        (item_w, item_h)
    };
    if w_orig <= 0.0 || h_orig <= 0.0 || usable_w < w_orig - TOL || usable_h < h_orig - TOL {
        return empty("pentagon_advanced");
    }

    if is_rotated_90 {
        let inner = pentagon_inner(
            usable_h,
            usable_w,
            item_w,
            item_h,
            gap_y,
            gap_x,
            sp,
            start_with_down,
        );
        let mut items: Vec<StickerItem> = inner
            .into_iter()
            .map(|it| StickerItem {
                c: it.r,
                r: it.c,
                x: it.y,
                y: it.x,
                width: it.height,
                height: it.width,
                is_rotated: true,
                is_rotated_180: it.is_rotated_180,
                block_id: 0,
            })
            .collect();
        if items.is_empty() {
            return empty("pentagon_advanced");
        }
        normalize(&mut items);
        let (_, _, w, h) = bbox(&items);
        let n = items.len();
        return ShapeResult {
            total_items: n,
            items,
            width_used: w,
            height_used: h,
            strategy_used: "pentagon_advanced".to_string(),
            main_rotated: None,
        };
    }

    let items = pentagon_inner(
        usable_w,
        usable_h,
        item_w,
        item_h,
        gap_x,
        gap_y,
        sp,
        start_with_down,
    );
    finish(items, "pentagon_advanced")
}

fn pentagon_inner(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    sp: &ShapeProps,
    start_with_down: bool,
) -> Vec<StickerItem> {
    let peak_ratio = sp.peak_height_ratio.unwrap_or(0.25).clamp(0.0, 1.0);
    let orientation = sp
        .pentagon_orientation
        .clone()
        .unwrap_or_else(|| "up".to_string());

    let w_orig = item_w;
    let h_orig = item_h;
    let peak_h = h_orig * peak_ratio;
    let base_h = h_orig - peak_h;
    let h_step = w_orig + gap_x;

    let mut items = Vec::new();
    let mut current_y = 0.0;
    let mut row_idx = 0usize;

    while current_y + h_orig <= usable_h + TOL {
        let is_row_down = if start_with_down {
            row_idx % 2 == 0
        } else {
            row_idx % 2 != 0
        };
        let is_rotated_180 = if orientation == "down" {
            !is_row_down
        } else {
            is_row_down
        };
        let is_stag = row_idx % 2 != 0;
        let h_off = if is_stag { h_step / 2.0 } else { 0.0 };

        let mut c = 0usize;
        loop {
            let cx = w_orig / 2.0 + h_off + c as f64 * h_step;
            if cx + w_orig / 2.0 > usable_w + TOL {
                break;
            }
            items.push(item(
                c,
                row_idx,
                cx - w_orig / 2.0,
                current_y,
                w_orig,
                h_orig,
                false,
                is_rotated_180,
            ));
            c += 1;
        }

        let y_step = if is_row_down {
            base_h + gap_y
        } else {
            h_orig + gap_y
        };
        current_y += y_step;
        row_idx += 1;
    }
    items
}

// ─── Parallelogram ──────────────────────────────────────────────────
pub fn parallelogram(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    sp: &ShapeProps,
) -> ShapeResult {
    if item_w <= 0.0 || item_h <= 0.0 {
        return empty("parallelogram");
    }
    let oh_x = sp.overhang_x.unwrap_or(0.0);
    let oh_y = sp.overhang_y.unwrap_or(0.0);

    let mut best_items: Vec<StickerItem> = Vec::new();
    let mut best_is_rotated = false;

    for pass_idx in 0..4 {
        let is_rot = pass_idx >= 2;
        let interlock_x = pass_idx % 2 == 0;
        let (cur_w, cur_h) = if is_rot {
            (item_h, item_w)
        } else {
            (item_w, item_h)
        };
        let (cur_gap_h, cur_gap_v) = if is_rot {
            (gap_y, gap_x)
        } else {
            (gap_x, gap_y)
        };
        let (cur_oh_x, cur_oh_y) = if is_rot { (oh_y, oh_x) } else { (oh_x, oh_y) };
        let half_w = cur_w / 2.0;
        let half_h = cur_h / 2.0;
        let mut items = Vec::new();

        if interlock_x && cur_oh_x > 0.1 {
            let step_x = cur_w - cur_oh_x + cur_gap_h;
            let step_y = cur_h + cur_gap_v;
            let n_cols = if step_x > 0.0 {
                1 + ((usable_w - cur_w + TOL) / step_x) as usize
            } else {
                1
            };
            let n_rows = if step_y > 0.0 {
                1 + ((usable_h - cur_h + TOL) / step_y) as usize
            } else {
                1
            };
            for row in 0..n_rows {
                let cy = half_h + row as f64 * step_y;
                if cy + half_h > usable_h + TOL {
                    break;
                }
                for col in 0..n_cols {
                    let cx = half_w + col as f64 * step_x;
                    if cx + half_w > usable_w + TOL {
                        break;
                    }
                    items.push(item(
                        col,
                        row,
                        cx - half_w,
                        cy - half_h,
                        cur_w,
                        cur_h,
                        is_rot,
                        col % 2 != 0,
                    ));
                }
            }
        } else if !interlock_x && cur_oh_y > 0.1 {
            let step_x = cur_w + cur_gap_h;
            let step_y = cur_h - cur_oh_y + cur_gap_v;
            let n_cols = if step_x > 0.0 {
                1 + ((usable_w - cur_w + TOL) / step_x) as usize
            } else {
                1
            };
            let n_rows = if step_y > 0.0 {
                1 + ((usable_h - cur_h + TOL) / step_y) as usize
            } else {
                1
            };
            for col in 0..n_cols {
                let cx = half_w + col as f64 * step_x;
                if cx + half_w > usable_w + TOL {
                    break;
                }
                for row in 0..n_rows {
                    let cy = half_h + row as f64 * step_y;
                    if cy + half_h > usable_h + TOL {
                        break;
                    }
                    items.push(item(
                        col,
                        row,
                        cx - half_w,
                        cy - half_h,
                        cur_w,
                        cur_h,
                        is_rot,
                        row % 2 != 0,
                    ));
                }
            }
        }

        if items.len() > best_items.len() {
            best_items = items;
            best_is_rotated = is_rot;
        }
    }

    if !best_items.is_empty() {
        let (bx, by, bw, bh) = bbox(&best_items);
        let ox = (usable_w - bw) / 2.0 - bx;
        let oy = (usable_h - bh) / 2.0 - by;
        for it in best_items.iter_mut() {
            it.x += ox;
            it.y += oy;
        }
    }

    let grid1 = solve_grid_internal(usable_w, usable_h, item_w, item_h, gap_x, gap_y, false);
    let grid2 = solve_grid_internal(usable_w, usable_h, item_h, item_w, gap_x, gap_y, true);

    let mut final_items = best_items;
    let mut final_rotated = best_is_rotated;
    let mut strategy = "parallelogram_interlock";

    if grid1.len() > final_items.len() {
        final_items = grid1;
        final_rotated = false;
        strategy = "grid";
    }
    if grid2.len() > final_items.len() {
        final_items = grid2;
        final_rotated = true;
        strategy = "grid_rot";
    }

    if final_items.is_empty() {
        return empty("parallelogram");
    }
    let (_, _, w, h) = bbox(&final_items);
    let n = final_items.len();
    ShapeResult {
        total_items: n,
        items: final_items,
        width_used: w,
        height_used: h,
        strategy_used: strategy.to_string(),
        main_rotated: Some(final_rotated),
    }
}

// ─── L-shape ────────────────────────────────────────────────────────
pub fn l_layout(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
) -> ShapeResult {
    let split_gap = gap_x.max(gap_y);

    fn try_config(
        usable_w: f64,
        usable_h: f64,
        main_w: f64,
        main_h: f64,
        fill_w: f64,
        fill_h: f64,
        gap_x: f64,
        gap_y: f64,
        split_gap: f64,
        primary_rotated: bool,
    ) -> (usize, Vec<StickerItem>, f64, f64) {
        let max_grid = solve_grid_internal(usable_w, usable_h, main_w, main_h, gap_x, gap_y, false);
        if max_grid.is_empty() {
            return (0, Vec::new(), 0.0, 0.0);
        }

        let step_x = (main_w * 0.05).max(main_w + gap_x);
        let step_y = (main_h * 0.05).max(main_h + gap_y);
        let max_cols = if step_x > 0.0 && usable_w + TOL >= main_w {
            ((usable_w - main_w + TOL) / step_x) as usize + 1
        } else {
            0
        };
        let max_rows = if step_y > 0.0 && usable_h + TOL >= main_h {
            ((usable_h - main_h + TOL) / step_y) as usize + 1
        } else {
            0
        };
        if max_cols < 1 || max_rows < 1 {
            return (0, Vec::new(), 0.0, 0.0);
        }

        let mut best_yield = 0usize;
        let mut best_items: Vec<StickerItem> = Vec::new();
        let mut best_w = 0.0f64;
        let mut best_h = 0.0f64;

        for reduce_c in 0..2.min(max_cols) {
            for reduce_r in 0..2.min(max_rows) {
                if reduce_c > 0 && reduce_r > 0 {
                    continue;
                }
                let tc = max_cols - reduce_c;
                let tr = max_rows - reduce_r;
                if tc == 0 || tr == 0 {
                    continue;
                }

                let tbw = tc as f64 * main_w + (tc - 1) as f64 * gap_x;
                let tbh = tr as f64 * main_h + (tr - 1) as f64 * gap_y;

                let mut main_items =
                    solve_grid_internal(tbw, tbh, main_w, main_h, gap_x, gap_y, false);
                for it in main_items.iter_mut() {
                    it.is_rotated = primary_rotated;
                    it.block_id = 0;
                }

                let right_x = tbw + split_gap;
                let right_w = usable_w - right_x;
                let mut right_items = Vec::new();
                if right_w > fill_w - TOL {
                    let mut ri =
                        solve_grid_internal(right_w, usable_h, fill_w, fill_h, gap_x, gap_y, false);
                    for it in ri.iter_mut() {
                        it.x += right_x;
                        it.is_rotated = !primary_rotated;
                        it.block_id = 1;
                    }
                    right_items = ri;
                }

                let bottom_y = tbh + split_gap;
                let bottom_h = usable_h - bottom_y;
                let mut bottom_items = Vec::new();
                if bottom_h > fill_h - TOL {
                    let mut bi = solve_grid_internal(
                        usable_w, bottom_h, fill_w, fill_h, gap_x, gap_y, false,
                    );
                    for it in bi.iter_mut() {
                        it.y += bottom_y;
                        it.is_rotated = !primary_rotated;
                        it.block_id = 2;
                    }
                    bottom_items = bi;
                }

                let mut all_items = main_items;
                all_items.extend(right_items);
                all_items.extend(bottom_items);

                if all_items.len() > best_yield {
                    best_yield = all_items.len();
                    best_w = all_items
                        .iter()
                        .map(|i| i.x + i.width)
                        .fold(0.0f64, f64::max);
                    best_h = all_items
                        .iter()
                        .map(|i| i.y + i.height)
                        .fold(0.0f64, f64::max);
                    best_items = all_items;
                }
            }
        }
        (best_yield, best_items, best_w, best_h)
    }

    let (y1, items1, w1, h1) = try_config(
        usable_w, usable_h, item_w, item_h, item_h, item_w, gap_x, gap_y, split_gap, false,
    );
    let (y2, items2, w2, h2) = try_config(
        usable_w, usable_h, item_h, item_w, item_w, item_h, gap_x, gap_y, split_gap, true,
    );

    let (best_items, best_w, best_h) = if y1 >= y2 {
        (items1, w1, h1)
    } else {
        (items2, w2, h2)
    };
    if best_items.is_empty() {
        return empty("l_shape");
    }
    let n = best_items.len();
    ShapeResult {
        total_items: n,
        items: best_items,
        width_used: best_w,
        height_used: best_h,
        strategy_used: "l_shape".to_string(),
        main_rotated: None,
    }
}

// ─── Hammer (Illustrator port) ──────────────────────────────────────
pub fn hammer(
    usable_w: f64,
    usable_h: f64,
    bb_w: f64,
    bb_h: f64,
    gap_h: f64,
    gap_v: f64,
    sp: &ShapeProps,
    disable_l_shape: bool,
) -> ShapeResult {
    let big_end_first = sp.big_end_first.unwrap_or(1.0) > 0.5;
    let mut best_items: Vec<StickerItem> = Vec::new();
    let mut best_pass = 0usize;

    for pass_idx in 0..2usize {
        let (cur_w, cur_h, cur_gap_h, cur_gap_v) = if pass_idx == 0 {
            (bb_w, bb_h, gap_h, gap_v)
        } else {
            (bb_h, bb_w, gap_v, gap_h)
        };
        let is_rotated_90 = pass_idx == 1;
        let half_w = cur_w / 2.0;
        let half_h = cur_h / 2.0;

        let mut body_w = sp.body_w.unwrap_or(0.0);
        if body_w <= 0.0 {
            body_w = cur_w.min(cur_h) * 0.5;
        }
        let small_d = sp.small_d.unwrap_or(0.0);
        let small_asymm = sp.small_asymm_offset.unwrap_or(0.0);
        let effective_tail_w = body_w.max(small_d + 2.0 * small_asymm);
        let mut safe_asymm = sp.asymm_offset.unwrap_or(0.0);
        if safe_asymm <= 1.0 {
            safe_asymm = 0.0;
        }

        let mut items = Vec::new();

        if cur_h >= cur_w {
            let mut col_pitch = (cur_w + effective_tail_w) / 2.0 + safe_asymm + cur_gap_h;
            let safe_pitch = sp.safe_interlock_pitch.unwrap_or(0.0);
            if safe_pitch > 0.0 {
                let pbp = safe_pitch + cur_gap_h;
                if pbp > col_pitch {
                    col_pitch = pbp;
                }
            }
            let row_pitch = cur_h + cur_gap_v;
            let num_cols = if usable_w >= cur_w - TOL {
                ((usable_w - cur_w + TOL) / col_pitch) as usize + 1
            } else {
                0
            };
            let num_rows = if usable_h >= cur_h - TOL {
                ((usable_h - cur_h + TOL) / row_pitch) as usize + 1
            } else {
                0
            };
            for col in 0..num_cols {
                let cx = half_w + col as f64 * col_pitch;
                if cx + half_w > usable_w + TOL {
                    continue;
                }
                for row in 0..num_rows {
                    let cy = half_h + row as f64 * row_pitch;
                    if cy + half_h <= usable_h + TOL {
                        let r180 = if big_end_first {
                            col % 2 != 0
                        } else {
                            col % 2 == 0
                        };
                        items.push(item(
                            col,
                            row,
                            cx - half_w,
                            cy - half_h,
                            cur_w,
                            cur_h,
                            is_rotated_90,
                            r180,
                        ));
                    }
                }
            }
        } else {
            let mut row_pitch = (cur_h + effective_tail_w) / 2.0 + safe_asymm + cur_gap_v;
            let safe_pitch = sp.safe_interlock_pitch.unwrap_or(0.0);
            if safe_pitch > 0.0 {
                let pbp = safe_pitch + cur_gap_v;
                if pbp > row_pitch {
                    row_pitch = pbp;
                }
            }
            let col_pitch = cur_w + cur_gap_h;
            let num_rows = if usable_h >= cur_h - TOL {
                ((usable_h - cur_h + TOL) / row_pitch) as usize + 1
            } else {
                0
            };
            let num_cols = if usable_w >= cur_w - TOL {
                ((usable_w - cur_w + TOL) / col_pitch) as usize + 1
            } else {
                0
            };
            for row in 0..num_rows {
                let cy = half_h + row as f64 * row_pitch;
                if cy + half_h > usable_h + TOL {
                    continue;
                }
                for col in 0..num_cols {
                    let cx = half_w + col as f64 * col_pitch;
                    if cx + half_w <= usable_w + TOL {
                        let r180 = if big_end_first {
                            row % 2 != 0
                        } else {
                            row % 2 == 0
                        };
                        items.push(item(
                            col,
                            row,
                            cx - half_w,
                            cy - half_h,
                            cur_w,
                            cur_h,
                            is_rotated_90,
                            r180,
                        ));
                    }
                }
            }
        }

        if items.len() > best_items.len() {
            best_items = items;
            best_pass = pass_idx;
        }
    }

    if best_items.is_empty() {
        return empty("illustrator_hammer");
    }
    normalize(&mut best_items);
    let (_, _, w, h) = bbox(&best_items);
    let n = best_items.len();
    let main_rotated = if disable_l_shape {
        None
    } else {
        Some(best_pass == 1)
    };
    ShapeResult {
        total_items: n,
        items: best_items,
        width_used: w,
        height_used: h,
        strategy_used: "illustrator_hammer".to_string(),
        main_rotated,
    }
}

// ─── Dumbbell pair-col ──────────────────────────────────────────────
pub fn dumbbell_pair_col(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    big_end_axis_frac: f64,
    is_rotated_90: bool,
) -> ShapeResult {
    let (w, h) = if is_rotated_90 {
        (item_h, item_w)
    } else {
        (item_w, item_h)
    };
    if w <= 0.0 || h <= 0.0 || usable_w < w - TOL || usable_h < h - TOL {
        return empty("dumbbell_pair_col");
    }

    let row_pitch = h + gap_y * 2.0;
    let half_v = row_pitch / 2.0;
    let h_shift = big_end_axis_frac * w + gap_x;
    let pair_w = w + h_shift;
    let pair_pitch = pair_w + gap_x;

    let num_pairs = if usable_w >= pair_w - TOL {
        ((usable_w - pair_w + TOL) / pair_pitch) as usize + 1
    } else {
        0
    };
    let num_rows_a = if usable_h >= h - TOL {
        ((usable_h - h + TOL) / row_pitch) as usize + 1
    } else {
        0
    };
    let num_rows_b = if usable_h >= h + half_v - TOL {
        ((usable_h - h - half_v + TOL) / row_pitch) as usize + 1
    } else {
        0
    };

    let mut items = Vec::new();
    for p in 0..num_pairs {
        let base_x = p as f64 * pair_pitch;
        if base_x + w <= usable_w + TOL {
            for r in 0..num_rows_a {
                let cy = r as f64 * row_pitch;
                if cy + h <= usable_h + TOL {
                    items.push(item(p * 2, r, base_x, cy, w, h, is_rotated_90, false));
                }
            }
        }
        let bx = base_x + h_shift;
        if bx + w <= usable_w + TOL {
            for r in 0..num_rows_b {
                let cy = half_v + r as f64 * row_pitch;
                if cy + h <= usable_h + TOL {
                    items.push(item(p * 2 + 1, r, bx, cy, w, h, is_rotated_90, true));
                }
            }
        }
    }

    if num_pairs == 0 && usable_w >= w - TOL {
        for r in 0..num_rows_a {
            let cy = r as f64 * row_pitch;
            if cy + h <= usable_h + TOL {
                items.push(item(0, r, 0.0, cy, w, h, is_rotated_90, false));
            }
        }
    }

    finish(items, "dumbbell_pair_col")
}

// ─── Dumbbell pair-row ──────────────────────────────────────────────
pub fn dumbbell_pair_row(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    big_end_axis_frac: f64,
    is_rotated_90: bool,
) -> ShapeResult {
    let (w, h) = if is_rotated_90 {
        (item_h, item_w)
    } else {
        (item_w, item_h)
    };
    if w <= 0.0 || h <= 0.0 || usable_w < w - TOL || usable_h < h - TOL {
        return empty("dumbbell_pair_row");
    }

    let col_pitch = w + gap_x * 2.0;
    let half_h_off = col_pitch / 2.0;
    let v_shift = big_end_axis_frac * h + gap_y;
    let pair_h = h + v_shift;
    let pair_v_pitch = pair_h + gap_y;

    let num_pairs = if usable_h >= pair_h - TOL {
        ((usable_h - pair_h + TOL) / pair_v_pitch) as usize + 1
    } else {
        0
    };
    let num_cols_a = if usable_w >= w - TOL {
        ((usable_w - w + TOL) / col_pitch) as usize + 1
    } else {
        0
    };
    let num_cols_b = if usable_w >= w + half_h_off - TOL {
        ((usable_w - w - half_h_off + TOL) / col_pitch) as usize + 1
    } else {
        0
    };

    let mut items = Vec::new();
    for p in 0..num_pairs {
        let base_y = p as f64 * pair_v_pitch;
        if base_y + h <= usable_h + TOL {
            for c in 0..num_cols_a {
                let cx = c as f64 * col_pitch;
                if cx + w <= usable_w + TOL {
                    items.push(item(c, p * 2, cx, base_y, w, h, is_rotated_90, false));
                }
            }
        }
        let by = base_y + v_shift;
        if by + h <= usable_h + TOL {
            for c in 0..num_cols_b {
                let cx = half_h_off + c as f64 * col_pitch;
                if cx + w <= usable_w + TOL {
                    items.push(item(c, p * 2 + 1, cx, by, w, h, is_rotated_90, true));
                }
            }
        }
    }

    if num_pairs == 0 && usable_h >= h - TOL {
        for c in 0..num_cols_a {
            let cx = c as f64 * col_pitch;
            if cx + w <= usable_w + TOL {
                items.push(item(c, 0, cx, 0.0, w, h, is_rotated_90, false));
            }
        }
    }

    finish(items, "dumbbell_pair_row")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_bounds(r: &ShapeResult, uw: f64, uh: f64) {
        for it in &r.items {
            assert!(it.x >= -TOL && it.y >= -TOL, "toạ độ âm: {:?}", it);
            assert!(it.x + it.width <= uw + TOL, "tràn ngang: {:?}", it);
            assert!(it.y + it.height <= uh + TOL, "tràn dọc: {:?}", it);
        }
    }

    #[test]
    fn trapezoid_produces_items() {
        let sp = ShapeProps {
            left_oh: Some(9.35),
            right_oh: Some(9.35),
            is_horizontal: Some(1.0),
            ..Default::default()
        };
        let r = trapezoid(847.56, 1145.20, 145.39, 305.88, 5.67, 5.67, &sp, false);
        assert!(r.total_items > 0);
        in_bounds(&r, 847.56, 1145.20);
    }

    #[test]
    fn triangle_pentagon_hammer_dumbbell_nonzero() {
        let sp = ShapeProps::default();
        assert!(triangle(320.0, 450.0, 60.0, 60.0, 2.0, 2.0, &sp, false).total_items > 0);
        assert!(pentagon(320.0, 450.0, 60.0, 60.0, 2.0, 2.0, &sp, false, false).total_items > 0);
        let sph = ShapeProps {
            body_w: Some(30.0),
            ..Default::default()
        };
        assert!(hammer(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, &sph, false).total_items > 0);
        assert!(dumbbell_pair_col(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, 0.65, false).total_items > 0);
        assert!(dumbbell_pair_row(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, 0.65, false).total_items > 0);
    }

    #[test]
    fn parallelogram_main_rotated_flag() {
        let sp = ShapeProps {
            overhang_x: Some(20.0),
            ..Default::default()
        };
        let r = parallelogram(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, &sp);
        assert!(r.total_items > 0);
        assert!(r.main_rotated.is_some());
        in_bounds(&r, 320.0, 450.0);
    }

    #[test]
    fn l_shape_at_least_grid() {
        let g = solve_grid_internal(320.0, 450.0, 80.0, 50.0, 2.0, 2.0, false);
        let l = l_layout(320.0, 450.0, 80.0, 50.0, 2.0, 2.0);
        assert!(l.total_items >= g.len());
        in_bounds(&l, 320.0, 450.0);
    }
}
