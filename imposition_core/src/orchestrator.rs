//! Orchestrator — sinh danh sách ứng viên layout theo shape_type + strategy.
//! Port thuần Rust từ `native/src/imposition/orchestrator.rs` (Task 5 / Req 1.1).
//!
//! Lưu ý: orchestrator chỉ SINH ứng viên; việc giải va chạm (NFP/Shapely) nằm
//! ở bước sau. Mỗi ứng viên gồm (items, rotated, strategy_name).

use crate::shape::{self, ShapeProps, ShapeResult};
use crate::sticker::{self, ClusterParams, ColAltParams, RowAltParams, StickerResult};

/// Một ứng viên layout đã chuẩn hóa.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutCandidate {
    pub items: Vec<crate::sticker::StickerItem>,
    pub total_items: usize,
    pub width_used: f64,
    pub height_used: f64,
    pub rotated: bool,
    pub strategy: String,
}

impl LayoutCandidate {
    fn from_sticker(r: StickerResult, rotated: bool, strategy: &str) -> Self {
        LayoutCandidate {
            total_items: r.total_items,
            items: r.items,
            width_used: r.width_used,
            height_used: r.height_used,
            rotated,
            strategy: strategy.to_string(),
        }
    }
    fn from_shape(r: ShapeResult, rotated: bool, strategy: &str) -> Self {
        LayoutCandidate {
            total_items: r.total_items,
            items: r.items,
            width_used: r.width_used,
            height_used: r.height_used,
            rotated,
            strategy: strategy.to_string(),
        }
    }
}

/// Tham số cluster/alternating tùy chọn (tương đương p5/p6/p5_row...).
#[derive(Clone, Copy, Debug, Default)]
pub struct OrchestratorParams {
    pub p5: Option<ClusterParams>,
    pub p6: Option<ClusterParams>,
    pub p5_row: Option<RowAltParams>,
    pub p6_row: Option<RowAltParams>,
    pub p5_col: Option<ColAltParams>,
    pub p6_col: Option<ColAltParams>,
}

fn dx_outer_positive(p: &Option<ClusterParams>) -> bool {
    p.as_ref()
        .and_then(|c| c.dx_outer)
        .map(|v| v > 0.0)
        .unwrap_or(false)
}

/// Sinh ứng viên layout. Tương đương `generate_layout_candidates`.
#[allow(clippy::too_many_arguments)]
pub fn generate_layout_candidates(
    usable_w: f64,
    usable_h: f64,
    item_w: f64,
    item_h: f64,
    gap_x: f64,
    gap_y: f64,
    strategy: &str,
    params: &OrchestratorParams,
    shape_type: &str,
    sp: &ShapeProps,
) -> Vec<LayoutCandidate> {
    let mut out: Vec<LayoutCandidate> = Vec::new();

    let push_cluster_alt = |out: &mut Vec<LayoutCandidate>| {
        if let Some(p5) = params.p5 {
            out.push(LayoutCandidate::from_sticker(
                sticker::cluster_grid(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p5),
                    false,
                ),
                false,
                "head_to_tail",
            ));
        }
        if let Some(p6) = params.p6 {
            out.push(LayoutCandidate::from_sticker(
                sticker::cluster_grid(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p6),
                    true,
                ),
                true,
                "head_to_tail",
            ));
        }
        if let Some(p5r) = params.p5_row {
            out.push(LayoutCandidate::from_sticker(
                sticker::row_alternating(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p5r),
                    false,
                ),
                false,
                "row_alt",
            ));
        }
        if let Some(p6r) = params.p6_row {
            out.push(LayoutCandidate::from_sticker(
                sticker::row_alternating(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p6r),
                    true,
                ),
                true,
                "row_alt",
            ));
        }
        if let Some(p5c) = params.p5_col {
            out.push(LayoutCandidate::from_sticker(
                sticker::col_alternating(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p5c),
                    false,
                ),
                false,
                "col_alt",
            ));
        }
        if let Some(p6c) = params.p6_col {
            out.push(LayoutCandidate::from_sticker(
                sticker::col_alternating(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p6c),
                    true,
                ),
                true,
                "col_alt",
            ));
        }
    };

    let is_pointy = |sp: &ShapeProps| -> bool {
        sp.hex_orientation
            .as_deref()
            .map(|s| s == "pointy-top")
            .unwrap_or(true)
    };

    if strategy == "optimal_auto" {
        match shape_type {
            "HAMMER" | "DUMBBELL" => {
                let p_hammer =
                    shape::hammer(usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, false);
                let rot = p_hammer.main_rotated.unwrap_or(false);
                out.push(LayoutCandidate::from_shape(
                    p_hammer,
                    rot,
                    "hammer_illustrator",
                ));

                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                    false,
                    "grid",
                ));
                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_h, item_w, gap_x, gap_y),
                    true,
                    "grid",
                ));

                if dx_outer_positive(&params.p5) {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::cluster_grid(
                            usable_w, usable_h, item_w, item_h, gap_x, gap_y, params.p5, false,
                        ),
                        false,
                        "head_to_tail",
                    ));
                }
                if dx_outer_positive(&params.p6) {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::cluster_grid(
                            usable_w, usable_h, item_w, item_h, gap_x, gap_y, params.p6, true,
                        ),
                        true,
                        "head_to_tail",
                    ));
                }
                if let Some(p5r) = params.p5_row {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::row_alternating(
                            usable_w,
                            usable_h,
                            item_w,
                            item_h,
                            gap_x,
                            gap_y,
                            Some(p5r),
                            false,
                        ),
                        false,
                        "row_alt",
                    ));
                }
                if let Some(p6r) = params.p6_row {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::row_alternating(
                            usable_w,
                            usable_h,
                            item_w,
                            item_h,
                            gap_x,
                            gap_y,
                            Some(p6r),
                            true,
                        ),
                        true,
                        "row_alt",
                    ));
                }
                if let Some(p5c) = params.p5_col {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::col_alternating(
                            usable_w,
                            usable_h,
                            item_w,
                            item_h,
                            gap_x,
                            gap_y,
                            Some(p5c),
                            false,
                        ),
                        false,
                        "col_alt",
                    ));
                }
                if let Some(p6c) = params.p6_col {
                    out.push(LayoutCandidate::from_sticker(
                        sticker::col_alternating(
                            usable_w,
                            usable_h,
                            item_w,
                            item_h,
                            gap_x,
                            gap_y,
                            Some(p6c),
                            true,
                        ),
                        true,
                        "col_alt",
                    ));
                }
            }
            "TRIANGLE" => {
                out.push(LayoutCandidate::from_shape(
                    shape::triangle(usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, false),
                    false,
                    "triangle_advanced",
                ));
                out.push(LayoutCandidate::from_shape(
                    shape::triangle(usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, true),
                    true,
                    "triangle_advanced",
                ));
            }
            "TRAPEZOID" => {
                let tr =
                    shape::trapezoid(usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, false);
                let rot = tr.main_rotated.unwrap_or(false);
                out.push(LayoutCandidate::from_shape(
                    tr,
                    rot,
                    "trapezoid_illustrator",
                ));
            }
            "PARALLELOGRAM" => {
                let pr = shape::parallelogram(usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp);
                let rot = pr.main_rotated.unwrap_or(false);
                out.push(LayoutCandidate::from_shape(
                    pr,
                    rot,
                    "parallelogram_illustrator",
                ));
            }
            "PENTAGON" | "ARROW" => {
                out.push(LayoutCandidate::from_shape(
                    shape::pentagon(
                        usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, false, false,
                    ),
                    false,
                    "pentagon_advanced",
                ));
                out.push(LayoutCandidate::from_shape(
                    shape::pentagon(
                        usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, false, true,
                    ),
                    false,
                    "pentagon_advanced",
                ));
                out.push(LayoutCandidate::from_shape(
                    shape::pentagon(
                        usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, true, false,
                    ),
                    true,
                    "pentagon_advanced",
                ));
                out.push(LayoutCandidate::from_shape(
                    shape::pentagon(
                        usable_w, usable_h, item_w, item_h, gap_x, gap_y, sp, true, true,
                    ),
                    true,
                    "pentagon_advanced",
                ));
            }
            "HEXAGON" => {
                let h1 = sticker::hex_tiling_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
                let h2 = sticker::hex_tiling_row(usable_w, usable_h, item_h, item_w, gap_y, gap_x);
                let h3 = sticker::hex_tiling_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
                let h4 = sticker::hex_tiling_col(usable_w, usable_h, item_h, item_w, gap_y, gap_x);
                if is_pointy(sp) {
                    out.push(LayoutCandidate::from_sticker(h1, false, "hex_tiling"));
                    out.push(LayoutCandidate::from_sticker(h4, true, "hex_tiling"));
                } else {
                    out.push(LayoutCandidate::from_sticker(h3, false, "hex_tiling"));
                    out.push(LayoutCandidate::from_sticker(h2, true, "hex_tiling"));
                }
            }
            "CIRCLE_ELLIPSE" => {
                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                    false,
                    "grid",
                ));
                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_h, item_w, gap_x, gap_y),
                    true,
                    "grid",
                ));
                out.push(LayoutCandidate::from_sticker(
                    sticker::staggered_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                    false,
                    "staggered",
                ));
                out.push(LayoutCandidate::from_sticker(
                    sticker::staggered_hex(usable_w, usable_h, item_h, item_w, gap_y, gap_x),
                    true,
                    "staggered",
                ));
            }
            _ => {
                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                    false,
                    "grid",
                ));
                out.push(LayoutCandidate::from_sticker(
                    sticker::solve_grid(usable_w, usable_h, item_h, item_w, gap_x, gap_y),
                    true,
                    "grid",
                ));
                out.push(LayoutCandidate::from_shape(
                    shape::l_layout(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                    false,
                    "l_shape",
                ));
                if shape_type != "CUSTOM" {
                    push_cluster_alt(&mut out);
                }
            }
        }
    } else if strategy == "head_to_tail" {
        if let Some(p5) = params.p5 {
            out.push(LayoutCandidate::from_sticker(
                sticker::cluster_grid(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p5),
                    false,
                ),
                false,
                "head_to_tail",
            ));
        }
        if let Some(p6) = params.p6 {
            out.push(LayoutCandidate::from_sticker(
                sticker::cluster_grid(
                    usable_w,
                    usable_h,
                    item_w,
                    item_h,
                    gap_x,
                    gap_y,
                    Some(p6),
                    true,
                ),
                true,
                "head_to_tail",
            ));
        }
    } else if strategy == "staggered" {
        if shape_type == "HEXAGON" {
            let h1 = sticker::hex_tiling_row(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
            let h2 = sticker::hex_tiling_row(usable_w, usable_h, item_h, item_w, gap_y, gap_x);
            let h3 = sticker::hex_tiling_col(usable_w, usable_h, item_w, item_h, gap_x, gap_y);
            let h4 = sticker::hex_tiling_col(usable_w, usable_h, item_h, item_w, gap_y, gap_x);
            if is_pointy(sp) {
                out.push(LayoutCandidate::from_sticker(
                    h1,
                    false,
                    "staggered_hex_tiling",
                ));
                out.push(LayoutCandidate::from_sticker(
                    h4,
                    true,
                    "staggered_hex_tiling",
                ));
            } else {
                out.push(LayoutCandidate::from_sticker(
                    h3,
                    false,
                    "staggered_hex_tiling",
                ));
                out.push(LayoutCandidate::from_sticker(
                    h2,
                    true,
                    "staggered_hex_tiling",
                ));
            }
        } else {
            out.push(LayoutCandidate::from_sticker(
                sticker::staggered_hex(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                false,
                "staggered",
            ));
            out.push(LayoutCandidate::from_sticker(
                sticker::staggered_hex(usable_w, usable_h, item_h, item_w, gap_y, gap_x),
                true,
                "staggered",
            ));
            out.push(LayoutCandidate::from_sticker(
                sticker::staggered_vertical(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
                false,
                "staggered",
            ));
            out.push(LayoutCandidate::from_sticker(
                sticker::staggered_vertical(usable_w, usable_h, item_h, item_w, gap_y, gap_x),
                true,
                "staggered",
            ));
        }
    } else {
        // grid
        out.push(LayoutCandidate::from_sticker(
            sticker::solve_grid(usable_w, usable_h, item_w, item_h, gap_x, gap_y),
            false,
            "grid",
        ));
        out.push(LayoutCandidate::from_sticker(
            sticker::solve_grid(usable_w, usable_h, item_h, item_w, gap_x, gap_y),
            true,
            "grid",
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_strategy_two_candidates() {
        let sp = ShapeProps::default();
        let p = OrchestratorParams::default();
        let c = generate_layout_candidates(
            320.0,
            450.0,
            50.0,
            50.0,
            2.0,
            2.0,
            "grid",
            &p,
            "RECTANGLE",
            &sp,
        );
        assert_eq!(c.len(), 2);
        assert!(c[0].total_items > 0);
    }

    #[test]
    fn optimal_circle_has_grid_and_staggered() {
        let sp = ShapeProps::default();
        let p = OrchestratorParams::default();
        let c = generate_layout_candidates(
            320.0,
            450.0,
            40.0,
            40.0,
            2.0,
            2.0,
            "optimal_auto",
            &p,
            "CIRCLE_ELLIPSE",
            &sp,
        );
        assert_eq!(c.len(), 4);
        assert!(c.iter().any(|x| x.strategy == "grid"));
        assert!(c.iter().any(|x| x.strategy == "staggered"));
        // ứng viên tốt nhất phải > 0
        assert!(c.iter().map(|x| x.total_items).max().unwrap() > 0);
    }

    #[test]
    fn optimal_hexagon_pointy_default() {
        let sp = ShapeProps::default(); // hex_orientation None → pointy mặc định
        let p = OrchestratorParams::default();
        let c = generate_layout_candidates(
            320.0,
            450.0,
            50.0,
            50.0,
            2.0,
            2.0,
            "optimal_auto",
            &p,
            "HEXAGON",
            &sp,
        );
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|x| x.strategy == "hex_tiling"));
    }

    #[test]
    fn optimal_generic_has_l_shape() {
        let sp = ShapeProps::default();
        let p = OrchestratorParams::default();
        let c = generate_layout_candidates(
            320.0,
            450.0,
            80.0,
            50.0,
            2.0,
            2.0,
            "optimal_auto",
            &p,
            "CUSTOM",
            &sp,
        );
        // CUSTOM: grid x2 + l_shape (không thêm cluster/alt vì == CUSTOM)
        assert_eq!(c.len(), 3);
        assert!(c.iter().any(|x| x.strategy == "l_shape"));
    }
}
