//! Mở tài liệu, dựng hình học trang, render ra [`InkBuffer`].

use std::sync::{Arc, OnceLock};

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::color::icc::ColorManager;
use crate::color::space::resolve_colorspace;
use crate::color::ColorSpace;
use crate::content::{BlendSpace, RenderOptions, Renderer};
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect};
use crate::ink::{InkBuffer, InkSpace};
use crate::page_program::PageProgram;
use crate::pdf;
use crate::session::SharedResourceCache;
use crate::text::outlines::TextOutlineReport;

/// Trần cạnh raster (pixel) cho một trang.
///
/// Chặn cả DPI vô lý lẫn PDF khai MediaBox khổng lồ. 30000 px ≈ 2.5 m ở 300 DPI,
/// vượt mọi khổ in thật, trong khi vẫn giữ trần bộ nhớ ở mức chấp nhận được:
/// 30000² × 4 kênh × 4 byte là quá lớn nên trần diện tích bên dưới mới là thứ
/// thực sự bảo vệ.
const MAX_RASTER_SIDE: u32 = 30_000;

/// Trần tổng số pixel: 80 MP (≈ A0 @ 300 DPI). Mỗi pixel tốn 4 byte × số kênh.
const MAX_RASTER_PIXELS: u64 = 80_000_000;

/// Viền dựng thừa quanh viewport trước khi crop kết quả.
///
/// tiny-skia cần pixel lân cận để scan-convert/anti-alias ổn định. 16 pixel bao
/// rộng hơn AA và vành fill-adjust 0,16 px, trong khi chi phí chỉ tăng theo chu vi.
const RASTER_CLIP_GUARD_PX: u32 = 16;

/// Kết quả render một trang.
pub struct PageRender {
    pub buffer: InkBuffer,
    pub warnings: RenderWarnings,
    /// Hộp đã dùng làm khung raster (thường là CropBox).
    pub box_used: Rect,
    /// `/Rotate` đã áp (0/90/180/270).
    pub rotate: i32,
    /// Đường viền chữ đã thu thập — rỗng trừ khi
    /// [`RenderOptions::collect_text_outlines`] được bật.
    pub text_outlines: TextOutlineReport,
}

/// Mô tả bất biến của một trang sau khi đã đi qua cây `/Pages`.
///
/// Session giữ mô tả này để các request zoom/viewport không phải lặp lại việc
/// tìm page box và resources; content stream được giải nén + decode lười đúng một lần.
/// `Document` vẫn là nguồn sự thật cho các object được tham chiếu bên trong stream.
#[derive(Debug, Clone)]
pub(crate) struct PageDescriptor {
    pub number: usize,
    pub page_id: ObjectId,
    pub media: Rect,
    pub crop: Option<Rect>,
    pub trim: Option<Rect>,
    pub bleed: Option<Rect>,
    pub art: Option<Rect>,
    pub rotate: i32,
    pub resources: Option<Dictionary>,
    pub blend_space: BlendSpace,
    pub program: Arc<OnceLock<PageProgram>>,
}

impl PageDescriptor {
    fn box_value(&self, which: PageBox) -> Option<Rect> {
        match which {
            PageBox::Media => Some(self.media),
            PageBox::Crop => self.crop,
            PageBox::Trim => self.trim,
            PageBox::Bleed => self.bleed,
            PageBox::Art => self.art,
        }
    }

    fn effective_crop(&self) -> Rect {
        self.crop
            .and_then(|value| value.intersect(&self.media))
            .unwrap_or(self.media)
    }

    fn target(&self, which: PageBox) -> Rect {
        // CORRECTNESS (audit 2026-09-01 §PPE-E1): ISO 32000 cho Trim/Bleed/Art
        // kế thừa CropBox hiệu lực khi thiếu hoặc không giao MediaBox. Một hộp con
        // hợp lệ chỉ bị chặn bởi MediaBox, không bị ép tiếp vào CropBox.
        match which {
            PageBox::Media => self.media,
            PageBox::Crop => self.effective_crop(),
            PageBox::Trim | PageBox::Bleed | PageBox::Art => self
                .box_value(which)
                .and_then(|value| value.intersect(&self.media))
                .unwrap_or_else(|| self.effective_crop()),
        }
    }

    fn program<'a>(&'a self, doc: &Document) -> PpeResult<&'a PageProgram> {
        if let Some(program) = self.program.get() {
            return Ok(program);
        }
        // PERF (audit 2026-08-09 §L4A): chỉ giữ chương trình đã decode, không giữ
        // thêm bản content giải nén. Compile lỗi không được cache thành trang trắng.
        let content = doc.get_page_content(self.page_id);
        let candidate = PageProgram::compile(&content)?;
        let _ = self.program.set(candidate);
        self.program.get().ok_or_else(|| {
            PpeError::ContentStream("không công bố được PageProgram đã decode".to_string())
        })
    }
}

/// Vùng raster theo pixel của ảnh trang sau khi áp `/Rotate`, gốc trên-trái.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterClip {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Hộp trang nào dùng làm khung raster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageBox {
    Media,
    Crop,
    Trim,
    Bleed,
    Art,
}

impl PageBox {
    fn key(&self) -> &'static str {
        match self {
            PageBox::Media => "MediaBox",
            PageBox::Crop => "CropBox",
            PageBox::Trim => "TrimBox",
            PageBox::Bleed => "BleedBox",
            PageBox::Art => "ArtBox",
        }
    }
}

/// Phân giải toàn bộ mô tả trang một lần khi mở session.
pub(crate) fn build_page_descriptors(doc: &Document) -> PpeResult<Vec<Arc<PageDescriptor>>> {
    let pages = doc.get_pages();
    let mut descriptors = Vec::with_capacity(pages.len());
    for (number, page_id) in pages {
        let page_dict = doc.get_dictionary(page_id).map_err(|e| {
            PpeError::MalformedPdf(format!("không đọc được dict trang {number}: {e}"))
        })?;
        let media = inherited_rect(doc, page_dict, PageBox::Media)
            .unwrap_or_else(|| Rect::new(0.0, 0.0, 612.0, 792.0));
        let resources = collect_resources(doc, page_dict);
        let blend_space = page_blend_space(doc, page_dict, resources.as_ref());
        descriptors.push(Arc::new(PageDescriptor {
            number: number as usize,
            page_id,
            media,
            crop: inherited_rect(doc, page_dict, PageBox::Crop),
            trim: inherited_rect(doc, page_dict, PageBox::Trim),
            bleed: inherited_rect(doc, page_dict, PageBox::Bleed),
            art: inherited_rect(doc, page_dict, PageBox::Art),
            rotate: normalize_rotate(inherited_num(doc, page_dict, "Rotate").unwrap_or(0.0) as i32),
            resources,
            blend_space,
            program: Arc::new(OnceLock::new()),
        }));
    }
    Ok(descriptors)
}

/// Phân giải duy nhất một trang cho API stateless, tránh quét toàn bộ tài liệu.
pub(crate) fn build_page_descriptor(
    doc: &Document,
    page_number: usize,
) -> PpeResult<Arc<PageDescriptor>> {
    let pages = doc.get_pages();
    let page_id = *pages
        .get(&(page_number as u32))
        .ok_or(PpeError::PageOutOfRange {
            requested: page_number,
            total: pages.len(),
        })?;
    let page_dict = doc
        .get_dictionary(page_id)
        .map_err(|error| PpeError::MalformedPdf(format!("trang {page_number}: {error}")))?;
    let media = inherited_rect(doc, page_dict, PageBox::Media)
        .unwrap_or_else(|| Rect::new(0.0, 0.0, 612.0, 792.0));
    let resources = collect_resources(doc, page_dict);
    let blend_space = page_blend_space(doc, page_dict, resources.as_ref());
    Ok(Arc::new(PageDescriptor {
        number: page_number,
        page_id,
        media,
        crop: inherited_rect(doc, page_dict, PageBox::Crop),
        trim: inherited_rect(doc, page_dict, PageBox::Trim),
        bleed: inherited_rect(doc, page_dict, PageBox::Bleed),
        art: inherited_rect(doc, page_dict, PageBox::Art),
        rotate: normalize_rotate(inherited_num(doc, page_dict, "Rotate").unwrap_or(0.0) as i32),
        resources,
        blend_space,
        program: Arc::new(OnceLock::new()),
    }))
}

/// Render một trang (1-based) ra buffer mực.
pub fn render_page(
    doc: &Document,
    page_number: usize,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
) -> PpeResult<PageRender> {
    render_page_managed(doc, page_number, dpi, which_box, opts, None)
}

/// Như [`render_page`] nhưng có quản lý màu ICC.
///
/// Tách thành hai hàm thay vì thêm `Option` vào mọi lời gọi: đường không-ICC vẫn
/// hợp lệ (nội dung DeviceCMYK thuần không cần profile nào), còn đường có ICC là
/// lựa chọn có ý thức của caller.
pub fn render_page_managed(
    doc: &Document,
    page_number: usize,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
    color: Option<&ColorManager>,
) -> PpeResult<PageRender> {
    render_page_managed_region(doc, page_number, dpi, which_box, opts, color, None)
}

/// Dựng trang có quản lý màu, chỉ cấp buffer cho vùng raster cần nhìn khi `clip` có giá trị.
///
/// PERF (audit 2026-08-08 §RENDER.3): clip dùng hệ pixel của ảnh full-page sau `/Rotate`.
/// Dịch ma trận bằng số pixel nguyên giữ cùng pha raster. Renderer dựng thêm guard-band rồi
/// crop nội bộ: fill/shading khớp tuyệt đối; sai số stroke AA do CTM f32 được khóa bằng oracle
/// overlap. RAM raster đích tỷ lệ với viewport; ảnh nguồn giao viewport vẫn cần decode đầy đủ.
#[allow(clippy::too_many_arguments)]
pub fn render_page_managed_region(
    doc: &Document,
    page_number: usize,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
    color: Option<&ColorManager>,
    clip: Option<RasterClip>,
) -> PpeResult<PageRender> {
    let descriptor = build_page_descriptor(doc, page_number)?;
    render_page_descriptor(doc, &descriptor, dpi, which_box, opts, color, clip, None)
}

/// Render một trang từ descriptor đã được session chuẩn bị sẵn.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_page_descriptor(
    doc: &Document,
    descriptor: &PageDescriptor,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
    color: Option<&ColorManager>,
    clip: Option<RasterClip>,
    resource_cache: Option<SharedResourceCache>,
) -> PpeResult<PageRender> {
    let target = descriptor.target(which_box);
    let rotate = descriptor.rotate;
    let resources = descriptor.resources.as_ref();
    let blend_space = descriptor.blend_space;
    opts.check_cancelled()?;
    let program = descriptor.program(doc)?;
    // PERF (audit 2026-08-08 §RENDER.3): extent full-page chỉ dùng để kiểm clip;
    // không áp trần cấp phát 80 MP lên nó vì viewport thực tế có thể rất nhỏ.
    let (page_width_px, page_height_px) = raster_extent(&target, dpi, rotate)?;
    let page_device = device_matrix(&target, dpi, rotate);
    let (width_px, height_px, device, output_crop) = if let Some(region) = clip {
        let right = region.x.checked_add(region.width);
        let bottom = region.y.checked_add(region.height);
        if region.width == 0
            || region.height == 0
            || right.is_none_or(|value| value > page_width_px)
            || bottom.is_none_or(|value| value > page_height_px)
        {
            return Err(PpeError::BadRasterClip {
                x: region.x,
                y: region.y,
                w: region.width,
                h: region.height,
                page_w: page_width_px,
                page_h: page_height_px,
            });
        }

        let requested_right = right.expect("đã kiểm overflow");
        let requested_bottom = bottom.expect("đã kiểm overflow");
        let render_x = region.x.saturating_sub(RASTER_CLIP_GUARD_PX);
        let render_y = region.y.saturating_sub(RASTER_CLIP_GUARD_PX);
        let render_right = requested_right
            .saturating_add(RASTER_CLIP_GUARD_PX)
            .min(page_width_px);
        let render_bottom = requested_bottom
            .saturating_add(RASTER_CLIP_GUARD_PX)
            .min(page_height_px);
        validate_raster_allocation(render_right - render_x, render_bottom - render_y, dpi)?;
        (
            render_right - render_x,
            render_bottom - render_y,
            page_device.then(&Matrix::translate(-(render_x as f32), -(render_y as f32))),
            Some(RasterClip {
                x: region.x - render_x,
                y: region.y - render_y,
                width: region.width,
                height: region.height,
            }),
        )
    } else {
        validate_raster_allocation(page_width_px, page_height_px, dpi)?;
        (page_width_px, page_height_px, page_device, None)
    };

    let space = if opts.flatten_spots {
        // GS-SUNSET (audit 2026-07-27 §A.1): mực pha giữ kênh riêng khi TRỘN rồi mới
        // gộp về CMYK lúc xuất ảnh. Quy sớm như trước làm overprint của Pantone
        // biến mất khỏi Overprint Preview.
        InkSpace::preview()
    } else {
        InkSpace::new()
    };
    let buffer =
        InkBuffer::new_with_memory_budget(width_px, height_px, space, opts.memory_budget_bytes)?;
    let render_annotations = opts.renders_annotations();
    let opts = opts.with_device_scale(dpi);
    let mut renderer =
        Renderer::new_with_resource_cache(doc, buffer, opts, color, blend_space, resource_cache)?;

    if program.operation_count() == 0 {
        // Trang trắng hợp lệ; không phải lỗi. Không ghi cảnh báo để khỏi hạ
        // accuracy oan cho trang thật sự trắng.
    }
    renderer.run_program(program, resources, device)?;
    if render_annotations {
        render_annotation_appearances(doc, descriptor.page_id, &mut renderer, device)?;
    }

    let (mut buffer, warnings, text_outlines) = renderer.into_parts_with_outlines();
    if let Some(region) = output_crop {
        buffer.crop_raster_in_place(region.x, region.y, region.width, region.height)?;
    }
    Ok(PageRender {
        buffer,
        warnings,
        box_used: target,
        rotate,
        text_outlines,
    })
}

/// CORRECTNESS (audit 2026-08-10 §L6.4): Viewer chỉ dựng appearance stream tĩnh
/// đã nằm trong PDF. Không tổng hợp giao diện từ JavaScript/XFA hay giá trị field;
/// thiếu appearance phải hạ soundness để hybrid dùng compatibility lane.
fn render_annotation_appearances(
    doc: &Document,
    page_id: ObjectId,
    renderer: &mut Renderer<'_>,
    page_device: Matrix,
) -> PpeResult<()> {
    if document_has_xfa(doc) {
        renderer.note_unsupported_annotation("Annotation XFA (không dựng appearance động)");
    }
    let page = doc.get_dictionary(page_id).map_err(|error| {
        PpeError::MalformedPdf(format!("không đọc được trang để dựng annotation: {error}"))
    })?;
    let Some(Object::Array(annotations)) = pdf::dict_get(doc, page, "Annots") else {
        return Ok(());
    };

    for raw in annotations {
        let Object::Dictionary(annotation) = pdf::deref(doc, raw) else {
            renderer.note_unsupported_annotation("Annotation dictionary không hợp lệ");
            continue;
        };
        let flags = pdf::dict_get(doc, annotation, "F")
            .and_then(pdf::as_num)
            .unwrap_or(0.0) as u32;
        // Invisible, Hidden và NoView không tạo pixel trên màn hình.
        if flags & (1 | 2 | 32) != 0 {
            continue;
        }

        let subtype = pdf::dict_get(doc, annotation, "Subtype")
            .and_then(pdf::name_str)
            .unwrap_or_default();
        // `/Popup` là cửa sổ UI do viewer mở, không phải nội dung raster của trang.
        if subtype == "Popup" {
            continue;
        }
        let Some(rect_values) =
            pdf::dict_get(doc, annotation, "Rect").and_then(|value| pdf::num_array(doc, value))
        else {
            renderer.note_unsupported_annotation("Annotation thiếu /Rect");
            continue;
        };
        if rect_values.len() < 4 {
            renderer.note_unsupported_annotation("Annotation /Rect không đủ bốn số");
            continue;
        }
        let rect = Rect::new(
            rect_values[0],
            rect_values[1],
            rect_values[2],
            rect_values[3],
        );
        if rect.is_empty() {
            continue;
        }
        // CORRECTNESS (audit 2026-08-31 §PPE-B01): tile không chứa annotation
        // phải sạch, kể cả khi appearance hoặc semantics của annotation chưa hỗ trợ.
        if !renderer.rect_may_intersect_buffer(rect, &page_device) {
            continue;
        }

        // NoZoom/NoRotate cần ma trận theo viewport thay vì trang; chưa được phép
        // áp phép co trang thông thường rồi tuyên bố color-verified.
        if flags & (8 | 16) != 0 {
            renderer.note_unsupported_annotation("Annotation /F NoZoom hoặc NoRotate chưa hỗ trợ");
            continue;
        }
        if annotation.get(b"OC").is_ok() {
            renderer.note_unsupported_annotation("Annotation /OC chưa áp trạng thái lớp");
            continue;
        }

        let Some(ap) = pdf::dict_get_dict(doc, annotation, "AP") else {
            if subtype == "Widget" {
                renderer.note_unsupported_annotation("Widget thiếu appearance /AP");
            } else if subtype.is_empty() {
                renderer.note_unsupported_annotation("Annotation thiếu appearance /AP");
            } else {
                renderer.note_unsupported_annotation(&format!(
                    "Annotation /{subtype} thiếu appearance /AP"
                ));
            }
            continue;
        };
        let Some(normal) = select_normal_appearance(doc, annotation, ap) else {
            renderer.note_unsupported_annotation("Annotation /AP thiếu appearance /N hợp lệ");
            continue;
        };
        let Object::Stream(stream) = normal else {
            renderer.note_unsupported_annotation("Annotation /AP /N không phải stream");
            continue;
        };
        let Some(bbox_values) =
            pdf::dict_get(doc, &stream.dict, "BBox").and_then(|value| pdf::num_array(doc, value))
        else {
            renderer.note_unsupported_annotation("Annotation appearance thiếu /BBox");
            continue;
        };
        if bbox_values.len() < 4 {
            renderer.note_unsupported_annotation("Annotation appearance /BBox không hợp lệ");
            continue;
        }
        let bbox = Rect::new(
            bbox_values[0],
            bbox_values[1],
            bbox_values[2],
            bbox_values[3],
        );
        if bbox.is_empty() {
            continue;
        }
        let appearance_matrix = pdf::dict_get(doc, &stream.dict, "Matrix")
            .and_then(|value| pdf::num_array(doc, value))
            .filter(|values| values.len() >= 6)
            .map(|values| {
                Matrix::new(
                    values[0], values[1], values[2], values[3], values[4], values[5],
                )
            })
            .unwrap_or(Matrix::IDENTITY);
        let transformed = transformed_rect_bounds(bbox, appearance_matrix);
        if transformed.is_empty()
            || !transformed.width().is_finite()
            || !transformed.height().is_finite()
        {
            renderer.note_unsupported_annotation("Annotation appearance có ma trận suy biến");
            continue;
        }
        let fit = Matrix::translate(-transformed.x0, -transformed.y0)
            .then(&Matrix::scale(
                rect.width() / transformed.width(),
                rect.height() / transformed.height(),
            ))
            .then(&Matrix::translate(rect.x0, rect.y0));
        let base_ctm = appearance_matrix.then(&fit).then(&page_device);
        let decoded = pdf::decode_stream(doc, stream);
        if decoded.quality == pdf::DecodeQuality::Recovered {
            // CORRECTNESS (audit 2026-09-01 §PPE-E2): Rect đã qua cổng giao
            // viewport phía trên; appearance ngoài tile không tạo warning oan.
            renderer.note_unsupported_annotation(
                "Annotation appearance chỉ phục hồi được content stream",
            );
        }
        let data = decoded.bytes;
        let mut clipped = format!(
            "q {} {} {} {} re W n\n",
            bbox.x0,
            bbox.y0,
            bbox.width(),
            bbox.height()
        )
        .into_bytes();
        clipped.extend_from_slice(&data);
        clipped.extend_from_slice(b"\nQ");
        let resources = pdf::dict_get_dict(doc, &stream.dict, "Resources");
        renderer.run(&clipped, resources, base_ctm)?;
    }
    Ok(())
}

fn select_normal_appearance<'a>(
    doc: &'a Document,
    annotation: &'a Dictionary,
    ap: &'a Dictionary,
) -> Option<&'a Object> {
    let normal = pdf::dict_get(doc, ap, "N")?;
    if matches!(normal, Object::Stream(_)) {
        return Some(normal);
    }
    let Object::Dictionary(states) = normal else {
        return None;
    };
    if let Some(state) = pdf::dict_get(doc, annotation, "AS").and_then(pdf::name_str) {
        if let Ok(value) = states.get(state.as_bytes()) {
            let resolved = pdf::deref(doc, value);
            if matches!(resolved, Object::Stream(_)) {
                return Some(resolved);
            }
        }
    }
    states
        .iter()
        .map(|(_, value)| pdf::deref(doc, value))
        .find(|value| matches!(value, Object::Stream(_)))
}

fn transformed_rect_bounds(rect: Rect, matrix: Matrix) -> Rect {
    let corners = [
        matrix.apply(rect.x0, rect.y0),
        matrix.apply(rect.x1, rect.y0),
        matrix.apply(rect.x0, rect.y1),
        matrix.apply(rect.x1, rect.y1),
    ];
    let min_x = corners
        .iter()
        .map(|point| point.0)
        .fold(f32::INFINITY, f32::min);
    let min_y = corners
        .iter()
        .map(|point| point.1)
        .fold(f32::INFINITY, f32::min);
    let max_x = corners
        .iter()
        .map(|point| point.0)
        .fold(f32::NEG_INFINITY, f32::max);
    let max_y = corners
        .iter()
        .map(|point| point.1)
        .fold(f32::NEG_INFINITY, f32::max);
    Rect::new(min_x, min_y, max_x, max_y)
}

fn document_has_xfa(doc: &Document) -> bool {
    let Ok(root) = doc.trailer.get(b"Root") else {
        return false;
    };
    let Object::Dictionary(catalog) = pdf::deref(doc, root) else {
        return false;
    };
    pdf::dict_get_dict(doc, catalog, "AcroForm").is_some_and(|form| form.get(b"XFA").is_ok())
}

/// Mở PDF từ file.
pub fn open(path: &str) -> PpeResult<Document> {
    Document::load(path).map_err(|e| PpeError::OpenFailed(format!("{e}")))
}

/// Mở PDF từ bộ nhớ.
pub fn open_mem(bytes: &[u8]) -> PpeResult<Document> {
    Document::load_mem(bytes).map_err(|e| PpeError::OpenFailed(format!("{e}")))
}

/// Chuẩn hoá `/Rotate` về {0, 90, 180, 270}.
///
/// Spec đòi số chia hết cho 90, nhưng file thật có cả số âm và > 360.
pub fn normalize_rotate(raw: i32) -> i32 {
    let r = ((raw % 360) + 360) % 360;
    // Làm tròn về bậc 90 gần nhất để giá trị lệch (vd 89) không làm lật khung.
    match r {
        0..=44 | 315..=359 => 0,
        45..=134 => 90,
        135..=224 => 180,
        _ => 270,
    }
}

/// Kích thước raster, đã tính hoán đổi cạnh khi xoay 90/270.
pub fn raster_size(page_box: &Rect, dpi: f32, rotate: i32) -> PpeResult<(u32, u32)> {
    let (w, h) = raster_extent(page_box, dpi, rotate)?;
    validate_raster_allocation(w, h, dpi)?;
    Ok((w, h))
}

/// Tính extent trang để ánh xạ clip, chưa đồng nghĩa sẽ cấp phát toàn bộ raster.
fn raster_extent(page_box: &Rect, dpi: f32, rotate: i32) -> PpeResult<(u32, u32)> {
    if !(dpi.is_finite()) || dpi <= 0.0 {
        return Err(PpeError::BadRasterSize { w: 0, h: 0, dpi });
    }
    let s64 = raster_scale(dpi);
    let (w_pt, h_pt) = if rotate == 90 || rotate == 270 {
        (page_box.height(), page_box.width())
    } else {
        (page_box.width(), page_box.height())
    };
    let w = (f64::from(w_pt) * s64).round().max(1.0);
    let h = (f64::from(h_pt) * s64).round().max(1.0);
    if !w.is_finite() || !h.is_finite() || w > f64::from(u32::MAX) || h > f64::from(u32::MAX) {
        return Err(PpeError::BadRasterSize {
            w: w as i64,
            h: h as i64,
            dpi,
        });
    }
    Ok((w as u32, h as u32))
}

#[inline]
fn raster_scale(dpi: f32) -> f64 {
    f64::from(dpi) / 72.0
}

/// Áp trần lên phần thực sự cấp phát (full-page hoặc clip đã cộng guard-band).
fn validate_raster_allocation(w: u32, h: u32, dpi: f32) -> PpeResult<()> {
    if w > MAX_RASTER_SIDE || h > MAX_RASTER_SIDE {
        return Err(PpeError::BadRasterSize {
            w: i64::from(w),
            h: i64::from(h),
            dpi,
        });
    }
    if (w as u64) * (h as u64) > MAX_RASTER_PIXELS {
        return Err(PpeError::BadRasterSize {
            w: i64::from(w),
            h: i64::from(h),
            dpi,
        });
    }
    Ok(())
}

/// Ma trận trang → thiết bị, đã gộp lật trục y và `/Rotate`.
///
/// Xoay theo chiều **kim đồng hồ** khi hiển thị (§7.7.3.3): `/Rotate 90` đưa góc
/// trên-trái của trang chưa xoay về góc trên-**phải** của ảnh.
///
/// # Neo lưới raster
///
/// Khi chiều cao trang không tròn pixel, phần dư làm tròn phải dồn lên **đỉnh**:
/// đáy trang luôn chạm mép dưới raster đã round, còn mép trái neo theo toạ độ
/// chính xác. Đây là hành vi đo black-box của RIP tham chiếu (GS 10.04, trang
/// 155.9 pt @72/100/150 DPI — sọc 1-texel khớp 0-pixel-lệch chỉ với mô hình
/// này). Neo đáy theo `y1*s` chính xác nghe hợp lý hơn nhưng làm TOÀN BỘ trang
/// lệch pha dọc một hằng số sub-pixel so với tham chiếu; với ảnh thu nhỏ
/// ratio ≥ 3 texel/pixel, lệch 0.1 px đổi texel được chọn ở ~1/3 số pixel —
/// đủ đổi đỉnh TAC của trang (tra gung @72: −8.2 điểm chỉ vì neo).
pub fn device_matrix(page_box: &Rect, dpi: f32, rotate: i32) -> Matrix {
    // PERF (audit 2026-08-08 §RENDER.3): extent và neo thiết bị phải dùng cùng
    // phép tính f64. Làm tròn scale bằng f32 sớm từng khiến raster 779 px nhưng
    // ma trận vẫn neo đáy ở 780 px trên các kích thước nửa-pixel.
    let s64 = raster_scale(dpi);
    let Rect { x0, y0, x1, y1 } = *page_box;
    let (x0, y0, x1, y1) = (f64::from(x0), f64::from(y0), f64::from(x1), f64::from(y1));
    // Cùng công thức làm tròn với `raster_size` — lệch nhau một ulp là lệch neo.
    let extent_y = if rotate == 90 || rotate == 270 {
        (x1 - x0) * s64
    } else {
        (y1 - y0) * s64
    };
    let snap = extent_y.round().max(1.0) - extent_y;
    let s = s64 as f32;
    match rotate {
        90 => Matrix::new(
            0.0,
            s,
            s,
            0.0,
            (-y0 * s64) as f32,
            (-x0 * s64 + snap) as f32,
        ),
        180 => Matrix::new(
            -s,
            0.0,
            0.0,
            s,
            (x1 * s64) as f32,
            (-y0 * s64 + snap) as f32,
        ),
        270 => Matrix::new(
            0.0,
            -s,
            -s,
            0.0,
            (y1 * s64) as f32,
            (x1 * s64 + snap) as f32,
        ),
        _ => Matrix::new(
            s,
            0.0,
            0.0,
            -s,
            (-x0 * s64) as f32,
            (y1 * s64 + snap) as f32,
        ),
    }
}

/// Đọc một hộp trang, có kế thừa từ `/Pages` cha.
fn inherited_rect(doc: &Document, page: &Dictionary, which: PageBox) -> Option<Rect> {
    let v = inherited(doc, page, which.key()).and_then(|o| pdf::num_array(doc, o))?;
    if v.len() < 4 {
        return None;
    }
    let r = Rect::new(v[0], v[1], v[2], v[3]);
    if r.is_empty() || !r.x0.is_finite() || !r.y1.is_finite() {
        None
    } else {
        Some(r)
    }
}

fn inherited_num(doc: &Document, page: &Dictionary, key: &str) -> Option<f32> {
    inherited(doc, page, key).and_then(pdf::as_num)
}
fn page_blend_space(
    doc: &Document,
    page: &Dictionary,
    resources: Option<&Dictionary>,
) -> BlendSpace {
    let Some(group) = pdf::dict_get_dict(doc, page, "Group") else {
        // ISO 32000: không khai thì dùng color space của target device.
        return BlendSpace::DeviceCmyk;
    };
    let Some(cs) = pdf::dict_get(doc, group, "CS") else {
        return BlendSpace::DeviceCmyk;
    };
    let mut warnings = RenderWarnings::default();
    match resolve_colorspace(doc, cs, resources, &mut warnings) {
        Ok(ColorSpace::DeviceCMYK) => BlendSpace::DeviceCmyk,
        Ok(ColorSpace::DeviceRGB) => BlendSpace::DeviceRgb,
        Ok(ColorSpace::IccBased { alternate, .. }) if alternate.n_components() == 4 => {
            BlendSpace::DeviceCmyk
        }
        _ => BlendSpace::Other,
    }
}

/// Trần độ cao cây trang khi truy ngược `/Parent`, chống vòng lặp cha-con.
const MAX_PAGE_TREE_DEPTH: u32 = 64;

/// Tìm một khoá trên trang, truy ngược `/Parent` nếu thiếu.
///
/// Kế thừa là điểm dễ bỏ sót: rất nhiều PDF chỉ khai `MediaBox`/`Resources` ở
/// node `/Pages`. Không truy ngược thì trang sẽ ra khổ mặc định sai và **mọi**
/// resources (kể cả colorspace spot) sẽ không tìm thấy.
fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &str) -> Option<&'a Object> {
    if let Some(v) = pdf::dict_get(doc, page, key) {
        return Some(v);
    }
    let mut current = page;
    for _ in 0..MAX_PAGE_TREE_DEPTH {
        let parent = pdf::dict_get(doc, current, "Parent")?;
        let parent_dict = match parent {
            Object::Dictionary(d) => d,
            _ => return None,
        };
        if let Some(v) = pdf::dict_get(doc, parent_dict, key) {
            return Some(v);
        }
        current = parent_dict;
    }
    None
}

fn collect_resources(doc: &Document, page: &Dictionary) -> Option<Dictionary> {
    match inherited(doc, page, "Resources")? {
        Object::Dictionary(d) => Some(d.clone()),
        Object::Stream(s) => Some(s.dict.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn a4() -> Rect {
        Rect::new(0.0, 0.0, 595.0, 842.0)
    }

    #[test]
    fn rotate_is_normalized_to_quadrants() {
        assert_eq!(normalize_rotate(0), 0);
        assert_eq!(normalize_rotate(90), 90);
        assert_eq!(normalize_rotate(-90), 270);
        assert_eq!(normalize_rotate(450), 90);
        assert_eq!(normalize_rotate(360), 0);
        assert_eq!(normalize_rotate(-360), 0);
    }

    #[test]
    fn odd_rotate_values_snap_to_nearest_quadrant() {
        assert_eq!(normalize_rotate(89), 90);
        assert_eq!(normalize_rotate(1), 0);
        assert_eq!(normalize_rotate(181), 180);
    }

    #[test]
    fn raster_size_matches_dpi() {
        let (w, h) = raster_size(&Rect::new(0.0, 0.0, 72.0, 144.0), 300.0, 0).unwrap();
        assert_eq!((w, h), (300, 600));
    }

    #[test]
    fn raster_size_swaps_sides_when_rotated_90() {
        let (w0, h0) = raster_size(&a4(), 72.0, 0).unwrap();
        let (w90, h90) = raster_size(&a4(), 72.0, 90).unwrap();
        assert_eq!((w90, h90), (h0, w0));
    }

    #[test]
    fn raster_size_rejects_zero_and_negative_dpi() {
        assert!(raster_size(&a4(), 0.0, 0).is_err());
        assert!(raster_size(&a4(), -300.0, 0).is_err());
    }

    #[test]
    fn raster_size_rejects_absurd_dpi() {
        // Chặn OOM trước khi cấp phát, thay vì để tiến trình bị kill.
        assert!(raster_size(&a4(), 100_000.0, 0).is_err());
    }

    #[test]
    fn raster_size_never_returns_zero() {
        let (w, h) = raster_size(&Rect::new(0.0, 0.0, 0.5, 0.5), 10.0, 0).unwrap();
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn device_matrix_rotate_0_maps_top_left_to_origin() {
        let m = device_matrix(&a4(), 72.0, 0);
        let p = m.apply(0.0, 842.0);
        assert!(p.0.abs() < 1e-3 && p.1.abs() < 1e-3, "{p:?}");
    }

    #[test]
    fn device_matrix_anchors_page_bottom_at_rounded_raster_height() {
        // Đo black-box GS 10.04 trên trang cao không nguyên pixel (155.9 pt
        // @72): GS dồn phần dư làm tròn lên ĐỈNH raster — đáy trang luôn chạm
        // mép dưới raster đã round; mép trái vẫn neo chính xác. Sọc 1-texel
        // chỉ khớp GS 0-pixel-lệch với mô hình neo này (kể cả 278/417 px ở
        // 100/150 DPI). Neo đáy theo toạ độ chính xác làm cả trang lệch pha
        // sub-pixel so với GS: ảnh thu nhỏ ratio ≥ 3 đổi texel ở ~1/3 pixel
        // (tra gung @72: d_tac −8.2 chỉ vì lệch này).
        let page = Rect::new(0.0, 0.0, 311.8, 155.9);
        let m = device_matrix(&page, 72.0, 0);
        assert!(
            (m.apply(0.0, 0.0).1 - 156.0).abs() < 1e-3,
            "đáy trang phải chạm raster 156, được {}",
            m.apply(0.0, 0.0).1
        );
        assert!(m.apply(0.0, 155.9).0.abs() < 1e-3, "mép trái neo chính xác");
        // Ba góc xoay còn lại: trục y thiết bị lần lượt đến từ x1/y1/x0.
        let m = device_matrix(&page, 72.0, 90);
        assert!((m.apply(311.8, 0.0).1 - 312.0).abs() < 1e-3);
        let m = device_matrix(&page, 72.0, 180);
        assert!((m.apply(0.0, 155.9).1 - 156.0).abs() < 1e-3);
        let m = device_matrix(&page, 72.0, 270);
        assert!((m.apply(0.0, 0.0).1 - 312.0).abs() < 1e-3);
    }

    fn assert_device_anchor_matches_raster(page: &Rect, dpi: f32) {
        for rotate in [0, 90, 180, 270] {
            let (_, height) = raster_extent(page, dpi, rotate).unwrap();
            let matrix = device_matrix(page, dpi, rotate);
            let anchor_y = match rotate {
                90 => matrix.apply(page.x1, page.y0).1,
                180 => matrix.apply(page.x0, page.y1).1,
                270 => matrix.apply(page.x0, page.y0).1,
                _ => matrix.apply(page.x0, page.y0).1,
            };
            assert!(
                (anchor_y - height as f32).abs() < 1e-3,
                "rotate={rotate}, dpi={dpi}: neo y={anchor_y}, raster h={height}"
            );
        }
    }

    #[test]
    fn device_matrix_uses_same_rounding_as_raster_extent_at_half_pixel_edges() {
        // PERF (audit 2026-08-08 §RENDER.3): hai biên này từng làm f32 và f64
        // làm tròn ngược chiều, khiến tile thừa/mất một hàng ở mép trang.
        let page_779 = Rect::new(0.0, 0.0, 311.8, 155.9);
        assert_eq!(raster_extent(&page_779, 360.0, 0).unwrap().1, 779);
        assert_device_anchor_matches_raster(&page_779, 360.0);

        let page_413 = Rect::new(0.0, 0.0, 155.9, 297.0);
        assert_eq!(raster_extent(&page_413, 100.0, 0).unwrap().1, 413);
        assert_device_anchor_matches_raster(&page_413, 100.0);
    }

    #[test]
    fn device_matrix_rotate_90_moves_top_left_to_top_right() {
        // /Rotate 90 xoay theo chiều kim đồng hồ.
        let (w, _h) = raster_size(&a4(), 72.0, 90).unwrap();
        let m = device_matrix(&a4(), 72.0, 90);
        let p = m.apply(0.0, 842.0); // góc trên-trái khi chưa xoay
        assert!((p.0 - w as f32).abs() < 1e-2, "x={} w={}", p.0, w);
        assert!(p.1.abs() < 1e-2, "y={}", p.1);
    }

    #[test]
    fn device_matrix_rotate_180_moves_top_left_to_bottom_right() {
        let (w, h) = raster_size(&a4(), 72.0, 180).unwrap();
        let m = device_matrix(&a4(), 72.0, 180);
        let p = m.apply(0.0, 842.0);
        assert!((p.0 - w as f32).abs() < 1e-2, "{p:?}");
        assert!((p.1 - h as f32).abs() < 1e-2, "{p:?}");
    }

    #[test]
    fn device_matrix_rotate_270_moves_top_left_to_bottom_left() {
        let (_w, h) = raster_size(&a4(), 72.0, 270).unwrap();
        let m = device_matrix(&a4(), 72.0, 270);
        let p = m.apply(0.0, 842.0);
        assert!(p.0.abs() < 1e-2, "{p:?}");
        assert!((p.1 - h as f32).abs() < 1e-2, "{p:?}");
    }

    #[test]
    fn device_matrix_honours_offset_crop_box() {
        // CropBox lệch gốc là chuyện thường ở file bình trang.
        let crop = Rect::new(20.0, 30.0, 320.0, 430.0);
        let m = device_matrix(&crop, 72.0, 0);
        let p = m.apply(20.0, 430.0);
        assert!(p.0.abs() < 1e-3 && p.1.abs() < 1e-3, "{p:?}");
    }

    #[test]
    fn rotation_preserves_area_mapping() {
        // Bốn góc trang phải map vào bốn góc ảnh với mọi góc xoay.
        for rot in [0, 90, 180, 270] {
            let (w, h) = raster_size(&a4(), 72.0, rot).unwrap();
            let m = device_matrix(&a4(), 72.0, rot);
            let corners = [
                m.apply(0.0, 0.0),
                m.apply(595.0, 0.0),
                m.apply(0.0, 842.0),
                m.apply(595.0, 842.0),
            ];
            let xs: Vec<f32> = corners.iter().map(|c| c.0).collect();
            let ys: Vec<f32> = corners.iter().map(|c| c.1).collect();
            let minx = xs.iter().cloned().fold(f32::MAX, f32::min);
            let maxx = xs.iter().cloned().fold(f32::MIN, f32::max);
            let miny = ys.iter().cloned().fold(f32::MAX, f32::min);
            let maxy = ys.iter().cloned().fold(f32::MIN, f32::max);
            assert!(minx.abs() < 1e-2, "rot={rot} minx={minx}");
            assert!(miny.abs() < 1e-2, "rot={rot} miny={miny}");
            assert!(
                (maxx - w as f32).abs() < 1e-2,
                "rot={rot} maxx={maxx} w={w}"
            );
            assert!(
                (maxy - h as f32).abs() < 1e-2,
                "rot={rot} maxy={maxy} h={h}"
            );
        }
    }

    fn build_program_test_pdf(rotate: i32) -> Document {
        let mut doc = Document::with_version("1.7");
        let content = concat!(
            "0.1 0.7 0.2 0.3 k 0 0 12 10 re f ",
            "0.8 0.1 0.6 0.2 k 2.25 1.75 7.5 5.5 re f",
        );
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "Contents" => Object::Reference(content_id),
            "Resources" => dictionary! {},
            "MediaBox" => vec![0.into(), 0.into(), 12.into(), 10.into()],
            "Rotate" => rotate,
        });
        doc.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            },
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog));
        doc
    }

    fn assert_same_ink(actual: &PageRender, expected: &PageRender) {
        assert_eq!(actual.buffer.width(), expected.buffer.width());
        assert_eq!(actual.buffer.height(), expected.buffer.height());
        assert_eq!(
            actual.buffer.space().colorants(),
            expected.buffer.space().colorants()
        );
        for channel in 0..actual.buffer.space().len() {
            assert_eq!(
                actual.buffer.plate_u8(channel),
                expected.buffer.plate_u8(channel)
            );
        }
    }

    #[test]
    fn page_program_duoc_decode_mot_lan_va_replay_dung_qua_dpi_clip_rotation() {
        let doc = build_program_test_pdf(90);
        let descriptor = build_page_descriptor(&doc, 1).unwrap();
        let first_program = descriptor.program(&doc).unwrap();
        assert_eq!(first_program.operation_count(), 6);
        let first_program_ptr = first_program as *const _;

        for dpi in [72.0, 144.0] {
            let cached = render_page_descriptor(
                &doc,
                &descriptor,
                dpi,
                PageBox::Crop,
                RenderOptions::softproof(),
                None,
                None,
                None,
            )
            .unwrap();
            let stateless = render_page_managed_region(
                &doc,
                1,
                dpi,
                PageBox::Crop,
                RenderOptions::softproof(),
                None,
                None,
            )
            .unwrap();
            assert_same_ink(&cached, &stateless);
        }

        let clip = RasterClip {
            x: 3,
            y: 4,
            width: 10,
            height: 12,
        };
        let cached_clip = render_page_descriptor(
            &doc,
            &descriptor,
            144.0,
            PageBox::Crop,
            RenderOptions::softproof(),
            None,
            Some(clip),
            None,
        )
        .unwrap();
        let stateless_clip = render_page_managed_region(
            &doc,
            1,
            144.0,
            PageBox::Crop,
            RenderOptions::softproof(),
            None,
            Some(clip),
        )
        .unwrap();
        assert_same_ink(&cached_clip, &stateless_clip);

        assert_eq!(
            descriptor.program(&doc).unwrap() as *const _,
            first_program_ptr,
            "cùng descriptor phải replay đúng một PageProgram đã decode"
        );
    }
}
