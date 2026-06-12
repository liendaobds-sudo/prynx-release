//! No-Fit-Polygon solver — port thuần Rust từ `native/src/nfp_solver.rs`
//! (Task 5 / Req 1.1). Bỏ `#[pyclass]` và `rayon`; chạy tuần tự (kết quả y hệt,
//! vì rayon chỉ song song hóa, không đổi giá trị).

use geo::algorithm::translate::Translate;
use geo::{Coord, Intersects, LineString, Polygon};

pub struct NfpSolver {
    base_poly: Polygon<f64>,
    rot_poly: Polygon<f64>,
}

impl NfpSolver {
    pub fn new(base_coords: Vec<(f64, f64)>, rot_coords: Vec<(f64, f64)>) -> Self {
        let base_ls: LineString<f64> = base_coords.into_iter().map(|(x, y)| Coord { x, y }).collect();
        let rot_ls: LineString<f64> = rot_coords.into_iter().map(|(x, y)| Coord { x, y }).collect();
        Self {
            base_poly: Polygon::new(base_ls, vec![]),
            rot_poly: Polygon::new(rot_ls, vec![]),
        }
    }

    /// Tìm biên NFP bằng binary search trên các bước dy rời rạc.
    /// Trả danh sách (dx, dy) hợp lệ trên biên.
    pub fn solve_candidates(&self, bh: f64, bw: f64, rw: f64, gap_px: f64, step: f64) -> Vec<(f64, f64)> {
        let mut dy_range = Vec::new();
        let mut current_dy = -bh + step;
        while current_dy < bh {
            dy_range.push(current_dy);
            current_dy += step;
        }

        dy_range
            .into_iter()
            .filter_map(|dy| {
                let mut lo = -rw;
                let mut hi = bw + gap_px;
                let mut safe_dx = hi;

                for _ in 0..20 {
                    let mid = (lo + hi) / 2.0;
                    let shifted_rot = self.rot_poly.translate(mid, dy);
                    if self.base_poly.intersects(&shifted_rot) {
                        lo = mid;
                    } else {
                        safe_dx = mid;
                        hi = mid;
                    }
                }

                if safe_dx < bw + gap_px {
                    Some((safe_dx, dy))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Tìm bước lặp ngoài (dx_step, dy_step) cho một cặp interlocking.
    pub fn solve_outer_step(&self, dx: f64, dy: f64, c_w: f64, c_h: f64, gap_px: f64) -> (f64, f64) {
        let rot_placed = self.rot_poly.translate(dx, dy);

        let mut lo_dx = 0.0;
        let mut hi_dx = c_w + gap_px;
        let mut dx_step = hi_dx;
        for _ in 0..20 {
            let mid = (lo_dx + hi_dx) / 2.0;
            let shifted_base = self.base_poly.translate(mid, 0.0);
            let shifted_rot = rot_placed.translate(mid, 0.0);
            if self.base_poly.intersects(&shifted_base)
                || self.base_poly.intersects(&shifted_rot)
                || rot_placed.intersects(&shifted_base)
                || rot_placed.intersects(&shifted_rot)
            {
                lo_dx = mid;
            } else {
                dx_step = mid;
                hi_dx = mid;
            }
        }

        let mut lo_dy = 0.0;
        let mut hi_dy = c_h + gap_px;
        let mut dy_step = hi_dy;
        for _ in 0..20 {
            let mid = (lo_dy + hi_dy) / 2.0;
            let shifted_base = self.base_poly.translate(0.0, mid);
            let shifted_rot = rot_placed.translate(0.0, mid);
            if self.base_poly.intersects(&shifted_base)
                || self.base_poly.intersects(&shifted_rot)
                || rot_placed.intersects(&shifted_base)
                || rot_placed.intersects(&shifted_rot)
            {
                lo_dy = mid;
            } else {
                dy_step = mid;
                hi_dy = mid;
            }
        }

        (dx_step, dy_step)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(w: f64, h: f64) -> Vec<(f64, f64)> {
        vec![(0.0, 0.0), (w, 0.0), (w, h), (0.0, h), (0.0, 0.0)]
    }

    #[test]
    fn candidates_for_two_squares() {
        let s = NfpSolver::new(square(100.0, 60.0), square(100.0, 60.0));
        let cands = s.solve_candidates(60.0, 100.0, 100.0, 5.0, 10.0);
        // Phải có ít nhất một ứng viên hợp lệ trên biên.
        assert!(!cands.is_empty());
        // dx an toàn không vượt bw + gap.
        for (dx, _) in &cands {
            assert!(*dx < 100.0 + 5.0 + 1e-6);
        }
    }

    #[test]
    fn outer_step_positive_and_bounded() {
        let s = NfpSolver::new(square(100.0, 60.0), square(100.0, 60.0));
        let (dxs, dys) = s.solve_outer_step(50.0, 0.0, 100.0, 60.0, 5.0);
        assert!(dxs >= 0.0 && dxs <= 100.0 + 5.0 + 1e-6);
        assert!(dys >= 0.0 && dys <= 60.0 + 5.0 + 1e-6);
    }
}
