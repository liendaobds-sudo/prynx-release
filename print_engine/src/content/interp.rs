//! Interpreter content stream: operator PDF → thao tác mực.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Weak};

use lopdf::{Dictionary, Document, Object, ObjectId};
use tiny_skia::{LineCap, LineJoin, Mask, Path, PathBuilder, Transform};

use crate::blend::BlendMode;
use crate::cancel::CancelToken;
use crate::color::icc::{ColorManager, SoftProofSettings};
use crate::color::space::{resolve_colorspace, resolve_function, OutputPreviewFilter};
use crate::color::ColorSpace;
use crate::content::gstate::{GraphicsState, StateDepthOverflow, StateStack};
use crate::content::inline_image::INLINE_OP;
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect, Region};
use crate::image::sampler::{decode_image_with_cancel, ImageSampler, SampledImage};
use crate::ink::{
    ChannelMask, InkBuffer, InkPaint, MemoryLease, SoftMask, DEFAULT_RENDER_MEMORY_BUDGET_BYTES,
};
use crate::oc::{OptionalContent, OptionalContentUsage};
use crate::page_program::PageProgram;
use crate::pdf;
use crate::raster::mask::{rect_path, stroke_to_path, FillRule};
use crate::raster::Rasterizer;
use crate::session::SharedResourceCache;
use crate::shading::eval::SampledShading;
use crate::shading::mesh::MeshTriangle;
use crate::shading::{
    resolve_shading_colorspace, resolve_shading_with_colorspace, Shading, ShadingKind,
};
use crate::text::font::{load_font, FontProgram, LoadedFont, Type3Data};
use crate::text::outlines::{
    encode_path, GlyphOutline, StreamKey, TextBlockCodes, TextOutlineReport,
};
use crate::text::state::{TextObject, TextRenderMode};

const EXPLICIT_MASK_DECODE_REASON: &str = "ảnh /Mask explicit không giải mã được";
const FORM_STREAM_DECODE_REASON: &str = "Do Form (không giải nén được content stream)";
const SMASK_STREAM_DECODE_REASON: &str = "SMask /G (content stream chỉ phục hồi được)";
const PATTERN_STREAM_DECODE_REASON: &str = "Pattern (content stream chỉ phục hồi được)";
const TYPE3_STREAM_DECODE_REASON: &str = "Type3 CharProc (content stream chỉ phục hồi được)";
const STATE_DEPTH_OVERFLOW_REASON: &str = "q (vượt trần graphics-state)";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum DeferredDiagnostic {
    ExplicitMaskDecode,
    SoftMaskStreamDecode,
    PatternStreamDecode,
    Type3StreamDecode,
}

impl DeferredDiagnostic {
    fn reason(self) -> &'static str {
        match self {
            Self::ExplicitMaskDecode => EXPLICIT_MASK_DECODE_REASON,
            Self::SoftMaskStreamDecode => SMASK_STREAM_DECODE_REASON,
            Self::PatternStreamDecode => PATTERN_STREAM_DECODE_REASON,
            Self::Type3StreamDecode => TYPE3_STREAM_DECODE_REASON,
        }
    }

    fn marks_unsupported_transparency(self) -> bool {
        matches!(self, Self::ExplicitMaskDecode | Self::SoftMaskStreamDecode)
    }

    fn counts_as_dropped_object(self) -> bool {
        matches!(self, Self::PatternStreamDecode | Self::Type3StreamDecode)
    }
}

/// Provenance bảo thủ của diagnostic `/Mask`: mỗi invocation giữ một hộp bao
/// pixel trên surface hiện hành. Hộp bao có thể phủ khoảng trống giữa các đảo
/// coverage, nhưng không được vượt qua một vùng hoàn toàn rời nhau ở boundary.
type ExplicitMaskEvents = HashMap<u64, Region>;

/// Transaction của một operation lồng: footprint và diagnostic chỉ được merge
/// lên cha sau khi operation hoàn tất. Hai phần phải đi cùng nhau; nếu chỉ giữ
/// Region thì `/Mask` lỗi trong cell vẫn làm bẩn warning dù operation đã hủy.
struct PaintTransaction {
    region: Region,
    explicit_mask_events: ExplicitMaskEvents,
}

impl Default for PaintTransaction {
    fn default() -> Self {
        Self {
            region: Region::EMPTY,
            explicit_mask_events: ExplicitMaskEvents::new(),
        }
    }
}

/// Ngưỡng scale thiết bị để bật raster bảo thủ cho vector.
///
/// Trước đây là 1.2 (tắt hẳn ở 72 DPI) để đỉnh TAC của path transparency không
/// bị binarize thổi phồng. Cái giá đo được ở 72 DPI là rất nặng: 17/31 file
/// corpus FAIL mean, gồm cả báo THIẾU 8.2 điểm TAC (tra gung) — chiều sai nguy
/// hiểm. Nay bật từ 1.0 nhưng path trong suốt (alpha < 1, soft mask, blend
/// khác Normal) ở dưới 1.2 vẫn giữ đường AA cũ — đúng nhóm mà ngưỡng 1.2 từng
/// bảo vệ (xem `conservative_allowed_for_paint`).
const CONSERVATIVE_VECTOR_MIN_DEVICE_SCALE: f32 = 1.0;
/// Dưới scale này, chỉ path ĐỤC (không alpha/soft mask/blend) mới raster bảo thủ.
const CONSERVATIVE_OPAQUE_ONLY_BELOW_SCALE: f32 = 1.2;
/// Chỉ mở rộng path có ít nhất một chiều nhỏ: đây là nhóm outline/hairline dễ biến
/// mất khi thử đúng tâm pixel. Mảng lớn giữ pixel-center để không phình diện tích phủ.
const CONSERVATIVE_VECTOR_MAX_MIN_DIM_PX: f32 = 16.0;
/// Trên raster lớn, một pixel biên chiếm tỷ lệ rất nhỏ so với toàn trang và việc giữ
/// mọi outline quan trọng hơn. Raster nhỏ chỉ mở rộng các fill nhỏ để tránh phình mean.
const CONSERVATIVE_VECTOR_FULL_PAGE_MIN_DIM_PX: u32 = 512;

/// Bắt đầu lọc footprint khi một pixel màn hình phủ quá số texel này trên một trục.
///
/// Dưới ngưỡng này, lấy mẫu tâm giữ đường phóng đại/zoom gần 1:1 nhanh như cũ.
/// Trên ngưỡng, ảnh menu/scan 300–600 DPI cần tích phân footprint để nét mảnh
/// không rơi lọt giữa các điểm lấy mẫu.
const PREVIEW_IMAGE_MINIFICATION_THRESHOLD: f64 = 1.25;

/// Trần supersample mỗi trục cho đường xem.
///
/// Tám điểm đủ giữ khoảng cách mẫu dưới một texel cho ảnh tới khoảng 8× DPI đích,
/// đồng thời chặn PDF cực lớn biến một pixel Viewer thành hàng nghìn phép đọc.
const PREVIEW_IMAGE_MAX_SAMPLES_PER_AXIS: u32 = 8;

/// Mức phục hồi vi tương phản sau khi đã tích phân footprint ảnh.
///
/// Chỉ đường xem dùng giá trị này. Đường đo mực/TAC không đi qua bộ lọc, nên
/// lượng mực thật và kẽm xuất không bị một hiệu ứng hiển thị làm thay đổi.
const PREVIEW_IMAGE_DETAIL_BOOST: f32 = 0.35;
/// Bỏ chi tiết nhỏ hơn hai mức 8-bit để không làm nổi nhiễu JPEG/vân giấy.
const PREVIEW_IMAGE_DETAIL_THRESHOLD: f32 = 2.0 / 255.0;
/// Giới hạn phần chi tiết trước khi nhân hệ số, chống halo quanh chữ và vật thể.
const PREVIEW_IMAGE_DETAIL_LIMIT: f32 = 0.12;

fn needs_conservative_vector_edge(path: &Path, page_width: u32, page_height: u32) -> bool {
    if page_width.min(page_height) >= CONSERVATIVE_VECTOR_FULL_PAGE_MIN_DIM_PX {
        return true;
    }
    let bounds = path.bounds();
    let width = (bounds.right() - bounds.left()).abs();
    let height = (bounds.bottom() - bounds.top()).abs();
    width.min(height) <= CONSERVATIVE_VECTOR_MAX_MIN_DIM_PX
}

/// Tuỳ chọn render.
///
/// Không dẫn xuất `Debug`: `fallback_font` chứa cả file font, in ra sẽ là hàng
/// trăm KB byte.
#[derive(Clone)]
pub struct RenderOptions {
    /// Khử răng cưa.
    ///
    /// **Tắt** cho chế độ đo mực (TAC/ink-limit): cạnh phải nhị phân để vùng đặc
    /// đọc đúng 100% mực. **Bật** cho xem trước.
    pub anti_alias: bool,
    /// Tỷ lệ DPI của phép render trang (được page.rs điền trước khi chạy).
    device_scale: f32,
    /// Trần độ sâu lồng Form XObject / pattern.
    pub max_form_depth: u32,
    /// Tổng bộ nhớ tối đa cho mọi buffer mực đang sống trong một lần render.
    ///
    /// Buffer transparency con dùng chung ngân sách; vượt trần trả lỗi fail-loud.
    pub memory_budget_bytes: usize,
    /// Font TrueType dùng thay khi file **không nhúng** font.
    ///
    /// `None` (mặc định) = không thay, không vẽ, ghi nhận. Đó là lựa chọn trung
    /// thực nhất nhưng để lại một lỗ đo: trang toàn chữ sẽ báo 0% mực, tức là báo
    /// **thiếu** mực — đúng chiều sai nguy hiểm.
    ///
    /// Cung cấp font thay thế lấp lỗ đó, với cái giá là bề rộng và hình chữ khác
    /// bản gốc. Vì vậy mỗi lần thay đều bật cờ hạ `accuracy`: kết quả dùng để
    /// **cảnh báo** được, không dùng để chốt kẽm.
    pub fallback_font: Option<Arc<Vec<u8>>>,
    /// Quy mực pha về CMYK thay vì cấp kênh riêng — chỉ dùng cho soft-proof.
    ///
    /// **Không bao giờ** bật ở đường đo: kết quả chỉ còn bốn kẽm process.
    ///
    /// Việc gộp xảy ra ở bước **xuất ảnh** (`InkBuffer::to_srgb`), không phải lúc
    /// dựng mực: overprint/knockout của object mực pha phải được tính khi kẽm còn
    /// danh tính riêng. Xem `InkSpace::fold_spots_at_output`.
    pub flatten_spots: bool,
    /// Có tôn trọng cờ `/OP`/`/op` trong PDF hay ép toàn bộ object về knockout.
    ///
    /// Chỉ tắt khi dựng cặp ảnh Overprint Preview. Mọi đường separations/TAC và
    /// soft-proof thông thường phải giữ `true` để phản ánh đúng bản in.
    pub simulate_overprint: bool,

    /// Lấy mẫu ảnh/mask theo chiều bảo thủ để tránh false-clean khi đo mực.
    ///
    /// Chỉ đường `ink_accurate` bật: soft-proof phải lấy đúng alpha tại pixel như
    /// PDF/Acrobat, không được giãn cực đại 7×7 vừa sai biên vừa tốn 49 lookup.
    conservative_image_sampling: bool,

    /// Tín hiệu hủy hợp tác; `None` giữ nguyên hành vi API stateless cũ.
    cancel_token: Option<CancelToken>,

    /// Separations/TAC dùng `/Print`; Viewer phải chủ động chọn `/View`.
    optional_content_usage: OptionalContentUsage,

    /// Viewer dựng annotation/widget từ appearance stream `/AP`; đường đo mực
    /// mặc định không trộn nội dung tương tác vào bản in.
    render_annotations: bool,

    /// Thu thập đường viền glyph thay vì rasterize chữ (action `OUTLINE_FONTS`).
    ///
    /// **Raster của lần render này KHÔNG dùng để đo được**: chữ không lên mực, nên
    /// mọi con số kẽm/TAC sẽ thiếu. Chế độ này chỉ để lấy hình học chữ đem đi ghi
    /// lại thành PDF; phần kiểm chứng kết quả vẫn là một lần render bình thường rồi
    /// so kẽm. Xem `crate::text::outlines`.
    pub collect_text_outlines: bool,

    /// Bộ lọc Show của Output Preview. Mặc định `All` giữ byte pixel cũ.
    output_preview_filter: OutputPreviewFilter,

    /// Các lựa chọn Paper/Black/Background chỉ dùng ở bước proof ra màn hình.
    softproof_settings: SoftProofSettings,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            anti_alias: true,
            device_scale: 1.0,
            max_form_depth: 12,
            memory_budget_bytes: DEFAULT_RENDER_MEMORY_BUDGET_BYTES,
            fallback_font: None,
            flatten_spots: false,
            simulate_overprint: true,
            conservative_image_sampling: false,
            cancel_token: None,
            optional_content_usage: OptionalContentUsage::Print,
            render_annotations: false,
            collect_text_outlines: false,
            output_preview_filter: OutputPreviewFilter::All,
            softproof_settings: SoftProofSettings::default(),
        }
    }
}

impl RenderOptions {
    /// Cấu hình đo lượng mực: không AA.
    pub fn ink_accurate() -> Self {
        RenderOptions {
            anti_alias: false,
            conservative_image_sampling: true,
            ..Default::default()
        }
    }

    /// Cấu hình **soft-proof**: khử răng cưa, và mực pha quy về CMYK.
    ///
    /// Ngược hẳn với [`RenderOptions::ink_accurate`] ở cả hai điểm, và đó là có chủ
    /// ý: một cấu hình dùng để *xem* thì cần cạnh mượt và cần thấy được mực pha trên
    /// màn hình; một cấu hình dùng để *đo* thì cần cạnh nhị phân và cần giữ kẽm spot.
    pub fn softproof() -> Self {
        RenderOptions {
            anti_alias: true,
            flatten_spots: true,
            ..Default::default()
        }
    }

    /// Gắn tỷ lệ DPI của render trang cho các guard phụ thuộc độ phân giải.
    pub(crate) fn with_device_scale(mut self, dpi: f32) -> Self {
        self.device_scale = (dpi / 72.0).max(0.0);
        self
    }

    /// Đặt ngân sách bộ nhớ cho một lần render.
    pub fn with_memory_budget_bytes(mut self, bytes: usize) -> Self {
        self.memory_budget_bytes = bytes;
        self
    }

    /// Gắn tín hiệu hủy cho một lần render tương tác.
    pub fn with_cancel_token(mut self, token: CancelToken) -> Self {
        self.cancel_token = Some(token);
        self
    }

    pub fn with_optional_content_usage(mut self, usage: OptionalContentUsage) -> Self {
        self.optional_content_usage = usage;
        self
    }

    pub fn with_annotations(mut self, enabled: bool) -> Self {
        self.render_annotations = enabled;
        self
    }

    pub(crate) fn renders_annotations(&self) -> bool {
        self.render_annotations
    }

    pub(crate) fn check_cancelled(&self) -> PpeResult<()> {
        match &self.cancel_token {
            Some(token) => token.check(),
            None => Ok(()),
        }
    }

    pub(crate) fn cancellation_token(&self) -> Option<&CancelToken> {
        self.cancel_token.as_ref()
    }

    /// Bật/tắt mô phỏng overprint khi dựng bản xem trước.
    pub fn with_overprint_simulation(mut self, enabled: bool) -> Self {
        self.simulate_overprint = enabled;
        self
    }

    /// Gắn bộ lọc Show thực thi tại đúng sink vẽ của PPE.
    pub fn with_output_preview_filter(mut self, filter: OutputPreviewFilter) -> Self {
        self.output_preview_filter = filter;
        self
    }

    pub fn with_softproof_settings(mut self, settings: SoftProofSettings) -> Self {
        self.softproof_settings = settings;
        self
    }

    pub(crate) fn softproof_settings(&self) -> SoftProofSettings {
        self.softproof_settings
    }

    fn allows_preview_object(&self, kind: PreviewObjectKind) -> bool {
        match self.output_preview_filter {
            OutputPreviewFilter::Text => kind == PreviewObjectKind::Text,
            OutputPreviewFilter::Images => kind == PreviewObjectKind::Image,
            OutputPreviewFilter::LineArt => kind == PreviewObjectKind::LineArt,
            OutputPreviewFilter::SmoothShades => kind == PreviewObjectKind::SmoothShade,
            _ => true,
        }
    }

    fn allows_preview_color_space(&self, color_space: &ColorSpace) -> bool {
        self.output_preview_filter.matches_color_space(color_space)
    }

    fn needs_source_space_for_preview(&self) -> bool {
        self.output_preview_filter.filters_source_space()
    }

    /// Chế độ lấy hình học chữ cho `OUTLINE_FONTS`. Xem [`RenderOptions::collect_text_outlines`].
    pub fn collecting_text_outlines() -> Self {
        RenderOptions {
            collect_text_outlines: true,
            ..RenderOptions::ink_accurate()
        }
    }

    /// Đặt font thay thế cho font không nhúng.
    pub fn with_fallback_font(mut self, data: Arc<Vec<u8>>) -> Self {
        self.fallback_font = Some(data);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewObjectKind {
    Text,
    Image,
    LineArt,
    SmoothShade,
}
/// Blending color space đang hiệu lực của trang/group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendSpace {
    DeviceCmyk,
    DeviceRgb,
    Other,
}

/// PERF (audit 2026-08-09 §RENDER.F3): nguồn độ phủ khi dựng shading.
///
/// Shading pattern vẫn dùng mảng raster dày của đường dẫn. Riêng operator `sh`
/// đọc clip và soft mask trực tiếp để không cấp phát thêm một `Vec<f32>` cỡ cả
/// trang cho từng dải màu.
#[derive(Clone, Copy)]
enum ShadingCoverage<'a> {
    Dense(&'a [f32]),
    GraphicsState {
        clip: Option<&'a Mask>,
        soft_mask: Option<&'a SoftMask>,
        width: usize,
    },
}

impl ShadingCoverage<'_> {
    #[inline]
    fn at(self, index: usize) -> f32 {
        match self {
            ShadingCoverage::Dense(coverage) => coverage.get(index).copied().unwrap_or(0.0),
            ShadingCoverage::GraphicsState {
                clip,
                soft_mask,
                width,
            } => {
                let clip_coverage = clip.map_or(1.0, |mask| {
                    mask.data()
                        .get(index)
                        .map_or(0.0, |value| *value as f32 / 255.0)
                });
                let soft_coverage = soft_mask.map_or(1.0, |mask| mask.value_at_index(index, width));
                clip_coverage * soft_coverage
            }
        }
    }
}

/// Bộ render một trang vào [`InkBuffer`].
pub struct Renderer<'a> {
    doc: &'a Document,
    buffer: InkBuffer,
    raster: Rasterizer,
    warnings: RenderWarnings,
    opts: RenderOptions,
    /// Quản lý màu ICC. `None` = không có profile ⇒ mọi nội dung không phải
    /// DeviceCMYK sẽ dùng công thức xấp xỉ và bị hạ `accuracy`.
    color: Option<&'a ColorManager>,
    /// Không gian dùng cho mọi alpha/blend trong group hiện hành.
    blend_space: BlendSpace,
    /// Ma trận text hiện hành. Không nằm trong graphics state vì text object bị
    /// đặt lại ở mỗi `BT` và **không** được `q`/`Q` lưu (§9.4.1).
    text_obj: TextObject,
    /// Mặt nạ clip cùng hộp bao bảo thủ đang gom từ glyph (`Tr` 4–7), áp khi
    /// gặp `ET`.
    text_clip: Option<PendingTextClip>,
    /// Cache font theo `ObjectId`.
    font_cache: HashMap<ObjectId, Arc<LoadedFont>>,
    /// Cache mẫu ảnh gián tiếp có colorspace tự chứa trong một lần render.
    image_cache: HashMap<ObjectId, CachedImage>,
    /// Cache resource sở hữu bởi document session, nếu request đi qua session.
    shared_resource_cache: Option<SharedResourceCache>,
    /// CTM khởi đầu của content stream đang chạy.
    ///
    /// Pattern `/Matrix` được ghép với ma trận khởi đầu của stream dùng
    /// pattern (§8.7.2), không phải CTM sau các `cm` bên trong stream và
    /// cũng không luôn là CTM đầu trang. Form XObject, soft mask và pattern cell
    /// mỗi loại đều tạo một stream lồng có ma trận khởi đầu riêng.
    stream_base_ctm: Matrix,
    /// Độ sâu lồng của soft mask đang dựng.
    ///
    /// Nội dung của một soft mask được phép tự đặt `gs` với soft mask khác. PDF
    /// hỏng (hoặc cố tình) có thể trỏ vòng, nên phải có trần riêng — trần
    /// `max_form_depth` không chặn được vì mỗi lần dựng mặt nạ lại bắt đầu một
    /// ngăn xếp mới.
    smask_depth: u32,
    /// Trạng thái bật/tắt của optional content, đọc theo cấu hình **in**.
    oc: OptionalContent,
    /// Độ sâu lồng của stream đang chạy.
    ///
    /// Giữ trong renderer thay vì truyền qua mọi hàm vẽ: tiling pattern được kích
    /// hoạt từ tận trong `end_path`, và luồn thêm một tham số `depth` qua cả chục
    /// điểm gọi chỉ để tới được đó là làm bẩn API vì một trường hợp.
    cur_depth: u32,
    /// Độ sâu lồng ô tiling pattern đang chạy (mọi PaintType).
    ///
    /// Vành fill-adjust bị TẮT bên trong ô pattern: mẫu lặp hàng trăm/nghìn ô,
    /// mỗi ô nở 0.16 px làm mean phồng theo chu vi × số ô (fixture
    /// `tiling_half_cell` phồng 3.67/255 @100 DPI, 12.75 @72), trong khi RIP
    /// tham chiếu không thể hiện độ nở đó trên nội dung ô pattern.
    pattern_cell_depth: u32,
    /// Loại object chủ khi đang chạy content của Pattern.
    ///
    /// Output Preview phân loại theo object dùng Pattern (Text/LineArt/Image), không
    /// theo operator con trong ô. Source colorspace vẫn được kiểm tại từng sink con.
    pattern_preview_owner: Option<PreviewObjectKind>,
    /// Đang ở trong ô của một **uncoloured** tiling pattern (`/PaintType 2`).
    ///
    /// Bên trong ô đó mọi operator màu bị bỏ qua (§8.7.3.3): màu do `scn` bên ngoài
    /// quyết định. Bộ đếm chứ không phải cờ vì ô có thể lồng pattern khác.
    suppress_color_ops: u32,
    /// Bộ đếm sink đã composite, chỉ dùng để defer diagnostic của Pattern host
    /// tới sau source/object filter. `wrapping_add` đủ vì chỉ so thay đổi cục bộ.
    paint_serial: u64,
    /// Hộp bao paint đã commit trên surface hiện hành.
    surface_painted_region: Region,
    /// Transaction theo operation lồng nhau. Sink chỉ ghi transaction trên cùng;
    /// operation chỉ merge Region + event lên cha khi hoàn tất, nên error/cancel
    /// không commit footprint hoặc diagnostic của nội dung dở dang.
    paint_region_trackers: Vec<PaintTransaction>,
    /// Surface child nằm dưới operation tracker cần footprint pixel thật, không
    /// được dùng bbox yêu cầu của shading/group làm xấp xỉ.
    exact_paint_region: bool,
    /// Event `/Mask` explicit đã thực sự paint trên surface phụ hiện hành.
    ///
    /// CORRECTNESS (audit 2026-08-31 §PPE-A05): warning không được ghi thẳng
    /// vào báo cáo khi đang render soft mask/transparency group; surface cha chỉ
    /// nhận event nếu bước dùng-mask/merge có alpha hiệu lực dương. Region là hộp
    /// bao bảo thủ trong hệ pixel của chính surface đó.
    surface_explicit_mask_events: ExplicitMaskEvents,
    /// Event đã đi tới surface trang, dùng để một soft mask tái sử dụng không
    /// đếm lại cùng lỗi ở mọi sink.
    reported_explicit_mask_events: HashSet<u64>,
    /// Metadata event gắn với soft mask mà không đổi public type của GraphicsState.
    /// Weak pointer ngăn địa chỉ allocator tái sử dụng làm nhận nhầm mask cũ.
    soft_mask_explicit_events: HashMap<usize, (Weak<SoftMask>, ExplicitMaskEvents)>,
    /// Loại diagnostic của từng event deferred; event có thể đi qua nhiều surface
    /// trước khi tới trang nên không thể suy loại chỉ từ Region.
    deferred_event_diagnostics: HashMap<u64, DeferredDiagnostic>,
    next_explicit_mask_event: u64,
    /// Độ sâu surface phụ do `render_form_into` dựng; 0 là output trang.
    render_surface_depth: u32,
    /// Số lớp optional content đang **tắt** mà con trỏ đang nằm trong.
    ///
    /// Là bộ đếm ở mức renderer (không phải mức stream) để một Form XObject được
    /// `Do` bên trong lớp tắt cũng không vẽ gì — lớp tắt phải tắt xuyên qua ranh
    /// giới stream.
    oc_hidden: u32,
    /// Ngăn xếp `(content stream đang chạy, số khối `BT` đã gặp trong stream đó)`.
    ///
    /// Là ngăn xếp chứ không phải một biến: Form XObject có content stream riêng và
    /// Python thay khối `BT … ET` **theo từng stream**, nên khi ra khỏi form thì bộ
    /// đếm của stream ngoài phải trở lại đúng giá trị cũ.
    stream_ctx: Vec<(StreamKey, u32)>,
    /// Báo cáo thu thập đường viền chữ; chỉ được ghi khi `opts.collect_text_outlines`.
    text_outlines: TextOutlineReport,
    /// Thứ tự glyph trong khối `BT` hiện hành.
    glyph_seq: u32,
    /// Số mã ký tự đã đi qua trong từng khối `BT … ET`, khoá `(stream, chỉ số khối)`.
    ///
    /// Hợp đồng đồng bộ chỉ số với lớp ghi PDF bên Python — xem
    /// [`TextBlockCodes`]. Dùng `max` thay vì `+=` khi cập nhật: một Form XObject có
    /// thể được `Do` nhiều lần, mỗi lần đi lại đúng các khối cũ, nên cộng dồn sẽ
    /// khai số gấp đôi và Python sẽ tưởng hai bên lệch.
    text_block_codes: HashMap<(StreamKey, u32), u32>,
}

/// Trạng thái dựng đường dẫn trong một chuỗi operator.
#[derive(Default)]
struct PathState {
    builder: PathBuilder,
    /// Điểm bắt đầu subpath hiện tại — cần cho `h` (close) và `v`/`y`.
    start: Option<(f32, f32)>,
    current: Option<(f32, f32)>,
    /// `W` / `W*` đã gặp: clip sẽ áp sau operator vẽ kế tiếp.
    pending_clip: Option<FillRule>,
    has_segments: bool,
}

/// Clip chữ đang chờ tới `ET` mới nhập vào graphics state.
struct PendingTextClip {
    mask: Mask,
    region: Region,
}

/// Ảnh đã giải mã trong phạm vi một lần render trang.
///
/// Chỉ giữ mẫu nguồn; CTM, clip, alpha, blend và overprint vẫn được áp lại ở mỗi
/// lần `Do`. Lease làm cache tự rút khỏi MemoryBudget khi Renderer kết thúc.
struct CachedImage {
    image: Arc<SampledImage>,
    _memory_lease: MemoryLease,
}

fn merge_render_warnings(target: &mut RenderWarnings, source: &RenderWarnings) {
    for (name, count) in &source.skipped_ops {
        if let Some((_, current)) = target
            .skipped_ops
            .iter_mut()
            .find(|(current_name, _)| current_name == name)
        {
            *current = current.saturating_add(*count);
        } else {
            target.skipped_ops.push((name.clone(), *count));
        }
    }
    for colorspace in &source.approximated_colorspaces {
        target.note_approximated_colorspace(colorspace);
    }
    target.dropped_objects = target
        .dropped_objects
        .saturating_add(source.dropped_objects);
    target.unsupported_transparency |= source.unsupported_transparency;
    target.hidden_content_risk |= source.hidden_content_risk;
    for font in &source.substituted_fonts {
        target.note_substituted_font(font);
    }
    for colorspace in &source.colorspaces_used {
        target.note_colorspace_used(colorspace);
    }
}

impl<'a> Renderer<'a> {
    pub fn new(
        doc: &'a Document,
        buffer: InkBuffer,
        opts: RenderOptions,
        color: Option<&'a ColorManager>,
        blend_space: BlendSpace,
    ) -> PpeResult<Self> {
        Self::new_with_resource_cache(doc, buffer, opts, color, blend_space, None)
    }

    pub(crate) fn new_with_resource_cache(
        doc: &'a Document,
        mut buffer: InkBuffer,
        opts: RenderOptions,
        color: Option<&'a ColorManager>,
        blend_space: BlendSpace,
        shared_resource_cache: Option<SharedResourceCache>,
    ) -> PpeResult<Self> {
        let raster = Rasterizer::new_budgeted(buffer.width(), buffer.height(), &buffer)?;
        if blend_space == BlendSpace::DeviceCmyk {
            buffer.set_rgb_sidecar_allowed(false);
        }
        let optional_content_usage = opts.optional_content_usage;
        Ok(Renderer {
            doc,
            buffer,
            raster,
            warnings: RenderWarnings::default(),
            opts,
            color,
            blend_space,
            text_obj: TextObject::default(),
            text_clip: None,
            font_cache: HashMap::new(),
            image_cache: HashMap::new(),
            shared_resource_cache,
            stream_base_ctm: Matrix::IDENTITY,
            smask_depth: 0,
            cur_depth: 0,
            pattern_cell_depth: 0,
            pattern_preview_owner: None,
            suppress_color_ops: 0,
            paint_serial: 0,
            surface_painted_region: Region::EMPTY,
            paint_region_trackers: Vec::new(),
            exact_paint_region: false,
            surface_explicit_mask_events: HashMap::new(),
            reported_explicit_mask_events: HashSet::new(),
            soft_mask_explicit_events: HashMap::new(),
            deferred_event_diagnostics: HashMap::new(),
            next_explicit_mask_event: 0,
            render_surface_depth: 0,
            oc: OptionalContent::load_for_usage(doc, optional_content_usage),
            oc_hidden: 0,
            stream_ctx: vec![(StreamKey::Page, 0)],
            text_outlines: TextOutlineReport::default(),
            glyph_seq: 0,
            text_block_codes: HashMap::new(),
        })
    }

    fn preview_object_kind(&self, local_kind: PreviewObjectKind) -> PreviewObjectKind {
        self.pattern_preview_owner.unwrap_or(local_kind)
    }

    fn allows_preview_object(&self, local_kind: PreviewObjectKind) -> bool {
        self.opts
            .allows_preview_object(self.preview_object_kind(local_kind))
    }

    fn allocate_deferred_event(&mut self, diagnostic: DeferredDiagnostic) -> u64 {
        let event = self.next_explicit_mask_event;
        self.next_explicit_mask_event = self.next_explicit_mask_event.wrapping_add(1);
        self.deferred_event_diagnostics.insert(event, diagnostic);
        event
    }

    /// Nhận event fail-loud từ surface hiện hành hoặc surface con đã merge.
    fn accept_explicit_mask_events(&mut self, events: impl IntoIterator<Item = (u64, Region)>) {
        // CORRECTNESS (audit 2026-08-31 §PPE-A05): event phát trong tiling phải
        // transaction cùng footprint. Inner success merge lên transaction cha;
        // error/cancel chỉ pop và bỏ cả hai.
        if let Some(transaction) = self.paint_region_trackers.last_mut() {
            for (event, region) in events {
                if region.is_empty() {
                    continue;
                }
                transaction
                    .explicit_mask_events
                    .entry(event)
                    .and_modify(|known| *known = known.union(region))
                    .or_insert(region);
            }
            return;
        }

        if self.render_surface_depth > 0 {
            for (event, region) in events {
                if region.is_empty() {
                    continue;
                }
                self.surface_explicit_mask_events
                    .entry(event)
                    .and_modify(|known| *known = known.union(region))
                    .or_insert(region);
            }
            return;
        }

        let mut new_events: HashMap<DeferredDiagnostic, u32> = HashMap::new();
        for (event, region) in events {
            if region.is_empty() || !self.reported_explicit_mask_events.insert(event) {
                continue;
            }
            let diagnostic = self
                .deferred_event_diagnostics
                .get(&event)
                .copied()
                .unwrap_or(DeferredDiagnostic::ExplicitMaskDecode);
            let count = new_events.entry(diagnostic).or_insert(0);
            *count = count.saturating_add(1);
        }

        for (diagnostic, new_count) in new_events {
            if diagnostic.marks_unsupported_transparency() {
                self.warnings.unsupported_transparency = true;
            }
            if diagnostic.counts_as_dropped_object() {
                self.warnings.dropped_objects =
                    self.warnings.dropped_objects.saturating_add(new_count);
            }
            let reason = diagnostic.reason();
            if let Some((_, count)) = self
                .warnings
                .skipped_ops
                .iter_mut()
                .find(|(known, _)| known == reason)
            {
                *count = count.saturating_add(new_count);
            } else {
                self.warnings
                    .skipped_ops
                    .push((reason.to_string(), new_count));
            }
        }
    }

    /// Tạo một event cho đúng invocation đã vượt mọi clip/filter của image host.
    fn defer_explicit_mask_failure(&mut self, painted_region: Region) {
        if painted_region.is_empty() {
            return;
        }
        let event = self.allocate_deferred_event(DeferredDiagnostic::ExplicitMaskDecode);
        self.accept_explicit_mask_events(std::iter::once((event, painted_region)));
    }

    /// Gắn event sinh trong Form dựng soft mask với chính Arc của mask đó.
    fn register_soft_mask_events(&mut self, mask: &Arc<SoftMask>, events: ExplicitMaskEvents) {
        if events.is_empty() {
            return;
        }
        self.soft_mask_explicit_events
            .insert(Arc::as_ptr(mask) as usize, (Arc::downgrade(mask), events));
    }

    /// Ghi Region vào operation tracker hiện hành; nếu không có tracker thì
    /// commit thẳng lên surface. Tracker con chỉ merge lên cha khi operation xanh.
    fn record_painted_region(&mut self, painted_region: Region) {
        if painted_region.is_empty() {
            return;
        }
        if let Some(transaction) = self.paint_region_trackers.last_mut() {
            transaction.region = transaction.region.union(painted_region);
        } else {
            self.surface_painted_region = self.surface_painted_region.union(painted_region);
        }
    }

    /// Chỉ trả metadata còn sống và chưa từng đi tới output trang.
    fn pending_soft_mask_events(&mut self, mask: &SoftMask) -> Option<ExplicitMaskEvents> {
        let key = mask as *const SoftMask as usize;
        let events = self
            .soft_mask_explicit_events
            .get(&key)
            .and_then(|(weak, events)| {
                weak.upgrade()
                    .filter(|live| Arc::as_ptr(live) == mask as *const SoftMask)
                    .map(|_| events.clone())
            });
        let Some(mut events) = events else {
            // Entry chết có thể giữ cùng địa chỉ tới khi renderer kết thúc;
            // xoá ngay để allocator tái sử dụng cũng không nhận nhầm event.
            self.soft_mask_explicit_events.remove(&key);
            return None;
        };
        events.retain(|event, region| {
            !region.is_empty() && !self.reported_explicit_mask_events.contains(event)
        });
        (!events.is_empty()).then_some(events)
    }

    fn soft_mask_has_pending_events(&mut self, mask: &SoftMask) -> bool {
        self.pending_soft_mask_events(mask).is_some()
    }

    /// Ghi nhận Region của sink đã tự tăng `paint_serial`, rồi propagate SMask.
    fn finish_surface_paint(
        &mut self,
        soft_mask: Option<&SoftMask>,
        painted_region: Region,
    ) -> PpeResult<()> {
        self.record_painted_region(painted_region);
        self.propagate_soft_mask_events(soft_mask, painted_region)
    }

    /// Ghi nhận một sink có alpha hiệu lực dương trên surface hiện hành.
    /// Event của soft mask chỉ đi tiếp ở đây, tức mask được **dùng để paint** chứ
    /// không chỉ được dựng bởi operator `gs` rồi bỏ đó.
    fn note_surface_paint(
        &mut self,
        soft_mask: Option<&SoftMask>,
        painted_region: Region,
    ) -> PpeResult<()> {
        self.paint_serial = self.paint_serial.wrapping_add(1);
        self.finish_surface_paint(soft_mask, painted_region)
    }

    fn propagate_soft_mask_events(
        &mut self,
        soft_mask: Option<&SoftMask>,
        painted_region: Region,
    ) -> PpeResult<()> {
        let Some(mask) = soft_mask else {
            return Ok(());
        };
        let Some(events) = self.pending_soft_mask_events(mask) else {
            return Ok(());
        };

        // Chỉ đường diagnostic hiếm mới quét pixel. Lookup Weak/HashMap và root
        // dedup đều hoàn tất trước vòng lặp; mỗi hàng vẫn poll cancellation.
        let mut visible = ExplicitMaskEvents::new();
        for (event, event_region) in events {
            let candidate = intersect_regions(event_region, painted_region);
            let diagnostic = self
                .deferred_event_diagnostics
                .get(&event)
                .copied()
                .unwrap_or(DeferredDiagnostic::ExplicitMaskDecode);
            // Lỗi nằm trong nội dung được SMask che chỉ có ảnh hưởng nơi alpha
            // mask dương. Lỗi decode của chính `/G` thì alpha 0 cũng có thể là
            // hậu quả của lỗi, nên không được dùng alpha đó để tự che warning.
            let region = if diagnostic == DeferredDiagnostic::SoftMaskStreamDecode {
                candidate
            } else {
                bounding_region_where_cancelled(
                    candidate,
                    self.opts.cancel_token.as_ref(),
                    |x, y| mask.value_at(x, y) > 0.0,
                )?
            };
            if !region.is_empty() {
                visible.insert(event, region);
            }
        }
        self.accept_explicit_mask_events(visible);
        Ok(())
    }

    pub fn warnings(&self) -> &RenderWarnings {
        &self.warnings
    }

    pub(crate) fn note_unsupported_annotation(&mut self, reason: &str) {
        self.warnings.dropped_objects = self.warnings.dropped_objects.saturating_add(1);
        self.warnings.note_skipped_op(reason);
    }

    /// Báo cáo đường viền chữ đã thu thập. Rỗng nếu không bật chế độ thu thập.
    pub fn text_outlines(&self) -> &TextOutlineReport {
        &self.text_outlines
    }

    pub fn into_parts(self) -> (InkBuffer, RenderWarnings) {
        (self.buffer, self.warnings)
    }

    /// Như [`Renderer::into_parts`] nhưng lấy kèm báo cáo đường viền chữ.
    pub fn into_parts_with_outlines(mut self) -> (InkBuffer, RenderWarnings, TextOutlineReport) {
        self.flush_text_block_codes();
        (self.buffer, self.warnings, self.text_outlines)
    }

    /// Dồn bảng đếm mã ký tự vào báo cáo, sắp thứ tự cố định.
    ///
    /// Sắp xếp chứ không giao ra thứ tự của `HashMap`: báo cáo là dữ liệu đi ra khỏi
    /// engine, và thứ tự ngẫu nhiên giữa hai lần chạy làm mọi phép so sánh (test,
    /// nhật ký, artifact đo) mất giá trị.
    fn flush_text_block_codes(&mut self) {
        if self.text_block_codes.is_empty() {
            return;
        }
        let mut blocks: Vec<TextBlockCodes> = self
            .text_block_codes
            .iter()
            .map(|((stream, index), count)| TextBlockCodes {
                stream: *stream,
                text_object_index: *index,
                code_count: *count,
            })
            .collect();
        blocks.sort_by_key(|b| (b.stream, b.text_object_index));
        self.text_outlines.blocks = blocks;
    }

    /// Ghi fail-loud một lần ở đầu mỗi episode vượt trần q-depth.
    fn note_state_depth_overflow(&mut self, overflow: StateDepthOverflow) {
        if !overflow.starts_episode() {
            return;
        }
        self.warnings.note_skipped_op(STATE_DEPTH_OVERFLOW_REASON);
        self.warnings.dropped_objects = self.warnings.dropped_objects.saturating_add(1);
    }

    /// Internal Form/group/Type3 không được sửa frame caller nếu save chạm trần.
    /// Frame virtual vừa tạo được consume ngay vì object đó bị bỏ fail-closed.
    fn save_internal_state(&mut self, stack: &mut StateStack) -> bool {
        match stack.save() {
            Ok(()) => true,
            Err(overflow) => {
                self.note_state_depth_overflow(overflow);
                stack.restore();
                false
            }
        }
    }

    /// Chạy một content stream với CTM và resources cho trước.
    pub fn run(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        base_ctm: Matrix,
    ) -> PpeResult<()> {
        let program = PageProgram::compile(data)?;
        self.run_program(&program, resources, base_ctm)
    }

    /// Replay chương trình trang đã decode với CTM/resource scope của request hiện tại.
    pub fn run_program(
        &mut self,
        program: &PageProgram,
        resources: Option<&Dictionary>,
        base_ctm: Matrix,
    ) -> PpeResult<()> {
        let mut stack = StateStack::new(GraphicsState::initial(base_ctm));
        self.execute_program(program, resources, &mut stack, 0)?;
        self.opts.check_cancelled()?;
        if stack.unbalanced_restores > 0 {
            self.warnings.note_skipped_op("Q (không cân)");
        }
        if let Some(color) = self.color {
            if !self.buffer.finalize_rgb(color) {
                self.warnings.unsupported_transparency = true;
                self.warnings.note_skipped_op(
                    "Transparency DeviceRGB: backdrop không còn biểu diễn chính xác trong RGB",
                );
            }
        }
        self.opts.check_cancelled()?;
        Ok(())
    }

    fn execute(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let program = PageProgram::compile(data)?;
        self.execute_program(&program, resources, stack, depth)
    }

    fn execute_program(
        &mut self,
        program: &PageProgram,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let previous_stream_base = self.stream_base_ctm;
        self.stream_base_ctm = stack.current().ctm;
        let result = self.execute_program_inner(program, resources, stack, depth);
        self.stream_base_ctm = previous_stream_base;
        result
    }

    fn execute_program_inner(
        &mut self,
        program: &PageProgram,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        self.opts.check_cancelled()?;
        if depth > self.opts.max_form_depth {
            // CORRECTNESS (audit 2026-08-31 §PPE-A01): stream lồng bị bỏ phải
            // hạ soundness, không chỉ xuất hiện trong danh sách operator bỏ qua.
            if stack
                .current()
                .clip_region
                .is_none_or(|region| !region.is_empty())
            {
                self.warnings.note_skipped_op("Do (lồng quá sâu)");
                self.warnings.dropped_objects = self.warnings.dropped_objects.saturating_add(1);
            }
            return Ok(());
        }

        if program.failed_inline_images() > 0 {
            self.warnings.dropped_objects += program.failed_inline_images();
            self.warnings
                .note_skipped_op("BI (ảnh nội tuyến không đọc được)");
        }
        let inline_images = program.inline_images();

        let mut path = PathState::default();
        // Độ sâu logic `q` lúc vào — dùng để dọn cả frame physical lẫn virtual
        // khi stream kết thúc.
        let entry_depth = stack.logical_depth();
        // Ngăn xếp marked content của **stream này**: mỗi phần tử ghi "khối này có
        // mở một lớp đang tắt hay không". Cục bộ theo stream vì `BDC`/`EMC` phải cân
        // trong cùng một stream; còn bộ đếm `oc_hidden` thì ở mức renderer để lớp tắt
        // tắt xuyên qua Form XObject.
        let mut marked_content: Vec<bool> = Vec::new();

        for op in program.operations() {
            self.opts.check_cancelled()?;
            let operands = &op.operands;
            // Đặt lại ở mỗi operator: một lời gọi lồng (form, pattern, soft mask) đã
            // ghi độ sâu của nó vào đây và không có nghĩa vụ phục hồi.
            self.cur_depth = depth;

            // CORRECTNESS (audit 2026-08-31 §PPE-B02): khi physical stack đã đầy,
            // chỉ q/Q được phép thay đổi virtual depth. Mọi paint/state op khác bị
            // bỏ fail-closed nhưng cancellation vẫn được poll ở đầu vòng.
            if stack.virtual_overflow_active() {
                match op.operator.as_str() {
                    "q" => {
                        if let Err(overflow) = stack.save() {
                            self.note_state_depth_overflow(overflow);
                        }
                    }
                    "Q" => stack.restore(),
                    _ => {}
                }
                continue;
            }

            // Type3 d1 và PaintType 2 đều cấm mọi color-setting, kể cả resolve
            // colorspace và assignment tên Pattern vốn không đi qua setter.
            if self.suppress_color_ops > 0
                && matches!(
                    op.operator.as_str(),
                    "g" | "G" | "rg" | "RG" | "k" | "K" | "cs" | "CS" | "sc" | "scn" | "SC" | "SCN"
                )
            {
                continue;
            }

            match op.operator.as_str() {
                // ── Trạng thái ────────────────────────────────────────────────
                "q" => {
                    if let Err(overflow) = stack.save() {
                        let starts_episode = overflow.starts_episode();
                        self.note_state_depth_overflow(overflow);
                        if starts_episode {
                            // Current path không thuộc graphics state. Nếu paint-op
                            // trong episode bị skip mà giữ path cũ, nó có thể bị tô
                            // muộn sau Q; bỏ path ngay để fail-closed.
                            path = PathState::default();
                        }
                    }
                }
                "Q" => stack.restore(),
                "cm" => {
                    if let Some(m) = matrix_from(operands) {
                        let gs = stack.current_mut();
                        gs.ctm = m.then(&gs.ctm);
                    }
                }
                "gs" => {
                    if let (Some(name), Some(res)) = (name_operand(operands, 0), resources) {
                        self.apply_ext_gstate(&name, res, stack, depth)?;
                    }
                }

                // ── Tham số nét ───────────────────────────────────────────────
                "w" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().line_width = v;
                    }
                }
                "J" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().line_cap = match v as i32 {
                            1 => LineCap::Round,
                            2 => LineCap::Square,
                            _ => LineCap::Butt,
                        };
                    }
                }
                "j" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().line_join = match v as i32 {
                            1 => LineJoin::Round,
                            2 => LineJoin::Bevel,
                            _ => LineJoin::Miter,
                        };
                    }
                }
                "M" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().miter_limit = v;
                    }
                }
                "d" => {
                    // lopdf chuẩn hóa Type3 d0/d1 thành operator `d` với toàn
                    // toán hạng số. Chỉ Array mới là dash operator thật.
                    if let Some(arr) = operands.first().and_then(|o| pdf::num_array(self.doc, o)) {
                        let phase = num_operand(operands, 1).unwrap_or(0.0);
                        let gs = stack.current_mut();
                        gs.dash_array = arr;
                        gs.dash_phase = phase;
                    }
                }
                // Flatness / smoothness / rendering intent: ảnh hưởng tram ở RIP,
                // không ảnh hưởng lượng mực danh nghĩa ⇒ bỏ qua có chủ ý.
                "i" | "ri" => {}

                // ── Dựng đường dẫn ────────────────────────────────────────────
                "m" => {
                    if let (Some(x), Some(y)) = (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        path.builder.move_to(x, y);
                        path.start = Some((x, y));
                        path.current = Some((x, y));
                    }
                }
                "l" => {
                    if let (Some(x), Some(y)) = (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        if path.current.is_some() {
                            path.builder.line_to(x, y);
                            path.current = Some((x, y));
                            path.has_segments = true;
                        }
                    }
                }
                "c" => {
                    if operands.len() >= 6 && path.current.is_some() {
                        let v: Vec<f32> = (0..6).filter_map(|i| num_operand(operands, i)).collect();
                        if v.len() == 6 {
                            path.builder.cubic_to(v[0], v[1], v[2], v[3], v[4], v[5]);
                            path.current = Some((v[4], v[5]));
                            path.has_segments = true;
                        }
                    }
                }
                "v" => {
                    // Điểm điều khiển đầu = điểm hiện tại.
                    if operands.len() >= 4 {
                        if let Some((cx, cy)) = path.current {
                            let v: Vec<f32> =
                                (0..4).filter_map(|i| num_operand(operands, i)).collect();
                            if v.len() == 4 {
                                path.builder.cubic_to(cx, cy, v[0], v[1], v[2], v[3]);
                                path.current = Some((v[2], v[3]));
                                path.has_segments = true;
                            }
                        }
                    }
                }
                "y" => {
                    // Điểm điều khiển thứ hai = điểm cuối.
                    if operands.len() >= 4 {
                        if path.current.is_some() {
                            let v: Vec<f32> =
                                (0..4).filter_map(|i| num_operand(operands, i)).collect();
                            if v.len() == 4 {
                                path.builder.cubic_to(v[0], v[1], v[2], v[3], v[2], v[3]);
                                path.current = Some((v[2], v[3]));
                                path.has_segments = true;
                            }
                        }
                    }
                }
                "h" => {
                    if path.current.is_some() {
                        path.builder.close();
                        path.current = path.start;
                    }
                }
                "re" => {
                    if operands.len() >= 4 {
                        let v: Vec<f32> = (0..4).filter_map(|i| num_operand(operands, i)).collect();
                        if v.len() == 4 {
                            push_rect(&mut path.builder, v[0], v[1], v[2], v[3]);
                            path.start = Some((v[0], v[1]));
                            path.current = Some((v[0], v[1]));
                            path.has_segments = true;
                        }
                    }
                }

                // ── Vẽ đường dẫn ──────────────────────────────────────────────
                "n" => self.end_path(&mut path, stack, None, None, resources)?,
                "f" | "F" => {
                    self.end_path(&mut path, stack, Some(FillRule::NonZero), None, resources)?
                }
                "f*" => {
                    self.end_path(&mut path, stack, Some(FillRule::EvenOdd), None, resources)?
                }
                "S" => self.end_path(&mut path, stack, None, Some(false), resources)?,
                "s" => {
                    path.builder.close();
                    self.end_path(&mut path, stack, None, Some(false), resources)?
                }
                "B" => self.end_path(
                    &mut path,
                    stack,
                    Some(FillRule::NonZero),
                    Some(true),
                    resources,
                )?,
                "B*" => self.end_path(
                    &mut path,
                    stack,
                    Some(FillRule::EvenOdd),
                    Some(true),
                    resources,
                )?,
                "b" => {
                    path.builder.close();
                    self.end_path(
                        &mut path,
                        stack,
                        Some(FillRule::NonZero),
                        Some(true),
                        resources,
                    )?
                }
                "b*" => {
                    path.builder.close();
                    self.end_path(
                        &mut path,
                        stack,
                        Some(FillRule::EvenOdd),
                        Some(true),
                        resources,
                    )?
                }
                "W" => path.pending_clip = Some(FillRule::NonZero),
                "W*" => path.pending_clip = Some(FillRule::EvenOdd),

                // ── Màu ───────────────────────────────────────────────────────
                "g" | "G" => {
                    let stroke = op.operator == "G";
                    self.set_color_space(stack, stroke, ColorSpace::DeviceGray);
                    self.set_components(stack, stroke, collect_nums(operands, 1));
                }
                "rg" | "RG" => {
                    let stroke = op.operator == "RG";
                    self.set_color_space(stack, stroke, ColorSpace::DeviceRGB);
                    self.set_components(stack, stroke, collect_nums(operands, 3));
                }
                "k" | "K" => {
                    let stroke = op.operator == "K";
                    self.set_color_space(stack, stroke, ColorSpace::DeviceCMYK);
                    self.set_components(stack, stroke, collect_nums(operands, 4));
                }
                "cs" | "CS" => {
                    let stroke = op.operator == "CS";
                    if let Some(obj) = operands.first() {
                        match resolve_colorspace(self.doc, obj, resources, &mut self.warnings) {
                            Ok(cs) => {
                                let init = cs.initial_components();
                                self.set_color_space(stack, stroke, cs);
                                self.set_components(stack, stroke, init);
                            }
                            Err(e) => {
                                self.warnings.note_approximated_colorspace(&format!("{e}"));
                            }
                        }
                    }
                }
                "sc" | "scn" | "SC" | "SCN" => {
                    let stroke = matches!(op.operator.as_str(), "SC" | "SCN");
                    // `scn` có thể kết thúc bằng tên pattern; số thì lấy hết.
                    let nums: Vec<f32> = operands.iter().filter_map(|o| pdf::as_num(o)).collect();
                    // Toán hạng tên = pattern. Ghi tên vào trạng thái thay vì bỏ
                    // qua: lúc vẽ mới biết được đó là shading pattern (vẽ được)
                    // hay tiling pattern (chưa dựng), và chỉ loại đúng loại chưa
                    // dựng thì mới không mất oan những trang chỉ dùng gradient.
                    let pattern_name = operands.iter().rev().find_map(pdf::name_str);
                    let gs = stack.current_mut();
                    if stroke {
                        gs.stroke_pattern = pattern_name;
                    } else {
                        gs.fill_pattern = pattern_name;
                    }
                    if !nums.is_empty() {
                        self.set_components(stack, stroke, nums);
                    }
                }

                // ── Ảnh nội tuyến (operator tổng hợp, xem `inline_image`) ─────
                op_name if op_name == INLINE_OP => {
                    if self.oc_hidden_now() {
                        continue;
                    }
                    let index = num_operand(operands, 0).unwrap_or(-1.0) as i64;
                    match usize::try_from(index)
                        .ok()
                        .and_then(|i| inline_images.get(i))
                    {
                        Some(img) => {
                            // Ảnh nội tuyến đi đúng đường của ảnh XObject: cùng chuỗi
                            // filter, cùng lấy mẫu, cùng ngữ nghĩa overprint.
                            let img = img.clone();
                            self.draw_image(&img, resources, stack)?;
                        }
                        None => {
                            self.warnings.dropped_objects += 1;
                            self.warnings
                                .note_skipped_op("BI (chỉ số ảnh nội tuyến sai)");
                        }
                    }
                }

                // ── XObject ───────────────────────────────────────────────────
                "Do" => {
                    if let (Some(name), Some(res)) = (name_operand(operands, 0), resources) {
                        self.do_xobject(&name, res, stack, depth)?;
                    }
                }

                // ── Chưa hỗ trợ: ghi nhận trung thực ──────────────────────────
                "sh" => {
                    if let (Some(name), Some(res)) = (name_operand(operands, 0), resources) {
                        self.do_shading_op(&name, res, stack)?;
                    }
                }
                // ── Marked content / optional content ─────────────────────────
                "BDC" => {
                    // `BDC /OC …` mở một lớp có thể đang TẮT. Đây là rủi ro **ngược
                    // chiều** với `dropped_objects`: vẽ lớp đang tắt làm đo *thừa*
                    // mực. Xem `crate::oc` về việc vì sao dùng cấu hình `/Print`.
                    let mut hides = false;
                    if name_operand(operands, 0).as_deref() == Some("OC") {
                        match self.oc_operand_hidden(operands.get(1), resources) {
                            Some(true) => {
                                hides = true;
                                if self.oc_operand_print_only(operands.get(1), resources) {
                                    // Lớp này *hiện* trên màn hình nhưng khai không
                                    // in. Không hạ tin cậy — file đã tự khai — nhưng
                                    // phải để lại vết: đây đúng chỗ Ghostscript cho
                                    // số khác vì nó bỏ qua `/AS`.
                                    self.warnings.note_skipped_op(
                                        "BDC /OC (lớp khai không in — /PrintState /OFF)",
                                    );
                                }
                            }
                            Some(false) => {}
                            None => {
                                // Không quyết được ⇒ vẽ tiếp nhưng nói ra. Đoán "hiện"
                                // trong im lặng là cách sai tệ nhất ở đây.
                                self.warnings.hidden_content_risk = true;
                                self.warnings
                                    .note_skipped_op("BDC /OC (không quyết được trạng thái)");
                            }
                        }
                    }
                    if hides {
                        self.oc_hidden += 1;
                    }
                    marked_content.push(hides);
                }
                "BMC" => marked_content.push(false),
                "EMC" => match marked_content.pop() {
                    Some(true) => self.oc_hidden = self.oc_hidden.saturating_sub(1),
                    Some(false) => {}
                    None => self.warnings.note_skipped_op("EMC (không cân)"),
                },
                "MP" | "DP" => {}
                // ── Chữ ───────────────────────────────────────────────────────
                "BT" => {
                    self.text_obj = TextObject::default();
                    self.text_clip = None;
                    // Mốc để Python biết ghi path vào khối `BT … ET` nào. Đếm cả khi
                    // không thu thập: rẻ, và tránh hai đường code lệch nhau.
                    self.glyph_seq = 0;
                    if let Some(top) = self.stream_ctx.last_mut() {
                        top.1 += 1;
                    }
                }
                "ET" => self.finish_text_clip(stack)?,
                "Tf" => {
                    let size = num_operand(operands, 1).unwrap_or(0.0);
                    let name = name_operand(operands, 0).unwrap_or_default();
                    let font = self.lookup_font(&name, resources);
                    let gs = stack.current_mut();
                    gs.text.size = size;
                    gs.text.font_name = name;
                    gs.text.font = font;
                }
                "Tc" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.char_spacing = v;
                    }
                }
                "Tw" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.word_spacing = v;
                    }
                }
                "Tz" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.horizontal_scale = v / 100.0;
                    }
                }
                "TL" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.leading = v;
                    }
                }
                "Ts" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.rise = v;
                    }
                }
                "Tr" => {
                    if let Some(v) = num_operand(operands, 0) {
                        stack.current_mut().text.render_mode = TextRenderMode::from_code(v as i32);
                    }
                }
                "Td" => {
                    if let (Some(tx), Some(ty)) =
                        (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        self.text_obj.next_line_offset(tx, ty);
                    }
                }
                "TD" => {
                    // `TD` vừa xuống dòng vừa đặt leading = −ty (§9.4.2).
                    if let (Some(tx), Some(ty)) =
                        (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        stack.current_mut().text.leading = -ty;
                        self.text_obj.next_line_offset(tx, ty);
                    }
                }
                "Tm" => {
                    if let Some(m) = matrix_from(operands) {
                        self.text_obj.set_matrix(m);
                    }
                }
                "T*" => {
                    let leading = stack.current().text.leading;
                    self.text_obj.next_line_offset(0.0, -leading);
                }
                "Tj" => {
                    if let Some(bytes) = string_operand(operands, 0) {
                        self.show_text(&bytes, resources, stack, depth)?;
                    }
                }
                "TJ" => {
                    if let Some(Object::Array(items)) = operands.first() {
                        let items = items.clone();
                        for item in &items {
                            match item {
                                Object::String(bytes, _) => {
                                    self.show_text(bytes, resources, stack, depth)?
                                }
                                other => {
                                    // Số trong `TJ` dịch con trỏ, đơn vị 1/1000
                                    // không gian text, và mang dấu **ngược**.
                                    if let Some(adj) = pdf::as_num(other) {
                                        let gs = stack.current();
                                        let tx =
                                            -adj / 1000.0 * gs.text.size * gs.text.horizontal_scale;
                                        self.text_obj.advance(tx, 0.0);
                                    }
                                }
                            }
                        }
                    }
                }
                "'" => {
                    let leading = stack.current().text.leading;
                    self.text_obj.next_line_offset(0.0, -leading);
                    if let Some(bytes) = string_operand(operands, 0) {
                        self.show_text(&bytes, resources, stack, depth)?;
                    }
                }
                "\"" => {
                    // `aw ac string "` — đặt word/char spacing rồi xuống dòng và vẽ.
                    if let (Some(aw), Some(ac)) =
                        (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        let gs = stack.current_mut();
                        gs.text.word_spacing = aw;
                        gs.text.char_spacing = ac;
                    }
                    let leading = stack.current().text.leading;
                    self.text_obj.next_line_offset(0.0, -leading);
                    if let Some(bytes) = string_operand(operands, 2) {
                        self.show_text(&bytes, resources, stack, depth)?;
                    }
                }
                // `d0`/`d1` khai bề rộng glyph Type3; `d1` còn khai hộp bao và
                // yêu cầu bỏ mọi thao tác màu trong glyph. Bề rộng lấy từ /Widths
                // nên ở đây không cần gì.
                "d0" | "d1" | "BX" | "EX" => {}

                other => self.warnings.note_skipped_op(other),
            }
        }

        // `BDC` thừa khi stream kết thúc: đóng lại, nếu không một lớp tắt sẽ tắt luôn
        // phần còn lại của trang.
        let leaked = marked_content.iter().filter(|h| **h).count() as u32;
        if leaked > 0 {
            self.oc_hidden = self.oc_hidden.saturating_sub(leaked);
            self.warnings.note_skipped_op("BDC (không cân)");
        }

        // `q` thừa khi stream kết thúc: dọn về đúng độ sâu để form lồng nhau không
        // rò trạng thái ra ngoài.
        while stack.logical_depth() > entry_depth {
            stack.restore();
        }
        Ok(())
    }

    /// `true` khi con trỏ đang nằm trong một lớp optional content **đang tắt**.
    ///
    /// Chặn ở tầng *vẽ* chứ không ở tầng đọc operator: mọi thay đổi graphics state
    /// (`cm`, `gs`, clip, màu) trong khối tắt vẫn phải có hiệu lực, vì nội dung sau
    /// `EMC` kế thừa chúng.
    fn oc_hidden_now(&self) -> bool {
        self.oc_hidden > 0
    }

    /// Phân giải toán hạng thứ hai của `BDC /OC`: tên trong `/Properties`, hoặc dict.
    fn oc_operand_hidden(
        &self,
        operand: Option<&Object>,
        resources: Option<&Dictionary>,
    ) -> Option<bool> {
        let operand = operand?;
        if let Object::Name(_) = operand {
            let name = pdf::name_str(operand)?;
            let res = resources?;
            let props = pdf::dict_get_dict(self.doc, res, "Properties")?;
            let raw = props.get(name.as_bytes()).ok()?;
            return self.oc.is_hidden(self.doc, raw);
        }
        self.oc.is_hidden(self.doc, operand)
    }

    /// `true` nếu lớp bị tắt **chỉ vì** khai không in.
    fn oc_operand_print_only(
        &self,
        operand: Option<&Object>,
        resources: Option<&Dictionary>,
    ) -> bool {
        let Some(operand) = operand else { return false };
        if let Object::Name(_) = operand {
            let Some(name) = pdf::name_str(operand) else {
                return false;
            };
            let Some(res) = resources else { return false };
            let Some(props) = pdf::dict_get_dict(self.doc, res, "Properties") else {
                return false;
            };
            let Ok(raw) = props.get(name.as_bytes()) else {
                return false;
            };
            return self.oc.hidden_only_for_print(raw);
        }
        self.oc.hidden_only_for_print(operand)
    }

    /// Kiểm `/OC` trên chính XObject (§8.11.4.1). `true` = phải bỏ qua.
    fn xobject_oc_hidden(&mut self, entry: Option<Object>) -> bool {
        let Some(raw) = entry else { return false };
        match self.oc.is_hidden(self.doc, &raw) {
            Some(v) => v,
            None => {
                self.warnings.hidden_content_risk = true;
                self.warnings
                    .note_skipped_op("XObject /OC (không quyết được trạng thái)");
                false
            }
        }
    }

    fn set_color_space(&mut self, stack: &mut StateStack, stroke: bool, cs: ColorSpace) {
        if self.suppress_color_ops > 0 {
            return; // ô uncoloured pattern: màu do `scn` bên ngoài quyết định
        }
        let gs = stack.current_mut();
        if stroke {
            gs.stroke_cs = cs;
            gs.stroke_pattern = None;
        } else {
            gs.fill_cs = cs;
            gs.fill_pattern = None;
        }
    }

    fn set_components(&mut self, stack: &mut StateStack, stroke: bool, comps: Vec<f32>) {
        if comps.is_empty() || self.suppress_color_ops > 0 {
            return;
        }
        let gs = stack.current_mut();
        if stroke {
            gs.stroke_comps = comps;
        } else {
            gs.fill_comps = comps;
        }
    }

    /// Kết thúc đường dẫn: tô, vẽ nét, rồi áp clip đang chờ.
    ///
    /// Thứ tự này là bắt buộc theo §8.5.4: `W` không vẽ gì, nó chỉ đổi clip **sau
    /// khi** operator vẽ hiện tại hoàn tất.
    fn end_path(
        &mut self,
        path: &mut PathState,
        stack: &mut StateStack,
        fill: Option<FillRule>,
        stroke: Option<bool>,
        resources: Option<&Dictionary>,
    ) -> PpeResult<()> {
        let built = std::mem::take(&mut path.builder).finish();
        let pending_clip = path.pending_clip.take();
        let had_segments = path.has_segments;
        *path = PathState::default();

        // Lớp optional content đang tắt: KHÔNG tô, KHÔNG vẽ nét, nhưng `W` vẫn phải
        // đổi clip — clip là graphics state và nội dung sau `EMC` kế thừa nó.
        let (mut fill, mut stroke) = if self.oc_hidden_now() {
            (None, None)
        } else {
            (fill, stroke)
        };
        let fill_uses_pattern = uses_pattern_color_space(stack, false);
        let stroke_uses_pattern = uses_pattern_color_space(stack, true);
        let line_art_visible = self.allows_preview_object(PreviewObjectKind::LineArt);
        if fill.is_some()
            && (!line_art_visible
                || (!fill_uses_pattern
                    && !self
                        .opts
                        .allows_preview_color_space(&stack.current().fill_cs)))
        {
            fill = None;
        }
        if stroke.is_some()
            && (!line_art_visible
                || (!stroke_uses_pattern
                    && !self
                        .opts
                        .allows_preview_color_space(&stack.current().stroke_cs)))
        {
            stroke = None;
        }

        let Some(user_path) = built else {
            // Đường dẫn rỗng: nếu có `W` thì clip thành rỗng (đúng spec).
            if pending_clip.is_some() {
                let empty = Mask::new(self.raster.width(), self.raster.height()).ok_or(
                    PpeError::BadRasterSize {
                        w: self.raster.width() as i64,
                        h: self.raster.height() as i64,
                        dpi: 0.0,
                    },
                )?;
                let gs = stack.current_mut();
                gs.clip = Some(Arc::new(empty));
                gs.clip_region = Some(Region::EMPTY);
            }
            return Ok(());
        };
        if !had_segments && fill.is_none() && stroke.is_none() && pending_clip.is_none() {
            return Ok(());
        }

        let ctm = stack.current().ctm;
        let device_path = user_path.clone().transform(to_ts(&ctm));

        if let (Some(rule), Some(dev)) = (fill, device_path.as_ref()) {
            // Pattern đi đường riêng: màu không phải một giá trị mà là một hàm của
            // vị trí, nên không dựng được `InkPaint` duy nhất cho cả hình.
            if fill_uses_pattern {
                let owner = self.preview_object_kind(PreviewObjectKind::LineArt);
                match pattern_for(stack, false) {
                    Some(name) => {
                        self.paint_with_pattern(&name, resources, dev, rule, stack, false, owner)?;
                    }
                    None => {
                        self.note_missing_pattern_selection(false, dev, rule, stack);
                    }
                }
            } else {
                let paint = self.make_paint(stack, false)?;
                if let Some(paint) = paint {
                    let clip = stack.current().clip.clone();
                    let soft = stack.current().soft_mask.clone();
                    let paint_serial_before = self.paint_serial;
                    let mut painted_region = Region::EMPTY;
                    let Renderer {
                        raster,
                        buffer,
                        paint_serial,
                        ..
                    } = self;
                    let opaque_paint =
                        paint.alpha >= 1.0 - 1e-6 && soft.is_none() && paint.blend.is_normal();
                    let conservative = !self.opts.anti_alias
                        && self.opts.device_scale >= CONSERVATIVE_VECTOR_MIN_DEVICE_SCALE
                        && (self.opts.device_scale >= CONSERVATIVE_OPAQUE_ONLY_BELOW_SCALE
                            || opaque_paint)
                        && needs_conservative_vector_edge(dev, raster.width(), raster.height());
                    let coverage = if conservative {
                        raster.fill_path_conservative(
                            dev,
                            rule,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref(),
                        )
                    } else {
                        raster.fill_path(
                            dev,
                            rule,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref(),
                        )
                    };
                    if let Some(cov) = coverage {
                        let cov_region = cov.region;
                        buffer.composite_region(cov.data, cov.region, &paint)?;
                        if paint.alpha > 0.0 {
                            *paint_serial = paint_serial.wrapping_add(1);
                            painted_region = painted_region.union(cov_region);
                        }
                    }
                    // Vành fill-adjust (xem `Rasterizer::fill_adjust_ring`): bù
                    // khoảng nở scan-convert của RIP tham chiếu. Composite bằng
                    // Darken (chỉ-thêm-mực) và chỉ cho paint có mực: vành không
                    // bao giờ được khoét kênh khác hay hạ đỉnh TAC.
                    if conservative
                        && self.pattern_cell_depth == 0
                        && paint.ink.iter().any(|v| *v > 0.0)
                    {
                        if let Some(ring) = raster.fill_adjust_ring_checked(
                            dev,
                            rule,
                            clip.as_deref(),
                            soft.as_deref(),
                        )? {
                            let ring_region = ring.region;
                            buffer.composite_region_tac_guard(ring.data, ring.region, &paint)?;
                            if paint.alpha > 0.0 {
                                *paint_serial = paint_serial.wrapping_add(1);
                                painted_region = painted_region.union(ring_region);
                            }
                        }
                    }
                    let painted = *paint_serial != paint_serial_before;
                    if painted {
                        self.finish_surface_paint(soft.as_deref(), painted_region)?;
                    }
                }
            }
        }

        if stroke.is_some() {
            let stroke_params = stack.current().build_stroke();
            if let Some(outline) = stroke_to_path(&user_path, &stroke_params, &ctm) {
                let paint = if stroke_uses_pattern {
                    let owner = self.preview_object_kind(PreviewObjectKind::LineArt);
                    match pattern_for(stack, true) {
                        Some(name) => {
                            self.paint_with_pattern(
                                &name,
                                resources,
                                &outline,
                                FillRule::NonZero,
                                stack,
                                true,
                                owner,
                            )?;
                        }
                        None => {
                            self.note_missing_pattern_selection(
                                true,
                                &outline,
                                FillRule::NonZero,
                                stack,
                            );
                        }
                    }
                    None
                } else {
                    self.make_paint(stack, true)?
                };
                if let Some(paint) = paint {
                    let clip = stack.current().clip.clone();
                    let soft = stack.current().soft_mask.clone();
                    let paint_serial_before = self.paint_serial;
                    let mut painted_region = Region::EMPTY;
                    let Renderer {
                        raster,
                        buffer,
                        paint_serial,
                        ..
                    } = self;
                    // Stroke có thể bao quanh một bbox rất lớn nhưng outline của chính nét
                    // vẫn mảnh; vì vậy không dùng kích thước bbox để loại như path fill.
                    // Nét giữ ngưỡng 1.2 cũ: đo corpus 72 DPI cho thấy scan-convert
                    // nét của RIP tham chiếu MỎNG hơn quy tắc "chạm là phủ"; binarize
                    // nét ở 72 DPI làm nét nhạt đè lên đỉnh TAC của shading lân cận
                    // và hạ đỉnh (banner: −2.1 → −5.1 điểm khi bật).
                    let conservative = !self.opts.anti_alias
                        && self.opts.device_scale >= CONSERVATIVE_OPAQUE_ONLY_BELOW_SCALE;
                    let coverage = if conservative {
                        raster.fill_path_conservative(
                            &outline,
                            FillRule::NonZero,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref(),
                        )
                    } else {
                        raster.fill_path(
                            &outline,
                            FillRule::NonZero,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref(),
                        )
                    };
                    if let Some(cov) = coverage {
                        let cov_region = cov.region;
                        buffer.composite_region(cov.data, cov.region, &paint)?;
                        if paint.alpha > 0.0 {
                            *paint_serial = paint_serial.wrapping_add(1);
                            painted_region = painted_region.union(cov_region);
                        }
                    }
                    // KHÔNG nở vành cho nét: outline của nét đã qua "chạm là
                    // phủ" (mọi pixel nét đi qua đều tính), và đo corpus cho
                    // thấy RIP tham chiếu không nở nét thêm như nở fill — nở
                    // nữa chỉ phình mean (Hộp nước hoa +1.2/255 khi nở nét).
                    let painted = *paint_serial != paint_serial_before;
                    if painted {
                        self.finish_surface_paint(soft.as_deref(), painted_region)?;
                    }
                }
            }
        }

        if let (Some(rule), Some(dev)) = (pending_clip, device_path.as_ref()) {
            self.intersect_clip(stack, dev, rule)?;
        }

        Ok(())
    }

    /// Giao clip hiện hành với một đường dẫn (đã ở toạ độ thiết bị).
    fn intersect_clip(
        &mut self,
        stack: &mut StateStack,
        device_path: &Path,
        rule: FillRule,
    ) -> PpeResult<()> {
        let bounds = device_path.bounds();
        let next_region = Region::from_bounds(
            bounds.left(),
            bounds.top(),
            bounds.right(),
            bounds.bottom(),
            self.raster.width(),
            self.raster.height(),
        );
        let old_region = stack
            .current()
            .clip_region
            .unwrap_or_else(|| Region::full(self.raster.width(), self.raster.height()));
        let clip_region = intersect_regions(old_region, next_region);
        let mut mask = match &stack.current().clip {
            Some(existing) => (**existing).clone(),
            None => self.raster.full_clip(),
        };
        mask.intersect_path(
            device_path,
            rule.into(),
            self.opts.anti_alias,
            Transform::identity(),
        );
        let gs = stack.current_mut();
        gs.clip = Some(Arc::new(mask));
        gs.clip_region = Some(clip_region);
        Ok(())
    }

    /// Quy màu hiện hành về mực. `Ok(None)` = không vẽ (colorant `/None`, pattern).
    fn make_paint(&mut self, stack: &mut StateStack, stroke: bool) -> PpeResult<Option<InkPaint>> {
        let gs = stack.current();
        let (cs, comps, alpha, overprint) = if stroke {
            (
                gs.stroke_cs.clone(),
                gs.stroke_comps.clone(),
                gs.stroke_alpha,
                gs.stroke_overprint,
            )
        } else {
            (
                gs.fill_cs.clone(),
                gs.fill_comps.clone(),
                gs.fill_alpha,
                gs.fill_overprint,
            )
        };
        let opm = gs.overprint_mode;
        let blend = gs.blend_mode;
        let source_rgb = if self.blend_space == BlendSpace::DeviceRgb && !overprint {
            cs.to_device_rgb_for_blending(&comps)
        } else {
            None
        };
        let blend_rgb =
            if source_rgb.is_some() && self.color.is_some() && self.buffer.ensure_rgb_sidecar()? {
                source_rgb
            } else {
                None
            };
        self.mark_pre_icc_transparency_approximation(
            &cs,
            alpha,
            blend,
            gs.soft_mask.is_some(),
            blend_rgb.is_some(),
        );

        let Some((ink, declared)) = cs.to_ink(
            &comps,
            self.buffer.space_mut(),
            &mut self.warnings,
            self.color,
        )?
        else {
            return Ok(None);
        };
        self.buffer.sync_channels()?;

        // Vector mực phải dài đúng số kênh hiện tại (spot có thể vừa được thêm).
        let mut ink = ink;
        ink.resize(self.buffer.space().len(), 0.0);

        let mut paint = InkPaint {
            ink,
            declared,
            overprint,
            alpha: alpha.clamp(0.0, 1.0),
            blend,
            blend_rgb,
        };
        if opm == 1 && matches!(cs, ColorSpace::DeviceCMYK | ColorSpace::IccBased { .. }) {
            paint = paint.with_overprint_mode_1();
        }
        Ok(Some(paint))
    }

    /// Đánh dấu trường hợp màu chưa-phải-mực bị đổi ICC trước khi trộn trong suốt.
    ///
    /// PDF yêu cầu alpha/blend diễn ra trong blending color space của trang/group rồi mới
    /// quy kết quả sang thiết bị. `InkBuffer` hiện chỉ giữ CMYK/spot, nên đổi từng lớp
    /// RGB/Lab sang CMYK trước rồi mới trộn là một phép xấp xỉ phi tuyến có thể báo thiếu TAC.
    fn mark_pre_icc_transparency_approximation(
        &mut self,
        cs: &ColorSpace,
        alpha: f32,
        blend: BlendMode,
        has_mask: bool,
        direct_pre_icc_supported: bool,
    ) {
        let transparent = alpha < 1.0 - 1e-6 || !blend.is_normal() || has_mask;
        if self.blend_space == BlendSpace::DeviceCmyk {
            return;
        }
        if transparent && needs_pre_icc_blending(cs) && !direct_pre_icc_supported {
            self.warnings.unsupported_transparency = true;
            self.warnings
                .note_skipped_op("Transparency RGB/Lab: đang trộn trong ink space sau ICC");
        }
    }

    /// `gs` — áp ExtGState.
    fn apply_ext_gstate(
        &mut self,
        name: &str,
        resources: &Dictionary,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let Some(egs_dict) = pdf::dict_get_dict(self.doc, resources, "ExtGState") else {
            return Ok(());
        };
        let Some(entry) = pdf::dict_get_dict(self.doc, egs_dict, name) else {
            return Ok(());
        };

        // Sao chép giá trị trước khi mượn `stack` khả biến.
        let ca = pdf::dict_get(self.doc, entry, "ca").and_then(pdf::as_num);
        let ca_upper = pdf::dict_get(self.doc, entry, "CA").and_then(pdf::as_num);
        let lw = pdf::dict_get(self.doc, entry, "LW").and_then(pdf::as_num);
        let ml = pdf::dict_get(self.doc, entry, "ML").and_then(pdf::as_num);
        let op_fill = pdf::dict_get(self.doc, entry, "op").and_then(as_bool);
        let op_stroke = pdf::dict_get(self.doc, entry, "OP").and_then(as_bool);
        let opm = pdf::dict_get(self.doc, entry, "OPM").and_then(pdf::as_num);
        // `/SMask` là một trong hai giá trị: tên `/None` (xoá mặt nạ) hoặc dict.
        // Phân biệt được hai trường hợp là bắt buộc: coi `/None` như "có mặt nạ"
        // sẽ giữ nguyên mặt nạ cũ và che mất nội dung lẽ ra phải in.
        let smask_obj = pdf::dict_get(self.doc, entry, "SMask").cloned();
        let blend_name = pdf::dict_get(self.doc, entry, "BM").and_then(|o| match o {
            Object::Name(_) => pdf::name_str(o),
            Object::Array(items) => items.first().and_then(pdf::name_str),
            _ => None,
        });

        // Blend mode phải đọc **trước** khi dựng soft mask: mặt nạ được render bằng
        // một graphics state riêng và không được thừa hưởng blend của trang.
        let blend_mode = match &blend_name {
            Some(name) => match crate::blend::BlendMode::from_name(name) {
                Some(m) => Some(m),
                None => {
                    // Tên lạ: spec nói coi như `Normal`, nhưng vẫn ghi vết để biết
                    // file dùng gì.
                    self.warnings
                        .note_skipped_op(&format!("BM /{name} (tên lạ)"));
                    Some(crate::blend::BlendMode::Normal)
                }
            },
            None => None,
        };

        let soft_mask = match &smask_obj {
            None => None,
            Some(obj) if matches!(pdf::name_str(obj).as_deref(), Some("None")) => {
                Some(None) // xoá mặt nạ đang có
            }
            Some(obj) => {
                let dict = match pdf::deref(self.doc, obj) {
                    Object::Dictionary(d) => Some(d.clone()),
                    _ => None,
                };
                match dict {
                    Some(d) => match self.build_soft_mask(&d, stack, depth) {
                        Ok(Some((mask, events))) => {
                            let mask = Arc::new(mask);
                            self.register_soft_mask_events(&mask, events);
                            Some(Some(mask))
                        }
                        Ok(None) => None,
                        Err(error @ PpeError::Cancelled) => return Err(error),
                        Err(error @ PpeError::MemoryBudgetExceeded { .. }) => {
                            // Thiếu RAM là lỗi tài nguyên của cả lần render, không
                            // được nuốt rồi vẽ bỏ mặt nạ (sẽ đổ thừa mực lên trang).
                            return Err(error);
                        }
                        Err(e) => {
                            // Dựng mặt nạ thất bại ⇒ vẽ **không** mặt nạ sẽ đổ mực
                            // đúng vào chỗ file muốn che. Đó là báo *thừa* mực nên
                            // không giấu được: hạ tin cậy.
                            self.warnings.note_skipped_op(&format!("SMask ({e})"));
                            self.warnings.unsupported_transparency = true;
                            None
                        }
                    },
                    None => {
                        self.warnings
                            .note_skipped_op("SMask (không phải dictionary)");
                        self.warnings.unsupported_transparency = true;
                        None
                    }
                }
            }
        };

        if let Some(mode) = blend_mode {
            if !mode.is_separable()
                && (self.blend_space != BlendSpace::DeviceRgb || self.color.is_none())
            {
                // CORRECTNESS (audit 2026-08-10 §L6.5): bốn mode này chỉ exact
                // khi giữ được surface RGB của blending space. Đường CMYK là phép
                // quy gần đúng có chủ ý và phải hạ soundness để Viewer hybrid lùi.
                let name = blend_name.as_deref().unwrap_or("không rõ");
                self.warnings.note_approximated_colorspace(&format!(
                    "BlendMode /{name} ngoài blending space DeviceRGB"
                ));
            }
        }

        let gs = stack.current_mut();
        if let Some(m) = blend_mode {
            gs.blend_mode = m;
        }
        if let Some(m) = soft_mask {
            gs.soft_mask = m;
        }
        if let Some(v) = ca {
            gs.fill_alpha = v.clamp(0.0, 1.0);
        }
        if let Some(v) = ca_upper {
            gs.stroke_alpha = v.clamp(0.0, 1.0);
        }
        if let Some(v) = lw {
            gs.line_width = v;
        }
        if let Some(v) = ml {
            gs.miter_limit = v;
        }
        if self.opts.simulate_overprint {
            // `OP` áp cho cả hai nếu `op` không có mặt (§11.7.4.3).
            if let Some(v) = op_stroke {
                gs.stroke_overprint = v;
                if op_fill.is_none() {
                    gs.fill_overprint = v;
                }
            }
            if let Some(v) = op_fill {
                gs.fill_overprint = v;
            }
            if let Some(v) = opm {
                gs.overprint_mode = v as i32;
            }
        } else {
            // GS-SUNSET (audit 2026-07-27 §4.1): bản knockout phải vô hiệu hóa
            // cờ overprint ở mọi ExtGState, không thay đổi nội dung PDF nguồn.
            gs.stroke_overprint = false;
            gs.fill_overprint = false;
            gs.overprint_mode = 0;
        }
        Ok(())
    }

    /// Giao clip với `/BBox` của một form (đã có `/Matrix` trong `ctm`).
    ///
    /// `/BBox` là clip **bắt buộc** (§8.10.2): nội dung tràn ra ngoài phải bị cắt.
    /// Với soft mask nó còn quan trọng hơn — vùng ngoài BBox phải mang giá trị nền
    /// (`/BC`), không phải giá trị của nội dung gần nhất.
    fn intersect_bbox(
        &self,
        clip: Option<Arc<Mask>>,
        bbox: Option<Rect>,
        ctm: &Matrix,
    ) -> Option<Arc<Mask>> {
        self.intersect_bbox_for_extent(clip, bbox, ctm, self.raster.width(), self.raster.height())
    }

    fn intersect_bbox_for_extent(
        &self,
        clip: Option<Arc<Mask>>,
        bbox: Option<Rect>,
        ctm: &Matrix,
        width: u32,
        height: u32,
    ) -> Option<Arc<Mask>> {
        let Some(bbox) = bbox else { return clip };
        if bbox.is_empty() {
            return Mask::new(width, height).map(Arc::new);
        }
        let Some(p) = rect_path(bbox.x0, bbox.y0, bbox.width(), bbox.height()) else {
            return clip;
        };
        let Some(dev) = p.transform(to_ts(ctm)) else {
            return clip;
        };
        let mut mask = match &clip {
            Some(existing) => (**existing).clone(),
            None => {
                let mut full = Mask::new(width, height)?;
                full.data_mut().fill(255);
                full
            }
        };
        mask.intersect_path(
            &dev,
            FillRule::NonZero.into(),
            self.opts.anti_alias,
            Transform::identity(),
        );
        Some(Arc::new(mask))
    }

    /// Hộp pixel bảo thủ của `/BBox` sau CTM, đã kẹp vào raster hiện hành.
    fn bbox_region(&self, bbox: Option<Rect>, ctm: &Matrix, width: u32, height: u32) -> Region {
        let Some(bbox) = bbox else {
            return Region::full(width, height);
        };
        if bbox.is_empty() {
            return Region::EMPTY;
        }
        let corners = [
            ctm.apply(bbox.x0, bbox.y0),
            ctm.apply(bbox.x1, bbox.y0),
            ctm.apply(bbox.x0, bbox.y1),
            ctm.apply(bbox.x1, bbox.y1),
        ];
        let min_x = corners.iter().map(|point| point.0).fold(f32::MAX, f32::min);
        let max_x = corners.iter().map(|point| point.0).fold(f32::MIN, f32::max);
        let min_y = corners.iter().map(|point| point.1).fold(f32::MAX, f32::min);
        let max_y = corners.iter().map(|point| point.1).fold(f32::MIN, f32::max);
        Region::from_bounds(min_x, min_y, max_x, max_y, width, height)
    }

    /// Kiểm tra hình chữ nhật sau ma trận có thể giao raster hiện hành hay không.
    ///
    /// CORRECTNESS (audit 2026-08-31 §PPE-B01): annotation ngoài tile không được
    /// tạo cảnh báo fail-loud; toạ độ không hữu hạn cũng không đại diện pixel thật.
    pub(crate) fn rect_may_intersect_buffer(&self, rect: Rect, ctm: &Matrix) -> bool {
        if rect.is_empty() {
            return false;
        }
        let corners = [
            ctm.apply(rect.x0, rect.y0),
            ctm.apply(rect.x1, rect.y0),
            ctm.apply(rect.x0, rect.y1),
            ctm.apply(rect.x1, rect.y1),
        ];
        if corners
            .iter()
            .any(|point| !point.0.is_finite() || !point.1.is_finite())
        {
            return false;
        }
        !self
            .bbox_region(Some(rect), ctm, self.buffer.width(), self.buffer.height())
            .is_empty()
    }

    fn intersect_bbox_region(
        &self,
        current: Option<Region>,
        bbox: Option<Rect>,
        ctm: &Matrix,
        width: u32,
        height: u32,
    ) -> Region {
        let current = current.unwrap_or_else(|| Region::full(width, height));
        intersect_regions(current, self.bbox_region(bbox, ctm, width, height))
    }

    /// Chạy nội dung một Form XObject vào **buffer riêng** rồi trả buffer đó.
    ///
    /// Dùng chung cho transparency group và soft mask. Cách cài đặt là tạm đổi
    /// `self.buffer`: nhờ vậy cache font, cảnh báo, bộ rasterize và quản lý màu
    /// vẫn là của chung — dựng một `Renderer` thứ hai sẽ parse lại font cho từng
    /// group, và tệ hơn, làm cảnh báo của group biến mất khỏi báo cáo.
    fn render_form_into(
        &mut self,
        child: InkBuffer,
        data: &[u8],
        resources: Option<&Dictionary>,
        initial: GraphicsState,
        exact_paint_region: bool,
        depth: u32,
    ) -> PpeResult<(InkBuffer, Region, ExplicitMaskEvents)> {
        let child_extent = (child.width(), child.height());
        let child_raster = if child_extent != (self.raster.width(), self.raster.height()) {
            Some(Rasterizer::new_budgeted(
                child_extent.0,
                child_extent.1,
                &child,
            )?)
        } else {
            None
        };
        let parent = std::mem::replace(&mut self.buffer, child);
        let parent_raster = child_raster.map(|raster| std::mem::replace(&mut self.raster, raster));
        // CORRECTNESS (audit 2026-08-31 §PPE-A02/A05): paint và diagnostic
        // visibility trong surface phụ đều phải chờ bước dùng-mask/merge lên cha.
        let parent_paint_serial = self.paint_serial;
        let parent_painted_region =
            std::mem::replace(&mut self.surface_painted_region, Region::EMPTY);
        // Tracker của operation cha không được thấy paint nội bộ child; boundary
        // group/SMask chỉ merge footprint đã lọc sau khi child thành công.
        let parent_paint_region_trackers = std::mem::take(&mut self.paint_region_trackers);
        let parent_exact_paint_region =
            std::mem::replace(&mut self.exact_paint_region, exact_paint_region);
        let parent_explicit_mask_events = std::mem::take(&mut self.surface_explicit_mask_events);
        self.render_surface_depth = self.render_surface_depth.saturating_add(1);
        // Text object không được rò qua ranh giới group: `BT` bên trong group là một
        // khối chữ độc lập.
        let saved_text_obj = self.text_obj;
        let saved_text_clip = self.text_clip.take();
        let mut sub = StateStack::new(initial);
        let result = self.execute(data, resources, &mut sub, depth + 1);
        self.text_obj = saved_text_obj;
        self.text_clip = saved_text_clip;
        self.render_surface_depth = self.render_surface_depth.saturating_sub(1);
        let child = std::mem::replace(&mut self.buffer, parent);
        if let Some(parent_raster) = parent_raster {
            self.raster = parent_raster;
        }
        let child_painted_region =
            std::mem::replace(&mut self.surface_painted_region, parent_painted_region);
        self.paint_region_trackers = parent_paint_region_trackers;
        self.exact_paint_region = parent_exact_paint_region;
        self.paint_serial = parent_paint_serial;
        let child_explicit_mask_events = std::mem::replace(
            &mut self.surface_explicit_mask_events,
            parent_explicit_mask_events,
        );
        result.map(|()| (child, child_painted_region, child_explicit_mask_events))
    }

    /// Dựng soft mask từ `/SMask` của ExtGState (§11.6.5).
    ///
    /// Trả về một cửa sổ giá trị 0.0..=1.0 ở **toạ độ thiết bị** cùng giá trị nền
    /// dùng ngoài cửa sổ.
    ///
    /// # Hai kiểu, hai ý nghĩa nền
    ///
    /// * `/S /Luminosity` — mặt nạ là **độ sáng** của group sau khi vẽ trên nền
    ///   `/BC`. Mặc định `/BC` là đen, tức mặt nạ = 0 ⇒ ngoài `/BBox` **không có gì
    ///   được in**. Đây là nguồn lỗi kinh điển: bỏ nền đen mặc định làm mặt nạ hoá
    ///   thành 1 ở khắp nơi và mực tràn ra toàn trang.
    /// * `/S /Alpha` — mặt nạ là **độ phủ** của group; `/BC` không có nghĩa và nền
    ///   luôn là 0.
    fn build_soft_mask(
        &mut self,
        smask: &Dictionary,
        stack: &StateStack,
        depth: u32,
    ) -> PpeResult<Option<(SoftMask, ExplicitMaskEvents)>> {
        if self.smask_depth >= MAX_SOFT_MASK_DEPTH {
            return Err(PpeError::Unsupported("soft mask lồng quá sâu".into()));
        }

        let luminosity = match pdf::dict_get(self.doc, smask, "S")
            .and_then(pdf::name_str)
            .as_deref()
        {
            Some("Luminosity") => true,
            Some("Alpha") => false,
            Some(other) => {
                return Err(PpeError::Unsupported(format!("SMask /S /{other}")));
            }
            None => return Err(PpeError::MalformedPdf("SMask thiếu /S".into())),
        };

        let g_obj = smask
            .get(b"G")
            .map_err(|_| PpeError::MalformedPdf("SMask thiếu /G".into()))?
            .clone();
        let stream = match pdf::deref(self.doc, &g_obj) {
            Object::Stream(s) => s.clone(),
            _ => {
                return Err(PpeError::MalformedPdf(
                    "SMask /G không phải Form XObject".into(),
                ))
            }
        };
        let decoded = pdf::decode_stream(self.doc, &stream);
        let stream_recovered = decoded.quality == pdf::DecodeQuality::Recovered;
        let data = decoded.bytes;

        let form_matrix = pdf::dict_get(self.doc, &stream.dict, "Matrix")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
            .unwrap_or(Matrix::IDENTITY);
        let bbox = pdf::dict_get(self.doc, &stream.dict, "BBox")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 4).then(|| Rect::new(v[0], v[1], v[2], v[3])));
        let form_res = pdf::dict_get_dict(self.doc, &stream.dict, "Resources").cloned();
        let group_cs = pdf::dict_get_dict(self.doc, &stream.dict, "Group")
            .and_then(|g| g.get(b"CS").ok())
            .cloned();
        let bc = pdf::dict_get(self.doc, smask, "BC").and_then(|o| pdf::num_array(self.doc, o));
        let tr = pdf::dict_get(self.doc, smask, "TR")
            .filter(|o| !matches!(pdf::name_str(o).as_deref(), Some("Identity")))
            .cloned();

        // Mặt nạ dựng theo CTM **tại thời điểm `gs`**, không theo CTM lúc vẽ.
        let ctm = form_matrix.then(&stack.current().ctm);

        let mask_cs = if luminosity {
            Some(match &group_cs {
                Some(o) => resolve_colorspace(self.doc, o, form_res.as_ref(), &mut self.warnings)
                    .unwrap_or(ColorSpace::DeviceGray),
                None => ColorSpace::DeviceGray,
            })
        } else {
            None
        };
        // MEMORY (audit 2026-08-09 §PRE.0B): chỉ đường managed mới duy trì
        // `blend_rgb` đủ để dùng sidecar làm luminosity. Unmanaged cấp sidecar
        // rồi vẫn fallback CMYK, vừa tốn RAM vừa có thể làm render bị từ chối.
        let rgb_luminosity = self.color.is_some()
            && mask_cs
                .as_ref()
                .map(ColorSpace::supports_device_rgb_blending)
                .unwrap_or(false);

        // PERF (audit 2026-08-09 §RENDER.F4): `/BBox` có thể là sentinel
        // ±32768 trong khi clip thật chỉ vài pixel. Dựng đúng giao ba vùng để cả
        // buffer con lẫn mặt phẳng kết quả tỷ lệ với phần có thể nhìn thấy.
        let raster_width = self.buffer.width();
        let raster_height = self.buffer.height();
        let clip_region = stack
            .current()
            .clip_region
            .unwrap_or_else(|| Region::full(raster_width, raster_height));
        // CORRECTNESS (audit 2026-08-09 §PRE.0A): mỗi tầng ảnh có thể lấy cực
        // đại soft-mask trong bán kính 3 px. Với mặt nạ lồng, vùng phụ thuộc
        // cộng dồn theo số tầng còn lại; lề 1 px của Region::from_bounds chỉ đủ
        // cho khử răng cưa và không được tính thay guard-band này.
        let remaining_levels = MAX_SOFT_MASK_DEPTH.saturating_sub(self.smask_depth);
        let sample_guard = (SOFT_MASK_PEAK_RADIUS as u32).saturating_mul(remaining_levels);
        let sample_region = expand_region(clip_region, sample_guard, raster_width, raster_height);
        let window = intersect_regions(
            sample_region,
            self.bbox_region(bbox, &ctm, raster_width, raster_height),
        );
        // Cửa sổ rỗng vẫn cần một pixel tạm để tính `/BC` của Luminosity. Pixel
        // này không được lưu vào mặt nạ và không phụ thuộc kích thước trang.
        let child_width = (window.x1 - window.x0).max(1);
        let child_height = (window.y1 - window.y0).max(1);
        let mut child = if rgb_luminosity {
            self.buffer
                .child_isolated_rgb_region(child_width, child_height)?
        } else {
            self.buffer
                .child_isolated_region(child_width, child_height)?
        };
        if let Some(cs) = &mask_cs {
            let comps = bc.unwrap_or_else(|| cs.initial_components());
            if let Some((ink, declared)) =
                cs.to_ink(&comps, child.space_mut(), &mut self.warnings, self.color)?
            {
                child.sync_channels()?;
                let mut ink = ink;
                ink.resize(child.space().len(), 0.0);
                let mut paint = InkPaint::opaque(ink, declared);
                if rgb_luminosity && child.ensure_rgb_sidecar()? {
                    paint.blend_rgb = cs.to_device_rgb_for_blending(&comps);
                }
                child.composite_solid(&paint)?;
            }
        }
        let backdrop = if luminosity {
            if rgb_luminosity && child.has_complete_rgb_luminosity() {
                child
                    .rgb_luminosity_at(0)
                    .unwrap_or_else(|| child.luminosity_at(0))
            } else {
                child.luminosity_at(0)
            }
        } else {
            0.0
        };

        let transfer_lut = if let Some(tr_obj) = tr {
            match resolve_function(self.doc, &tr_obj) {
                Ok(function) => {
                    let mut lut = [0.0_f32; 256];
                    for (index, value) in lut.iter_mut().enumerate() {
                        let input = index as f32 / 255.0;
                        *value = function
                            .eval(&[input])
                            .first()
                            .copied()
                            .unwrap_or(input)
                            .clamp(0.0, 1.0);
                    }
                    Some(lut)
                }
                Err(error) => {
                    // Không đọc được `/TR`: giữ mặt nạ thô nhưng hạ độ tin cậy.
                    self.warnings
                        .note_skipped_op(&format!("SMask /TR ({error})"));
                    self.warnings.unsupported_transparency = true;
                    None
                }
            }
        } else {
            None
        };
        let apply_transfer = |value: f32| {
            let Some(lut) = transfer_lut.as_ref() else {
                return value.clamp(0.0, 1.0);
            };
            let index = (value.clamp(0.0, 1.0) * 255.0 + 0.5) as usize;
            lut[index.min(255)]
        };

        if window.is_empty() {
            // ISO 32000-1 §7.5.4: ngoài BBox, Alpha dùng TR(0.0), còn
            // Luminosity dùng TR(luminosity(BC)). `backdrop` đã là đúng đầu
            // vào cho cả hai trường hợp (0 với Alpha).
            let outside = apply_transfer(backdrop);
            return Ok(Some((
                self.buffer.new_soft_mask(Region::EMPTY, outside)?,
                HashMap::new(),
            )));
        }

        // Nội dung form được dịch về gốc cửa sổ; CTM của mặt nạ vẫn được neo tại
        // thời điểm `gs`, chỉ thay hệ pixel cục bộ để tránh raster toàn trang.
        let local_ctm = ctm.then(&Matrix::translate(-(window.x0 as f32), -(window.y0 as f32)));
        let mut initial = GraphicsState::initial(local_ctm);
        let local_bbox_clip =
            self.intersect_bbox_for_extent(None, bbox, &local_ctm, child_width, child_height);
        initial.clip = local_bbox_clip.clone();
        initial.clip_region = Some(self.bbox_region(bbox, &local_ctm, child_width, child_height));

        let saved_blend_space = self.blend_space;
        if rgb_luminosity {
            self.blend_space = BlendSpace::DeviceRgb;
        }
        self.smask_depth += 1;
        let rendered =
            self.render_form_into(child, &data, form_res.as_ref(), initial, false, depth);
        self.smask_depth -= 1;
        self.blend_space = saved_blend_space;
        let (rendered, _, explicit_mask_events) = rendered?;
        // `render_form_into` vừa chạy trên child có gốc (0,0), còn SoftMask được
        // tra bằng toạ độ surface cha. Không dịch provenance ở đây sẽ lọc sai mọi
        // cửa sổ SMask không bắt đầu tại gốc trang.
        let mut explicit_mask_events = translate_explicit_mask_events(
            explicit_mask_events,
            window.x0,
            window.y0,
            self.buffer.width(),
            self.buffer.height(),
        );
        if stream_recovered {
            let event = self.allocate_deferred_event(DeferredDiagnostic::SoftMaskStreamDecode);
            explicit_mask_events.insert(event, window);
        }

        let outside = apply_transfer(backdrop);
        let mut mask = self.buffer.new_soft_mask(window, outside)?;
        let use_rgb = luminosity && rgb_luminosity && rendered.has_complete_rgb_luminosity();
        for (index, value) in mask.values_mut().iter_mut().enumerate() {
            if index % 4096 == 0 {
                self.opts.check_cancelled()?;
            }
            if !luminosity
                && local_bbox_clip
                    .as_ref()
                    .is_some_and(|clip| clip.data().get(index).copied().unwrap_or(0) == 0)
            {
                // CORRECTNESS (audit 2026-08-09 §PRE.0A): cửa sổ BBox có lề
                // khử răng cưa 1 px; pixel trong lề vẫn phải nhận TR(0), giống
                // mọi điểm khác nằm ngoài BBox của subtype Alpha.
                *value = outside;
                continue;
            }
            let raw = if luminosity {
                if use_rgb {
                    rendered
                        .rgb_luminosity_at(index)
                        .unwrap_or_else(|| rendered.luminosity_at(index))
                } else {
                    rendered.luminosity_at(index)
                }
            } else {
                rendered.alpha_plane().get(index).copied().unwrap_or(0.0)
            };
            *value = apply_transfer(raw);
        }
        Ok(Some((mask, explicit_mask_events)))
    }

    /// `Do` — vẽ XObject.
    fn do_xobject(
        &mut self,
        name: &str,
        resources: &Dictionary,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let Some(xobjects) = pdf::dict_get_dict(self.doc, resources, "XObject") else {
            return Ok(());
        };
        let Ok(entry_ref) = xobjects.get(name.as_bytes()) else {
            return Ok(());
        };
        // Lấy khoá stream NGAY, dạng dữ liệu thuần: nó phải sống qua các lệnh `&mut
        // self` phía dưới, còn `entry_ref` thì mượn từ `self.doc`.
        let form_key = match entry_ref {
            Object::Reference((id, gen)) => StreamKey::Form(*id, *gen),
            _ => StreamKey::Unaddressable,
        };
        // Giữ bản tham chiếu gốc cho image cache; `entry` bên dưới là stream đã
        // deref nên không còn ObjectId để định danh mẫu nguồn.
        let image_ref = entry_ref.clone();
        let entry = pdf::deref(self.doc, entry_ref);
        let Object::Stream(stream) = entry else {
            return Ok(());
        };

        // Form và ảnh là **tự chứa**: chúng không đổi được trạng thái của stream gọi
        // (mọi `q` đều được dọn khi ra). Nên trong lớp tắt có thể bỏ qua trọn vẹn,
        // thay vì chạy rồi chặn từng thao tác vẽ.
        if self.oc_hidden_now() {
            return Ok(());
        }
        let oc_entry = stream.dict.get(b"OC").ok().cloned();
        if self.xobject_oc_hidden(oc_entry) {
            return Ok(());
        }

        let subtype = pdf::dict_get(self.doc, &stream.dict, "Subtype")
            .and_then(pdf::name_str)
            .unwrap_or_default();

        match subtype.as_str() {
            "Form" => {
                let form_matrix = pdf::dict_get(self.doc, &stream.dict, "Matrix")
                    .and_then(|o| pdf::num_array(self.doc, o))
                    .and_then(|v| {
                        (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5]))
                    })
                    .unwrap_or(Matrix::IDENTITY);
                let bbox = pdf::dict_get(self.doc, &stream.dict, "BBox")
                    .and_then(|o| pdf::num_array(self.doc, o))
                    .and_then(|v| (v.len() >= 4).then(|| Rect::new(v[0], v[1], v[2], v[3])));
                let form_res = pdf::dict_get_dict(self.doc, &stream.dict, "Resources")
                    .cloned()
                    .or_else(|| Some(resources.clone()));
                // CORRECTNESS (audit 2026-09-01 §PPE-E2): helper chung giữ
                // provenance recovery; Form chỉ fail-loud khi BBox thật sự giao
                // clip hiện hành, nên resource lỗi ngoài viewport vẫn sạch.
                let decoded = pdf::decode_stream(self.doc, stream);
                let decompression_failed = decoded.quality == pdf::DecodeQuality::Recovered;
                let data = decoded.bytes;
                if decompression_failed {
                    let form_ctm = form_matrix.then(&stack.current().ctm);
                    let visible_region = self.intersect_bbox_region(
                        stack.current().clip_region,
                        bbox,
                        &form_ctm,
                        self.buffer.width(),
                        self.buffer.height(),
                    );
                    let clip = stack.current().clip.clone();
                    let visible = if visible_region.is_empty() {
                        false
                    } else if let Some(mask) = clip.as_deref() {
                        let width = self.buffer.width() as usize;
                        any_pixel_where_cancelled(
                            visible_region,
                            self.opts.cancel_token.as_ref(),
                            |x, y| mask.data()[y as usize * width + x as usize] > 0,
                        )?
                    } else {
                        true
                    };
                    if visible {
                        self.warnings.note_skipped_op(FORM_STREAM_DECODE_REASON);
                        self.warnings.dropped_objects =
                            self.warnings.dropped_objects.saturating_add(1);
                    }
                }

                // Transparency group (§11.6.6): `/Group << /S /Transparency >>`.
                let group = pdf::dict_get_dict(self.doc, &stream.dict, "Group").filter(|g| {
                    pdf::dict_get(self.doc, g, "S")
                        .and_then(pdf::name_str)
                        .as_deref()
                        == Some("Transparency")
                });
                let (isolated, knockout) = match group {
                    Some(g) => (
                        pdf::dict_get(self.doc, g, "I")
                            .and_then(as_bool)
                            .unwrap_or(false),
                        pdf::dict_get(self.doc, g, "K")
                            .and_then(as_bool)
                            .unwrap_or(false),
                    ),
                    None => (false, false),
                };

                // Chữ bên trong form thuộc content stream CỦA FORM, không phải của
                // trang — Python thay khối `BT … ET` theo từng stream.
                self.stream_ctx.push((form_key, 0));
                if let Some(group_dict) = group {
                    // Group non-isolated luôn kế thừa blending space từ backdrop;
                    // `/CS` chỉ chọn space riêng cho group isolated.
                    let group_blend_space = if !isolated {
                        self.blend_space
                    } else if let Some(group_cs_obj) =
                        pdf::dict_get(self.doc, group_dict, "CS").cloned()
                    {
                        match resolve_colorspace(
                            self.doc,
                            &group_cs_obj,
                            form_res.as_ref(),
                            &mut self.warnings,
                        ) {
                            Ok(group_cs) => {
                                let space = blend_space_for_colorspace(&group_cs);
                                if space == BlendSpace::Other && needs_pre_icc_blending(&group_cs) {
                                    self.warnings.unsupported_transparency = true;
                                    self.warnings.note_skipped_op(
                                        "Group RGB/Lab: cần buffer theo blending color space trước ICC",
                                    );
                                }
                                space
                            }
                            Err(_) => BlendSpace::Other,
                        }
                    } else {
                        self.blend_space
                    };
                    let result = self.do_transparency_group(
                        &data,
                        form_res.as_ref(),
                        form_matrix,
                        bbox,
                        isolated,
                        knockout,
                        group_blend_space,
                        stack,
                        depth,
                    );
                    self.stream_ctx.pop();
                    return result;
                }

                if !self.save_internal_state(stack) {
                    // `stream_ctx` đã push ở đầu Form; skip sớm vẫn phải cân.
                    self.stream_ctx.pop();
                    return Ok(());
                }
                {
                    let gs = stack.current_mut();
                    gs.ctm = form_matrix.then(&gs.ctm);
                }
                // `BBox` là clip bắt buộc (§8.10.2): nội dung tràn ra ngoài BBox
                // phải bị cắt. Bỏ qua sẽ cho mực ra ngoài vùng hợp lệ.
                let ctm = stack.current().ctm;
                let clip = stack.current().clip.clone();
                let clip_region = self.intersect_bbox_region(
                    stack.current().clip_region,
                    bbox,
                    &ctm,
                    self.buffer.width(),
                    self.buffer.height(),
                );
                let gs = stack.current_mut();
                gs.clip = self.intersect_bbox(clip, bbox, &ctm);
                gs.clip_region = Some(clip_region);
                let saved_depth = stack.logical_depth();
                let result = self.execute_with_ctm(&data, form_res.as_ref(), stack, depth + 1, ctm);
                while stack.logical_depth() > saved_depth {
                    stack.restore();
                }
                stack.restore();
                // Pop trước khi bung lỗi: một lỗi giữa form không được để lại khoá
                // stream của form trên ngăn xếp và gán chữ của trang cho nó.
                self.stream_ctx.pop();
                result?;
            }
            "Image" => self.draw_image(&image_ref, Some(resources), stack)?,
            other => {
                self.warnings.note_skipped_op(&format!("Do (/{other})"));
            }
        }
        Ok(())
    }

    /// Vẽ một transparency group (§11.6.6).
    ///
    /// # Ba đường, chọn theo đúng thứ group khai báo
    ///
    /// 1. **Đường nhanh** — group đục (`ca = 1`), không soft mask, `BM /Normal`,
    ///    không cách ly. Vẽ thẳng lên nền: kết quả *bằng đúng* mô hình group, không
    ///    xấp xỉ. Phần lớn group trong file thật rơi vào đây.
    /// 2. **Không cách ly** — buffer con khởi tạo bằng chính mực nền, nên overprint
    ///    và blend của từng phần tử bên trong nhìn thấy nền thật. Composite lại chỉ
    ///    là nội suy theo `ca × soft mask`, và phép nội suy đó **chính xác** (xem
    ///    [`InkBuffer::merge_non_isolated`]).
    /// 3. **Cách ly** — buffer con nền trắng; màu group lấy được bằng cách chia lại
    ///    alpha, rồi blend với nền.
    #[allow(clippy::too_many_arguments)]
    fn do_transparency_group(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        form_matrix: Matrix,
        bbox: Option<Rect>,
        isolated: bool,
        knockout: bool,
        group_blend_space: BlendSpace,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let gs = stack.current();
        // `Do` là thao tác không-nét, nên group dùng `ca` chứ không phải `CA`.
        let ca = gs.fill_alpha.clamp(0.0, 1.0);
        let blend = gs.blend_mode;
        let soft = gs.soft_mask.clone();
        let overprint = gs.fill_overprint;
        let ctm = form_matrix.then(&gs.ctm);
        let parent_clip = gs.clip.clone();
        let parent_clip_region = gs.clip_region;
        let group_region = self.intersect_bbox_region(
            parent_clip_region,
            bbox,
            &ctm,
            self.buffer.width(),
            self.buffer.height(),
        );

        if knockout {
            // Knockout group: mỗi phần tử composite với nền **ban đầu** của group,
            // không với phần tử vẽ trước nó. Chưa dựng ⇒ vùng chồng lấn sẽ đọc ra
            // nhiều mực hơn thực tế.
            self.warnings.unsupported_transparency = true;
            self.warnings.note_skipped_op("Group /K true (knockout)");
        }

        let transparent = ca < 1.0 - 1e-6 || soft.is_some();
        if !transparent && blend.is_normal() && !isolated {
            if !self.save_internal_state(stack) {
                return Ok(());
            }
            stack.current_mut().ctm = ctm;
            let clip = stack.current().clip.clone();
            let gs = stack.current_mut();
            gs.clip = self.intersect_bbox(clip, bbox, &ctm);
            gs.clip_region = Some(group_region);
            let saved_depth = stack.logical_depth();
            let result = self.execute(data, resources, stack, depth + 1);
            while stack.logical_depth() > saved_depth {
                stack.restore();
            }
            stack.restore();
            return result;
        }

        // Trạng thái khởi tạo của group thừa hưởng trạng thái hiện hành **trừ**
        // alpha, blend và soft mask (§11.6.6). Ba thứ đó áp cho *cả group* ở bước
        // composite; để chúng lọt vào trong sẽ nhân hai lần tại mọi vùng các phần
        // tử chồng nhau — đúng kiểu lỗi làm bóng mờ đậm gấp đôi.
        let mut initial = stack.current().clone();
        initial.ctm = ctm;
        initial.fill_alpha = 1.0;
        initial.stroke_alpha = 1.0;
        initial.blend_mode = BlendMode::Normal;
        initial.soft_mask = None;
        initial.clip = self.intersect_bbox(parent_clip, bbox, &ctm);
        initial.clip_region = Some(group_region);

        let rgb_group = group_blend_space == BlendSpace::DeviceRgb && self.color.is_some();
        let child = if rgb_group && isolated {
            self.buffer.child_isolated_rgb()?
        } else if rgb_group {
            if self.buffer.ensure_rgb_sidecar()? {
                self.buffer.child_non_isolated_rgb()?
            } else {
                self.buffer.child_non_isolated()?
            }
        } else if isolated {
            self.buffer.child_isolated()?
        } else {
            self.buffer.child_non_isolated()?
        };

        let exact_group_paint_region =
            self.exact_paint_region || !self.paint_region_trackers.is_empty();
        let saved_blend_space = self.blend_space;
        self.blend_space = group_blend_space;
        let rendered = self.render_form_into(
            child,
            data,
            resources,
            initial,
            exact_group_paint_region,
            depth,
        );
        self.blend_space = saved_blend_space;
        let (mut child, child_painted_region, child_explicit_mask_events) = rendered?;

        if rgb_group {
            let has_group_content = child.alpha_plane().iter().any(|alpha| *alpha > 1e-6);
            if !isolated && has_group_content && !child.has_rgb_sidecar() {
                self.warnings.unsupported_transparency = true;
                self.warnings.note_skipped_op(
                    "Group DeviceRGB non-isolated: không sao chép được RGB backdrop",
                );
            }
        }
        if rgb_group && isolated {
            let has_group_content = child.alpha_plane().iter().any(|alpha| *alpha > 1e-6);
            let rgb_surface_ok = match self.color {
                Some(color) if child.has_rgb_sidecar() => child.finalize_rgb(color),
                _ => false,
            };
            if has_group_content && !rgb_surface_ok {
                self.warnings.unsupported_transparency = true;
                self.warnings.note_skipped_op(
                    "Group DeviceRGB isolated: nội dung không giữ được hoàn toàn trên RGB surface",
                );
            }
        }

        // Spot chỉ xuất hiện bên trong group vẫn phải có kẽm ở trang cha.
        self.buffer.adopt_channels_from(&child)?;
        self.opts.check_cancelled()?;

        // CORRECTNESS (audit 2026-08-31 §PPE-A02/A05): paint nội bộ child đã
        // được cô lập; boundary chỉ commit phần vừa có child alpha vừa qua external
        // SMask. Scan bbox đầy đủ chỉ bật trên đường diagnostic có event pending.
        let merged_region = group_region
            .clamped(self.buffer.width(), self.buffer.height())
            .clamped(child.width(), child.height());
        let child_merge_region = intersect_regions(child_painted_region, merged_region);
        let host_soft_has_pending_events = soft
            .as_deref()
            .is_some_and(|mask| self.soft_mask_has_pending_events(mask));
        let child_width = child.width() as usize;
        let group_painted_region = if ca <= 0.0 || child_merge_region.is_empty() {
            Region::EMPTY
        } else {
            match soft.as_deref() {
                Some(mask) if host_soft_has_pending_events || exact_group_paint_region => {
                    bounding_region_where_cancelled(
                        child_merge_region,
                        self.opts.cancel_token.as_ref(),
                        |x, y| {
                            let index = y as usize * child_width + x as usize;
                            child
                                .alpha_plane()
                                .get(index)
                                .is_some_and(|alpha| *alpha > 0.0)
                                && mask.value_at(x, y) > 0.0
                        },
                    )?
                }
                Some(mask) => {
                    let paints = any_pixel_where_cancelled(
                        child_merge_region,
                        self.opts.cancel_token.as_ref(),
                        |x, y| {
                            let index = y as usize * child_width + x as usize;
                            child
                                .alpha_plane()
                                .get(index)
                                .is_some_and(|alpha| *alpha > 0.0)
                                && mask.value_at(x, y) > 0.0
                        },
                    )?;
                    if paints {
                        child_merge_region
                    } else {
                        Region::EMPTY
                    }
                }
                None => child_merge_region,
            }
        };

        // Mỗi event child phải tự vượt boundary. `ca = 0`, event đã report và
        // group không paint đều thoát trước scan; đường hiếm còn lại poll mỗi hàng.
        let mut visible_child_events = ExplicitMaskEvents::new();
        if !group_painted_region.is_empty() {
            for (event, event_region) in child_explicit_mask_events {
                if self.reported_explicit_mask_events.contains(&event) {
                    continue;
                }
                let candidate = intersect_regions(event_region, child_merge_region);
                let region = bounding_region_where_cancelled(
                    candidate,
                    self.opts.cancel_token.as_ref(),
                    |x, y| {
                        let index = y as usize * child_width + x as usize;
                        child
                            .alpha_plane()
                            .get(index)
                            .is_some_and(|alpha| *alpha > 0.0)
                            && soft.as_deref().is_none_or(|mask| mask.value_at(x, y) > 0.0)
                    },
                )?;
                if !region.is_empty() {
                    visible_child_events.insert(event, region);
                }
            }
        }

        if isolated {
            self.buffer
                .merge_isolated(&child, group_region, ca, soft.as_deref(), blend, overprint);
        } else {
            self.buffer.merge_non_isolated(
                &child,
                group_region,
                ca,
                soft.as_deref(),
                blend,
                overprint,
            );
        }
        self.opts.check_cancelled()?;
        if !group_painted_region.is_empty() {
            // `note_surface_paint` còn có thể lỗi/hủy khi lọc host SMask. Chỉ
            // commit event child sau khi boundary đó hoàn tất.
            self.note_surface_paint(soft.as_deref(), group_painted_region)?;
            self.accept_explicit_mask_events(visible_child_events);
        }
        Ok(())
    }

    /// Khóa cache ảnh chỉ cho dictionary có colorspace tự chứa.
    ///
    /// Tên colorspace lấy từ `/Resources` có thể trỏ tới định nghĩa khác trong
    /// mỗi Form XObject; cache theo ObjectId trong trường hợp đó sẽ đổi màu ảnh.
    fn image_cache_key(&self, entry: &Object) -> Option<ObjectId> {
        let Object::Reference(id) = entry else {
            return None;
        };
        let Object::Stream(stream) = pdf::deref(self.doc, entry) else {
            return None;
        };
        if matches!(
            pdf::dict_get(self.doc, &stream.dict, "ImageMask"),
            Some(Object::Boolean(true))
        ) {
            return Some(*id);
        }
        let colorspace = pdf::dict_get(self.doc, &stream.dict, "ColorSpace")
            .or_else(|| pdf::dict_get(self.doc, &stream.dict, "CS"))
            .map(|object| pdf::deref(self.doc, object))?;
        match colorspace {
            Object::Name(name)
                if matches!(
                    name.as_slice(),
                    b"DeviceGray" | b"DeviceRGB" | b"DeviceCMYK"
                ) =>
            {
                Some(*id)
            }
            _ => None,
        }
    }

    /// Giải mã một ảnh và tái dùng mẫu nguồn trong phạm vi lần render hiện hành.
    fn decode_image_cached(
        &mut self,
        entry: &Object,
        resources: Option<&Dictionary>,
    ) -> PpeResult<Arc<SampledImage>> {
        self.opts.check_cancelled()?;
        let key = self.image_cache_key(entry);
        if let Some(key) = key {
            if let Some(cached) = self.image_cache.get(&key) {
                self.opts.check_cancelled()?;
                return Ok(Arc::clone(&cached.image));
            }
            if let Some(shared) = &self.shared_resource_cache {
                let cached = shared
                    .lock()
                    .map_err(|_| PpeError::Unsupported("resource cache bị khóa hỏng".into()))?
                    .get_image(key);
                if let Some((cached, warnings)) = cached {
                    self.opts.check_cancelled()?;
                    merge_render_warnings(&mut self.warnings, &warnings);
                    self.pin_image_for_request(key, &cached);
                    return Ok(cached);
                }
            }
        }
        let mut decode_warnings = RenderWarnings::default();
        let image = Arc::new(decode_image_with_cancel(
            self.doc,
            entry,
            resources,
            &mut decode_warnings,
            self.opts.cancel_token.as_ref(),
        )?);
        // CORRECTNESS (audit 2026-08-10 §L5B.3): token có thể đổi trạng thái
        // đúng sau byte cuối codec; chặn ở đây để ảnh stale không lọt vào cache.
        self.opts.check_cancelled()?;
        merge_render_warnings(&mut self.warnings, &decode_warnings);
        if let Some(key) = key {
            // Cache là quick-win tùy ngân sách: thiếu chỗ thì bỏ cache và vẫn
            // render đúng, không biến một tối ưu thành lỗi tài nguyên.
            if let Some(shared) = &self.shared_resource_cache {
                let _ = shared
                    .lock()
                    .map_err(|_| PpeError::Unsupported("resource cache bị khóa hỏng".into()))?
                    .insert_image(key, Arc::clone(&image), decode_warnings);
            }
            self.pin_image_for_request(key, &image);
        }
        Ok(image)
    }

    /// Ghim ảnh trong một request để eviction cache session không gây decode
    /// lặp ngay trong cùng content stream. Thiếu budget thì bỏ tối ưu này.
    fn pin_image_for_request(&mut self, key: ObjectId, image: &Arc<SampledImage>) {
        if self.image_cache.contains_key(&key) {
            return;
        }
        if let Ok(lease) = self.buffer.reserve_temporary(image.memory_bytes()) {
            self.image_cache.insert(
                key,
                CachedImage {
                    image: Arc::clone(image),
                    _memory_lease: lease,
                },
            );
        }
    }

    /// Vẽ một ảnh XObject.
    ///
    /// # Hướng lấy mẫu
    ///
    /// Ảnh PDF luôn chiếm **hình vuông đơn vị** `[0,1]²` trong toạ độ người dùng
    /// (§8.9.5.2); mọi phép co giãn/xoay nằm trong CTM. Nên engine không "vẽ ảnh
    /// lên trang" mà đi ngược: với mỗi pixel **thiết bị**, nghịch đảo CTM để tìm
    /// pixel ảnh tương ứng.
    ///
    /// Cách này quan trọng vì ảnh in thường 300–600 DPI trong khi khung render là
    /// 100–150 DPI: duyệt theo pixel thiết bị làm chi phí tỉ lệ với **kích thước
    /// hiển thị**, không phải kích thước ảnh, và xử lý xoay/nghiêng miễn phí.
    ///
    /// Ảnh phóng đại và vùng mực thường lấy **nearest neighbour**. Khi thu nhỏ,
    /// nếu mẫu tâm đã ở vùng nguy hiểm (TAC hiệu dụng ≥ 300%), renderer xét thêm
    /// footprint và chọn texel có TAC cao nhất. Soft mask của ảnh cũng dùng cực đại
    /// lân cận nhỏ. Hai quy tắc bảo thủ này tránh false-clean nhưng không làm tối
    /// toàn bộ ảnh như phép max-filter áp vô điều kiện.
    fn draw_image(
        &mut self,
        entry: &Object,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
    ) -> PpeResult<()> {
        self.opts.check_cancelled()?;
        if !self.allows_preview_object(PreviewObjectKind::Image)
            && !self.opts.needs_source_space_for_preview()
        {
            return Ok(());
        }
        let ctm = stack.current().ctm;

        // Hộp bao của hình vuông đơn vị sau biến đổi, kẹp vào khung raster.
        let corners = [
            ctm.apply(0.0, 0.0),
            ctm.apply(1.0, 0.0),
            ctm.apply(0.0, 1.0),
            ctm.apply(1.0, 1.0),
        ];
        let min_x = corners.iter().map(|c| c.0).fold(f32::MAX, f32::min);
        let max_x = corners.iter().map(|c| c.0).fold(f32::MIN, f32::max);
        let min_y = corners.iter().map(|c| c.1).fold(f32::MAX, f32::min);
        let max_y = corners.iter().map(|c| c.1).fold(f32::MIN, f32::max);
        let buf_w = self.buffer.width() as i64;
        let buf_h = self.buffer.height() as i64;

        // PERF (audit 2026-08-08 §RENDER.3): bbox ảnh không phụ thuộc dữ liệu
        // stream. Loại XObject hoàn toàn ngoài viewport trước khi giải nén để ảnh
        // lớn lặp lại ở vùng khác của trang không chiếm CPU/RAM cho từng tile.
        let finite_bounds =
            min_x.is_finite() && max_x.is_finite() && min_y.is_finite() && max_y.is_finite();
        if finite_bounds
            && (max_x <= 0.0 || max_y <= 0.0 || min_x >= buf_w as f32 || min_y >= buf_h as f32)
        {
            return Ok(());
        }

        let img = match self.decode_image_cached(entry, resources) {
            Ok(img) => img,
            Err(error @ PpeError::Cancelled) => return Err(error),
            Err(e) => {
                // Không giải mã được (JPX, CCITT, dữ liệu hỏng): ghi nhận để hạ
                // accuracy. Trang có ảnh mà báo "sạch TAC" là kiểu sai tệ nhất.
                self.warnings.note_skipped_op(&format!("Do ảnh ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };
        self.opts.check_cancelled()?;
        let is_stencil = img.stencil.is_some();
        let stencil_uses_pattern = is_stencil && uses_pattern_color_space(stack, false);
        let source_color_space = if is_stencil {
            Some(&stack.current().fill_cs)
        } else {
            img.colorspace.as_ref()
        };
        // Pattern không có một source colorspace duy nhất; filter màu được áp tại
        // từng sink trong cell, còn host vẫn phải nằm trong lane Images.
        if !self.allows_preview_object(PreviewObjectKind::Image)
            || (!stencil_uses_pattern
                && source_color_space
                    .is_none_or(|color_space| !self.opts.allows_preview_color_space(color_space)))
        {
            return Ok(());
        }
        // CORRECTNESS (audit 2026-08-31 §PPE-A05): metadata lỗi nằm trong mẫu
        // cache, nhưng diagnostic là của từng placement có coverage hữu hiệu.
        let explicit_mask_warning_pending = img.explicit_mask_decode_failed;

        // Ảnh có `/SMask` lấy mẫu trên lưới CĂNG-BBOX thay vì lưới CTM chính
        // xác — xem `mask_sample_ctm`. Không có bước này, mọi ảnh mờ thu nhỏ
        // lệch pha lấy mẫu với RIP tham chiếu và kẽm nhiễu đốm toàn vùng ảnh
        // (tra gung @72: 60% pixel kẽm lệch, d_tac −8.2 điểm).
        let sample_ctm = if img.alpha.is_some() {
            mask_sample_ctm(&ctm, min_x, max_x, min_y, max_y)
        } else {
            ctm
        };
        let Some(inv) = sample_ctm.invert() else {
            // CTM suy biến (scale 0): ảnh không chiếm diện tích nào.
            return Ok(());
        };
        // Nghịch đảo lấy mẫu tính bằng **f64**: với ảnh ~1500 texel, sai số f32
        // của nghịch-đảo-rồi-nhân là ~5e-4 texel — đủ lật mẫu ở pixel có toạ độ
        // rơi sát biên texel (đo được ~200 pixel lật trên một trang nhãn thật;
        // texel kề mang giá trị bất kỳ nên mỗi cú lật là ±255 trên kẽm). `inv`
        // f32 vẫn dùng cho ước lượng footprint, nơi nửa texel không đáng kể.
        let inv64 = {
            let (a, b, c, d, e, f) = (
                sample_ctm.a as f64,
                sample_ctm.b as f64,
                sample_ctm.c as f64,
                sample_ctm.d as f64,
                sample_ctm.e as f64,
                sample_ctm.f as f64,
            );
            let det = a * d - b * c;
            let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
            [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
        };

        let x0 = (min_x.floor() as i64).max(0);
        let x1 = (max_x.ceil() as i64).min(buf_w);
        let y0 = (min_y.floor() as i64).max(0);
        let y1 = (max_y.ceil() as i64).min(buf_h);
        if x0 >= x1 || y0 >= y1 {
            return Ok(());
        }
        let stencil_pattern = if stencil_uses_pattern {
            stack.current().fill_pattern.clone()
        } else {
            None
        };

        let (base_alpha, overprint, blend, clip, soft, overprint_mode) = {
            let gs = stack.current();
            (
                gs.fill_alpha.clamp(0.0, 1.0),
                gs.fill_overprint,
                gs.blend_mode,
                gs.clip.clone(),
                gs.soft_mask.clone(),
                gs.overprint_mode,
            )
        };
        if base_alpha <= 0.0 {
            return Ok(());
        }

        // CORRECTNESS (audit 2026-08-31 §PPE-A02): Pattern là hàm theo vị trí,
        // nên ImageMask phải trở thành một clip coverage rồi dispatch painter đúng
        // một lần. Image CTM chỉ dựng hình học stencil; painter vẫn ghép
        // `pattern_matrix.then(stream_base_ctm)` và không bị scale theo ảnh.
        if stencil_uses_pattern {
            let mut stencil_mask = Mask::new(self.raster.width(), self.raster.height()).ok_or(
                PpeError::BadRasterSize {
                    w: self.raster.width() as i64,
                    h: self.raster.height() as i64,
                    dpi: 0.0,
                },
            )?;
            let mask_data = stencil_mask.data_mut();
            let iw = img.width as f64;
            let ih = img.height as f64;
            let mut stencil_region = Region::EMPTY;
            for dy in y0..y1 {
                self.opts.check_cancelled()?;
                for dx in x0..x1 {
                    let (px, py) = (dx as f64 + 0.5, dy as f64 + 0.5);
                    let u = inv64[0] * px + inv64[2] * py + inv64[4];
                    let v = inv64[1] * px + inv64[3] * py + inv64[5];
                    if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                        continue;
                    }
                    let sx = tex_index(u * iw, img.width);
                    let sy = tex_index((1.0 - v) * ih, img.height);
                    let index = dy as usize * buf_w as usize + dx as usize;
                    let clip_coverage = clip
                        .as_ref()
                        .map_or(1.0, |mask| mask.data()[index] as f32 / 255.0);
                    if clip_coverage <= 0.0 {
                        continue;
                    }
                    let mut image_alpha = 0.0f32;
                    for (candidate_sx, candidate_sy) in
                        image_sample_candidates(inv, dx, dy, img.width, img.height, (sx, sy))
                    {
                        if img.stencil_at(candidate_sx, candidate_sy) {
                            image_alpha = image_alpha.max(img.alpha_at(candidate_sx, candidate_sy));
                        }
                    }
                    let coverage = image_alpha * clip_coverage;
                    if coverage > 0.0 {
                        mask_data[index] = (coverage.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                        include_pixel(&mut stencil_region, dx as u32, dy as u32);
                    }
                }
            }
            if stencil_region.is_empty() {
                return Ok(());
            }

            let Some(image_path) =
                rect_path(0.0, 0.0, 1.0, 1.0).and_then(|path| path.transform(to_ts(&ctm)))
            else {
                return Ok(());
            };
            let old_region = stack
                .current()
                .clip_region
                .unwrap_or_else(|| Region::full(self.raster.width(), self.raster.height()));
            let pattern_host_region = intersect_regions(old_region, stencil_region);
            let mut initial = stack.current().clone();
            initial.clip = Some(Arc::new(stencil_mask));
            initial.clip_region = Some(pattern_host_region);
            // `soft_mask` và `fill_alpha` vẫn nằm trong state tạm: pattern painter
            // sẽ nhân mỗi lớp đúng một lần rồi xoá soft mask ở cell con.
            let mut pattern_stack = StateStack::new(initial);
            let paint_serial_before = self.paint_serial;
            match stencil_pattern.as_deref() {
                Some(pattern_name) => {
                    self.paint_with_pattern(
                        pattern_name,
                        resources,
                        &image_path,
                        FillRule::NonZero,
                        &mut pattern_stack,
                        false,
                        PreviewObjectKind::Image,
                    )?;
                }
                None => {
                    self.note_missing_pattern_selection(
                        false,
                        &image_path,
                        FillRule::NonZero,
                        &pattern_stack,
                    );
                }
            }
            // Chỉ commit diagnostic khi một sink trong Pattern đã vượt object +
            // source filter và composite thật. Pattern bị filter/clip không được
            // biến một invocation vô hình thành `ink_unsound`.
            if explicit_mask_warning_pending && self.paint_serial != paint_serial_before {
                let event_region = match soft.as_deref() {
                    Some(mask) => bounding_region_where_cancelled(
                        pattern_host_region,
                        self.opts.cancel_token.as_ref(),
                        |x, y| mask.value_at(x, y) > 0.0,
                    )?,
                    None => pattern_host_region,
                };
                self.defer_explicit_mask_failure(event_region);
            }
            return Ok(());
        }

        // Stencil (`/ImageMask`) lấy màu từ trạng thái tô hiện hành, không từ ảnh.
        let stencil_paint = if is_stencil {
            match self.make_paint(stack, false)? {
                Some(p) => Some(p),
                None => return Ok(()), // colorant /None
            }
        } else {
            None
        };

        let image_rgb_sidecar = self.blend_space == BlendSpace::DeviceRgb
            && !overprint
            && img.supports_device_rgb()
            && self.color.is_some()
            && self.buffer.ensure_rgb_sidecar()?;
        if let Some(cs) = &img.colorspace {
            self.mark_pre_icc_transparency_approximation(
                cs,
                base_alpha,
                blend,
                soft.is_some() || img.alpha.is_some(),
                image_rgb_sidecar,
            );
        }
        // Như ở shading: `OPM = 1` phải được áp cho cả đường ảnh, vì ảnh cũng dựng
        // `InkPaint` trực tiếp cho từng pixel thay vì đi qua `make_paint`.
        let opm_one = overprint_mode == 1
            && matches!(
                img.colorspace,
                Some(ColorSpace::DeviceCMYK) | Some(ColorSpace::IccBased { .. })
            );

        let sampler = ImageSampler::new(
            &img,
            self.buffer.space_mut(),
            &mut self.warnings,
            self.color,
        )?;
        self.buffer.sync_channels()?;
        let static_process_channels =
            matches!(img.colorspace, Some(ColorSpace::DeviceCMYK)) && !img.has_matte();

        // PERF (audit 2026-08-14 §VIEW.IMAGE): Viewer trước đây lấy đúng một texel
        // ở tâm dù đang thu ảnh CMYK 300–600 DPI xuống màn hình. menu.pdf @96 DPI
        // có footprint khoảng 5,2×5,2 texel, nên nét chữ mảnh rơi khỏi toàn bộ trang.
        // Chỉ đường xem ảnh CMYK đục dùng lưới phủ footprint; đường đo mực bảo thủ,
        // ảnh có alpha và zoom gần 1:1 giữ nguyên hợp đồng cũ.
        let preview_cmyk_grid = if !self.opts.conservative_image_sampling
            && static_process_channels
            && img.alpha.is_none()
            && !overprint
            && blend == BlendMode::Normal
        {
            preview_image_sample_grid(&inv64, img.width, img.height)
        } else {
            (1, 1)
        };

        let mut ink_scratch: Vec<f32> = Vec::with_capacity(8);
        let iw = img.width as f64;
        let ih = img.height as f64;
        let paint_serial_before = self.paint_serial;
        let mut painted_region = Region::EMPTY;

        for dy in y0..y1 {
            // PERF (audit 2026-08-09 §ZOOM.7): một atomic-load mỗi hàng giúp request zoom
            // cũ nhả session trong vài mili-giây thay vì dựng hết bitmap rồi mới bỏ kết quả.
            self.opts.check_cancelled()?;
            for dx in x0..x1 {
                // Tâm pixel thiết bị → toạ độ ảnh trong hình vuông đơn vị.
                let (px, py) = (dx as f64 + 0.5, dy as f64 + 0.5);
                let u = inv64[0] * px + inv64[2] * py + inv64[4];
                let v = inv64[1] * px + inv64[3] * py + inv64[5];
                if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                    continue;
                }
                // Hàng 0 của ảnh nằm ở **đỉnh** hình vuông đơn vị (v = 1), nên
                // phải lật v. Quên bước này thì ảnh in ngược trên-dưới.
                let sx = tex_index(u * iw, img.width);
                let sy = tex_index((1.0 - v) * ih, img.height);

                let index = (dy as usize) * (buf_w as usize) + (dx as usize);
                let mut common_coverage = 1.0;
                if let Some(mask) = &clip {
                    common_coverage *= mask.data()[index] as f32 / 255.0;
                }
                if let Some(sm) = &soft {
                    common_coverage *= image_soft_mask_value(
                        sm,
                        dx,
                        dy,
                        buf_w,
                        buf_h,
                        self.opts.conservative_image_sampling,
                    );
                }
                if common_coverage <= 0.0 {
                    continue;
                }

                if is_stencil {
                    let candidates =
                        image_sample_candidates(inv, dx, dy, img.width, img.height, (sx, sy));
                    let mut best = None;
                    for (candidate_sx, candidate_sy) in candidates {
                        if !img.stencil_at(candidate_sx, candidate_sy) {
                            continue;
                        }
                        let coverage =
                            base_alpha * img.alpha_at(candidate_sx, candidate_sy) * common_coverage;
                        if coverage > 0.0 && best.is_none_or(|old: f32| coverage > old) {
                            best = Some(coverage);
                        }
                    }
                    if let Some(coverage) = best {
                        if let Some(paint) = &stencil_paint {
                            let mut p = paint.clone();
                            p.alpha = coverage;
                            self.buffer.composite_at(index, 1.0, &p);
                            self.paint_serial = self.paint_serial.wrapping_add(1);
                            include_pixel(&mut painted_region, dx as u32, dy as u32);
                        }
                    }
                    continue;
                }

                let mut sample_sx = sx;
                let mut sample_sy = sy;
                let mut center_coverage = base_alpha * img.alpha_at(sx, sy) * common_coverage;
                if center_coverage <= 0.0 {
                    if !self.opts.conservative_image_sampling {
                        continue;
                    }
                    // Alpha tại tâm bằng 0: tham chiếu (nearest trên cùng lưới
                    // căng-bbox) cũng bỏ pixel này — TRỪ khi mẫu rơi trong dải
                    // nhiễu quanh biên texel, nơi GS có thể lấy texel kề có
                    // alpha. Trước khi lưới được căn đúng, chỗ này từng lấy
                    // TRUNG BÌNH alpha footprint để cứu nét 1-texel (Steam Iron
                    // @72: −21/255) — nhưng đó là bù cho lệch pha lưới; giữ nó
                    // sau khi căn lưới làm ảnh mask thu nhỏ dư mực so với GS
                    // (túi nước mắm @72: mean kẽm 3.15, giá trị 21/38 không có
                    // thật trên kẽm tham chiếu).
                    if base_alpha * common_coverage > 0.0 {
                        let alt_x = texel_tie_alternate(u * iw, img.width, sx);
                        let alt_y = texel_tie_alternate((1.0 - v) * ih, img.height, sy);
                        for (cx, cy) in [(alt_x, Some(sy)), (Some(sx), alt_y), (alt_x, alt_y)]
                            .into_iter()
                            .filter_map(|(a, b)| Some((a?, b?)))
                        {
                            let a = img.alpha_at(cx, cy);
                            if a * base_alpha * common_coverage > center_coverage {
                                center_coverage = a * base_alpha * common_coverage;
                                sample_sx = cx;
                                sample_sy = cy;
                            }
                        }
                    }
                    if center_coverage <= 0.0 {
                        continue;
                    }
                }
                let (sx, sy) = (sample_sx, sample_sy);
                let center_mask = if preview_cmyk_grid != (1, 1) {
                    match preview_device_cmyk_raw_average(
                        &inv64,
                        dx,
                        dy,
                        img.width,
                        img.height,
                        preview_cmyk_grid,
                        |sample_x, sample_y| img.device_cmyk_raw_at(sample_x, sample_y),
                    ) {
                        Some(raw_average) => {
                            let footprint = img.decode_device_cmyk_units(raw_average.footprint);
                            let core = raw_average
                                .core
                                .map(|value| img.decode_device_cmyk_units(value));
                            let cmyk = boost_preview_device_cmyk_detail(footprint, core);
                            ink_scratch.clear();
                            ink_scratch.resize(self.buffer.space().len(), 0.0);
                            ink_scratch[..4].copy_from_slice(&cmyk);
                            Some(ChannelMask::PROCESS)
                        }
                        None => sampler.ink_into(
                            sx,
                            sy,
                            &mut ink_scratch,
                            self.buffer.space_mut(),
                            &mut self.warnings,
                            self.color,
                        )?,
                    }
                } else {
                    sampler.ink_into(
                        sx,
                        sy,
                        &mut ink_scratch,
                        self.buffer.space_mut(),
                        &mut self.warnings,
                        self.color,
                    )?
                };
                let Some(center_declared) = center_mask else {
                    continue;
                };
                if !static_process_channels {
                    self.buffer.sync_channels()?;
                }
                ink_scratch.resize(self.buffer.space().len(), 0.0);
                if !self.opts.conservative_image_sampling {
                    // PERF (audit 2026-08-09 §ZOOM.6): Viewer lấy đúng texel/alpha
                    // tại tâm pixel. Không dựng score/candidate bảo thủ của đường
                    // đo TAC; composite thẳng và tái dùng cùng scratch Vec.
                    let mut paint = InkPaint {
                        ink: std::mem::take(&mut ink_scratch),
                        declared: center_declared,
                        overprint,
                        alpha: center_coverage,
                        blend,
                        blend_rgb: if image_rgb_sidecar {
                            img.device_rgb_at(sx, sy)
                        } else {
                            None
                        },
                    };
                    if opm_one {
                        paint = paint.with_overprint_mode_1();
                    }
                    self.buffer.composite_at(index, 1.0, &paint);
                    self.paint_serial = self.paint_serial.wrapping_add(1);
                    include_pixel(&mut painted_region, dx as u32, dy as u32);
                    ink_scratch = paint.ink;
                    continue;
                }
                let center_score = ink_scratch.iter().copied().sum::<f32>() * center_coverage;
                let mut best = (
                    sx,
                    sy,
                    center_coverage,
                    center_declared,
                    std::mem::take(&mut ink_scratch),
                    center_score,
                );

                // Mẫu rơi trong dải nhiễu số học quanh biên texel: RIP tham chiếu
                // có thể chọn phía bên kia (đo được ~23 pixel như vậy trên một
                // ảnh nhãn thật — trong đó có đúng pixel đỉnh TAC của trang,
                // GS 297.6% vs mẫu tâm 291.8%). Không thể tái lập nhiễu float
                // nội bộ của GS, nên trong dải này đánh giá CẢ hai phía và giữ
                // phía nhiều mực hơn — chiều sai an toàn của prepress, bị chặn
                // ±1 texel và chỉ chạm ~0.2% mẫu nên không phồng ảnh thường.
                let mut tie_candidates: Vec<(u32, u32)> = Vec::new();
                let alt_x = texel_tie_alternate(u * iw, img.width, sx);
                let alt_y = texel_tie_alternate((1.0 - v) * ih, img.height, sy);
                if let Some(ax) = alt_x {
                    tie_candidates.push((ax, sy));
                }
                if let Some(ay) = alt_y {
                    tie_candidates.push((sx, ay));
                }
                if let (Some(ax), Some(ay)) = (alt_x, alt_y) {
                    tie_candidates.push((ax, ay));
                }
                for (candidate_sx, candidate_sy) in tie_candidates {
                    let coverage =
                        base_alpha * img.alpha_at(candidate_sx, candidate_sy) * common_coverage;
                    if coverage <= 0.0 {
                        continue;
                    }
                    let mask = sampler.ink_into(
                        candidate_sx,
                        candidate_sy,
                        &mut ink_scratch,
                        self.buffer.space_mut(),
                        &mut self.warnings,
                        self.color,
                    )?;
                    let Some(declared) = mask else { continue };
                    self.buffer.sync_channels()?;
                    ink_scratch.resize(self.buffer.space().len(), 0.0);
                    let score = ink_scratch.iter().copied().sum::<f32>() * coverage;
                    if score > best.5 {
                        best = (
                            candidate_sx,
                            candidate_sy,
                            coverage,
                            declared,
                            std::mem::take(&mut ink_scratch),
                            score,
                        );
                    }
                }

                if center_score >= IMAGE_FOOTPRINT_TAC_THRESHOLD {
                    let candidates =
                        image_sample_candidates(inv, dx, dy, img.width, img.height, (sx, sy));
                    for (candidate_sx, candidate_sy) in candidates.into_iter().skip(1) {
                        let coverage =
                            base_alpha * img.alpha_at(candidate_sx, candidate_sy) * common_coverage;
                        if coverage <= 0.0 {
                            continue;
                        }
                        let mask = sampler.ink_into(
                            candidate_sx,
                            candidate_sy,
                            &mut ink_scratch,
                            self.buffer.space_mut(),
                            &mut self.warnings,
                            self.color,
                        )?;
                        let Some(declared) = mask else { continue };
                        // DeviceN trong ảnh có thể đăng ký spot mới giữa vòng lặp.
                        self.buffer.sync_channels()?;
                        ink_scratch.resize(self.buffer.space().len(), 0.0);
                        let score = ink_scratch.iter().copied().sum::<f32>() * coverage;
                        if score > best.5 {
                            best = (
                                candidate_sx,
                                candidate_sy,
                                coverage,
                                declared,
                                std::mem::take(&mut ink_scratch),
                                score,
                            );
                        }
                    }
                }

                let (best_sx, best_sy, coverage, declared, mut ink, _) = best;
                let mut paint = InkPaint {
                    ink: std::mem::take(&mut ink),
                    declared,
                    overprint,
                    alpha: coverage,
                    blend,
                    blend_rgb: if image_rgb_sidecar {
                        img.device_rgb_at(best_sx, best_sy)
                    } else {
                        None
                    },
                };
                if opm_one {
                    paint = paint.with_overprint_mode_1();
                }
                self.buffer.composite_at(index, 1.0, &paint);
                if paint.alpha > 0.0 {
                    self.paint_serial = self.paint_serial.wrapping_add(1);
                    include_pixel(&mut painted_region, dx as u32, dy as u32);
                }
                ink_scratch = paint.ink;
            }
        }
        if self.paint_serial != paint_serial_before {
            // Lọc/propagate host SMask còn có thể bị hủy. Event của chính image
            // chỉ vào transaction/surface sau khi bước fallible này thành công.
            self.finish_surface_paint(soft.as_deref(), painted_region)?;
            if explicit_mask_warning_pending {
                self.defer_explicit_mask_failure(painted_region);
            }
        }

        Ok(())
    }

    /// `sh` — tô shading lên **toàn bộ vùng clip hiện hành** (§8.7.4.2).
    ///
    /// Khác đường pattern: `sh` không có đường dẫn nào giới hạn, vùng phủ chính là
    /// clip. Nhầm hai đường này làm gradient tràn ra ngoài hình cần tô.
    fn do_shading_op(
        &mut self,
        name: &str,
        resources: &Dictionary,
        stack: &mut StateStack,
    ) -> PpeResult<()> {
        // Không tìm được shading là **mất nội dung**, không phải chuyện vô hại:
        // `sh` luôn tô một vùng, nên bỏ qua im lặng sẽ để lại một khoảng trắng mà
        // báo cáo vẫn nói trang sạch. Object lane ẩn có chủ đích phải thoát trước
        // lookup/decode để mesh hỏng không tạo provenance oan.
        if self.oc_hidden_now() || !self.allows_preview_object(PreviewObjectKind::SmoothShade) {
            return Ok(());
        }
        let entry = match pdf::dict_get_dict(self.doc, resources, "Shading")
            .and_then(|d| d.get(name.as_bytes()).ok())
        {
            Some(e) => e.clone(),
            None => {
                self.warnings
                    .note_skipped_op(&format!("sh: không có /Shading /{name} trong resources"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };
        let mut metadata_warnings = RenderWarnings::default();
        let colorspace = match resolve_shading_colorspace(
            self.doc,
            &entry,
            Some(resources),
            &mut metadata_warnings,
        ) {
            Ok(colorspace) => colorspace,
            Err(e) => {
                merge_render_warnings(&mut self.warnings, &metadata_warnings);
                self.warnings.note_skipped_op(&format!("sh ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };
        if !self.opts.allows_preview_color_space(&colorspace) {
            return Ok(());
        }
        merge_render_warnings(&mut self.warnings, &metadata_warnings);
        let shading = match resolve_shading_with_colorspace(self.doc, &entry, colorspace) {
            Ok(shading) => shading,
            Err(e) => {
                // Kiểu lưới hoặc dict hỏng: ghi nhận để kết quả bị từ chối an toàn.
                self.warnings.note_skipped_op(&format!("sh ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };

        let ctm = stack.current().ctm;
        let gs = stack.current();
        let coverage = ShadingCoverage::GraphicsState {
            clip: gs.clip.as_deref(),
            soft_mask: gs.soft_mask.as_deref(),
            width: self.buffer.width() as usize,
        };
        let region = gs
            .clip_region
            .unwrap_or_else(|| Region::full(self.buffer.width(), self.buffer.height()));
        self.paint_shading(&shading, &ctm, coverage, region, stack, false)
    }

    /// Tô shading qua một mặt nạ độ phủ cho trước.
    ///
    /// Dùng chung cho `sh` (mặt nạ = clip) và cho shading pattern (mặt nạ = đường
    /// dẫn đã rasterize ∩ clip), nên hai đường không thể lệch ngữ nghĩa overprint
    /// hay alpha.
    #[allow(clippy::too_many_arguments)]
    fn paint_shading(
        &mut self,
        shading: &Shading,
        ctm: &Matrix,
        coverage: ShadingCoverage<'_>,
        region: Region,
        stack: &StateStack,
        stroke: bool,
    ) -> PpeResult<()> {
        let gs = stack.current();
        let soft_for_events = gs.soft_mask.clone();
        let alpha = if stroke {
            gs.stroke_alpha
        } else {
            gs.fill_alpha
        };
        let overprint = if stroke {
            gs.stroke_overprint
        } else {
            gs.fill_overprint
        };
        // `OPM = 1`: thành phần bằng 0 không ghi đè kênh tương ứng (§11.7.4.4).
        // Phải áp ở đây nữa, không chỉ ở `make_paint`: shading dựng `InkPaint`
        // trực tiếp cho từng pixel, nên bỏ sót sẽ làm gradient đen overprint khoét
        // trắng nền màu — đúng lỗi mà overprint sinh ra để tránh.
        let opm_one = gs.overprint_mode == 1
            && matches!(
                shading.colorspace,
                ColorSpace::DeviceCMYK | ColorSpace::IccBased { .. }
            );
        let blend = gs.blend_mode;
        let shading_rgb_sidecar = self.blend_space == BlendSpace::DeviceRgb
            && !gs.fill_overprint
            && shading.colorspace.supports_device_rgb_blending()
            && self.color.is_some()
            && self.buffer.ensure_rgb_sidecar()?;
        self.mark_pre_icc_transparency_approximation(
            &shading.colorspace,
            alpha,
            blend,
            gs.soft_mask.is_some(),
            shading_rgb_sidecar,
        );
        let mut exact_paint_region =
            self.exact_paint_region || !self.paint_region_trackers.is_empty();
        if !exact_paint_region {
            exact_paint_region = soft_for_events
                .as_deref()
                .is_some_and(|mask| self.soft_mask_has_pending_events(mask));
        }

        // Lưới đi đường riêng: màu của nó nằm ở đỉnh tam giác, không phải là hàm của
        // vị trí, nên bảng LUT theo `t` không dùng được.
        if let ShadingKind::Mesh { triangles } = &shading.kind {
            let triangles = triangles.clone();
            return self.paint_mesh(
                &triangles,
                &shading.colorspace,
                ctm,
                coverage,
                soft_for_events.as_deref(),
                region,
                exact_paint_region,
                alpha,
                overprint,
                blend,
                opm_one,
            );
        }

        let sampled = SampledShading::new(
            shading,
            ctm,
            self.buffer.space_mut(),
            &mut self.warnings,
            self.color,
        )?;
        let Some(sampled) = sampled else {
            return Ok(());
        };
        self.buffer.sync_channels()?;

        let w = self.buffer.width() as usize;
        let n = self.buffer.space().len();
        let region = region.clamped(self.buffer.width(), self.buffer.height());

        if !shading_rgb_sidecar && sampled.uses_only_process_channels() {
            let cancel_token = self.opts.cancel_token.as_ref();
            let painted = AtomicBool::new(false);
            let paint_x0 = AtomicU32::new(region.x1);
            let paint_y0 = AtomicU32::new(region.y1);
            let paint_x1 = AtomicU32::new(region.x0);
            let paint_y1 = AtomicU32::new(region.y0);
            let parallel = self.buffer.composite_process_shading_pixels_parallel(
                region,
                blend,
                overprint,
                cancel_token,
                |x, y, index| {
                    let coverage = coverage.at(index);
                    if coverage <= 0.0 {
                        return None;
                    }
                    let (ink, mut declared, _sampled_rgb) =
                        sampled.ink_at_device(x as f32 + 0.5, y as f32 + 0.5)?;
                    let process =
                        std::array::from_fn(|channel| ink.get(channel).copied().unwrap_or(0.0));
                    if opm_one && overprint {
                        for (channel, value) in process.iter().enumerate() {
                            if declared.contains(channel) && *value <= 0.0 {
                                declared = declared.without(channel);
                            }
                        }
                    }
                    let sample_alpha = (coverage * alpha).clamp(0.0, 1.0);
                    if sample_alpha <= 0.0 {
                        return None;
                    }
                    painted.store(true, Ordering::Relaxed);
                    if exact_paint_region {
                        paint_x0.fetch_min(x, Ordering::Relaxed);
                        paint_y0.fetch_min(y, Ordering::Relaxed);
                        paint_x1.fetch_max(x.saturating_add(1), Ordering::Relaxed);
                        paint_y1.fetch_max(y.saturating_add(1), Ordering::Relaxed);
                    }
                    Some((process, declared, sample_alpha))
                },
            );
            if parallel {
                self.opts.check_cancelled()?;
                if painted.load(Ordering::Relaxed) {
                    let painted_region = if exact_paint_region {
                        Region {
                            x0: paint_x0.load(Ordering::Relaxed),
                            y0: paint_y0.load(Ordering::Relaxed),
                            x1: paint_x1.load(Ordering::Relaxed),
                            y1: paint_y1.load(Ordering::Relaxed),
                        }
                    } else {
                        region
                    };
                    self.note_surface_paint(soft_for_events.as_deref(), painted_region)?;
                }
                return Ok(());
            }
        }

        let mut ink_scratch: Vec<f32> = vec![0.0; n];
        let paint_serial_before = self.paint_serial;
        let mut painted_region = Region::EMPTY;

        for y in region.y0..region.y1 {
            self.opts.check_cancelled()?;
            for x in region.x0..region.x1 {
                let index = y as usize * w + x as usize;
                let cov = coverage.at(index);
                if cov <= 0.0 {
                    continue;
                }
                // Tâm pixel: shading là hàm liên tục nên lấy mẫu ở tâm, giống mọi
                // đường raster khác của engine.
                let Some((ink, declared, sampled_rgb)) =
                    sampled.ink_at_device(x as f32 + 0.5, y as f32 + 0.5)
                else {
                    continue;
                };
                ink_scratch.clear();
                ink_scratch.extend_from_slice(ink);
                ink_scratch.resize(n, 0.0);

                let mut paint = InkPaint {
                    ink: std::mem::take(&mut ink_scratch),
                    declared,
                    overprint,
                    alpha: (cov * alpha).clamp(0.0, 1.0),
                    blend,
                    blend_rgb: if shading_rgb_sidecar {
                        sampled_rgb
                    } else {
                        None
                    },
                };
                if opm_one {
                    paint = paint.with_overprint_mode_1();
                }
                self.buffer.composite_at(index, 1.0, &paint);
                if paint.alpha > 0.0 {
                    self.paint_serial = self.paint_serial.wrapping_add(1);
                    if exact_paint_region {
                        include_pixel(&mut painted_region, x, y);
                    }
                }
                ink_scratch = paint.ink;
            }
        }
        if self.paint_serial != paint_serial_before {
            let painted_region = if exact_paint_region {
                painted_region
            } else {
                region
            };
            self.finish_surface_paint(soft_for_events.as_deref(), painted_region)?;
        }
        Ok(())
    }

    /// Tô một lưới tam giác (shading kiểu 4–7).
    ///
    /// Mỗi tam giác được quét theo hộp bao của nó và lọc bằng **toạ độ trọng tâm**
    /// (barycentric). Màu ba đỉnh được quy sang mực **một lần cho mỗi tam giác** rồi
    /// nội suy tuyến tính — xem [`crate::shading::mesh`] về lý do không gọi ICC theo
    /// từng pixel.
    #[allow(clippy::too_many_arguments)]
    fn paint_mesh(
        &mut self,
        triangles: &[MeshTriangle],
        cs: &ColorSpace,
        ctm: &Matrix,
        coverage: ShadingCoverage<'_>,
        soft_for_events: Option<&SoftMask>,
        region: Region,
        exact_paint_region: bool,
        alpha: f32,
        overprint: bool,
        blend: BlendMode,
        opm_one: bool,
    ) -> PpeResult<()> {
        let w = self.buffer.width() as usize;
        let region = region.clamped(self.buffer.width(), self.buffer.height());
        if region.is_empty() {
            return Ok(());
        }

        let mut ink_scratch: Vec<f32> = Vec::new();
        let paint_serial_before = self.paint_serial;
        let mut painted_region = Region::EMPTY;
        let preserve_rgb = self.blend_space == BlendSpace::DeviceRgb
            && !overprint
            && cs.supports_device_rgb_blending()
            && self.buffer.has_rgb_sidecar();
        for tri in triangles {
            self.opts.check_cancelled()?;
            // Quy màu ba đỉnh sang mực trước khi quét pixel.
            let mut verts: [(f32, f32); 3] = [(0.0, 0.0); 3];
            let mut inks: [Vec<f32>; 3] = Default::default();
            let mut rgbs = [[0.0f32; 3]; 3];
            let mut declared = ChannelMask::EMPTY;
            let mut usable = true;
            for k in 0..3 {
                verts[k] = ctm.apply(tri.p[k][0], tri.p[k][1]);
                if preserve_rgb {
                    rgbs[k] = cs.to_device_rgb_for_blending(&tri.c[k]).unwrap_or([0.0; 3]);
                }
                match cs.to_ink(
                    &tri.c[k],
                    self.buffer.space_mut(),
                    &mut self.warnings,
                    self.color,
                )? {
                    Some((ink, mask)) => {
                        inks[k] = ink;
                        declared = declared.union(mask);
                    }
                    // Colorant `/None`: tam giác này không lên mực.
                    None => {
                        usable = false;
                        break;
                    }
                }
            }
            if !usable {
                continue;
            }
            self.buffer.sync_channels()?;
            let n = self.buffer.space().len();
            for ink in inks.iter_mut() {
                ink.resize(n, 0.0);
            }

            let (x1, y1) = verts[0];
            let (x2, y2) = verts[1];
            let (x3, y3) = verts[2];
            let denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
            if !denom.is_finite() || denom.abs() < 1e-9 {
                continue; // tam giác suy biến: không chiếm diện tích nào
            }

            let tri_region = Region::from_bounds(
                x1.min(x2).min(x3),
                y1.min(y2).min(y3),
                x1.max(x2).max(x3),
                y1.max(y2).max(y3),
                self.buffer.width(),
                self.buffer.height(),
            );
            let bx0 = tri_region.x0.max(region.x0);
            let bx1 = tri_region.x1.min(region.x1);
            let by0 = tri_region.y0.max(region.y0);
            let by1 = tri_region.y1.min(region.y1);
            if bx0 >= bx1 || by0 >= by1 {
                continue;
            }

            for y in by0..by1 {
                self.opts.check_cancelled()?;
                let py = y as f32 + 0.5;
                for x in bx0..bx1 {
                    let index = y as usize * w + x as usize;
                    let cov = coverage.at(index);
                    if cov <= 0.0 {
                        continue;
                    }
                    let pxc = x as f32 + 0.5;
                    let l1 = ((y2 - y3) * (pxc - x3) + (x3 - x2) * (py - y3)) / denom;
                    let l2 = ((y3 - y1) * (pxc - x3) + (x1 - x3) * (py - y3)) / denom;
                    let l3 = 1.0 - l1 - l2;
                    // Lề nhỏ để pixel nằm đúng trên cạnh chung của hai tam giác
                    // không bị cả hai bỏ — bỏ sót ở cạnh làm lưới rạn thành vệt
                    // trắng, tức báo **thiếu** mực.
                    if l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4 {
                        continue;
                    }
                    ink_scratch.clear();
                    for c in 0..n {
                        ink_scratch.push(l1 * inks[0][c] + l2 * inks[1][c] + l3 * inks[2][c]);
                    }
                    let mut paint = InkPaint {
                        ink: std::mem::take(&mut ink_scratch),
                        declared,
                        overprint,
                        alpha: (cov * alpha).clamp(0.0, 1.0),
                        blend,
                        blend_rgb: if preserve_rgb {
                            Some([
                                (l1 * rgbs[0][0] + l2 * rgbs[1][0] + l3 * rgbs[2][0])
                                    .clamp(0.0, 1.0),
                                (l1 * rgbs[0][1] + l2 * rgbs[1][1] + l3 * rgbs[2][1])
                                    .clamp(0.0, 1.0),
                                (l1 * rgbs[0][2] + l2 * rgbs[1][2] + l3 * rgbs[2][2])
                                    .clamp(0.0, 1.0),
                            ])
                        } else {
                            None
                        },
                    };
                    if opm_one {
                        paint = paint.with_overprint_mode_1();
                    }
                    self.buffer.composite_at(index, 1.0, &paint);
                    if paint.alpha > 0.0 {
                        self.paint_serial = self.paint_serial.wrapping_add(1);
                        if exact_paint_region {
                            include_pixel(&mut painted_region, x, y);
                        }
                    }
                    ink_scratch = paint.ink;
                }
            }
        }
        if self.paint_serial != paint_serial_before {
            let painted_region = if exact_paint_region {
                painted_region
            } else {
                region
            };
            self.finish_surface_paint(soft_for_events, painted_region)?;
        }
        Ok(())
    }

    /// Kiểm tra target Pattern có thực sự phủ pixel sau clip và soft mask hay không.
    ///
    /// Chỉ gọi trên nhánh lỗi: happy path tự dựng coverage đúng một lần trong
    /// painter tương ứng. Nhờ vậy resource hỏng nằm hoàn toàn ngoài clip không
    /// biến một trang đúng thành `ink_unsound`.
    fn pattern_target_is_visible(
        &mut self,
        device_path: &Path,
        rule: FillRule,
        stack: &StateStack,
    ) -> bool {
        let clip = stack.current().clip.clone();
        let soft = stack.current().soft_mask.clone();
        self.raster
            .fill_path(
                device_path,
                rule,
                self.opts.anti_alias,
                clip.as_deref(),
                soft.as_deref(),
            )
            .is_some()
    }

    /// Ghi nhận Pattern đã được chọn nhưng không thể dựng.
    ///
    /// CORRECTNESS (audit 2026-08-31 §PTXT.2): chỉ ghi `skipped_ops` là chưa đủ;
    /// worker suy ra fail-loud từ `dropped_objects`. Trả `false` để caller không
    /// bịa màu đặc thay cho Pattern.
    fn note_dropped_pattern(&mut self, pattern_name: &str, reason: &str) -> bool {
        self.warnings
            .note_skipped_op(&format!("Pattern /{pattern_name}: {reason}"));
        self.warnings.dropped_objects = self.warnings.dropped_objects.saturating_add(1);
        false
    }

    /// Chỉ fail-loud khi Pattern lỗi làm mất pixel có thể nhìn thấy.
    fn note_dropped_pattern_if_visible(
        &mut self,
        pattern_name: &str,
        reason: &str,
        device_path: &Path,
        rule: FillRule,
        stack: &StateStack,
    ) -> bool {
        if !self.pattern_target_is_visible(device_path, rule, stack) {
            return true;
        }
        self.note_dropped_pattern(pattern_name, reason)
    }

    fn note_missing_pattern_selection(
        &mut self,
        stroke: bool,
        device_path: &Path,
        rule: FillRule,
        stack: &StateStack,
    ) -> bool {
        if !self.pattern_target_is_visible(device_path, rule, stack) {
            return true;
        }
        let target = if stroke { "stroke" } else { "fill" };
        self.warnings.note_skipped_op(&format!(
            "Pattern {target}: colorspace /Pattern chưa chọn resource bằng scn/SCN"
        ));
        self.warnings.dropped_objects = self.warnings.dropped_objects.saturating_add(1);
        false
    }

    /// Tô/vẽ nét bằng tiling hoặc shading Pattern. `Ok(true)` khi đã xử lý xong;
    /// `Ok(false)` chỉ khi object visible bị bỏ và diagnostics đã được ghi.
    fn paint_with_pattern(
        &mut self,
        pattern_name: &str,
        resources: Option<&Dictionary>,
        device_path: &Path,
        rule: FillRule,
        stack: &mut StateStack,
        stroke: bool,
        owner: PreviewObjectKind,
    ) -> PpeResult<bool> {
        // Object bị Output Preview ẩn có chủ đích không phải object bị bỏ. Kiểm
        // host trước lookup để resource hỏng trong lane đang ẩn không tạo fail-loud oan.
        if !self.opts.allows_preview_object(owner) {
            return Ok(true);
        }
        let Some(res) = resources else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "thiếu /Resources",
                device_path,
                rule,
                stack,
            ));
        };
        let Some(patterns) = pdf::dict_get_dict(self.doc, res, "Pattern") else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "thiếu dictionary /Pattern",
                device_path,
                rule,
                stack,
            ));
        };
        let Ok(raw) = patterns.get(pattern_name.as_bytes()) else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "không tìm thấy resource",
                device_path,
                rule,
                stack,
            ));
        };
        let entry = pdf::deref(self.doc, raw).clone();
        let (pattern_dict, cell_data, cell_decode_quality) = match &entry {
            Object::Dictionary(d) => (d.clone(), None, pdf::DecodeQuality::Exact),
            Object::Stream(stream) => {
                let decoded = pdf::decode_stream(self.doc, stream);
                (stream.dict.clone(), Some(decoded.bytes), decoded.quality)
            }
            _ => {
                return Ok(self.note_dropped_pattern_if_visible(
                    pattern_name,
                    "resource không phải dictionary/stream",
                    device_path,
                    rule,
                    stack,
                ));
            }
        };
        let pattern_dict = &pattern_dict;

        let ptype = pdf::dict_get(self.doc, pattern_dict, "PatternType")
            .and_then(pdf::as_num)
            .unwrap_or(0.0) as i32;
        if ptype == 1 {
            return self.paint_tiling_pattern(
                pattern_name,
                pattern_dict,
                cell_data,
                cell_decode_quality,
                device_path,
                rule,
                stack,
                stroke,
                owner,
            );
        }
        if ptype != 2 {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                &format!("kiểu {ptype} không hợp lệ"),
                device_path,
                rule,
                stack,
            ));
        }

        let Ok(shading_obj) = pattern_dict.get(b"Shading") else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "shading pattern thiếu /Shading",
                device_path,
                rule,
                stack,
            ));
        };
        let shading_obj = shading_obj.clone();
        let mut metadata_warnings = RenderWarnings::default();
        let colorspace = match resolve_shading_colorspace(
            self.doc,
            &shading_obj,
            resources,
            &mut metadata_warnings,
        ) {
            Ok(colorspace) => colorspace,
            Err(e) => {
                let handled = self.note_dropped_pattern_if_visible(
                    pattern_name,
                    &format!("shading pattern ({e})"),
                    device_path,
                    rule,
                    stack,
                );
                if !handled {
                    merge_render_warnings(&mut self.warnings, &metadata_warnings);
                }
                return Ok(handled);
            }
        };
        if !self.opts.allows_preview_color_space(&colorspace) {
            return Ok(true);
        }
        merge_render_warnings(&mut self.warnings, &metadata_warnings);
        let shading = match resolve_shading_with_colorspace(self.doc, &shading_obj, colorspace) {
            Ok(shading) => shading,
            Err(e) => {
                return Ok(self.note_dropped_pattern_if_visible(
                    pattern_name,
                    &format!("shading pattern ({e})"),
                    device_path,
                    rule,
                    stack,
                ));
            }
        };

        // Pattern space nối vào ma trận khởi đầu của content stream đang
        // dùng pattern, không phải CTM sau các `cm` bên trong stream (§8.7.2).
        let pattern_matrix = pdf::dict_get(self.doc, pattern_dict, "Matrix")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
            .unwrap_or(Matrix::IDENTITY);
        // `/Matrix` nối vào CTM khởi đầu của stream đang dùng pattern.
        let ctm = pattern_matrix.then(&self.stream_base_ctm);

        // Vùng phủ = đường dẫn ∩ clip ∩ soft mask.
        let clip = stack.current().clip.clone();
        let soft = stack.current().soft_mask.clone();
        let (coverage, region) = {
            let Renderer { raster, .. } = self;
            match raster.fill_path(
                device_path,
                rule,
                self.opts.anti_alias,
                clip.as_deref(),
                soft.as_deref(),
            ) {
                Some(cov) => (cov.data.to_vec(), cov.region),
                None => return Ok(true),
            }
        };

        self.paint_shading(
            &shading,
            &ctm,
            ShadingCoverage::Dense(&coverage),
            region,
            stack,
            stroke,
        )?;
        Ok(true)
    }

    /// Tô/vẽ nét bằng **tiling pattern** (`/PatternType 1`).
    ///
    /// # Cách dựng
    ///
    /// Ô mẫu là một content stream có `/BBox`, lặp theo bước `/XStep` × `/YStep`
    /// trong **không gian pattern**. Engine chạy lại content đó một lần cho mỗi ô,
    /// với CTM đã dịch, và clip = (đường dẫn ∩ clip hiện hành ∩ soft mask) ∩ `/BBox`
    /// của ô. Không có đường "tô một màu xấp xỉ": lượng mực của mẫu gạch chéo phụ
    /// thuộc hoàn toàn vào diện tích nét, nên xấp xỉ ở đây là bịa số.
    ///
    /// # Vì sao có trần số ô
    ///
    /// Chi phí tỉ lệ `số_ô × diện_tích_trang` (mỗi ô cần một mặt nạ clip riêng, mà
    /// mặt nạ có kích thước cả trang). Một mẫu bước 2pt trên A4 là hơn 100 000 ô.
    /// Vượt trần thì **báo thiếu tính năng** và dừng an toàn, chứ không vẽ một
    /// phần số ô — vẽ một phần cho ra lượng mực thấp hơn thực tế, đúng chiều sai
    /// nguy hiểm.
    fn paint_tiling_pattern(
        &mut self,
        pattern_name: &str,
        pattern: &Dictionary,
        cell_data: Option<Vec<u8>>,
        cell_decode_quality: pdf::DecodeQuality,
        device_path: &Path,
        rule: FillRule,
        stack: &mut StateStack,
        stroke: bool,
        owner: PreviewObjectKind,
    ) -> PpeResult<bool> {
        const MAX_TILES: usize = 1024;

        let Some(data) = cell_data else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "tiling pattern không có content stream",
                device_path,
                rule,
                stack,
            ));
        };
        let depth = self.cur_depth;
        if depth + 1 > self.opts.max_form_depth {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "tiling pattern lồng quá sâu",
                device_path,
                rule,
                stack,
            ));
        }

        let Some(bbox) = pdf::dict_get(self.doc, pattern, "BBox")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 4).then(|| Rect::new(v[0], v[1], v[2], v[3])))
        else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "tiling pattern thiếu /BBox",
                device_path,
                rule,
                stack,
            ));
        };
        // `/XStep` mặc định bằng bề rộng `/BBox`; bước 0 hoặc âm là file hỏng và sẽ
        // làm vòng lặp vô hạn nếu tin.
        let xstep = pdf::dict_get(self.doc, pattern, "XStep")
            .and_then(pdf::as_num)
            .filter(|v| v.is_finite() && v.abs() > 1e-6)
            .map(f32::abs)
            .unwrap_or(bbox.width());
        let ystep = pdf::dict_get(self.doc, pattern, "YStep")
            .and_then(pdf::as_num)
            .filter(|v| v.is_finite() && v.abs() > 1e-6)
            .map(f32::abs)
            .unwrap_or(bbox.height());
        if xstep <= 0.0 || ystep <= 0.0 {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "tiling pattern có bước không hợp lệ",
                device_path,
                rule,
                stack,
            ));
        }
        let paint_type = pdf::dict_get(self.doc, pattern, "PaintType")
            .and_then(pdf::as_num)
            .unwrap_or(1.0) as i32;
        let cell_res = pdf::dict_get_dict(self.doc, pattern, "Resources").cloned();
        let pattern_matrix = pdf::dict_get(self.doc, pattern, "Matrix")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
            .unwrap_or(Matrix::IDENTITY);
        // Như shading pattern: dùng CTM khởi đầu của stream, không dùng
        // CTM sau các `cm` bên trong stream.
        let ctm = pattern_matrix.then(&self.stream_base_ctm);
        let Some(inv) = ctm.invert() else {
            return Ok(self.note_dropped_pattern_if_visible(
                pattern_name,
                "tiling pattern có /Matrix suy biến",
                device_path,
                rule,
                stack,
            ));
        };

        // Vùng phủ = đường dẫn ∩ clip ∩ soft mask, giữ dạng mặt nạ để dùng làm clip
        // cho từng ô.
        let clip = stack.current().clip.clone();
        let soft = stack.current().soft_mask.clone();
        let (mask_w, mask_h) = (self.raster.width(), self.raster.height());
        let cancel_token = self.opts.cancel_token.clone();
        let (base_mask, region) = {
            let Renderer { raster, .. } = self;
            let Some(cov) = raster.fill_path(
                device_path,
                rule,
                self.opts.anti_alias,
                clip.as_deref(),
                soft.as_deref(),
            ) else {
                return Ok(true); // không phủ pixel nào — đã "vẽ" xong
            };
            let region = cov.region;
            let mut m = Mask::new(mask_w, mask_h).ok_or(PpeError::BadRasterSize {
                w: mask_w as i64,
                h: mask_h as i64,
                dpi: 0.0,
            })?;
            let w = mask_w as usize;
            let dst = m.data_mut();
            for y in region.y0..region.y1 {
                if let Some(token) = cancel_token.as_ref() {
                    token.check()?;
                }
                let row = y as usize * w;
                for x in region.x0..region.x1 {
                    let i = row + x as usize;
                    dst[i] = (cov.data[i].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
            (Arc::new(m), region)
        };

        // Phạm vi chỉ số ô: đưa bốn góc của vùng phủ về không gian pattern.
        let corners = [
            inv.apply(region.x0 as f32, region.y0 as f32),
            inv.apply(region.x1 as f32, region.y0 as f32),
            inv.apply(region.x0 as f32, region.y1 as f32),
            inv.apply(region.x1 as f32, region.y1 as f32),
        ];
        let min_x = corners.iter().map(|c| c.0).fold(f32::MAX, f32::min);
        let max_x = corners.iter().map(|c| c.0).fold(f32::MIN, f32::max);
        let min_y = corners.iter().map(|c| c.1).fold(f32::MAX, f32::min);
        let max_y = corners.iter().map(|c| c.1).fold(f32::MIN, f32::max);
        if !min_x.is_finite() || !max_x.is_finite() || !min_y.is_finite() || !max_y.is_finite() {
            return Ok(
                self.note_dropped_pattern(pattern_name, "tiling pattern có phạm vi không hữu hạn")
            );
        }
        let i0 = ((min_x - bbox.x1) / xstep).floor() as i64;
        let i1 = ((max_x - bbox.x0) / xstep).ceil() as i64;
        let j0 = ((min_y - bbox.y1) / ystep).floor() as i64;
        let j1 = ((max_y - bbox.y0) / ystep).ceil() as i64;
        let count_x = (i1 - i0 + 1).max(0);
        let count_y = (j1 - j0 + 1).max(0);
        let tiles = (count_x as u128) * (count_y as u128);
        if tiles == 0 {
            return Ok(true);
        }
        if tiles > MAX_TILES as u128 {
            return Ok(self.note_dropped_pattern(
                pattern_name,
                &format!("tiling pattern {tiles} ô vượt trần {MAX_TILES}"),
            ));
        }

        self.paint_region_trackers.push(PaintTransaction::default());
        let operation_result = (|| -> PpeResult<bool> {
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let tile_ctm = Matrix::translate(i as f32 * xstep, j as f32 * ystep).then(&ctm);

                    let mut initial = stack.current().clone();
                    initial.ctm = tile_ctm;
                    // Soft mask đã được nhân vào `base_mask`; giữ lại sẽ nhân hai lần.
                    initial.soft_mask = None;
                    initial.fill_pattern = None;
                    initial.stroke_pattern = None;
                    let tile_clip =
                        self.intersect_bbox(Some(base_mask.clone()), Some(bbox), &tile_ctm);
                    let tile_clip_region = intersect_regions(
                        region,
                        self.bbox_region(
                            Some(bbox),
                            &tile_ctm,
                            self.buffer.width(),
                            self.buffer.height(),
                        ),
                    );
                    // CORRECTNESS (audit 2026-08-31 §PPE-A05): khoảng chỉ số ô
                    // có guard bảo thủ ở biên. Ô có clip rỗng không được chạy
                    // resource lỗi rồi chặn operation trước khi tới ô nhìn thấy.
                    if tile_clip_region.is_empty() {
                        continue;
                    }
                    initial.clip = tile_clip;
                    initial.clip_region = Some(tile_clip_region);

                    if paint_type == 2 {
                        // Uncoloured: màu **không** nằm trong ô; nó là toán hạng của
                        // `scn` với colorspace nền của `/Pattern`. Mọi operator màu bên
                        // trong ô bị bỏ qua (§8.7.3.3) — nếu không, ô sẽ tự đặt màu đen
                        // và mất hẳn màu mà file yêu cầu.
                        let gs = stack.current();
                        let (base_cs, comps) = if stroke {
                            (pattern_base_cs(&gs.stroke_cs), gs.stroke_comps.clone())
                        } else {
                            (pattern_base_cs(&gs.fill_cs), gs.fill_comps.clone())
                        };
                        let Some(base_cs) = base_cs else {
                            return Ok(self.note_dropped_pattern(
                                pattern_name,
                                "tiling pattern /PaintType 2 thiếu colorspace nền",
                            ));
                        };
                        initial.fill_cs = base_cs.clone();
                        initial.stroke_cs = base_cs;
                        initial.fill_comps = comps.clone();
                        initial.stroke_comps = comps;
                    } else {
                        // Coloured: ô tự khai màu, khởi tạo là đen (§8.7.3.1).
                        initial.fill_cs = ColorSpace::DeviceGray;
                        initial.stroke_cs = ColorSpace::DeviceGray;
                        initial.fill_comps = vec![0.0];
                        initial.stroke_comps = vec![0.0];
                    }

                    let mut sub = StateStack::new(initial);
                    let saved_text_obj = self.text_obj;
                    let saved_text_clip = self.text_clip.take();
                    let saved_preview_owner = self.pattern_preview_owner;
                    self.pattern_preview_owner = Some(owner);
                    if paint_type == 2 {
                        self.suppress_color_ops += 1;
                    }
                    self.pattern_cell_depth += 1;
                    let saved_depth = self.cur_depth;
                    let result = self.execute(&data, cell_res.as_ref(), &mut sub, depth + 1);
                    self.cur_depth = saved_depth;
                    self.pattern_cell_depth -= 1;
                    if paint_type == 2 {
                        self.suppress_color_ops -= 1;
                    }
                    self.pattern_preview_owner = saved_preview_owner;
                    self.text_obj = saved_text_obj;
                    self.text_clip = saved_text_clip;
                    result?;
                }
            }
            Ok(true)
        })();
        let mut transaction = self.paint_region_trackers.pop().unwrap_or_default();
        let completed = operation_result?;
        self.opts.check_cancelled()?;

        // Chỉ source/object sink đủ điều kiện mới ghi transaction.region. Gắn
        // provenance sau cổng đó để Show=DeviceRGB không làm Pattern CMYK ẩn
        // thành dropped object oan.
        if cell_decode_quality == pdf::DecodeQuality::Recovered && !transaction.region.is_empty() {
            let event = self.allocate_deferred_event(DeferredDiagnostic::PatternStreamDecode);
            transaction
                .explicit_mask_events
                .insert(event, transaction.region);
        }

        // Soft mask của host đã được bake vào `base_mask` rồi xoá khỏi state
        // từng cell. Chỉ sau khi toàn bộ operation thành công mới dùng footprint
        // sink thật để lọc event, rồi commit Region + direct event lên cha.
        if !transaction.region.is_empty() {
            self.propagate_soft_mask_events(soft.as_deref(), transaction.region)?;
            self.record_painted_region(transaction.region);
        }
        self.accept_explicit_mask_events(transaction.explicit_mask_events);

        Ok(completed)
    }

    /// Tra font trong `/Font` của resources, có cache theo tham chiếu object.
    ///
    /// Cache theo `ObjectId` chứ không theo tên resource: cùng một font thường
    /// được nhiều Form XObject tham chiếu dưới các tên khác nhau, và parse lại
    /// chương trình font cho từng tên là phần chậm nhất của cả trang.
    fn lookup_font(
        &mut self,
        name: &str,
        resources: Option<&Dictionary>,
    ) -> Option<Arc<LoadedFont>> {
        let res = resources?;
        let fonts = pdf::dict_get_dict(self.doc, res, "Font")?;
        let raw = fonts.get(name.as_bytes()).ok()?;
        let key = pdf::ref_id(raw);

        if let Some(id) = key {
            if let Some(found) = self.font_cache.get(&id) {
                return Some(found.clone());
            }
        }
        let dict = match pdf::deref(self.doc, raw) {
            Object::Dictionary(d) => d.clone(),
            _ => return None,
        };
        let mut loaded = load_font(self.doc, &dict);

        if loaded.cannot_draw() {
            match &self.opts.fallback_font {
                Some(data) => {
                    // Thay font: lấp được lỗ đo (trang chữ không còn báo 0% mực)
                    // nhưng bề rộng và hình chữ khác bản gốc ⇒ diện tích phủ mực
                    // chỉ là xấp xỉ. Ghi vào trục *hình học*, KHÔNG vào
                    // `approximated_colorspaces`: font chẳng liên quan colorspace,
                    // và làm bẩn danh sách đó sẽ khiến lớp trên tưởng quản lý màu
                    // còn thiếu trong khi ICC đã áp đủ.
                    loaded.substitute_program(FontProgram::TrueType(data.clone()));
                    self.warnings.note_substituted_font(&loaded.base_font);
                    self.warnings
                        .note_skipped_op(&format!("font thay thế: {}", loaded.base_font));
                }
                None => {
                    // Chỉ ghi vết chẩn đoán. Font được khai trong /Resources nhưng
                    // không có `Tj` nào dùng thì không mất nội dung nào — hạ tin cậy
                    // ở đây là báo oan. Chữ thật sự bị bỏ được đếm ở `draw_glyph`
                    // (`dropped_objects`), đúng chỗ nó xảy ra.
                    self.warnings
                        .note_skipped_op(&format!("font không nhúng: {}", loaded.describe()));
                }
            }
        }
        let font = Arc::new(loaded);
        if let Some(id) = key {
            self.font_cache.insert(id, font.clone());
        }
        Some(font)
    }

    /// Vẽ một chuỗi (`Tj` / `TJ` / `'` / `"`).
    fn show_text(
        &mut self,
        bytes: &[u8],
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let Some(font) = stack.current().text.font.clone() else {
            self.warnings.note_skipped_op("vẽ chữ khi chưa có Tf");
            self.warnings.dropped_objects += 1;
            return Ok(());
        };
        let mode = stack.current().text.render_mode;

        let mut i = 0usize;
        while i < bytes.len() {
            // Tách mã: font Type0 dùng CMap (1–4 byte), font đơn byte thì 1 byte.
            let (code, consumed) = match (&font.cmap, font.is_type0) {
                (Some(cmap), true) => cmap.next_code(&bytes[i..]),
                _ => (bytes[i] as u32, 1),
            };
            let raw_byte_is_space = consumed == 1 && bytes[i] == 32;
            i += consumed.max(1);

            let width = font.advance(code);

            if self.opts.collect_text_outlines {
                // Đếm ở ĐÂY, trước cổng `paints_ink`, chứ không trong `draw_glyph`:
                // lớp ghi PDF bên Python duyệt mọi mã ký tự bất kể `Tr`. Đếm sau cổng
                // thì một khối kiểu `3 Tr (abc) Tj 0 Tr (XY) Tj` cho Python ordinal 3,4
                // còn engine 0,1 — path bị gán cho glyph khác, file vẫn có chữ, chỉ sai
                // chỗ. Đây là chỗ hai bên phải đếm y hệt nhau.
                self.count_text_code();
            }

            if mode.paints_ink() || mode.adds_to_clip() {
                self.draw_glyph(&font, code, resources, stack, depth, mode)?;
            }

            let gs = stack.current();
            let tx = crate::text::state::glyph_advance(&gs.text, width, raw_byte_is_space);
            self.text_obj.advance(tx, 0.0);
        }
        Ok(())
    }

    /// Ghi nhận đã đi qua MỘT mã ký tự trong khối `BT … ET` hiện hành.
    ///
    /// Đếm cả dấu cách, `Tr 3` và mã trong lớp optional content đang tắt — đúng như
    /// vòng lặp mã ký tự bên Python. Hai con số đi ra từ đây:
    ///
    /// * `glyph_seq` — chỉ số của glyph tiếp theo trong khối;
    /// * `text_block_codes` — tổng số mã của khối, tức hợp đồng để Python đối chiếu
    ///   bằng số lượng (OUT-FONT, audit lần 3 §3.2). Chốt hình học trước đó phụ thuộc
    ///   kích thước và bỏ sót glyph nhỏ (dấu chấm 12pt chỉ 9 px mực).
    fn count_text_code(&mut self) {
        self.glyph_seq += 1;
        let block = self
            .stream_ctx
            .last()
            .map(|(k, n)| (*k, n.saturating_sub(1)))
            .unwrap_or((StreamKey::Page, 0));
        let counted = self.text_block_codes.entry(block).or_insert(0);
        *counted = (*counted).max(self.glyph_seq);
    }

    /// Vẽ một glyph.
    fn draw_glyph(
        &mut self,
        font: &Arc<LoadedFont>,
        code: u32,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
        mode: TextRenderMode,
    ) -> PpeResult<()> {
        if self.oc_hidden_now() {
            if self.opts.collect_text_outlines {
                // Chữ trong lớp optional content đang TẮT. Lớp Python ghi PDF không
                // theo dõi optional content, nên nếu bỏ im lặng thì chỉ số glyph hai
                // bên lệch nhau và path sẽ bị gán cho glyph khác. Từ chối cả trang.
                self.text_outlines.has_unsupported_context = true;
            }
            return Ok(());
        }
        let gs_ctm = stack.current().ctm;
        let trm = crate::text::state::glyph_matrix(&stack.current().text, &self.text_obj.matrix);

        // Type3: glyph là một content stream, không phải đường viền.
        if let Some(t3) = font.type3.clone() {
            if self.opts.collect_text_outlines {
                // Không có "outline" nào đúng cho Type3: glyph của nó có thể vẽ ảnh
                // hoặc đặt màu riêng. Khai ra để caller từ chối trang, thay vì giao
                // ra bản in thiếu chữ.
                self.text_outlines.has_type3 = true;
                return Ok(());
            }
            return self.draw_type3_glyph(font, &t3, code, resources, stack, depth);
        }

        if self.opts.collect_text_outlines {
            return self.collect_glyph_outline(font, code, &trm, stack, mode);
        }

        let Some(outline) = font.glyph_outline(code) else {
            // Glyph rỗng (dấu cách) là bình thường; glyph thiếu vì font không
            // nhúng đã được ghi nhận lúc nạp font.
            if font.program.is_missing() {
                self.warnings.dropped_objects += 1;
            }
            return Ok(());
        };

        let full = trm.then(&gs_ctm);
        let Some(device_path) = outline.as_ref().clone().transform(to_ts(&full)) else {
            return Ok(());
        };

        let text_owner = self.preview_object_kind(PreviewObjectKind::Text);
        let text_object_visible = self.opts.allows_preview_object(text_owner);
        let fill_uses_pattern = uses_pattern_color_space(stack, false);
        if mode.fills()
            && text_object_visible
            && (fill_uses_pattern
                || self
                    .opts
                    .allows_preview_color_space(&stack.current().fill_cs))
        {
            // CORRECTNESS (audit 2026-08-31 §PTXT.1): Pattern là một hàm theo vị
            // trí, không thể quy về `InkPaint`. Glyph phải đi cùng semantic
            // `paint_with_pattern` như path; nếu gọi `make_paint` thì Pattern trả
            // `None` và chữ bị bỏ im lặng.
            if fill_uses_pattern {
                match pattern_for(stack, false) {
                    Some(name) => {
                        self.paint_with_pattern(
                            &name,
                            resources,
                            &device_path,
                            FillRule::NonZero,
                            stack,
                            false,
                            text_owner,
                        )?;
                    }
                    None => {
                        self.note_missing_pattern_selection(
                            false,
                            &device_path,
                            FillRule::NonZero,
                            stack,
                        );
                    }
                }
            } else if let Some(paint) = self.make_paint(stack, false)? {
                let clip = stack.current().clip.clone();
                let soft = stack.current().soft_mask.clone();
                let paint_serial_before = self.paint_serial;
                let mut painted_region = Region::EMPTY;
                let Renderer {
                    raster,
                    buffer,
                    paint_serial,
                    ..
                } = self;
                if let Some(cov) = raster.fill_path_centered(
                    &device_path,
                    FillRule::NonZero,
                    self.opts.anti_alias,
                    clip.as_deref(),
                    soft.as_deref(),
                ) {
                    let cov_region = cov.region;
                    buffer.composite_region(cov.data, cov.region, &paint)?;
                    if paint.alpha > 0.0 {
                        *paint_serial = paint_serial.wrapping_add(1);
                        painted_region = painted_region.union(cov_region);
                    }
                }
                let painted = *paint_serial != paint_serial_before;
                if painted {
                    self.finish_surface_paint(soft.as_deref(), painted_region)?;
                }
            }
        }

        let stroke_uses_pattern = uses_pattern_color_space(stack, true);
        if mode.strokes()
            && text_object_visible
            && (stroke_uses_pattern
                || self
                    .opts
                    .allows_preview_color_space(&stack.current().stroke_cs))
        {
            // Nét của chữ có bề rộng theo toạ độ người dùng, nên phải dựng outline
            // trong không gian glyph rồi mới biến đổi — giống hệt đường vector.
            let stroke = stack.current().build_stroke();
            let glyph_user = outline.as_ref().clone().transform(to_ts(&trm));
            if let Some(p) = glyph_user {
                if let Some(outlined) = stroke_to_path(&p, &stroke, &gs_ctm) {
                    if stroke_uses_pattern {
                        match pattern_for(stack, true) {
                            Some(name) => {
                                self.paint_with_pattern(
                                    &name,
                                    resources,
                                    &outlined,
                                    FillRule::NonZero,
                                    stack,
                                    true,
                                    text_owner,
                                )?;
                            }
                            None => {
                                self.note_missing_pattern_selection(
                                    true,
                                    &outlined,
                                    FillRule::NonZero,
                                    stack,
                                );
                            }
                        }
                    } else if let Some(paint) = self.make_paint(stack, true)? {
                        let clip = stack.current().clip.clone();
                        let soft = stack.current().soft_mask.clone();
                        let paint_serial_before = self.paint_serial;
                        let mut painted_region = Region::EMPTY;
                        let Renderer {
                            raster,
                            buffer,
                            paint_serial,
                            ..
                        } = self;
                        if let Some(cov) = raster.fill_path_centered(
                            &outlined,
                            FillRule::NonZero,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref(),
                        ) {
                            let cov_region = cov.region;
                            buffer.composite_region(cov.data, cov.region, &paint)?;
                            if paint.alpha > 0.0 {
                                *paint_serial = paint_serial.wrapping_add(1);
                                painted_region = painted_region.union(cov_region);
                            }
                        }
                        let painted = *paint_serial != paint_serial_before;
                        if painted {
                            self.finish_surface_paint(soft.as_deref(), painted_region)?;
                        }
                    }
                }
            }
        }
        if mode.adds_to_clip() {
            self.accumulate_text_clip(&device_path);
        }
        Ok(())
    }

    /// Glyph Type3: chạy content stream trong `/CharProcs`.
    /// Ghi lại đường viền một glyph trong **không gian người dùng của stream**.
    ///
    /// Chỉ áp ma trận chữ, KHÔNG áp CTM: xem tài liệu `crate::text::outlines` về vì
    /// sao nhân CTM ở đây là nhân hai lần.
    fn collect_glyph_outline(
        &mut self,
        font: &Arc<LoadedFont>,
        code: u32,
        trm: &Matrix,
        stack: &mut StateStack,
        mode: TextRenderMode,
    ) -> PpeResult<()> {
        let stream = self
            .stream_ctx
            .last()
            .map(|(k, _)| *k)
            .unwrap_or(StreamKey::Page);
        if self.smask_depth > 0 || self.pattern_cell_depth > 0 || stream == StreamKey::Unaddressable
        {
            // Soft mask và ô tiling pattern được dựng lại mỗi lần dùng và nằm trong
            // dictionary tài nguyên; chỉ số khối text ở đó không ánh xạ về chỗ ghi.
            // Form là object trực tiếp thì Python cũng không trỏ tới được.
            self.text_outlines.has_unsupported_context = true;
            return Ok(());
        }
        if !(mode.fills() || mode.strokes() || mode.adds_to_clip()) {
            return Ok(()); // `Tr 3` — chữ vô hình, không phải chữ bị mất
        }
        let Some(outline) = font.glyph_outline(code) else {
            if font.program.is_missing() {
                // Font không nhúng ⇒ glyph lấy từ font thay thế; nếu cả nó cũng không
                // có thì chữ sẽ MẤT khi ghi lại. Phải khai, không được im lặng.
                self.text_outlines.missing_glyphs += 1;
            }
            return Ok(());
        };
        let Some(glyph_user) = outline.as_ref().clone().transform(to_ts(trm)) else {
            self.text_outlines.missing_glyphs += 1;
            return Ok(());
        };
        let (verbs, coords) = encode_path(&glyph_user);
        if verbs.is_empty() {
            return Ok(()); // glyph rỗng (dấu cách)
        }
        let text_object_index = self
            .stream_ctx
            .last()
            .map(|(_, n)| n.saturating_sub(1))
            .unwrap_or(0);
        let glyph_index = self.glyph_seq - 1; // đã tăng ở đầu draw_glyph
        self.text_outlines.glyphs.push(GlyphOutline {
            stream,
            text_object_index,
            glyph_index,
            fill: mode.fills(),
            stroke: mode.strokes(),
            clip: mode.adds_to_clip(),
            line_width: stack.current().line_width,
            verbs,
            coords,
        });
        Ok(())
    }

    fn draw_type3_glyph(
        &mut self,
        font: &Arc<LoadedFont>,
        t3: &Type3Data,
        code: u32,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        let Some(name) = font
            .encoding
            .as_ref()
            .and_then(|e| e.glyph_name(code as u8))
            .map(|s| s.to_string())
        else {
            return Ok(());
        };
        let Ok(proc_obj) = t3.char_procs.get(name.as_bytes()) else {
            return Ok(());
        };
        let Some(decoded) = pdf::stream_data_with_quality(self.doc, proc_obj) else {
            return Ok(());
        };
        let stream_recovered = decoded.quality == pdf::DecodeQuality::Recovered;
        let data = decoded.bytes;
        // CORRECTNESS (audit 2026-08-31 §PPE-A06): classify width operator trước
        // mọi mutation rồi replay chính PageProgram này; d1 là glyph uncoloured,
        // d0 vẫn được dùng màu nội bộ. Operator width đầu tiên thắng nếu file hỏng.
        let program = PageProgram::compile(&data)?;
        let suppress_glyph_color = program
            .operations()
            .iter()
            .find_map(|op| match op.operator.as_str() {
                "d1" => Some(true),
                "d0" => Some(false),
                // lopdf tokenizes operator có hậu tố số thành `d`; d1 có 6 số
                // (wx wy llx lly urx ury), d0 có 2 số (wx wy). Dash `d` thật
                // bắt đầu bằng Array nên không đi vào hai nhánh này.
                "d" if op.operands.len() == 6
                    && op
                        .operands
                        .iter()
                        .all(|operand| pdf::as_num(operand).is_some()) =>
                {
                    Some(true)
                }
                "d" if op.operands.len() == 2
                    && op
                        .operands
                        .iter()
                        .all(|operand| pdf::as_num(operand).is_some()) =>
                {
                    Some(false)
                }
                _ => None,
            })
            .unwrap_or(false);

        let trm = crate::text::state::glyph_matrix(&stack.current().text, &self.text_obj.matrix);
        let ctm = t3.font_matrix.then(&trm).then(&stack.current().ctm);

        // Resources của font Type3 thắng resources của trang; thiếu thì kế thừa.
        let res = t3.resources.clone().or_else(|| resources.cloned());

        if !self.save_internal_state(stack) {
            return Ok(());
        }
        stack.current_mut().ctm = ctm;
        let saved_depth = stack.logical_depth();
        // Glyph Type3 có thể vẽ chữ bên trong → phải lưu text object, nếu không
        // con trỏ chữ của dòng ngoài sẽ bị glyph làm lệch.
        let saved_text_obj = self.text_obj;
        let saved_suppress_color_ops = self.suppress_color_ops;
        if suppress_glyph_color {
            self.suppress_color_ops = self.suppress_color_ops.saturating_add(1);
        }
        if stream_recovered {
            // CORRECTNESS (audit 2026-09-01 §PPE-E2): transaction giữ warning
            // cùng footprint thật của glyph; glyph ngoài clip hoặc replay lỗi
            // không được làm bẩn provenance của trang.
            self.paint_region_trackers.push(PaintTransaction::default());
        }
        let result = self.execute_program(&program, res.as_ref(), stack, depth + 1);
        let recovered_transaction = if stream_recovered {
            self.paint_region_trackers.pop()
        } else {
            None
        };
        self.suppress_color_ops = saved_suppress_color_ops;
        self.text_obj = saved_text_obj;
        while stack.logical_depth() > saved_depth {
            stack.restore();
        }
        stack.restore();

        if result.is_ok() {
            if let Some(mut transaction) = recovered_transaction {
                if !transaction.region.is_empty() {
                    let event = self.allocate_deferred_event(DeferredDiagnostic::Type3StreamDecode);
                    transaction
                        .explicit_mask_events
                        .insert(event, transaction.region);
                    self.record_painted_region(transaction.region);
                }
                self.accept_explicit_mask_events(transaction.explicit_mask_events);
            }
        }
        result
    }

    /// Gom glyph vào mặt nạ clip của khối text (`Tr` 4–7).
    fn accumulate_text_clip(&mut self, device_path: &Path) {
        let width = self.raster.width();
        let height = self.raster.height();
        let bounds = device_path.bounds();
        let glyph_region = Region::from_bounds(
            bounds.left(),
            bounds.top(),
            bounds.right(),
            bounds.bottom(),
            width,
            height,
        );
        let pending = self.text_clip.get_or_insert_with(|| PendingTextClip {
            mask: Mask::new(width, height).expect("kích thước raster đã kiểm"),
            region: Region::EMPTY,
        });
        pending.region = pending.region.union(glyph_region);
        pending.mask.fill_path(
            device_path,
            FillRule::NonZero.into(),
            self.opts.anti_alias,
            Transform::identity(),
        );
    }

    /// `ET` — áp mặt nạ clip đã gom.
    ///
    /// Clip chữ chỉ có hiệu lực **sau** `ET` (§9.4.3). Áp sớm sẽ cắt mất chính
    /// những glyph đang được gom.
    fn finish_text_clip(&mut self, stack: &mut StateStack) -> PpeResult<()> {
        let Some(PendingTextClip {
            mask: text_mask,
            region: text_region,
        }) = self.text_clip.take()
        else {
            return Ok(());
        };
        let old_region = stack
            .current()
            .clip_region
            .unwrap_or_else(|| Region::full(self.raster.width(), self.raster.height()));
        let mut combined = match &stack.current().clip {
            Some(existing) => (**existing).clone(),
            None => self.raster.full_clip(),
        };
        for (dst, src) in combined.data_mut().iter_mut().zip(text_mask.data().iter()) {
            *dst = ((*dst as u32 * *src as u32) / 255) as u8;
        }
        let gs = stack.current_mut();
        gs.clip = Some(Arc::new(combined));
        // CORRECTNESS (audit 2026-08-09 §PRE.0A): mask là nguồn sự thật;
        // region chỉ là hộp bao bảo thủ để soft-mask sau clip chữ không dựng
        // child buffer gần toàn trang.
        gs.clip_region = Some(intersect_regions(old_region, text_region));
        Ok(())
    }

    /// Chạy content lồng nhau, kế thừa trạng thái hiện hành thay vì khởi tạo mới.
    fn execute_with_ctm(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
        _ctm: Matrix,
    ) -> PpeResult<()> {
        self.execute(data, resources, stack, depth)
    }
}

const IMAGE_FOOTPRINT_TAC_THRESHOLD: f32 = 3.0;
const MAX_SOFT_MASK_DEPTH: u32 = 4;
const SOFT_MASK_PEAK_RADIUS: i64 = 3;

/// Cực đại lân cận của soft mask cho đường ảnh đo mực.
///
/// Soft mask được render ở đúng DPI đầu ra. Một đỉnh hẹp có thể rơi giữa hai tâm
/// pixel và bị hạ vừa đủ để tạo false-clean; lấy cực đại trong cửa sổ 7×7 chỉ mở
/// rộng biên mask vài pixel, theo đúng chiều sai bảo thủ của prepress.
fn soft_mask_peak(mask: &SoftMask, x: i64, y: i64, width: i64, height: i64) -> f32 {
    mask.peak_at(x, y, width, height, SOFT_MASK_PEAK_RADIUS)
}

#[inline]
fn image_soft_mask_value(
    mask: &SoftMask,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    conservative: bool,
) -> f32 {
    if conservative {
        soft_mask_peak(mask, x, y, width, height)
    } else {
        mask.value_at(x as u32, y as u32)
    }
}

/// Chỉ số texel từ toạ độ mẫu, theo quy ước khoảng **nửa-mở trái** `(t, t+1]`
/// của RIP tham chiếu: mẫu rơi đúng biên texel lấy texel BÊN TRÁI.
///
/// Đo black-box GS 10.04: sọc 1-texel đặt sao cho tâm pixel rơi đúng biên texel
/// (offset nguyên, ratio 16/5) — GS bỏ đúng các pixel-tie mà quy ước `[t, t+1)`
/// (floor) giữ; trên lưới căng-bbox của ảnh có mask, tie xuất hiện định kỳ
/// (mỗi 21 px @75 DPI, 47 px @150 — chu kỳ của 64/21 và 72/47) và đều nghiêng
/// trái. Với toạ độ không-tie hai quy ước cho cùng kết quả.
#[inline]
fn tex_index(t: f64, n: u32) -> u32 {
    ((t.ceil() as i64) - 1).clamp(0, n as i64 - 1) as u32
}

/// Số điểm lấy mẫu theo hai trục pixel thiết bị cho một ảnh đang thu nhỏ.
///
/// Mỗi bước một pixel thiết bị được đổi về vector trong lưới texel nguồn. Với
/// xoay/nghiêng, chuẩn Euclid giữ mật độ mẫu theo đúng hướng biến đổi thay vì chỉ
/// nhìn bbox. Zoom gần 1:1 hoặc phóng đại trả `(1, 1)` để đi đường nóng cũ.
fn preview_image_sample_grid(inv: &[f64; 6], width: u32, height: u32) -> (u32, u32) {
    let source_per_device_x = (inv[0] * width as f64).hypot(inv[1] * height as f64);
    let source_per_device_y = (inv[2] * width as f64).hypot(inv[3] * height as f64);

    fn samples_for_span(span: f64) -> u32 {
        if !span.is_finite() || span <= PREVIEW_IMAGE_MINIFICATION_THRESHOLD {
            1
        } else {
            (span.ceil() as u32).clamp(2, PREVIEW_IMAGE_MAX_SAMPLES_PER_AXIS)
        }
    }

    (
        samples_for_span(source_per_device_x),
        samples_for_span(source_per_device_y),
    )
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PreviewDeviceCmykRawAverage {
    /// Trung bình trên toàn footprint — lớp chống alias giữ nét mảnh không biến mất.
    footprint: [f32; 4],
    /// Trung bình phần lõi bỏ một vòng mẫu ngoài — dùng làm tín hiệu chi tiết.
    core: Option<[f32; 4]>,
}

/// Trung bình CMYK trên footprint của một pixel Viewer bằng lưới sub-pixel đều.
///
/// Lưới được đặt trong pixel thiết bị rồi mới nghịch đảo qua CTM, nên cùng một
/// hàm dùng được cho ảnh xoay/nghiêng và tile có offset. Mẫu ngoài hình vuông ảnh
/// bị loại; caller dùng đường tâm cũ nếu footprint không còn mẫu hợp lệ. Phần lõi
/// dùng lại chính các mẫu đã đọc, nên tăng nét không thêm lookup nguồn.
fn preview_device_cmyk_raw_average<F>(
    inv: &[f64; 6],
    dx: i64,
    dy: i64,
    width: u32,
    height: u32,
    grid: (u32, u32),
    mut sample: F,
) -> Option<PreviewDeviceCmykRawAverage>
where
    F: FnMut(u32, u32) -> [u8; 4],
{
    let (samples_x, samples_y) = grid;
    if samples_x == 0 || samples_y == 0 || width == 0 || height == 0 {
        return None;
    }

    let mut sum = [0_u64; 4];
    let mut core_sum = [0_u64; 4];
    let mut count = 0_u32;
    let mut core_count = 0_u32;
    let has_narrower_core = samples_x >= 4 || samples_y >= 4;
    for sample_y in 0..samples_y {
        let py = dy as f64 + (sample_y as f64 + 0.5) / samples_y as f64;
        for sample_x in 0..samples_x {
            let px = dx as f64 + (sample_x as f64 + 0.5) / samples_x as f64;
            let u = inv[0] * px + inv[2] * py + inv[4];
            let v = inv[1] * px + inv[3] * py + inv[5];
            if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                continue;
            }
            let sx = tex_index(u * width as f64, width);
            let sy = tex_index((1.0 - v) * height as f64, height);
            let value = sample(sx, sy);
            for channel in 0..4 {
                sum[channel] += value[channel] as u64;
            }
            count += 1;
            let inside_core_x = samples_x < 4 || (sample_x > 0 && sample_x + 1 < samples_x);
            let inside_core_y = samples_y < 4 || (sample_y > 0 && sample_y + 1 < samples_y);
            if inside_core_x && inside_core_y {
                for channel in 0..4 {
                    core_sum[channel] += value[channel] as u64;
                }
                core_count += 1;
            }
        }
    }

    if count == 0 {
        return None;
    }
    let footprint = std::array::from_fn(|channel| sum[channel] as f32 / (count as f32 * 255.0));
    // UIUX (feedback 2026-08-14 §VIEW.SHARP.2): chỉ boost khi lưới đầy đủ.
    // Ở mép ảnh/clip thiếu mẫu, dùng footprint thuần để không tạo viền sáng tối.
    let expected_core_count = (if samples_x >= 4 {
        samples_x - 2
    } else {
        samples_x
    }) * (if samples_y >= 4 {
        samples_y - 2
    } else {
        samples_y
    });
    let core = (has_narrower_core
        && count == samples_x.saturating_mul(samples_y)
        && core_count == expected_core_count)
        .then(|| {
            std::array::from_fn(|channel| core_sum[channel] as f32 / (core_count as f32 * 255.0))
        });
    Some(PreviewDeviceCmykRawAverage { footprint, core })
}

/// Phục hồi chi tiết đã bị box-filter làm mềm mà không đổi kích thước raster.
///
/// Soft-threshold loại nhiễu thấp; limiter chặn overshoot. Tính trong không gian
/// mực sau `/Decode` để ảnh Adobe CMYK đảo kênh vẫn sắc đúng chiều sáng/tối.
fn boost_preview_device_cmyk_detail(footprint: [f32; 4], core: Option<[f32; 4]>) -> [f32; 4] {
    let Some(core) = core else {
        return footprint;
    };
    std::array::from_fn(|channel| {
        let detail = core[channel] - footprint[channel];
        let magnitude = (detail.abs() - PREVIEW_IMAGE_DETAIL_THRESHOLD)
            .max(0.0)
            .min(PREVIEW_IMAGE_DETAIL_LIMIT);
        (footprint[channel] + detail.signum() * magnitude * PREVIEW_IMAGE_DETAIL_BOOST)
            .clamp(0.0, 1.0)
    })
}

/// Dải nhiễu quanh biên texel mà hai RIP có thể làm tròn khác phía.
///
/// Cận trên của tổng nhiễu: hệ số CTM lưu f32 (~1e-7 tương đối, nhân toạ độ
/// texel ~1536 → ~1.5e-4 texel) cộng fixed-point nội bộ của tham chiếu; 1e-3
/// cho biên an toàn ×5 mà vẫn chỉ chạm ~0.2% mẫu ở phân bố đều.
const TEXEL_TIE_EPS: f64 = 1e-3;

/// Texel phía bên kia của một mẫu nằm sát biên texel, nếu có.
///
/// `chosen` là texel đã chọn theo quy ước `(t, t+1]`; biên gần nhất `k` chia
/// texel `k-1 | k`, nên phía còn lại là `k` nếu đã chọn `k-1` và ngược lại.
fn texel_tie_alternate(t: f64, n: u32, chosen: u32) -> Option<u32> {
    let boundary = t.round();
    if (t - boundary).abs() > TEXEL_TIE_EPS {
        return None;
    }
    let k = boundary as i64;
    let alt = if chosen as i64 == k { k - 1 } else { k };
    (0..n as i64)
        .contains(&alt)
        .then_some(alt as u32)
        .filter(|a| *a != chosen)
}

/// Lưới lấy mẫu cho ảnh có `/SMask`: hình vuông đơn vị căng lên bbox pixel-NGUYÊN.
///
/// Đo black-box GS 10.04 (sọc 1-texel trong mask và trong màu, quét DPI 23–150):
///
/// * Ảnh KHÔNG mask: lưới CTM chính xác, nearest tại tâm pixel — khớp GS từng
///   pixel tới ratio 11.5, mọi codec, kể cả khi tràn mép trang.
/// * Ảnh CÓ mask: cả kênh màu LẪN kênh alpha lấy mẫu như thể hình vuông đơn vị
///   phủ `[floor(x0), ceil(x1)) × [floor(y0), ceil(y1))` của footprint đầy đủ
///   (kể cả phần bị cắt ngoài trang) — tức bị căng thêm tối đa 1 px mỗi chiều.
///   Chỉ mô hình này khớp GS từng pixel (184/184 @75, 246/246 @100, 371/371
///   @150; các mô hình exact/pixround đều rớt về ~55–77%).
///
/// Chỉ áp cho CTM trục-thẳng (kể cả xoay bội 90° và lật gương — bbox vẫn là
/// hình chữ nhật thẳng trục). Dạng nghiêng/xoay lẻ chưa đo được hành vi GS nên
/// giữ lưới chính xác; lệch nếu có chỉ là pha sub-pixel, không phải chiều
/// báo-thiếu hệ thống.
fn mask_sample_ctm(ctm: &Matrix, min_x: f32, max_x: f32, min_y: f32, max_y: f32) -> Matrix {
    let mag = ctm
        .a
        .abs()
        .max(ctm.b.abs())
        .max(ctm.c.abs())
        .max(ctm.d.abs());
    let axis_aligned =
        (ctm.b.abs() + ctm.c.abs()) <= mag * 1e-5 || (ctm.a.abs() + ctm.d.abs()) <= mag * 1e-5;
    if !axis_aligned {
        return *ctm;
    }
    let (bx0, bx1) = (min_x.floor(), max_x.ceil());
    let (by0, by1) = (min_y.floor(), max_y.ceil());
    let (fw, fh) = (max_x - min_x, max_y - min_y);
    if fw <= 0.0 || fh <= 0.0 || bx1 <= bx0 || by1 <= by0 {
        return *ctm;
    }
    let sx = (bx1 - bx0) / fw;
    let sy = (by1 - by0) / fh;
    let adj = Matrix::new(sx, 0.0, 0.0, sy, bx0 - min_x * sx, by0 - min_y * sy);
    ctm.then(&adj)
}

/// Các texel ứng viên cho một pixel thiết bị.
///
/// Với ảnh phóng đại, chỉ lấy texel ở tâm là nearest-neighbour như trước. Với ảnh
/// thu nhỏ, duyệt toàn bộ footprint nhỏ (tối đa 16 texel); footprint lớn hơn dùng
/// lưới 3×3 để giữ chi phí hữu hạn nhưng vẫn không bỏ qua các đỉnh mực ở biên.
fn image_sample_candidates(
    inv: Matrix,
    dx: i64,
    dy: i64,
    width: u32,
    height: u32,
    center: (u32, u32),
) -> Vec<(u32, u32)> {
    let corners = [
        inv.apply(dx as f32, dy as f32),
        inv.apply(dx as f32 + 1.0, dy as f32),
        inv.apply(dx as f32, dy as f32 + 1.0),
        inv.apply(dx as f32 + 1.0, dy as f32 + 1.0),
    ];
    let min_u = corners.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
    let max_u = corners
        .iter()
        .map(|p| p.0)
        .fold(f32::NEG_INFINITY, f32::max);
    let min_v = corners.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
    let max_v = corners
        .iter()
        .map(|p| p.1)
        .fold(f32::NEG_INFINITY, f32::max);
    let footprint_w = (max_u - min_u) * width as f32;
    let footprint_h = (max_v - min_v) * height as f32;
    let mut out = vec![center];
    if footprint_w <= 1.05 && footprint_h <= 1.05 {
        return out;
    }

    let sx0 = ((min_u * width as f32).floor() as i64).clamp(0, width as i64 - 1);
    let sx1 = (((max_u * width as f32).ceil() as i64) - 1).clamp(0, width as i64 - 1);
    let sy0 = (((1.0 - max_v) * height as f32).floor() as i64).clamp(0, height as i64 - 1);
    let sy1 = ((((1.0 - min_v) * height as f32).ceil() as i64) - 1).clamp(0, height as i64 - 1);
    let area = (sx1 - sx0 + 1).max(0) * (sy1 - sy0 + 1).max(0);
    if area <= 16 {
        for sy in sy0..=sy1 {
            for sx in sx0..=sx1 {
                let p = (sx as u32, sy as u32);
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        return out;
    }

    for fy in [0.0_f32, 0.5, 1.0] {
        for fx in [0.0_f32, 0.5, 1.0] {
            let u = min_u + (max_u - min_u) * fx;
            let v = min_v + (max_v - min_v) * fy;
            let sx = ((u * width as f32).floor() as i64).clamp(0, width as i64 - 1) as u32;
            let sy =
                (((1.0 - v) * height as f32).floor() as i64).clamp(0, height as i64 - 1) as u32;
            let p = (sx, sy);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Nới hộp bao để chứa thêm một pixel đã composite.
fn include_pixel(region: &mut Region, x: u32, y: u32) {
    *region = region.union(Region {
        x0: x,
        y0: y,
        x1: x.saturating_add(1),
        y1: y.saturating_add(1),
    });
}

/// Hộp bao các pixel trong `candidate` thỏa điều kiện visibility.
///
/// Chỉ dùng trên đường diagnostic hiếm; giữ Region thay coverage map để metadata
/// nhỏ, đổi lại khoảng trống giữa các đảo vẫn được xem là vùng bảo thủ.
fn bounding_region_where_cancelled(
    candidate: Region,
    cancel_token: Option<&CancelToken>,
    mut visible: impl FnMut(u32, u32) -> bool,
) -> PpeResult<Region> {
    let mut region = Region::EMPTY;
    for y in candidate.y0..candidate.y1 {
        if let Some(token) = cancel_token {
            token.check()?;
        }
        for x in candidate.x0..candidate.x1 {
            if visible(x, y) {
                include_pixel(&mut region, x, y);
            }
        }
    }
    Ok(region)
}

/// Kiểm tra existence có short-circuit, vẫn nhả render khi token bị hủy.
fn any_pixel_where_cancelled(
    candidate: Region,
    cancel_token: Option<&CancelToken>,
    mut visible: impl FnMut(u32, u32) -> bool,
) -> PpeResult<bool> {
    for y in candidate.y0..candidate.y1 {
        if let Some(token) = cancel_token {
            token.check()?;
        }
        for x in candidate.x0..candidate.x1 {
            if visible(x, y) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Đưa provenance của Form soft-mask từ cửa sổ local về hệ pixel surface cha.
fn translate_explicit_mask_events(
    events: ExplicitMaskEvents,
    offset_x: u32,
    offset_y: u32,
    width: u32,
    height: u32,
) -> ExplicitMaskEvents {
    events
        .into_iter()
        .filter_map(|(event, region)| {
            let translated = Region {
                x0: region.x0.saturating_add(offset_x),
                y0: region.y0.saturating_add(offset_y),
                x1: region.x1.saturating_add(offset_x),
                y1: region.y1.saturating_add(offset_y),
            }
            .clamped(width, height);
            (!translated.is_empty()).then_some((event, translated))
        })
        .collect()
}

/// Giao hai hộp bao clip; kết quả không bao giờ được nới rộng clip cũ.
fn intersect_regions(a: Region, b: Region) -> Region {
    let region = Region {
        x0: a.x0.max(b.x0),
        y0: a.y0.max(b.y0),
        x1: a.x1.min(b.x1),
        y1: a.y1.min(b.y1),
    };
    if region.is_empty() {
        Region::EMPTY
    } else {
        region
    }
}

/// Nới một vùng pixel bằng guard-band rồi kẹp vào raster hiện hành.
fn expand_region(region: Region, padding: u32, width: u32, height: u32) -> Region {
    if region.is_empty() {
        return Region::EMPTY;
    }
    Region {
        x0: region.x0.saturating_sub(padding),
        y0: region.y0.saturating_sub(padding),
        x1: region.x1.saturating_add(padding).min(width),
        y1: region.y1.saturating_add(padding).min(height),
    }
}

#[cfg(test)]
mod conservative_sampling_tests {
    use super::*;

    #[test]
    fn soft_mask_peak_keeps_a_nearby_narrow_peak() {
        let owner = InkBuffer::new(7, 7, crate::ink::InkSpace::new()).unwrap();
        let mut mask = owner.new_soft_mask(Region::full(7, 7), 0.0).unwrap();
        mask.values_mut()[3 * 7 + 5] = 0.875;
        assert!((soft_mask_peak(&mask, 3, 3, 7, 7) - 0.875).abs() < 1e-6);
    }

    #[test]
    fn softproof_samples_exact_mask_while_ink_measurement_keeps_peak_guard() {
        let owner = InkBuffer::new(7, 7, crate::ink::InkSpace::new()).unwrap();
        let mut mask = owner.new_soft_mask(Region::full(7, 7), 0.0).unwrap();
        mask.values_mut()[3 * 7 + 5] = 0.875;

        let proof = RenderOptions::softproof();
        let ink = RenderOptions::ink_accurate();
        assert_eq!(
            image_soft_mask_value(&mask, 3, 3, 7, 7, proof.conservative_image_sampling,),
            0.0,
            "Viewer không được giãn alpha sang pixel lân cận"
        );
        assert!(
            (image_soft_mask_value(&mask, 3, 3, 7, 7, ink.conservative_image_sampling,) - 0.875)
                .abs()
                < 1e-6
        );
    }

    #[test]
    fn output_preview_object_filter_is_exclusive_and_source_filter_is_cross_kind() {
        let text = RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Text);
        assert!(text.allows_preview_object(PreviewObjectKind::Text));
        assert!(!text.allows_preview_object(PreviewObjectKind::Image));
        assert!(!text.needs_source_space_for_preview());

        let rgb =
            RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb);
        assert!(rgb.allows_preview_object(PreviewObjectKind::Text));
        assert!(rgb.allows_preview_object(PreviewObjectKind::Image));
        assert!(rgb.needs_source_space_for_preview());
        assert!(rgb.allows_preview_color_space(&ColorSpace::DeviceRGB));
        assert!(!rgb.allows_preview_color_space(&ColorSpace::DeviceCMYK));
    }

    #[test]
    fn magnified_image_keeps_only_center_texel() {
        let candidates = image_sample_candidates(Matrix::scale(0.1, 0.1), 0, 0, 4, 4, (0, 3));
        assert_eq!(candidates, vec![(0, 3)]);
    }

    #[test]
    fn minified_image_includes_source_footprint() {
        let candidates = image_sample_candidates(Matrix::scale(0.5, 0.5), 0, 0, 4, 4, (1, 2));
        assert!(candidates.len() > 1);
        assert!(candidates.contains(&(0, 2)));
        assert!(candidates.contains(&(1, 3)));
    }

    #[test]
    fn narrow_vector_path_uses_conservative_edge() {
        let path = rect_path(0.0, 0.0, 4.0, 40.0).unwrap();
        assert!(needs_conservative_vector_edge(&path, 100, 100));
    }

    #[test]
    fn large_vector_fill_keeps_pixel_center_rule() {
        let path = rect_path(0.0, 0.0, 40.0, 40.0).unwrap();
        assert!(!needs_conservative_vector_edge(&path, 100, 100));
    }

    #[test]
    fn large_raster_keeps_all_vector_edges() {
        let path = rect_path(0.0, 0.0, 40.0, 40.0).unwrap();
        assert!(needs_conservative_vector_edge(&path, 512, 700));
    }

    #[test]
    fn clip_region_intersection_never_expands_the_old_clip() {
        let old = Region {
            x0: 10,
            y0: 5,
            x1: 90,
            y1: 80,
        };
        let next = Region {
            x0: 30,
            y0: 0,
            x1: 120,
            y1: 40,
        };
        assert_eq!(
            intersect_regions(old, next),
            Region {
                x0: 30,
                y0: 5,
                x1: 90,
                y1: 40
            },
        );
        assert_eq!(
            intersect_regions(
                old,
                Region {
                    x0: 100,
                    y0: 0,
                    x1: 120,
                    y1: 4
                }
            ),
            Region::EMPTY,
        );
    }

    #[test]
    fn preview_grid_tracks_source_texels_only_while_minifying() {
        let one_device_pixel = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        assert_eq!(preview_image_sample_grid(&one_device_pixel, 6, 5), (6, 5));

        let magnified = [1.0 / 12.0, 0.0, 0.0, 1.0 / 10.0, 0.0, 0.0];
        assert_eq!(preview_image_sample_grid(&magnified, 6, 5), (1, 1));

        assert_eq!(
            preview_image_sample_grid(&one_device_pixel, 100, 100),
            (
                PREVIEW_IMAGE_MAX_SAMPLES_PER_AXIS,
                PREVIEW_IMAGE_MAX_SAMPLES_PER_AXIS,
            )
        );
    }

    #[test]
    fn preview_cmyk_footprint_keeps_a_one_texel_line_missed_by_center() {
        let inv = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let averaged = preview_device_cmyk_raw_average(&inv, 0, 0, 6, 6, (6, 6), |x, _y| {
            if x == 0 {
                [0, 0, 0, 255]
            } else {
                [0; 4]
            }
        })
        .expect("footprint nằm trong ảnh");

        assert!((averaged.footprint[3] - 1.0 / 6.0).abs() < 1e-6);
        assert_eq!(averaged.core.expect("lưới 6×6 phải có lõi")[3], 0.0);
        assert_eq!(tex_index(0.5 * 6.0, 6), 2);

        let partial = preview_device_cmyk_raw_average(
            &[1.0, 0.0, 0.0, 1.0, -0.25, 0.0],
            0,
            0,
            6,
            6,
            (6, 6),
            |_x, _y| [128; 4],
        )
        .expect("phần footprint còn nằm trong ảnh");
        assert_eq!(partial.core, None, "mép thiếu mẫu không được tăng chi tiết");
    }

    #[test]
    fn preview_detail_boost_is_thresholded_limited_and_keeps_thin_lines() {
        let unchanged = boost_preview_device_cmyk_detail(
            [0.5; 4],
            Some([0.5 + PREVIEW_IMAGE_DETAIL_THRESHOLD / 2.0; 4]),
        );
        assert_eq!(unchanged, [0.5; 4], "nhiễu dưới ngưỡng không được nổi lên");

        let boosted = boost_preview_device_cmyk_detail([0.0, 0.0, 0.0, 1.0 / 6.0], Some([0.0; 4]));
        assert!(boosted[3] > 0.12, "nét một texel vẫn phải nhìn thấy");
        assert!(
            boosted[3] < 1.0 / 6.0,
            "lõi sáng hơn phải giảm mực có giới hạn"
        );

        let limited = boost_preview_device_cmyk_detail([0.2; 4], Some([1.0; 4]));
        let max_gain = PREVIEW_IMAGE_DETAIL_LIMIT * PREVIEW_IMAGE_DETAIL_BOOST;
        assert!((limited[0] - (0.2 + max_gain)).abs() < 1e-6);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích operand
// ─────────────────────────────────────────────────────────────────────────────
fn blend_space_for_colorspace(cs: &ColorSpace) -> BlendSpace {
    match cs {
        ColorSpace::DeviceCMYK => BlendSpace::DeviceCmyk,
        ColorSpace::DeviceRGB => BlendSpace::DeviceRgb,
        ColorSpace::IccBased { alternate, .. } if alternate.n_components() == 4 => {
            BlendSpace::DeviceCmyk
        }
        _ => BlendSpace::Other,
    }
}

fn needs_pre_icc_blending(cs: &ColorSpace) -> bool {
    match cs {
        ColorSpace::DeviceRGB | ColorSpace::Lab => true,
        ColorSpace::IccBased { alternate, .. } => needs_pre_icc_blending(alternate),
        ColorSpace::Indexed { base, .. } => needs_pre_icc_blending(base),
        ColorSpace::Pattern { base: Some(base) } => needs_pre_icc_blending(base),
        ColorSpace::DeviceGray
        | ColorSpace::DeviceCMYK
        | ColorSpace::Separation { .. }
        | ColorSpace::DeviceN { .. }
        | ColorSpace::Pattern { base: None } => false,
    }
}

fn to_ts(m: &Matrix) -> Transform {
    Transform::from_row(m.a, m.b, m.c, m.d, m.e, m.f)
}

fn num_operand(operands: &[Object], i: usize) -> Option<f32> {
    operands.get(i).and_then(pdf::as_num)
}

fn name_operand(operands: &[Object], i: usize) -> Option<String> {
    operands.get(i).and_then(pdf::name_str)
}

/// Tên pattern đang chọn, chỉ khi colorspace hiện hành đúng là `/Pattern`.
///
/// Kiểm cả colorspace là cần thiết: tên pattern còn sót lại trong trạng thái sau
/// khi `cs` đã đổi sang colorspace khác, và tô gradient lên hình đáng lẽ tô màu
/// phẳng là lỗi rất khó truy.
/// Colorspace nền của `/Pattern` — bắt buộc với uncoloured tiling pattern.
fn pattern_base_cs(cs: &ColorSpace) -> Option<ColorSpace> {
    match cs {
        ColorSpace::Pattern { base } => base.as_ref().map(|b| (**b).clone()),
        _ => None,
    }
}

fn uses_pattern_color_space(stack: &StateStack, stroke: bool) -> bool {
    let gs = stack.current();
    let color_space = if stroke { &gs.stroke_cs } else { &gs.fill_cs };
    matches!(color_space, ColorSpace::Pattern { .. })
}

fn pattern_for(stack: &StateStack, stroke: bool) -> Option<String> {
    if !uses_pattern_color_space(stack, stroke) {
        return None;
    }
    let gs = stack.current();
    if stroke {
        gs.stroke_pattern.clone()
    } else {
        gs.fill_pattern.clone()
    }
}

fn string_operand(operands: &[Object], i: usize) -> Option<Vec<u8>> {
    match operands.get(i) {
        Some(Object::String(bytes, _)) => Some(bytes.clone()),
        _ => None,
    }
}

/// Lấy đúng `n` toán hạng số cuối cùng.
///
/// PDF hỏng có thể để thừa toán hạng trước operator; lấy `n` cái CUỐI là hành vi
/// khoan dung đúng (giống cách interpreter PostScript đọc từ đỉnh stack).
fn collect_nums(operands: &[Object], n: usize) -> Vec<f32> {
    let nums: Vec<f32> = operands.iter().filter_map(pdf::as_num).collect();
    if nums.len() > n {
        nums[nums.len() - n..].to_vec()
    } else {
        nums
    }
}

fn matrix_from(operands: &[Object]) -> Option<Matrix> {
    let v = collect_nums(operands, 6);
    (v.len() == 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5]))
}

fn as_bool(obj: &Object) -> Option<bool> {
    match obj {
        Object::Boolean(b) => Some(*b),
        _ => None,
    }
}

fn push_rect(builder: &mut PathBuilder, x: f32, y: f32, w: f32, h: f32) {
    builder.move_to(x, y);
    builder.line_to(x + w, y);
    builder.line_to(x + w, y + h);
    builder.line_to(x, y + h);
    builder.close();
}
