//! Sinh mặt nạ độ phủ và quản lý clip.

use tiny_skia::{Mask, Path, PathBuilder, Stroke, Transform};

use crate::error::{PpeError, PpeResult};
use crate::geom::{Matrix, Region};
use crate::ink::{InkBuffer, MemoryLease, SoftMask};

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

/// Biên độ "nở" hình học của fill bảo thủ, tính bằng pixel thiết bị mỗi phía.
///
/// Vì sao tồn tại: quy tắc "chạm là phủ" đã bảo đảm không pixel nào path đi qua
/// bị bỏ, nhưng Ghostscript còn đi xa hơn thế — bộ scan-convert không AA của nó
/// **nở path ra ngoài** một khoảng cố định theo pixel thiết bị (fill adjust) để
/// hai fill kề nhau không hở khe. Đo black-box trên glyph outline thật
/// (một chữ 'N' 7.5pt @100 DPI): GS phủ 94 pixel; "chạm" trên path nở
/// 0.15 px cho đúng 94, nở 0.25 px dư thành 96, không nở chỉ 79. Chọn
/// 0.16 px: sát mức 0.15 đo được, cộng một lề nhỏ để pha biên nằm sát ranh
/// giới pixel vẫn ló đủ rộng cho bộ raster AA giữ lại (ngưỡng bỏ sliver
/// ~0.1 px); 0.25 px đã thử và loại vì dư ~2% pixel biên so với GS.
/// Không bù khoảng nở này thì mọi trang chữ outline dày đặc đo **thiếu** mực so
/// với tham chiếu (Steam Iron: mean Cyan −3.1/255 chỉ riêng phần vector), đúng
/// chiều sai nguy hiểm của prepress.
///
/// Giá trị theo pixel THIẾT BỊ (không theo pt): fill adjust của RIP tham chiếu
/// cũng là hằng số thiết bị, nên sai số tuyệt đối không đổi theo DPI và tự nhỏ
/// dần theo tỷ lệ khi DPI tăng.
const CONSERVATIVE_FILL_ADJUST_PX: f32 = 0.16;

/// Scratch luôn tồn tại: một mask u8 + một coverage f32.
const RASTER_BASE_BYTES_PER_PIXEL: usize = std::mem::size_of::<u8>() + std::mem::size_of::<f32>();
const RASTER_RING_BYTES_PER_PIXEL: usize = std::mem::size_of::<u8>();

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
    /// Mặt nạ phụ cho vành fill-adjust: giữ hình gốc để loại phần vành trùng ruột.
    ///
    /// Cấp phát lười — chỉ trang nào thật sự dùng vành mới trả chi phí bộ nhớ.
    ring_scratch: Option<Mask>,
    /// Vùng bẩn của `ring_scratch`.
    ring_dirty: Region,
    /// Reservation dùng chung với InkBuffer của lần render; `None` cho caller
    /// độc lập dùng constructor cũ ngoài pipeline render trang.
    _memory_lease: Option<MemoryLease>,
    /// Ring mask chỉ đặt chỗ khi fill-adjust thật sự được gọi.
    _ring_memory_lease: Option<MemoryLease>,
}

impl Rasterizer {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        Self::allocate(width, height, None)
    }

    /// Rasterizer production có scratch được tính vào MemoryBudget của buffer.
    pub(crate) fn new_budgeted(width: u32, height: u32, owner: &InkBuffer) -> PpeResult<Self> {
        if width == 0 || height == 0 {
            return Err(PpeError::BadRasterSize {
                w: width as i64,
                h: height as i64,
                dpi: 0.0,
            });
        }
        let pixel_count =
            (width as usize)
                .checked_mul(height as usize)
                .ok_or(PpeError::BadRasterSize {
                    w: width as i64,
                    h: height as i64,
                    dpi: 0.0,
                })?;
        let reserved_bytes = pixel_count
            .checked_mul(RASTER_BASE_BYTES_PER_PIXEL)
            .ok_or_else(|| owner.temporary_allocation_error(usize::MAX))?;
        let lease = owner.reserve_temporary(reserved_bytes)?;
        Self::allocate(width, height, Some(lease))
            .ok_or_else(|| owner.temporary_allocation_error(reserved_bytes))
    }

    fn allocate(width: u32, height: u32, memory_lease: Option<MemoryLease>) -> Option<Self> {
        let pixel_count = (width as usize).checked_mul(height as usize)?;
        let scratch_mask = Mask::new(width, height)?;
        let mut coverage = Vec::new();
        coverage.try_reserve_exact(pixel_count).ok()?;
        coverage.resize(pixel_count, 0.0);
        Some(Rasterizer {
            width,
            height,
            scratch_mask,
            coverage,
            dirty: Region::EMPTY,
            ring_scratch: None,
            ring_dirty: Region::EMPTY,
            _memory_lease: memory_lease,
            _ring_memory_lease: None,
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
        soft_mask: Option<&SoftMask>,
    ) -> Option<Coverage<'_>> {
        self.fill_path_impl(path, rule, anti_alias, clip, soft_mask, false, None)
    }

    /// PERF (audit 2026-09-11 §PPEBX.B2): clip_region đến từ đúng Mask của
    /// graphics state. Chỉ thu vùng áp clip/composite, không đổi scan-convert.
    pub(crate) fn fill_path_in_clip_region(
        &mut self,
        path: &Path,
        rule: FillRule,
        anti_alias: bool,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
        clip_region: Option<Region>,
    ) -> Option<Coverage<'_>> {
        self.fill_path_impl(path, rule, anti_alias, clip, soft_mask, false, clip_region)
    }

    /// Nhị phân hoá mọi pixel mà path chạm tới — chỉ dùng cho nét/vector đặc đục.
    pub fn fill_path_conservative(
        &mut self,
        path: &Path,
        rule: FillRule,
        anti_alias: bool,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
    ) -> Option<Coverage<'_>> {
        self.fill_path_impl(path, rule, anti_alias, clip, soft_mask, true, None)
    }

    /// Vành fill-adjust của một path: dải rộng `2×CONSERVATIVE_FILL_ADJUST_PX`
    /// ôm quanh biên, nhị phân hoá "chạm là phủ".
    ///
    /// Trả về độ phủ của RIÊNG vành (không gồm ruột path). Caller composite nó
    /// bằng ngữ nghĩa **chỉ-thêm-mực** (blend Darken trong không gian mực):
    /// vành là dải bất định do khác biệt scan-convert với RIP tham chiếu, nên
    /// nó chỉ được phép THÊM mực — để nó knock out kênh khác sẽ có ngày ăn
    /// đúng vào pixel đỉnh TAC (đo được −8.9 điểm trên corpus khi vành dùng
    /// ngữ nghĩa composite thường).
    /// API tương thích cũ: caller độc lập nhận `None` nếu scratch không cấp được.
    /// Pipeline render trang dùng [`Self::fill_adjust_ring_checked`] để không nuốt
    /// lỗi MemoryBudget.
    pub fn fill_adjust_ring(
        &mut self,
        path: &Path,
        rule: FillRule,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
    ) -> Option<Coverage<'_>> {
        self.fill_adjust_ring_checked(path, rule, clip, soft_mask)
            .ok()
            .flatten()
    }

    pub(crate) fn fill_adjust_ring_checked(
        &mut self,
        path: &Path,
        rule: FillRule,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
    ) -> PpeResult<Option<Coverage<'_>>> {
        let stroke = Stroke {
            width: 2.0 * CONSERVATIVE_FILL_ADJUST_PX,
            line_cap: tiny_skia::LineCap::Round,
            line_join: tiny_skia::LineJoin::Round,
            ..Stroke::default()
        };
        let Some(ring) = path.stroke(&stroke, 1.0) else {
            return Ok(None);
        };

        // Hình gốc vào mặt nạ phụ: pixel đã thuộc ruột fill thì KHÔNG thuộc
        // vành. Thiếu bước loại trừ này, dải biên bị composite hai lần — vô hại
        // với alpha 1 nhưng với alpha < 1 sẽ đậm gấp đôi so với một lần tô.
        if self.ring_scratch.is_none() {
            let pixel_count = (self.width as usize) * (self.height as usize);
            let bytes = pixel_count * RASTER_RING_BYTES_PER_PIXEL;
            let ring_memory_lease = match self._memory_lease.as_ref() {
                Some(base) => Some(base.reserve_sibling(bytes)?),
                None => None,
            };
            let allocation_error = self
                ._memory_lease
                .as_ref()
                .map(|base| base.allocation_error(0))
                .unwrap_or(PpeError::BadRasterSize {
                    w: self.width as i64,
                    h: self.height as i64,
                    dpi: 0.0,
                });
            let ring_mask = Mask::new(self.width, self.height).ok_or(allocation_error)?;
            self.ring_scratch = Some(ring_mask);
            self._ring_memory_lease = ring_memory_lease;
        }
        let interior = self
            .ring_scratch
            .as_mut()
            .expect("ring scratch vừa được cấp phát");
        if !self.ring_dirty.is_empty() {
            let w = self.width as usize;
            let data = interior.data_mut();
            for y in self.ring_dirty.y0..self.ring_dirty.y1 {
                let row = y as usize * w;
                data[row + self.ring_dirty.x0 as usize..row + self.ring_dirty.x1 as usize].fill(0);
            }
        }
        interior.fill_path(path, rule.into(), true, Transform::identity());
        let ib = path.bounds();
        self.ring_dirty = Region::from_bounds(
            ib.left(),
            ib.top(),
            ib.right(),
            ib.bottom(),
            self.width,
            self.height,
        );

        let Some(cov) =
            self.fill_path_impl(&ring, FillRule::NonZero, false, clip, soft_mask, true, None)
        else {
            return Ok(None);
        };
        let region = cov.region;
        // Loại phần trùng ruột (mượn lại các buffer qua self để né borrow kép).
        let w = self.width as usize;
        let interior = self.ring_scratch.as_ref().expect("vừa cấp phát ở trên");
        let idata = interior.data();
        let mut any = false;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                if idata[i] > 0 {
                    self.coverage[i] = 0.0;
                } else {
                    any |= self.coverage[i] > 0.0;
                }
            }
        }
        if any {
            Ok(Some(Coverage {
                data: &self.coverage,
                region,
            }))
        } else {
            Ok(None)
        }
    }

    /// Raster theo phép thử tâm pixel cũ — dùng riêng cho glyph chữ sống.
    ///
    /// Font renderer của RIP có grid-fitting riêng; áp quy tắc "có chạm" của
    /// outline vector lên glyph đã hint có thể làm chữ dày hơn tham chiếu.
    pub fn fill_path_centered(
        &mut self,
        path: &Path,
        rule: FillRule,
        anti_alias: bool,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
    ) -> Option<Coverage<'_>> {
        self.fill_path_impl(path, rule, anti_alias, clip, soft_mask, false, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_path_impl(
        &mut self,
        path: &Path,
        rule: FillRule,
        anti_alias: bool,
        clip: Option<&Mask>,
        soft_mask: Option<&SoftMask>,
        binary_geometry: bool,
        clip_region: Option<Region>,
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
        let visible = match (clip, clip_region) {
            (Some(_), Some(bound)) => Region {
                x0: region.x0.max(bound.x0),
                y0: region.y0.max(bound.y0),
                x1: region.x1.min(bound.x1),
                y1: region.y1.min(bound.y1),
            }
            .clamped(self.width, self.height),
            _ => region,
        };
        if visible.is_empty() {
            return None;
        }
        // Scratch vẫn được vẽ bằng cùng path/transform trên toàn surface, nên
        // lần sau phải xóa cả bbox này, không chỉ vùng coverage đã thu hẹp.
        self.dirty = region;

        // Đường đo mực vẫn cần hình học nhị phân, nhưng raster trực tiếp với
        // `anti_alias=false` dùng đúng một phép thử tại tâm pixel và có thể làm
        // biến mất outline rất mảnh. Raster coverage trước rồi nhị phân hoá mọi
        // pixel có chạm hình giữ được nét theo chiều bảo thủ của prepress.
        self.scratch_mask.fill_path(
            path,
            rule.into(),
            anti_alias || binary_geometry,
            Transform::identity(),
        );
        self.apply_clip(visible, clip, soft_mask, binary_geometry)
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
        soft_mask: Option<&SoftMask>,
        binary_geometry: bool,
    ) -> Option<Coverage<'_>> {
        let src = self.scratch_mask.data();
        let w = self.width as usize;
        let mut any = false;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                let mut v = if binary_geometry {
                    if src[i] > 0 {
                        1.0
                    } else {
                        0.0
                    }
                } else {
                    src[i] as f32 / 255.0
                };
                if v > 0.0 {
                    if let Some(c) = clip {
                        v *= c.data()[i] as f32 / 255.0;
                    }
                    if let Some(sm) = soft_mask {
                        v *= sm.value_at(x, y);
                    }
                }
                self.coverage[i] = v;
                any |= v > 0.0;
            }
        }
        if any {
            Some(Coverage {
                data: &self.coverage,
                region,
            })
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
pub fn stroke_to_path(path: &Path, stroke: &Stroke, ctm: &Matrix) -> Option<Path> {
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
    use crate::ink::{InkBuffer, InkSpace};

    fn unit_square_at(x: f32, y: f32, size: f32) -> Path {
        rect_path(x, y, size, size).unwrap()
    }

    #[test]
    fn bounded_clip_keeps_all_pixels_and_clears_previous_scratch() {
        let mut baseline = Rasterizer::new(128, 128).unwrap();
        let mut bounded = Rasterizer::new(128, 128).unwrap();
        let full = unit_square_at(-100.0, -100.0, 400.0);
        let owner = InkBuffer::new(128, 128, InkSpace::new()).unwrap();
        let mut soft = owner.new_soft_mask(Region::full(128, 128), 0.0).unwrap();
        soft.values_mut().fill(0.5);
        for (x, y, width, height) in [
            (0.3, 0.2, 5.3, 127.0),
            (100.4, 110.2, 6.7, 5.2),
            (20.0, 20.0, 0.0, 0.0),
            (0.0, 0.0, 128.0, 128.0),
        ] {
            let mut mask = Mask::new(128, 128).unwrap();
            let path = rect_path(x, y, width, height).unwrap();
            mask.fill_path(
                &path,
                tiny_skia::FillRule::Winding,
                true,
                Transform::identity(),
            );
            let bound = if width == 0.0 {
                Region::EMPTY
            } else {
                Region::from_bounds(x, y, x + width, y + height, 128, 128)
            };
            let expected = baseline
                .fill_path(&full, FillRule::NonZero, true, Some(&mask), Some(&soft))
                .map(|coverage| coverage.data.to_vec());
            let actual = bounded
                .fill_path_in_clip_region(
                    &full,
                    FillRule::NonZero,
                    true,
                    Some(&mask),
                    Some(&soft),
                    Some(bound),
                )
                .map(|coverage| {
                    assert!(coverage.region.x1 - coverage.region.x0 <= bound.x1 - bound.x0);
                    assert!(coverage.region.y1 - coverage.region.y0 <= bound.y1 - bound.y0);
                    coverage.data.to_vec()
                });
            assert_eq!(actual, expected);
        }
        assert_eq!(
            bounded
                .fill_path(&full, FillRule::NonZero, true, None, None)
                .unwrap()
                .data,
            baseline
                .fill_path(&full, FillRule::NonZero, true, None, None)
                .unwrap()
                .data
        );
    }

    #[test]
    fn fill_covers_expected_pixels() {
        let mut r = Rasterizer::new(4, 4).unwrap();
        let path = unit_square_at(0.0, 0.0, 2.0);
        let cov = r
            .fill_path(&path, FillRule::NonZero, false, None, None)
            .unwrap();
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
        assert!(r
            .fill_path(&path, FillRule::NonZero, false, None, None)
            .is_none());
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
        let owner = InkBuffer::new(4, 4, InkSpace::new()).unwrap();
        let mut sm = owner.new_soft_mask(Region::full(4, 4), 0.0).unwrap();
        sm.values_mut().fill(1.0);
        sm.values_mut()[0] = 0.25;
        sm.values_mut()[1] = 0.0;
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
        let owner = InkBuffer::new(4, 4, InkSpace::new()).unwrap();
        let sm = owner.new_soft_mask(Region::full(4, 4), 0.0).unwrap();
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
        let cov = r
            .fill_path(&path, FillRule::NonZero, false, None, None)
            .unwrap();
        assert!(
            cov.iter().all(|v| *v == 0.0 || *v == 1.0),
            "AA tắt phải nhị phân"
        );
    }

    #[test]
    fn conservative_fill_adjust_reaches_next_pixel_like_reference_rip() {
        // Hình chữ nhật dừng ở x = 3.9: hàng pixel 4 KHÔNG bị hình chạm
        // (quy tắc "chạm là phủ" cho 0), nhưng RIP tham chiếu nở fill một
        // khoảng cố định theo pixel thiết bị nên 3.9 + 0.15 = 4.05 vẫn phủ
        // pixel 4. Thiếu vành nở này, trang chữ outline đo thiếu mực.
        let mut r = Rasterizer::new(8, 8).unwrap();
        // Tới (3.99, 3.99): vành 0.16 px ló sang pixel 4 một dải 0.15 px — đủ
        // rộng để bộ raster AA không bỏ (ngưỡng bỏ sliver ~0.1 px).
        let path = rect_path(1.0, 1.0, 2.99, 2.99).unwrap();
        let ring = r
            .fill_adjust_ring(&path, FillRule::NonZero, None, None)
            .unwrap();
        assert_eq!(
            ring[1 * 8 + 4],
            1.0,
            "vành nở phải với sang pixel 4 theo x (3.99+0.16=4.15)"
        );
        assert_eq!(ring[4 * 8 + 1], 1.0, "vành nở phải với sang pixel 4 theo y");
        // Góc chéo (4,4) KHÔNG bị ràng buộc: phần vành ló sang đường chéo chỉ
        // ~0.16/√2 ≈ 0.11 px mỗi trục và bộ raster có thể bỏ mảnh tam giác đó;
        // biên theo trục mới là phần quyết định lượng mực.
        assert_eq!(ring[1 * 8 + 5], 0.0, "vành nở không được với quá một pixel");
        // Fill bảo thủ thường không tự nở.
        let cov = r
            .fill_path_conservative(&path, FillRule::NonZero, false, None, None)
            .unwrap();
        assert_eq!(
            cov[1 * 8 + 4],
            0.0,
            "fill bảo thủ không tự nở khi thiếu vành"
        );
        assert_eq!(cov[2 * 8 + 2], 1.0, "ruột fill giữ nguyên");
    }

    #[test]
    fn ink_mode_keeps_a_subpixel_sliver() {
        let mut r = Rasterizer::new(8, 8).unwrap();
        let path = rect_path(3.1, 0.0, 0.1, 8.0).unwrap();
        let cov = r
            .fill_path_conservative(&path, FillRule::NonZero, false, None, None)
            .unwrap();
        assert!(
            cov.iter().any(|v| *v == 1.0),
            "outline có chạm pixel không được biến mất ở đường đo mực"
        );
        assert!(
            cov.iter().all(|v| *v == 0.0 || *v == 1.0),
            "hình học đường đo vẫn phải nhị phân"
        );
    }

    #[test]
    fn centered_glyph_mode_keeps_the_old_pixel_center_rule() {
        let mut r = Rasterizer::new(8, 8).unwrap();
        let path = rect_path(3.1, 0.0, 0.1, 8.0).unwrap();
        assert!(
            r.fill_path_centered(&path, FillRule::NonZero, false, None, None)
                .is_none(),
            "glyph không dùng quy tắc có-chạm của outline vector"
        );
    }

    #[test]
    fn anti_alias_on_produces_partial_edge() {
        let mut r = Rasterizer::new(8, 8).unwrap();
        let path = rect_path(0.0, 0.0, 3.5, 8.0).unwrap();
        let cov = r
            .fill_path(&path, FillRule::NonZero, true, None, None)
            .unwrap();
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
    fn budgeted_rasterizer_releases_its_temporary_reservation() {
        // Buffer 4×4 CMYK+alpha = 320 byte; raster scratch luôn sống 5 byte/pixel
        // = 80 byte. Ngân sách 400 chỉ chứa đúng một rasterizer tại một thời điểm.
        let owner = InkBuffer::new_with_memory_budget(4, 4, InkSpace::new(), 400).unwrap();
        {
            let _first = Rasterizer::new_budgeted(4, 4, &owner).unwrap();
        }
        let _second = Rasterizer::new_budgeted(4, 4, &owner)
            .expect("drop rasterizer phải trả reservation cho lần cấp tiếp theo");
    }

    #[test]
    fn lazy_ring_scratch_is_budgeted_and_released() {
        let owner = InkBuffer::new_with_memory_budget(4, 4, InkSpace::new(), 400).unwrap();
        let path = unit_square_at(0.0, 0.0, 4.0);
        let mut raster = Rasterizer::new_budgeted(4, 4, &owner).unwrap();
        let result = raster.fill_adjust_ring_checked(&path, FillRule::NonZero, None, None);
        assert!(matches!(result, Err(PpeError::MemoryBudgetExceeded { .. })));
        drop(raster);
        Rasterizer::new_budgeted(4, 4, &owner)
            .expect("reservation lỗi phải không làm rò scratch raster");
    }

    #[test]
    fn stroke_outline_respects_non_uniform_scale() {
        // Nét dọc và ngang phải dày khác nhau khi scale x ≠ scale y.
        let mut pb = PathBuilder::new();
        pb.move_to(0.0, 5.0);
        pb.line_to(10.0, 5.0);
        let horizontal = pb.finish().unwrap();

        let stroke = Stroke {
            width: 1.0,
            ..Stroke::default()
        };
        let ctm = Matrix::new(1.0, 0.0, 0.0, 4.0, 0.0, 0.0); // y phóng 4x
        let outlined = stroke_to_path(&horizontal, &stroke, &ctm).unwrap();
        let b = outlined.bounds();
        // Nét ngang dày 1 đơn vị người dùng, y phóng 4 ⇒ dày 4 trong thiết bị.
        assert!((b.height() - 4.0).abs() < 0.2, "height={}", b.height());
    }
}
