//! Interpreter content stream: operator PDF → thao tác mực.

use std::collections::HashMap;
use std::sync::Arc;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use tiny_skia::{LineCap, LineJoin, Mask, Path, PathBuilder, Transform};

use crate::color::icc::ColorManager;
use crate::color::space::resolve_colorspace;
use crate::color::ColorSpace;
use crate::content::gstate::{GraphicsState, StateStack};
use crate::content::inline_image::strip_inline_images;
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect};
use crate::image::sampler::{decode_image, ImageSampler};
use crate::ink::{InkBuffer, InkPaint};
use crate::pdf;
use crate::raster::mask::{rect_path, stroke_to_path, FillRule};
use crate::raster::Rasterizer;
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
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            anti_alias: true,
            max_form_depth: 12,
            fallback_font: None,
        }
    }
}

impl RenderOptions {
    /// Cấu hình đo lượng mực: không AA.
    pub fn ink_accurate() -> Self {
        RenderOptions { anti_alias: false, ..Default::default() }
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
    /// Ma trận text hiện hành. Không nằm trong graphics state vì text object bị
    /// đặt lại ở mỗi `BT` và **không** được `q`/`Q` lưu (§9.4.1).
    text_obj: TextObject,
    /// Mặt nạ clip đang gom từ glyph (`Tr` 4–7), áp khi gặp `ET`.
    text_clip: Option<Mask>,
    /// Cache font theo `ObjectId`.
    font_cache: HashMap<ObjectId, Arc<LoadedFont>>,
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
        buffer: InkBuffer,
        opts: RenderOptions,
        color: Option<&'a ColorManager>,
    ) -> PpeResult<Self> {
        let raster = Rasterizer::new(buffer.width(), buffer.height()).ok_or(
            PpeError::BadRasterSize {
                w: buffer.width() as i64,
                h: buffer.height() as i64,
                dpi: 0.0,
            },
        )?;
        Ok(Renderer {
            doc,
            buffer,
            raster,
            warnings: RenderWarnings::default(),
            opts,
            color,
            text_obj: TextObject::default(),
            text_clip: None,
            font_cache: HashMap::new(),
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
        let mut stack = StateStack::new(GraphicsState::initial(base_ctm));
        self.execute(data, resources, &mut stack, 0)?;
        if stack.unbalanced_restores > 0 {
            self.warnings.note_skipped_op("Q (không cân)");
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

        let stripped = strip_inline_images(data);
        if stripped.count > 0 {
            self.warnings.dropped_objects += stripped.count;
            self.warnings.note_skipped_op("BI (ảnh nội tuyến)");
        }

        let content = Content::decode(&stripped.data)
            .map_err(|e| PpeError::ContentStream(format!("{e}")))?;

        let mut path = PathState::default();
        // Độ sâu `q` lúc vào — dùng để dọn `q` thừa khi stream kết thúc.
        let entry_depth = stack.depth();

        for op in &content.operations {
            let operands = &op.operands;
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
                        self.apply_ext_gstate(&name, res, stack)?;
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
                    if let (Some(x), Some(y)) = (num_operand(operands, 0), num_operand(operands, 1)) {
                        path.builder.move_to(x, y);
                        path.start = Some((x, y));
                        path.current = Some((x, y));
                    }
                }
                "l" => {
                    if let (Some(x), Some(y)) = (num_operand(operands, 0), num_operand(operands, 1)) {
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
                "n" => self.end_path(&mut path, stack, None, None)?,
                "f" | "F" => {
                    self.end_path(&mut path, stack, Some(FillRule::NonZero), None)?
                }
                "f*" => self.end_path(&mut path, stack, Some(FillRule::EvenOdd), None)?,
                "S" => self.end_path(&mut path, stack, None, Some(false))?,
                "s" => {
                    path.builder.close();
                    self.end_path(&mut path, stack, None, Some(false))?
                }
                "B" => self.end_path(&mut path, stack, Some(FillRule::NonZero), Some(true))?,
                "B*" => self.end_path(&mut path, stack, Some(FillRule::EvenOdd), Some(true))?,
                "b" => {
                    path.builder.close();
                    self.end_path(&mut path, stack, Some(FillRule::NonZero), Some(true))?
                }
                "b*" => {
                    path.builder.close();
                    self.end_path(&mut path, stack, Some(FillRule::EvenOdd), Some(true))?
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
                                self.warnings
                                    .note_approximated_colorspace(&format!("{e}"));
                            }
                        }
                    }
                }
                "sc" | "scn" | "SC" | "SCN" => {
                    let stroke = matches!(op.operator.as_str(), "SC" | "SCN");
                    // `scn` có thể kết thúc bằng tên pattern; số thì lấy hết.
                    let nums: Vec<f32> = operands
                        .iter()
                        .filter_map(|o| pdf::as_num(o))
                        .collect();
                    let is_pattern = operands.iter().any(|o| matches!(o, Object::Name(_)));
                    if is_pattern {
                        // Pattern chưa vẽ: ghi nhận để hạ accuracy thay vì tô đen.
                        self.warnings.note_skipped_op("scn (pattern)");
                        self.warnings.dropped_objects += 1;
                    }
                    if !nums.is_empty() {
                        self.set_components(stack, stroke, nums);
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
                    self.warnings.note_skipped_op("sh (shading)");
                    self.warnings.dropped_objects += 1;
                }
                "BDC" | "BMC" | "EMC" | "MP" | "DP" => {
                    // Optional content (/OC) có thể ẩn nội dung. Chưa xét trạng thái
                    // bật/tắt ⇒ nội dung đang TẮT vẫn bị vẽ lên kẽm. Đây là rủi ro
                    // ngược chiều với `dropped_objects` (thừa mực, không phải thiếu),
                    // nên đi vào cờ riêng thay vì gộp chung.
                    if op.operator == "BDC" && name_operand(operands, 0).as_deref() == Some("OC") {
                        self.warnings.hidden_content_risk = true;
                        self.warnings.note_skipped_op("BDC /OC (optional content)");
                    }
                }
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
                        stack.current_mut().text.render_mode =
                            TextRenderMode::from_code(v as i32);
                    }
                }
                "Td" => {
                    if let (Some(tx), Some(ty)) = (num_operand(operands, 0), num_operand(operands, 1))
                    {
                        self.text_obj.next_line_offset(tx, ty);
                    }
                }
                "TD" => {
                    // `TD` vừa xuống dòng vừa đặt leading = −ty (§9.4.2).
                    if let (Some(tx), Some(ty)) = (num_operand(operands, 0), num_operand(operands, 1))
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
                                        let tx = -adj / 1000.0
                                            * gs.text.size
                                            * gs.text.horizontal_scale;
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

        // `q` thừa khi stream kết thúc: dọn về đúng độ sâu để form lồng nhau không
        // rò trạng thái ra ngoài.
        while stack.depth() > entry_depth {
            stack.restore();
        }
        Ok(())
    }

    fn set_color_space(&mut self, stack: &mut StateStack, stroke: bool, cs: ColorSpace) {
        let gs = stack.current_mut();
        if stroke {
            gs.stroke_cs = cs;
        } else {
            gs.fill_cs = cs;
        }
    }

    fn set_components(&mut self, stack: &mut StateStack, stroke: bool, comps: Vec<f32>) {
        if comps.is_empty() {
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
    ) -> PpeResult<()> {
        let built = std::mem::take(&mut path.builder).finish();
        let pending_clip = path.pending_clip.take();
        let had_segments = path.has_segments;
        *path = PathState::default();

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
            let paint = self.make_paint(stack, false)?;
            if let Some(paint) = paint {
                let Renderer { raster, buffer, .. } = self;
                let clip = stack.current().clip.clone();
                if let Some(cov) =
                    raster.fill_path(dev, rule, self.opts.anti_alias, clip.as_deref())
                {
                    buffer.composite(cov, &paint);
                }
            }
        }

        if stroke.is_some() {
            let stroke_params = stack.current().build_stroke();
            if let Some(outline) = stroke_to_path(&user_path, &stroke_params, &ctm) {
                let paint = self.make_paint(stack, true)?;
                if let Some(paint) = paint {
                    let Renderer { raster, buffer, .. } = self;
                    let clip = stack.current().clip.clone();
                    if let Some(cov) = raster.fill_path(
                        &outline,
                        FillRule::NonZero,
                        self.opts.anti_alias,
                        clip.as_deref(),
                    ) {
                        buffer.composite(cov, &paint);
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

        let Some((ink, declared)) =
            cs.to_ink(&comps, self.buffer.space_mut(), &mut self.warnings, self.color)?
        else {
            return Ok(None);
        };
        self.buffer.sync_channels();

        // Vector mực phải dài đúng số kênh hiện tại (spot có thể vừa được thêm).
        let mut ink = ink;
        ink.resize(self.buffer.space().len(), 0.0);

        let mut paint = InkPaint {
            ink,
            declared,
            overprint,
            alpha: alpha.clamp(0.0, 1.0),
        };
        if opm == 1 && matches!(cs, ColorSpace::DeviceCMYK | ColorSpace::IccBased { .. }) {
            paint = paint.with_overprint_mode_1();
        }
        Ok(Some(paint))
    }

    /// `gs` — áp ExtGState.
    fn apply_ext_gstate(
        &mut self,
        name: &str,
        resources: &Dictionary,
        stack: &mut StateStack,
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
        let has_smask = pdf::dict_get(self.doc, entry, "SMask")
            .map(|o| !matches!(pdf::name_str(o).as_deref(), Some("None")))
            .unwrap_or(false);
        let blend = pdf::dict_get(self.doc, entry, "BM").and_then(|o| match o {
            Object::Name(_) => pdf::name_str(o),
            Object::Array(items) => items.first().and_then(pdf::name_str),
            _ => None,
        });

        if has_smask {
            // Soft mask chưa dựng: kết quả không còn là chuẩn RIP.
            self.warnings.unsupported_transparency = true;
            self.warnings.note_skipped_op("SMask");
        }
        if let Some(bm) = blend {
            if bm != "Normal" && bm != "Compatible" {
                self.warnings.unsupported_transparency = true;
                self.warnings.note_skipped_op(&format!("BM /{bm}"));
            }
        }

        let gs = stack.current_mut();
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

                // Group trong suốt (isolated/knockout) chưa dựng riêng ⇒ ghi nhận.
                if pdf::dict_get_dict(self.doc, &stream.dict, "Group").is_some() {
                    self.warnings.unsupported_transparency = true;
                }

                stack.save();
                {
                    let gs = stack.current_mut();
                    gs.ctm = form_matrix.then(&gs.ctm);
                }
                // `BBox` là clip bắt buộc (§8.10.2): nội dung tràn ra ngoài BBox
                // phải bị cắt. Bỏ qua sẽ cho mực ra ngoài vùng hợp lệ.
                if let Some(bbox) = bbox {
                    let ctm = stack.current().ctm;
                    if let Some(p) = rect_path(bbox.x0, bbox.y0, bbox.width(), bbox.height()) {
                        if let Some(dev) = p.transform(to_ts(&ctm)) {
                            self.intersect_clip(stack, &dev, FillRule::NonZero)?;
                        }
                    }
                }
                let ctm = stack.current().ctm;
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
        let clip = gs.clip.clone();

        let sampler = ImageSampler::new(&img, self.buffer.space_mut(), &mut self.warnings, self.color)?;
        self.buffer.sync_channels();

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
                self.buffer.sync_channels();
                ink_scratch.resize(self.buffer.space().len(), 0.0);

                let paint = InkPaint {
                    ink: std::mem::take(&mut ink_scratch),
                    declared,
                    overprint,
                    alpha: coverage,
                };
                self.buffer.composite_at(index, 1.0, &paint);
                ink_scratch = paint.ink;
            }
        }

        Ok(())
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
                let Renderer { raster, buffer, .. } = self;
                if let Some(cov) = raster.fill_path(
                    &device_path,
                    FillRule::NonZero,
                    self.opts.anti_alias,
                    clip.as_deref(),
                ) {
                    buffer.composite(cov, &paint);
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
                        let Renderer { raster, buffer, .. } = self;
                        if let Some(cov) = raster.fill_path(
                            &outlined,
                            FillRule::NonZero,
                            self.opts.anti_alias,
                            clip.as_deref(),
                        ) {
                            buffer.composite(cov, &paint);
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
            Mask::new(self.raster.width(), self.raster.height())
                .expect("kích thước raster đã kiểm")
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

fn to_ts(m: &Matrix) -> Transform {
    Transform::from_row(m.a, m.b, m.c, m.d, m.e, m.f)
}

fn num_operand(operands: &[Object], i: usize) -> Option<f32> {
    operands.get(i).and_then(pdf::as_num)
}

fn name_operand(operands: &[Object], i: usize) -> Option<String> {
    operands.get(i).and_then(pdf::name_str)
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
