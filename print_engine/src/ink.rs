//! Không gian mực (ink space) và buffer n kênh.
//!
//! # Vì sao không rasterize trong RGB
//!
//! Mọi renderer phổ thông (pdfium, Skia, Cairo) trộn màu trong RGB(A). Với
//! prepress điều đó phá ba thứ không thể phục hồi:
//!
//! 1. **Spot color.** `Separation`/`DeviceN` bị quy về alternate space ngay khi
//!    vẽ ⇒ không còn kênh Pantone để xuất kẽm.
//! 2. **Overprint.** Overprint không phải một blend mode; nó là quy tắc "kênh
//!    nào nguồn không khai báo thì giữ nguyên nền" (ISO 32000-2 §11.7.4.2).
//!    Trong RGB không có khái niệm "kênh nguồn không khai báo".
//! 3. **TAC.** Tổng mực là tổng lượng mực vật lý. Từ pixel RGB không suy ra được
//!    (vô số bộ CMYK cho cùng một RGB).
//!
//! Nên PPE giữ đúng dữ liệu mực từ đầu tới cuối: `[C, M, Y, K, spot…]`, mỗi kênh
//! `f32` trong `0.0..=1.0` nghĩa là 0–100% mực.

use crate::error::{PpeError, PpeResult};

/// Trần số colorant trong một trang.
///
/// Bằng 64 vì [`ChannelMask`] là `u64` — participation set phải kiểm tra được
/// bằng một phép AND. GS `-dMaxSpots` mặc định 32; 64 là dư cho mọi job thật
/// (bao bì nhiều kênh nhất trong thực tế hiếm khi quá 12).
pub const MAX_COLORANTS: usize = 64;

/// Một loại mực.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Colorant {
    Cyan,
    Magenta,
    Yellow,
    Black,
    /// Mực pha: Pantone, vernis, kênh bế/khắc (CutContour, Dieline)…
    Spot(String),
}

impl Colorant {
    /// Tên như xuất hiện trong PDF và trong output plate.
    ///
    /// Bốn tên process khớp đúng chuỗi mà `separations.py` đang phân loại
    /// process vs spot (`"Cyan" | "Magenta" | "Yellow" | "Black"`), nên plate của
    /// PPE cắm thẳng vào contract cũ không cần map lại.
    pub fn name(&self) -> &str {
        match self {
            Colorant::Cyan => "Cyan",
            Colorant::Magenta => "Magenta",
            Colorant::Yellow => "Yellow",
            Colorant::Black => "Black",
            Colorant::Spot(name) => name,
        }
    }

    pub fn is_spot(&self) -> bool {
        matches!(self, Colorant::Spot(_))
    }

    /// Nhận diện tên mực trong PDF về colorant process tương ứng.
    ///
    /// PDF cho phép `Separation` tên `/Cyan` — đó là mực process, KHÔNG phải
    /// spot. Bỏ qua bước này thì một file dùng `Separation Cyan` sẽ sinh ra plate
    /// "spot Cyan" thứ năm bên cạnh plate Cyan process ⇒ TAC bị đếm hai lần.
    pub fn from_pdf_name(name: &str) -> Colorant {
        match name {
            "Cyan" => Colorant::Cyan,
            "Magenta" => Colorant::Magenta,
            "Yellow" => Colorant::Yellow,
            "Black" => Colorant::Black,
            other => Colorant::Spot(other.to_string()),
        }
    }
}

/// Tập kênh mà một nguồn màu **khai báo** (participation set).
///
/// Bitmask theo chỉ số kênh trong [`InkSpace`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChannelMask(u64);

impl ChannelMask {
    pub const EMPTY: ChannelMask = ChannelMask(0);

    /// Bốn kênh process C,M,Y,K.
    pub const PROCESS: ChannelMask = ChannelMask(0b1111);

    pub fn single(index: usize) -> ChannelMask {
        debug_assert!(index < MAX_COLORANTS);
        ChannelMask(1u64 << index)
    }

    pub fn with(self, index: usize) -> ChannelMask {
        debug_assert!(index < MAX_COLORANTS);
        ChannelMask(self.0 | (1u64 << index))
    }

    pub fn without(self, index: usize) -> ChannelMask {
        ChannelMask(self.0 & !(1u64 << index))
    }

    pub fn contains(self, index: usize) -> bool {
        index < MAX_COLORANTS && (self.0 & (1u64 << index)) != 0
    }

    pub fn union(self, other: ChannelMask) -> ChannelMask {
        ChannelMask(self.0 | other.0)
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

/// Danh sách colorant của một lần render, theo thứ tự kênh.
///
/// Bất biến: **bốn kênh đầu luôn là C, M, Y, K**, kể cả khi trang không dùng.
/// Giữ cố định như vậy để plate output, công thức TAC và soft-proof không phải
/// tra cứu động, và để so sánh golden với GS `tiffsep` (vốn luôn xuất 4 plate
/// process) là so cùng thứ tự.
#[derive(Debug, Clone)]
pub struct InkSpace {
    colorants: Vec<Colorant>,
}

impl Default for InkSpace {
    fn default() -> Self {
        Self::new()
    }
}

impl InkSpace {
    pub fn new() -> Self {
        InkSpace {
            colorants: vec![Colorant::Cyan, Colorant::Magenta, Colorant::Yellow, Colorant::Black],
        }
    }

    pub fn len(&self) -> usize {
        self.colorants.len()
    }

    pub fn is_empty(&self) -> bool {
        false // luôn có 4 kênh process
    }

    pub fn colorants(&self) -> &[Colorant] {
        &self.colorants
    }

    pub fn index_of(&self, colorant: &Colorant) -> Option<usize> {
        self.colorants.iter().position(|c| c == colorant)
    }

    /// Lấy chỉ số kênh, thêm mới nếu chưa có.
    ///
    /// Spot được thêm theo thứ tự gặp trong content stream — giống cách RIP đánh
    /// số kẽm theo thứ tự xuất hiện.
    pub fn register(&mut self, colorant: Colorant) -> PpeResult<usize> {
        if let Some(i) = self.index_of(&colorant) {
            return Ok(i);
        }
        if self.colorants.len() >= MAX_COLORANTS {
            return Err(PpeError::TooManyColorants { limit: MAX_COLORANTS });
        }
        self.colorants.push(colorant);
        Ok(self.colorants.len() - 1)
    }

    /// `None` (mực `/None` của PDF) không bao giờ được đánh mực — ISO 32000-2
    /// §8.6.6.4: mọi thao tác vẽ vào colorant `/None` bị loại bỏ.
    pub fn is_none_colorant(name: &str) -> bool {
        name == "None"
    }

    /// `/All` đánh lên **mọi** kênh — dùng cho crop mark in trên tất cả kẽm.
    pub fn is_all_colorant(name: &str) -> bool {
        name == "All"
    }

    pub fn all_channels_mask(&self) -> ChannelMask {
        let mut m = ChannelMask::EMPTY;
        for i in 0..self.colorants.len() {
            m = m.with(i);
        }
        m
    }
}

/// Màu nguồn đã quy về không gian mực, kèm ngữ nghĩa overprint.
#[derive(Debug, Clone)]
pub struct InkPaint {
    /// Lượng mực theo từng kênh; độ dài = số kênh của [`InkSpace`] khi tạo.
    pub ink: Vec<f32>,
    /// Kênh mà nguồn thực sự khai báo. Kênh ngoài tập này sẽ bị knockout (nếu
    /// overprint tắt) hoặc giữ nguyên nền (nếu overprint bật).
    pub declared: ChannelMask,
    /// `/OP` (vẽ nét) hoặc `/op` (tô) trong ExtGState.
    pub overprint: bool,
    /// Alpha hằng `CA`/`ca`.
    pub alpha: f32,
}

impl InkPaint {
    /// Màu đục, knockout, phủ đúng các kênh khai báo.
    pub fn opaque(ink: Vec<f32>, declared: ChannelMask) -> Self {
        InkPaint { ink, declared, overprint: false, alpha: 1.0 }
    }

    /// Áp dụng ngữ nghĩa `OPM = 1` (overprint mode "zero means no-op").
    ///
    /// ISO 32000-2 §11.7.4.4: khi overprint bật và `OPM = 1`, với nguồn màu
    /// DeviceCMYK, **thành phần bằng 0 không ghi đè** kênh tương ứng — thay vì
    /// đặt kênh đó về 0. Đây chính là cách một chữ đen `0,0,0,1` overprint lên
    /// nền màu mà không khoét trắng nền.
    ///
    /// Cài đặt: loại các kênh có giá trị 0 khỏi participation set.
    pub fn with_overprint_mode_1(mut self) -> Self {
        if self.overprint {
            for i in 0..self.ink.len() {
                if self.declared.contains(i) && self.ink[i] <= 0.0 {
                    self.declared = self.declared.without(i);
                }
            }
        }
        self
    }
}

/// Buffer mực n kênh, lưu theo **mặt phẳng** (plane-major).
///
/// Plane-major (mỗi kênh một mảng liên tục) thay vì interleaved vì:
/// * xuất plate = copy nguyên một mặt phẳng, không phải stride-gather;
/// * trộn mực chạy tuần tự trong một kênh ⇒ thân thiện cache và vector hoá;
/// * thêm spot giữa lúc render chỉ là push thêm một mặt phẳng, không phải dựng
///   lại toàn bộ buffer.
#[derive(Debug, Clone)]
pub struct InkBuffer {
    width: u32,
    height: u32,
    space: InkSpace,
    /// `planes[channel][y * width + x]`, giá trị 0.0..=1.0.
    planes: Vec<Vec<f32>>,
}

impl InkBuffer {
    /// Buffer trắng (0% mực trên mọi kênh) — tương đương giấy trắng.
    pub fn new(width: u32, height: u32, space: InkSpace) -> PpeResult<Self> {
        if width == 0 || height == 0 {
            return Err(PpeError::BadRasterSize { w: width as i64, h: height as i64, dpi: 0.0 });
        }
        let px = (width as usize)
            .checked_mul(height as usize)
            .ok_or(PpeError::BadRasterSize { w: width as i64, h: height as i64, dpi: 0.0 })?;
        let planes = vec![vec![0.0f32; px]; space.len()];
        Ok(InkBuffer { width, height, space, planes })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn space(&self) -> &InkSpace {
        &self.space
    }

    pub fn plane(&self, channel: usize) -> &[f32] {
        &self.planes[channel]
    }

    /// Đồng bộ số mặt phẳng với [`InkSpace`] sau khi spot mới được đăng ký giữa
    /// lúc render. Mặt phẳng mới bắt đầu từ 0% mực.
    pub fn sync_channels(&mut self) {
        let px = (self.width as usize) * (self.height as usize);
        while self.planes.len() < self.space.len() {
            self.planes.push(vec![0.0f32; px]);
        }
    }

    pub fn space_mut(&mut self) -> &mut InkSpace {
        &mut self.space
    }

    /// Trộn một nguồn màu vào buffer qua mặt nạ độ phủ.
    ///
    /// `coverage` dài `width*height`, giá trị 0.0..=1.0 (0 = không chạm tới).
    ///
    /// # Mô hình trộn
    ///
    /// Với mỗi pixel, `a = coverage * paint.alpha`:
    ///
    /// * kênh **có** trong `declared`: `dst = dst*(1-a) + src*a` — mực nguồn phủ
    ///   lên nền theo tỉ lệ.
    /// * kênh **không** có trong `declared`:
    ///   * overprint **tắt** → `dst = dst*(1-a)`. Đây là *knockout*: object đục
    ///     xoá sạch mực nền ở vùng nó che, kể cả kênh nó không dùng. Đúng hành vi
    ///     mặc định của PDF và là nguyên nhân của "viền trắng" khi in.
    ///   * overprint **bật** → `dst` giữ nguyên. Mực nguồn cộng thêm lên nền.
    ///
    /// Chính hai dòng này là thứ RGB không biểu diễn được.
    pub fn composite(&mut self, coverage: &[f32], paint: &InkPaint) {
        debug_assert_eq!(coverage.len(), (self.width as usize) * (self.height as usize));
        self.sync_channels();

        let n = self.planes.len();
        for ch in 0..n {
            let declared = paint.declared.contains(ch);
            if !declared && paint.overprint {
                continue; // giữ nguyên nền — bản chất của overprint
            }
            let src = if declared {
                paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0)
            } else {
                0.0 // knockout về giấy trắng
            };
            let plane = &mut self.planes[ch];
            for (dst, &cov) in plane.iter_mut().zip(coverage.iter()) {
                if cov <= 0.0 {
                    continue;
                }
                let a = (cov * paint.alpha).clamp(0.0, 1.0);
                *dst = *dst * (1.0 - a) + src * a;
            }
        }
    }

    /// Trộn mực tại **một** pixel.
    ///
    /// Dùng cho ảnh: mỗi pixel có màu riêng nên không thể dùng chung một
    /// [`InkPaint`] cho cả mặt nạ như đường dẫn vector. Mô hình trộn giống hệt
    /// [`InkBuffer::composite`] — knockout và overprint hành xử y nguyên, nên ảnh
    /// và vector không bao giờ lệch ngữ nghĩa.
    pub fn composite_at(&mut self, index: usize, coverage: f32, paint: &InkPaint) {
        if coverage <= 0.0 {
            return;
        }
        let a = (coverage * paint.alpha).clamp(0.0, 1.0);
        for ch in 0..self.planes.len() {
            let declared = paint.declared.contains(ch);
            if !declared && paint.overprint {
                continue;
            }
            let src = if declared {
                paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0)
            } else {
                0.0
            };
            if let Some(dst) = self.planes[ch].get_mut(index) {
                *dst = *dst * (1.0 - a) + src * a;
            }
        }
    }

    /// Tổng mực (TAC) theo phần trăm tại từng pixel.
    ///
    /// TAC = Σ kênh × 100. Bốn kênh solid ⇒ 400%. Spot cộng như process, đúng
    /// cách xưởng tính giới hạn mực (mực pha vẫn là mực trên giấy).
    pub fn tac_percent(&self) -> Vec<f32> {
        let px = (self.width as usize) * (self.height as usize);
        let mut out = vec![0.0f32; px];
        for plane in &self.planes {
            for (o, v) in out.iter_mut().zip(plane.iter()) {
                *o += v * 100.0;
            }
        }
        out
    }

    pub fn max_tac_percent(&self) -> f32 {
        self.tac_percent().into_iter().fold(0.0f32, f32::max)
    }

    /// Xuất một kẽm sang byte 0..255 với **255 = 100% mực**.
    ///
    /// Chiều quy ước này khớp `ink_density` mà `separations.py` dựng (`255 - tiff`
    /// vì TIFF của `tiffsep` bị nghịch đảo), nên plate PPE cắm thẳng vào
    /// `_create_colored_plate` không cần đổi dấu ở lớp Python.
    pub fn plate_u8(&self, channel: usize) -> Vec<u8> {
        self.planes[channel]
            .iter()
            .map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
            .collect()
    }

    /// Độ phủ của một kẽm theo % diện tích có mực (ngưỡng > 2%).
    pub fn plate_coverage_pct(&self, channel: usize) -> f32 {
        let plane = &self.planes[channel];
        if plane.is_empty() {
            return 0.0;
        }
        let inked = plane.iter().filter(|v| **v > 0.02).count();
        inked as f32 / plane.len() as f32 * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_coverage(n: usize) -> Vec<f32> {
        vec![1.0; n]
    }

    fn cmyk(c: f32, m: f32, y: f32, k: f32) -> Vec<f32> {
        vec![c, m, y, k]
    }

    #[test]
    fn process_channels_are_fixed_and_ordered() {
        let space = InkSpace::new();
        assert_eq!(space.len(), 4);
        let names: Vec<&str> = space.colorants().iter().map(|c| c.name()).collect();
        assert_eq!(names, ["Cyan", "Magenta", "Yellow", "Black"]);
    }

    #[test]
    fn separation_named_cyan_maps_to_process_not_spot() {
        // Nếu sai, file dùng `Separation Cyan` sẽ sinh plate thứ 5 ⇒ TAC đếm đôi.
        let mut space = InkSpace::new();
        let idx = space.register(Colorant::from_pdf_name("Cyan")).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(space.len(), 4);
    }

    #[test]
    fn spots_register_in_encounter_order() {
        let mut space = InkSpace::new();
        let a = space.register(Colorant::from_pdf_name("PANTONE 485 C")).unwrap();
        let b = space.register(Colorant::from_pdf_name("CutContour")).unwrap();
        assert_eq!((a, b), (4, 5));
        // Đăng ký lại phải trả cùng kênh, không tạo trùng.
        assert_eq!(space.register(Colorant::from_pdf_name("PANTONE 485 C")).unwrap(), 4);
        assert_eq!(space.len(), 6);
    }

    #[test]
    fn colorant_limit_is_enforced_loudly() {
        let mut space = InkSpace::new();
        for i in 0..(MAX_COLORANTS - 4) {
            space.register(Colorant::Spot(format!("S{i}"))).unwrap();
        }
        assert!(matches!(
            space.register(Colorant::Spot("overflow".into())),
            Err(PpeError::TooManyColorants { .. })
        ));
    }

    #[test]
    fn solid_cmyk_fill_reads_exactly_400_percent_tac() {
        // Đây là bài test chống "false-clean": 4 kênh solid PHẢI ra đúng 400%.
        // Soft-proof color-managed nén xuống ~292% và đó là lý do TAC không được
        // đo trên plate đã qua ICC.
        let mut buf = InkBuffer::new(4, 4, InkSpace::new()).unwrap();
        let paint = InkPaint::opaque(cmyk(1.0, 1.0, 1.0, 1.0), ChannelMask::PROCESS);
        buf.composite(&full_coverage(16), &paint);
        assert!((buf.max_tac_percent() - 400.0).abs() < 1e-3);
    }

    #[test]
    fn knockout_clears_background_channels_not_declared() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        // Nền: 100% Magenta.
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS),
        );
        // Vẽ đen K-only, overprint TẮT, chỉ khai báo kênh K.
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        );
        assert_eq!(buf.plane(1)[0], 0.0, "Magenta phải bị khoét trắng");
        assert_eq!(buf.plane(3)[0], 1.0, "K phải đủ 100%");
    }

    #[test]
    fn overprint_preserves_background_channels() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS),
        );
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3));
        black.overprint = true;
        buf.composite(&full_coverage(4), &black);
        assert_eq!(buf.plane(1)[0], 1.0, "overprint phải giữ nền Magenta");
        assert_eq!(buf.plane(3)[0], 1.0);
        // Tổng mực tăng lên 200% — đúng bản chất chồng mực.
        assert!((buf.max_tac_percent() - 200.0).abs() < 1e-3);
    }

    #[test]
    fn overprint_mode_1_zero_component_does_not_knock_out() {
        // Chữ đen DeviceCMYK 0,0,0,1 overprint OPM=1 trên nền cyan:
        // ba kênh C,M,Y giá trị 0 phải KHÔNG ghi đè nền.
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(1),
            &InkPaint::opaque(cmyk(1.0, 0.0, 0.0, 0.0), ChannelMask::PROCESS),
        );
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::PROCESS);
        black.overprint = true;
        let black = black.with_overprint_mode_1();
        buf.composite(&full_coverage(1), &black);
        assert_eq!(buf.plane(0)[0], 1.0, "Cyan nền phải còn nguyên (OPM=1)");
        assert_eq!(buf.plane(3)[0], 1.0);
    }

    #[test]
    fn overprint_mode_0_zero_component_does_knock_out() {
        // Cùng tình huống nhưng OPM=0: thành phần 0 VẪN ghi đè ⇒ nền bị khoét.
        // Phân biệt được hai chế độ này là điều kiện để overprint preview tin được.
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(1),
            &InkPaint::opaque(cmyk(1.0, 0.0, 0.0, 0.0), ChannelMask::PROCESS),
        );
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::PROCESS);
        black.overprint = true; // KHÔNG gọi with_overprint_mode_1
        buf.composite(&full_coverage(1), &black);
        assert_eq!(buf.plane(0)[0], 0.0, "OPM=0 phải khoét nền");
    }

    #[test]
    fn spot_plate_survives_and_counts_into_tac() {
        let mut space = InkSpace::new();
        let spot = space.register(Colorant::Spot("PANTONE 485 C".into())).unwrap();
        let mut buf = InkBuffer::new(2, 2, space).unwrap();
        let mut ink = vec![0.0; 5];
        ink[spot] = 1.0;
        buf.composite(&full_coverage(4), &InkPaint::opaque(ink, ChannelMask::single(spot)));
        assert_eq!(buf.plane(spot)[0], 1.0);
        assert!((buf.max_tac_percent() - 100.0).abs() < 1e-3);
        assert!(buf.space().colorants()[spot].is_spot());
    }

    #[test]
    fn partial_coverage_blends_proportionally() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &[0.5],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        );
        assert!((buf.plane(3)[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn constant_alpha_scales_coverage() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        let mut paint = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3));
        paint.alpha = 0.25;
        buf.composite(&[1.0], &paint);
        assert!((buf.plane(3)[0] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn zero_coverage_leaves_buffer_untouched() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(1.0, 1.0, 1.0, 1.0), ChannelMask::PROCESS),
        );
        let before = buf.plane(0).to_vec();
        buf.composite(&vec![0.0; 4], &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 0.0), ChannelMask::PROCESS));
        assert_eq!(buf.plane(0), &before[..], "coverage 0 không được đổi buffer");
    }

    #[test]
    fn plate_u8_uses_255_as_full_ink() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &[1.0],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        );
        assert_eq!(buf.plate_u8(3)[0], 255);
        assert_eq!(buf.plate_u8(0)[0], 0);
    }

    #[test]
    fn plate_u8_rounds_half_tone_to_128() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &[0.5],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        );
        assert_eq!(buf.plate_u8(3)[0], 128);
    }

    #[test]
    fn none_and_all_colorants_are_recognised() {
        assert!(InkSpace::is_none_colorant("None"));
        assert!(!InkSpace::is_none_colorant("PANTONE 485 C"));
        assert!(InkSpace::is_all_colorant("All"));
    }

    #[test]
    fn all_colorant_mask_covers_every_channel() {
        let mut space = InkSpace::new();
        space.register(Colorant::Spot("Varnish".into())).unwrap();
        let mask = space.all_channels_mask();
        for i in 0..5 {
            assert!(mask.contains(i), "kênh {i} phải nằm trong /All");
        }
    }

    #[test]
    fn sync_channels_adds_plane_for_late_spot() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        let idx = buf.space_mut().register(Colorant::Spot("Late".into())).unwrap();
        buf.sync_channels();
        assert_eq!(buf.plane(idx).len(), 4);
        assert_eq!(buf.plane(idx)[0], 0.0);
    }

    #[test]
    fn zero_size_buffer_is_rejected() {
        assert!(InkBuffer::new(0, 10, InkSpace::new()).is_err());
    }
}
