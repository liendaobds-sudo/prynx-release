//! Ma trận / hình học PDF.
//!
//! PDF dùng ma trận 3x2 `[a b c d e f]` với gốc toạ độ **góc dưới-trái** và trục
//! y hướng **lên** (ISO 32000-2 §8.3.3). Raster thì gốc trên-trái, y hướng xuống.
//! Việc lật trục nằm gọn trong [`Matrix::device_from_page`] để không lẫn dấu rải
//! rác khắp interpreter.

/// Ma trận affine PDF `[a b c d e f]`.
///
/// Nhân theo quy ước PDF: `M_new = M_applied × M_current` (§8.3.4 — `cm` nhân
/// TRƯỚC CTM hiện tại).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Matrix {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl Default for Matrix {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Matrix {
    pub const IDENTITY: Matrix = Matrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    pub fn new(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> Self {
        Matrix { a, b, c, d, e, f }
    }

    pub fn scale(sx: f32, sy: f32) -> Self {
        Matrix::new(sx, 0.0, 0.0, sy, 0.0, 0.0)
    }

    pub fn translate(tx: f32, ty: f32) -> Self {
        Matrix::new(1.0, 0.0, 0.0, 1.0, tx, ty)
    }

    /// `self` áp dụng TRƯỚC `outer` — tương đương `outer ∘ self`.
    ///
    /// Dùng cho `cm`: `ctm = cm_operand.then(ctm)`.
    pub fn then(&self, outer: &Matrix) -> Matrix {
        Matrix {
            a: self.a * outer.a + self.b * outer.c,
            b: self.a * outer.b + self.b * outer.d,
            c: self.c * outer.a + self.d * outer.c,
            d: self.c * outer.b + self.d * outer.d,
            e: self.e * outer.a + self.f * outer.c + outer.e,
            f: self.e * outer.b + self.f * outer.d + outer.f,
        }
    }

    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }

    /// Chỉ biến đổi vector (bỏ phần dịch chuyển) — dùng cho bề rộng nét.
    pub fn apply_vector(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y, self.b * x + self.d * y)
    }

    pub fn determinant(&self) -> f32 {
        self.a * self.d - self.b * self.c
    }

    pub fn invert(&self) -> Option<Matrix> {
        let det = self.determinant();
        if det.abs() < 1e-12 {
            return None;
        }
        let inv = 1.0 / det;
        Some(Matrix {
            a: self.d * inv,
            b: -self.b * inv,
            c: -self.c * inv,
            d: self.a * inv,
            e: (self.c * self.f - self.d * self.e) * inv,
            f: (self.b * self.e - self.a * self.f) * inv,
        })
    }

    /// Hệ số phóng đại xấp xỉ — dùng để quy đổi bề rộng nét sang pixel và để
    /// chọn độ mịn khi làm phẳng đường cong.
    pub fn mean_scale(&self) -> f32 {
        let sx = (self.a * self.a + self.b * self.b).sqrt();
        let sy = (self.c * self.c + self.d * self.d).sqrt();
        ((sx * sy).abs()).sqrt().max(1e-6)
    }

    /// Ma trận đưa toạ độ trang (point, y hướng lên, gốc tại `crop_origin`) về
    /// toạ độ thiết bị (pixel, y hướng xuống, gốc trên-trái).
    ///
    /// `dpi / 72` là tỉ lệ point→pixel. Lật y bằng `d = -scale` cộng dịch chuyển
    /// bằng chiều cao raster.
    pub fn device_from_page(crop: &Rect, dpi: f32) -> Matrix {
        let s = dpi / 72.0;
        Matrix {
            a: s,
            b: 0.0,
            c: 0.0,
            d: -s,
            e: -crop.x0 * s,
            f: crop.y1 * s,
        }
    }
}

/// Hình chữ nhật trong toạ độ trang (point). `x0<x1`, `y0<y1` sau khi chuẩn hoá.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub fn new(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Rect {
            x0: x0.min(x1),
            y0: y0.min(y1),
            x1: x0.max(x1),
            y1: y0.max(y1),
        }
    }

    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }

    pub fn is_empty(&self) -> bool {
        self.width() <= 0.0 || self.height() <= 0.0
    }

    /// Giao hai hình chữ nhật; `None` nếu rỗng.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let r = Rect {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        };
        if r.is_empty() {
            None
        } else {
            Some(r)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn then_follows_pdf_order() {
        // Dịch (10,0) rồi phóng 2x ⇒ điểm gốc phải ra (20,0), KHÔNG phải (10,0).
        let m = Matrix::translate(10.0, 0.0).then(&Matrix::scale(2.0, 2.0));
        assert_eq!(m.apply(0.0, 0.0), (20.0, 0.0));
    }

    #[test]
    fn invert_roundtrips() {
        let m = Matrix::new(2.0, 0.5, -0.25, 3.0, 12.0, -7.0);
        let inv = m.invert().expect("khả nghịch");
        let (x, y) = m.apply(3.0, 4.0);
        let (rx, ry) = inv.apply(x, y);
        assert!((rx - 3.0).abs() < 1e-4, "rx={rx}");
        assert!((ry - 4.0).abs() < 1e-4, "ry={ry}");
    }

    #[test]
    fn singular_matrix_has_no_inverse() {
        assert!(Matrix::new(1.0, 2.0, 2.0, 4.0, 0.0, 0.0).invert().is_none());
    }

    #[test]
    fn device_matrix_flips_y_and_honours_crop_origin() {
        // Crop box lệch gốc: A4 dịch (20, 30). Góc TRÊN-TRÁI trang phải về (0,0).
        let crop = Rect::new(20.0, 30.0, 20.0 + 595.0, 30.0 + 842.0);
        let m = Matrix::device_from_page(&crop, 72.0);
        let top_left = m.apply(crop.x0, crop.y1);
        assert!(top_left.0.abs() < 1e-3 && top_left.1.abs() < 1e-3, "{top_left:?}");
        let bottom_right = m.apply(crop.x1, crop.y0);
        assert!((bottom_right.0 - 595.0).abs() < 1e-3, "{bottom_right:?}");
        assert!((bottom_right.1 - 842.0).abs() < 1e-3, "{bottom_right:?}");
    }

    #[test]
    fn device_matrix_scales_with_dpi() {
        let crop = Rect::new(0.0, 0.0, 72.0, 72.0);
        let m = Matrix::device_from_page(&crop, 300.0);
        let (x, y) = m.apply(72.0, 0.0);
        assert!((x - 300.0).abs() < 1e-3, "x={x}");
        assert!((y - 300.0).abs() < 1e-3, "y={y}");
    }

    #[test]
    fn rect_intersect_empty_is_none() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(20.0, 20.0, 30.0, 30.0);
        assert!(a.intersect(&b).is_none());
    }
}
