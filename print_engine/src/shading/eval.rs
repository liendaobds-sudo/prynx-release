//! Tính màu shading theo điểm.
//!
//! # Vì sao dựng LUT theo tham số t
//!
//! Với kiểu 2 và 3, màu chỉ phụ thuộc **một** tham số `t`. Hàm màu thì thường là
//! function kiểu 4 (chương trình PostScript) hoặc kiểu 3 ghép nhiều đoạn — gọi nó
//! cho từng pixel của một vùng gradient cỡ A4 @300 DPI là hàng triệu lần chạy
//! interpreter.
//!
//! Nên `t` được lấy mẫu trước thành bảng và quy luôn sang **mực**, không phải sang
//! màu trung gian. Nhờ vậy vòng vẽ mỗi pixel chỉ còn: tính `t` → tra bảng → trộn.
//! Quy sang mực ngay lúc dựng bảng cũng là chỗ duy nhất `Separation`/`DeviceN` kịp
//! đăng ký kênh spot trước khi vòng vẽ bắt đầu.

use crate::color::icc::ColorManager;
use crate::error::{PpeResult, RenderWarnings};
use crate::geom::Matrix;
use crate::ink::{ChannelMask, InkSpace};
use crate::shading::{Shading, ShadingKind};

/// Số mẫu của bảng màu theo `t`.
///
/// 256 là độ phân giải mà mắt không phân biệt được trên một dải chuyển, và cũng là
/// số bước mà mọi bộ render thực tế dùng.
const LUT_SIZE: usize = 256;

/// Shading đã lấy mẫu sang mực, dùng cho vòng vẽ.
pub struct SampledShading {
    kind: ShadingKind,
    /// `[(ink, mask, DeviceRGB gốc)]` theo `t` chuẩn hoá 0..1.
    lut: Vec<(Vec<f32>, ChannelMask, Option<[f32; 3]>)>,
    /// Ma trận nghịch đảo: thiết bị → không gian shading.
    inverse: Matrix,
    /// `/BBox` đã đổi sang toạ độ thiết bị (hộp bao, dùng để cắt nhanh).
    bbox_device: Option<[f32; 4]>,
}

impl SampledShading {
    /// Lấy mẫu shading và dựng bảng mực.
    ///
    /// `ctm` là ma trận đưa không gian shading về thiết bị.
    pub fn new(
        shading: &Shading,
        ctm: &Matrix,
        space: &mut InkSpace,
        warn: &mut RenderWarnings,
        cm: Option<&ColorManager>,
    ) -> PpeResult<Option<Self>> {
        let Some(inverse) = ctm.invert() else {
            // CTM suy biến ⇒ shading không chiếm diện tích nào.
            return Ok(None);
        };

        let (t0, t1) = match &shading.kind {
            ShadingKind::Axial { domain, .. } | ShadingKind::Radial { domain, .. } => {
                (domain[0], domain[1])
            }
            // Lưới không có tham số `t`: màu nằm ở đỉnh. Nhánh này không bao giờ
            // chạy vì interpreter tách lưới ra đường vẽ riêng trước khi lấy mẫu.
            ShadingKind::FunctionBased { .. } | ShadingKind::Mesh { .. } => (0.0, 1.0),
        };

        let mut lut = Vec::with_capacity(LUT_SIZE);
        for i in 0..LUT_SIZE {
            let frac = i as f32 / (LUT_SIZE - 1) as f32;
            let t = t0 + frac * (t1 - t0);
            let comps = match &shading.function {
                Some(f) => f.eval(&[t]),
                // Không có `/Function`: chỉ hợp lệ với kiểu 4–7 (màu nằm trong
                // dữ liệu lưới), mà những kiểu đó đã bị loại từ trước.
                None => vec![0.0],
            };
            let rgb = shading.colorspace.to_device_rgb_for_blending(&comps);
            match shading.colorspace.to_ink(&comps, space, warn, cm)? {
                Some((ink, mask)) => lut.push((ink, mask, rgb)),
                None => lut.push((Vec::new(), ChannelMask::EMPTY, rgb)),
            }
        }
        // Spot có thể vừa được đăng ký khi dựng bảng ⇒ đồng bộ độ dài vector mực.
        let n = space.len();
        for entry in lut.iter_mut() {
            if !entry.0.is_empty() {
                entry.0.resize(n, 0.0);
            }
        }

        let bbox_device = shading.bbox.as_ref().map(|b| {
            let corners = [
                ctm.apply(b.x0, b.y0),
                ctm.apply(b.x1, b.y0),
                ctm.apply(b.x0, b.y1),
                ctm.apply(b.x1, b.y1),
            ];
            let xs: Vec<f32> = corners.iter().map(|c| c.0).collect();
            let ys: Vec<f32> = corners.iter().map(|c| c.1).collect();
            [
                xs.iter().cloned().fold(f32::MAX, f32::min),
                ys.iter().cloned().fold(f32::MAX, f32::min),
                xs.iter().cloned().fold(f32::MIN, f32::max),
                ys.iter().cloned().fold(f32::MIN, f32::max),
            ]
        });

        Ok(Some(SampledShading {
            kind: shading.kind.clone(),
            lut,
            inverse,
            bbox_device,
        }))
    }

    /// Mực tại một điểm **thiết bị**. `None` = điểm không được shading phủ.
    pub fn ink_at_device(
        &self,
        dx: f32,
        dy: f32,
    ) -> Option<(&[f32], ChannelMask, Option<[f32; 3]>)> {
        if let Some([x0, y0, x1, y1]) = self.bbox_device {
            if dx < x0 || dx > x1 || dy < y0 || dy > y1 {
                return None;
            }
        }
        let (sx, sy) = self.inverse.apply(dx, dy);
        let frac = match &self.kind {
            ShadingKind::Axial { coords, extend, .. } => axial_param(coords, extend, sx, sy)?,
            ShadingKind::Radial { coords, extend, .. } => radial_param(coords, extend, sx, sy)?,
            ShadingKind::FunctionBased { domain, matrix } => {
                function_param(domain, matrix, sx, sy)?
            }
            ShadingKind::Mesh { .. } => return None,
        };
        let idx =
            ((frac.clamp(0.0, 1.0) * (LUT_SIZE - 1) as f32).round() as usize).min(LUT_SIZE - 1);
        let (ink, mask, rgb) = &self.lut[idx];
        if ink.is_empty() {
            None
        } else {
            Some((ink, *mask, *rgb))
        }
    }
}

/// Tham số chuẩn hoá 0..1 cho shading dọc trục.
///
/// Chiếu điểm lên trục rồi chuẩn hoá theo độ dài trục. Ngoài đoạn `[0,1]` thì chỉ
/// vẽ khi `/Extend` bật ở đầu tương ứng.
fn axial_param(coords: &[f32; 4], extend: &[bool; 2], x: f32, y: f32) -> Option<f32> {
    let (x0, y0, x1, y1) = (coords[0], coords[1], coords[2], coords[3]);
    let dx = x1 - x0;
    let dy = y1 - y0;
    let denom = dx * dx + dy * dy;
    if denom <= f32::EPSILON {
        // Trục suy biến (hai đầu trùng nhau): chỉ vẽ nếu có extend, và khi đó
        // toàn vùng lấy màu đầu trục.
        return if extend[0] || extend[1] {
            Some(0.0)
        } else {
            None
        };
    }
    let s = ((x - x0) * dx + (y - y0) * dy) / denom;
    clamp_with_extend(s, extend)
}

/// Tham số cho shading theo bán kính (§8.7.4.5.4).
///
/// Giải `s` sao cho điểm nằm trên đường tròn nội suy `s`, chọn `s` **lớn nhất**
/// hợp lệ — đường tròn s lớn vẽ sau nên nằm trên.
fn radial_param(coords: &[f32; 6], extend: &[bool; 2], px: f32, py: f32) -> Option<f32> {
    let (x0, y0, r0, x1, y1, r1) = (
        coords[0], coords[1], coords[2], coords[3], coords[4], coords[5],
    );
    let dx = x1 - x0;
    let dy = y1 - y0;
    let dr = r1 - r0;
    let a = dx * dx + dy * dy - dr * dr;
    let fx = px - x0;
    let fy = py - y0;
    let b = fx * dx + fy * dy + r0 * dr;
    let c = fx * fx + fy * fy - r0 * r0;

    let mut candidates: [Option<f32>; 2] = [None, None];
    if a.abs() < 1e-6 {
        // Trường hợp suy biến: phương trình thành tuyến tính.
        if b.abs() > 1e-9 {
            candidates[0] = Some(c / (2.0 * b));
        }
    } else {
        let disc = b * b - a * c;
        if disc < 0.0 {
            return None;
        }
        let sq = disc.sqrt();
        candidates[0] = Some((b + sq) / a);
        candidates[1] = Some((b - sq) / a);
    }

    // Xét nghiệm lớn trước: đường tròn s lớn hơn được vẽ sau nên phủ lên.
    let mut best: Option<f32> = None;
    for s in candidates.iter().flatten() {
        let s = *s;
        // Bán kính phải không âm, nếu không đường tròn đó không tồn tại.
        if r0 + s * dr < 0.0 {
            continue;
        }
        let Some(frac) = clamp_with_extend(s, extend) else {
            continue;
        };
        best = match best {
            Some(prev) if prev >= frac => Some(prev),
            _ => Some(frac),
        };
    }
    best
}

/// Tham số cho shading kiểu 1: điểm phải nằm trong `domain` sau khi qua ma trận
/// riêng của shading.
///
/// Trả về giá trị chuẩn hoá theo trục x của domain. Đây là **xấp xỉ có chủ ý**:
/// bảng LUT một chiều không biểu diễn được hàm hai biến. Kiểu 1 rất hiếm và luôn
/// là hàm mượt, nên sai số nằm trong dung sai; nếu cần chính xác thì phải đổi sang
/// tính trực tiếp không qua LUT.
fn function_param(domain: &[f32; 4], matrix: &Matrix, x: f32, y: f32) -> Option<f32> {
    let inv = matrix.invert()?;
    let (ux, uy) = inv.apply(x, y);
    if ux < domain[0] || ux > domain[1] || uy < domain[2] || uy > domain[3] {
        return None;
    }
    let span = domain[1] - domain[0];
    if span.abs() <= f32::EPSILON {
        return Some(0.0);
    }
    Some((ux - domain[0]) / span)
}

/// Kẹp tham số vào `[0,1]` theo `/Extend`; `None` nếu điểm nằm ngoài và không mở rộng.
fn clamp_with_extend(s: f32, extend: &[bool; 2]) -> Option<f32> {
    if s < 0.0 {
        if extend[0] {
            Some(0.0)
        } else {
            None
        }
    } else if s > 1.0 {
        if extend[1] {
            Some(1.0)
        } else {
            None
        }
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_EXTEND: [bool; 2] = [false, false];
    const BOTH: [bool; 2] = [true, true];

    #[test]
    fn axial_param_is_zero_at_start_and_one_at_end() {
        let coords = [0.0, 0.0, 100.0, 0.0];
        assert_eq!(axial_param(&coords, &NO_EXTEND, 0.0, 0.0), Some(0.0));
        assert_eq!(axial_param(&coords, &NO_EXTEND, 100.0, 0.0), Some(1.0));
        assert_eq!(axial_param(&coords, &NO_EXTEND, 50.0, 0.0), Some(0.5));
    }

    #[test]
    fn axial_param_ignores_offset_perpendicular_to_axis() {
        // Điểm lệch khỏi trục vẫn lấy tham số theo hình chiếu.
        let coords = [0.0, 0.0, 100.0, 0.0];
        assert_eq!(axial_param(&coords, &NO_EXTEND, 50.0, 999.0), Some(0.5));
    }

    #[test]
    fn axial_param_outside_without_extend_is_none() {
        let coords = [0.0, 0.0, 100.0, 0.0];
        assert_eq!(axial_param(&coords, &NO_EXTEND, -10.0, 0.0), None);
        assert_eq!(axial_param(&coords, &NO_EXTEND, 110.0, 0.0), None);
    }

    #[test]
    fn axial_param_outside_with_extend_clamps() {
        // Bỏ qua /Extend làm dải chuyển kết thúc đột ngột ⇒ sai diện tích phủ mực.
        let coords = [0.0, 0.0, 100.0, 0.0];
        assert_eq!(axial_param(&coords, &BOTH, -10.0, 0.0), Some(0.0));
        assert_eq!(axial_param(&coords, &BOTH, 110.0, 0.0), Some(1.0));
    }

    #[test]
    fn axial_param_handles_diagonal_axis() {
        let coords = [0.0, 0.0, 10.0, 10.0];
        let t = axial_param(&coords, &NO_EXTEND, 5.0, 5.0).unwrap();
        assert!((t - 0.5).abs() < 1e-5, "t={t}");
    }

    #[test]
    fn axial_param_with_degenerate_axis_does_not_divide_by_zero() {
        let coords = [5.0, 5.0, 5.0, 5.0];
        assert_eq!(axial_param(&coords, &NO_EXTEND, 0.0, 0.0), None);
        assert_eq!(axial_param(&coords, &BOTH, 0.0, 0.0), Some(0.0));
    }

    #[test]
    fn radial_concentric_circles_give_radius_fraction() {
        // Tâm chung, bán kính 0 → 100.
        let coords = [0.0, 0.0, 0.0, 0.0, 0.0, 100.0];
        let t = radial_param(&coords, &NO_EXTEND, 50.0, 0.0).unwrap();
        assert!((t - 0.5).abs() < 1e-4, "t={t}");
        assert!(radial_param(&coords, &NO_EXTEND, 0.0, 0.0).unwrap() < 1e-4);
    }

    #[test]
    fn radial_outside_outer_circle_without_extend_is_none() {
        let coords = [0.0, 0.0, 0.0, 0.0, 0.0, 100.0];
        assert_eq!(radial_param(&coords, &NO_EXTEND, 150.0, 0.0), None);
    }

    #[test]
    fn radial_outside_with_extend_clamps_to_one() {
        let coords = [0.0, 0.0, 0.0, 0.0, 0.0, 100.0];
        assert_eq!(radial_param(&coords, &BOTH, 150.0, 0.0), Some(1.0));
    }

    #[test]
    fn radial_offset_circles_resolve() {
        // Hai tâm lệch nhau — dạng "highlight" hay dùng cho hiệu ứng bóng.
        let coords = [0.0, 0.0, 10.0, 40.0, 0.0, 50.0];
        assert!(radial_param(&coords, &BOTH, 0.0, 0.0).is_some());
        assert!(radial_param(&coords, &BOTH, 40.0, 0.0).is_some());
    }

    #[test]
    fn radial_picks_larger_root() {
        // Khi có hai nghiệm hợp lệ, đường tròn s lớn vẽ sau nên phải thắng.
        let coords = [0.0, 0.0, 0.0, 0.0, 0.0, 100.0];
        let t = radial_param(&coords, &BOTH, 30.0, 0.0).unwrap();
        assert!(t > 0.0);
    }

    #[test]
    fn function_based_param_rejects_points_outside_domain() {
        let domain = [0.0, 1.0, 0.0, 1.0];
        assert!(function_param(&domain, &Matrix::IDENTITY, 0.5, 0.5).is_some());
        assert!(function_param(&domain, &Matrix::IDENTITY, 2.0, 0.5).is_none());
        assert!(function_param(&domain, &Matrix::IDENTITY, 0.5, -1.0).is_none());
    }

    #[test]
    fn function_based_param_applies_its_own_matrix() {
        let domain = [0.0, 1.0, 0.0, 1.0];
        let m = Matrix::scale(100.0, 100.0);
        // Điểm (50,50) trong không gian shading ⇒ (0.5,0.5) trong domain.
        let t = function_param(&domain, &m, 50.0, 50.0).unwrap();
        assert!((t - 0.5).abs() < 1e-5, "t={t}");
    }

    #[test]
    fn clamp_with_extend_matrix_of_cases() {
        assert_eq!(clamp_with_extend(0.5, &NO_EXTEND), Some(0.5));
        assert_eq!(clamp_with_extend(-0.1, &[true, false]), Some(0.0));
        assert_eq!(clamp_with_extend(-0.1, &[false, true]), None);
        assert_eq!(clamp_with_extend(1.1, &[false, true]), Some(1.0));
        assert_eq!(clamp_with_extend(1.1, &[true, false]), None);
    }
}
