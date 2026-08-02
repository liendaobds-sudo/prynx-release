//! Fast path Combine cho manifest chỉ gồm PNG/JPEG.
//!
//! PERF (audit 2026-08-02 §TC.1): tránh UPNG/pako trong WebView và tránh
//! ReportLab tạo PDF tạm từng ảnh. Module này không gọi PDFium.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::{DynamicImage, ImageFormat};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use png::{
    BlendOp as PngBlendOp, ColorType as PngColorType, Decoder as ApngDecoder,
    DisposeOp as PngDisposeOp, Limits as PngLimits, Transformations as PngTransformations,
};
use pyo3::exceptions::{
    PyIOError, PyInterruptedError, PyNotImplementedError, PyRuntimeError, PyValueError,
};
use pyo3::prelude::*;
use rayon::prelude::*;
use serde::Deserialize;

const MAX_MANIFEST_FILES: usize = 256;
const MAX_MANIFEST_ITEMS: usize = 20_000;
const A4_WIDTH_PT: f64 = 595.28;
const A4_HEIGHT_PT: f64 = 841.89;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_ICC_PROFILE_BYTES: u64 = 32 * 1024 * 1024;
const SRGB_ICC_PROFILE: &[u8] = include_bytes!("../../backend/app/assets/icc/sRGB.icc");

#[derive(Debug)]
enum ImagePdfError {
    Invalid(String),
    Unsupported(String),
    QualityGuard(String),
    Cancelled,
    Io(String),
    Runtime(String),
}

impl fmt::Display for ImagePdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::Unsupported(message)
            | Self::QualityGuard(message)
            | Self::Io(message)
            | Self::Runtime(message) => f.write_str(message),
            Self::Cancelled => f.write_str("Đã hủy ghép ảnh"),
        }
    }
}

impl std::error::Error for ImagePdfError {}

impl From<std::io::Error> for ImagePdfError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct ImageManifestRequest {
    sources: Vec<ImageSourceSpec>,
    pages: Vec<ImagePageSpec>,
}

#[derive(Debug, Deserialize)]
struct ImageSourceSpec {
    path: String,
    width_px: u32,
    height_px: u32,
    width_pt: f64,
    height_pt: f64,
}

#[derive(Debug, Deserialize)]
struct ImagePageSpec {
    #[serde(default)]
    blank: bool,
    file_index: Option<usize>,
    width: Option<f64>,
    height: Option<f64>,
    #[serde(default)]
    rotation: i32,
}

#[derive(Debug, Clone, Copy)]
enum AssetColorSpace {
    Gray,
    Rgb,
    Cmyk,
}

impl AssetColorSpace {
    fn components(self) -> i64 {
        match self {
            Self::Gray => 1,
            Self::Rgb => 3,
            Self::Cmyk => 4,
        }
    }

    fn device_name(self) -> &'static [u8] {
        match self {
            Self::Gray => b"DeviceGray",
            Self::Rgb => b"DeviceRGB",
            Self::Cmyk => b"DeviceCMYK",
        }
    }
}

#[derive(Debug)]
enum AssetFilter {
    Flate { colors: i64 },
    Dct,
}

#[derive(Debug)]
struct CompressedAlpha {
    bits_per_component: i64,
    data: Vec<u8>,
}

#[derive(Debug)]
struct PreparedAsset {
    width_px: u32,
    height_px: u32,
    bits_per_component: i64,
    color_space: AssetColorSpace,
    filter: AssetFilter,
    data: Vec<u8>,
    alpha: Option<CompressedAlpha>,
    icc_profile: Option<Vec<u8>>,
    invert_cmyk: bool,
}

type SharedPyCallback = Arc<Mutex<Py<PyAny>>>;

#[derive(Default)]
struct CallbackHooks {
    progress: Option<SharedPyCallback>,
    cancel: Option<SharedPyCallback>,
}

impl CallbackHooks {
    fn cancelled(&self) -> Result<bool, ImagePdfError> {
        let Some(callback) = &self.cancel else {
            return Ok(false);
        };
        let guard = callback
            .lock()
            .map_err(|_| ImagePdfError::Runtime("Khóa callback hủy bị lỗi".to_string()))?;
        Python::attach(|py| {
            guard
                .bind(py)
                .call0()
                .and_then(|value| value.extract::<bool>())
        })
        .map_err(|error| ImagePdfError::Runtime(format!("Callback hủy thất bại: {error}")))
    }

    fn report_source(&self, source_index: usize) -> Result<(), ImagePdfError> {
        let Some(callback) = &self.progress else {
            return Ok(());
        };
        let guard = callback
            .lock()
            .map_err(|_| ImagePdfError::Runtime("Khóa callback tiến độ bị lỗi".to_string()))?;
        Python::attach(|py| guard.bind(py).call1((source_index,)).map(|_| ()))
            .map_err(|error| ImagePdfError::Runtime(format!("Callback tiến độ thất bại: {error}")))
    }

    fn check_cancelled(&self) -> Result<(), ImagePdfError> {
        if self.cancelled()? {
            Err(ImagePdfError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug)]
struct ParsedPng {
    width: u32,
    height: u32,
    bit_depth: u8,
    color_type: u8,
    interlace: u8,
    has_trns: bool,
    icc_profile: Option<Vec<u8>>,
    has_srgb: bool,
    has_unhandled_color_metadata: bool,
    has_animation: bool,
    idat: Vec<u8>,
}

#[derive(Debug)]
struct ParsedJpeg {
    width: u32,
    height: u32,
    bits_per_component: i64,
    channels: u8,
    icc_profile: Option<Vec<u8>>,
}

#[pyfunction]
#[pyo3(signature = (
    request_json,
    output_path,
    max_workers=0,
    progress_callback=None,
    cancel_callback=None
))]
pub fn combine_image_manifest_native(
    py: Python<'_>,
    request_json: &str,
    output_path: &str,
    max_workers: usize,
    progress_callback: Option<Py<PyAny>>,
    cancel_callback: Option<Py<PyAny>>,
) -> PyResult<String> {
    let request: ImageManifestRequest = serde_json::from_str(request_json)
        .map_err(|error| PyValueError::new_err(format!("Manifest ảnh không hợp lệ: {error}")))?;
    let output = PathBuf::from(output_path);
    let hooks = CallbackHooks {
        progress: progress_callback.map(|callback| Arc::new(Mutex::new(callback))),
        cancel: cancel_callback.map(|callback| Arc::new(Mutex::new(callback))),
    };

    py.detach(move || combine_impl(request, output, max_workers, &hooks))
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(to_python_error)
}

fn to_python_error(error: ImagePdfError) -> PyErr {
    match error {
        ImagePdfError::Invalid(message) => PyValueError::new_err(message),
        ImagePdfError::Unsupported(message) => {
            PyNotImplementedError::new_err(format!("COMBINE_IMAGE_UNSUPPORTED: {message}"))
        }
        ImagePdfError::QualityGuard(message) => {
            PyValueError::new_err(format!("COMBINE_IMAGE_QUALITY_GUARD: {message}"))
        }
        ImagePdfError::Cancelled => PyInterruptedError::new_err("Đã hủy ghép ảnh"),
        ImagePdfError::Io(message) => PyIOError::new_err(message),
        ImagePdfError::Runtime(message) => PyRuntimeError::new_err(message),
    }
}

fn combine_impl(
    request: ImageManifestRequest,
    output_path: PathBuf,
    max_workers: usize,
    hooks: &CallbackHooks,
) -> Result<PathBuf, ImagePdfError> {
    let used_sources = validate_request(&request, &output_path)?;
    hooks.check_cancelled()?;

    let prepare = || prepare_sources(&request.sources, &used_sources, hooks);
    let prepared_pairs = if max_workers > 0 && max_workers < rayon::current_num_threads() {
        rayon::ThreadPoolBuilder::new()
            .num_threads(max_workers)
            .thread_name(|index| format!("prynx-combine-image-{index}"))
            .build()
            .map_err(|error| ImagePdfError::Runtime(format!("Không tạo được pool ảnh: {error}")))?
            .install(prepare)?
    } else {
        prepare()?
    };

    let mut assets: Vec<Option<Vec<PreparedAsset>>> =
        (0..request.sources.len()).map(|_| None).collect();
    for (source_index, source_assets) in prepared_pairs {
        assets[source_index] = Some(source_assets);
    }

    hooks.check_cancelled()?;
    let document = build_document(&request, assets, hooks)?;
    save_atomic(document, &output_path, hooks)?;
    Ok(output_path)
}

fn validate_request(
    request: &ImageManifestRequest,
    output_path: &Path,
) -> Result<Vec<usize>, ImagePdfError> {
    if request.sources.is_empty() || request.sources.len() > MAX_MANIFEST_FILES {
        return Err(ImagePdfError::Invalid(
            "Số nguồn ảnh nằm ngoài giới hạn Combine".to_string(),
        ));
    }
    if request.pages.is_empty() || request.pages.len() > MAX_MANIFEST_ITEMS {
        return Err(ImagePdfError::Invalid(
            "Số trang manifest nằm ngoài giới hạn Combine".to_string(),
        ));
    }
    if output_path.extension().and_then(|value| value.to_str()) != Some("pdf") {
        return Err(ImagePdfError::Invalid(
            "Đường dẫn kết quả phải có phần mở rộng .pdf".to_string(),
        ));
    }
    let parent = output_path.parent().ok_or_else(|| {
        ImagePdfError::Invalid("Đường dẫn kết quả không có thư mục cha".to_string())
    })?;
    if !parent.is_dir() {
        return Err(ImagePdfError::Invalid(
            "Thư mục kết quả không tồn tại".to_string(),
        ));
    }
    if output_path.exists() {
        return Err(ImagePdfError::Invalid(
            "File kết quả đã tồn tại; không ghi đè âm thầm".to_string(),
        ));
    }

    for source in &request.sources {
        if source.width_px == 0
            || source.height_px == 0
            || !source.width_pt.is_finite()
            || !source.height_pt.is_finite()
            || source.width_pt <= 0.0
            || source.height_pt <= 0.0
            || source.width_pt > 20_000.0
            || source.height_pt > 20_000.0
        {
            return Err(ImagePdfError::Invalid(
                "Kích thước nguồn ảnh không hợp lệ".to_string(),
            ));
        }
        let pixels = (source.width_px as usize)
            .checked_mul(source.height_px as usize)
            .ok_or_else(|| ImagePdfError::Invalid("Kích thước ảnh bị tràn số".to_string()))?;
        pixels
            .checked_mul(4)
            .ok_or_else(|| ImagePdfError::Invalid("Bộ đệm ảnh bị tràn số".to_string()))?;
    }

    let mut used = BTreeSet::new();
    for page in &request.pages {
        normalize_rotation(page.rotation)?;
        if page.blank {
            if page.file_index.is_some() {
                return Err(ImagePdfError::Invalid(
                    "Trang trắng không được tham chiếu nguồn ảnh".to_string(),
                ));
            }
            validate_optional_page_size(page.width, page.height)?;
            continue;
        }
        let source_index = page
            .file_index
            .ok_or_else(|| ImagePdfError::Invalid("Trang ảnh thiếu file_index".to_string()))?;
        if source_index >= request.sources.len() {
            return Err(ImagePdfError::Invalid(
                "file_index nằm ngoài danh sách nguồn".to_string(),
            ));
        }
        used.insert(source_index);
    }
    if used.is_empty() {
        return Err(ImagePdfError::Invalid(
            "Manifest không có trang ảnh nào".to_string(),
        ));
    }
    Ok(used.into_iter().collect())
}

fn validate_optional_page_size(
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), ImagePdfError> {
    for value in [width, height].into_iter().flatten() {
        if !value.is_finite() || value <= 0.0 || value > 20_000.0 {
            return Err(ImagePdfError::Invalid(
                "Kích thước trang trắng không hợp lệ".to_string(),
            ));
        }
    }
    Ok(())
}

fn normalize_rotation(rotation: i32) -> Result<i64, ImagePdfError> {
    let normalized = rotation.rem_euclid(360);
    if normalized % 90 != 0 {
        return Err(ImagePdfError::Invalid(
            "Góc xoay phải là bội số của 90".to_string(),
        ));
    }
    Ok(normalized as i64)
}

fn prepare_sources(
    sources: &[ImageSourceSpec],
    used_sources: &[usize],
    hooks: &CallbackHooks,
) -> Result<Vec<(usize, Vec<PreparedAsset>)>, ImagePdfError> {
    used_sources
        .par_iter()
        .map(|&source_index| {
            hooks.check_cancelled()?;
            let asset = prepare_source(source_index, &sources[source_index])?;
            hooks.check_cancelled()?;
            hooks.report_source(source_index)?;
            Ok((source_index, asset))
        })
        .collect()
}

fn prepare_source(
    source_index: usize,
    source: &ImageSourceSpec,
) -> Result<Vec<PreparedAsset>, ImagePdfError> {
    let bytes = fs::read(&source.path).map_err(|error| {
        ImagePdfError::Io(format!(
            "Không đọc được nguồn ảnh số {source_index} ({}): {error}",
            safe_file_name(&source.path)
        ))
    })?;
    let extension = Path::new(&source.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" => prepare_png_source(&bytes, source),
        "jpg" | "jpeg" => prepare_jpeg(&bytes, source).map(|asset| vec![asset]),
        _ => Err(ImagePdfError::Unsupported(format!(
            "Định dạng .{extension} chưa có fast path native"
        ))),
    }
}

fn safe_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("ảnh")
        .to_string()
}

fn prepare_png_source(
    bytes: &[u8],
    source: &ImageSourceSpec,
) -> Result<Vec<PreparedAsset>, ImagePdfError> {
    let parsed = parse_png(bytes)?;
    if parsed.has_animation {
        prepare_apng(bytes, source, &parsed)
    } else {
        prepare_png(bytes, source).map(|asset| vec![asset])
    }
}

fn prepare_apng(
    bytes: &[u8],
    source: &ImageSourceSpec,
    parsed: &ParsedPng,
) -> Result<Vec<PreparedAsset>, ImagePdfError> {
    ensure_pixel_parity(parsed.width, parsed.height, source)?;
    if parsed.bit_depth != 8 {
        return Err(ImagePdfError::QualityGuard(
            "APNG hiện chỉ hỗ trợ kênh 8-bit; bit-depth khác chưa có decoder animation bảo toàn"
                .to_string(),
        ));
    }
    if parsed.has_unhandled_color_metadata {
        return Err(ImagePdfError::QualityGuard(
            "APNG có thông tin màu chưa thể biểu diễn tương đương trong PDF".to_string(),
        ));
    }
    let color_space = if matches!(parsed.color_type, 0 | 4) {
        AssetColorSpace::Gray
    } else {
        AssetColorSpace::Rgb
    };
    let colors = color_space.components();
    let icc_profile = resolve_png_icc_profile(parsed, color_space)?;
    let pixel_count = (source.width_px as usize)
        .checked_mul(source.height_px as usize)
        .ok_or_else(|| ImagePdfError::Invalid("Kích thước APNG bị tràn số".to_string()))?;

    let mut decoder = ApngDecoder::new(Cursor::new(bytes));
    decoder.set_transformations(PngTransformations::EXPAND);
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    // PERF (audit 2026-08-03 §TC.4): kích thước đã được kiểm tra theo canvas và
    // backend đã gate RAM; không để mặc định 64 MiB làm chậm/fail máy mạnh.
    decoder.set_limits(PngLimits { bytes: usize::MAX });
    let mut reader = decoder
        .read_info()
        .map_err(|error| ImagePdfError::Invalid(format!("Không mở được APNG: {error}")))?;
    let animation = reader
        .info()
        .animation_control()
        .ok_or_else(|| ImagePdfError::Invalid("APNG thiếu chunk acTL".to_string()))?;
    let frame_count = animation.num_frames as usize;
    if frame_count == 0 || frame_count > MAX_MANIFEST_ITEMS {
        return Err(ImagePdfError::Invalid(
            "Số frame APNG nằm ngoài giới hạn".to_string(),
        ));
    }

    let buffer_size = reader.output_buffer_size().ok_or_else(|| {
        ImagePdfError::Invalid("Bộ đệm giải mã APNG vượt giới hạn hệ thống".to_string())
    })?;
    let mut frame_buffer = vec![0u8; buffer_size];
    let has_thumbnail = reader.info().frame_control().is_none();
    if has_thumbnail {
        reader.next_frame(&mut frame_buffer).map_err(|error| {
            ImagePdfError::Invalid(format!("Không bỏ qua được thumbnail APNG: {error}"))
        })?;
    }

    let canvas_bytes = pixel_count
        .checked_mul(4)
        .ok_or_else(|| ImagePdfError::Invalid("Bộ đệm canvas APNG bị tràn số".to_string()))?;
    let mut canvas = vec![0u8; canvas_bytes];
    let mut restore_canvas: Option<Vec<u8>> = None;
    let mut previous_dispose = PngDisposeOp::None;
    let mut previous_region: Option<(u32, u32, u32, u32)> = None;
    let mut assets = Vec::with_capacity(frame_count);

    for _ in 0..frame_count {
        apply_apng_disposal(
            &mut canvas,
            &mut restore_canvas,
            previous_dispose,
            previous_region,
            source.width_px,
        )?;
        let output = reader
            .next_frame(&mut frame_buffer)
            .map_err(|error| ImagePdfError::Invalid(format!("Không giải mã được APNG: {error}")))?;
        let control = reader
            .info()
            .frame_control()
            .cloned()
            .ok_or_else(|| ImagePdfError::Invalid("Frame APNG thiếu chunk fcTL".to_string()))?;
        validate_apng_frame(&output, &control, source)?;
        let frame_rgba = apng_frame_to_rgba(&frame_buffer[..output.buffer_size()], &output)?;
        restore_canvas = if control.dispose_op == PngDisposeOp::Previous {
            Some(canvas.clone())
        } else {
            None
        };
        composite_apng_frame(
            &mut canvas,
            source.width_px,
            &frame_rgba,
            control.width,
            control.height,
            control.x_offset,
            control.y_offset,
            control.blend_op,
        );
        previous_dispose = control.dispose_op;
        previous_region = Some((
            control.x_offset,
            control.y_offset,
            control.width,
            control.height,
        ));

        let (color, alpha) = split_apng_canvas(&canvas, color_space, pixel_count)?;
        assets.push(PreparedAsset {
            width_px: source.width_px,
            height_px: source.height_px,
            bits_per_component: 8,
            color_space,
            filter: AssetFilter::Flate { colors },
            data: compress_predictor_rows(
                &color,
                source.width_px,
                source.height_px,
                colors as usize,
                8,
            )?,
            alpha: alpha
                .map(|channel| {
                    compress_predictor_rows(&channel, source.width_px, source.height_px, 1, 8)
                })
                .transpose()?
                .map(|data| CompressedAlpha {
                    bits_per_component: 8,
                    data,
                }),
            icc_profile: icc_profile.clone(),
            invert_cmyk: false,
        });
    }
    Ok(assets)
}

fn validate_apng_frame(
    output: &png::OutputInfo,
    control: &png::FrameControl,
    source: &ImageSourceSpec,
) -> Result<(), ImagePdfError> {
    let x_end = control.x_offset.checked_add(control.width);
    let y_end = control.y_offset.checked_add(control.height);
    if output.bit_depth != png::BitDepth::Eight
        || output.width != control.width
        || output.height != control.height
        || x_end.is_none_or(|value| value > source.width_px)
        || y_end.is_none_or(|value| value > source.height_px)
    {
        return Err(ImagePdfError::Invalid(
            "Kích thước frame APNG không hợp lệ".to_string(),
        ));
    }
    Ok(())
}

fn apply_apng_disposal(
    canvas: &mut [u8],
    restore_canvas: &mut Option<Vec<u8>>,
    dispose: PngDisposeOp,
    region: Option<(u32, u32, u32, u32)>,
    canvas_width: u32,
) -> Result<(), ImagePdfError> {
    match dispose {
        PngDisposeOp::None => {}
        PngDisposeOp::Background => {
            let (x, y, width, height) = region
                .ok_or_else(|| ImagePdfError::Invalid("APNG thiếu vùng dispose".to_string()))?;
            for row in y..y + height {
                let start = ((row as usize * canvas_width as usize + x as usize) * 4) as usize;
                let end = start + width as usize * 4;
                canvas[start..end].fill(0);
            }
        }
        PngDisposeOp::Previous => {
            let previous = restore_canvas.take().ok_or_else(|| {
                ImagePdfError::Invalid("APNG không có canvas để dispose Previous".to_string())
            })?;
            canvas.copy_from_slice(&previous);
        }
    }
    Ok(())
}

fn apng_frame_to_rgba(raw: &[u8], output: &png::OutputInfo) -> Result<Vec<u8>, ImagePdfError> {
    let channels = match output.color_type {
        PngColorType::Grayscale => 1,
        PngColorType::GrayscaleAlpha => 2,
        PngColorType::Rgb => 3,
        PngColorType::Rgba => 4,
        PngColorType::Indexed => {
            return Err(ImagePdfError::Invalid(
                "APNG palette chưa được decoder mở rộng".to_string(),
            ))
        }
    };
    let pixel_count = output.width as usize * output.height as usize;
    if raw.len() != pixel_count * channels {
        return Err(ImagePdfError::Invalid(
            "Bộ đệm frame APNG không khớp kích thước".to_string(),
        ));
    }
    let mut rgba = Vec::with_capacity(pixel_count * 4);
    for pixel in raw.chunks_exact(channels) {
        match output.color_type {
            PngColorType::Grayscale => rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], 255]),
            PngColorType::GrayscaleAlpha => {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]])
            }
            PngColorType::Rgb => rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]),
            PngColorType::Rgba => rgba.extend_from_slice(pixel),
            PngColorType::Indexed => unreachable!("đã chặn palette chưa mở rộng"),
        }
    }
    Ok(rgba)
}

#[allow(clippy::too_many_arguments)]
fn composite_apng_frame(
    canvas: &mut [u8],
    canvas_width: u32,
    frame: &[u8],
    frame_width: u32,
    frame_height: u32,
    x_offset: u32,
    y_offset: u32,
    blend: PngBlendOp,
) {
    for y in 0..frame_height as usize {
        for x in 0..frame_width as usize {
            let source_index = (y * frame_width as usize + x) * 4;
            let target_index =
                (((y + y_offset as usize) * canvas_width as usize + x + x_offset as usize) * 4)
                    as usize;
            let source = &frame[source_index..source_index + 4];
            let target = &mut canvas[target_index..target_index + 4];
            match blend {
                PngBlendOp::Source => target.copy_from_slice(source),
                PngBlendOp::Over => blend_rgba_over(target, source),
            }
        }
    }
}

fn blend_rgba_over(background: &mut [u8], foreground: &[u8]) {
    let foreground_alpha = foreground[3] as u32;
    if foreground_alpha == 0 {
        return;
    }
    if foreground_alpha == 255 {
        background.copy_from_slice(foreground);
        return;
    }
    let background_alpha = background[3] as u32;
    let inverse_alpha = 255 - foreground_alpha;
    let output_alpha_numerator = foreground_alpha * 255 + background_alpha * inverse_alpha;
    if output_alpha_numerator == 0 {
        background.fill(0);
        return;
    }
    for channel in 0..3 {
        let numerator = foreground[channel] as u32 * foreground_alpha * 255
            + background[channel] as u32 * background_alpha * inverse_alpha;
        background[channel] =
            ((numerator + output_alpha_numerator / 2) / output_alpha_numerator) as u8;
    }
    background[3] = ((output_alpha_numerator + 127) / 255) as u8;
}

fn split_apng_canvas(
    canvas: &[u8],
    color_space: AssetColorSpace,
    pixel_count: usize,
) -> Result<(Vec<u8>, Option<Vec<u8>>), ImagePdfError> {
    if canvas.len() != pixel_count * 4 {
        return Err(ImagePdfError::Invalid(
            "Canvas APNG không khớp kích thước".to_string(),
        ));
    }
    let has_alpha = canvas.chunks_exact(4).any(|pixel| pixel[3] != u8::MAX);
    let components = color_space.components() as usize;
    let mut color = Vec::with_capacity(pixel_count * components);
    let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count));
    for pixel in canvas.chunks_exact(4) {
        if matches!(color_space, AssetColorSpace::Gray) {
            color.push(pixel[0]);
        } else {
            color.extend_from_slice(&pixel[..3]);
        }
        if let Some(channel) = alpha.as_mut() {
            channel.push(pixel[3]);
        }
    }
    Ok((color, alpha))
}

fn prepare_png(bytes: &[u8], source: &ImageSourceSpec) -> Result<PreparedAsset, ImagePdfError> {
    let parsed = parse_png(bytes)?;
    ensure_pixel_parity(parsed.width, parsed.height, source)?;
    if parsed.has_animation {
        return Err(ImagePdfError::Invalid(
            "APNG phải đi qua đường tách frame".to_string(),
        ));
    }
    if parsed.has_unhandled_color_metadata {
        return Err(ImagePdfError::QualityGuard(
            "PNG có thông tin màu chưa thể biểu diễn tương đương trong PDF".to_string(),
        ));
    }

    let direct_idat = parsed.interlace == 0
        && !parsed.has_trns
        && ((parsed.color_type == 0 && matches!(parsed.bit_depth, 1 | 2 | 4 | 8 | 16))
            || (parsed.color_type == 2 && matches!(parsed.bit_depth, 8 | 16)));
    if direct_idat {
        let (color_space, colors) = if parsed.color_type == 0 {
            (AssetColorSpace::Gray, 1)
        } else {
            (AssetColorSpace::Rgb, 3)
        };
        let icc_profile = resolve_png_icc_profile(&parsed, color_space)?;
        return Ok(PreparedAsset {
            width_px: parsed.width,
            height_px: parsed.height,
            bits_per_component: parsed.bit_depth as i64,
            color_space,
            filter: AssetFilter::Flate { colors },
            data: parsed.idat,
            alpha: None,
            icc_profile,
            invert_cmyk: false,
        });
    }

    let decoded = image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|error| ImagePdfError::Invalid(format!("Không giải mã được PNG: {error}")))?;
    if decoded.width() != source.width_px || decoded.height() != source.height_px {
        return Err(ImagePdfError::Invalid(
            "Kích thước PNG sau giải mã không khớp bước kiểm tra".to_string(),
        ));
    }
    let pixel_count = (source.width_px as usize)
        .checked_mul(source.height_px as usize)
        .ok_or_else(|| ImagePdfError::Invalid("Kích thước PNG bị tràn số".to_string()))?;
    let color_space = if matches!(parsed.color_type, 0 | 4) {
        AssetColorSpace::Gray
    } else {
        AssetColorSpace::Rgb
    };
    let colors = color_space.components();
    let bits_per_component = if parsed.bit_depth == 16 { 16 } else { 8 };
    let (color, alpha) = if bits_per_component == 16 {
        split_png_16bit(&decoded, color_space, pixel_count)?
    } else {
        split_png_8bit(&decoded, color_space, pixel_count)?
    };
    let icc_profile = resolve_png_icc_profile(&parsed, color_space)?;

    Ok(PreparedAsset {
        width_px: source.width_px,
        height_px: source.height_px,
        bits_per_component,
        color_space,
        filter: AssetFilter::Flate { colors },
        data: compress_predictor_rows(
            &color,
            source.width_px,
            source.height_px,
            colors as usize,
            bits_per_component,
        )?,
        alpha: alpha
            .map(|channel| {
                compress_predictor_rows(
                    &channel,
                    source.width_px,
                    source.height_px,
                    1,
                    bits_per_component,
                )
            })
            .transpose()?
            .map(|data| CompressedAlpha {
                bits_per_component,
                data,
            }),
        icc_profile,
        invert_cmyk: false,
    })
}

fn resolve_png_icc_profile(
    parsed: &ParsedPng,
    color_space: AssetColorSpace,
) -> Result<Option<Vec<u8>>, ImagePdfError> {
    let profile = parsed
        .icc_profile
        .as_deref()
        .or_else(|| parsed.has_srgb.then_some(SRGB_ICC_PROFILE));
    profile
        .map(|bytes| validate_icc_profile(bytes, color_space).map(|_| bytes.to_vec()))
        .transpose()
}

fn split_png_8bit(
    decoded: &DynamicImage,
    color_space: AssetColorSpace,
    pixel_count: usize,
) -> Result<(Vec<u8>, Option<Vec<u8>>), ImagePdfError> {
    if matches!(color_space, AssetColorSpace::Gray) {
        let pixels = decoded.to_luma_alpha8().into_raw();
        let has_alpha = pixels.chunks_exact(2).any(|pixel| pixel[1] != u8::MAX);
        let mut gray = Vec::with_capacity(pixel_count);
        let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count));
        for pixel in pixels.chunks_exact(2) {
            gray.push(pixel[0]);
            if let Some(channel) = alpha.as_mut() {
                channel.push(pixel[1]);
            }
        }
        Ok((gray, alpha))
    } else {
        let pixels = decoded.to_rgba8().into_raw();
        let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != u8::MAX);
        let mut rgb = Vec::with_capacity(pixel_count * 3);
        let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count));
        for pixel in pixels.chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
            if let Some(channel) = alpha.as_mut() {
                channel.push(pixel[3]);
            }
        }
        Ok((rgb, alpha))
    }
}

fn split_png_16bit(
    decoded: &DynamicImage,
    color_space: AssetColorSpace,
    pixel_count: usize,
) -> Result<(Vec<u8>, Option<Vec<u8>>), ImagePdfError> {
    if matches!(color_space, AssetColorSpace::Gray) {
        let pixels = decoded.to_luma_alpha16().into_raw();
        let has_alpha = pixels.chunks_exact(2).any(|pixel| pixel[1] != u16::MAX);
        let mut gray = Vec::with_capacity(pixel_count * 2);
        let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count * 2));
        for pixel in pixels.chunks_exact(2) {
            gray.extend_from_slice(&pixel[0].to_be_bytes());
            if let Some(channel) = alpha.as_mut() {
                channel.extend_from_slice(&pixel[1].to_be_bytes());
            }
        }
        Ok((gray, alpha))
    } else {
        let pixels = decoded.to_rgba16().into_raw();
        let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != u16::MAX);
        let mut rgb = Vec::with_capacity(pixel_count * 6);
        let mut alpha = has_alpha.then(|| Vec::with_capacity(pixel_count * 2));
        for pixel in pixels.chunks_exact(4) {
            for channel in &pixel[..3] {
                rgb.extend_from_slice(&channel.to_be_bytes());
            }
            if let Some(channel) = alpha.as_mut() {
                channel.extend_from_slice(&pixel[3].to_be_bytes());
            }
        }
        Ok((rgb, alpha))
    }
}

fn parse_png(bytes: &[u8]) -> Result<ParsedPng, ImagePdfError> {
    if bytes.len() < PNG_SIGNATURE.len() || &bytes[..8] != PNG_SIGNATURE {
        return Err(ImagePdfError::Invalid("Sai signature PNG".to_string()));
    }

    let mut cursor = 8usize;
    let mut ihdr: Option<(u32, u32, u8, u8, u8)> = None;
    let mut idat = Vec::new();
    let mut has_trns = false;
    let mut icc_profile: Option<Vec<u8>> = None;
    let mut has_srgb = false;
    let mut has_gamma = false;
    let mut has_chromaticities = false;
    let mut has_cicp = false;
    let mut has_animation = false;
    let mut saw_iend = false;

    while cursor
        .checked_add(12)
        .is_some_and(|minimum| minimum <= bytes.len())
    {
        let length = u32::from_be_bytes(
            bytes[cursor..cursor + 4]
                .try_into()
                .map_err(|_| ImagePdfError::Invalid("Chunk PNG bị cắt".to_string()))?,
        ) as usize;
        let kind = &bytes[cursor + 4..cursor + 8];
        let data_start = cursor + 8;
        let data_end = data_start
            .checked_add(length)
            .ok_or_else(|| ImagePdfError::Invalid("Chunk PNG bị tràn số".to_string()))?;
        let chunk_end = data_end
            .checked_add(4)
            .ok_or_else(|| ImagePdfError::Invalid("CRC PNG bị tràn số".to_string()))?;
        if chunk_end > bytes.len() {
            return Err(ImagePdfError::Invalid(
                "Chunk PNG vượt cuối file".to_string(),
            ));
        }

        match kind {
            b"IHDR" => {
                if length != 13 || ihdr.is_some() {
                    return Err(ImagePdfError::Invalid("IHDR PNG không hợp lệ".to_string()));
                }
                let width =
                    u32::from_be_bytes(bytes[data_start..data_start + 4].try_into().unwrap());
                let height =
                    u32::from_be_bytes(bytes[data_start + 4..data_start + 8].try_into().unwrap());
                let bit_depth = bytes[data_start + 8];
                let color_type = bytes[data_start + 9];
                let compression = bytes[data_start + 10];
                let filter = bytes[data_start + 11];
                let interlace = bytes[data_start + 12];
                if width == 0
                    || height == 0
                    || compression != 0
                    || filter != 0
                    || interlace > 1
                    || !valid_png_bit_depth(color_type, bit_depth)
                {
                    return Err(ImagePdfError::Invalid(
                        "Thông số IHDR không hợp lệ".to_string(),
                    ));
                }
                ihdr = Some((width, height, bit_depth, color_type, interlace));
            }
            b"IDAT" => {
                if ihdr.is_none() {
                    return Err(ImagePdfError::Invalid(
                        "IDAT xuất hiện trước IHDR".to_string(),
                    ));
                }
                idat.extend_from_slice(&bytes[data_start..data_end]);
            }
            b"tRNS" => has_trns = true,
            b"iCCP" => {
                if icc_profile.is_some() {
                    return Err(ImagePdfError::Invalid(
                        "PNG có nhiều chunk iCCP".to_string(),
                    ));
                }
                icc_profile = Some(decode_png_iccp(&bytes[data_start..data_end])?);
            }
            b"sRGB" => has_srgb = true,
            b"gAMA" => has_gamma = true,
            b"cHRM" => has_chromaticities = true,
            b"cICP" => has_cicp = true,
            b"acTL" | b"fcTL" | b"fdAT" => has_animation = true,
            b"IEND" => {
                saw_iend = true;
                break;
            }
            _ => {}
        }
        cursor = chunk_end;
    }

    let (width, height, bit_depth, color_type, interlace) =
        ihdr.ok_or_else(|| ImagePdfError::Invalid("PNG thiếu IHDR".to_string()))?;
    if !saw_iend || idat.is_empty() {
        return Err(ImagePdfError::Invalid("PNG thiếu IDAT/IEND".to_string()));
    }
    if icc_profile.is_some() && has_srgb {
        return Err(ImagePdfError::Invalid(
            "PNG không được đồng thời chứa iCCP và sRGB".to_string(),
        ));
    }
    let has_unhandled_color_metadata =
        has_cicp || ((has_gamma || has_chromaticities) && icc_profile.is_none() && !has_srgb);
    Ok(ParsedPng {
        width,
        height,
        bit_depth,
        color_type,
        interlace,
        has_trns,
        icc_profile,
        has_srgb,
        has_unhandled_color_metadata,
        has_animation,
        idat,
    })
}

fn valid_png_bit_depth(color_type: u8, bit_depth: u8) -> bool {
    match color_type {
        0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(bit_depth, 8 | 16),
        3 => matches!(bit_depth, 1 | 2 | 4 | 8),
        _ => false,
    }
}

fn decode_png_iccp(data: &[u8]) -> Result<Vec<u8>, ImagePdfError> {
    let separator = data
        .iter()
        .position(|&value| value == 0)
        .ok_or_else(|| ImagePdfError::Invalid("iCCP thiếu tên profile".to_string()))?;
    if separator == 0 || separator > 79 || data.get(separator + 1) != Some(&0) {
        return Err(ImagePdfError::Invalid("iCCP không hợp lệ".to_string()));
    }
    let compressed = data
        .get(separator + 2..)
        .filter(|payload| !payload.is_empty())
        .ok_or_else(|| ImagePdfError::Invalid("iCCP thiếu dữ liệu profile".to_string()))?;
    let mut decoder = ZlibDecoder::new(compressed).take(MAX_ICC_PROFILE_BYTES + 1);
    let mut profile = Vec::new();
    decoder
        .read_to_end(&mut profile)
        .map_err(|error| ImagePdfError::Invalid(format!("Không giải nén được iCCP: {error}")))?;
    if profile.len() as u64 > MAX_ICC_PROFILE_BYTES {
        return Err(ImagePdfError::Invalid(
            "ICC vượt giới hạn an toàn".to_string(),
        ));
    }
    Ok(profile)
}

fn prepare_jpeg(bytes: &[u8], source: &ImageSourceSpec) -> Result<PreparedAsset, ImagePdfError> {
    let parsed = parse_jpeg(bytes)?;
    ensure_pixel_parity(parsed.width, parsed.height, source)?;
    let (color_space, invert_cmyk) = match parsed.channels {
        1 => (AssetColorSpace::Gray, false),
        3 => (AssetColorSpace::Rgb, false),
        4 => (AssetColorSpace::Cmyk, true),
        _ => {
            return Err(ImagePdfError::Unsupported(
                "JPEG có số kênh màu chưa hỗ trợ".to_string(),
            ))
        }
    };
    if let Some(profile) = parsed.icc_profile.as_deref() {
        validate_icc_profile(profile, color_space)?;
    }
    Ok(PreparedAsset {
        width_px: parsed.width,
        height_px: parsed.height,
        bits_per_component: parsed.bits_per_component,
        color_space,
        filter: AssetFilter::Dct,
        data: bytes.to_vec(),
        alpha: None,
        icc_profile: parsed.icc_profile,
        invert_cmyk,
    })
}

fn parse_jpeg(bytes: &[u8]) -> Result<ParsedJpeg, ImagePdfError> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err(ImagePdfError::Invalid("Sai signature JPEG".to_string()));
    }
    let mut cursor = 2usize;
    let mut icc_parts: BTreeMap<u8, Vec<u8>> = BTreeMap::new();
    let mut icc_part_count: Option<u8> = None;
    let mut frame_info: Option<(u32, u32, i64, u8)> = None;
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor] == 0xff {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            break;
        }
        let marker = bytes[cursor];
        cursor += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if cursor + 2 > bytes.len() {
            return Err(ImagePdfError::Invalid("Marker JPEG bị cắt".to_string()));
        }
        let length = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        if length < 2 || cursor + length > bytes.len() {
            return Err(ImagePdfError::Invalid(
                "Độ dài marker JPEG không hợp lệ".to_string(),
            ));
        }
        let payload = cursor + 2;
        if marker == 0xe2
            && length >= 16
            && bytes.get(payload..payload + 12) == Some(b"ICC_PROFILE\0")
        {
            let sequence = bytes[payload + 12];
            let count = bytes[payload + 13];
            if sequence == 0 || count == 0 || sequence > count {
                return Err(ImagePdfError::Invalid(
                    "Thứ tự ICC APP2 của JPEG không hợp lệ".to_string(),
                ));
            }
            if icc_part_count
                .replace(count)
                .is_some_and(|existing| existing != count)
            {
                return Err(ImagePdfError::Invalid(
                    "Số phần ICC APP2 của JPEG không nhất quán".to_string(),
                ));
            }
            if icc_parts
                .insert(sequence, bytes[payload + 14..cursor + length].to_vec())
                .is_some()
            {
                return Err(ImagePdfError::Invalid(
                    "JPEG lặp thứ tự ICC APP2".to_string(),
                ));
            }
        }
        let is_sof = matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        );
        if is_sof {
            if length < 8 {
                return Err(ImagePdfError::Invalid("SOF JPEG quá ngắn".to_string()));
            }
            let bits_per_component = bytes[payload] as i64;
            let height = u16::from_be_bytes([bytes[payload + 1], bytes[payload + 2]]) as u32;
            let width = u16::from_be_bytes([bytes[payload + 3], bytes[payload + 4]]) as u32;
            let channels = bytes[payload + 5];
            if width == 0 || height == 0 || bits_per_component <= 0 {
                return Err(ImagePdfError::Invalid("SOF JPEG không hợp lệ".to_string()));
            }
            frame_info.get_or_insert((width, height, bits_per_component, channels));
        }
        cursor += length;
    }
    let (width, height, bits_per_component, channels) = frame_info
        .ok_or_else(|| ImagePdfError::Invalid("JPEG không có marker SOF hợp lệ".to_string()))?;
    let icc_profile = assemble_jpeg_icc(icc_parts, icc_part_count)?;
    Ok(ParsedJpeg {
        width,
        height,
        bits_per_component,
        channels,
        icc_profile,
    })
}

fn assemble_jpeg_icc(
    parts: BTreeMap<u8, Vec<u8>>,
    part_count: Option<u8>,
) -> Result<Option<Vec<u8>>, ImagePdfError> {
    let Some(count) = part_count else {
        return Ok(None);
    };
    if parts.len() != count as usize {
        return Err(ImagePdfError::Invalid(
            "JPEG thiếu phần ICC APP2".to_string(),
        ));
    }
    let total_bytes = parts.values().try_fold(0usize, |total, part| {
        total
            .checked_add(part.len())
            .ok_or_else(|| ImagePdfError::Invalid("Kích thước ICC JPEG bị tràn số".to_string()))
    })?;
    if total_bytes == 0 || total_bytes as u64 > MAX_ICC_PROFILE_BYTES {
        return Err(ImagePdfError::Invalid(
            "Kích thước ICC JPEG không hợp lệ".to_string(),
        ));
    }
    let mut profile = Vec::with_capacity(total_bytes);
    for sequence in 1..=count {
        profile.extend_from_slice(
            parts
                .get(&sequence)
                .ok_or_else(|| ImagePdfError::Invalid("JPEG thiếu thứ tự ICC APP2".to_string()))?,
        );
    }
    Ok(Some(profile))
}

fn validate_icc_profile(profile: &[u8], color_space: AssetColorSpace) -> Result<(), ImagePdfError> {
    if profile.len() < 128 || profile.len() as u64 > MAX_ICC_PROFILE_BYTES {
        return Err(ImagePdfError::Invalid(
            "Kích thước ICC không hợp lệ".to_string(),
        ));
    }
    let declared_size = u32::from_be_bytes(profile[..4].try_into().unwrap()) as usize;
    if declared_size < 128 || declared_size > profile.len() || &profile[36..40] != b"acsp" {
        return Err(ImagePdfError::Invalid(
            "Header ICC không hợp lệ".to_string(),
        ));
    }
    let expected = match color_space {
        AssetColorSpace::Gray => b"GRAY".as_slice(),
        AssetColorSpace::Rgb => b"RGB ".as_slice(),
        AssetColorSpace::Cmyk => b"CMYK".as_slice(),
    };
    if &profile[16..20] != expected {
        return Err(ImagePdfError::QualityGuard(
            "Số kênh ICC không khớp dữ liệu ảnh".to_string(),
        ));
    }
    Ok(())
}

fn ensure_pixel_parity(
    width: u32,
    height: u32,
    source: &ImageSourceSpec,
) -> Result<(), ImagePdfError> {
    if width != source.width_px || height != source.height_px {
        Err(ImagePdfError::Invalid(
            "Kích thước pixel không khớp bước kiểm tra backend".to_string(),
        ))
    } else {
        Ok(())
    }
}

fn compress_predictor_rows(
    raw: &[u8],
    width: u32,
    height: u32,
    channels: usize,
    bits_per_component: i64,
) -> Result<Vec<u8>, ImagePdfError> {
    let bytes_per_component = match bits_per_component {
        8 => 1usize,
        16 => 2usize,
        _ => {
            return Err(ImagePdfError::Invalid(
                "Predictor chỉ nhận kênh 8-bit hoặc 16-bit".to_string(),
            ))
        }
    };
    let bytes_per_pixel = channels
        .checked_mul(bytes_per_component)
        .ok_or_else(|| ImagePdfError::Invalid("Số byte mỗi pixel bị tràn".to_string()))?;
    let row_bytes = (width as usize)
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| ImagePdfError::Invalid("Số byte mỗi hàng bị tràn".to_string()))?;
    let expected = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| ImagePdfError::Invalid("Bộ đệm ảnh bị tràn".to_string()))?;
    if raw.len() != expected {
        return Err(ImagePdfError::Invalid(
            "Độ dài kênh ảnh không khớp kích thước".to_string(),
        ));
    }

    let mut filtered = Vec::with_capacity(expected + height as usize);
    let mut sub_row = vec![0u8; row_bytes];
    for row in raw.chunks_exact(row_bytes) {
        let mut none_score = 0u64;
        let mut sub_score = 0u64;
        for (index, &value) in row.iter().enumerate() {
            none_score += signed_byte_score(value);
            let left = if index >= bytes_per_pixel {
                row[index - bytes_per_pixel]
            } else {
                0
            };
            let filtered_value = value.wrapping_sub(left);
            sub_row[index] = filtered_value;
            sub_score += signed_byte_score(filtered_value);
        }
        if sub_score < none_score {
            filtered.push(1);
            filtered.extend_from_slice(&sub_row);
        } else {
            filtered.push(0);
            filtered.extend_from_slice(row);
        }
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&filtered)?;
    encoder
        .finish()
        .map_err(|error| ImagePdfError::Io(error.to_string()))
}

fn signed_byte_score(value: u8) -> u64 {
    let signed = value as i8 as i16;
    signed.unsigned_abs() as u64
}

fn build_document(
    request: &ImageManifestRequest,
    assets: Vec<Option<Vec<PreparedAsset>>>,
    hooks: &CallbackHooks,
) -> Result<Document, ImagePdfError> {
    let expanded_page_count = request.pages.iter().try_fold(0usize, |count, page| {
        let added = if page.blank {
            1
        } else {
            let source_index = page.file_index.expect("đã validate file_index");
            assets[source_index]
                .as_ref()
                .ok_or_else(|| ImagePdfError::Runtime("Nguồn ảnh chưa được chuẩn bị".to_string()))?
                .len()
        };
        count
            .checked_add(added)
            .filter(|&value| value <= MAX_MANIFEST_ITEMS)
            .ok_or_else(|| {
                ImagePdfError::Invalid(
                    "Tổng số trang sau khi tách frame APNG vượt giới hạn Combine".to_string(),
                )
            })
    })?;

    let mut document = Document::with_version("1.7");
    let mut image_ids: Vec<Option<Vec<ObjectId>>> =
        (0..request.sources.len()).map(|_| None).collect();

    for (source_index, source_assets) in assets.into_iter().enumerate() {
        let Some(source_assets) = source_assets else {
            continue;
        };
        hooks.check_cancelled()?;
        image_ids[source_index] = Some(
            source_assets
                .into_iter()
                .map(|asset| add_image_object(&mut document, asset))
                .collect(),
        );
    }

    let pages_id = document.new_object_id();
    let mut kids = Vec::with_capacity(expanded_page_count);
    let mut first_visible_size: Option<(f64, f64)> = None;

    for page in &request.pages {
        hooks.check_cancelled()?;
        let rotation = normalize_rotation(page.rotation)?;
        if page.blank {
            let size = if page.width.is_some() || page.height.is_some() {
                (
                    page.width.unwrap_or(A4_WIDTH_PT),
                    page.height.unwrap_or(A4_HEIGHT_PT),
                )
            } else {
                first_visible_size.unwrap_or((A4_WIDTH_PT, A4_HEIGHT_PT))
            };
            let page_id = add_pdf_page(&mut document, pages_id, size.0, size.1, rotation, None);
            kids.push(Object::Reference(page_id));
            if first_visible_size.is_none() {
                first_visible_size = Some(rotated_page_size(size.0, size.1, rotation));
            }
            continue;
        }

        let source_index = page.file_index.expect("đã validate file_index");
        let source = &request.sources[source_index];
        let source_image_ids = image_ids[source_index]
            .as_ref()
            .ok_or_else(|| ImagePdfError::Runtime("Nguồn ảnh chưa được chuẩn bị".to_string()))?;
        for &image_id in source_image_ids {
            hooks.check_cancelled()?;
            let page_id = add_pdf_page(
                &mut document,
                pages_id,
                source.width_pt,
                source.height_pt,
                rotation,
                Some(image_id),
            );
            kids.push(Object::Reference(page_id));
            if first_visible_size.is_none() {
                first_visible_size = Some(rotated_page_size(
                    source.width_pt,
                    source.height_pt,
                    rotation,
                ));
            }
        }
    }

    let page_count = kids.len() as i64;
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(kids),
            "Count" => page_count,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    let info_id = document.add_object(dictionary! {
        "Producer" => Object::string_literal("PrynX native Combine"),
    });
    document.trailer.set("Root", Object::Reference(catalog_id));
    document.trailer.set("Info", Object::Reference(info_id));
    Ok(document)
}

fn add_pdf_page(
    document: &mut Document,
    pages_id: ObjectId,
    width_pt: f64,
    height_pt: f64,
    rotation: i64,
    image_id: Option<ObjectId>,
) -> ObjectId {
    let content = image_id
        .map(|_| format!("q\n{width_pt:.6} 0 0 {height_pt:.6} 0 0 cm\n/Im0 Do\nQ\n").into_bytes())
        .unwrap_or_default();
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let resources = if let Some(image_id) = image_id {
        dictionary! {
            "XObject" => dictionary! { "Im0" => Object::Reference(image_id) }
        }
    } else {
        Dictionary::new()
    };
    let resources_id = document.add_object(resources);
    let mut page_dictionary = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Real(width_pt as f32),
            Object::Real(height_pt as f32),
        ]),
    };
    if rotation != 0 {
        page_dictionary.set("Rotate", rotation);
    }
    document.add_object(page_dictionary)
}

fn rotated_page_size(width_pt: f64, height_pt: f64, rotation: i64) -> (f64, f64) {
    if matches!(rotation, 90 | 270) {
        (height_pt, width_pt)
    } else {
        (width_pt, height_pt)
    }
}

fn add_image_object(document: &mut Document, asset: PreparedAsset) -> ObjectId {
    let PreparedAsset {
        width_px,
        height_px,
        bits_per_component,
        color_space,
        filter,
        data,
        alpha,
        icc_profile,
        invert_cmyk,
    } = asset;
    let alpha_id = alpha.map(|alpha| {
        let mut alpha_dictionary = base_image_dictionary(
            width_px,
            height_px,
            alpha.bits_per_component,
            AssetColorSpace::Gray,
        );
        alpha_dictionary.set("Filter", "FlateDecode");
        alpha_dictionary.set(
            "DecodeParms",
            predictor_dictionary(width_px, 1, alpha.bits_per_component),
        );
        document.add_object(Stream::new(alpha_dictionary, alpha.data))
    });

    let mut image_dictionary =
        base_image_dictionary(width_px, height_px, bits_per_component, color_space);
    if let Some(profile) = icc_profile {
        let profile_dictionary = dictionary! {
            "N" => color_space.components(),
            "Alternate" => Object::Name(color_space.device_name().to_vec()),
        };
        let profile_id = document.add_object(Stream::new(profile_dictionary, profile));
        image_dictionary.set(
            "ColorSpace",
            Object::Array(vec![
                Object::Name(b"ICCBased".to_vec()),
                Object::Reference(profile_id),
            ]),
        );
    }
    match filter {
        AssetFilter::Flate { colors } => {
            image_dictionary.set("Filter", "FlateDecode");
            image_dictionary.set(
                "DecodeParms",
                predictor_dictionary(width_px, colors, bits_per_component),
            );
        }
        AssetFilter::Dct => {
            image_dictionary.set("Filter", "DCTDecode");
        }
    }
    if let Some(alpha_id) = alpha_id {
        image_dictionary.set("SMask", Object::Reference(alpha_id));
    }
    if invert_cmyk {
        image_dictionary.set(
            "Decode",
            Object::Array(vec![
                1.into(),
                0.into(),
                1.into(),
                0.into(),
                1.into(),
                0.into(),
                1.into(),
                0.into(),
            ]),
        );
    }
    document.add_object(Stream::new(image_dictionary, data))
}

fn base_image_dictionary(
    width: u32,
    height: u32,
    bits_per_component: i64,
    color_space: AssetColorSpace,
) -> Dictionary {
    dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => width as i64,
        "Height" => height as i64,
        "BitsPerComponent" => bits_per_component,
        "ColorSpace" => Object::Name(color_space.device_name().to_vec()),
    }
}

fn predictor_dictionary(width: u32, colors: i64, bits_per_component: i64) -> Dictionary {
    dictionary! {
        "Predictor" => 15,
        "Colors" => colors,
        "BitsPerComponent" => bits_per_component,
        "Columns" => width as i64,
    }
}

fn save_atomic(
    mut document: Document,
    output_path: &Path,
    hooks: &CallbackHooks,
) -> Result<(), ImagePdfError> {
    hooks.check_cancelled()?;
    let parent = output_path
        .parent()
        .ok_or_else(|| ImagePdfError::Invalid("Đường dẫn kết quả không hợp lệ".to_string()))?;
    let file_name = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("combined.pdf");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| ImagePdfError::Runtime(error.to_string()))?
        .as_nanos();
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.native.tmp",
        std::process::id(),
        nonce
    ));

    let save_result = document
        .save(&temp_path)
        .map_err(|error| ImagePdfError::Runtime(format!("Không ghi được PDF native: {error}")));
    if let Err(error) = save_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = hooks.check_cancelled() {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if output_path.exists() {
        let _ = fs::remove_file(&temp_path);
        return Err(ImagePdfError::Invalid(
            "File kết quả xuất hiện trong lúc xử lý; không ghi đè".to_string(),
        ));
    }
    if let Err(error) = fs::rename(&temp_path, output_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(ImagePdfError::Io(format!(
            "Không hoàn tất file PDF atomic: {error}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};
    use png::{
        BitDepth as PngBitDepth, BlendOp, ColorType as PngColorType, DisposeOp,
        Encoder as ApngEncoder,
    };

    fn unique_path(name: &str, extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "prynx_native_combine_{name}_{}_{}.{}",
            std::process::id(),
            nonce,
            extension
        ))
    }

    fn write_rgb_png(path: &Path, width: u32, height: u32, data: &[u8]) {
        let file = fs::File::create(path).unwrap();
        PngEncoder::new(file)
            .write_image(data, width, height, ColorType::Rgb8.into())
            .unwrap();
    }

    fn write_rgba_png(path: &Path, width: u32, height: u32, data: &[u8]) {
        let file = fs::File::create(path).unwrap();
        PngEncoder::new(file)
            .write_image(data, width, height, ColorType::Rgba8.into())
            .unwrap();
    }

    fn write_rgba16_png(path: &Path, width: u32, height: u32, data: &[u16]) {
        let raw: Vec<u8> = data.iter().flat_map(|value| value.to_ne_bytes()).collect();
        let file = fs::File::create(path).unwrap();
        PngEncoder::new(file)
            .write_image(&raw, width, height, ColorType::Rgba16.into())
            .unwrap();
    }

    fn write_composited_apng(path: &Path) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = ApngEncoder::new(file, 2, 1);
        encoder.set_color(PngColorType::Rgba);
        encoder.set_depth(PngBitDepth::Eight);
        encoder.set_animated(4, 0).unwrap();
        let mut writer = encoder.write_header().unwrap();

        writer.set_blend_op(BlendOp::Source).unwrap();
        writer.set_dispose_op(DisposeOp::None).unwrap();
        writer
            .write_image_data(&[255, 0, 0, 255, 255, 0, 0, 255])
            .unwrap();

        writer.set_frame_dimension(1, 1).unwrap();
        writer.set_frame_position(1, 0).unwrap();
        writer.set_blend_op(BlendOp::Over).unwrap();
        writer.set_dispose_op(DisposeOp::Background).unwrap();
        writer.write_image_data(&[0, 0, 255, 128]).unwrap();

        writer.set_frame_position(0, 0).unwrap();
        writer.set_blend_op(BlendOp::Source).unwrap();
        writer.set_dispose_op(DisposeOp::Previous).unwrap();
        writer.write_image_data(&[0, 255, 0, 255]).unwrap();

        writer.set_frame_position(1, 0).unwrap();
        writer.set_dispose_op(DisposeOp::None).unwrap();
        writer.write_image_data(&[255, 255, 0, 255]).unwrap();
        writer.finish().unwrap();
    }

    fn write_rgba16_apng(path: &Path) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = ApngEncoder::new(file, 1, 1);
        encoder.set_color(PngColorType::Rgba);
        encoder.set_depth(PngBitDepth::Sixteen);
        encoder.set_animated(2, 0).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_image_data(&[0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff])
            .unwrap();
        writer
            .write_image_data(&[0, 0, 0xff, 0xff, 0, 0, 0xff, 0xff])
            .unwrap();
        writer.finish().unwrap();
    }

    fn inflate_predictor_rows(
        compressed: &[u8],
        width: usize,
        height: usize,
        channels: usize,
    ) -> Vec<u8> {
        let mut decoder = ZlibDecoder::new(compressed);
        let mut filtered = Vec::new();
        decoder.read_to_end(&mut filtered).unwrap();
        let row_bytes = width * channels;
        assert_eq!(filtered.len(), height * (row_bytes + 1));
        let mut output = Vec::with_capacity(height * row_bytes);
        for row in filtered.chunks_exact(row_bytes + 1) {
            match row[0] {
                0 => output.extend_from_slice(&row[1..]),
                1 => {
                    for (index, &value) in row[1..].iter().enumerate() {
                        let left = if index >= channels {
                            output[output.len() - channels]
                        } else {
                            0
                        };
                        output.push(value.wrapping_add(left));
                    }
                }
                filter => panic!("Bộ lọc Predictor không mong đợi: {filter}"),
            }
        }
        output
    }

    fn insert_png_chunk_after_ihdr(path: &Path, chunk_type: &[u8; 4], data: &[u8]) {
        let original = fs::read(path).unwrap();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(chunk_type);
        chunk.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(chunk_type);
        crc_input.extend_from_slice(data);
        chunk.extend_from_slice(&png_crc32(&crc_input).to_be_bytes());
        let mut updated = Vec::with_capacity(original.len() + chunk.len());
        updated.extend_from_slice(&original[..33]);
        updated.extend_from_slice(&chunk);
        updated.extend_from_slice(&original[33..]);
        fs::write(path, updated).unwrap();
    }

    fn png_crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xedb8_8320 & mask);
            }
        }
        !crc
    }

    fn png_iccp_data(profile: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(profile).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut data = b"PrynX sRGB\0\0".to_vec();
        data.extend_from_slice(&compressed);
        data
    }

    fn insert_jpeg_icc_markers(path: &Path, profile: &[u8], part_size: usize) {
        let original = fs::read(path).unwrap();
        let parts: Vec<&[u8]> = profile.chunks(part_size).collect();
        let mut markers = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            let mut payload = b"ICC_PROFILE\0".to_vec();
            payload.push((index + 1) as u8);
            payload.push(parts.len() as u8);
            payload.extend_from_slice(part);
            markers.extend_from_slice(&[0xff, 0xe2]);
            markers.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
            markers.extend_from_slice(&payload);
        }
        let mut updated = Vec::with_capacity(original.len() + markers.len());
        updated.extend_from_slice(&original[..2]);
        updated.extend_from_slice(&markers);
        updated.extend_from_slice(&original[2..]);
        fs::write(path, updated).unwrap();
    }

    fn source(path: &Path, width: u32, height: u32) -> ImageSourceSpec {
        ImageSourceSpec {
            path: path.to_string_lossy().into_owned(),
            width_px: width,
            height_px: height,
            width_pt: width as f64,
            height_pt: height as f64,
        }
    }

    fn assert_iccbased_asset(asset: PreparedAsset, expected_profile: &[u8]) {
        let mut document = Document::with_version("1.7");
        let image_id = add_image_object(&mut document, asset);
        let image = document.get_object(image_id).unwrap().as_stream().unwrap();
        let color_space = image.dict.get(b"ColorSpace").unwrap().as_array().unwrap();
        assert_eq!(color_space[0].as_name().unwrap(), b"ICCBased");
        let profile_id = color_space[1].as_reference().unwrap();
        let profile = document
            .get_object(profile_id)
            .unwrap()
            .as_stream()
            .unwrap();
        assert_eq!(profile.dict.get(b"N").unwrap().as_i64().unwrap(), 3);
        assert_eq!(profile.content, expected_profile);
    }

    #[test]
    fn opaque_rgb_png_keeps_original_idat() {
        let path = unique_path("opaque", "png");
        write_rgb_png(&path, 2, 1, &[255, 0, 0, 0, 255, 0]);
        let bytes = fs::read(&path).unwrap();
        let parsed = parse_png(&bytes).unwrap();
        let asset = prepare_png(&bytes, &source(&path, 2, 1)).unwrap();
        assert!(matches!(asset.filter, AssetFilter::Flate { colors: 3 }));
        assert_eq!(asset.data, parsed.idat);
        assert!(asset.alpha.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rgba_png_creates_soft_mask_without_flattening() {
        let path = unique_path("alpha", "png");
        write_rgba_png(&path, 2, 1, &[255, 0, 0, 0, 0, 255, 0, 255]);
        let bytes = fs::read(&path).unwrap();
        let asset = prepare_png(&bytes, &source(&path, 2, 1)).unwrap();
        assert!(matches!(asset.color_space, AssetColorSpace::Rgb));
        assert!(asset.alpha.is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rgba16_png_keeps_16_bit_color_and_alpha() {
        let path = unique_path("rgba16", "png");
        write_rgba16_png(&path, 1, 1, &[65535, 32768, 1, 12345]);
        let bytes = fs::read(&path).unwrap();
        let asset = prepare_png(&bytes, &source(&path, 1, 1)).unwrap();
        assert_eq!(asset.bits_per_component, 16);
        assert_eq!(asset.alpha.as_ref().unwrap().bits_per_component, 16);

        let mut color_decoder = ZlibDecoder::new(asset.data.as_slice());
        let mut color = Vec::new();
        color_decoder.read_to_end(&mut color).unwrap();
        assert_eq!(&color[1..], &[0xff, 0xff, 0x80, 0x00, 0x00, 0x01]);

        let alpha_asset = asset.alpha.unwrap();
        let mut alpha_decoder = ZlibDecoder::new(alpha_asset.data.as_slice());
        let mut alpha = Vec::new();
        alpha_decoder.read_to_end(&mut alpha).unwrap();
        assert_eq!(&alpha[1..], &[0x30, 0x39]);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn png_iccp_is_preserved_for_iccbased_pdf() {
        let path = unique_path("icc", "png");
        write_rgb_png(&path, 1, 1, &[10, 20, 30]);
        insert_png_chunk_after_ihdr(&path, b"iCCP", &png_iccp_data(SRGB_ICC_PROFILE));
        let bytes = fs::read(&path).unwrap();
        let asset = prepare_png(&bytes, &source(&path, 1, 1)).unwrap();
        assert_eq!(asset.icc_profile.as_deref(), Some(SRGB_ICC_PROFILE));
        assert_iccbased_asset(asset, SRGB_ICC_PROFILE);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn png_srgb_chunk_uses_bundled_srgb_icc() {
        let path = unique_path("srgb", "png");
        write_rgb_png(&path, 1, 1, &[10, 20, 30]);
        insert_png_chunk_after_ihdr(&path, b"sRGB", &[0]);
        let bytes = fs::read(&path).unwrap();
        let asset = prepare_png(&bytes, &source(&path, 1, 1)).unwrap();
        assert_eq!(asset.icc_profile.as_deref(), Some(SRGB_ICC_PROFILE));
        assert_iccbased_asset(asset, SRGB_ICC_PROFILE);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn apng_composites_frames_and_expands_each_manifest_item() {
        let image_path = unique_path("apng", "png");
        let output_path = unique_path("apng_output", "pdf");
        write_composited_apng(&image_path);
        insert_png_chunk_after_ihdr(&image_path, b"sRGB", &[0]);
        let bytes = fs::read(&image_path).unwrap();
        let assets = prepare_png_source(&bytes, &source(&image_path, 2, 1)).unwrap();
        assert_eq!(assets.len(), 4);
        assert!(assets
            .iter()
            .all(|asset| asset.icc_profile.as_deref() == Some(SRGB_ICC_PROFILE)));

        assert_eq!(
            inflate_predictor_rows(&assets[0].data, 2, 1, 3),
            [255, 0, 0, 255, 0, 0]
        );
        assert!(assets[0].alpha.is_none());
        assert_eq!(
            inflate_predictor_rows(&assets[1].data, 2, 1, 3),
            [255, 0, 0, 127, 0, 128]
        );
        assert!(assets[1].alpha.is_none());
        assert_eq!(
            inflate_predictor_rows(&assets[2].data, 2, 1, 3),
            [0, 255, 0, 0, 0, 0]
        );
        assert_eq!(
            inflate_predictor_rows(&assets[2].alpha.as_ref().unwrap().data, 2, 1, 1),
            [255, 0]
        );
        assert_eq!(
            inflate_predictor_rows(&assets[3].data, 2, 1, 3),
            [255, 0, 0, 255, 255, 0]
        );
        assert!(assets[3].alpha.is_none());

        let request = ImageManifestRequest {
            sources: vec![source(&image_path, 2, 1)],
            pages: vec![ImagePageSpec {
                blank: false,
                file_index: Some(0),
                width: None,
                height: None,
                rotation: 90,
            }],
        };
        combine_impl(request, output_path.clone(), 1, &CallbackHooks::default()).unwrap();
        let document = Document::load(&output_path).unwrap();
        let pages = document.get_pages();
        assert_eq!(pages.len(), 4);
        for page_id in pages.values() {
            let page = document.get_object(*page_id).unwrap().as_dict().unwrap();
            assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        }

        let _ = fs::remove_file(image_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn apng_16_bit_stops_at_quality_guard() {
        let path = unique_path("apng16", "png");
        write_rgba16_apng(&path);
        let bytes = fs::read(&path).unwrap();
        let error = prepare_png_source(&bytes, &source(&path, 1, 1)).unwrap_err();
        assert!(matches!(error, ImagePdfError::QualityGuard(_)));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn jpeg_keeps_dct_bytes() {
        let path = unique_path("jpeg", "jpg");
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode(&[255, 0, 0, 0, 255, 0], 2, 1, ColorType::Rgb8.into())
            .unwrap();
        fs::write(&path, &bytes).unwrap();
        let asset = prepare_jpeg(&bytes, &source(&path, 2, 1)).unwrap();
        assert!(matches!(asset.filter, AssetFilter::Dct));
        assert_eq!(asset.data, bytes);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn jpeg_icc_keeps_dct_and_builds_iccbased_pdf() {
        let path = unique_path("jpeg_icc", "jpg");
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 90)
            .encode(&[255, 0, 0], 1, 1, ColorType::Rgb8.into())
            .unwrap();
        fs::write(&path, &bytes).unwrap();
        insert_jpeg_icc_markers(&path, SRGB_ICC_PROFILE, 128);
        let bytes = fs::read(&path).unwrap();
        let asset = prepare_jpeg(&bytes, &source(&path, 1, 1)).unwrap();
        assert_eq!(asset.data, bytes);
        assert_eq!(asset.icc_profile.as_deref(), Some(SRGB_ICC_PROFILE));
        assert_iccbased_asset(asset, SRGB_ICC_PROFILE);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn document_keeps_duplicate_blank_and_rotation() {
        let image_path = unique_path("manifest", "png");
        let output_path = unique_path("manifest_output", "pdf");
        write_rgb_png(&image_path, 2, 1, &[255, 0, 0, 0, 255, 0]);
        let request = ImageManifestRequest {
            sources: vec![source(&image_path, 2, 1)],
            pages: vec![
                ImagePageSpec {
                    blank: false,
                    file_index: Some(0),
                    width: None,
                    height: None,
                    rotation: 90,
                },
                ImagePageSpec {
                    blank: true,
                    file_index: None,
                    width: None,
                    height: None,
                    rotation: 0,
                },
                ImagePageSpec {
                    blank: false,
                    file_index: Some(0),
                    width: None,
                    height: None,
                    rotation: 180,
                },
            ],
        };
        combine_impl(request, output_path.clone(), 1, &CallbackHooks::default()).unwrap();

        let document = Document::load(&output_path).unwrap();
        let pages = document.get_pages();
        assert_eq!(pages.len(), 3);
        let first_page_id = pages.get(&1).unwrap();
        let first_page = document
            .get_object(*first_page_id)
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(first_page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);

        let _ = fs::remove_file(image_path);
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn rejects_non_quarter_turn_without_writing_output() {
        let image_path = unique_path("bad_rotation", "png");
        let output_path = unique_path("bad_rotation_output", "pdf");
        write_rgb_png(&image_path, 1, 1, &[255, 0, 0]);
        let request = ImageManifestRequest {
            sources: vec![source(&image_path, 1, 1)],
            pages: vec![ImagePageSpec {
                blank: false,
                file_index: Some(0),
                width: None,
                height: None,
                rotation: 45,
            }],
        };
        let error =
            combine_impl(request, output_path.clone(), 1, &CallbackHooks::default()).unwrap_err();
        assert!(matches!(error, ImagePdfError::Invalid(_)));
        assert!(!output_path.exists());

        let _ = fs::remove_file(image_path);
    }
}
