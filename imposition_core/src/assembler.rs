//! Assembler — tính vị trí tuyệt đối + toạ độ mark. Port thuần Rust từ
//! `native/src/imposition/assembler.rs` (Task 5 / Req 2.1).
//! Giữ NGUYÊN VẸN công thức căn lề/lật trục để bảo toàn parity.
//!
//! Đơn vị: pt, gốc toạ độ PDF (Y hướng lên) ở phần tính; `original_cell_y`
//! là toạ độ đỉnh-trên theo hệ Y-xuống (tương thích renderer hiện tại).

use crate::grid::get_src_page_idx;

/// Ô đầu vào cho assembler (toạ độ tương đối trong khối lưới).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AssemblyCell {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_rotated: bool,
    pub is_rotated_180: bool,
    pub block_id: i64,
}

/// Placement tuyệt đối trên tờ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AbsPlacement {
    pub cluster_idx: usize,
    pub src_page_idx: usize,
    pub abs_x: f64,
    pub abs_y: f64,
    pub original_cell_y: f64,
    pub width: f64,
    pub height: f64,
    pub cell: AssemblyCell,
}

/// Đoạn mark cắt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarkSegment {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// Tính toạ độ super_base theo align. Tương đương `compute_alignment`.
pub fn compute_alignment(
    sheet_w: f64,
    sheet_h: f64,
    sheet_usable_w: f64,
    sheet_usable_h: f64,
    margin_left: f64,
    margin_bottom: f64,
    super_grid_w: f64,
    super_grid_h: f64,
    align: &str,
) -> (f64, f64) {
    let super_base_x = if align.contains("center") {
        margin_left + (sheet_usable_w - super_grid_w) / 2.0
    } else if align.contains("right") {
        sheet_w - (sheet_w - margin_left - sheet_usable_w) - super_grid_w
    } else {
        margin_left
    };

    let super_base_y = if align.contains("center") {
        margin_bottom + (sheet_usable_h - super_grid_h) / 2.0
    } else if align.contains("top") {
        sheet_h - (sheet_h - margin_bottom - sheet_usable_h) - super_grid_h
    } else {
        margin_bottom
    };

    (super_base_x, super_base_y)
}

/// Map sheet_idx → src page cho layout 'repeat' (tra `sheet_mapping`).
pub type SheetMapping = std::collections::HashMap<usize, usize>;

/// Tính placement tuyệt đối cho toàn bộ ô trên một tờ. Tương đương `compute_placements`.
#[allow(clippy::too_many_arguments)]
pub fn compute_placements(
    sheet_idx: usize,
    cells: &[AssemblyCell],
    capacity: usize,
    cx_count: usize,
    cy_count: usize,
    cluster_gap: f64,
    active_grid_w: f64,
    active_grid_h: f64,
    super_base_x: f64,
    super_base_y: f64,
    sheet_h: f64,
    layout_type: &str,
    total_capacity: usize,
    page_count: usize,
    sheet_mapping: Option<&SheetMapping>,
) -> Vec<AbsPlacement> {
    let mut placements: Vec<AbsPlacement> = Vec::with_capacity(cells.len() * cx_count * cy_count);

    for cy in 0..cy_count {
        for cx in 0..cx_count {
            let cluster_base_x = super_base_x + cx as f64 * (active_grid_w + cluster_gap);
            let visual_cy = cy_count - 1 - cy;
            let cluster_base_y = super_base_y + visual_cy as f64 * (active_grid_h + cluster_gap);

            for (cell_idx, cell) in cells.iter().enumerate() {
                let cluster_idx = cy * cx_count + cx;
                let cell_on_sheet_idx = cluster_idx * capacity + cell_idx;

                let src_page_idx = if layout_type == "repeat" {
                    if let Some(mapping) = sheet_mapping {
                        *mapping.get(&sheet_idx).unwrap_or(&sheet_idx)
                    } else {
                        sheet_idx
                    }
                } else {
                    get_src_page_idx(
                        sheet_idx,
                        cell_on_sheet_idx,
                        layout_type,
                        total_capacity,
                        page_count,
                    )
                };

                if src_page_idx >= page_count {
                    continue;
                }

                let cell_x = cluster_base_x + cell.x;
                let cell_y_from_bottom = cluster_base_y + (active_grid_h - cell.y - cell.height);
                let cell_y = sheet_h - cell_y_from_bottom - cell.height;

                placements.push(AbsPlacement {
                    cluster_idx,
                    src_page_idx,
                    abs_x: cell_x,
                    abs_y: cell_y_from_bottom,
                    original_cell_y: cell_y,
                    width: cell.width,
                    height: cell.height,
                    cell: *cell,
                });
            }
        }
    }

    placements
}

/// Tính các đoạn mark cắt từ placements. Tương đương `compute_mark_coords`.
/// `mark_type`: "corners" chỉ vẽ mép ngoài; còn lại vẽ mọi đường cắt.
/// `bleed_offset`: nếu > 0, vẽ 2 đường song song offset ±bleed (kiểu Nhật Bản).
pub fn compute_mark_coords(
    placements: &[AbsPlacement],
    mark_type: &str,
    mark_off: f64,
    mark_len: f64,
    bleed_offset: f64,
) -> Vec<MarkSegment> {
    use std::collections::{BTreeSet, HashMap};

    struct BlockCuts {
        v: BTreeSet<i64>,
        h: BTreeSet<i64>,
    }

    let mut block_cuts: HashMap<usize, HashMap<i64, BlockCuts>> = HashMap::new();

    for p in placements {
        let trim_x0 = p.abs_x;
        let trim_y0 = p.original_cell_y;
        let trim_x1 = p.abs_x + p.width;
        let trim_y1 = p.original_cell_y + p.height;

        let cluster_map = block_cuts.entry(p.cluster_idx).or_default();
        let cuts = cluster_map
            .entry(p.cell.block_id)
            .or_insert_with(|| BlockCuts {
                v: BTreeSet::new(),
                h: BTreeSet::new(),
            });
        cuts.v.insert((trim_x0 * 100.0).round() as i64);
        cuts.v.insert((trim_x1 * 100.0).round() as i64);
        cuts.h.insert((trim_y0 * 100.0).round() as i64);
        cuts.h.insert((trim_y1 * 100.0).round() as i64);
    }

    let mut marks: Vec<MarkSegment> = Vec::new();
    let is_japanese = bleed_offset > 0.01;

    macro_rules! push_mark {
        (v, $x:expr, $y0:expr, $y1:expr) => {
            if is_japanese {
                marks.push(MarkSegment {
                    x1: $x - bleed_offset,
                    y1: $y0,
                    x2: $x - bleed_offset,
                    y2: $y1,
                });
                marks.push(MarkSegment {
                    x1: $x + bleed_offset,
                    y1: $y0,
                    x2: $x + bleed_offset,
                    y2: $y1,
                });
            } else {
                marks.push(MarkSegment {
                    x1: $x,
                    y1: $y0,
                    x2: $x,
                    y2: $y1,
                });
            }
        };
        (h, $y:expr, $x0:expr, $x1:expr) => {
            if is_japanese {
                marks.push(MarkSegment {
                    x1: $x0,
                    y1: $y - bleed_offset,
                    x2: $x1,
                    y2: $y - bleed_offset,
                });
                marks.push(MarkSegment {
                    x1: $x0,
                    y1: $y + bleed_offset,
                    x2: $x1,
                    y2: $y + bleed_offset,
                });
            } else {
                marks.push(MarkSegment {
                    x1: $x0,
                    y1: $y,
                    x2: $x1,
                    y2: $y,
                });
            }
        };
    }

    #[derive(Clone)]
    struct BBox {
        min_x: f64,
        max_x: f64,
        min_y: f64,
        max_y: f64,
    }
    const GAP_EPS: f64 = 0.5;

    for cluster_blocks in block_cuts.values() {
        let mut bboxes: HashMap<i64, BBox> = HashMap::new();
        let mut per_block: Vec<(i64, Vec<f64>, Vec<f64>)> = Vec::new();
        for (&block_id, cuts) in cluster_blocks.iter() {
            let v_vals: Vec<f64> = cuts.v.iter().map(|&v| v as f64 / 100.0).collect();
            let h_vals: Vec<f64> = cuts.h.iter().map(|&v| v as f64 / 100.0).collect();
            if v_vals.is_empty() || h_vals.is_empty() {
                continue;
            }
            bboxes.insert(
                block_id,
                BBox {
                    min_x: v_vals[0],
                    max_x: *v_vals.last().unwrap(),
                    min_y: h_vals[0],
                    max_y: *h_vals.last().unwrap(),
                },
            );
            per_block.push((block_id, v_vals, h_vals));
        }

        let b0 = bboxes.get(&0);
        let vx_c: Option<f64> = match (b0, bboxes.get(&1)) {
            (Some(a), Some(b)) if b.min_x - a.max_x > GAP_EPS => Some((a.max_x + b.min_x) / 2.0),
            _ => None,
        };
        let hy_c: Option<f64> = match (b0, bboxes.get(&2)) {
            (Some(a), Some(b)) if b.min_y - a.max_y > GAP_EPS => Some((a.max_y + b.min_y) / 2.0),
            _ => None,
        };

        for (_block_id, v_vals, h_vals) in &per_block {
            let min_x = v_vals[0];
            let max_x = *v_vals.last().unwrap();
            let min_y = h_vals[0];
            let max_y = *h_vals.last().unwrap();

            let v_draw: Vec<f64> = if mark_type == "corners" {
                vec![min_x, max_x]
            } else {
                v_vals.clone()
            };
            let h_draw: Vec<f64> = if mark_type == "corners" {
                vec![min_y, max_y]
            } else {
                h_vals.clone()
            };

            for &vx in &v_draw {
                push_mark!(v, vx, min_y - mark_off, min_y - mark_off - mark_len);
                push_mark!(v, vx, max_y + mark_off, max_y + mark_off + mark_len);
            }
            for &hy in &h_draw {
                push_mark!(h, hy, min_x - mark_off, min_x - mark_off - mark_len);
                push_mark!(h, hy, max_x + mark_off, max_x + mark_off + mark_len);
            }
        }

        let g_min_x = bboxes
            .values()
            .map(|b| b.min_x)
            .fold(f64::INFINITY, f64::min);
        let g_max_x = bboxes
            .values()
            .map(|b| b.max_x)
            .fold(f64::NEG_INFINITY, f64::max);
        let g_min_y = bboxes
            .values()
            .map(|b| b.min_y)
            .fold(f64::INFINITY, f64::min);
        let g_max_y = bboxes
            .values()
            .map(|b| b.max_y)
            .fold(f64::NEG_INFINITY, f64::max);
        if let Some(vc) = vx_c {
            push_mark!(v, vc, g_min_y - mark_off, g_min_y - mark_off - mark_len);
            push_mark!(v, vc, g_max_y + mark_off, g_max_y + mark_off + mark_len);
        }
        if let Some(hc) = hy_c {
            push_mark!(h, hc, g_min_x - mark_off, g_min_x - mark_off - mark_len);
            push_mark!(h, hc, g_max_x + mark_off, g_max_x + mark_off + mark_len);
        }
    }

    marks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_center_and_corners() {
        // center: super_base_x = mL + (usableW - gridW)/2
        let (bx, by) =
            compute_alignment(320.0, 450.0, 320.0, 440.0, 0.0, 5.0, 200.0, 400.0, "center");
        assert!((bx - (0.0 + (320.0 - 200.0) / 2.0)).abs() < 1e-9);
        assert!((by - (5.0 + (440.0 - 400.0) / 2.0)).abs() < 1e-9);

        // bottom-left mặc định
        let (bx2, by2) = compute_alignment(
            320.0,
            450.0,
            320.0,
            440.0,
            7.0,
            5.0,
            200.0,
            400.0,
            "bottom-left",
        );
        assert!((bx2 - 7.0).abs() < 1e-9);
        assert!((by2 - 5.0).abs() < 1e-9);
    }

    #[test]
    fn placements_basic_flip() {
        let cells = [AssemblyCell {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 60.0,
            is_rotated: false,
            is_rotated_180: false,
            block_id: 0,
        }];
        let pls = compute_placements(
            0,
            &cells,
            1,
            1,
            1,
            0.0,
            100.0,
            60.0,
            0.0,
            0.0,
            450.0,
            "sequential",
            1,
            1,
            None,
        );
        assert_eq!(pls.len(), 1);
        let p = pls[0];
        assert_eq!(p.src_page_idx, 0);
        assert!((p.abs_x - 0.0).abs() < 1e-9);
        // abs_y (from bottom) = cluster_base_y + (gridH - y - h) = 0 + (60 - 0 - 60) = 0
        assert!((p.abs_y - 0.0).abs() < 1e-9);
        // original_cell_y = sheet_h - abs_y - h = 450 - 0 - 60 = 390
        assert!((p.original_cell_y - 390.0).abs() < 1e-9);
    }

    #[test]
    fn marks_corners_only_outer() {
        // 2 ô cạnh nhau cùng block → "corners" chỉ lấy mép ngoài (min/max).
        let cells = [
            AssemblyCell {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 60.0,
                is_rotated: false,
                is_rotated_180: false,
                block_id: 0,
            },
            AssemblyCell {
                x: 100.0,
                y: 0.0,
                width: 100.0,
                height: 60.0,
                is_rotated: false,
                is_rotated_180: false,
                block_id: 0,
            },
        ];
        let pls = compute_placements(
            0,
            &cells,
            2,
            1,
            1,
            0.0,
            200.0,
            60.0,
            0.0,
            0.0,
            450.0,
            "sequential",
            2,
            2,
            None,
        );
        let corners = compute_mark_coords(&pls, "corners", 3.0, 5.0, 0.0);
        let guillotine = compute_mark_coords(&pls, "guillotine", 3.0, 5.0, 0.0);
        // guillotine có nhiều đường cắt hơn corners (3 đường dọc vs 2).
        assert!(guillotine.len() > corners.len());
    }
}
