//! Sinh mặt nạ độ phủ và quản lý clip.

use tiny_skia::{Mask, Path, PathBuilder, Stroke, Transform};

use crate::geom::{Matrix, Region};

/// Độ phủ của một thao tác vẽ, kèm vùng bao của nó.
///
/// `data` vẫn được đánh chỉ số theo **cả trang** (`y * width + x`) để mọi tầng dùng
/// một hệ chỉ số duy nhất; `region` nói phần nào của nó có thể khác 0. Ngoài
/// `region`, giá trị được bảo đảm là 0.
pub struct Coverage<'a> {
    pub data: &'a [f32],
    pub region: Region,
}

/// Cho phép dùng `Coverage` như một slice (`cov[i]`, `cov.iter()`).
///
/// Tiện cho test và cho những chỗ chỉ cần giá trị; đường vẽ thật vẫn phải truyền
/// `region` xuống tầng mực, nếu không thì mất luôn tác dụng của việc giới hạn vùng.
impl<'a> std::ops::Deref for Coverage<'a> {
    type Target = [f32];

    fn deref(&self) -> &Self::Target {
        self.data
    }
}

/// Quy tắc tô của PDF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillRule {
    /// `f`, `F`, `B` — nonzero winding.
    NonZero,
    /// `f*`, `B*` — even-odd.
    EvenOdd,
}

impl From<FillRule> for tiny_skia::FillRule {
    fn from(r: FillRule) -> Self {
        match r {
            FillRule::NonZero => tiny_skia::FillRule::Winding,
            FillRule::EvenOdd => tiny_skia::FillRule::EvenOdd,
        }
    }
}

fn to_ts(m: &Matrix) -> Transform {
    Transform::from_row(m.a, m.b, m.c, m.d, m.e, m.f)
}

/// Bộ rasterize dùng lại buffer giữa các thao tác vẽ.
///
/// Một trang A4 @300 DPI là ~8.7 triệu pixel. Cấp phát mặt nạ mới cho từng
/// operator (file thật có hàng chục nghìn) sẽ giết hiệu năng, nên hai mặt nạ và
/// một scratch f32 được giữ lại và ghi đè.
pub struct Rasterizer {
    width: u32,
    height: u32,
    /// Mặt nạ của thao tác vẽ hiện tại.
    scratch_mask: Mask,
    /// Độ phủ cuối cùng (đã nhân clip) truyền cho tầng mực.
    coverage: Vec<f32>,
    /// Vùng mà `coverage`/`scratch_mask` có thể còn khác 0 từ lần vẽ trước.
    ///
    /// Chỉ xoá đúng vùng này thay vì cả buffer: với tiling pattern, số lần xoá bằng
    /// số ô × số operator, nên xoá cả trang mỗi lần là chi phí chính của cả trang.
    dirty: Region,
}

impl Rasterizer {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        let scratch_mask = Mask::new(width, height)?;
        Some(Rasterizer {
            width,
            height,
            scratch_mask,
            coverage: vec![0.0; (width as usize) * (height as usize)],
            dirty: Region::EMPTY,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Mặt nạ clip khởi tạo: phủ toàn trang.
    pub fn full_clip(&self) -> Mask {
        let mut m = Mask::new(self.width, self.height).expect("kích thước đã kiểm");
        m.data_mut().fill(255);
        m
    }

    /// Tô đường dẫn và trả về độ phủ đã nhân với clip.
    ///
    /// `None` khi đường dẫn không phủ pixel nào (rỗng, ngoài trang, hoặc bị clip
    /// hết) — caller bỏ qua thao tác, tiết kiệm một lượt composite.
    pub fn fill_path(
        &mut self,
        path: &Path,
        rule: FillRule,
        anti_alias: bool,
        clip: Option<&Mask>,
        soft_mask: Option<&[f32]>,
    ) -> Option<Coverage<'_>> {
        // Xoá vết của lần vẽ trước — chỉ trong vùng nó đã chạm.
        self.clear_dirty();

        let b = path.bounds();
        let region = Region::from_bounds(
            b.left(),
            b.top(),
            b.right(),
            b.bottom(),
            self.width,
            self.height,
        );
        if region.is_empty() {
            return None;
        }
        self.dirty = region;

        self.scratch_mask
            .fill_path(path, rule.into(), anti_alias, Transform::identity());
        self.apply_clip(region, clip, soft_mask)
    }

    /// Xoá `coverage` và `scratch_mask` trong vùng bẩn của lần vẽ trước.
    fn clear_dirty(&mut self) {
        if self.dirty.is_empty() {
            return;
        }
        let w = self.width as usize;
        let mask = self.scratch_mask.data_mut();
        for y in self.dirty.y0..self.dirty.y1 {
            let row = y as usize * w;
            let a = row + self.dirty.x0 as usize;
            let b = row + self.dirty.x1 as usize;
            mask[a..b].fill(0);
            self.coverage[a..b].fill(0.0);
        }
        self.dirty = Region::EMPTY;
    }

    /// Nhân mặt nạ vừa vẽ với clip và soft mask, chuyển sang f32 0..1.
    ///
    /// Gộp cả ba việc vào một lượt duyệt: đây là vòng lặp nóng nhất của engine.
    ///
    /// Soft mask đi **cùng đường** với clip thay vì được áp ở tầng mực, để mọi
    /// nhánh vẽ (tô, nét, glyph, pattern) không thể quên nó — một nhánh quên soft
    /// mask sẽ đổ mực đúng vào chỗ file muốn che.
    fn apply_clip(
        &mut self,
        region: Region,
        clip: Option<&Mask>,
        soft_mask: Option<&[f32]>,
    ) -> Option<Coverage<'_>> {
        let src = self.scratch_mask.data();
        let w = self.width as usize;
        let mut any = false;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                let mut v = src[i] as f32 / 255.0;
                if v > 0.0 {
                    if let Some(c) = clip {
                        v *= c.data()[i] as f32 / 255.0;
                    }
                    if let Some(sm) = soft_mask {
                        v *= sm.get(i).copied().unwrap_or(1.0);
                    }
                }
                self.coverage[i] = v;
                any |= v > 0.0;
            }
        }
        if any {
            Some(Coverage { data: &self.coverage, region })
        } else {
            None
        }
    }
}

/// Đổi nét thành đường dẫn tô được.
///
/// # Vì sao phải chuyển thành outline
///
/// Nét trong PDF có bề rộng theo **toạ độ người dùng**, nên phép biến đổi phi
/// đều (scale x ≠ scale y, hoặc có xiên) làm nét dày mỏng khác nhau theo hướng.
/// Cách đúng: dựng outline của nét trong toạ độ người dùng **rồi** mới biến đổi.
/// Rasterize nét trực tiếp trong toạ độ thiết bị sẽ sai bề rộng ở mọi file có
/// scale không đều — lỗi này rất hay gặp và rất khó thấy bằng mắt.
pub fn stroke_to_path(
    path: &Path,
    stroke: &Stroke,
    ctm: &Matrix,
) -> Option<Path> {
    let outline = path.stroke(stroke, 1.0)?;
    outline.transform(to_ts(ctm))
}

/// Bề rộng nét 0 nghĩa là "mảnh nhất thiết bị vẽ được" (§8.4.3.2), không phải
/// vô hình. Quy về 1 pixel để nét không biến mất trên kẽm.
pub fn effective_line_width(width_user: f32, ctm: &Matrix) -> f32 {
    let scale = ctm.mean_scale();
    if width_user <= 0.0 {
        // 1 pixel thiết bị quy về toạ độ người dùng.
        1.0 / scale.max(1e-6)
    } else {
        // Nét quá mảnh sau khi phóng cũng phải giữ tối thiểu 1 pixel, giống hành
        // vi hairline của RIP — nếu không, đường bế 0.01pt sẽ mất khi tách kẽm.
        let device_w = width_user * scale;
        if device_w < 1.0 {
            1.0 / scale.max(1e-6)
        } else {
            width_user
        }
    }
}

/// Đường dẫn hình chữ nhật (dùng cho `re`).
pub fn rect_path(x: f32, y: f32, w: f32, h: f32) -> Option<Path> {
    let mut pb = PathBuilder::new();
    pb.move_to(x, y);
    pb.line_to(x + w, y);
    pb.line_to(x + w, y + h);
    pb.line_to(x, y + h);
    pb.close();
    pb.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Matrix;

    fn unit_square_at(x: f32, y: f32, size: f32) -> Path {
        rect_path(x, y, size, size).unwrap()
    }

    #[test]
    fn fill_covers_expected_pixels() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let path = unit_square_at(0.0, 0.0, 2.0);
        let cov = r.fill_path(&path, FillRule::NonZero, false, None, None).unwrap();
        // 2x2 pixel góc trên-trái phủ hết, phần còn lại trống.
        assert_eq!(cov[0], 1.0);
        assert_eq!(cov[1], 1.0);
        assert_eq!(cov[2], 0.0);
        assert_eq!(cov[4 * 2], 0.0);
    }

    #[test]
    fn empty_path_returns_none_so_caller_can_skip() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let path = unit_square_at(100.0, 100.0, 2.0); // ngoài trang
        assert!(r.fill_path(&path, FillRule::NonZero, false, None, None).is_none());
    }

    #[test]
    fn clip_multiplies_coverage() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let mut clip = r.full_clip();
        // Clip nửa trái.
        clip.clear();
        clip.fill_path(
            &unit_square_at(0.0, 0.0, 2.0),
            tiny_skia::FillRule::Winding,
            false,
            tiny_skia::Transform::identity(),
        );
        let path = unit_square_at(0.0, 0.0, 4.0);
        let cov = r
            .fill_path(&path, FillRule::NonZero, false, Some(&clip), None)
            .unwrap();
        assert_eq!(cov[0], 1.0, "trong clip");
        assert_eq!(cov[3], 0.0, "ngoài clip phải bị loại");
    }

    #[test]
    fn soft_mask_scales_coverage_per_pixel() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let path = unit_square_at(0.0, 0.0, 4.0);
        let mut sm = vec![1.0f32; 16];
        sm[0] = 0.25;
        sm[1] = 0.0;
        let cov = r
            .fill_path(&path, FillRule::NonZero, false, None, Some(&sm))
            .unwrap();
        assert!((cov[0] - 0.25).abs() < 1e-6, "cov={}", cov[0]);
        assert_eq!(cov[1], 0.0, "mask 0 phải chặn hoàn toàn");
        assert_eq!(cov[2], 1.0);
    }

    #[test]
    fn soft_mask_of_all_zero_returns_none() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let path = unit_square_at(0.0, 0.0, 4.0);
        let sm = vec![0.0f32; 16];
        assert!(r
            .fill_path(&path, FillRule::NonZero, false, None, Some(&sm))
            .is_none());
    }

    #[test]
    fn clip_to_nothing_returns_none() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let mut clip = Mask::new(4, 4).unwrap();
        clip.clear(); // clip rỗng
        let path = unit_square_at(0.0, 0.0, 4.0);
        assert!(r
            .fill_path(&path, FillRule::NonZero, false, Some(&clip), None)
            .is_none());
    }

    #[test]
    fn even_odd_leaves_hole_where_nonzero_does_not() {
        // Hai hình vuông lồng nhau cùng chiều: even-odd tạo lỗ, nonzero thì không.
        let mut pb = PathBuilder::new();
        pb.move_to(0.0, 0.0);
        pb.line_to(8.0, 0.0);
        pb.line_to(8.0, 8.0);
        pb.line_to(0.0, 8.0);
        pb.close();
        pb.move_to(2.0, 2.0);
        pb.line_to(6.0, 2.0);
        pb.line_to(6.0, 6.0);
        pb.line_to(2.0, 6.0);
        pb.close();
        let path = pb.finish().unwrap();

        let mut r = Rasterizer::new(8, 8).unwrap();
        let center = 4 * 8 + 4;

        let eo = r
            .fill_path(&path, FillRule::EvenOdd, false, None, None)
            .unwrap()[center];
        let nz = r
            .fill_path(&path, FillRule::NonZero, false, None, None)
            .unwrap()[center];
        assert_eq!(eo, 0.0, "even-odd phải tạo lỗ");
        assert_eq!(nz, 1.0, "nonzero phải đặc");
    }

    #[test]
    fn anti_alias_off_gives_binary_coverage() {
        // Chế độ ink_accurate: cạnh phải là 0 hoặc 1 để solid đọc đúng 100% mực.
        let mut r = Rasterizer::new(8, 8).unwrap();
        let path = rect_path(0.0, 0.0, 3.5, 8.0).unwrap();
        let cov = r.fill_path(&path, FillRule::NonZero, false, None, None).unwrap();
        assert!(cov.iter().all(|v| *v == 0.0 || *v == 1.0), "AA tắt phải nhị phân");
    }

    #[test]
    fn anti_alias_on_produces_partial_edge() {
        let mut r = Rasterizer::new(8, 8).unwrap();
        let path = rect_path(0.0, 0.0, 3.5, 8.0).unwrap();
        let cov = r.fill_path(&path, FillRule::NonZero, true, None, None).unwrap();
        assert!(
            cov.iter().any(|v| *v > 0.0 && *v < 1.0),
            "AA bật phải có pixel phủ một phần"
        );
    }

    #[test]
    fn zero_width_line_becomes_one_device_pixel() {
        // Nét bề rộng 0 KHÔNG được vô hình.
        let ctm = Matrix::scale(4.0, 4.0);
        let w = effective_line_width(0.0, &ctm);
        assert!((w * ctm.mean_scale() - 1.0).abs() < 1e-3, "w={w}");
    }

    #[test]
    fn subpixel_hairline_is_promoted_to_one_pixel() {
        // Đường bế 0.01pt @72dpi: phải còn thấy trên kẽm.
        let ctm = Matrix::scale(1.0, 1.0);
        let w = effective_line_width(0.01, &ctm);
        assert!(w >= 1.0, "w={w}");
    }

    #[test]
    fn normal_line_width_is_left_alone() {
        let ctm = Matrix::scale(1.0, 1.0);
        assert_eq!(effective_line_width(2.0, &ctm), 2.0);
    }

    #[test]
    fn stroke_outline_respects_non_uniform_scale() {
        // Nét dọc và ngang phải dày khác nhau khi scale x ≠ scale y.
        let mut pb = PathBuilder::new();
        pb.move_to(0.0, 5.0);
        pb.line_to(10.0, 5.0);
        let horizontal = pb.finish().unwrap();

        let stroke = Stroke { width: 1.0, ..Stroke::default() };
        let ctm = Matrix::new(1.0, 0.0, 0.0, 4.0, 0.0, 0.0); // y phóng 4x
        let outlined = stroke_to_path(&horizontal, &stroke, &ctm).unwrap();
        let b = outlined.bounds();
        // Nét ngang dày 1 đơn vị người dùng, y phóng 4 ⇒ dày 4 trong thiết bị.
        assert!((b.height() - 4.0).abs() < 0.2, "height={}", b.height());
    }
}
