//! Interpreter content stream: operator PDF → thao tác mực.

use std::collections::HashMap;
use std::sync::Arc;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use tiny_skia::{LineCap, LineJoin, Mask, Path, PathBuilder, Transform};

use crate::blend::BlendMode;
use crate::color::icc::ColorManager;
use crate::color::space::{resolve_colorspace, resolve_function};
use crate::color::ColorSpace;
use crate::content::gstate::{GraphicsState, StateStack};
use crate::content::inline_image::{extract_inline_images, INLINE_OP};
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect, Region};
use crate::image::sampler::{decode_image, ImageSampler};
use crate::ink::{ChannelMask, InkBuffer, InkPaint, DEFAULT_RENDER_MEMORY_BUDGET_BYTES};
use crate::oc::OptionalContent;
use crate::pdf;
use crate::raster::mask::{rect_path, stroke_to_path, FillRule};
use crate::raster::Rasterizer;
use crate::shading::eval::SampledShading;
use crate::shading::mesh::MeshTriangle;
use crate::shading::{resolve_shading, Shading, ShadingKind};
use crate::text::font::{load_font, FontProgram, LoadedFont, Type3Data};
use crate::text::state::{TextObject, TextRenderMode};

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
    /// **Không bao giờ** bật ở đường đo: nó xoá kẽm spot.
    pub flatten_spots: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            anti_alias: true,
            max_form_depth: 12,
            memory_budget_bytes: DEFAULT_RENDER_MEMORY_BUDGET_BYTES,
            fallback_font: None,
            flatten_spots: false,
        }
    }
}

impl RenderOptions {
    /// Cấu hình đo lượng mực: không AA.
    pub fn ink_accurate() -> Self {
        RenderOptions {
            anti_alias: false,
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

    /// Đặt ngân sách bộ nhớ cho một lần render.
    pub fn with_memory_budget_bytes(mut self, bytes: usize) -> Self {
        self.memory_budget_bytes = bytes;
        self
    }

    /// Đặt font thay thế cho font không nhúng.
    pub fn with_fallback_font(mut self, data: Arc<Vec<u8>>) -> Self {
        self.fallback_font = Some(data);
        self
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
    /// Trang khai `/Group /CS /DeviceCMYK` thì alpha/blend diễn ra sau khi quy màu nguồn về CMYK.
    blend_space_cmyk: bool,
    /// Ma trận text hiện hành. Không nằm trong graphics state vì text object bị
    /// đặt lại ở mỗi `BT` và **không** được `q`/`Q` lưu (§9.4.1).
    text_obj: TextObject,
    /// Mặt nạ clip đang gom từ glyph (`Tr` 4–7), áp khi gặp `ET`.
    text_clip: Option<Mask>,
    /// Cache font theo `ObjectId`.
    font_cache: HashMap<ObjectId, Arc<LoadedFont>>,
    /// CTM lúc bắt đầu trang.
    ///
    /// `/Matrix` của pattern nối vào ma trận mặc định của trang, **không** vào CTM
    /// hiện hành (§8.7.3.1). Dùng CTM hiện hành sẽ làm gradient bị biến đổi hai lần
    /// khi pattern được tô bên trong một `cm`.
    base_ctm: Matrix,
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
    /// Đang ở trong ô của một **uncoloured** tiling pattern (`/PaintType 2`).
    ///
    /// Bên trong ô đó mọi operator màu bị bỏ qua (§8.7.3.3): màu do `scn` bên ngoài
    /// quyết định. Bộ đếm chứ không phải cờ vì ô có thể lồng pattern khác.
    suppress_color_ops: u32,
    /// Số lớp optional content đang **tắt** mà con trỏ đang nằm trong.
    ///
    /// Là bộ đếm ở mức renderer (không phải mức stream) để một Form XObject được
    /// `Do` bên trong lớp tắt cũng không vẽ gì — lớp tắt phải tắt xuyên qua ranh
    /// giới stream.
    oc_hidden: u32,
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

impl<'a> Renderer<'a> {
    pub fn new(
        doc: &'a Document,
        mut buffer: InkBuffer,
        opts: RenderOptions,
        color: Option<&'a ColorManager>,
        blend_space_cmyk: bool,
    ) -> PpeResult<Self> {
        let raster =
            Rasterizer::new(buffer.width(), buffer.height()).ok_or(PpeError::BadRasterSize {
                w: buffer.width() as i64,
                h: buffer.height() as i64,
                dpi: 0.0,
            })?;
        if blend_space_cmyk {
            buffer.set_rgb_sidecar_allowed(false);
        }
        Ok(Renderer {
            doc,
            buffer,
            raster,
            warnings: RenderWarnings::default(),
            opts,
            color,
            blend_space_cmyk,
            text_obj: TextObject::default(),
            text_clip: None,
            font_cache: HashMap::new(),
            base_ctm: Matrix::IDENTITY,
            smask_depth: 0,
            cur_depth: 0,
            suppress_color_ops: 0,
            oc: OptionalContent::load(doc),
            oc_hidden: 0,
        })
    }

    pub fn warnings(&self) -> &RenderWarnings {
        &self.warnings
    }

    pub fn into_parts(self) -> (InkBuffer, RenderWarnings) {
        (self.buffer, self.warnings)
    }

    /// Chạy một content stream với CTM và resources cho trước.
    pub fn run(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        base_ctm: Matrix,
    ) -> PpeResult<()> {
        // Ghi lại ma trận mặc định của trang cho `/Matrix` của pattern.
        self.base_ctm = base_ctm;
        let mut stack = StateStack::new(GraphicsState::initial(base_ctm));
        self.execute(data, resources, &mut stack, 0)?;
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
        Ok(())
    }

    fn execute(
        &mut self,
        data: &[u8],
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
        depth: u32,
    ) -> PpeResult<()> {
        if depth > self.opts.max_form_depth {
            self.warnings.note_skipped_op("Do (lồng quá sâu)");
            return Ok(());
        }

        // Ảnh nội tuyến phải bóc **trước** khi tokenize: dữ liệu giữa `ID` và `EI` là
        // nhị phân thô, bộ tokenize sẽ đọc nó thành operator rác rồi bỏ phần còn lại
        // của trang.
        let extracted = extract_inline_images(data);
        if extracted.failed > 0 {
            self.warnings.dropped_objects += extracted.failed;
            self.warnings
                .note_skipped_op("BI (ảnh nội tuyến không đọc được)");
        }
        let inline_images = extracted.images;

        let content = Content::decode(&extracted.data)
            .map_err(|e| PpeError::ContentStream(format!("{e}")))?;

        let mut path = PathState::default();
        // Độ sâu `q` lúc vào — dùng để dọn `q` thừa khi stream kết thúc.
        let entry_depth = stack.depth();
        // Ngăn xếp marked content của **stream này**: mỗi phần tử ghi "khối này có
        // mở một lớp đang tắt hay không". Cục bộ theo stream vì `BDC`/`EMC` phải cân
        // trong cùng một stream; còn bộ đếm `oc_hidden` thì ở mức renderer để lớp tắt
        // tắt xuyên qua Form XObject.
        let mut marked_content: Vec<bool> = Vec::new();

        for op in &content.operations {
            let operands = &op.operands;
            // Đặt lại ở mỗi operator: một lời gọi lồng (form, pattern, soft mask) đã
            // ghi độ sâu của nó vào đây và không có nghĩa vụ phục hồi.
            self.cur_depth = depth;
            match op.operator.as_str() {
                // ── Trạng thái ────────────────────────────────────────────────
                "q" => stack.save(),
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
                    let arr = operands
                        .first()
                        .and_then(|o| pdf::num_array(self.doc, o))
                        .unwrap_or_default();
                    let phase = num_operand(operands, 1).unwrap_or(0.0);
                    let gs = stack.current_mut();
                    gs.dash_array = arr;
                    gs.dash_phase = phase;
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
        while stack.depth() > entry_depth {
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
        } else {
            gs.fill_cs = cs;
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
        let (fill, stroke) = if self.oc_hidden_now() {
            (None, None)
        } else {
            (fill, stroke)
        };

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
                stack.current_mut().clip = Some(Arc::new(empty));
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
            let pattern = pattern_for(stack, false);
            let painted = match &pattern {
                Some(name) => self.paint_with_pattern(name, resources, dev, rule, stack, false)?,
                None => false,
            };
            if !painted && pattern.is_none() {
                let paint = self.make_paint(stack, false)?;
                if let Some(paint) = paint {
                    let clip = stack.current().clip.clone();
                    let soft = stack.current().soft_mask.clone();
                    let Renderer { raster, buffer, .. } = self;
                    if let Some(cov) = raster.fill_path(
                        dev,
                        rule,
                        self.opts.anti_alias,
                        clip.as_deref(),
                        soft.as_deref().map(|v| v.as_slice()),
                    ) {
                        buffer.composite_region(cov.data, cov.region, &paint)?;
                    }
                }
            }
        }

        if stroke.is_some() {
            let stroke_params = stack.current().build_stroke();
            if let Some(outline) = stroke_to_path(&user_path, &stroke_params, &ctm) {
                let pattern = pattern_for(stack, true);
                if let Some(name) = &pattern {
                    self.paint_with_pattern(
                        name,
                        resources,
                        &outline,
                        FillRule::NonZero,
                        stack,
                        true,
                    )?;
                }
                let paint = if pattern.is_some() {
                    None
                } else {
                    self.make_paint(stack, true)?
                };
                if let Some(paint) = paint {
                    let clip = stack.current().clip.clone();
                    let soft = stack.current().soft_mask.clone();
                    let Renderer { raster, buffer, .. } = self;
                    if let Some(cov) = raster.fill_path(
                        &outline,
                        FillRule::NonZero,
                        self.opts.anti_alias,
                        clip.as_deref(),
                        soft.as_deref().map(|v| v.as_slice()),
                    ) {
                        buffer.composite_region(cov.data, cov.region, &paint)?;
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
        stack.current_mut().clip = Some(Arc::new(mask));
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
        let blend_rgb = if matches!(cs, ColorSpace::DeviceRGB) && self.color.is_some() {
            if self.buffer.ensure_rgb_sidecar_with_color(self.color)? {
                Some([
                    comps.first().copied().unwrap_or(0.0).clamp(0.0, 1.0),
                    comps.get(1).copied().unwrap_or(0.0).clamp(0.0, 1.0),
                    comps.get(2).copied().unwrap_or(0.0).clamp(0.0, 1.0),
                ])
            } else {
                None
            }
        } else {
            None
        };
        self.mark_pre_icc_transparency_approximation(
            &cs,
            alpha,
            blend,
            gs.soft_mask.is_some(),
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
    ) {
        let transparent = alpha < 1.0 - 1e-6 || !blend.is_normal() || has_mask;
        if self.blend_space_cmyk {
            return;
        }
        let direct_rgb_supported =
            matches!(cs, ColorSpace::DeviceRGB) && self.buffer.has_rgb_sidecar();
        if transparent && needs_pre_icc_blending(cs) && !direct_rgb_supported {
            self.warnings.unsupported_transparency = true;
            self.warnings.note_skipped_op(
                "Transparency RGB/Lab: đang trộn trong ink space sau ICC",
            );
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
                        Ok(Some(mask)) => Some(Some(Arc::new(mask))),
                        Ok(None) => None,
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
        Ok(())
    }

    /// Giao clip với `/BBox` của một form (đã có `/Matrix` trong `ctm`).
    ///
    /// `/BBox` là clip **bắt buộc** (§8.10.2): nội dung tràn ra ngoài phải bị cắt.
    /// Với soft mask nó còn quan trọng hơn — vùng ngoài BBox phải mang giá trị nền
    /// (`/BC`), không phải giá trị của nội dung gần nhất.
    fn intersect_bbox(
        &mut self,
        clip: Option<Arc<Mask>>,
        bbox: Option<Rect>,
        ctm: &Matrix,
    ) -> Option<Arc<Mask>> {
        let Some(bbox) = bbox else { return clip };
        let Some(p) = rect_path(bbox.x0, bbox.y0, bbox.width(), bbox.height()) else {
            return clip;
        };
        let Some(dev) = p.transform(to_ts(ctm)) else {
            return clip;
        };
        let mut mask = match &clip {
            Some(existing) => (**existing).clone(),
            None => self.raster.full_clip(),
        };
        mask.intersect_path(
            &dev,
            FillRule::NonZero.into(),
            self.opts.anti_alias,
            Transform::identity(),
        );
        Some(Arc::new(mask))
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
        depth: u32,
    ) -> PpeResult<InkBuffer> {
        let parent = std::mem::replace(&mut self.buffer, child);
        // Text object không được rò qua ranh giới group: `BT` bên trong group là một
        // khối chữ độc lập.
        let saved_text_obj = self.text_obj;
        let saved_text_clip = self.text_clip.take();
        let mut sub = StateStack::new(initial);
        let result = self.execute(data, resources, &mut sub, depth + 1);
        self.text_obj = saved_text_obj;
        self.text_clip = saved_text_clip;
        let child = std::mem::replace(&mut self.buffer, parent);
        result.map(|()| child)
    }

    /// Dựng soft mask từ `/SMask` của ExtGState (§11.6.5).
    ///
    /// Trả về mảng `width*height` giá trị 0.0..=1.0 ở **toạ độ thiết bị**.
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
    ) -> PpeResult<Option<Vec<f32>>> {
        if self.smask_depth >= 4 {
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
        let data = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());

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

        let mut child = self.buffer.child_isolated()?;
        if luminosity {
            let cs = match &group_cs {
                Some(o) => resolve_colorspace(self.doc, o, form_res.as_ref(), &mut self.warnings)
                    .unwrap_or(ColorSpace::DeviceGray),
                None => ColorSpace::DeviceGray,
            };
            let comps = bc.unwrap_or_else(|| cs.initial_components());
            if let Some((ink, declared)) =
                cs.to_ink(&comps, child.space_mut(), &mut self.warnings, self.color)?
            {
                child.sync_channels()?;
                let mut ink = ink;
                ink.resize(child.space().len(), 0.0);
                let px = (child.width() as usize) * (child.height() as usize);
                let paint = InkPaint::opaque(ink, declared);
                child.composite(&vec![1.0; px], &paint)?;
            }
        }

        let mut initial = GraphicsState::initial(ctm);
        initial.clip = self.intersect_bbox(None, bbox, &ctm);

        self.smask_depth += 1;
        let rendered = self.render_form_into(child, &data, form_res.as_ref(), initial, depth);
        self.smask_depth -= 1;
        let rendered = rendered?;

        let mut mask = if luminosity {
            rendered.luminosity_plane()
        } else {
            rendered.alpha_plane().to_vec()
        };

        if let Some(tr_obj) = tr {
            match resolve_function(self.doc, &tr_obj) {
                Ok(f) => {
                    // LUT 256 ô: `/TR` là hàm một biến nên bảng tra là đủ chính xác
                    // và tránh gọi hàm hàng triệu lần cho một trang A4.
                    let lut: Vec<f32> = (0..256)
                        .map(|i| {
                            f.eval(&[i as f32 / 255.0])
                                .first()
                                .copied()
                                .unwrap_or(i as f32 / 255.0)
                                .clamp(0.0, 1.0)
                        })
                        .collect();
                    for v in mask.iter_mut() {
                        let idx = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as usize;
                        *v = lut[idx.min(255)];
                    }
                }
                Err(e) => {
                    // Không đọc được `/TR`: mặt nạ chưa qua hiệu chỉnh nên có thể
                    // che nhiều/ít hơn thực tế. Ghi nhận, giữ mặt nạ thô.
                    self.warnings.note_skipped_op(&format!("SMask /TR ({e})"));
                    self.warnings.unsupported_transparency = true;
                }
            }
        }

        Ok(Some(mask))
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
                let data = stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone());

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

                if let Some(group_dict) = group {
                    let mut isolated_rgb_group = false;
                    if let Some(group_cs_obj) =
                        pdf::dict_get(self.doc, group_dict, "CS").cloned()
                    {
                        if let Ok(group_cs) = resolve_colorspace(
                            self.doc,
                            &group_cs_obj,
                            form_res.as_ref(),
                            &mut self.warnings,
                        ) {
                            isolated_rgb_group = isolated
                                && matches!(&group_cs, ColorSpace::DeviceRGB)
                                && self.color.is_some();
                            if needs_pre_icc_blending(&group_cs) && !isolated_rgb_group {
                                self.warnings.unsupported_transparency = true;
                                self.warnings.note_skipped_op(
                                    "Group RGB/Lab: cần buffer theo blending color space trước ICC",
                                );
                            }
                        }
                    } else if isolated && !self.blend_space_cmyk && self.color.is_some() {
                        // `/CS` bỏ trống thì group thừa hưởng blending space của trang.
                        isolated_rgb_group = true;
                    }
                    return self.do_transparency_group(
                        &data,
                        form_res.as_ref(),
                        form_matrix,
                        bbox,
                        isolated,
                        knockout,
                        isolated_rgb_group,
                        stack,
                        depth,
                    );
                }

                stack.save();
                {
                    let gs = stack.current_mut();
                    gs.ctm = form_matrix.then(&gs.ctm);
                }
                // `BBox` là clip bắt buộc (§8.10.2): nội dung tràn ra ngoài BBox
                // phải bị cắt. Bỏ qua sẽ cho mực ra ngoài vùng hợp lệ.
                let ctm = stack.current().ctm;
                let clip = stack.current().clip.clone();
                stack.current_mut().clip = self.intersect_bbox(clip, bbox, &ctm);
                let saved_depth = stack.depth();
                self.execute_with_ctm(&data, form_res.as_ref(), stack, depth + 1, ctm)?;
                while stack.depth() > saved_depth {
                    stack.restore();
                }
                stack.restore();
            }
            "Image" => self.draw_image(entry, Some(resources), stack)?,
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
        isolated_rgb_group: bool,
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

        if knockout {
            // Knockout group: mỗi phần tử composite với nền **ban đầu** của group,
            // không với phần tử vẽ trước nó. Chưa dựng ⇒ vùng chồng lấn sẽ đọc ra
            // nhiều mực hơn thực tế.
            self.warnings.unsupported_transparency = true;
            self.warnings.note_skipped_op("Group /K true (knockout)");
        }

        let transparent = ca < 1.0 - 1e-6 || soft.is_some();
        if !transparent && blend.is_normal() && !isolated {
            stack.save();
            stack.current_mut().ctm = ctm;
            let clip = stack.current().clip.clone();
            stack.current_mut().clip = self.intersect_bbox(clip, bbox, &ctm);
            let saved_depth = stack.depth();
            let result = self.execute(data, resources, stack, depth + 1);
            while stack.depth() > saved_depth {
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

        let child = if isolated_rgb_group {
            self.buffer.child_isolated_rgb()?
        } else if isolated {
            self.buffer.child_isolated()?
        } else {
            self.buffer.child_non_isolated()?
        };
        let mut child = self.render_form_into(child, data, resources, initial, depth)?;
        if isolated_rgb_group {
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

        let px = (self.buffer.width() as usize) * (self.buffer.height() as usize);
        let factor: Vec<f32> = match &soft {
            Some(sm) => (0..px)
                .map(|i| ca * sm.get(i).copied().unwrap_or(1.0))
                .collect(),
            None => vec![ca; px],
        };

        if isolated {
            self.buffer
                .merge_isolated(&child, &factor, blend, overprint);
        } else {
            self.buffer
                .merge_non_isolated(&child, &factor, blend, overprint);
        }
        Ok(())
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
    /// Lấy mẫu là **nearest neighbour**, cố ý cả ở chế độ xem trước. Lấy trung
    /// bình vùng khi thu nhỏ sẽ làm **giảm** đỉnh mực, tức là TAC bị báo thiếu —
    /// đúng chiều sai nguy hiểm mà toàn bộ engine đang tránh.
    fn draw_image(
        &mut self,
        entry: &Object,
        resources: Option<&Dictionary>,
        stack: &mut StateStack,
    ) -> PpeResult<()> {
        let img = match decode_image(self.doc, entry, resources, &mut self.warnings) {
            Ok(img) => img,
            Err(e) => {
                // Không giải mã được (JPX, CCITT, dữ liệu hỏng): ghi nhận để hạ
                // accuracy. Trang có ảnh mà báo "sạch TAC" là kiểu sai tệ nhất.
                self.warnings.note_skipped_op(&format!("Do ảnh ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };

        let ctm = stack.current().ctm;
        let Some(inv) = ctm.invert() else {
            // CTM suy biến (scale 0): ảnh không chiếm diện tích nào.
            return Ok(());
        };

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
        let x0 = (min_x.floor() as i64).max(0);
        let x1 = (max_x.ceil() as i64).min(buf_w);
        let y0 = (min_y.floor() as i64).max(0);
        let y1 = (max_y.ceil() as i64).min(buf_h);
        if x0 >= x1 || y0 >= y1 {
            return Ok(());
        }

        let is_stencil = img.stencil.is_some();
        // Stencil (`/ImageMask`) lấy màu từ trạng thái tô hiện hành, không từ ảnh.
        let stencil_paint = if is_stencil {
            match self.make_paint(stack, false)? {
                Some(p) => Some(p),
                None => return Ok(()), // colorant /None
            }
        } else {
            None
        };

        let gs = stack.current();
        let base_alpha = gs.fill_alpha.clamp(0.0, 1.0);
        let overprint = gs.fill_overprint;
        let blend = gs.blend_mode;
        let clip = gs.clip.clone();
        let soft = gs.soft_mask.clone();
        let image_rgb_sidecar = matches!(img.colorspace.as_ref(), Some(ColorSpace::DeviceRGB))
            && self.color.is_some()
            && self.buffer.ensure_rgb_sidecar_with_color(self.color)?;
        if let Some(cs) = &img.colorspace {
            self.mark_pre_icc_transparency_approximation(
                cs,
                base_alpha,
                blend,
                soft.is_some() || img.alpha.is_some(),
            );
        }
        // Như ở shading: `OPM = 1` phải được áp cho cả đường ảnh, vì ảnh cũng dựng
        // `InkPaint` trực tiếp cho từng pixel thay vì đi qua `make_paint`.
        let opm_one = gs.overprint_mode == 1
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

        let mut ink_scratch: Vec<f32> = Vec::with_capacity(8);
        let iw = img.width as f32;
        let ih = img.height as f32;

        for dy in y0..y1 {
            for dx in x0..x1 {
                // Tâm pixel thiết bị → toạ độ ảnh trong hình vuông đơn vị.
                let (u, v) = inv.apply(dx as f32 + 0.5, dy as f32 + 0.5);
                if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
                    continue;
                }
                // Hàng 0 của ảnh nằm ở **đỉnh** hình vuông đơn vị (v = 1), nên
                // phải lật v. Quên bước này thì ảnh in ngược trên-dưới.
                let sx = (u * iw) as u32;
                let sy = ((1.0 - v) * ih) as u32;
                let sx = sx.min(img.width - 1);
                let sy = sy.min(img.height - 1);

                let index = (dy as usize) * (buf_w as usize) + (dx as usize);

                let mut coverage = base_alpha * img.alpha_at(sx, sy);
                if let Some(mask) = &clip {
                    coverage *= mask.data()[index] as f32 / 255.0;
                }
                if let Some(sm) = &soft {
                    coverage *= sm.get(index).copied().unwrap_or(1.0);
                }
                if coverage <= 0.0 {
                    continue;
                }

                if let Some(paint) = &stencil_paint {
                    if !img.stencil_at(sx, sy) {
                        continue;
                    }
                    let mut p = paint.clone();
                    p.alpha = coverage;
                    self.buffer.composite_at(index, 1.0, &p);
                    continue;
                }

                let mask = sampler.ink_into(
                    sx,
                    sy,
                    &mut ink_scratch,
                    self.buffer.space_mut(),
                    &mut self.warnings,
                    self.color,
                )?;
                let Some(declared) = mask else { continue };
                // DeviceN trong ảnh có thể đăng ký spot mới giữa vòng lặp.
                self.buffer.sync_channels()?;
                ink_scratch.resize(self.buffer.space().len(), 0.0);

                let mut paint = InkPaint {
                    ink: std::mem::take(&mut ink_scratch),
                    declared,
                    overprint,
                    alpha: coverage,
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
                ink_scratch = paint.ink;
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
        // báo cáo vẫn nói trang sạch.
        if self.oc_hidden_now() {
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
        let shading = match resolve_shading(self.doc, &entry, Some(resources), &mut self.warnings) {
            Ok(s) => s,
            Err(e) => {
                // Kiểu lưới hoặc dict hỏng: ghi nhận để trang rơi về Ghostscript.
                self.warnings.note_skipped_op(&format!("sh ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(());
            }
        };

        let ctm = stack.current().ctm;
        let coverage = self.coverage_from_clip(stack);
        // `sh` phủ toàn bộ vùng clip, nên vùng bao là cả trang.
        let region = Region::full(self.buffer.width(), self.buffer.height());
        self.paint_shading(&shading, &ctm, &coverage, region, stack, false)
    }

    /// Độ phủ bằng chính mặt nạ clip ∩ soft mask (hoặc toàn trang nếu không có).
    fn coverage_from_clip(&self, stack: &StateStack) -> Vec<f32> {
        let px = (self.buffer.width() as usize) * (self.buffer.height() as usize);
        let gs = stack.current();
        let mut cov: Vec<f32> = match &gs.clip {
            Some(mask) => mask.data().iter().map(|v| *v as f32 / 255.0).collect(),
            None => vec![1.0; px],
        };
        if let Some(sm) = &gs.soft_mask {
            for (i, c) in cov.iter_mut().enumerate() {
                *c *= sm.get(i).copied().unwrap_or(1.0);
            }
        }
        cov
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
        coverage: &[f32],
        region: Region,
        stack: &mut StateStack,
        stroke: bool,
    ) -> PpeResult<()> {
        let gs = stack.current();
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
        let shading_rgb_sidecar = matches!(shading.colorspace, ColorSpace::DeviceRGB)
            && self.color.is_some()
            && self.buffer.ensure_rgb_sidecar_with_color(self.color)?;
        self.mark_pre_icc_transparency_approximation(
            &shading.colorspace,
            alpha,
            blend,
            gs.soft_mask.is_some(),
        );

        // Lưới đi đường riêng: màu của nó nằm ở đỉnh tam giác, không phải là hàm của
        // vị trí, nên bảng LUT theo `t` không dùng được.
        if let ShadingKind::Mesh { triangles } = &shading.kind {
            let triangles = triangles.clone();
            return self.paint_mesh(
                &triangles,
                &shading.colorspace,
                ctm,
                coverage,
                region,
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
        let mut ink_scratch: Vec<f32> = vec![0.0; n];
        let region = region.clamped(self.buffer.width(), self.buffer.height());

        for y in region.y0..region.y1 {
            for x in region.x0..region.x1 {
                let index = y as usize * w + x as usize;
                let cov = coverage.get(index).copied().unwrap_or(0.0);
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
                ink_scratch = paint.ink;
            }
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
        coverage: &[f32],
        region: Region,
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
        let preserve_rgb =
            matches!(cs, ColorSpace::DeviceRGB) && self.buffer.has_rgb_sidecar();
        for tri in triangles {
            // Quy màu ba đỉnh sang mực trước khi quét pixel.
            let mut verts: [(f32, f32); 3] = [(0.0, 0.0); 3];
            let mut inks: [Vec<f32>; 3] = Default::default();
            let mut rgbs = [[0.0f32; 3]; 3];
            let mut declared = ChannelMask::EMPTY;
            let mut usable = true;
            for k in 0..3 {
                verts[k] = ctm.apply(tri.p[k][0], tri.p[k][1]);
                if preserve_rgb {
                    rgbs[k] = [
                        tri.c[k].first().copied().unwrap_or(0.0).clamp(0.0, 1.0),
                        tri.c[k].get(1).copied().unwrap_or(0.0).clamp(0.0, 1.0),
                        tri.c[k].get(2).copied().unwrap_or(0.0).clamp(0.0, 1.0),
                    ];
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
                let py = y as f32 + 0.5;
                for x in bx0..bx1 {
                    let index = y as usize * w + x as usize;
                    let cov = coverage[index];
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
                    ink_scratch = paint.ink;
                }
            }
        }
        Ok(())
    }

    /// Tô/vẽ nét bằng pattern. `Ok(true)` nếu đã vẽ được.
    ///
    /// Chỉ shading pattern (`/PatternType 2`) được vẽ. Tiling pattern
    /// (`/PatternType 1`) chưa dựng nên bị ghi nhận và trang rơi về Ghostscript —
    /// tô một màu xấp xỉ ở đây sẽ cho ra lượng mực bịa.
    fn paint_with_pattern(
        &mut self,
        pattern_name: &str,
        resources: Option<&Dictionary>,
        device_path: &Path,
        rule: FillRule,
        stack: &mut StateStack,
        stroke: bool,
    ) -> PpeResult<bool> {
        let Some(res) = resources else {
            return Ok(false);
        };
        let Some(patterns) = pdf::dict_get_dict(self.doc, res, "Pattern") else {
            return Ok(false);
        };
        let Ok(raw) = patterns.get(pattern_name.as_bytes()) else {
            return Ok(false);
        };
        let entry = pdf::deref(self.doc, raw).clone();
        let (pattern_dict, cell_data) = match &entry {
            Object::Dictionary(d) => (d.clone(), None),
            Object::Stream(s) => (
                s.dict.clone(),
                Some(
                    s.decompressed_content()
                        .unwrap_or_else(|_| s.content.clone()),
                ),
            ),
            _ => return Ok(false),
        };
        let pattern_dict = &pattern_dict;

        let ptype = pdf::dict_get(self.doc, pattern_dict, "PatternType")
            .and_then(pdf::as_num)
            .unwrap_or(0.0) as i32;
        if ptype == 1 {
            return self.paint_tiling_pattern(
                pattern_dict,
                cell_data,
                device_path,
                rule,
                stack,
                stroke,
            );
        }
        if ptype != 2 {
            self.warnings
                .note_skipped_op(&format!("pattern kiểu {ptype} không hợp lệ"));
            self.warnings.dropped_objects += 1;
            return Ok(false);
        }

        let Ok(shading_obj) = pattern_dict.get(b"Shading") else {
            return Ok(false);
        };
        let shading_obj = shading_obj.clone();
        let shading = match resolve_shading(self.doc, &shading_obj, resources, &mut self.warnings) {
            Ok(s) => s,
            Err(e) => {
                self.warnings
                    .note_skipped_op(&format!("shading pattern ({e})"));
                self.warnings.dropped_objects += 1;
                return Ok(false);
            }
        };

        // `/Matrix` của pattern nối vào CTM **của lúc bắt đầu trang/form**, không
        // phải CTM hiện hành (§8.7.3.1). Engine dùng CTM hiện hành làm xấp xỉ khi
        // không theo dõi được ma trận gốc; với phần lớn file hai giá trị này trùng
        // nhau vì pattern được dùng ngay trong không gian mặc định.
        let pattern_matrix = pdf::dict_get(self.doc, pattern_dict, "Matrix")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
            .unwrap_or(Matrix::IDENTITY);
        let ctm = pattern_matrix.then(&self.base_ctm);

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
                soft.as_deref().map(|v| v.as_slice()),
            ) {
                Some(cov) => (cov.data.to_vec(), cov.region),
                None => return Ok(true),
            }
        };

        self.paint_shading(&shading, &ctm, &coverage, region, stack, stroke)?;
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
    /// Vượt trần thì **báo thiếu tính năng** và nhường Ghostscript, chứ không vẽ một
    /// phần số ô — vẽ một phần cho ra lượng mực thấp hơn thực tế, đúng chiều sai
    /// nguy hiểm.
    fn paint_tiling_pattern(
        &mut self,
        pattern: &Dictionary,
        cell_data: Option<Vec<u8>>,
        device_path: &Path,
        rule: FillRule,
        stack: &mut StateStack,
        stroke: bool,
    ) -> PpeResult<bool> {
        /// Trần số ô cho một lần tô.
        const MAX_TILES: usize = 1024;

        let Some(data) = cell_data else {
            self.warnings
                .note_skipped_op("tiling pattern không có content stream");
            self.warnings.dropped_objects += 1;
            return Ok(false);
        };
        let depth = self.cur_depth;
        if depth + 1 > self.opts.max_form_depth {
            self.warnings.note_skipped_op("tiling pattern lồng quá sâu");
            self.warnings.dropped_objects += 1;
            return Ok(false);
        }

        let Some(bbox) = pdf::dict_get(self.doc, pattern, "BBox")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 4).then(|| Rect::new(v[0], v[1], v[2], v[3])))
        else {
            self.warnings.note_skipped_op("tiling pattern thiếu /BBox");
            self.warnings.dropped_objects += 1;
            return Ok(false);
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
            self.warnings
                .note_skipped_op("tiling pattern có bước không hợp lệ");
            self.warnings.dropped_objects += 1;
            return Ok(false);
        }
        let paint_type = pdf::dict_get(self.doc, pattern, "PaintType")
            .and_then(pdf::as_num)
            .unwrap_or(1.0) as i32;
        let cell_res = pdf::dict_get_dict(self.doc, pattern, "Resources").cloned();
        let pattern_matrix = pdf::dict_get(self.doc, pattern, "Matrix")
            .and_then(|o| pdf::num_array(self.doc, o))
            .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
            .unwrap_or(Matrix::IDENTITY);
        // Như shading pattern: `/Matrix` nối vào ma trận mặc định của trang, không
        // vào CTM hiện hành (§8.7.3.1).
        let ctm = pattern_matrix.then(&self.base_ctm);
        let Some(inv) = ctm.invert() else {
            return Ok(false); // ma trận suy biến ⇒ pattern không chiếm diện tích
        };

        // Vùng phủ = đường dẫn ∩ clip ∩ soft mask, giữ dạng mặt nạ để dùng làm clip
        // cho từng ô.
        let clip = stack.current().clip.clone();
        let soft = stack.current().soft_mask.clone();
        let (mask_w, mask_h) = (self.raster.width(), self.raster.height());
        let (base_mask, region) = {
            let Renderer { raster, .. } = self;
            let Some(cov) = raster.fill_path(
                device_path,
                rule,
                self.opts.anti_alias,
                clip.as_deref(),
                soft.as_deref().map(|v| v.as_slice()),
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
            return Ok(false);
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
            self.warnings
                .note_skipped_op(&format!("tiling pattern {tiles} ô vượt trần {MAX_TILES}"));
            self.warnings.dropped_objects += 1;
            return Ok(false);
        }

        for j in j0..=j1 {
            for i in i0..=i1 {
                let tile_ctm = Matrix::translate(i as f32 * xstep, j as f32 * ystep).then(&ctm);

                let mut initial = stack.current().clone();
                initial.ctm = tile_ctm;
                // Soft mask đã được nhân vào `base_mask`; giữ lại sẽ nhân hai lần.
                initial.soft_mask = None;
                initial.fill_pattern = None;
                initial.stroke_pattern = None;
                initial.clip = self.intersect_bbox(Some(base_mask.clone()), Some(bbox), &tile_ctm);

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
                        self.warnings
                            .note_skipped_op("tiling pattern /PaintType 2 thiếu colorspace nền");
                        self.warnings.dropped_objects += 1;
                        return Ok(false);
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
                if paint_type == 2 {
                    self.suppress_color_ops += 1;
                }
                let result = self.execute(&data, cell_res.as_ref(), &mut sub, depth + 1);
                if paint_type == 2 {
                    self.suppress_color_ops -= 1;
                }
                self.text_obj = saved_text_obj;
                self.text_clip = saved_text_clip;
                result?;
            }
        }

        Ok(true)
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

            if mode.paints_ink() || mode.adds_to_clip() {
                self.draw_glyph(&font, code, resources, stack, depth, mode)?;
            }

            let gs = stack.current();
            let tx = crate::text::state::glyph_advance(&gs.text, width, raw_byte_is_space);
            self.text_obj.advance(tx, 0.0);
        }
        Ok(())
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
            return Ok(());
        }
        let gs_ctm = stack.current().ctm;
        let trm = crate::text::state::glyph_matrix(&stack.current().text, &self.text_obj.matrix);

        // Type3: glyph là một content stream, không phải đường viền.
        if let Some(t3) = font.type3.clone() {
            return self.draw_type3_glyph(font, &t3, code, resources, stack, depth);
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

        if mode.fills() {
            if let Some(paint) = self.make_paint(stack, false)? {
                let clip = stack.current().clip.clone();
                let soft = stack.current().soft_mask.clone();
                let Renderer { raster, buffer, .. } = self;
                if let Some(cov) = raster.fill_path(
                    &device_path,
                    FillRule::NonZero,
                    self.opts.anti_alias,
                    clip.as_deref(),
                    soft.as_deref().map(|v| v.as_slice()),
                ) {
                    buffer.composite_region(cov.data, cov.region, &paint)?;
                }
            }
        }
        if mode.strokes() {
            // Nét của chữ có bề rộng theo toạ độ người dùng, nên phải dựng outline
            // trong không gian glyph rồi mới biến đổi — giống hệt đường vector.
            let stroke = stack.current().build_stroke();
            let glyph_user = outline.as_ref().clone().transform(to_ts(&trm));
            if let Some(p) = glyph_user {
                if let Some(outlined) = stroke_to_path(&p, &stroke, &gs_ctm) {
                    if let Some(paint) = self.make_paint(stack, true)? {
                        let clip = stack.current().clip.clone();
                        let soft = stack.current().soft_mask.clone();
                        let Renderer { raster, buffer, .. } = self;
                        if let Some(cov) = raster.fill_path(
                            &outlined,
                            FillRule::NonZero,
                            self.opts.anti_alias,
                            clip.as_deref(),
                            soft.as_deref().map(|v| v.as_slice()),
                        ) {
                            buffer.composite_region(cov.data, cov.region, &paint)?;
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
        let Some(data) = pdf::stream_data(self.doc, proc_obj) else {
            return Ok(());
        };

        let trm = crate::text::state::glyph_matrix(&stack.current().text, &self.text_obj.matrix);
        let ctm = t3.font_matrix.then(&trm).then(&stack.current().ctm);

        // Resources của font Type3 thắng resources của trang; thiếu thì kế thừa.
        let res = t3.resources.clone().or_else(|| resources.cloned());

        stack.save();
        stack.current_mut().ctm = ctm;
        let saved_depth = stack.depth();
        // Glyph Type3 có thể vẽ chữ bên trong → phải lưu text object, nếu không
        // con trỏ chữ của dòng ngoài sẽ bị glyph làm lệch.
        let saved_text_obj = self.text_obj;
        let result = self.execute(&data, res.as_ref(), stack, depth + 1);
        self.text_obj = saved_text_obj;
        while stack.depth() > saved_depth {
            stack.restore();
        }
        stack.restore();
        result
    }

    /// Gom glyph vào mặt nạ clip của khối text (`Tr` 4–7).
    fn accumulate_text_clip(&mut self, device_path: &Path) {
        let mask = self.text_clip.get_or_insert_with(|| {
            Mask::new(self.raster.width(), self.raster.height()).expect("kích thước raster đã kiểm")
        });
        mask.fill_path(
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
        let Some(text_mask) = self.text_clip.take() else {
            return Ok(());
        };
        let mut combined = match &stack.current().clip {
            Some(existing) => (**existing).clone(),
            None => self.raster.full_clip(),
        };
        for (dst, src) in combined.data_mut().iter_mut().zip(text_mask.data().iter()) {
            *dst = ((*dst as u32 * *src as u32) / 255) as u8;
        }
        stack.current_mut().clip = Some(Arc::new(combined));
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

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích operand
// ─────────────────────────────────────────────────────────────────────────────

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

fn pattern_for(stack: &StateStack, stroke: bool) -> Option<String> {
    let gs = stack.current();
    let cs = if stroke { &gs.stroke_cs } else { &gs.fill_cs };
    if !matches!(cs, ColorSpace::Pattern { .. }) {
        return None;
    }
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
