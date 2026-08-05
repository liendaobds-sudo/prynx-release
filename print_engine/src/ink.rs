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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rayon::prelude::*;

use crate::blend::{blend_nonseparable_cmyk, BlendMode};
use crate::color::icc::ColorManager;
use crate::error::{PpeError, PpeResult};
use crate::geom::Region;

const MIB: usize = 1024 * 1024;
const BYTES_PER_SAMPLE: usize = std::mem::size_of::<f32>();

/// Dưới ngưỡng này, chi phí chia việc lớn hơn lợi ích song song.
/// Đây là ngưỡng theo kích thước công việc, không phải hard-cap phần cứng: trang
/// lớn luôn dùng toàn bộ pool Rayon dùng chung, kể cả trên máy mạnh nhiều lõi.
const PARALLEL_FRAME_MIN_PIXELS: usize = 512 * 1024;

#[inline]
fn should_parallelize_frame(pixel_count: usize) -> bool {
    pixel_count >= PARALLEL_FRAME_MIN_PIXELS && rayon::current_num_threads() > 1
}

/// Ngân sách mặc định cho toàn bộ buffer mực đang sống trong một lần render.
///
/// A4 @300 DPI, bốn kênh process + alpha cần khoảng 166 MiB. 512 MiB giữ được
/// trang đó cùng một transparency group cỡ trang, nhưng từ chối sớm raster quá
/// lớn hoặc group lồng sâu thay vì để allocator làm sidecar chết vì OOM.
pub const DEFAULT_RENDER_MEMORY_BUDGET_BYTES: usize = 512 * MIB;

#[derive(Debug)]
struct MemoryBudget {
    limit: usize,
    used: AtomicUsize,
}

impl MemoryBudget {
    fn new(limit: usize) -> Self {
        MemoryBudget {
            limit,
            used: AtomicUsize::new(0),
        }
    }

    fn reserve(&self, bytes: usize) -> PpeResult<()> {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let requested = used
                .checked_add(bytes)
                .ok_or_else(|| memory_budget_error(usize::MAX, self.limit))?;
            if requested > self.limit {
                return Err(memory_budget_error(requested, self.limit));
            }
            match self.used.compare_exchange_weak(
                used,
                requested,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Ok(()),
                Err(actual) => used = actual,
            }
        }
    }

    fn release(&self, bytes: usize) {
        self.used.fetch_sub(bytes, Ordering::AcqRel);
    }
}

fn mib_ceil(bytes: usize) -> usize {
    bytes.saturating_add(MIB - 1) / MIB
}

fn memory_budget_error(requested: usize, limit: usize) -> PpeError {
    PpeError::MemoryBudgetExceeded {
        requested_mib: mib_ceil(requested),
        limit_mib: mib_ceil(limit),
    }
}

fn buffer_bytes(pixel_count: usize, plane_count: usize) -> PpeResult<usize> {
    pixel_count
        .checked_mul(plane_count)
        .and_then(|samples| samples.checked_mul(BYTES_PER_SAMPLE))
        .ok_or_else(|| memory_budget_error(usize::MAX, usize::MAX))
}

fn zeroed_plane(pixel_count: usize, limit: usize) -> PpeResult<Vec<f32>> {
    let bytes = buffer_bytes(pixel_count, 1)?;
    let mut plane = Vec::new();
    plane
        .try_reserve_exact(pixel_count)
        .map_err(|_| memory_budget_error(bytes, limit))?;
    plane.resize(pixel_count, 0.0);
    Ok(plane)
}

fn rgb_sidecar_bytes(pixel_count: usize) -> PpeResult<usize> {
    pixel_count
        .checked_mul(std::mem::size_of::<[f32; 3]>() + std::mem::size_of::<u8>())
        .ok_or_else(|| memory_budget_error(usize::MAX, usize::MAX))
}

fn white_rgb_pixels(pixel_count: usize, limit: usize) -> PpeResult<Vec<[f32; 3]>> {
    let bytes = pixel_count
        .checked_mul(std::mem::size_of::<[f32; 3]>())
        .ok_or_else(|| memory_budget_error(usize::MAX, limit))?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(pixel_count)
        .map_err(|_| memory_budget_error(bytes, limit))?;
    pixels.resize(pixel_count, [1.0, 1.0, 1.0]);
    Ok(pixels)
}

fn zeroed_rgb_pixels(pixel_count: usize, limit: usize) -> PpeResult<Vec<[f32; 3]>> {
    let bytes = pixel_count
        .checked_mul(std::mem::size_of::<[f32; 3]>())
        .ok_or_else(|| memory_budget_error(usize::MAX, limit))?;
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(pixel_count)
        .map_err(|_| memory_budget_error(bytes, limit))?;
    pixels.resize(pixel_count, [0.0, 0.0, 0.0]);
    Ok(pixels)
}

fn zeroed_rgb_state(pixel_count: usize, limit: usize) -> PpeResult<Vec<u8>> {
    let bytes = pixel_count;
    let mut state = Vec::new();
    state
        .try_reserve_exact(pixel_count)
        .map_err(|_| memory_budget_error(bytes, limit))?;
    state.resize(pixel_count, RGB_INVALID);
    Ok(state)
}

const RGB_INVALID: u8 = 0;
const RGB_VALID_CLEAN: u8 = 1;
const RGB_VALID_DIRTY: u8 = 2;
const RGB_LOSSY: u8 = 3;

fn rgb_state_is_valid(state: u8) -> bool {
    matches!(state, RGB_VALID_CLEAN | RGB_VALID_DIRTY)
}

fn rgb_state_after_unrepresentable_merge(state: u8) -> u8 {
    match state {
        RGB_VALID_CLEAN | RGB_INVALID => RGB_INVALID,
        RGB_VALID_DIRTY | RGB_LOSSY => RGB_LOSSY,
        _ => RGB_LOSSY,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RgbSurfaceMode {
    OpaqueBackdrop,
    PremultipliedAlpha,
}

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

/// Số mẫu của bảng tra tint → CMYK cho một kẽm mực pha.
///
/// 33 mẫu + nội suy tuyến tính: tint transform trong PDF thực tế là hàm mũ hoặc
/// sampled gần tuyến tính, nên sai số nội suy nằm dưới một bước lượng tử 8 bit.
/// Lấy dày hơn chỉ tốn thêm phép quy đổi ICC mà không đổi pixel nào.
const SPOT_ALT_LUT_STEPS: usize = 33;

/// CMYK tương đương của một kẽm mực pha, lấy mẫu từ tint transform của nó.
///
/// # Vì sao phải giữ cả một bảng thay vì một giá trị ở tint 100%
///
/// Đường **xem** cần biết Pantone 50% ra màu gì. Tint transform không tuyến tính
/// (hàm `FunctionType 2` với `N != 1`, hoặc sampled), nên nhân giá trị ở tint 1.0
/// với 0.5 cho ra màu khác màu thật. Bảng này được lấy mẫu **một lần mỗi kẽm mỗi
/// trang** lúc gặp colorspace, nên chi phí không đáng kể.
#[derive(Debug, Clone)]
pub struct SpotAlternate {
    lut: Vec<[f32; 4]>,
}

impl SpotAlternate {
    /// Dựng từ đúng [`SPOT_ALT_LUT_STEPS`] mẫu, mẫu `i` ứng với tint `i/(n-1)`.
    pub fn from_lut(lut: Vec<[f32; 4]>) -> Option<SpotAlternate> {
        if lut.len() != SPOT_ALT_LUT_STEPS {
            return None;
        }
        Some(SpotAlternate { lut })
    }

    /// Số mẫu mà [`SpotAlternate::from_lut`] đòi hỏi.
    pub const fn lut_steps() -> usize {
        SPOT_ALT_LUT_STEPS
    }

    /// CMYK tương đương ở một mức tint, nội suy tuyến tính giữa hai mẫu.
    pub fn cmyk_at(&self, tint: f32) -> [f32; 4] {
        let t = tint.clamp(0.0, 1.0) * (self.lut.len() - 1) as f32;
        let lo = t.floor() as usize;
        let hi = (lo + 1).min(self.lut.len() - 1);
        let f = t - lo as f32;
        let a = self.lut[lo];
        let b = self.lut[hi];
        let mut out = [0.0f32; 4];
        for ch in 0..4 {
            out[ch] = (a[ch] + (b[ch] - a[ch]) * f).clamp(0.0, 1.0);
        }
        out
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
    /// Chỉ giữ bốn kênh process; mực pha được quy về CMYK qua tint transform.
    ///
    /// # Vì sao là thuộc tính của ink space, không phải của bộ render
    ///
    /// Đây đúng là câu hỏi "không gian mực đích có kênh spot hay không". Đường **đo**
    /// (tách kẽm, TAC) bắt buộc `false`: mất kênh spot là mất kẽm. Đường **xem**
    /// (soft-proof) bắt buộc `true`: màn hình không có mực pha, và một trang chỉ dùng
    /// Pantone sẽ hiện ra trắng nếu spot giữ kênh riêng rồi chỉ đọc bốn kênh process.
    process_only: bool,

    /// Mực pha giữ kênh riêng khi trộn, chỉ gộp về CMYK ở bước **xuất ảnh**.
    ///
    /// # Vì sao đường xem cần chế độ này thay vì `process_only`
    ///
    /// `process_only` quy mực pha về CMYK ngay lúc dựng mực, nên paint mất danh
    /// tính kênh: participation set thành cả bốn kênh process. Hệ quả đo được
    /// (audit 2026-07-27 §A.1): overprint và knockout của một object mực pha cho
    /// kết quả **giống nhau từng pixel**, nên Overprint Preview trả "không có
    /// vùng thay đổi" trên file overprint bằng Pantone — đúng lớp false-negative
    /// mà tính năng này sinh ra để chặn.
    ///
    /// Ở chế độ này thứ tự vẽ và ngữ nghĩa overprint/knockout được tính trong
    /// không gian mực đầy đủ trước, việc mất kênh chỉ xảy ra ở bước cuối khi
    /// buộc phải nói ra ba byte RGB cho màn hình.
    fold_spots_at_output: bool,

    /// CMYK tương đương của từng kênh, song song `colorants`. `None` cho kênh
    /// process và cho kẽm chưa lấy được mẫu.
    alternates: Vec<Option<SpotAlternate>>,
}

impl Default for InkSpace {
    fn default() -> Self {
        Self::new()
    }
}

impl InkSpace {
    pub fn new() -> Self {
        InkSpace {
            colorants: vec![
                Colorant::Cyan,
                Colorant::Magenta,
                Colorant::Yellow,
                Colorant::Black,
            ],
            process_only: false,
            fold_spots_at_output: false,
            alternates: vec![None; 4],
        }
    }

    /// Ink space chỉ có bốn kênh process — mực pha bị quy về CMYK **ngay lúc dựng
    /// mực**. Dùng cho việc quy đổi phụ trợ (lấy mẫu alternate space), KHÔNG dùng
    /// cho đường xem: xem [`InkSpace::preview`].
    pub fn process_only() -> Self {
        InkSpace {
            process_only: true,
            ..InkSpace::new()
        }
    }

    /// Ink space của đường **xem**: mực pha giữ kênh riêng khi trộn, gộp về CMYK ở
    /// bước xuất ảnh. Xem [`InkSpace::fold_spots_at_output`].
    pub fn preview() -> Self {
        InkSpace {
            fold_spots_at_output: true,
            ..InkSpace::new()
        }
    }

    /// `true` nếu mực pha phải được quy về CMYK thay vì cấp kênh riêng.
    pub fn is_process_only(&self) -> bool {
        self.process_only
    }

    /// `true` nếu cần lấy mẫu CMYK tương đương cho mỗi kẽm mực pha gặp phải.
    pub fn wants_spot_alternates(&self) -> bool {
        self.fold_spots_at_output
    }

    /// CMYK tương đương đã lấy mẫu của một kênh, nếu có.
    pub fn spot_alternate(&self, channel: usize) -> Option<&SpotAlternate> {
        self.alternates.get(channel).and_then(|a| a.as_ref())
    }

    /// Ghi CMYK tương đương cho một kênh. Lần ghi đầu tiên thắng: cùng một kẽm có
    /// thể được khai lại bởi một colorspace khác trong cùng trang, và đổi bảng
    /// giữa trang sẽ làm hai vùng cùng mực hiện ra hai màu.
    pub fn set_spot_alternate(&mut self, channel: usize, alternate: SpotAlternate) {
        if channel >= self.colorants.len() {
            return;
        }
        if self.alternates.len() < self.colorants.len() {
            self.alternates.resize(self.colorants.len(), None);
        }
        if self.alternates[channel].is_none() {
            self.alternates[channel] = Some(alternate);
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
            return Err(PpeError::TooManyColorants {
                limit: MAX_COLORANTS,
            });
        }
        self.colorants.push(colorant);
        self.alternates.push(None);
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
    /// `/BM` — blend mode. `Normal` = nguồn phủ lên nền theo alpha.
    pub blend: BlendMode,
    /// Màu DeviceRGB gốc, chỉ có khi renderer giữ được blending surface RGB.
    ///
    /// `ink` vẫn được duy trì song song để các đường CMYK/spot hiện hữu tiếp tục
    /// hoạt động; các pixel RGB hợp lệ sẽ ghi đè bốn kênh process sau ICC ở cuối.
    pub blend_rgb: Option<[f32; 3]>,
}

impl InkPaint {
    /// Màu đục, knockout, phủ đúng các kênh khai báo.
    pub fn opaque(ink: Vec<f32>, declared: ChannelMask) -> Self {
        InkPaint {
            ink,
            declared,
            overprint: false,
            alpha: 1.0,
            blend: BlendMode::Normal,
            blend_rgb: None,
        }
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

#[derive(Debug)]
struct RgbSidecar {
    pixels: Vec<[f32; 3]>,
    /// 0 = CMYK đúng nhưng không suy ngược RGB; 1 = RGB trắng chưa đổi; 2 = RGB
    /// đã vẽ cần đổi ICC; 3 = đã trộn RGB lên một backdrop không còn biểu diễn
    /// chính xác trong RGB.
    state: Vec<u8>,
    mode: RgbSurfaceMode,
}

/// Buffer mực n kênh, lưu theo **mặt phẳng** (plane-major).
///
/// Plane-major (mỗi kênh một mảng liên tục) thay vì interleaved vì:
/// * xuất plate = copy nguyên một mặt phẳng, không phải stride-gather;
/// * trộn mực chạy tuần tự trong một kênh ⇒ thân thiện cache và vector hoá;
/// * thêm spot giữa lúc render chỉ là push thêm một mặt phẳng, không phải dựng
///   lại toàn bộ buffer.
#[derive(Debug)]
pub struct InkBuffer {
    width: u32,
    height: u32,
    space: InkSpace,
    /// `planes[channel][y * width + x]`, giá trị 0.0..=1.0.
    planes: Vec<Vec<f32>>,
    /// Độ phủ tích luỹ (alpha) của **chính buffer này**, 0.0..=1.0.
    ///
    /// Trang giấy không có alpha — nó luôn đục. Mặt phẳng này chỉ có nghĩa khi
    /// buffer đóng vai **transparency group** hoặc **soft mask**: lúc đó cần biết
    /// pixel nào đã được nội dung group chạm tới để (a) tính `/SMask /S /Alpha`,
    /// và (b) un-premultiply khi composite group isolated lên nền.
    ///
    /// Giữ luôn cho mọi buffer thay vì chỉ cho group: chi phí là một mặt phẳng
    /// f32, còn cái lợi là mọi đường vẽ (vector, ảnh, shading, chữ) cập nhật alpha
    /// ở đúng một chỗ — không có nhánh nào quên.
    alpha: Vec<f32>,
    /// Mọi buffer con của cùng một lần render chia sẻ ngân sách này.
    budget: Arc<MemoryBudget>,
    /// Số byte riêng buffer này đã đặt chỗ; trả lại khi buffer bị drop.
    reserved_bytes: usize,
    /// Bề mặt RGB được cấp phát lười khi gặp DeviceRGB có ICC.
    rgb_sidecar: Option<RgbSidecar>,
    /// Chỉ buffer trang gốc được phép giữ RGB. Buffer group vẫn dùng blending
    /// space riêng hiện hữu và bị guard nếu khai RGB/Lab chưa hỗ trợ.
    rgb_sidecar_allowed: bool,
    /// Kiểu surface RGB của buffer: nền opaque trang hay alpha premultiplied cho group.
    rgb_surface_mode: RgbSurfaceMode,
    /// Scratch cho `composite_region_tac_guard` — tránh cấp phát mỗi vành.
    ring_filter_scratch: Vec<f32>,
}

impl InkBuffer {
    /// Buffer trắng (0% mực trên mọi kênh) — tương đương giấy trắng.
    pub fn new(width: u32, height: u32, space: InkSpace) -> PpeResult<Self> {
        Self::new_with_memory_budget(width, height, space, DEFAULT_RENDER_MEMORY_BUDGET_BYTES)
    }

    /// Như [`InkBuffer::new`] nhưng dùng ngân sách do caller đặt.
    pub fn new_with_memory_budget(
        width: u32,
        height: u32,
        space: InkSpace,
        memory_budget_bytes: usize,
    ) -> PpeResult<Self> {
        if width == 0 || height == 0 {
            return Err(PpeError::BadRasterSize {
                w: width as i64,
                h: height as i64,
                dpi: 0.0,
            });
        }
        let px = (width as usize)
            .checked_mul(height as usize)
            .ok_or(PpeError::BadRasterSize {
                w: width as i64,
                h: height as i64,
                dpi: 0.0,
            })?;
        let reserved_bytes = buffer_bytes(px, space.len() + 1)?;
        let budget = Arc::new(MemoryBudget::new(memory_budget_bytes));
        budget.reserve(reserved_bytes)?;

        let allocation = (|| -> PpeResult<(Vec<Vec<f32>>, Vec<f32>)> {
            let mut planes = Vec::with_capacity(space.len());
            for _ in 0..space.len() {
                planes.push(zeroed_plane(px, memory_budget_bytes)?);
            }
            Ok((planes, zeroed_plane(px, memory_budget_bytes)?))
        })();
        let (planes, alpha) = match allocation {
            Ok(buffers) => buffers,
            Err(err) => {
                budget.release(reserved_bytes);
                return Err(err);
            }
        };

        Ok(InkBuffer {
            width,
            height,
            rgb_surface_mode: RgbSurfaceMode::OpaqueBackdrop,
            space,
            planes,
            alpha,
            budget,
            reserved_bytes,
            rgb_sidecar: None,
            rgb_sidecar_allowed: true,
            ring_filter_scratch: Vec::new(),
        })
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

    /// Cấp phát lười bề mặt RGB cho buffer trang gốc.
    ///
    /// Pixel chưa từng được vẽ bắt đầu là giấy trắng RGB hợp lệ. Pixel đã có nội
    /// dung trước khi sidecar xuất hiện được giữ ở trạng thái CMYK đúng nhưng
    /// không thể suy ngược RGB.
    pub(crate) fn ensure_rgb_sidecar(&mut self) -> PpeResult<bool> {
        if !self.rgb_sidecar_allowed {
            return Ok(false);
        }
        if self.rgb_sidecar.is_some() {
            return Ok(true);
        }
        let px = self.alpha.len();
        let bytes = rgb_sidecar_bytes(px)?;
        self.budget.reserve(bytes)?;
        let allocation = (|| -> PpeResult<RgbSidecar> {
            let pixels = match self.rgb_surface_mode {
                RgbSurfaceMode::OpaqueBackdrop => white_rgb_pixels(px, self.budget.limit)?,
                RgbSurfaceMode::PremultipliedAlpha => zeroed_rgb_pixels(px, self.budget.limit)?,
            };
            let mut state = zeroed_rgb_state(px, self.budget.limit)?;
            for (s, a) in state.iter_mut().zip(self.alpha.iter()) {
                if *a <= 0.0 {
                    *s = RGB_VALID_CLEAN;
                }
            }
            Ok(RgbSidecar {
                pixels,
                state,
                mode: self.rgb_surface_mode,
            })
        })();
        match allocation {
            Ok(sidecar) => {
                self.rgb_sidecar = Some(sidecar);
                self.reserved_bytes += bytes;
                Ok(true)
            }
            Err(err) => {
                self.budget.release(bytes);
                Err(err)
            }
        }
    }

    pub(crate) fn set_rgb_sidecar_allowed(&mut self, allowed: bool) {
        if !allowed {
            self.rgb_sidecar_allowed = false;
        }
    }

    pub(crate) fn has_rgb_sidecar(&self) -> bool {
        self.rgb_sidecar.is_some()
    }

    /// Đổi các pixel còn biểu diễn chính xác trong RGB sang bốn kênh process một
    /// lần duy nhất, sau khi toàn bộ alpha/blend RGB đã hoàn tất.
    ///
    /// Trả `false` nếu có pixel từng phải trộn RGB lên một backdrop chỉ còn CMYK.
    pub(crate) fn finalize_rgb(&mut self, cm: &ColorManager) -> bool {
        let Some(sidecar) = self.rgb_sidecar.as_mut() else {
            return true;
        };
        if self.planes.len() < 4 {
            return false;
        }
        for i in 0..sidecar.state.len() {
            if sidecar.state[i] != RGB_VALID_DIRTY {
                continue;
            }
            let rgb = sidecar.pixels[i];
            let Some(cmyk) = cm.rgb_to_cmyk(rgb[0], rgb[1], rgb[2]) else {
                sidecar.state[i] = RGB_LOSSY;
                continue;
            };
            let alpha = if sidecar.mode == RgbSurfaceMode::PremultipliedAlpha {
                self.alpha[i].clamp(0.0, 1.0)
            } else {
                1.0
            };
            for ch in 0..4 {
                self.planes[ch][i] = cmyk[ch] * alpha;
            }
            sidecar.state[i] = RGB_VALID_CLEAN;
        }
        !sidecar.state.iter().any(|s| *s == RGB_LOSSY)
    }

    /// Đồng bộ số mặt phẳng với [`InkSpace`] sau khi spot mới được đăng ký giữa
    /// lúc render. Mặt phẳng mới bắt đầu từ 0% mực.
    pub fn sync_channels(&mut self) -> PpeResult<()> {
        let px = (self.width as usize) * (self.height as usize);
        let plane_bytes = buffer_bytes(px, 1)?;
        while self.planes.len() < self.space.len() {
            self.budget.reserve(plane_bytes)?;
            match zeroed_plane(px, self.budget.limit) {
                Ok(plane) => {
                    self.planes.push(plane);
                    self.reserved_bytes += plane_bytes;
                }
                Err(err) => {
                    self.budget.release(plane_bytes);
                    return Err(err);
                }
            }
        }
        Ok(())
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
    /// # Blend mode
    ///
    /// Với `/BM` khác `Normal`, mực nguồn được trộn với mực nền **trước** khi phủ:
    /// `dst = dst*(1−a) + blend(dst, src)*a`. Xem [`crate::blend`] về việc công
    /// thức của spec phải áp trên phần bù vì ink space là không gian trừ.
    ///
    /// Knockout vẫn hoạt động đúng qua blend: kênh không khai báo có `src = 0` (=
    /// giấy trắng), và `Multiply` với giấy trắng cho ra chính nền — nên một chữ đen
    /// K-only `BM /Multiply` không khoét nền, đúng như trong Acrobat.
    pub fn composite(&mut self, coverage: &[f32], paint: &InkPaint) -> PpeResult<()> {
        let region = Region::full(self.width, self.height);
        self.composite_region(coverage, region, paint)
    }

    /// Như [`InkBuffer::composite`] nhưng chỉ trộn trong `region`.
    ///
    /// `coverage` vẫn đánh chỉ số theo cả trang; ngoài `region` nó phải bằng 0. Xem
    /// [`Region`] về việc vì sao mọi thao tác vẽ mang theo vùng bao.
    /// Composite một vùng như `composite_region`, nhưng **bỏ qua** pixel mà kết
    /// quả sẽ có tổng mực (TAC) thấp hơn hiện trạng.
    ///
    /// Dùng RIÊNG cho vành fill-adjust: vành là dải bất định do khác biệt
    /// scan-convert với RIP tham chiếu. Nếu để nó composite thường, một vành
    /// của hình nhạt vẽ SAU có thể quét đúng vào pixel đỉnh TAC do các hình
    /// trước tạo ra và hạ đỉnh (đo được −8.9 điểm TAC trên corpus) — chiều sai
    /// nguy hiểm. Chặn theo hướng: vành chỉ được phép GIỮ hoặc TĂNG tổng mực
    /// của pixel; phần giảm là việc của chính hình gốc (ruột fill), không phải
    /// của dải bất định.
    pub fn composite_region_tac_guard(
        &mut self,
        coverage: &[f32],
        region: Region,
        paint: &InkPaint,
    ) -> PpeResult<()> {
        debug_assert_eq!(
            coverage.len(),
            (self.width as usize) * (self.height as usize)
        );
        self.sync_channels()?;
        let region = region.clamped(self.width, self.height);
        if region.is_empty() {
            return Ok(());
        }
        // TAC của paint (alpha 1, phủ kín): cận trên của phần mực vành thêm vào.
        let paint_tac: f32 = paint.ink.iter().map(|v| v.clamp(0.0, 1.0)).sum();
        // Vành được phép hạ TAC một khoảng NHỎ (khớp hành vi nở fill của RIP
        // tham chiếu ở các đường ghép màu sát nhau), nhưng không được quét sập
        // một đỉnh: hạ quá ngưỡng này là việc của ruột fill, không phải của dải
        // bất định 0.16 px. 0.10 = 10 điểm TAC.
        const RING_MAX_TAC_DROP: f32 = 0.25;
        let w = self.width as usize;
        let n = self.planes.len();
        // Tái dùng buffer giữa các lần gọi: vành chạy cho TỪNG fill của trang,
        // cấp phát cả trang mỗi lần sẽ thành chi phí chính của trang nhiều chữ.
        let mut filtered = std::mem::take(&mut self.ring_filter_scratch);
        filtered.clear();
        filtered.resize(coverage.len(), 0.0);
        let mut any = false;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                let c = coverage[i];
                if c <= 0.0 {
                    continue;
                }
                let mut current = 0.0f32;
                for ch in 0..n {
                    current += self.planes[ch][i];
                }
                // `>=` với sai số: bằng nhau vẫn cho qua để vành trên nền cùng
                // màu hoạt động như fill thường.
                if paint_tac + RING_MAX_TAC_DROP + 1e-4 >= current {
                    filtered[i] = c;
                    any = true;
                }
            }
        }
        if !any {
            self.ring_filter_scratch = filtered;
            return Ok(());
        }
        let result = self.composite_region(&filtered, region, paint);
        self.ring_filter_scratch = filtered;
        result
    }

    pub fn composite_region(
        &mut self,
        coverage: &[f32],
        region: Region,
        paint: &InkPaint,
    ) -> PpeResult<()> {
        debug_assert_eq!(
            coverage.len(),
            (self.width as usize) * (self.height as usize)
        );
        self.sync_channels()?;
        let region = region.clamped(self.width, self.height);
        if region.is_empty() {
            return Ok(());
        }

        self.composite_rgb_region(coverage, region, paint);

        let first_spot = if paint.blend.is_separable() { 0 } else { 4 };
        if first_spot > 0 {
            self.composite_nonseparable(coverage, region, paint);
        }

        let w = self.width as usize;
        let n = self.planes.len();
        for ch in first_spot..n {
            let declared = paint.declared.contains(ch);
            if !declared && paint.overprint {
                continue; // giữ nguyên nền — bản chất của overprint
            }
            let src = if declared {
                paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0)
            } else {
                0.0 // knockout về giấy trắng
            };
            // Kênh spot dưới mode không tách kênh: dùng `Normal`. Đoán một công
            // thức cho mực pha sẽ làm sai chính cái kẽm dùng để chốt bản.
            let mode = if first_spot > 0 {
                BlendMode::Normal
            } else {
                paint.blend
            };
            let plane = &mut self.planes[ch];
            for y in region.y0..region.y1 {
                let row = y as usize * w;
                for x in region.x0..region.x1 {
                    let i = row + x as usize;
                    let cov = coverage[i];
                    if cov <= 0.0 {
                        continue;
                    }
                    let a = (cov * paint.alpha).clamp(0.0, 1.0);
                    let dst = plane[i];
                    plane[i] = dst * (1.0 - a) + mode.blend_ink(dst, src) * a;
                }
            }
        }

        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                let cov = coverage[i];
                if cov <= 0.0 {
                    continue;
                }
                let a = (cov * paint.alpha).clamp(0.0, 1.0);
                self.alpha[i] = self.alpha[i] * (1.0 - a) + a;
            }
        }
        Ok(())
    }

    fn composite_rgb_region(&mut self, coverage: &[f32], region: Region, paint: &InkPaint) {
        if self.rgb_sidecar.is_none() {
            return;
        }
        let w = self.width as usize;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                self.composite_rgb_at(i, coverage[i], paint);
            }
        }
    }

    fn composite_rgb_at(&mut self, index: usize, coverage: f32, paint: &InkPaint) {
        let dst_alpha = self.alpha.get(index).copied().unwrap_or(0.0);
        if matches!(
            self.rgb_sidecar.as_ref().map(|sidecar| sidecar.mode),
            Some(RgbSurfaceMode::PremultipliedAlpha)
        ) {
            self.composite_rgb_premultiplied_at(index, coverage, paint, dst_alpha);
            return;
        }

        let Some(sidecar) = self.rgb_sidecar.as_mut() else {
            return;
        };
        if index >= sidecar.state.len() || coverage <= 0.0 {
            return;
        }
        let a = (coverage * paint.alpha).clamp(0.0, 1.0);
        if a <= 0.0 {
            return;
        }

        if let Some(source) = paint.blend_rgb {
            match sidecar.state[index] {
                RGB_VALID_CLEAN | RGB_VALID_DIRTY => {
                    let backdrop = sidecar.pixels[index];
                    let blended = paint.blend.blend_rgb(backdrop, source);
                    sidecar.pixels[index] = [
                        backdrop[0] * (1.0 - a) + blended[0] * a,
                        backdrop[1] * (1.0 - a) + blended[1] * a,
                        backdrop[2] * (1.0 - a) + blended[2] * a,
                    ];
                    sidecar.state[index] = RGB_VALID_DIRTY;
                }
                RGB_INVALID | RGB_LOSSY => {
                    if a >= 1.0 - 1e-6 && paint.blend.is_normal() {
                        sidecar.pixels[index] = source.map(|v| v.clamp(0.0, 1.0));
                        sidecar.state[index] = RGB_VALID_DIRTY;
                    } else {
                        sidecar.state[index] = RGB_LOSSY;
                    }
                }
                _ => sidecar.state[index] = RGB_LOSSY,
            }
            return;
        }

        // Spot overprint không chạm bốn kênh process nên không phá sidecar RGB.
        let affects_process = !paint.overprint || (0..4).any(|ch| paint.declared.contains(ch));
        if !affects_process {
            return;
        }
        let full_process_replacement = a >= 1.0 - 1e-6
            && paint.blend.is_normal()
            && (!paint.overprint || (0..4).all(|ch| paint.declared.contains(ch)));
        sidecar.state[index] = match sidecar.state[index] {
            RGB_VALID_CLEAN | RGB_INVALID => RGB_INVALID,
            RGB_VALID_DIRTY | RGB_LOSSY if full_process_replacement => RGB_INVALID,
            RGB_VALID_DIRTY | RGB_LOSSY => RGB_LOSSY,
            _ => RGB_LOSSY,
        };
    }
    fn composite_rgb_premultiplied_at(
        &mut self,
        index: usize,
        coverage: f32,
        paint: &InkPaint,
        dst_alpha: f32,
    ) {
        let Some(sidecar) = self.rgb_sidecar.as_mut() else {
            return;
        };
        if index >= sidecar.state.len() || coverage <= 0.0 {
            return;
        }
        let a = (coverage * paint.alpha).clamp(0.0, 1.0);
        if a <= 0.0 {
            return;
        }

        let Some(source) = paint.blend_rgb else {
            let affects_process = !paint.overprint || (0..4).any(|ch| paint.declared.contains(ch));
            if affects_process {
                sidecar.state[index] = RGB_LOSSY;
            }
            return;
        };

        match sidecar.state[index] {
            RGB_VALID_CLEAN | RGB_VALID_DIRTY => {
                let backdrop = sidecar.pixels[index];
                let out_alpha = (dst_alpha * (1.0 - a) + a).clamp(0.0, 1.0);
                let blended = if dst_alpha <= 1e-6 {
                    source
                } else {
                    paint.blend.blend_rgb(backdrop, source)
                };
                let premul = [
                    backdrop[0] * dst_alpha * (1.0 - a) + blended[0] * a,
                    backdrop[1] * dst_alpha * (1.0 - a) + blended[1] * a,
                    backdrop[2] * dst_alpha * (1.0 - a) + blended[2] * a,
                ];
                sidecar.pixels[index] = if out_alpha > 1e-6 {
                    [
                        premul[0] / out_alpha,
                        premul[1] / out_alpha,
                        premul[2] / out_alpha,
                    ]
                } else {
                    source
                };
                sidecar.state[index] = RGB_VALID_DIRTY;
            }
            RGB_INVALID | RGB_LOSSY => {
                if dst_alpha <= 1e-6 || (a >= 1.0 - 1e-6 && paint.blend.is_normal()) {
                    sidecar.pixels[index] = source.map(|v| v.clamp(0.0, 1.0));
                    sidecar.state[index] = RGB_VALID_DIRTY;
                } else {
                    sidecar.state[index] = RGB_LOSSY;
                }
            }
            _ => sidecar.state[index] = RGB_LOSSY,
        }
    }

    fn note_group_merge_for_rgb(&mut self, index: usize) {
        let Some(sidecar) = self.rgb_sidecar.as_mut() else {
            return;
        };
        if index >= sidecar.state.len() {
            return;
        }
        sidecar.state[index] = rgb_state_after_unrepresentable_merge(sidecar.state[index]);
    }

    /// Bốn kênh process dưới mode **không** tách kênh (Hue/Saturation/Color/
    /// Luminosity): phải xử lý cả bộ cùng lúc nên duyệt theo pixel.
    fn composite_nonseparable(&mut self, coverage: &[f32], region: Region, paint: &InkPaint) {
        let mut src4 = [0.0f32; 4];
        for ch in 0..4 {
            if paint.declared.contains(ch) {
                src4[ch] = paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0);
            }
        }
        let keep: [bool; 4] = [
            paint.declared.contains(0) || !paint.overprint,
            paint.declared.contains(1) || !paint.overprint,
            paint.declared.contains(2) || !paint.overprint,
            paint.declared.contains(3) || !paint.overprint,
        ];
        let w = self.width as usize;
        for y in region.y0..region.y1 {
            let row = y as usize * w;
            for x in region.x0..region.x1 {
                let i = row + x as usize;
                let cov = coverage[i];
                if cov <= 0.0 {
                    continue;
                }
                let a = (cov * paint.alpha).clamp(0.0, 1.0);
                let bd = [
                    self.planes[0][i],
                    self.planes[1][i],
                    self.planes[2][i],
                    self.planes[3][i],
                ];
                let blended = blend_nonseparable_cmyk(paint.blend, bd, src4);
                for ch in 0..4 {
                    if keep[ch] {
                        self.planes[ch][i] = bd[ch] * (1.0 - a) + blended[ch] * a;
                    }
                }
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
        if coverage <= 0.0 || index >= self.alpha.len() {
            return;
        }
        let a = (coverage * paint.alpha).clamp(0.0, 1.0);
        self.composite_rgb_at(index, coverage, paint);
        let first_spot = if paint.blend.is_separable() { 0 } else { 4 };
        if first_spot > 0 {
            let mut src4 = [0.0f32; 4];
            for ch in 0..4 {
                if paint.declared.contains(ch) {
                    src4[ch] = paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0);
                }
            }
            let bd = [
                self.planes[0][index],
                self.planes[1][index],
                self.planes[2][index],
                self.planes[3][index],
            ];
            let blended = blend_nonseparable_cmyk(paint.blend, bd, src4);
            for ch in 0..4 {
                if paint.declared.contains(ch) || !paint.overprint {
                    self.planes[ch][index] = bd[ch] * (1.0 - a) + blended[ch] * a;
                }
            }
        }
        for ch in first_spot..self.planes.len() {
            let declared = paint.declared.contains(ch);
            if !declared && paint.overprint {
                continue;
            }
            let src = if declared {
                paint.ink.get(ch).copied().unwrap_or(0.0).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mode = if first_spot > 0 {
                BlendMode::Normal
            } else {
                paint.blend
            };
            if let Some(dst) = self.planes[ch].get_mut(index) {
                let blended = mode.blend_ink(*dst, src);
                *dst = *dst * (1.0 - a) + blended * a;
            }
        }
        let da = &mut self.alpha[index];
        *da = *da * (1.0 - a) + a;
    }

    /// Độ phủ tích luỹ theo từng pixel — xem [`InkBuffer::alpha`].
    pub fn alpha_plane(&self) -> &[f32] {
        &self.alpha
    }

    /// Buffer con cho **transparency group không cách ly** (non-isolated).
    ///
    /// Sao chép nguyên mực nền, đặt alpha về 0. Nội dung group vì thế nhìn thấy
    /// đúng nền thật, nên overprint và blend bên trong group cho ra kết quả đúng —
    /// điều mà group cách ly (nền trắng) không làm được: một chữ đen overprint
    /// trong group cách ly sẽ mất hết nền màu.
    pub fn child_non_isolated(&self) -> PpeResult<InkBuffer> {
        self.child_buffer(true, None)
    }
    /// Surface RGB cho group không cách ly: sao chép cả backdrop mực lẫn RGB.
    /// Chỉ hợp lệ khi parent là surface opaque (trang hoặc group non-isolated).
    pub(crate) fn child_non_isolated_rgb(&self) -> PpeResult<InkBuffer> {
        let mut child = self.child_buffer(true, Some(RgbSurfaceMode::OpaqueBackdrop))?;
        let Some(parent) = self.rgb_sidecar.as_ref() else {
            child.rgb_sidecar_allowed = false;
            return Ok(child);
        };
        if parent.mode != RgbSurfaceMode::OpaqueBackdrop {
            child.rgb_sidecar_allowed = false;
            return Ok(child);
        }

        let px = self.alpha.len();
        let bytes = rgb_sidecar_bytes(px)?;
        self.budget.reserve(bytes)?;
        let allocation = (|| -> PpeResult<RgbSidecar> {
            let mut pixels = zeroed_rgb_pixels(px, self.budget.limit)?;
            pixels.copy_from_slice(&parent.pixels);
            let mut state = zeroed_rgb_state(px, self.budget.limit)?;
            state.copy_from_slice(&parent.state);
            Ok(RgbSidecar {
                pixels,
                state,
                mode: RgbSurfaceMode::OpaqueBackdrop,
            })
        })();
        match allocation {
            Ok(sidecar) => {
                child.rgb_sidecar = Some(sidecar);
                child.reserved_bytes += bytes;
                Ok(child)
            }
            Err(err) => {
                self.budget.release(bytes);
                Err(err)
            }
        }
    }

    /// Buffer con cho **transparency group cách ly** (isolated): nền trắng, alpha 0.
    pub fn child_isolated(&self) -> PpeResult<InkBuffer> {
        self.child_buffer(false, None)
    }

    /// Surface RGB có alpha riêng cho transparency group cách ly khai `/CS /DeviceRGB`.
    pub(crate) fn child_isolated_rgb(&self) -> PpeResult<InkBuffer> {
        self.child_buffer(false, Some(RgbSurfaceMode::PremultipliedAlpha))
    }

    fn child_buffer(
        &self,
        copy_planes: bool,
        rgb_surface_mode: Option<RgbSurfaceMode>,
    ) -> PpeResult<InkBuffer> {
        let px = self.alpha.len();
        let reserved_bytes = buffer_bytes(px, self.space.len() + 1)?;
        self.budget.reserve(reserved_bytes)?;

        let allocation = (|| -> PpeResult<(Vec<Vec<f32>>, Vec<f32>)> {
            let mut planes = Vec::with_capacity(self.space.len());
            for source in &self.planes {
                let mut plane = zeroed_plane(px, self.budget.limit)?;
                if copy_planes {
                    plane.copy_from_slice(source);
                }
                planes.push(plane);
            }
            Ok((planes, zeroed_plane(px, self.budget.limit)?))
        })();
        let (planes, alpha) = match allocation {
            Ok(buffers) => buffers,
            Err(err) => {
                self.budget.release(reserved_bytes);
                return Err(err);
            }
        };

        Ok(InkBuffer {
            width: self.width,
            height: self.height,
            rgb_surface_mode: rgb_surface_mode.unwrap_or(RgbSurfaceMode::OpaqueBackdrop),
            space: self.space.clone(),
            planes,
            alpha,
            budget: Arc::clone(&self.budget),
            reserved_bytes,
            rgb_sidecar: None,
            rgb_sidecar_allowed: rgb_surface_mode.is_some(),
            ring_filter_scratch: Vec::new(),
        })
    }

    /// Tổng byte của mọi buffer đang sống trong cùng lần render.
    pub fn memory_used_bytes(&self) -> usize {
        self.budget.used.load(Ordering::Relaxed)
    }

    /// Trần byte của lần render, phục vụ chẩn đoán ở binding.
    pub fn memory_limit_bytes(&self) -> usize {
        self.budget.limit
    }

    /// Hợp các colorant mà buffer con đăng ký thêm về buffer cha.
    ///
    /// Buffer con khởi tạo từ [`InkSpace`] của cha nên chỉ có thể **thêm** vào
    /// cuối; vì vậy chỉ số kênh của con và của cha trùng nhau sau khi hợp. Bỏ bước
    /// này thì một spot chỉ xuất hiện bên trong group sẽ mất kẽm.
    pub fn adopt_channels_from(&mut self, child: &InkBuffer) -> PpeResult<()> {
        for colorant in child.space.colorants().iter().skip(self.space.len()) {
            self.space.register(colorant.clone())?;
        }
        // Bảng CMYK tương đương phải đi cùng kẽm: một Pantone chỉ xuất hiện bên
        // trong group mà không mang theo bảng sẽ hiện ra đen ở bước xuất ảnh.
        for ch in 0..self.space.len() {
            if let Some(alt) = child.space.spot_alternate(ch) {
                self.space.set_spot_alternate(ch, alt.clone());
            }
        }
        self.sync_channels()?;
        Ok(())
    }

    /// Hoà kết quả group **không cách ly** vào buffer này.
    ///
    /// `factor[i]` = alpha hằng của group × soft mask tại pixel `i`.
    ///
    /// # Group `/BM /Normal`
    ///
    /// Buffer con đã chứa `nền*(1−ga) + ga*màu_group` (vì nó khởi tạo từ nền).
    /// Thay vào công thức composite của spec `C = nền*(1−ca·ga) + ca·ga·C_group`
    /// thì `ga` triệt tiêu, còn lại đúng `C = nền*(1−ca) + ca·con`. Nên đường này
    /// **chính xác** với group alpha hằng / soft mask, không phải xấp xỉ.
    ///
    /// # Group `/BM` khác `/Normal`
    ///
    /// Không được đổi group sang isolated: nội dung bên trong group không cách ly
    /// phải nhìn thấy nền thật (đặc biệt với overprint và blend nội bộ). Thay vào
    /// đó khôi phục màu nguồn của group từ kết quả composite:
    ///
    /// `C_group = (C_child − C_backdrop·(1−ga)) / ga`
    ///
    /// rồi mới áp blend mode của **cả group** lên backdrop. Đây là bước "backdrop
    /// removal" của mô hình transparency; bỏ nó là lý do trước đây PPE phải hạ
    /// `ink_unsound` cho tổ hợp này.
    fn merge_non_isolated_rgb_at(
        &mut self,
        child: &InkBuffer,
        index: usize,
        group_alpha: f32,
        factor: f32,
        blend: BlendMode,
    ) -> bool {
        let Some(parent) = self.rgb_sidecar.as_mut() else {
            return false;
        };
        if index >= parent.state.len() {
            return false;
        }

        let parent_state = parent.state[index];
        let Some(child_rgb) = child.rgb_sidecar.as_ref() else {
            parent.state[index] = rgb_state_after_unrepresentable_merge(parent_state);
            return true;
        };
        if index >= child_rgb.state.len() || child_rgb.mode != RgbSurfaceMode::OpaqueBackdrop {
            parent.state[index] = rgb_state_after_unrepresentable_merge(parent_state);
            return true;
        }

        let child_state = child_rgb.state[index];
        if !rgb_state_is_valid(child_state) {
            parent.state[index] = rgb_state_after_unrepresentable_merge(parent_state);
            return true;
        }
        let child_color = child_rgb.pixels[index];

        if !rgb_state_is_valid(parent_state) {
            if blend.is_normal() && factor >= 1.0 - 1e-6 {
                parent.pixels[index] = child_color;
                parent.state[index] = RGB_VALID_DIRTY;
            } else {
                parent.state[index] = rgb_state_after_unrepresentable_merge(parent_state);
            }
            return true;
        }

        let backdrop = parent.pixels[index];
        let output = if blend.is_normal() {
            [
                backdrop[0] * (1.0 - factor) + child_color[0] * factor,
                backdrop[1] * (1.0 - factor) + child_color[1] * factor,
                backdrop[2] * (1.0 - factor) + child_color[2] * factor,
            ]
        } else {
            let ga = group_alpha.clamp(1e-6, 1.0);
            let alpha = (ga * factor).clamp(0.0, 1.0);
            let source = [
                non_isolated_group_source(backdrop[0], child_color[0], ga),
                non_isolated_group_source(backdrop[1], child_color[1], ga),
                non_isolated_group_source(backdrop[2], child_color[2], ga),
            ];
            let blended = blend.blend_rgb(backdrop, source);
            [
                backdrop[0] * (1.0 - alpha) + blended[0] * alpha,
                backdrop[1] * (1.0 - alpha) + blended[1] * alpha,
                backdrop[2] * (1.0 - alpha) + blended[2] * alpha,
            ]
        };
        parent.pixels[index] = output.map(|value| value.clamp(0.0, 1.0));
        parent.state[index] = RGB_VALID_DIRTY;
        true
    }

    pub fn merge_non_isolated(
        &mut self,
        child: &InkBuffer,
        factor: &[f32],
        blend: BlendMode,
        overprint: bool,
    ) {
        let n = self.planes.len().min(child.planes.len());
        let separable = blend.is_separable();
        for i in 0..self.alpha.len() {
            let ga = child.alpha.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
            let f = factor.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
            if f <= 0.0 || ga <= 0.0 {
                continue;
            }

            if blend.is_normal() {
                // Dạng rút gọn chính xác; tránh phép chia khi không cần blend.
                for ch in 0..n {
                    let dst = self.planes[ch][i];
                    self.planes[ch][i] = dst * (1.0 - f) + child.planes[ch][i] * f;
                }
            } else {
                let a = (ga * f).clamp(0.0, 1.0);
                if !separable && n >= 4 {
                    let bd = [
                        self.planes[0][i],
                        self.planes[1][i],
                        self.planes[2][i],
                        self.planes[3][i],
                    ];
                    let src = [
                        non_isolated_group_source(bd[0], child.planes[0][i], ga),
                        non_isolated_group_source(bd[1], child.planes[1][i], ga),
                        non_isolated_group_source(bd[2], child.planes[2][i], ga),
                        non_isolated_group_source(bd[3], child.planes[3][i], ga),
                    ];
                    let blended = blend_nonseparable_cmyk(blend, bd, src);
                    for ch in 0..4 {
                        self.planes[ch][i] = bd[ch] * (1.0 - a) + blended[ch] * a;
                    }
                }

                let start = if separable { 0 } else { 4.min(n) };
                for ch in start..n {
                    let dst = self.planes[ch][i];
                    let src = non_isolated_group_source(dst, child.planes[ch][i], ga);
                    if overprint && src <= 0.0 {
                        continue;
                    }
                    let mode = if separable { blend } else { BlendMode::Normal };
                    self.planes[ch][i] = dst * (1.0 - a) + mode.blend_ink(dst, src) * a;
                }
            }

            let a = (ga * f).clamp(0.0, 1.0);
            let dst = &mut self.alpha[i];
            *dst = *dst * (1.0 - a) + a;
            if !self.merge_non_isolated_rgb_at(child, i, ga, f, blend) {
                self.note_group_merge_for_rgb(i);
            }
        }
    }

    /// Hoà kết quả group **cách ly** vào buffer này, có blend mode ở mức group.
    ///
    /// Mực trong buffer con là dạng đã nhân alpha (`ink = ga · màu`), nên phải chia
    /// lại `ga` để lấy màu thật của group trước khi blend với nền. Bỏ bước chia sẽ
    /// làm mọi vùng nửa trong suốt nhạt đi hai lần.
    pub fn merge_isolated(
        &mut self,
        child: &InkBuffer,
        factor: &[f32],
        blend: BlendMode,
        overprint: bool,
    ) {
        let n = self.planes.len().min(child.planes.len());
        let separable = blend.is_separable();
        for i in 0..self.alpha.len() {
            let ga = child.alpha.get(i).copied().unwrap_or(0.0);
            if ga <= 0.0 {
                continue;
            }
            let f = factor.get(i).copied().unwrap_or(0.0).clamp(0.0, 1.0);
            if f <= 0.0 {
                continue;
            }
            let a = (ga * f).clamp(0.0, 1.0);
            if !separable && n >= 4 {
                let bd = [
                    self.planes[0][i],
                    self.planes[1][i],
                    self.planes[2][i],
                    self.planes[3][i],
                ];
                let src = [
                    (child.planes[0][i] / ga).clamp(0.0, 1.0),
                    (child.planes[1][i] / ga).clamp(0.0, 1.0),
                    (child.planes[2][i] / ga).clamp(0.0, 1.0),
                    (child.planes[3][i] / ga).clamp(0.0, 1.0),
                ];
                let blended = blend_nonseparable_cmyk(blend, bd, src);
                for ch in 0..4 {
                    self.planes[ch][i] = bd[ch] * (1.0 - a) + blended[ch] * a;
                }
            }
            let start = if separable { 0 } else { 4.min(n) };
            for ch in start..n {
                let src = (child.planes[ch][i] / ga).clamp(0.0, 1.0);
                if overprint && src <= 0.0 {
                    // Group overprint: kênh group không dùng thì giữ nguyên nền.
                    continue;
                }
                let dst = self.planes[ch][i];
                let mode = if separable { blend } else { BlendMode::Normal };
                self.planes[ch][i] = dst * (1.0 - a) + mode.blend_ink(dst, src) * a;
            }
            let da = &mut self.alpha[i];
            *da = *da * (1.0 - a) + a;
            self.note_group_merge_for_rgb(i);
        }
    }

    /// Độ sáng (luminosity) từng pixel, dùng cho `/SMask /S /Luminosity`.
    ///
    /// Quy CMYK về RGB xấp xỉ rồi lấy `0.3R + 0.59G + 0.11B` (§11.5.2). Kênh spot
    /// **không** tham gia: soft mask luminosity của một group chỉ định nghĩa trên
    /// không gian màu của group, và group không bao giờ khai spot làm nền mask.
    /// Độ sáng trực tiếp từ RGB sidecar, trước khi RGB được đổi qua ICC sang CMYK.
    ///
    /// Chỉ trả kết quả khi mọi pixel còn biểu diễn chính xác trong RGB. Nếu một paint
    /// CMYK/spot đã làm surface mất tính đảo ngược, caller phải quay về đường CMYK.
    pub(crate) fn rgb_luminosity_plane(&self) -> Option<Vec<f32>> {
        let sidecar = self.rgb_sidecar.as_ref()?;
        let mut out = Vec::with_capacity(sidecar.pixels.len());
        for (rgb, state) in sidecar.pixels.iter().zip(sidecar.state.iter()) {
            if !rgb_state_is_valid(*state) {
                return None;
            }
            out.push((0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2]).clamp(0.0, 1.0));
        }
        Some(out)
    }

    pub fn luminosity_plane(&self) -> Vec<f32> {
        let px = self.alpha.len();
        let mut out = vec![0.0f32; px];
        for i in 0..px {
            let k = self.planes[3][i].clamp(0.0, 1.0);
            let r = (1.0 - self.planes[0][i].clamp(0.0, 1.0)) * (1.0 - k);
            let g = (1.0 - self.planes[1][i].clamp(0.0, 1.0)) * (1.0 - k);
            let b = (1.0 - self.planes[2][i].clamp(0.0, 1.0)) * (1.0 - k);
            out[i] = (0.3 * r + 0.59 * g + 0.11 * b).clamp(0.0, 1.0);
        }
        out
    }

    /// Tổng mực (TAC) theo phần trăm tại từng pixel.
    ///
    /// TAC = Σ kênh × 100. Bốn kênh solid ⇒ 400%. Spot cộng như process, đúng
    /// cách xưởng tính giới hạn mực (mực pha vẫn là mực trên giấy).
    pub fn tac_percent(&self) -> Vec<f32> {
        let px = (self.width as usize) * (self.height as usize);
        let mut out = vec![0.0f32; px];
        if should_parallelize_frame(px) {
            out.par_iter_mut().enumerate().for_each(|(index, output)| {
                let mut tac = 0.0f32;
                for plane in &self.planes {
                    tac += plane[index] * 100.0;
                }
                *output = tac;
            });
            return out;
        }
        for plane in &self.planes {
            for (o, v) in out.iter_mut().zip(plane.iter()) {
                *o += v * 100.0;
            }
        }
        out
    }

    pub fn max_tac_percent(&self) -> f32 {
        // PERF (audit 2026-08-05 §PERF.8): fold trực tiếp, không dựng Vec<f32>
        // full-page chỉ để đọc một giá trị. A4 @300 DPI tránh được ~32,1 MiB tạm.
        let px = self.alpha.len();
        let pixel_tac = |index: usize| {
            let mut tac = 0.0f32;
            for plane in &self.planes {
                tac += plane[index] * 100.0;
            }
            tac
        };
        if should_parallelize_frame(px) {
            (0..px)
                .into_par_iter()
                .map(pixel_tac)
                .reduce(|| 0.0f32, f32::max)
        } else {
            (0..px).map(pixel_tac).fold(0.0f32, f32::max)
        }
    }

    /// Xuất một kẽm sang byte 0..255 với **255 = 100% mực**.
    ///
    /// Chiều quy ước này khớp `ink_density` mà `separations.py` dựng (`255 - tiff`
    /// vì TIFF của `tiffsep` bị nghịch đảo), nên plate PPE cắm thẳng vào
    /// `_create_colored_plate` không cần đổi dấu ở lớp Python.
    pub fn plate_u8(&self, channel: usize) -> Vec<u8> {
        let plane = &self.planes[channel];
        let convert = |value: &f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        if should_parallelize_frame(plane.len()) {
            plane.par_iter().map(convert).collect()
        } else {
            plane.iter().map(convert).collect()
        }
    }

    /// Quy buffer mực sang ảnh sRGB 8 bit (3 byte/pixel) — đường **soft-proof**.
    ///
    /// Đây là chiều **ra**, không phải chiều đo: nó trả lời "in ra sẽ trông thế nào",
    /// không trả lời "tốn bao nhiêu mực". Hai chiều đó không được lẫn nhau — chính vì
    /// vậy vùng CMYK đặc bị nén khi qua profile ở đây là **đúng**, trong khi ở đường
    /// đo thì đó là lỗi.
    ///
    /// `None` khi không có quản lý màu: đoán một công thức CMYK→RGB rồi gọi đó là
    /// soft-proof là hứa một thứ không có.
    pub fn to_srgb(&self, cm: &crate::color::icc::ColorManager) -> Option<Vec<u8>> {
        let px = self.alpha.len();
        // Kênh spot không biểu diễn được trên màn hình, nên đây là chỗ chúng được
        // gộp về CMYK — SAU khi overprint/knockout đã được tính trong không gian
        // mực đầy đủ (xem `InkSpace::fold_spots_at_output`).
        let mut cmyk: Vec<[f32; 4]> = Vec::with_capacity(px);
        for i in 0..px {
            cmyk.push([
                self.planes[0][i].clamp(0.0, 1.0),
                self.planes[1][i].clamp(0.0, 1.0),
                self.planes[2][i].clamp(0.0, 1.0),
                self.planes[3][i].clamp(0.0, 1.0),
            ]);
        }
        for ch in 4..self.planes.len() {
            if !self.space.colorants()[ch].is_spot() {
                continue;
            }
            let plane = &self.planes[ch];
            match self.space.spot_alternate(ch) {
                Some(alt) => {
                    for i in 0..px {
                        let t = plane[i].clamp(0.0, 1.0);
                        if t <= 0.0 {
                            continue;
                        }
                        let add = alt.cmyk_at(t);
                        for c in 0..4 {
                            cmyk[i][c] = (cmyk[i][c] + add[c]).min(1.0);
                        }
                    }
                }
                None => {
                    // Không lấy được tint transform (kẽm khai thiếu hoặc alternate
                    // space không quy đổi được). Hiện nó ra như mực đen theo đúng
                    // lượng phủ: sai sắc, nhưng thấy được. Bỏ hẳn kênh sẽ làm một
                    // vùng có mực hiện ra giấy trắng — đó là im lặng nói sai.
                    for i in 0..px {
                        let t = plane[i].clamp(0.0, 1.0);
                        if t > 0.0 {
                            cmyk[i][3] = (cmyk[i][3] + t).min(1.0);
                        }
                    }
                }
            }
        }
        let rgb = cm.cmyk_to_srgb_batch(&cmyk)?;
        let mut out = Vec::with_capacity(px * 3);
        for p in rgb {
            out.extend_from_slice(&p);
        }
        Some(out)
    }

    /// Xuất buffer mực ra CMYK composite 8 bit (4 byte/pixel) — đường **export production**.
    ///
    /// Gộp kênh spot vào process CMYK theo cùng logic với [`to_srgb`], nhưng trả
    /// dữ liệu CMYK thẳng thay vì quy sang RGB. Không cần `ColorManager` vì dữ
    /// liệu đã nằm trong không gian mực — caller tự nhúng profile ICC (FOGRA39/SWOP)
    /// khi ghi file.
    ///
    /// Thứ tự byte: `[C, M, Y, K, C, M, Y, K, ...]` (interleaved), mỗi kênh 0..255
    /// với 255 = 100% mực. Khớp convention TIFF CMYK (PhotometricInterpretation=5,
    /// InkSet=1) và Pillow mode "CMYK".
    pub fn to_process_cmyk(&self) -> Vec<u8> {
        let px = self.alpha.len();
        // Gộp spot vào process — cùng logic to_srgb.
        let process_at = |i: usize| {
            [
                self.planes[0][i].clamp(0.0, 1.0),
                self.planes[1][i].clamp(0.0, 1.0),
                self.planes[2][i].clamp(0.0, 1.0),
                self.planes[3][i].clamp(0.0, 1.0),
            ]
        };
        let parallel = should_parallelize_frame(px);
        let mut cmyk: Vec<[f32; 4]> = if parallel {
            (0..px).into_par_iter().map(process_at).collect()
        } else {
            (0..px).map(process_at).collect()
        };
        for ch in 4..self.planes.len() {
            if !self.space.colorants()[ch].is_spot() {
                continue;
            }
            let plane = &self.planes[ch];
            match self.space.spot_alternate(ch) {
                Some(alt) => {
                    for i in 0..px {
                        let t = plane[i].clamp(0.0, 1.0);
                        if t <= 0.0 {
                            continue;
                        }
                        let add = alt.cmyk_at(t);
                        for c in 0..4 {
                            cmyk[i][c] = (cmyk[i][c] + add[c]).min(1.0);
                        }
                    }
                }
                None => {
                    // Spot không có tint transform → hiện như mực đen (cùng to_srgb).
                    for i in 0..px {
                        let t = plane[i].clamp(0.0, 1.0);
                        if t > 0.0 {
                            cmyk[i][3] = (cmyk[i][3] + t).min(1.0);
                        }
                    }
                }
            }
        }
        // Trả interleaved CMYK u8: 4 byte/pixel.
        if parallel {
            let mut out = vec![0u8; px * 4];
            out.par_chunks_mut(4)
                .zip(cmyk.par_iter())
                .for_each(|(bytes, pixel)| {
                    bytes[0] = (pixel[0] * 255.0 + 0.5) as u8;
                    bytes[1] = (pixel[1] * 255.0 + 0.5) as u8;
                    bytes[2] = (pixel[2] * 255.0 + 0.5) as u8;
                    bytes[3] = (pixel[3] * 255.0 + 0.5) as u8;
                });
            out
        } else {
            let mut out = Vec::with_capacity(px * 4);
            for pixel in cmyk {
                out.push((pixel[0] * 255.0 + 0.5) as u8);
                out.push((pixel[1] * 255.0 + 0.5) as u8);
                out.push((pixel[2] * 255.0 + 0.5) as u8);
                out.push((pixel[3] * 255.0 + 0.5) as u8);
            }
            out
        }
    }

    /// Độ phủ của một kẽm theo % diện tích có mực (ngưỡng > 2%).
    pub fn plate_coverage_pct(&self, channel: usize) -> f32 {
        let plane = &self.planes[channel];
        if plane.is_empty() {
            return 0.0;
        }
        let inked = if should_parallelize_frame(plane.len()) {
            plane.par_iter().filter(|value| **value > 0.02).count()
        } else {
            plane.iter().filter(|value| **value > 0.02).count()
        };
        inked as f32 / plane.len() as f32 * 100.0
    }
}

/// Loại backdrop khỏi kết quả của một transparency group không cách ly.
///
/// `composite = backdrop·(1−alpha) + source·alpha`. Giá trị được kẹp vì sai số
/// raster f32 ở alpha rất nhỏ có thể đẩy kết quả ra ngoài miền mực một lượng nhỏ.
#[inline]
fn non_isolated_group_source(backdrop: f32, composite: f32, alpha: f32) -> f32 {
    ((composite - backdrop * (1.0 - alpha)) / alpha.max(1e-7)).clamp(0.0, 1.0)
}

impl Drop for InkBuffer {
    fn drop(&mut self) {
        self.budget.release(self.reserved_bytes);
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
        let a = space
            .register(Colorant::from_pdf_name("PANTONE 485 C"))
            .unwrap();
        let b = space
            .register(Colorant::from_pdf_name("CutContour"))
            .unwrap();
        assert_eq!((a, b), (4, 5));
        // Đăng ký lại phải trả cùng kênh, không tạo trùng.
        assert_eq!(
            space
                .register(Colorant::from_pdf_name("PANTONE 485 C"))
                .unwrap(),
            4
        );
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
        buf.composite(&full_coverage(16), &paint).unwrap();
        assert!((buf.max_tac_percent() - 400.0).abs() < 1e-3);
    }

    #[test]
    fn knockout_clears_background_channels_not_declared() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        // Nền: 100% Magenta.
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS),
        )
        .unwrap();
        // Vẽ đen K-only, overprint TẮT, chỉ khai báo kênh K.
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        )
        .unwrap();
        assert_eq!(buf.plane(1)[0], 0.0, "Magenta phải bị khoét trắng");
        assert_eq!(buf.plane(3)[0], 1.0, "K phải đủ 100%");
    }

    #[test]
    fn overprint_preserves_background_channels() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(0.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS),
        )
        .unwrap();
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3));
        black.overprint = true;
        buf.composite(&full_coverage(4), &black).unwrap();
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
        )
        .unwrap();
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::PROCESS);
        black.overprint = true;
        let black = black.with_overprint_mode_1();
        buf.composite(&full_coverage(1), &black).unwrap();
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
        )
        .unwrap();
        let mut black = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::PROCESS);
        black.overprint = true; // KHÔNG gọi with_overprint_mode_1
        buf.composite(&full_coverage(1), &black).unwrap();
        assert_eq!(buf.plane(0)[0], 0.0, "OPM=0 phải khoét nền");
    }

    #[test]
    fn spot_plate_survives_and_counts_into_tac() {
        let mut space = InkSpace::new();
        let spot = space
            .register(Colorant::Spot("PANTONE 485 C".into()))
            .unwrap();
        let mut buf = InkBuffer::new(2, 2, space).unwrap();
        let mut ink = vec![0.0; 5];
        ink[spot] = 1.0;
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(ink, ChannelMask::single(spot)),
        )
        .unwrap();
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
        )
        .unwrap();
        assert!((buf.plane(3)[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn constant_alpha_scales_coverage() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        let mut paint = InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3));
        paint.alpha = 0.25;
        buf.composite(&[1.0], &paint).unwrap();
        assert!((buf.plane(3)[0] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn zero_coverage_leaves_buffer_untouched() {
        let mut buf = InkBuffer::new(2, 2, InkSpace::new()).unwrap();
        buf.composite(
            &full_coverage(4),
            &InkPaint::opaque(cmyk(1.0, 1.0, 1.0, 1.0), ChannelMask::PROCESS),
        )
        .unwrap();
        let before = buf.plane(0).to_vec();
        buf.composite(
            &vec![0.0; 4],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 0.0), ChannelMask::PROCESS),
        )
        .unwrap();
        assert_eq!(
            buf.plane(0),
            &before[..],
            "coverage 0 không được đổi buffer"
        );
    }

    #[test]
    fn plate_u8_uses_255_as_full_ink() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &[1.0],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        )
        .unwrap();
        assert_eq!(buf.plate_u8(3)[0], 255);
        assert_eq!(buf.plate_u8(0)[0], 0);
    }

    #[test]
    fn plate_u8_rounds_half_tone_to_128() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        buf.composite(
            &[0.5],
            &InkPaint::opaque(cmyk(0.0, 0.0, 0.0, 1.0), ChannelMask::single(3)),
        )
        .unwrap();
        assert_eq!(buf.plate_u8(3)[0], 128);
    }

    #[test]
    fn parallel_full_frame_outputs_match_the_scalar_contract() {
        let width = 1024u32;
        let height = (PARALLEL_FRAME_MIN_PIXELS / width as usize) as u32;
        let px = width as usize * height as usize;
        assert_eq!(px, PARALLEL_FRAME_MIN_PIXELS);

        let mut buf = InkBuffer::new(width, height, InkSpace::new()).unwrap();
        for index in 0..px {
            buf.planes[0][index] = (index % 257) as f32 / 256.0;
            buf.planes[1][index] = (index % 17) as f32 / 16.0;
            buf.planes[2][index] = (index % 5) as f32 / 4.0;
            buf.planes[3][index] = (index % 2) as f32;
        }

        let expected_tac: Vec<f32> = (0..px)
            .map(|index| {
                let mut tac = 0.0f32;
                for plane in &buf.planes {
                    tac += plane[index] * 100.0;
                }
                tac
            })
            .collect();
        let expected_max = expected_tac.iter().copied().fold(0.0f32, f32::max);
        let expected_plate: Vec<u8> = buf.planes[0]
            .iter()
            .map(|value| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
            .collect();
        let expected_coverage =
            buf.planes[0].iter().filter(|value| **value > 0.02).count() as f32 / px as f32 * 100.0;
        let mut expected_cmyk = Vec::with_capacity(px * 4);
        for index in 0..px {
            for plane in &buf.planes {
                expected_cmyk.push((plane[index].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
        }

        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .unwrap();
        pool.install(|| {
            assert_eq!(buf.tac_percent(), expected_tac);
            assert_eq!(buf.max_tac_percent(), expected_max);
            assert_eq!(buf.plate_u8(0), expected_plate);
            assert_eq!(buf.plate_coverage_pct(0), expected_coverage);
            assert_eq!(buf.to_process_cmyk(), expected_cmyk);
        });
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
        let idx = buf
            .space_mut()
            .register(Colorant::Spot("Late".into()))
            .unwrap();
        buf.sync_channels().unwrap();
        assert_eq!(buf.plane(idx).len(), 4);
        assert_eq!(buf.plane(idx)[0], 0.0);
    }

    #[test]
    fn isolated_rgb_sidecar_keeps_unassociated_color_and_alpha() {
        let parent = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        let mut buf = parent.child_isolated_rgb().unwrap();
        assert!(buf.ensure_rgb_sidecar().unwrap());

        let mut red = InkPaint::opaque(cmyk(0.0, 1.0, 1.0, 0.0), ChannelMask::PROCESS);
        red.alpha = 0.25;
        red.blend_rgb = Some([1.0, 0.0, 0.0]);
        buf.composite(&[1.0], &red).unwrap();

        let mut blue = InkPaint::opaque(cmyk(1.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS);
        blue.alpha = 0.5;
        blue.blend_rgb = Some([0.0, 0.0, 1.0]);
        buf.composite(&[1.0], &blue).unwrap();

        assert!((buf.alpha[0] - 0.625).abs() < 1e-6);
        let sidecar = buf.rgb_sidecar.as_ref().unwrap();
        assert_eq!(sidecar.mode, RgbSurfaceMode::PremultipliedAlpha);
        let rgb = sidecar.pixels[0];
        assert!((rgb[0] - 0.2).abs() < 1e-6, "{rgb:?}");
        assert!(rgb[1].abs() < 1e-6, "{rgb:?}");
        assert!((rgb[2] - 0.8).abs() < 1e-6, "{rgb:?}");
        assert_eq!(sidecar.state[0], RGB_VALID_DIRTY);
    }

    #[test]
    fn non_isolated_rgb_child_copies_and_merges_backdrop() {
        let mut parent = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        assert!(parent.ensure_rgb_sidecar().unwrap());

        let mut backdrop = InkPaint::opaque(cmyk(0.9, 0.8, 0.7, 0.0), ChannelMask::PROCESS);
        backdrop.blend_rgb = Some([0.1, 0.2, 0.3]);
        parent.composite(&[1.0], &backdrop).unwrap();

        let mut child = parent.child_non_isolated_rgb().unwrap();
        let mut source = InkPaint::opaque(cmyk(1.0, 1.0, 0.0, 0.0), ChannelMask::PROCESS);
        source.alpha = 0.5;
        source.blend_rgb = Some([0.0, 0.0, 1.0]);
        child.composite(&[1.0], &source).unwrap();

        parent.merge_non_isolated(&child, &[0.4], BlendMode::Normal, false);
        let sidecar = parent.rgb_sidecar.as_ref().unwrap();
        let rgb = sidecar.pixels[0];
        // Group coverage 0.5 × group alpha 0.4 = 0.2.
        assert!((rgb[0] - 0.08).abs() < 1e-6, "{rgb:?}");
        assert!((rgb[1] - 0.16).abs() < 1e-6, "{rgb:?}");
        assert!((rgb[2] - 0.44).abs() < 1e-6, "{rgb:?}");
        assert_eq!(sidecar.state[0], RGB_VALID_DIRTY);
    }

    #[test]
    fn rgb_sidecar_blends_alpha_in_additive_space() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        assert!(buf.ensure_rgb_sidecar().unwrap());

        let mut backdrop = InkPaint::opaque(cmyk(0.9, 1.0, 1.0, 0.0), ChannelMask::PROCESS);
        backdrop.blend_rgb = Some([0.1, 0.0, 0.0]);
        buf.composite(&[1.0], &backdrop).unwrap();

        let mut source = InkPaint::opaque(cmyk(0.8, 0.5, 0.7, 0.0), ChannelMask::PROCESS);
        source.alpha = 0.4;
        source.blend_rgb = Some([0.2, 0.5, 0.3]);
        buf.composite(&[1.0], &source).unwrap();

        let sidecar = buf.rgb_sidecar.as_ref().unwrap();
        let rgb = sidecar.pixels[0];
        assert!((rgb[0] - 0.14).abs() < 1e-6, "{rgb:?}");
        assert!((rgb[1] - 0.20).abs() < 1e-6, "{rgb:?}");
        assert!((rgb[2] - 0.12).abs() < 1e-6, "{rgb:?}");
        assert_eq!(sidecar.state[0], RGB_VALID_DIRTY);
    }

    #[test]
    fn partial_cmyk_over_rgb_is_marked_lossy() {
        let mut buf = InkBuffer::new(1, 1, InkSpace::new()).unwrap();
        assert!(buf.ensure_rgb_sidecar().unwrap());
        let mut rgb = InkPaint::opaque(cmyk(0.0, 1.0, 1.0, 0.0), ChannelMask::PROCESS);
        rgb.blend_rgb = Some([1.0, 0.0, 0.0]);
        buf.composite(&[1.0], &rgb).unwrap();

        let mut cmyk_paint = InkPaint::opaque(cmyk(1.0, 0.0, 0.0, 0.0), ChannelMask::PROCESS);
        cmyk_paint.alpha = 0.5;
        buf.composite(&[1.0], &cmyk_paint).unwrap();
        assert_eq!(buf.rgb_sidecar.as_ref().unwrap().state[0], RGB_LOSSY);
    }

    #[test]
    fn base_buffer_over_budget_fails_loudly() {
        assert!(matches!(
            InkBuffer::new_with_memory_budget(100, 100, InkSpace::new(), 1024),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
    }

    #[test]
    fn transparency_children_share_the_parent_budget() {
        // 10 × 10 × (CMYK + alpha) × f32 = 2,000 bytes per buffer.
        let buf = InkBuffer::new_with_memory_budget(10, 10, InkSpace::new(), 3_500).unwrap();
        assert_eq!(buf.memory_used_bytes(), 2_000);
        assert!(matches!(
            buf.child_isolated(),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
        assert_eq!(buf.memory_used_bytes(), 2_000);
    }

    #[test]
    fn late_spot_plane_respects_the_shared_budget() {
        // Root needs 2,000 bytes; one late 10 × 10 spot plane needs 400 more.
        let mut buf = InkBuffer::new_with_memory_budget(10, 10, InkSpace::new(), 2_300).unwrap();
        buf.space_mut()
            .register(Colorant::Spot("Late".into()))
            .unwrap();
        assert!(matches!(
            buf.sync_channels(),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
        assert_eq!(buf.memory_used_bytes(), 2_000);
    }

    #[test]
    fn zero_size_buffer_is_rejected() {
        assert!(InkBuffer::new(0, 10, InkSpace::new()).is_err());
    }
}
