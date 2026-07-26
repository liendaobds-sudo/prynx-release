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
    pub const IDENTITY: Matrix = Matrix {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

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
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
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
        assert!(
            top_left.0.abs() < 1e-3 && top_left.1.abs() < 1e-3,
            "{top_left:?}"
        );
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

/// Vùng pixel nửa mở `[x0, x1) × [y0, y1)` trong toạ độ thiết bị.
///
/// # Vì sao mọi thao tác vẽ đều mang theo một vùng
///
/// Buffer mực của một trang A4 @300 DPI là ~8.7 triệu pixel × n kênh. Nếu mỗi
/// operator trộn mực trên **cả** buffer thì chi phí một trang tỉ lệ với
/// `số_operator × diện_tích_trang`, chứ không với diện tích thật của nét vẽ.
///
/// Với vector và chữ điều đó chỉ là chậm. Với **tiling pattern** thì nó là bất khả
/// thi: một mẫu gạch chéo bước 4pt trên A4 có hơn 30 000 ô, mỗi ô vài operator.
/// Quét cả trang cho từng operator biến một trang thành hàng phút.
///
/// Nên `Rasterizer` trả về vùng bao của nét vẽ, và tầng mực chỉ trộn trong vùng đó.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Region {
    pub const EMPTY: Region = Region {
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
    };

    pub fn full(width: u32, height: u32) -> Region {
        Region {
            x0: 0,
            y0: 0,
            x1: width,
            y1: height,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }

    /// Kẹp vào khung `width × height`, trả [`Region::EMPTY`] nếu không còn gì.
    pub fn clamped(self, width: u32, height: u32) -> Region {
        let x0 = self.x0.min(width);
        let y0 = self.y0.min(height);
        let x1 = self.x1.min(width);
        let y1 = self.y1.min(height);
        if x1 <= x0 || y1 <= y0 {
            Region::EMPTY
        } else {
            Region { x0, y0, x1, y1 }
        }
    }

    /// Hộp bao chung của hai vùng (bỏ qua vùng rỗng).
    pub fn union(self, other: Region) -> Region {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Region {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    /// Từ hộp bao dạng số thực (toạ độ thiết bị), nới ra một pixel mỗi phía.
    ///
    /// Nới một pixel vì bộ rasterize khử răng cưa có thể chạm pixel ngay ngoài hộp
    /// bao hình học. Thiếu lề đó sẽ cắt mất viền mờ của nét — trên kẽm là mất nét.
    pub fn from_bounds(
        left: f32,
        top: f32,
        right: f32,
        bottom: f32,
        width: u32,
        height: u32,
    ) -> Region {
        if !left.is_finite() || !top.is_finite() || !right.is_finite() || !bottom.is_finite() {
            return Region::full(width, height);
        }
        let x0 = (left.floor() as i64 - 1).max(0) as u32;
        let y0 = (top.floor() as i64 - 1).max(0) as u32;
        let x1 = (right.ceil() as i64 + 1).max(0) as u32;
        let y1 = (bottom.ceil() as i64 + 1).max(0) as u32;
        Region { x0, y0, x1, y1 }.clamped(width, height)
    }
}

#[cfg(test)]
mod region_tests {
    use super::Region;

    #[test]
    fn full_region_covers_everything() {
        let r = Region::full(10, 20);
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (0, 0, 10, 20));
        assert!(!r.is_empty());
    }

    #[test]
    fn empty_is_detected() {
        assert!(Region::EMPTY.is_empty());
        assert!(Region {
            x0: 5,
            y0: 0,
            x1: 5,
            y1: 10
        }
        .is_empty());
    }

    #[test]
    fn clamped_drops_region_outside_frame() {
        let r = Region {
            x0: 20,
            y0: 20,
            x1: 30,
            y1: 30,
        }
        .clamped(10, 10);
        assert!(r.is_empty());
    }

    #[test]
    fn clamped_trims_partial_overlap() {
        let r = Region {
            x0: 5,
            y0: 5,
            x1: 30,
            y1: 30,
        }
        .clamped(10, 10);
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (5, 5, 10, 10));
    }

    #[test]
    fn union_ignores_empty() {
        let a = Region {
            x0: 1,
            y0: 1,
            x1: 2,
            y1: 2,
        };
        assert_eq!(a.union(Region::EMPTY), a);
        assert_eq!(Region::EMPTY.union(a), a);
    }

    #[test]
    fn union_takes_outer_hull() {
        let a = Region {
            x0: 1,
            y0: 1,
            x1: 3,
            y1: 3,
        };
        let b = Region {
            x0: 5,
            y0: 0,
            x1: 6,
            y1: 9,
        };
        let u = a.union(b);
        assert_eq!((u.x0, u.y0, u.x1, u.y1), (1, 0, 6, 9));
    }

    #[test]
    fn from_bounds_adds_one_pixel_margin() {
        // Lề một pixel để không cắt viền khử răng cưa.
        let r = Region::from_bounds(4.0, 4.0, 6.0, 6.0, 100, 100);
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (3, 3, 7, 7));
    }

    #[test]
    fn from_bounds_clamps_to_frame() {
        let r = Region::from_bounds(-50.0, -50.0, 500.0, 500.0, 10, 10);
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (0, 0, 10, 10));
    }

    #[test]
    fn from_bounds_with_non_finite_falls_back_to_full_frame() {
        // Toạ độ NaN/inf: thà quét cả trang còn hơn bỏ mất nét.
        let r = Region::from_bounds(f32::NAN, 0.0, 10.0, 10.0, 8, 9);
        assert_eq!((r.x0, r.y0, r.x1, r.y1), (0, 0, 8, 9));
    }
}
